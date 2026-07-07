"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Network } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { useInterfaceStats } from "./useInterfaceStats";
import { LiveButton } from "./LiveButton";

type SortKey = "name" | "rx" | "tx";

const RX_COLOR = "var(--qz-accent)"; // green-500
const TX_COLOR = "var(--qz-green-300)"; // lighter green

/// Short interface-type label derived from the name prefix.
function ifaceType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes(".")) return "VLAN";
  if (n.startsWith("eth")) return "ETH";
  if (n.startsWith("lo")) return "LO";
  if (n.startsWith("wg")) return "WG";
  if (n.startsWith("bond")) return "BOND";
  if (n.startsWith("br")) return "BR";
  if (n.startsWith("vxlan")) return "VXLAN";
  if (n.startsWith("vtun") || n.startsWith("tun")) return "TUN";
  if (n.startsWith("vti")) return "VTI";
  if (n.startsWith("wlan")) return "WLAN";
  if (n.startsWith("pppoe") || n.startsWith("ppp")) return "PPP";
  if (n.startsWith("gre")) return "GRE";
  return "IF";
}

function Bar({ value, max, color, up }: { value: number; max: number; color: string; up: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <div className="flex items-center gap-2">
      <Icon size={12} style={{ color }} className="shrink-0" />
      <div className="flex-1 h-[7px] rounded-full overflow-hidden min-w-0" style={{ background: "var(--qz-border)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-[72px] text-right text-[12px] text-[var(--qz-fg-2)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
        {formatBytes(value)}
      </span>
    </div>
  );
}

export function InterfaceStatsTile() {
  const [paused, setPaused] = useState(false);
  const { stats, error } = useInterfaceStats(5_000, !paused);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [asc, setAsc] = useState(true);

  const max = useMemo(
    () => (stats ? Math.max(1, ...stats.flatMap((s) => [s.rx_bytes ?? 0, s.tx_bytes ?? 0])) : 0),
    [stats],
  );

  const rows = useMemo(() => {
    if (!stats) return [];
    const f = filter.trim().toLowerCase();
    const filtered = f ? stats.filter((s) => s.name.toLowerCase().includes(f)) : stats.slice();
    filtered.sort((a, b) => {
      const r =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : sortKey === "rx"
            ? (a.rx_bytes ?? 0) - (b.rx_bytes ?? 0)
            : (a.tx_bytes ?? 0) - (b.tx_bytes ?? 0);
      return asc ? r : -r;
    });
    return filtered;
  }, [stats, filter, sortKey, asc]);

  // Switching key uses a sensible default direction (name ↑, RX/TX ↓); same key toggles.
  const setSort = (k: SortKey) => {
    if (sortKey === k) setAsc((a) => !a);
    else {
      setSortKey(k);
      setAsc(k === "name");
    }
  };
  const arrow = (k: SortKey) => (sortKey === k ? (asc ? "↑" : "↓") : "");

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px]">
          <Network size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.01em" }}>
            Interface Statistics
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="rounded-md px-2 py-1 text-[12px] text-[var(--qz-fg-1)] outline-none w-24"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
          />
          <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
        </div>
      </div>

      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-[var(--qz-fg-4)] mr-1">Sort:</span>
          {(["name", "rx", "tx"] as SortKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSort(k)}
              className="px-2 py-[3px] rounded-md cursor-pointer font-medium transition-colors"
              style={
                sortKey === k
                  ? { background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)" }
                  : { background: "transparent", color: "var(--qz-fg-3)" }
              }
            >
              {k === "name" ? "Name" : k.toUpperCase()} {arrow(k)}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-[var(--qz-fg-4)]">
          {rows.length} interface{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {!stats && !error && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading interface statistics…</div>}
      {error && !stats && <div className="text-[13px] text-[var(--qz-danger)]">{error}</div>}

      {stats && (
        <div className="flex-1 overflow-auto">
          {rows.map((s) => {
            const type = ifaceType(s.name);
            return (
              <div
                key={s.name}
                className="flex items-center gap-3 py-[10px]"
                style={{ borderTop: "1px solid var(--qz-divider)" }}
              >
                <div className="w-14 shrink-0 text-[13px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
                  {s.name}
                </div>
                <span className={`badge ${type === "ETH" ? "badge-ok" : "badge-muted"} shrink-0`}>{type}</span>
                <div className="flex-1 flex flex-col gap-[6px] min-w-0">
                  <Bar value={s.rx_bytes ?? 0} max={max} color={RX_COLOR} up={false} />
                  <Bar value={s.tx_bytes ?? 0} max={max} color={TX_COLOR} up />
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <div className="py-3 text-[12px] text-[var(--qz-fg-4)]">No interfaces match.</div>}
        </div>
      )}
    </div>
  );
}
