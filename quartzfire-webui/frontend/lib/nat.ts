// NAT44 data layer (source SNAT / destination DNAT rules).
//
// Parsing is ported from the vyos-fabric backend (`routes/nat.rs`); writes
// follow the QuartzFire model — diff against the live config, commit straight
// to the VyOS API, and save to the boot config.

import { vyosApi } from "./api";
import { VyosCommand, VyosResponse } from "./interfaces";
import { guardedCommitAndSave } from "./guard";

/// A bad NAT change can sever the management session, so NAT writes commit
/// under commit-confirm: live immediately, auto-reverted unless the user
/// confirms in the shell banner (see lib/guard).
const commitAndSave = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "NAT configuration change");

export type NatSection = "source" | "destination";

export interface NatRule {
  rule: number;
  description: string | null;
  /** Interface name, or group name when `interface_group` is true. */
  interface: string | null;
  interface_group: boolean;
  source: string | null;
  /** `<type> <name>` of a firewall group match (read-only; managed under Firewall). */
  source_group: string | null;
  source_port: string | null;
  destination: string | null;
  destination_group: string | null;
  destination_port: string | null;
  /** Translation address: an IP, CIDR, range, or `masquerade`. */
  translation: string | null;
  translation_port: string | null;
  protocol: string | null;
  enabled: boolean;
}

/// A 1-to-1 (static) mapping: a source rule mapping `internal → external`
/// paired with a destination rule mirroring it (`external → internal`).
export interface StaticNatMapping {
  rule: number;
  description: string | null;
  interface: string | null;
  internal_address: string;
  external_address: string;
  enabled: boolean;
}

export interface Nat44Config {
  source: NatRule[];
  destination: NatRule[];
  static_nat: StaticNatMapping[];
}

/// Desired NAT44 rule. `original_rule` identifies the rule being edited; when
/// it differs from `rule` the edit is a renumber (old rule deleted, new one
/// built fresh).
export interface NatRuleUpdate {
  section: NatSection;
  rule: number;
  description: string | null;
  interface: string | null;
  source_address: string | null;
  /** `<type> <name>` firewall-group source match (e.g. `network-group LAN-NETS`);
   *  mutually exclusive with `source_address`. */
  source_group: string | null;
  source_port: string | null;
  destination_address: string | null;
  destination_port: string | null;
  /** An IP, CIDR, range, or `masquerade`. */
  translation_address: string | null;
  translation_port: string | null;
  protocol: string | null;
  enabled: boolean;
  original_rule: number | null;
}

// ── parse helpers ─────────────────────────────────────────────────────────────

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

function nestedStr(v: Cfg, parent: string, child: string): string | null {
  const p = childCfg(v, parent);
  return p ? childStr(p, child) : null;
}

/// A `group { <type> <name> }` reference under a `source`/`destination`
/// section, rendered as `<type> <name>` (e.g. `network-group NET-INSIDE-v4`).
function groupRef(v: Cfg, section: string): string | null {
  const g = childCfg(childCfg(v, section) ?? {}, "group");
  if (!g) return null;
  const [ty, name] = Object.entries(g)[0] ?? [];
  return ty && typeof name === "string" ? `${ty} ${name}` : null;
}

/// Translation target: an address (which may be the literal `masquerade`), or
/// the legacy valueless `masquerade` node.
function translationOf(v: Cfg): string | null {
  const t = childCfg(v, "translation");
  if (!t) return null;
  return childStr(t, "address") ?? ("masquerade" in t ? "masquerade" : null);
}

/// 1.4+: `<key> name <iface>` or `<key> group <iface-group>`; 1.3: `<key> <iface>`.
function ifaceOf(v: Cfg, key: string): { name: string | null; group: boolean } {
  const node = v[key];
  if (typeof node === "string") return { name: node.trim() || null, group: false };
  if (node && typeof node === "object") {
    const n = childStr(node as Cfg, "name");
    if (n) return { name: n, group: false };
    const g = childStr(node as Cfg, "group");
    if (g) return { name: g, group: true };
  }
  return { name: null, group: false };
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// The full running `nat` config node ({} when nothing is configured).
async function fetchNatConfig(): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["nat"],
  });

  if (resp.success) return resp.data ?? {};
  // "Configuration under specified path is empty" just means no NAT rules yet.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading NAT.");
}

const IFACE_KEY: Record<NatSection, string> = {
  source: "outbound-interface",
  destination: "inbound-interface",
};

/// Parse `nat <section> rule <n>` into a list sorted by rule number.
function parseRules(nat: Cfg, section: NatSection): NatRule[] {
  const rules = childCfg(childCfg(nat, section) ?? {}, "rule") ?? {};

  return Object.entries(rules)
    .map(([num, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const iface = ifaceOf(cfg, IFACE_KEY[section]);
      return {
        rule: Number(num) || 0,
        description: childStr(cfg, "description"),
        interface: iface.name,
        interface_group: iface.group,
        source: nestedStr(cfg, "source", "address"),
        source_group: groupRef(cfg, "source"),
        source_port: nestedStr(cfg, "source", "port"),
        destination: nestedStr(cfg, "destination", "address"),
        destination_group: groupRef(cfg, "destination"),
        destination_port: nestedStr(cfg, "destination", "port"),
        translation: translationOf(cfg),
        translation_port: nestedStr(cfg, "translation", "port"),
        protocol: childStr(cfg, "protocol"),
        enabled: !("disable" in cfg),
      };
    })
    .sort((a, b) => a.rule - b.rule);
}

/// Splits parsed rules into source/destination lists plus 1-to-1 (static)
/// mappings. A rule number present in both `source` and `destination` whose
/// addresses mirror (source `source`→`translation` equals destination
/// `translation`←`destination`) is lifted into `static_nat` and removed from
/// both lists.
function splitStatic(source: NatRule[], destination: NatRule[]): Nat44Config {
  const static_nat: StaticNatMapping[] = [];
  const paired = new Set<number>();
  const dstByRule = new Map(destination.map((d) => [d.rule, d]));

  for (const s of source) {
    const d = dstByRule.get(s.rule);
    if (!d) continue;
    const internal = s.source;
    const external = s.translation;
    // Mirror check: both addresses present and swapped on the destination rule.
    if (!internal || !external || d.destination !== external || d.translation !== internal) {
      continue;
    }
    static_nat.push({
      rule: s.rule,
      description: s.description ?? d.description,
      interface: s.interface_group ? null : s.interface,
      internal_address: internal,
      external_address: external,
      enabled: s.enabled && d.enabled,
    });
    paired.add(s.rule);
  }

  return {
    source: source.filter((r) => !paired.has(r.rule)),
    destination: destination.filter((r) => !paired.has(r.rule)),
    static_nat,
  };
}

/// Configured NAT44 source and destination rules plus 1-to-1 (static)
/// mappings, from the running config.
export async function fetchNat44(): Promise<Nat44Config> {
  const nat = await fetchNatConfig();
  return splitStatic(parseRules(nat, "source"), parseRules(nat, "destination"));
}

// ── writes ────────────────────────────────────────────────────────────────────

/// Config path of a rule node: `nat <section> rule <n>`.
const ruleBase = (section: NatSection, rule: number) => ["nat", section, "rule", String(rule)];

/// Diff a desired NAT44 rule against the live list into a minimal set/delete
/// command list. An edit that renumbers is a move: drop the old rule and
/// rebuild fresh.
export function diffNatRule(existing: NatRule[], u: NatRuleUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved = u.original_rule !== null && u.original_rule !== u.rule;
  if (moved) {
    out.push({ op: "delete", path: ruleBase(u.section, u.original_rule!) });
  }

  // After a renumber the target is brand new, so diff against an empty live rule.
  const live = moved ? null : existing.find((r) => r.rule === u.rule) ?? null;

  const base = ruleBase(u.section, u.rule);
  const body: VyosCommand[] = [];
  const leaf = (sub: string[], liveV: string | null, desiredRaw: string | null) => {
    const desired = desiredRaw?.trim() || null;
    if (desired === liveV) return;
    if (desired !== null) body.push({ op: "set", path: [...base, ...sub, desired] });
    else if (liveV !== null) body.push({ op: "delete", path: [...base, ...sub] });
  };

  leaf(["description"], live?.description ?? null, u.description);

  // Source match — a literal address or a firewall-group reference (stored as
  // `<type> <name>`), mutually exclusive. Deletes are emitted before sets so
  // the departing form is gone before the new one lands in the same commit.
  const newSrcAddr = u.source_address?.trim() || null;
  const newSrcGroup = u.source_group?.trim() || null;
  const liveSrcAddr = live?.source ?? null;
  const liveSrcGroup = live?.source_group ?? null;
  if (liveSrcAddr !== null && newSrcAddr === null) {
    body.push({ op: "delete", path: [...base, "source", "address"] });
  }
  // A group set replaces a same-type value, but a type change (`network-group`
  // → `address-group`) would leave the old sibling leaf behind — clear the node.
  if (
    liveSrcGroup !== null &&
    (newSrcGroup === null || newSrcGroup.split(" ")[0] !== liveSrcGroup.split(" ")[0])
  ) {
    body.push({ op: "delete", path: [...base, "source", "group"] });
  }
  if (newSrcAddr !== null && newSrcAddr !== liveSrcAddr) {
    body.push({ op: "set", path: [...base, "source", "address", newSrcAddr] });
  }
  if (newSrcGroup !== null && newSrcGroup !== liveSrcGroup) {
    body.push({ op: "set", path: [...base, "source", "group", ...newSrcGroup.split(" ")] });
  }

  leaf(["source", "port"], live?.source_port ?? null, u.source_port);
  leaf(["destination", "address"], live?.destination ?? null, u.destination_address);
  leaf(["destination", "port"], live?.destination_port ?? null, u.destination_port);
  leaf(["protocol"], live?.protocol ?? null, u.protocol);
  leaf(["translation", "address"], live?.translation ?? null, u.translation_address);
  leaf(["translation", "port"], live?.translation_port ?? null, u.translation_port);

  // Interface — written as `<key> name <iface>` (1.4+ form). An unchanged value
  // is left alone, so a rule matching by interface group survives other edits;
  // changing it removes the whole `<key>` node first so the stale form is
  // dropped before the new one is set.
  const key = IFACE_KEY[u.section];
  const newIface = u.interface?.trim() || null;
  const liveIface = live?.interface ?? null;
  if (newIface !== liveIface) {
    if (liveIface !== null) body.push({ op: "delete", path: [...base, key] });
    if (newIface !== null) body.push({ op: "set", path: [...base, key, "name", newIface] });
  }

  // Enabled state — VyOS models "off" as a valueless `disable` leaf. New rules
  // default enabled.
  const liveEnabled = live?.enabled ?? true;
  if (u.enabled !== liveEnabled) {
    if (u.enabled) body.push({ op: "delete", path: [...base, "disable"] });
    else body.push({ op: "set", path: [...base, "disable"] });
  }

  // A new rule with nothing else set still needs the node created.
  if (live === null && !body.some((c) => c.op === "set")) {
    body.length = 0;
    body.push({ op: "set", path: base });
  }
  out.push(...body);

  return out;
}

/// Apply a desired NAT44 rule. Returns the number of changes applied.
export function applyNatRule(existing: NatRule[], update: NatRuleUpdate): Promise<number> {
  return commitAndSave(diffNatRule(existing, update));
}

/// Delete a NAT44 rule.
export function deleteNatRule(section: NatSection, rule: number): Promise<number> {
  return commitAndSave([{ op: "delete", path: ruleBase(section, rule) }]);
}

// ── static (1-to-1) NAT ───────────────────────────────────────────────────────

/// Desired 1-to-1 mapping. `original_rule` identifies the mapping being edited.
export interface StaticNatUpdate {
  rule: number;
  description: string | null;
  interface: string | null;
  internal_address: string;
  external_address: string;
  enabled: boolean;
  original_rule: number | null;
}

/// Builds the source + destination rule updates backing one 1-to-1 mapping.
/// The source rule maps `internal → external`; the destination rule mirrors it
/// (`external → internal`). All non-static leaves are left null so editing a
/// mapping cleans up any stray ports/protocol on the underlying rules.
function staticPair(u: StaticNatUpdate): [NatRuleUpdate, NatRuleUpdate] {
  const common = {
    rule: u.rule,
    description: u.description,
    interface: u.interface,
    source_group: null,
    source_port: null,
    destination_port: null,
    translation_port: null,
    protocol: null,
    enabled: u.enabled,
    original_rule: u.original_rule,
  };
  return [
    {
      ...common,
      section: "source",
      source_address: u.internal_address,
      destination_address: null,
      translation_address: u.external_address,
    },
    {
      ...common,
      section: "destination",
      source_address: null,
      destination_address: u.external_address,
      translation_address: u.internal_address,
    },
  ];
}

/// Apply a desired 1-to-1 mapping as one transaction over both halves of the
/// pair. Re-reads the live config so the diff sees the full rule lists (the
/// display split hides paired rules). Returns the number of changes applied.
export async function applyStaticNat(u: StaticNatUpdate): Promise<number> {
  const nat = await fetchNatConfig();
  const [src, dst] = staticPair(u);
  return commitAndSave([
    ...diffNatRule(parseRules(nat, "source"), src),
    ...diffNatRule(parseRules(nat, "destination"), dst),
  ]);
}

/// Delete both halves of a 1-to-1 mapping.
export function deleteStaticNat(rule: number): Promise<number> {
  return commitAndSave([
    { op: "delete", path: ruleBase("source", rule) },
    { op: "delete", path: ruleBase("destination", rule) },
  ]);
}
