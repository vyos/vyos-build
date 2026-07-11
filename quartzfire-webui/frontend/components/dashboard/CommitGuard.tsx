"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, RotateCcw, ShieldAlert } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import {
  confirmPending,
  dismissGuardNotice,
  getGuardState,
  GuardState,
  revertPending,
  subscribeGuard,
  syncPending,
} from "@/lib/guard";

/// Commit-confirm surface, mounted once in the shell (like SaveIndicator).
///
/// While a guarded change is awaiting confirmation it shows a top-center
/// banner with the countdown and Confirm / Revert buttons; when the
/// anti-lockout check refuses a change it shows the override dialog; after an
/// auto-revert it tells the user their change was undone (the page's data is
/// stale at that point, hence the Reload button).
export function CommitGuard() {
  const state = useSyncExternalStore<GuardState>(subscribeGuard, getGuardState, getGuardState);

  // Pick up a pending change that survived a full page reload (or was armed
  // by another tab).
  useEffect(() => {
    void syncPending();
  }, []);

  if (state.phase === "idle") return null;
  if (state.phase === "lockout") return <LockoutDialog reasons={state.reasons} resolve={state.resolve} />;

  const banner: React.CSSProperties = {
    position: "fixed",
    top: 14,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 90,
    maxWidth: 720,
    width: "calc(100% - 300px)",
    background: "var(--qz-surface-raised)",
    border: "1px solid var(--qz-border)",
    borderRadius: 10,
    padding: "12px 16px",
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
    fontSize: 13,
    color: "var(--qz-fg-1)",
  };

  if (state.phase === "pending") {
    return (
      <div style={{ ...banner, borderLeft: "3px solid var(--qz-warn, #e8a33d)" }}>
        <PendingBody state={state} />
      </div>
    );
  }

  if (state.phase === "reverted") {
    return (
      <div style={{ ...banner, borderLeft: "3px solid var(--qz-danger)" }} className="flex items-center gap-3">
        <RotateCcw size={16} style={{ color: "var(--qz-danger)", flexShrink: 0 }} />
        <span className="flex-1">
          <strong>{state.description}</strong> was not confirmed and has been reverted — the previous
          configuration is back in effect. What you see may be stale until you reload.
        </span>
        <BannerButton onClick={() => window.location.reload()} primary>
          Reload view
        </BannerButton>
        <BannerButton onClick={dismissGuardNotice}>Dismiss</BannerButton>
      </div>
    );
  }

  // revert_failed — the loudest state we have: an unconfirmed change is live
  // and could not be undone (or a confirmed one could not be persisted).
  return (
    <div style={{ ...banner, borderLeft: "3px solid var(--qz-danger)" }} className="flex items-center gap-3">
      <AlertTriangle size={16} style={{ color: "var(--qz-danger)", flexShrink: 0 }} />
      <span className="flex-1">
        <strong>{state.description}:</strong> {state.error}
      </span>
      <BannerButton onClick={dismissGuardNotice}>Dismiss</BannerButton>
    </div>
  );
}

function PendingBody({ state }: { state: Extract<GuardState, { phase: "pending" }> }) {
  const { pending, busy, error } = state;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const remaining = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <ShieldAlert size={16} style={{ color: "var(--qz-warn, #e8a33d)", flexShrink: 0 }} />
        <span className="flex-1">
          <strong>{pending.description}</strong> is live —{" "}
          {remaining > 0 ? (
            <>
              confirm it within <strong style={{ fontVariantNumeric: "tabular-nums" }}>{remaining}s</strong> or
              it will be automatically reverted.
            </>
          ) : (
            <>checking whether it was reverted…</>
          )}
        </span>
        <BannerButton onClick={() => void confirmPending()} disabled={busy !== null} primary icon={Check}>
          {busy === "confirm" ? "Confirming…" : "Confirm change"}
        </BannerButton>
        <BannerButton onClick={() => void revertPending()} disabled={busy !== null} icon={RotateCcw}>
          {busy === "revert" ? "Reverting…" : "Revert now"}
        </BannerButton>
      </div>
      {/* Progress bar makes the deadline legible at a glance. */}
      <div style={{ height: 3, borderRadius: 2, background: "var(--qz-border)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, (remaining / pending.timeoutSecs) * 100)}%`,
            background: "var(--qz-warn, #e8a33d)",
            transition: "width 250ms linear",
          }}
        />
      </div>
      {error && (
        <span className="text-[12px]" style={{ color: "var(--qz-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

function BannerButton({
  children,
  onClick,
  disabled,
  primary,
  icon: Icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  icon?: React.ComponentType<{ size?: number | string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-[6px] rounded-md px-3 py-[7px] text-[12px] font-semibold cursor-pointer disabled:opacity-60 flex-shrink-0"
      style={
        primary
          ? { background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", border: "1px solid transparent" }
          : { background: "var(--qz-input-bg)", color: "var(--qz-fg-1)", border: "1px solid var(--qz-border)" }
      }
    >
      {Icon && <Icon size={13} />}
      {children}
    </button>
  );
}

/// The anti-lockout check refused a change that would sever this session —
/// make the user read why before letting them push it through anyway (the
/// override still runs under commit-confirm, so even a wrong call reverts).
function LockoutDialog({ reasons, resolve }: { reasons: string[]; resolve: (proceed: boolean) => void }) {
  return (
    <ModalShell onClose={() => resolve(false)} maxWidth={520}>
      <ModalHeader
        title="This change would lock you out"
        subtitle="The anti-lockout guard refused to apply it"
        onClose={() => resolve(false)}
      />
      <div className="flex flex-col gap-4">
        <ul className="m-0 pl-5 flex flex-col gap-1 text-[13px] text-[var(--qz-fg-2)]">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
          If you apply it anyway it still runs under commit-confirm: unless you confirm it from a
          session that survives the change, the previous configuration is restored automatically.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => resolve(false)}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => resolve(true)}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-danger)", color: "white" }}
          >
            Apply anyway
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
