"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";
import {
  IpsAlert,
  IpsSettings,
  THREAT_LEVELS,
  alertKey,
  fetchIpsAlertHistory,
  fetchIpsStatus,
} from "@/lib/ips";
import { LiveButton } from "./LiveButton";

const MAX_ROWS = 50;

type AlertRow = IpsAlert & { id: number };

/// Compact alert time: clock for today, day + clock for older history rows.
function alertTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? clock : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function RecentIpsAlertsTile() {
  const rowsRef = useRef<AlertRow[]>([]);
  const nextId = useRef(0);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [settings, setSettings] = useState<IpsSettings | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);

  // Settings (per-level Log/Alarm flags) and engine liveness, once on mount.
  useEffect(() => {
    let alive = true;
    fetchIpsStatus()
      .then((s) => {
        if (!alive) return;
        setSettings(s.settings);
        setRunning(s.running);
      })
      .catch(() => {
        // tile still renders alerts without the flags
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live SSE stream + persistent history, deduped — the Alerts tab's pattern,
  // trimmed for a tile (no filters, small cap).
  useEffect(() => {
    const es = new EventSource("/api/ips/alerts");
    const push = () => {
      if (!pausedRef.current) setRows([...rowsRef.current]);
    };
    es.onmessage = (ev) => {
      try {
        const alert = JSON.parse(ev.data) as IpsAlert;
        rowsRef.current = [{ ...alert, id: nextId.current++ }, ...rowsRef.current].slice(0, MAX_ROWS);
        push();
      } catch {
        // tolerate a malformed event rather than killing the stream
      }
    };

    let cancelled = false;
    fetchIpsAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map(alertKey));
        const merged = [
          ...rowsRef.current,
          ...history.filter((a) => !seen.has(alertKey(a))).map((a) => ({ ...a, id: nextId.current++ })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_ROWS);
        push();
      })
      .catch(() => {
        // best-effort — the live stream still works without history
      });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const togglePause = () =>
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows([...rowsRef.current]);
      return !p;
    });

  // Hide levels whose Log flag is off, matching the Alerts tab.
  const visible = settings ? rows.filter((r) => settings[r.level]?.log ?? true) : rows;

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px] min-w-0">
          <ShieldAlert size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0 truncate" style={{ letterSpacing: "-0.01em" }}>
            IPS Alerts
          </h2>
          <Link
            href="/services/intrusion-prevention"
            className="inline-flex items-center gap-[3px] text-[11px] text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-2)] flex-shrink-0"
          >
            View all <ArrowRight size={11} />
          </Link>
        </div>
        <LiveButton paused={paused} onToggle={togglePause} />
      </div>

      {running === false && (
        <div className="text-[12px] text-[var(--qz-fg-4)] mb-2 flex-shrink-0">
          IPS engine is not running — showing logged history.
        </div>
      )}

      {visible.length === 0 ? (
        <div className="flex-1 grid place-items-center text-[12px] text-[var(--qz-fg-4)] text-center px-4">
          No alerts yet — alerts appear when inspected traffic matches a signature.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto -mx-2 flex flex-col gap-[4px]">
          {visible.map((r) => {
            const meta = THREAT_LEVELS.find((l) => l.level === r.level) ?? THREAT_LEVELS[4];
            const alarm = settings?.[r.level]?.alarm ?? false;
            const route = `${r.src ?? "?"}${r.spt != null ? `:${r.spt}` : ""} → ${r.dst ?? "?"}${r.dpt != null ? `:${r.dpt}` : ""}`;
            return (
              <div
                key={r.id}
                className="flex items-center gap-[8px] px-2 py-[6px] rounded-md text-[12px] flex-shrink-0"
                style={{
                  background: alarm ? "color-mix(in oklab, var(--qz-danger) 7%, transparent)" : undefined,
                }}
                title={`${meta.label} · SID ${r.sid}${r.category ? ` · ${r.category}` : ""}\n${route}${r.proto ? ` (${r.proto})` : ""}`}
              >
                <span
                  className="flex-shrink-0"
                  style={{ width: 8, height: 8, borderRadius: 999, background: meta.color }}
                  aria-label={meta.label}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[var(--qz-fg-2)] truncate">{r.signature}</div>
                  <div className="text-[11px] text-[var(--qz-fg-4)] truncate" style={{ fontFamily: "var(--qz-font-mono)" }}>
                    {route}
                  </div>
                </div>
                {r.action === "blocked" ? (
                  <span className="badge badge-crit flex-shrink-0">Blocked</span>
                ) : (
                  <span className="badge badge-ok flex-shrink-0">Allowed</span>
                )}
                <span
                  className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0 text-right"
                  style={{ fontFamily: "var(--qz-font-mono)" }}
                >
                  {alertTime(r.ts)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
