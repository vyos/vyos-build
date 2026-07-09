// Background boot-config persistence.
//
// A commit through `/configure` makes the change live immediately; writing it
// to the boot config (`config-file save`) is a second, slow VyOS API round
// trip that only matters for reboot survival. Callers used to block the UI on
// it, roughly doubling every apply. Instead, `scheduleBootSave` runs the save
// in the background: saves coalesce (a save requested while one is in flight
// runs once more afterwards, persisting the latest state), and the shell's
// SaveIndicator subscribes here to show progress and surface failures with a
// retry.

import { vyosApi } from "./api";

interface VyosSaveResponse {
  success: boolean;
  error: string | null;
}

export type BootSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "error"; message: string };

let state: BootSaveState = { status: "idle" };
/** A save was requested while one was in flight — run once more when it ends. */
let pending = false;
let running = false;

const listeners = new Set<(s: BootSaveState) => void>();

function setState(s: BootSaveState): void {
  state = s;
  for (const l of listeners) l(s);
}

export function getBootSaveState(): BootSaveState {
  return state;
}

/// Subscribe to save-state changes. Returns the unsubscribe function.
/// (Signature matches React's useSyncExternalStore.)
export function subscribeBootSave(cb: (s: BootSaveState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/// Persist the running config to the boot config in the background.
export function scheduleBootSave(): void {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  void run();
}

/// Retry after a failed save (the button on the shell's error pill).
export function retryBootSave(): void {
  scheduleBootSave();
}

async function run(): Promise<void> {
  setState({ status: "saving" });
  let error: string | null = null;
  do {
    pending = false;
    try {
      const resp = await vyosApi<VyosSaveResponse>("config-file", { op: "save" });
      error = resp.success ? null : resp.error ?? "unknown error";
    } catch (e) {
      error = e instanceof Error ? e.message : "unknown error";
    }
  } while (pending); // a commit landed mid-save — save again for the latest state
  running = false;
  if (error !== null) {
    setState({ status: "error", message: `Saving to boot config failed: ${error}` });
  } else {
    setState({ status: "idle" });
  }
}
