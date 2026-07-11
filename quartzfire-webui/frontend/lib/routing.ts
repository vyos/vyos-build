// Static routing data layer (`protocols static route` / `route6`).
//
// Reads and writes go straight to the VyOS HTTP API through the authenticated
// backend proxy, commit immediately, and are saved to the boot config.

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

/// A bad route change can sever the management session, so routing writes
/// commit under commit-confirm: live immediately, auto-reverted unless the
/// user confirms in the shell banner (see lib/guard).
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "Static route change");

export type RouteFamily = "ipv4" | "ipv6";

/// How the route reaches its destination: via a gateway address, out an
/// interface, or dropped (blackhole).
export type StaticRouteKind = "gateway" | "interface" | "blackhole";

/// One next-hop of a static route. VyOS allows several next-hops per
/// destination; the GUI models each (destination, next-hop) pair as a row.
export interface StaticRoute {
  family: RouteFamily;
  destination: string;
  kind: StaticRouteKind;
  /** Gateway address, or interface name for interface routes; null for blackhole. */
  via: string | null;
  /** Optional egress interface on a gateway next-hop. */
  interface: string | null;
  distance: number | null;
  enabled: boolean;
  /** Route-level description (shared by every next-hop of the destination). */
  description: string | null;
}

// ── parse ─────────────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function childCfg(v: Cfg, key: string): Cfg | null {
  const x = v[key];
  return x && typeof x === "object" ? (x as Cfg) : null;
}

function asDistance(v: Cfg): number | null {
  const d = childStr(v, "distance");
  const n = d === null ? NaN : Number(d);
  return Number.isInteger(n) ? n : null;
}

const isEnabled = (v: Cfg) => !("disable" in v);

const ROUTE_NODE: Record<RouteFamily, string> = { ipv4: "route", ipv6: "route6" };

function parseFamily(staticCfg: Cfg, family: RouteFamily): StaticRoute[] {
  const routes = childCfg(staticCfg, ROUTE_NODE[family]) ?? {};
  const out: StaticRoute[] = [];

  for (const [destination, raw] of Object.entries(routes)) {
    const cfg = (raw ?? {}) as Cfg;
    const description = childStr(cfg, "description");
    const common = { family, destination, description };

    for (const [via, hraw] of Object.entries(childCfg(cfg, "next-hop") ?? {})) {
      const hop = (hraw ?? {}) as Cfg;
      out.push({
        ...common,
        kind: "gateway",
        via,
        interface: childStr(hop, "interface"),
        distance: asDistance(hop),
        enabled: isEnabled(hop),
      });
    }
    for (const [via, hraw] of Object.entries(childCfg(cfg, "interface") ?? {})) {
      const hop = (hraw ?? {}) as Cfg;
      out.push({
        ...common,
        kind: "interface",
        via,
        interface: null,
        distance: asDistance(hop),
        enabled: isEnabled(hop),
      });
    }
    const blackhole = childCfg(cfg, "blackhole") ?? ("blackhole" in cfg ? {} : null);
    if (blackhole) {
      out.push({
        ...common,
        kind: "blackhole",
        via: null,
        interface: null,
        distance: asDistance(blackhole),
        enabled: true,
      });
    }
  }

  return out.sort(
    (a, b) => a.destination.localeCompare(b.destination) || (a.via ?? "").localeCompare(b.via ?? ""),
  );
}

/// Configured static routes (IPv4 + IPv6), one row per next-hop.
export async function fetchStaticRoutes(): Promise<StaticRoute[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["protocols"],
  });

  let staticCfg: Cfg = {};
  if (resp.success) staticCfg = childCfg(resp.data ?? {}, "static") ?? {};
  else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    throw new Error(resp.error || "Device returned an error reading static routes.");
  }

  return [...parseFamily(staticCfg, "ipv4"), ...parseFamily(staticCfg, "ipv6")];
}

// ── writes ────────────────────────────────────────────────────────────────────

const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

const routeBase = (family: RouteFamily, destination: string) => [
  "protocols",
  "static",
  ROUTE_NODE[family],
  destination,
];

/// Config path of one next-hop node within its route.
function hopPath(family: RouteFamily, destination: string, kind: StaticRouteKind, via: string | null): string[] {
  const base = routeBase(family, destination);
  if (kind === "gateway") return [...base, "next-hop", via ?? ""];
  if (kind === "interface") return [...base, "interface", via ?? ""];
  return [...base, "blackhole"];
}

/// Rows that belong to the same route node (same family + destination).
const siblings = (rows: StaticRoute[], family: RouteFamily, destination: string) =>
  rows.filter((r) => r.family === family && r.destination === destination);

/// Identity of a row within the config tree.
const sameHop = (r: StaticRoute, family: RouteFamily, destination: string, kind: StaticRouteKind, via: string | null) =>
  r.family === family && r.destination === destination && r.kind === kind && (r.via ?? null) === (via ?? null);

/// Desired static route next-hop. `original` identifies the row being edited;
/// when the identity (family/destination/kind/via) differs the edit is a move
/// (old node deleted, new one built fresh).
export interface StaticRouteUpdate {
  family: RouteFamily;
  destination: string;
  kind: StaticRouteKind;
  via: string | null;
  interface: string | null;
  distance: number | null;
  enabled: boolean;
  description: string | null;
  original: { family: RouteFamily; destination: string; kind: StaticRouteKind; via: string | null } | null;
}

/// Apply a desired static route next-hop. Returns the number of changes applied.
export function applyStaticRoute(existing: StaticRoute[], u: StaticRouteUpdate): Promise<number> {
  const out: VyosCommand[] = [];
  const o = u.original;
  const moved =
    o !== null &&
    !(o.family === u.family && o.destination === u.destination && o.kind === u.kind && (o.via ?? null) === (u.via ?? null));

  let routeDeleted = false;
  if (moved) {
    // Drop the old node — the whole route when this was its only next-hop, so
    // no empty `route <dst>` shell is left behind.
    const others = siblings(existing, o!.family, o!.destination).filter(
      (r) => !sameHop(r, o!.family, o!.destination, o!.kind, o!.via),
    );
    routeDeleted = others.length === 0;
    out.push({
      op: "delete",
      path: routeDeleted ? routeBase(o!.family, o!.destination) : hopPath(o!.family, o!.destination, o!.kind, o!.via),
    });
  }

  const live = moved || o === null ? null : existing.find((r) => sameHop(r, o.family, o.destination, o.kind, o.via)) ?? null;

  const hop = hopPath(u.family, u.destination, u.kind, u.via);
  // A fresh node must exist even when every optional leaf is empty.
  if (live === null) out.push({ op: "set", path: hop });

  const leaf = (sub: string[], liveV: string | null, desiredRaw: string | null) => {
    const desired = trimmed(desiredRaw);
    if (desired === liveV) return;
    if (desired !== null) out.push({ op: "set", path: [...hop, ...sub, desired] });
    else out.push({ op: "delete", path: [...hop, ...sub] });
  };

  leaf(["distance"], live?.distance != null ? String(live.distance) : null, u.distance !== null ? String(u.distance) : null);
  if (u.kind === "gateway") {
    leaf(["interface"], live?.interface ?? null, u.interface);
  }

  // Enabled state — a valueless `disable` leaf on the next-hop. Blackhole has
  // no disable knob.
  if (u.kind !== "blackhole") {
    const liveEnabled = live?.enabled ?? true;
    if (u.enabled !== liveEnabled) {
      if (u.enabled) out.push({ op: "delete", path: [...hop, "disable"] });
      else out.push({ op: "set", path: [...hop, "disable"] });
    }
  }

  // Description lives on the route node, shared by all its next-hops. When the
  // whole route node was just deleted (a type change on its only next-hop, same
  // destination), the live description is gone with it — diff against null so
  // it gets re-set on the rebuilt node.
  const wipedHere = routeDeleted && o!.family === u.family && o!.destination === u.destination;
  const liveDesc = wipedHere
    ? null
    : existing.find((r) => r.family === u.family && r.destination === u.destination)?.description ?? null;
  const base = routeBase(u.family, u.destination);
  const newDesc = trimmed(u.description);
  if (newDesc !== liveDesc) {
    if (newDesc !== null) out.push({ op: "set", path: [...base, "description", newDesc] });
    else out.push({ op: "delete", path: [...base, "description"] });
  }

  return commitAndSave(out);
}

/// Delete one next-hop — or its whole route node when it is the last one, so
/// no empty `route <dst>` shell is left behind.
export function deleteStaticRoute(existing: StaticRoute[], row: StaticRoute): Promise<number> {
  const others = siblings(existing, row.family, row.destination).filter(
    (r) => !sameHop(r, row.family, row.destination, row.kind, row.via),
  );
  return commitAndSave([
    {
      op: "delete",
      path: others.length === 0 ? routeBase(row.family, row.destination) : hopPath(row.family, row.destination, row.kind, row.via),
    },
  ]);
}
