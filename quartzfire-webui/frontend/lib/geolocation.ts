// Geolocation data layer — country filtering on top of IPFire libloc.
//
// Two halves, mirroring how the feature is built on the device:
//   * CONFIG (actions + policies) is real VyOS config under
//     `service geolocation …` (nodes shipped by the quartzfire-geoip
//     package). It is read via the VyOS API proxy and edited diff-style
//     under commit-confirm, exactly like the firewall pages — so
//     geolocation changes participate in commit, rollback, and save/load.
//   * DATABASE/STATUS (libloc version, updates, per-action hit counters,
//     the country list, IP lookup) comes from the backend's
//     /api/geolocation/* endpoints, fed by the root helpers' /run files.
//
// Enforcement model (see quartzfire-geoip/docs/design.md): each enabled
// policy replicates its target firewall rule's match in the dedicated
// `inet qz_geo` table and jumps to the action's verdict chain — per-country
// nftables sets (geo4_cn / geo6_cn), one set lookup per new connection.

import { apiFetch, vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";
import type { RuleChain } from "./firewall";

/// Geolocation can drop the operator's own traffic (e.g. blocking the country
/// the admin sits in on an input-chain rule), so writes commit under
/// commit-confirm like every other risky domain.
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "Geolocation configuration change");

export type GeoMode = "block-listed" | "allow-listed";
export type GeoUnknown = "allow" | "block";
export type GeoDirection = "source" | "destination" | "both";

export const GEO_MODE_LABEL: Record<GeoMode, string> = {
  "block-listed": "Block selected countries",
  "allow-listed": "Only allow selected countries",
};

export const GEO_DIRECTION_LABEL: Record<GeoDirection, string> = {
  source: "Source",
  destination: "Destination",
  both: "Both",
};

export interface GeoAction {
  name: string;
  description: string | null;
  /** Missing on CLI-created actions until set; the form requires it. */
  mode: GeoMode | null;
  /** Upper-case ISO 3166-1 alpha-2 codes. */
  countries: string[];
  unknownIp: GeoUnknown;
  log: boolean;
}

export interface GeoPolicy {
  id: number;
  action: string;
  ruleset: RuleChain;
  rule: number;
  direction: GeoDirection;
  enabled: boolean;
}

export interface GeolocationConfig {
  actions: GeoAction[];
  policies: GeoPolicy[];
}

export function emptyGeolocationConfig(): GeolocationConfig {
  return { actions: [], policies: [] };
}

// ── config reads ──────────────────────────────────────────────────────────────

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

/// A multi-value leaf — VyOS renders one value as a string, several as an array.
function childList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((m): m is string => typeof m === "string");
  return [];
}

const asMode = (v: string | null): GeoMode | null =>
  v === "block-listed" || v === "allow-listed" ? v : null;

const asDirection = (v: string | null): GeoDirection =>
  v === "source" || v === "destination" || v === "both" ? v : "both";

const asRuleset = (v: string | null): RuleChain =>
  v === "input" || v === "output" ? v : "forward";

export async function fetchGeolocation(): Promise<GeolocationConfig> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["service", "geolocation"],
  });
  if (!resp.success) {
    // "Configuration under specified path is empty" = feature unconfigured.
    if ((resp.error ?? "").toLowerCase().includes("empty")) return emptyGeolocationConfig();
    throw new Error(resp.error || "Device returned an error reading the geolocation config.");
  }
  const cfg = resp.data ?? {};

  const actions: GeoAction[] = Object.entries(childCfg(cfg, "action") ?? {}).map(
    ([name, raw]) => {
      const a = (raw ?? {}) as Cfg;
      return {
        name,
        description: childStr(a, "description"),
        mode: asMode(childStr(a, "mode")),
        countries: childList(a, "country").map((c) => c.toUpperCase()),
        unknownIp: childStr(a, "unknown-ip") === "block" ? "block" : "allow",
        log: "log" in a,
      };
    },
  );
  actions.sort((a, b) => a.name.localeCompare(b.name));

  const policies: GeoPolicy[] = Object.entries(childCfg(cfg, "policy") ?? {}).map(
    ([num, raw]) => {
      const p = (raw ?? {}) as Cfg;
      return {
        id: Number(num) || 0,
        action: childStr(p, "action") ?? "",
        ruleset: asRuleset(childStr(p, "ruleset")),
        rule: Number(childStr(p, "rule")) || 0,
        direction: asDirection(childStr(p, "direction")),
        enabled: !("disable" in p),
      };
    },
  );
  policies.sort((a, b) => a.id - b.id);

  return { actions, policies };
}

// ── usage lookups ─────────────────────────────────────────────────────────────

/// Policy numbers referencing an action — backs "in use" counts and the
/// delete guard (the device's commit-time verify also refuses the delete).
export function actionUsage(policies: GeoPolicy[], name: string): number[] {
  return policies.filter((p) => p.action === name).map((p) => p.id);
}

// ── writes: actions ───────────────────────────────────────────────────────────

const actionBase = (name: string) => ["service", "geolocation", "action", name];

/// Client-side mirror of the device's action-name rule (nft identifiers).
export function validateActionName(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) {
    return "Names must start with a letter and contain only letters, digits, and underscores (max 32).";
  }
  return null;
}

/// Desired action. `original_name` identifies the action being edited; a
/// rename rebuilds the node and repoints every policy that referenced it.
export interface GeoActionUpdate {
  name: string;
  description: string | null;
  mode: GeoMode;
  countries: string[];
  unknownIp: GeoUnknown;
  log: boolean;
  original_name: string | null;
}

export function diffGeoAction(
  existing: GeoAction[],
  policies: GeoPolicy[],
  u: GeoActionUpdate,
): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: actionBase(u.original_name!) });
    // Keep referencing policies attached across the rename (same commit, so
    // the device's verify never sees a dangling reference).
    for (const p of policies) {
      if (p.action === u.original_name) {
        out.push({ op: "set", path: [...policyBase(p.id), "action", u.name] });
      }
    }
  }

  const live = moved ? null : existing.find((a) => a.name === u.name) ?? null;
  const base = actionBase(u.name);

  const leaf = (sub: string, liveV: string | null, desired: string | null) => {
    if (desired === liveV) return;
    if (desired !== null) out.push({ op: "set", path: [...base, sub, desired] });
    else out.push({ op: "delete", path: [...base, sub] });
  };
  leaf("description", live?.description ?? null, u.description?.trim() || null);
  leaf("mode", live?.mode ?? null, u.mode);
  leaf("unknown-ip", live ? live.unknownIp : null, u.unknownIp === "block" ? "block" : null);

  const liveCountries = live?.countries ?? [];
  const newCountries = [...new Set(u.countries.map((c) => c.trim().toUpperCase()))];
  for (const c of newCountries) {
    if (!liveCountries.includes(c)) out.push({ op: "set", path: [...base, "country", c] });
  }
  for (const c of liveCountries) {
    if (!newCountries.includes(c)) out.push({ op: "delete", path: [...base, "country", c] });
  }

  const liveLog = live?.log ?? false;
  if (u.log !== liveLog) {
    if (u.log) out.push({ op: "set", path: [...base, "log"] });
    else out.push({ op: "delete", path: [...base, "log"] });
  }

  return out;
}

/// Apply a desired action. Returns the number of changes applied.
export function applyGeoAction(
  existing: GeoAction[],
  policies: GeoPolicy[],
  update: GeoActionUpdate,
): Promise<number> {
  return commitAndSave(diffGeoAction(existing, policies, update));
}

/// Delete an action. Callers must check actionUsage first for a friendly
/// message; the device's commit-time verify refuses the delete regardless.
export function deleteGeoAction(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: actionBase(name) }]);
}

// ── writes: policies ──────────────────────────────────────────────────────────

const policyBase = (id: number) => ["service", "geolocation", "policy", String(id)];

/// Desired policy. `original_id` identifies the policy being edited.
export interface GeoPolicyUpdate {
  id: number;
  action: string;
  ruleset: RuleChain;
  rule: number;
  direction: GeoDirection;
  enabled: boolean;
  original_id: number | null;
}

export function diffGeoPolicy(existing: GeoPolicy[], u: GeoPolicyUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved = u.original_id !== null && u.original_id !== u.id;
  if (moved) out.push({ op: "delete", path: policyBase(u.original_id!) });

  const live = moved ? null : existing.find((p) => p.id === u.id) ?? null;
  const base = policyBase(u.id);

  const leaf = (sub: string, liveV: string | null, desired: string) => {
    if (desired === liveV) return;
    out.push({ op: "set", path: [...base, sub, desired] });
  };
  leaf("action", live?.action ?? null, u.action);
  leaf("ruleset", live?.ruleset ?? null, u.ruleset);
  leaf("rule", live ? String(live.rule) : null, String(u.rule));
  leaf("direction", live?.direction ?? null, u.direction);

  const liveEnabled = live?.enabled ?? true;
  if (u.enabled !== liveEnabled) {
    if (u.enabled) out.push({ op: "delete", path: [...base, "disable"] });
    else out.push({ op: "set", path: [...base, "disable"] });
  }

  return out;
}

/// Apply a desired policy. Returns the number of changes applied.
export function applyGeoPolicy(existing: GeoPolicy[], update: GeoPolicyUpdate): Promise<number> {
  return commitAndSave(diffGeoPolicy(existing, update));
}

export function deleteGeoPolicy(id: number): Promise<number> {
  return commitAndSave([{ op: "delete", path: policyBase(id) }]);
}

/// Inline enable/disable toggle (applies via the normal commit flow).
export function setGeoPolicyEnabled(policy: GeoPolicy, enabled: boolean): Promise<number> {
  if (policy.enabled === enabled) return Promise.resolve(0);
  const base = policyBase(policy.id);
  return commitAndSave([
    enabled
      ? { op: "delete", path: [...base, "disable"] }
      : { op: "set", path: [...base, "disable"] },
  ]);
}

/// Policy number for a new policy: appended after the last one, in gaps of 10
/// (matching the firewall rule-number convention).
export function nextPolicyId(policies: GeoPolicy[]): number {
  const max = policies.reduce((m, p) => Math.max(m, p.id), 0);
  return max + 10;
}

// ── backend API: database / status / lookup ───────────────────────────────────

export interface GeoCountry {
  code: string;
  name: string;
  continent: string | null;
}

export interface GeoCountries {
  available: boolean;
  db_version: number | null;
  countries: GeoCountry[];
}

export function fetchGeoCountries(): Promise<GeoCountries> {
  return apiFetch<GeoCountries>("/geolocation/countries");
}

/// The helpers' merged status report (/run/quartzfire-geoip/status.json).
export interface GeoStatusReport {
  db?: { present: boolean; version: number | null; signature_ok: boolean | null } | null;
  update?: {
    time: number;
    ok: boolean;
    changed?: boolean;
    message: string | null;
    schedule?: string;
  } | null;
  apply?: { time: number; ok: boolean; error: string | null } | null;
  policy_errors?: { policy: number; error: string }[];
  set_counts?: Record<string, number>;
  active?: boolean;
}

export interface GeoCounters {
  time: number;
  /** Named per-action counters: packets/bytes DROPPED by that action. */
  actions: Record<string, { packets: number; bytes: number }>;
  /** Per-policy jump-rule counters: new connections CHECKED (keyed by policy
   *  number as a string). Absent from dumps written by older helpers. */
  policies?: Record<string, { packets: number; bytes: number }>;
  /** Per-country blocked packets/bytes (keyed by UPPER-case ISO code) from
   *  block-listed actions — feeds the Top Blocked Countries tile. Zero-hit
   *  countries are omitted; absent from dumps written by older helpers. */
  countries?: Record<string, { packets: number; bytes: number }>;
}

export interface GeoStatus {
  status: GeoStatusReport | null;
  counters: GeoCounters | null;
}

export function fetchGeoStatus(): Promise<GeoStatus> {
  return apiFetch<GeoStatus>("/geolocation/status");
}

/// Request an immediate database update; the root updater runs it
/// asynchronously — poll fetchGeoStatus for the outcome.
export function requestGeoUpdate(): Promise<{ requested: boolean; seq: number }> {
  return apiFetch("/geolocation/update", { method: "POST" });
}

export interface GeoLookupResult {
  ip?: string;
  country?: string | null;
  country_name?: string | null;
  network?: string | null;
  db_version?: number;
  error?: string;
}

export function geoLookup(ip: string): Promise<GeoLookupResult> {
  return apiFetch<GeoLookupResult>(`/geolocation/lookup?ip=${encodeURIComponent(ip.trim())}`);
}

// ── backend API: block-event alerts ───────────────────────────────────────────

/// One geolocation block event, parsed by the backend from a netfilter
/// `[GEO-<action>]` kernel LOG line. Fields past the action name are
/// best-effort (the kernel LOG target omits ports for non-TCP/UDP traffic and
/// the outbound interface on the input chain). `ts` is ms since the epoch.
export interface GeoEvent {
  ts: number;
  action_name: string;
  iif?: string;
  oif?: string;
  src?: string;
  dst?: string;
  proto?: string;
  spt?: number;
  dpt?: number;
}

/// Stable-ish identity for de-duping the live stream against history.
export function geoEventKey(e: GeoEvent): string {
  return `${e.ts}|${e.action_name}|${e.src ?? ""}:${e.spt ?? ""}|${e.dst ?? ""}:${e.dpt ?? ""}|${e.proto ?? ""}`;
}

/// Persisted block events (newest first) from the journal's kernel backlog.
/// Live events arrive over SSE at GET /api/geolocation/alerts.
export function fetchGeoAlertHistory(): Promise<GeoEvent[]> {
  return apiFetch<GeoEvent[]>("/geolocation/alerts/history");
}

// ── backend API: traffic-by-country (Geolocation Map globe) ────────────────────

export interface GeoTrafficEntry {
  /** UPPER-case ISO 3166-1 alpha-2 code. */
  code: string;
  /** Active connections observed to/from that country at the last sample. */
  count: number;
}

export interface GeoTraffic {
  time: number;
  db_version: number | null;
  countries: GeoTrafficEntry[];
}

/// Active connections grouped by country (sampled from conntrack by the
/// quartzfire-geoip-traffic timer). Empty shape until the first sample.
export function fetchGeoTraffic(): Promise<GeoTraffic> {
  return apiFetch<GeoTraffic>("/geolocation/traffic");
}

// ── display helpers ───────────────────────────────────────────────────────────

/// Flag emoji from a country code (regional-indicator pair) — no data needed.
export function flagEmoji(code: string): string {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(
    0x1f1e6 + (cc.charCodeAt(0) - 65),
    0x1f1e6 + (cc.charCodeAt(1) - 65),
  );
}

/// libloc continent codes → display names (for the picker's groupings).
export const CONTINENT_NAMES: Record<string, string> = {
  AF: "Africa",
  AN: "Antarctica",
  AS: "Asia",
  EU: "Europe",
  NA: "North America",
  OC: "Oceania",
  SA: "South America",
};

/// Country display name lookup with a graceful fallback to the bare code
/// (e.g. a config listing a country the current database doesn't know).
export function countryName(countries: GeoCountry[], code: string): string {
  return countries.find((c) => c.code === code.toUpperCase())?.name ?? code.toUpperCase();
}
