"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Gauge, Network } from "lucide-react";
import { formatRate } from "@/lib/format";
import { useInterfaceStats } from "./useInterfaceStats";
import { LiveButton } from "./LiveButton";

const POLL_MS = 2_000;
const MAX_POINTS = 61; // ~2 minutes at 2s spacing
const POLL_SEC = POLL_MS / 1000;

interface Sample {
  t: number;
  rx: number;
  tx: number;
}

/// Round number for axis steps: 1/2/5 × 10ⁿ just below the target.
function niceStep(x: number): number {
  if (x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

/// Compact bits/sec axis label, e.g. 3_000_000 → "3.0M".
function formatRateShort(bits: number): string {
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)}G`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)}M`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)}K`;
  return `${Math.round(bits)}`;
}

/// Seconds-ago label, e.g. 90 → "1m30s", 0 → "now".
function formatAge(sec: number): string {
  if (sec <= 0) return "now";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

const RX_COLOR = "var(--qz-accent)"; // green-500
const TX_COLOR = "var(--qz-green-300)"; // lighter green

function SpeedGraph({ rx, tx }: { rx: number[]; tx: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 320, h: 180 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const PAD_L = 40;
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 20;
  const plotW = Math.max(1, w - PAD_L - PAD_R);
  const plotH = Math.max(1, h - PAD_T - PAD_B);
  const spacing = plotW / (MAX_POINTS - 1);
  const maxAge = (MAX_POINTS - 1) * POLL_SEC;
  const chartMax = Math.max(1, ...rx, ...tx);
  const len = Math.max(rx.length, tx.length);

  const xForIdx = (i: number, l: number) => PAD_L + plotW - (l - 1 - i) * spacing;
  const yForVal = (v: number) => PAD_T + plotH - (v / chartMax) * plotH;
  const xForAge = (age: number) => PAD_L + plotW * (1 - age / maxAge);

  const coords = (arr: number[]) => arr.map((v, i) => [xForIdx(i, arr.length), yForVal(v)] as const);
  const lineStr = (p: readonly (readonly [number, number])[]) =>
    p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaStr = (p: readonly (readonly [number, number])[]) =>
    p.length < 2
      ? ""
      : `${lineStr(p)} ${p[p.length - 1][0].toFixed(1)},${(PAD_T + plotH).toFixed(1)} ${p[0][0].toFixed(1)},${(PAD_T + plotH).toFixed(1)}`;

  const rxP = coords(rx);
  const txP = coords(tx);

  const bitsMax = chartMax * 8;
  const yStep = niceStep(bitsMax / 4);
  const yTicks: number[] = [];
  for (let v = yStep; v < bitsMax * 0.999; v += yStep) yTicks.push(v);

  const xStep = niceStep(maxAge / 4);
  const xTicks: number[] = [];
  for (let a = 0; a <= maxAge + 0.5; a += xStep) xTicks.push(Math.round(a));

  const onMove = (e: React.MouseEvent) => {
    if (len < 1 || !wrapRef.current) return;
    const px = e.clientX - wrapRef.current.getBoundingClientRect().left;
    const fromEnd = Math.round((PAD_L + plotW - px) / spacing);
    setHover(Math.min(len - 1, Math.max(0, len - 1 - fromEnd)));
  };

  const hasData = len >= 2;
  const hoverX = hover != null ? xForIdx(hover, len) : null;
  const hoverAge = hover != null ? Math.round((len - 1 - hover) * POLL_SEC) : 0;

  return (
    <div ref={wrapRef} className="relative h-full w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {!hasData && (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-[var(--qz-fg-4)]">Measuring…</div>
      )}
      <svg width={w} height={h} style={{ display: "block" }}>
        {yTicks.map((b) => {
          const y = yForVal(b / 8);
          return (
            <g key={`y${b}`}>
              <line x1={PAD_L} x2={w - PAD_R} y1={y} y2={y} stroke="var(--qz-border)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={9} fill="var(--qz-fg-4)" fontFamily="var(--qz-font-mono)">
                {formatRateShort(b)}
              </text>
            </g>
          );
        })}
        {/* baseline + top max + x labels */}
        <line x1={PAD_L} x2={w - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} stroke="var(--qz-border)" strokeWidth={1} />
        <text x={PAD_L - 6} y={PAD_T + plotH + 3} textAnchor="end" fontSize={9} fill="var(--qz-fg-4)" fontFamily="var(--qz-font-mono)">0</text>
        <text x={PAD_L - 6} y={PAD_T + 3} textAnchor="end" fontSize={9} fill="var(--qz-fg-4)" fontFamily="var(--qz-font-mono)">
          {formatRateShort(bitsMax)}
        </text>
        {xTicks.map((a) => (
          <text
            key={`x${a}`}
            x={Math.min(w - PAD_R, Math.max(PAD_L, xForAge(a)))}
            y={h - 5}
            textAnchor="middle"
            fontSize={9}
            fill="var(--qz-fg-4)"
            fontFamily="var(--qz-font-mono)"
          >
            {formatAge(a)}
          </text>
        ))}

        {rx.length >= 2 && (
          <>
            <polygon points={areaStr(rxP)} fill={RX_COLOR} opacity={0.13} />
            <polyline points={lineStr(rxP)} fill="none" stroke={RX_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
          </>
        )}
        {tx.length >= 2 && (
          <>
            <polygon points={areaStr(txP)} fill={TX_COLOR} opacity={0.13} />
            <polyline points={lineStr(txP)} fill="none" stroke={TX_COLOR} strokeWidth={1.5} strokeLinejoin="round" />
          </>
        )}

        {hover != null && hoverX != null && hasData && (
          <>
            <line x1={hoverX} x2={hoverX} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--qz-fg-4)" strokeWidth={1} strokeDasharray="3 3" />
            {rx[hover] != null && <circle cx={hoverX} cy={yForVal(rx[hover])} r={3} fill={RX_COLOR} />}
            {tx[hover] != null && <circle cx={hoverX} cy={yForVal(tx[hover])} r={3} fill={TX_COLOR} />}
          </>
        )}
      </svg>

      {hover != null && hoverX != null && hasData && (
        <div
          className="absolute pointer-events-none rounded-md p-2 z-10 text-[11px]"
          style={{
            left: Math.min(w - 150, Math.max(0, hoverX + 8)),
            top: 8,
            minWidth: 140,
            background: "var(--qz-surface-raised)",
            border: "1px solid var(--qz-border)",
            boxShadow: "var(--qz-shadow-2)",
          }}
        >
          <div className="text-[var(--qz-fg-3)] mb-1" style={{ fontFamily: "var(--qz-font-mono)" }}>{formatAge(hoverAge)}</div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-[5px] text-[var(--qz-fg-2)]">
              <span style={{ width: 7, height: 7, borderRadius: 999, background: RX_COLOR }} />
              Download
            </span>
            <span className="text-[var(--qz-fg-1)] font-semibold" style={{ fontFamily: "var(--qz-font-mono)" }}>
              {formatRate(rx[hover] ?? null)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 mt-[3px]">
            <span className="inline-flex items-center gap-[5px] text-[var(--qz-fg-2)]">
              <span style={{ width: 7, height: 7, borderRadius: 999, background: TX_COLOR }} />
              Upload
            </span>
            <span className="text-[var(--qz-fg-1)] font-semibold" style={{ fontFamily: "var(--qz-font-mono)" }}>
              {formatRate(tx[hover] ?? null)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function NetworkSpeedTile() {
  const [paused, setPaused] = useState(false);
  const { stats, error } = useInterfaceStats(POLL_MS, !paused);
  const [selected, setSelected] = useState<string | null>(null);
  const [rx, setRx] = useState<number[]>([]);
  const [tx, setTx] = useState<number[]>([]);
  const prev = useRef<Sample | null>(null);

  const names = useMemo(() => (stats ? stats.map((s) => s.name) : []), [stats]);

  // Default to the first ethernet interface (or the first available).
  useEffect(() => {
    if (selected || names.length === 0) return;
    setSelected(names.find((n) => n.startsWith("eth")) ?? names[0]);
  }, [names, selected]);

  // Reset the chart when the chosen interface changes.
  useEffect(() => {
    prev.current = null;
    setRx([]);
    setTx([]);
  }, [selected]);

  // Append a speed sample (Δbytes / Δt) whenever fresh counters arrive.
  useEffect(() => {
    if (!stats || !selected) return;
    const s = stats.find((x) => x.name === selected);
    if (!s || s.rx_bytes == null || s.tx_bytes == null) return;
    const now = Date.now();
    const p = prev.current;
    prev.current = { t: now, rx: s.rx_bytes, tx: s.tx_bytes };
    if (!p) return;
    const dt = (now - p.t) / 1000;
    if (dt <= 0) return;
    setRx((a) => [...a, Math.max(0, (s.rx_bytes! - p.rx) / dt)].slice(-MAX_POINTS));
    setTx((a) => [...a, Math.max(0, (s.tx_bytes! - p.tx) / dt)].slice(-MAX_POINTS));
  }, [stats, selected]);

  const curRx = rx.length ? rx[rx.length - 1] : null;
  const curTx = tx.length ? tx[tx.length - 1] : null;

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px] min-w-0">
          <Gauge size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.01em" }}>
            Network Speed
          </h2>
          {names.length > 0 && (
            <div
              className="inline-flex items-center gap-[6px] rounded-md px-2 py-[3px]"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <Network size={12} className="text-[var(--qz-fg-4)]" />
              <select
                value={selected ?? ""}
                onChange={(e) => setSelected(e.target.value)}
                className="bg-transparent outline-none text-[12px] text-[var(--qz-fg-1)] cursor-pointer"
                style={{ fontFamily: "var(--qz-font-mono)" }}
              >
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
      </div>

      {error && rx.length === 0 && <div className="text-[13px] text-[var(--qz-danger)] mb-2">{error}</div>}

      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <span className="inline-flex items-center gap-[6px]">
          <ArrowDown size={16} style={{ color: RX_COLOR }} />
          <span className="text-[16px] font-bold" style={{ color: RX_COLOR, fontFamily: "var(--qz-font-mono)" }}>
            {formatRate(curRx)}
          </span>
          <span className="text-[12px] text-[var(--qz-fg-4)]">down</span>
        </span>
        <span className="inline-flex items-center gap-[6px]">
          <span className="text-[12px] text-[var(--qz-fg-4)]">up</span>
          <span className="text-[16px] font-bold" style={{ color: TX_COLOR, fontFamily: "var(--qz-font-mono)" }}>
            {formatRate(curTx)}
          </span>
          <ArrowUp size={16} style={{ color: TX_COLOR }} />
        </span>
      </div>

      <div className="flex-1 min-h-[80px]">
        <SpeedGraph rx={rx} tx={tx} />
      </div>

      <div className="flex items-center justify-center gap-5 mt-2 flex-shrink-0 text-[11px] text-[var(--qz-fg-3)]">
        <span className="inline-flex items-center gap-[6px]">
          <span style={{ width: 8, height: 8, borderRadius: 999, background: RX_COLOR }} />
          Download (RX)
        </span>
        <span className="inline-flex items-center gap-[6px]">
          <span style={{ width: 8, height: 8, borderRadius: 999, background: TX_COLOR }} />
          Upload (TX)
        </span>
      </div>
    </div>
  );
}
