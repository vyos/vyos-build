"use client";

import { useSyncExternalStore } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { BootSaveState, getBootSaveState, retryBootSave, subscribeBootSave } from "@/lib/bootSave";

/// Global pill showing the state of the background boot-config save (commits
/// apply immediately; persistence runs behind the scenes — see lib/bootSave).
/// Hidden when idle; bottom-left so it never covers the toast (bottom-right).
export function SaveIndicator() {
  const state = useSyncExternalStore<BootSaveState>(
    subscribeBootSave,
    getBootSaveState,
    getBootSaveState,
  );

  if (state.status === "idle") return null;

  const base: React.CSSProperties = {
    position: "fixed",
    bottom: 18,
    left: 258, // clears the 240px sidebar
    zIndex: 80,
    background: "var(--qz-surface-raised)",
    border: "1px solid var(--qz-border)",
    borderRadius: 8,
    padding: "10px 14px",
    boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
    fontSize: 13,
    color: "var(--qz-fg-1)",
  };

  if (state.status === "saving") {
    return (
      <div style={{ ...base, borderLeft: "3px solid var(--qz-accent)" }} className="flex items-center gap-2">
        <RotateCw size={14} className="animate-spin" style={{ color: "var(--qz-accent)" }} />
        Saving to boot config…
      </div>
    );
  }

  return (
    <div style={{ ...base, borderLeft: "3px solid var(--qz-danger)" }} className="flex items-center gap-2">
      <AlertTriangle size={14} style={{ color: "var(--qz-danger)" }} />
      <span>{state.message}</span>
      <button
        onClick={retryBootSave}
        className="ml-2 rounded-md px-2 py-1 text-[12px]"
        style={{ border: "1px solid var(--qz-border)", background: "var(--qz-input-bg)", color: "var(--qz-fg-1)" }}
      >
        Retry
      </button>
    </div>
  );
}
