// Commit-confirm guard (frontend half — the engine lives in the backend's
// guard.rs).
//
// Risky changes (firewall, interfaces, NAT, routing, restores, rollbacks)
// don't go straight to /configure: they apply through /api/guard/apply, which
// commits the change but arms a server-side revert timer. This module tracks
// that pending change so the shell's CommitGuard banner can show the
// countdown with Confirm / Revert buttons. If the change severed the session
// (the exact failure the guard exists for), no confirmation arrives and the
// backend restores the previous config by itself.
//
// The store follows the bootSave.ts pattern: module state + subscribe, read
// by useSyncExternalStore.

import { API, apiFetch } from "./api";
import type { VyosCommand } from "./interfaces";

/// A committed-but-unconfirmed change, as the backend reports it. `expiresAt`
/// is a local-clock timestamp derived from the server's remaining seconds —
/// the appliance's wall clock is never trusted.
export interface PendingChange {
  id: string;
  description: string;
  expiresAt: number;
  timeoutSecs: number;
}

/// A pending change as the backend serializes it (guard/apply,
/// config/restore and config/rollback all answer with this shape).
export interface PendingWire {
  id: string;
  description: string;
  remaining_secs: number;
  timeout_secs: number;
}

interface LastOutcomeWire {
  outcome: "confirmed" | "reverted" | "revert_failed";
  description: string;
  error?: string | null;
  /** How long ago it resolved (server-side monotonic clock). */
  ago_secs?: number;
}

export type GuardState =
  | { phase: "idle" }
  | { phase: "pending"; pending: PendingChange; busy: "confirm" | "revert" | null; error: string | null }
  // The anti-lockout check refused a change; the user must decide.
  | { phase: "lockout"; reasons: string[]; resolve: (proceed: boolean) => void }
  // An unconfirmed change was rolled back (by timer or by hand) — stays up
  // until dismissed, because the UI's data is now stale.
  | { phase: "reverted"; description: string }
  // The revert itself failed: the unconfirmed change is still live.
  | { phase: "revert_failed"; description: string; error: string };

let state: GuardState = { phase: "idle" };
const listeners = new Set<() => void>();
/** Timer that re-checks the server just after the local countdown ends. */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function setState(s: GuardState): void {
  state = s;
  for (const l of listeners) l();
}

export function getGuardState(): GuardState {
  return state;
}

export function subscribeGuard(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function fromWire(p: PendingWire): PendingChange {
  return {
    id: p.id,
    description: p.description,
    expiresAt: Date.now() + p.remaining_secs * 1000,
    timeoutSecs: p.timeout_secs,
  };
}

/// Track a pending change the backend just returned (from guard/apply,
/// config/restore, or config/rollback) and schedule the outcome check.
export function registerPending(wire: PendingWire): PendingChange {
  const pending = fromWire(wire);
  setState({ phase: "pending", pending, busy: null, error: null });
  if (expiryTimer) clearTimeout(expiryTimer);
  // Slightly past the deadline: the server is authoritative, this only asks
  // it what happened.
  expiryTimer = setTimeout(() => void syncPending(), pending.expiresAt - Date.now() + 1500);
  return pending;
}

/// Ask the backend for the current guard state. Called by the banner on
/// mount (a page reload during a pending window must re-show the countdown)
/// and after the local countdown runs out.
export async function syncPending(): Promise<void> {
  let body: { pending: PendingWire | null; last: LastOutcomeWire | null };
  try {
    body = await apiFetch("/guard/pending");
  } catch {
    return; // transient — the next sync will catch up
  }
  // Never clobber the lockout dialog — its resolver must fire exactly once,
  // and only from the user's decision.
  if (state.phase === "lockout") return;
  if (body.pending) {
    // Don't clobber an in-flight confirm/revert click either.
    if (state.phase === "pending" && state.busy) return;
    registerPending(body.pending);
    return;
  }
  // Nothing pending. If we were showing a countdown, the change resolved
  // without us — report how it ended. On a fresh page (idle) also surface a
  // *recent* revert: this is exactly the "bad change cut me off, the guard
  // restored access, I reconnected" path, and the user needs to know their
  // change did not stick.
  const wasCountingDown = state.phase === "pending";
  const recent = (body.last?.ago_secs ?? Infinity) <= 300;
  if (wasCountingDown || (state.phase === "idle" && recent)) {
    if (body.last?.outcome === "reverted") {
      setState({ phase: "reverted", description: body.last.description });
    } else if (body.last?.outcome === "revert_failed") {
      setState({
        phase: "revert_failed",
        description: body.last.description,
        error: body.last.error ?? "unknown error",
      });
    } else if (wasCountingDown) {
      setState({ phase: "idle" }); // confirmed from another tab
    }
  }
}

/// Keep the pending change. The backend cancels the revert timer and persists
/// the running config to the boot config.
export async function confirmPending(): Promise<void> {
  if (state.phase !== "pending") return;
  const { pending } = state;
  setState({ phase: "pending", pending, busy: "confirm", error: null });
  try {
    const res = await apiFetch<{ ok: boolean; boot_saved: boolean; error?: string | null }>(
      "/guard/confirm",
      { method: "POST", body: JSON.stringify({ id: pending.id }) },
    );
    if (res.boot_saved === false) {
      // Confirmed but not persisted — surface it rather than vanish silently.
      setState({
        phase: "revert_failed",
        description: pending.description,
        error: `The change is confirmed and live, but saving it to the boot config failed: ${res.error ?? "unknown error"}. It will not survive a reboot until a later save succeeds.`,
      });
      return;
    }
    setState({ phase: "idle" });
  } catch (e) {
    // A 409 means the window already closed — ask the server what happened.
    setState({
      phase: "pending",
      pending,
      busy: null,
      error: e instanceof Error ? e.message : "Confirm failed.",
    });
    void syncPending();
  }
}

/// Undo the pending change now instead of waiting out the timer.
export async function revertPending(): Promise<void> {
  if (state.phase !== "pending") return;
  const { pending } = state;
  setState({ phase: "pending", pending, busy: "revert", error: null });
  try {
    await apiFetch("/guard/revert", { method: "POST", body: JSON.stringify({ id: pending.id }) });
    setState({ phase: "reverted", description: pending.description });
  } catch (e) {
    setState({
      phase: "pending",
      pending,
      busy: null,
      error: e instanceof Error ? e.message : "Revert failed.",
    });
    void syncPending();
  }
}

export function dismissGuardNotice(): void {
  if (state.phase === "reverted" || state.phase === "revert_failed") {
    setState({ phase: "idle" });
  }
}

// ── guarded apply ─────────────────────────────────────────────────────────────

async function postApply(
  commands: VyosCommand[],
  description: string,
  overrideLockout: boolean,
): Promise<Response> {
  return fetch(`${API}/guard/apply`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands, description, override_lockout: overrideLockout }),
  });
}

/// Commit a command list under commit-confirm. Drop-in replacement for
/// `commitAndSave` for the domains where a bad change can sever the session
/// (firewall, interfaces, NAT, routing).
///
/// The change is live once this resolves, but it auto-reverts unless the user
/// confirms it in the shell's CommitGuard banner — the boot config is only
/// written after that confirmation. If the backend's anti-lockout check
/// refuses the change, the banner asks the user whether to proceed anyway;
/// declining rejects with an error like any other failed apply.
export async function guardedCommitAndSave(
  commands: VyosCommand[],
  description: string,
): Promise<number> {
  if (commands.length === 0) return 0;

  let res = await postApply(commands, description, false);
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const reasons: string[] | undefined = body?.lockout;
    if (!reasons?.length) {
      throw new Error(body?.error || "Another change is awaiting confirmation.");
    }
    const proceed = await new Promise<boolean>((resolve) => {
      setState({ phase: "lockout", reasons, resolve });
    });
    setState({ phase: "idle" });
    if (!proceed) {
      throw new Error("Cancelled — the change would have cut off management access.");
    }
    res = await postApply(commands, description, true);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }

  registerPending((await res.json()) as PendingWire);
  return commands.length;
}
