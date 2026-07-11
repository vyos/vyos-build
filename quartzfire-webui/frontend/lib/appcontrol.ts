// Application Control data layer.
//
// Mirrors the WatchGuard model and the IPS module's two halves:
//   * Actions + bindings (the policy) go to /api/appcontrol/settings — the
//     backend writes a desired-state file under /config and the root
//     qfappd-apply helper validates and publishes it to qfappd asynchronously
//     (poll status for the applied result).
//   * WHICH firewall rules enforce an action is expressed as bindings; the
//     Policies tab derives a binding's traffic match from the firewall rule.
//
// The application/category tree comes from qfappd's nDPI catalog dump so it
// tracks the installed signature set; a shipped fixture is used until qfappd
// has run once.

import { apiFetch } from "./api";

export type Verdict = "allow" | "block";
export type BlockMode = "drop" | "reset";

/// One named action (WatchGuard "Application Control Action", e.g. "Global").
export interface AcAction {
  /** "when application does not match". */
  default_action: Verdict;
  block_mode: BlockMode;
  /** category name → verdict. */
  categories: Record<string, Verdict>;
  /** nDPI app name → verdict (takes precedence over its category). */
  applications: Record<string, Verdict>;
}

/// nft match derived from a firewall rule — opaque to the UI; qfappd validates.
export interface AcMatch {
  iifname?: string[];
  oifname?: string[];
  saddr?: string[];
  daddr?: string[];
  l4?: { proto: "tcp" | "udp"; dports?: number[] }[];
}

export interface AcBinding {
  /** Stable id (the firewall rule number it came from). */
  id: number;
  /** Which named action governs this binding's traffic. */
  action: string;
  description: string;
  match: AcMatch;
}

export interface AcConfig {
  version: 2;
  actions: Record<string, AcAction>;
  bindings: AcBinding[];
}

/// One row of the status snapshot's top-applications list (by bytes seen up to
/// the classification decision — fast-path traffic is not counted).
export interface AcTopApp {
  app_id: number;
  app: string;
  bytes: number;
  flows: number;
}

/// The daemon's runtime status snapshot (/run/qfappd/status.json).
export interface AcRuntimeStatus {
  qfappd_version: string;
  ndpi_version: string;
  policy_generation: number;
  policy_last_error: string;
  decisions: number;
  blocked: number;
  unknown_pct: number;
  classification_rate_per_min: number;
  flowtable_entries: number;
  event_sink_drops: number;
  fail_mode: string;
  queues: { queue_num: number; packets: number; drops: number }[];
  /** Absent from status files written by older daemons. */
  top_apps?: AcTopApp[];
  total_app_bytes?: number;
}

/// qfappd-apply's last-run report. Validation happens BEFORE the policy
/// reaches qfappd, so `ok:false` means the saved config was refused and the
/// previously applied policy is still enforced (qfappd's own status shows no
/// error for this case).
export interface AcApplyReport {
  ok: boolean;
  error: string;
  /** Epoch seconds of the apply run. */
  time: number;
  /** mtime (epoch seconds) / size of the desired-state file that run saw. */
  desired_mtime: number;
  desired_size: number;
}

export interface AcStatus {
  settings: AcConfig;
  status: AcRuntimeStatus | null;
  running: boolean;
  /** Null until qfappd-apply has run once; absent from older backends. */
  apply?: AcApplyReport | null;
  /** Current desired-state file mtime (epoch seconds). Newer than
   *  `apply.desired_mtime` ⇒ saved changes have not been applied yet. */
  settings_mtime?: number | null;
}

export function emptyAcConfig(): AcConfig {
  return {
    version: 2,
    actions: { Global: { default_action: "allow", block_mode: "drop", categories: {}, applications: {} } },
    bindings: [],
  };
}

export function fetchAcStatus(): Promise<AcStatus> {
  return apiFetch<AcStatus>("/appcontrol/status");
}

/// Replace the desired policy; qfappd-apply applies it asynchronously.
export function saveAcConfig(config: AcConfig): Promise<AcConfig> {
  return apiFetch<AcConfig>("/appcontrol/settings", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

// ── catalog ────────────────────────────────────────────────────────────────────

export interface CatalogApp {
  id: number;
  name: string;
  category_id: number;
  category: string;
}

export interface Catalog {
  available: boolean;
  ndpi_version: string | null;
  num_protocols: number;
  applications: CatalogApp[];
}

export function fetchCatalog(): Promise<Catalog> {
  return apiFetch<Catalog>("/appcontrol/catalog");
}

/// A small offline fixture matching qfappd-core's catalog::fixture() — used
/// when qfappd hasn't dumped its catalog yet (available:false), so the Actions
/// editor still renders a category/app tree during bring-up.
export const CATALOG_FIXTURE: Catalog = {
  available: false,
  ndpi_version: "fixture",
  num_protocols: 11,
  applications: [
    { id: 5, name: "DNS", category_id: 14, category: "Network" },
    { id: 7, name: "HTTP", category_id: 5, category: "Web" },
    { id: 37, name: "BitTorrent", category_id: 7, category: "Download" },
    { id: 48, name: "QUIC", category_id: 5, category: "Web" },
    { id: 91, name: "TLS", category_id: 5, category: "Web" },
    { id: 119, name: "Facebook", category_id: 6, category: "SocialNetwork" },
    { id: 124, name: "YouTube", category_id: 1, category: "Media" },
    { id: 211, name: "PornHub", category_id: 21, category: "Adult" },
    { id: 244, name: "ChatGPT", category_id: 33, category: "AI" },
    { id: 245, name: "Claude", category_id: 33, category: "AI" },
  ],
};

/// Group a catalog into { category → apps } for the tree view.
export function groupByCategory(catalog: Catalog): { category: string; apps: CatalogApp[] }[] {
  const map = new Map<string, CatalogApp[]>();
  for (const app of catalog.applications) {
    if (app.name === "Unknown") continue;
    const list = map.get(app.category) ?? [];
    list.push(app);
    map.set(app.category, list);
  }
  return [...map.entries()]
    .map(([category, apps]) => ({ category, apps: apps.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/// Resolve the effective verdict for one app under an action (app > category >
/// default), matching qfappd's precedence.
export function effectiveVerdict(action: AcAction, app: CatalogApp): Verdict {
  if (app.name in action.applications) return action.applications[app.name];
  if (app.category in action.categories) return action.categories[app.category];
  return action.default_action;
}

// ── alerts ─────────────────────────────────────────────────────────────────────

/// One decision event — SSE payload of /api/appcontrol/alerts and the rows of
/// /api/appcontrol/alerts/history.
export interface AcEvent {
  /** Decision time, ms since epoch (from the event's own timestamp). */
  ts: number;
  src?: string;
  spt?: number;
  dst?: string;
  dpt?: number;
  proto?: string;
  app: string;
  category?: string;
  action: Verdict;
  action_name: string;
  block_mode: string;
  confidence?: string;
  sni?: string;
}

export function fetchAcAlertHistory(): Promise<AcEvent[]> {
  return apiFetch<AcEvent[]>("/appcontrol/alerts/history");
}

/// Identity for deduping live-stream events against fetched history.
export function eventKey(e: AcEvent): string {
  return `${e.ts}:${e.src ?? ""}:${e.spt ?? ""}:${e.dst ?? ""}:${e.dpt ?? ""}:${e.app}`;
}
