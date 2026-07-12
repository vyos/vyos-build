"use client";

import type React from "react";

export interface TabItem {
  value: string;
  label: string;
  /** Optional trailing count, rendered NAT44-style next to the label. */
  count?: number;
}

/// Underline tab bar — the page-level navigation used across the console
/// (NAT44, Intrusion Prevention, Application Control, Geolocation). A full-width
/// bottom border with the active tab underlined in the accent colour. `trailing`
/// renders at the right edge of the bar (e.g. an enforcing/health badge) without
/// breaking the full-width underline.
export function Tabs({
  items,
  value,
  onChange,
  trailing,
  className = "",
}: {
  items: TabItem[];
  value: string;
  onChange: (v: string) => void;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 border-b border-[var(--qz-border)] ${className}`.trim()}>
      {items.map((it) => {
        const active = value === it.value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={[
              "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
              active
                ? "text-[var(--qz-accent)] border-[var(--qz-accent)]"
                : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
            ].join(" ")}
          >
            {it.label}
            {it.count !== undefined && (
              <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{it.count}</span>
            )}
          </button>
        );
      })}
      {trailing !== undefined && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
