"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, HardDrive, MemoryStick, Server } from "lucide-react";
import { DeviceSystemInfo, fetchSystemInfo } from "@/lib/vyos";
import { formatBytes } from "@/lib/format";

const POLL_MS = 10_000;

const UPTIME_UNITS: Record<string, string> = {
  year: "y", week: "w", day: "d", hour: "h", minute: "m", second: "s",
};

/// "1 day, 2 hours, 34 minutes, 5 seconds" → "1d 2h 34m 5s" (falls back to the raw string).
function shortUptime(s: string | null): string | null {
  if (!s) return null;
  const parts: string[] = [];
  const re = /(\d+)\s*(year|week|day|hour|minute|second)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) parts.push(`${m[1]}${UPTIME_UNITS[m[2]]}`);
  return parts.length ? parts.join(" ") : s;
}

/// "quartzfire-0.1.0" → "QuartzFire v0.1.0" (unrecognized strings pass through).
/// A trailing build-timestamp segment ("-202607120222") is dropped — the build
/// date is surfaced separately as "Built: …".
function prettyVersion(v: string | null): string {
  if (!v) return "Unknown version";
  const m = /^quartzfire-(.+)$/i.exec(v.trim());
  if (!m) return v;
  return `QuartzFire v${m[1].replace(/-\d{6,}$/, "")}`;
}

/// Bar colour by utilisation: green → amber → red.
function barColor(pct: number | null): string {
  if (pct == null) return "var(--qz-fg-4)";
  if (pct >= 90) return "var(--qz-danger)";
  if (pct >= 70) return "var(--qz-warn)";
  return "var(--qz-success)";
}

function Bar({ pct }: { pct: number | null }) {
  const width = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="h-[3px] rounded-full overflow-hidden" style={{ background: "var(--qz-border)" }}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${width}%`, background: barColor(pct) }}
      />
    </div>
  );
}

function SectionTitle({ icon: Icon, label, right }: { icon: typeof Activity; label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-[10px]">
      <div className="flex items-center gap-[7px] text-[13px] font-semibold text-[var(--qz-fg-1)]">
        <Icon size={14} className="text-[var(--qz-fg-3)]" />
        {label}
      </div>
      {right != null && <div className="text-[12px] text-[var(--qz-fg-3)]">{right}</div>}
    </div>
  );
}

function MetricRow({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-baseline justify-between mb-[5px]">
        <span className="text-[12px] text-[var(--qz-fg-3)]">{label}</span>
        <span className="text-[13px] font-semibold text-[var(--qz-fg-1)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
          {value}
        </span>
      </div>
      <Bar pct={pct} />
    </div>
  );
}

function Divider() {
  return <div className="my-4" style={{ borderTop: "1px solid var(--qz-border)" }} />;
}

export function SystemInfoPod() {
  const [info, setInfo] = useState<DeviceSystemInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await fetchSystemInfo();
      setInfo(data);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load system information.");
      setStatus((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const mem = info?.memory;
  const hardware = [info?.hardware_vendor, info?.hardware_model].filter(Boolean).join(" ");

  return (
    <div className="p-6 h-full">
      {/* Header */}
      <div className="flex items-center gap-[9px] mb-5">
        <Server size={18} className="text-[var(--qz-accent)]" />
        <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.01em" }}>
          System Information
        </h2>
      </div>

      {status === "loading" && (
        <div className="text-[13px] text-[var(--qz-fg-4)] py-2">Loading system information…</div>
      )}

      {status === "error" && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)] py-2">
          <AlertTriangle size={15} />
          {errorMsg}
        </div>
      )}

      {status === "ready" && info && (
        <>
          {/* Identity */}
          <div className="flex items-center gap-[10px] mb-1 flex-wrap">
            <span
              className="text-[22px] font-bold"
              style={{ color: "var(--qz-accent)", fontFamily: "var(--qz-font-mono)" }}
            >
              {prettyVersion(info.version)}
            </span>
          </div>
          {hardware && <div className="text-[13px] text-[var(--qz-fg-2)] mb-2">{hardware}</div>}
          {info.built_on && (
            <div className="text-[11px] text-[var(--qz-fg-4)] mt-2">Built: {info.built_on}</div>
          )}

          <Divider />

          {/* Load average */}
          <SectionTitle
            icon={Activity}
            label="Load Average"
            right={info.uptime ? <>Uptime {shortUptime(info.uptime)}</> : undefined}
          />
          <MetricRow label="1 min" value={info.load.one != null ? `${info.load.one}%` : "—"} pct={info.load.one} />
          <MetricRow label="5 min" value={info.load.five != null ? `${info.load.five}%` : "—"} pct={info.load.five} />
          <MetricRow label="15 min" value={info.load.fifteen != null ? `${info.load.fifteen}%` : "—"} pct={info.load.fifteen} />

          <Divider />

          {/* Memory */}
          <SectionTitle
            icon={MemoryStick}
            label="Memory"
            right={mem?.used_pct != null ? `${mem.used_pct.toFixed(1)}%` : undefined}
          />
          <div className="flex items-baseline justify-between mb-[5px]">
            <span className="text-[12px] text-[var(--qz-fg-3)]">
              Used: <span className="text-[var(--qz-fg-1)] font-semibold" style={{ fontFamily: "var(--qz-font-mono)" }}>{formatBytes(mem?.used_bytes ?? null)}</span>
            </span>
          </div>
          <Bar pct={mem?.used_pct ?? null} />
          <div className="flex items-baseline justify-between mt-[6px] text-[12px] text-[var(--qz-fg-3)]">
            <span>Free: {formatBytes(mem?.free_bytes ?? null)}</span>
            <span>Total: {formatBytes(mem?.total_bytes ?? null)}</span>
          </div>

          <Divider />

          {/* Disk usage */}
          <SectionTitle icon={HardDrive} label="Disk Usage" />
          {info.storage.length === 0 && (
            <div className="text-[12px] text-[var(--qz-fg-4)]">No storage data available.</div>
          )}
          {info.storage.map((s) => (
            <div key={s.filesystem} className="mb-3 last:mb-0">
              <div className="flex items-baseline justify-between mb-[5px]">
                <span className="text-[12px] text-[var(--qz-fg-2)]" style={{ fontFamily: "var(--qz-font-mono)" }}>
                  {s.filesystem}
                </span>
                <span className="text-[12px] text-[var(--qz-fg-3)]">
                  {formatBytes(s.used_bytes)} / {formatBytes(s.size_bytes)}
                  {s.used_pct != null && ` (${s.used_pct}%)`}
                </span>
              </div>
              <Bar pct={s.used_pct} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
