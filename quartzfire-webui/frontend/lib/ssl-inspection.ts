// SSL Inspection data layer — Squid ssl_bump TLS interception.
//
// Two halves, mirroring how the feature is built on the device (see
// quartzfire-ssl-inspection/docs/design.md):
//   * CONFIG is real VyOS config under `service quartzfire ssl-inspection …`
//     (nodes shipped by the quartzfire-ssl-inspection package). It is read via
//     the VyOS API proxy and edited diff-style under commit-confirm, exactly
//     like the firewall/geolocation pages.
//   * STATUS / CA / REGENERATE comes from the backend's /api/ssl-inspection/*
//     endpoints, fed by the root qzssl helpers' /run files. The CA PRIVATE KEY
//     is never exposed by any of them.
//
// Architecture rule (binding): Squid is the SOLE TLS terminator and owns the
// one and only CA. A future content-filter engine attaches behind Squid over
// ICAP in PLAINTEXT mode — the content-filter UI section is intentionally inert
// here (no engine yet).

import { apiFetch, API, vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

// SSL inspection can break the operator's own HTTPS (a bad CA / wrong scope),
// so writes commit under commit-confirm like every other risky domain.
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "SSL Inspection configuration change");

export type SslDefaultAction = "inspect" | "splice";
export type UpstreamInvalid = "block" | "allow";
export type FailMode = "closed" | "open";

export interface SslContentFilter {
  icapHost: string;
  icapPort: number;
  reqmodService: string;
  respmodService: string;
  failMode: FailMode;
}

export interface SslInspectionConfig {
  enabled: boolean;
  interceptPort: number;
  interfaces: string[];
  defaultAction: SslDefaultAction;
  noInspect: string[];
  /** true = the shipped do-not-inspect baseline is applied (default). */
  defaultExclusions: boolean;
  upstreamInvalid: UpstreamInvalid;
  /** null = no content-filter engine attached (the default). */
  contentFilter: SslContentFilter | null;
  caDownloadInterfaces: string[];
}

export function emptySslInspectionConfig(): SslInspectionConfig {
  return {
    enabled: false,
    interceptPort: 3129,
    interfaces: [],
    defaultAction: "inspect",
    noInspect: [],
    defaultExclusions: true,
    upstreamInvalid: "block",
    contentFilter: null,
    caDownloadInterfaces: [],
  };
}

const BASE = ["service", "quartzfire", "ssl-inspection"];

// ── config reads ────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}

function childList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((m): m is string => typeof m === "string");
  return [];
}

export async function fetchSslInspection(): Promise<SslInspectionConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: BASE,
  });
  if (!resp.success) {
    if ((resp.error ?? "").toLowerCase().includes("empty")) return emptySslInspectionConfig();
    throw new Error(resp.error || "Device returned an error reading the SSL inspection config.");
  }
  const cfg = resp.data ?? {};

  const cf = childCfg(cfg, "content-filter");
  const contentFilter: SslContentFilter | null = cf
    ? {
        icapHost: childStr(cf, "icap-host") ?? "127.0.0.1",
        icapPort: Number(childStr(cf, "icap-port")) || 1344,
        reqmodService: childStr(cf, "reqmod-service") ?? "request",
        respmodService: childStr(cf, "respmod-service") ?? "response",
        failMode: childStr(cf, "fail-mode") === "open" ? "open" : "closed",
      }
    : null;

  return {
    enabled: "enable" in cfg,
    interceptPort: Number(childStr(cfg, "intercept-port")) || 3129,
    interfaces: childList(cfg, "interface"),
    defaultAction: childStr(cfg, "default-action") === "splice" ? "splice" : "inspect",
    noInspect: childList(cfg, "no-inspect"),
    defaultExclusions: !("disable-default-exclusions" in cfg),
    upstreamInvalid: childStr(cfg, "upstream-invalid") === "allow" ? "allow" : "block",
    contentFilter,
    caDownloadInterfaces: childList(childCfg(cfg, "ca-download") ?? {}, "interface"),
  };
}

// ── writes ──────────────────────────────────────────────────────────────────

/// Client-side mirror of the device's do-not-inspect pattern rule.
export function validateDomainPattern(pat: string): string | null {
  const core = pat.replace(/^\*\./, "").replace(/^\./, "");
  const ok = /^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
  if (!core || core.length > 253 || !ok.test(core)) {
    return "Use a domain, .suffix, or *.wildcard (e.g. .bank.com, *.mozilla.org).";
  }
  return null;
}

/// Diff the whole model into a VyOS command batch (set/delete leaves).
export function diffSslInspection(
  live: SslInspectionConfig,
  desired: SslInspectionConfig,
): VyosCommand[] {
  const out: VyosCommand[] = [];

  // Valueless enable.
  if (desired.enabled !== live.enabled) {
    out.push(desired.enabled
      ? { op: "set", path: [...BASE, "enable"] }
      : { op: "delete", path: [...BASE, "enable"] });
  }

  const leaf = (sub: string, liveV: string | null, desiredV: string | null) => {
    if (desiredV === liveV) return;
    if (desiredV !== null) out.push({ op: "set", path: [...BASE, sub, desiredV] });
    else out.push({ op: "delete", path: [...BASE, sub] });
  };
  leaf("intercept-port", String(live.interceptPort), String(desired.interceptPort));
  leaf("default-action", live.defaultAction, desired.defaultAction);
  leaf("upstream-invalid", live.upstreamInvalid, desired.upstreamInvalid);

  // Valueless disable-default-exclusions (present when baseline is OFF).
  if (desired.defaultExclusions !== live.defaultExclusions) {
    out.push(desired.defaultExclusions
      ? { op: "delete", path: [...BASE, "disable-default-exclusions"] }
      : { op: "set", path: [...BASE, "disable-default-exclusions"] });
  }

  multiDiff(out, [...BASE, "interface"], live.interfaces, desired.interfaces);
  multiDiff(out, [...BASE, "no-inspect"], live.noInspect, desired.noInspect);
  multiDiff(out, [...BASE, "ca-download", "interface"], live.caDownloadInterfaces, desired.caDownloadInterfaces);

  // Content filter (the inert-in-UI seam; still diffed for CLI-set values).
  if (!desired.contentFilter && live.contentFilter) {
    out.push({ op: "delete", path: [...BASE, "content-filter"] });
  } else if (desired.contentFilter) {
    const cf = desired.contentFilter;
    const lc = live.contentFilter;
    const cleaf = (sub: string, lv: string | null, dv: string) => {
      if (dv === lv) return;
      out.push({ op: "set", path: [...BASE, "content-filter", sub, dv] });
    };
    cleaf("icap-host", lc?.icapHost ?? null, cf.icapHost);
    cleaf("icap-port", lc ? String(lc.icapPort) : null, String(cf.icapPort));
    cleaf("reqmod-service", lc?.reqmodService ?? null, cf.reqmodService);
    cleaf("respmod-service", lc?.respmodService ?? null, cf.respmodService);
    cleaf("fail-mode", lc?.failMode ?? null, cf.failMode);
  }

  return out;
}

function multiDiff(out: VyosCommand[], path: string[], live: string[], desired: string[]) {
  const liveSet = new Set(live);
  const desiredSet = new Set(desired);
  for (const v of desiredSet) if (!liveSet.has(v)) out.push({ op: "set", path: [...path, v] });
  for (const v of liveSet) if (!desiredSet.has(v)) out.push({ op: "delete", path: [...path, v] });
}

/// Apply a desired config. Returns the number of changes applied (0 = no-op).
export function applySslInspection(
  live: SslInspectionConfig,
  desired: SslInspectionConfig,
): Promise<number> {
  const cmds = diffSslInspection(live, desired);
  if (cmds.length === 0) return Promise.resolve(0);
  return commitAndSave(cmds);
}

/// Enable/disable convenience (immediate commit).
export function setSslEnabled(live: SslInspectionConfig, enabled: boolean): Promise<number> {
  if (live.enabled === enabled) return Promise.resolve(0);
  return commitAndSave([
    enabled
      ? { op: "set", path: [...BASE, "enable"] }
      : { op: "delete", path: [...BASE, "enable"] },
  ]);
}

// ── backend API: status / CA / regenerate ───────────────────────────────────

/// Public CA metadata (`ca-info.json`) — no key, ever.
export interface CaInfo {
  present: boolean;
  key_present: boolean;
  subject?: string;
  issuer?: string;
  serial?: string;
  fingerprint_sha256?: string;
  not_before?: string;
  not_after?: string;
}

/// The qzssl status report (`/run/quartzfire-ssl/status.json`).
export interface SslStatusReport {
  enabled: boolean;
  squid?: { running: boolean; bump_capable: boolean | null; icap_capable: boolean | null };
  certgen_db_ready?: boolean;
  intercept_port?: number;
  interfaces?: string[];
  default_action?: string;
  no_inspect_count?: number;
  upstream_invalid?: string;
  icap?: {
    configured: boolean;
    endpoint?: string;
    fail_mode?: string;
    reachable?: boolean;
  };
  ca?: CaInfo;
  ca_download?: { port: number; interfaces: string[] };
  apply?: { time: number; ok: boolean; error: string | null };
}

export interface SslStatus {
  status: SslStatusReport | null;
  ca: CaInfo | null;
}

export function fetchSslStatus(): Promise<SslStatus> {
  return apiFetch<SslStatus>("/ssl-inspection/status");
}

/// Request a fresh inspection CA. WARNS the caller's UI first: all previously
/// distributed CAs become invalid and clients must reinstall. Runs
/// asynchronously as root — poll fetchSslStatus for the new fingerprint.
export function regenerateCa(): Promise<{ requested: boolean; seq: number }> {
  return apiFetch("/ssl-inspection/regenerate", { method: "POST" });
}

/// Authenticated CA download URLs (the box also serves these unauthenticated on
/// :4126 for client bootstrapping).
export const caCrtUrl = `${API}/ssl-inspection/ca.crt`;
export const caDerUrl = `${API}/ssl-inspection/ca.der`;

/// The plain-HTTP CA-distribution page clients use to install the root CA.
export function caDistUrl(host: string): string {
  return `http://${host}:4126/`;
}
