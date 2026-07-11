"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PieChart } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { AcStatus, AcTopApp, fetchAcStatus } from "@/lib/appcontrol";
import { LiveButton } from "./LiveButton";

const POLL_MS = 5_000;
/** Slices shown individually; the rest fold into "Other". */
const MAX_SLICES = 5;

// Categorical palette validated for the qz dark surface (#161920) — all-pairs
// CVD check passes with the 2px surface gaps + legend this tile ships (see
// dataviz skill). Assigned per application in fixed order, never cycled.
const SLICE_COLORS = ["#3987e5", "#199e70", "#c98500", "#e66767", "#008300"];
const OTHER_COLOR = "var(--qz-ink-7)";

interface Slice {
  key: string;
  name: string;
  bytes: number;
  flows: number | null;
  pct: number;
  color: string;
}

/// Keep each application's color stable across polls: survivors keep their
/// slot, newcomers take the lowest freed slot (color follows the entity, not
/// its current rank).
function assignSlots(prev: Map<number, number>, apps: AcTopApp[]): Map<number, number> {
  const next = new Map<number, number>();
  for (const a of apps) {
    const slot = prev.get(a.app_id);
    if (slot != null) next.set(a.app_id, slot);
  }
  const used = new Set(next.values());
  let free = 0;
  for (const a of apps) {
    if (next.has(a.app_id)) continue;
    while (used.has(free)) free++;
    next.set(a.app_id, free);
    used.add(free);
  }
  return next;
}

/// SVG path for a donut segment from `a0` to `a1` (radians, 0 = 12 o'clock).
function arcPath(cx: number, cy: number, rOut: number, rIn: number, a0: number, a1: number): string {
  // A full circle collapses to nothing as a single arc; nudge under 2π.
  const sweep = Math.min(a1 - a0, Math.PI * 2 - 0.0001);
  const x = (r: number, a: number) => cx + r * Math.sin(a);
  const y = (r: number, a: number) => cy - r * Math.cos(a);
  const large = sweep > Math.PI ? 1 : 0;
  const end = a0 + sweep;
  return [
    `M ${x(rOut, a0).toFixed(2)} ${y(rOut, a0).toFixed(2)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${x(rOut, end).toFixed(2)} ${y(rOut, end).toFixed(2)}`,
    `L ${x(rIn, end).toFixed(2)} ${y(rIn, end).toFixed(2)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${x(rIn, a0).toFixed(2)} ${y(rIn, a0).toFixed(2)}`,
    "Z",
  ].join(" ");
}

function Donut({
  slices,
  totalBytes,
  hover,
  onHover,
}: {
  slices: Slice[];
  totalBytes: number;
  hover: string | null;
  onHover: (key: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(160);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize(Math.min(r.width, r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const c = size / 2;
  const rOut = c - 2;
  const rIn = rOut * 0.62;

  let angle = 0;
  const segs = slices.map((s) => {
    const a0 = angle;
    angle += (s.bytes / totalBytes) * Math.PI * 2;
    return { s, a0, a1: angle };
  });

  const hovered = hover ? slices.find((s) => s.key === hover) : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full grid place-items-center">
      <svg width={size} height={size} style={{ display: "block" }} role="img" aria-label="Top applications by bytes">
        {segs.map(({ s, a0, a1 }) => (
          <path
            key={s.key}
            d={arcPath(c, c, rOut, rIn, a0, a1)}
            fill={s.color}
            opacity={hover == null || hover === s.key ? 1 : 0.45}
            stroke="var(--qz-surface)"
            strokeWidth={2}
            strokeLinejoin="round"
            onMouseEnter={() => onHover(s.key)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${s.name} — ${formatBytes(s.bytes)} (${s.pct.toFixed(1)}%)`}</title>
          </path>
        ))}
      </svg>
      {/* Center readout: hovered slice, or the total. */}
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <div className="text-center" style={{ maxWidth: rIn * 1.7 }}>
          <div className="text-[15px] font-bold text-[var(--qz-fg-1)] truncate" style={{ fontFamily: "var(--qz-font-mono)" }}>
            {hovered ? `${hovered.pct.toFixed(1)}%` : formatBytes(totalBytes)}
          </div>
          <div className="text-[10px] text-[var(--qz-fg-4)] truncate">{hovered ? hovered.name : "classified"}</div>
        </div>
      </div>
    </div>
  );
}

export function TopApplicationsTile() {
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const slots = useRef(new Map<number, number>());

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchAcStatus();
        if (!alive) return;
        setStatus(s);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [paused]);

  const runtime = status?.status ?? null;
  const running = status?.running ?? false;

  const { slices, totalBytes } = useMemo(() => {
    const apps = (runtime?.top_apps ?? []).filter((a) => a.bytes > 0);
    const total = runtime?.total_app_bytes ?? apps.reduce((n, a) => n + a.bytes, 0);
    if (!apps.length || total <= 0) return { slices: [] as Slice[], totalBytes: 0 };

    const shown = [...apps].sort((a, b) => b.bytes - a.bytes || a.app_id - b.app_id).slice(0, MAX_SLICES);
    slots.current = assignSlots(slots.current, shown);
    const out: Slice[] = shown.map((a) => ({
      key: `app-${a.app_id}`,
      name: a.app,
      bytes: a.bytes,
      flows: a.flows,
      pct: (a.bytes / total) * 100,
      color: SLICE_COLORS[slots.current.get(a.app_id) ?? 0],
    }));
    const rest = total - shown.reduce((n, a) => n + a.bytes, 0);
    if (rest > 0) {
      out.push({ key: "other", name: "Other", bytes: rest, flows: null, pct: (rest / total) * 100, color: OTHER_COLOR });
    }
    return { slices: out, totalBytes: total };
  }, [runtime]);

  const empty = !running
    ? "Application Control is not running."
    : slices.length === 0
      ? "No classified traffic yet."
      : null;

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px] min-w-0">
          <PieChart size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0 truncate" style={{ letterSpacing: "-0.01em" }}>
            Top Applications
          </h2>
          <span className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0">by classified bytes</span>
        </div>
        <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
      </div>

      {error && !status && <div className="text-[13px] text-[var(--qz-danger)] mb-2">{error}</div>}

      {empty ? (
        <div className="flex-1 grid place-items-center text-[12px] text-[var(--qz-fg-4)]">{empty}</div>
      ) : (
        <div className="flex-1 flex flex-wrap items-stretch gap-4 min-h-0">
          <div className="flex-1 min-w-[130px] min-h-[130px]">
            <Donut slices={slices} totalBytes={totalBytes} hover={hover} onHover={setHover} />
          </div>
          <div className="flex-1 min-w-[150px] flex flex-col justify-center gap-[6px] overflow-y-auto">
            {slices.map((s) => (
              <div
                key={s.key}
                className="flex items-center gap-[7px] text-[12px] rounded-md px-1 -mx-1"
                style={{ background: hover === s.key ? "color-mix(in oklab, white 5%, transparent)" : undefined }}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="flex-shrink-0" style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
                <span className="text-[var(--qz-fg-2)] truncate flex-1" title={s.flows != null ? `${s.name} — ${s.flows} flows` : s.name}>
                  {s.name}
                </span>
                <span className="text-[var(--qz-fg-1)] font-semibold flex-shrink-0" style={{ fontFamily: "var(--qz-font-mono)" }}>
                  {s.pct.toFixed(1)}%
                </span>
                <span className="text-[var(--qz-fg-4)] flex-shrink-0 w-[62px] text-right" style={{ fontFamily: "var(--qz-font-mono)" }}>
                  {formatBytes(s.bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
