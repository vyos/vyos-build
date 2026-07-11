// Intrusion Prevention data layer.
//
// Two halves, mirroring the WatchGuard model:
//   * Engine settings (threat-level actions, scan mode, exceptions, signature
//     updates) go to the backend's /api/ips endpoints — the backend edits a
//     desired-state file under /config and a root helper applies it to
//     Suricata asynchronously (poll status to see the applied result).
//   * WHICH traffic is inspected is plain firewall config: rules with IPS
//     enabled use `action queue` (see lib/firewall.ts ipsRuleCommands), so
//     only their matches are handed to Suricata for an inline verdict.

import { apiFetch } from "./api";

export type ThreatLevel = "critical" | "high" | "medium" | "low" | "information";
export type LevelAction = "allow" | "drop" | "disable";
export type ScanMode = "full" | "fast";

/// Threat levels, most severe first, with the UI color chip. Levels derive
/// from signature priority (1→critical … 4→low, unclassified→information).
export const THREAT_LEVELS: { level: ThreatLevel; label: string; color: string }[] = [
  { level: "critical", label: "Critical", color: "#e5484d" },
  { level: "high", label: "High", color: "#f76b15" },
  { level: "medium", label: "Medium", color: "#f5d90a" },
  { level: "low", label: "Low", color: "#0ac5e5" },
  { level: "information", label: "Information", color: "#46a758" },
];

export const LEVEL_ACTION_LABEL: Record<LevelAction, string> = {
  drop: "Drop",
  allow: "Allow",
  disable: "Disabled",
};

export interface LevelPolicy {
  action: LevelAction;
  /** Highlight matches as alarms in the Alerts view. */
  alarm: boolean;
  /** Show matches in the Alerts view at all. */
  log: boolean;
}

export interface IpsSettings {
  enabled: boolean;
  scan_mode: ScanMode;
  critical: LevelPolicy;
  high: LevelPolicy;
  medium: LevelPolicy;
  low: LevelPolicy;
  information: LevelPolicy;
  /** Excepted signature IDs — alert-only: never blocked, still logged. */
  exceptions: number[];
  /** Signature source URL; null = suricata-update's default (ET Open). */
  update_url: string | null;
  /** Server-managed update request counter — echo back what was fetched. */
  update_seq: number;
}

/// The root helper's last apply report (see scripts/ips-apply).
export interface IpsApplyReport {
  applied_at: number;
  enabled: boolean;
  running: boolean;
  update_seq_applied: number;
  last_update: { time: number; ok: boolean; message: string | null } | null;
  rule_counts: (Partial<Record<ThreatLevel, number>> & { disabled?: number }) | null;
  error: string | null;
}

export interface IpsStatus {
  settings: IpsSettings;
  /** Whether suricata is active right now. */
  running: boolean;
  /** Null until the helper has run once (e.g. IPS units not installed). */
  apply: IpsApplyReport | null;
}

export function fetchIpsStatus(): Promise<IpsStatus> {
  return apiFetch<IpsStatus>("/ips/status");
}

/// Replace the desired settings; the helper applies them asynchronously.
export function saveIpsSettings(settings: IpsSettings): Promise<IpsSettings> {
  return apiFetch<IpsSettings>("/ips/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/// Request a signature update (suricata-update on the device).
export function requestIpsUpdate(): Promise<IpsSettings> {
  return apiFetch<IpsSettings>("/ips/update", { method: "POST" });
}

/// One alert (see backend/src/ips.rs AlertEntry) — the SSE payload of
/// /api/ips/alerts and the rows of /api/ips/alerts/history.
export interface IpsAlert {
  /** Alert time (ms since epoch), from the EVE record itself — identical
   *  whether the alert arrived live or from history. */
  ts: number;
  /** Suricata flow id — part of the live/history dedupe key. */
  flow_id?: number;
  level: ThreatLevel;
  severity: number;
  /** `allowed` (alert-only) or `blocked` (dropped inline). */
  action: string;
  sid: number;
  signature: string;
  category?: string;
  src?: string;
  spt?: number;
  dst?: string;
  dpt?: number;
  proto?: string;
}

/// Persisted alert history, newest first — read from the EVE file on the
/// device, so it survives reboots (the live stream's journal does not).
export function fetchIpsAlertHistory(): Promise<IpsAlert[]> {
  return apiFetch<IpsAlert[]>("/ips/alerts/history");
}

/// Identity for deduping live-stream alerts against fetched history.
export function alertKey(a: IpsAlert): string {
  return `${a.ts}:${a.sid}:${a.flow_id ?? ""}`;
}
