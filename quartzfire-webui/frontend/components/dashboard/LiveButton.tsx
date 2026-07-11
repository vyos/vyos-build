"use client";

import { Pause, RefreshCw } from "lucide-react";

/// Blue "Live" pill that toggles to a muted "Paused" state. Used by polling tiles to
/// freeze their data for inspection.
export function LiveButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-[5px] px-[8px] py-[3px] rounded-full text-[10.5px] font-semibold cursor-pointer transition-colors"
      style={
        paused
          ? { background: "var(--qz-surface-raised)", color: "var(--qz-fg-3)", border: "1px solid var(--qz-border)" }
          : { background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", border: "1px solid transparent" }
      }
      title={paused ? "Resume live updates" : "Pause"}
    >
      {paused ? <Pause size={12} strokeWidth={2.75} /> : <RefreshCw size={12} strokeWidth={2.75} />}
      {paused ? "Paused" : "Live"}
    </button>
  );
}
