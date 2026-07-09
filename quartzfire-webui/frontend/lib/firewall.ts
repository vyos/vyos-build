// Firewall data layer — a WatchGuard-style model over native VyOS config.
//
// The GUI works with three object kinds, all stored as plain VyOS firewall
// config so the CLI view stays normal:
//   Aliases  → `firewall group` address-group (hosts) / network-group
//              (networks) / domain-group (FQDNs)
//   Policies → `firewall group port-group`; the protocol is kept in a
//              `[tcp]`/`[udp]`/`[tcp_udp]` marker prefixed to the group
//              description (port-groups have no protocol of their own)
//   Rules    → `firewall ipv4 forward filter rule <n>`, ordered by rule
//              number in gaps of 10 so drag-reorder renumbers cleanly
//
// A rule's From/To is a WatchGuard-style list matching ANY of its entries. One
// native rule can't OR several groups (multiple criteria AND together), so a
// multi-entry side is backed by a hidden auto-managed group — an address/
// network-group `include`-ing each chosen alias, or an interface-group holding
// the chosen interfaces — marked with a `[qz-rule]` description and kept off
// the Aliases page.
//
// Writes follow the QuartzFire model — diff against the live config, commit
// straight to the VyOS API, and save to the boot config.

import { vyosApi } from "./api";
import { commitAndSave, VyosCommand, VyosResponse } from "./interfaces";

export type AliasType = "host" | "network" | "fqdn";

/// VyOS group node + member leaf backing each alias type.
export const ALIAS_GROUP: Record<AliasType, { node: string; memberLeaf: string; label: string }> = {
  host:    { node: "address-group", memberLeaf: "address", label: "Host" },
  network: { node: "network-group", memberLeaf: "network", label: "Network" },
  fqdn:    { node: "domain-group",  memberLeaf: "address", label: "FQDN" },
};

const GROUP_NODE_TO_TYPE: Record<string, AliasType> = {
  "address-group": "host",
  "network-group": "network",
  "domain-group": "fqdn",
};

export interface FirewallAlias {
  name: string;
  type: AliasType;
  description: string | null;
  members: string[];
}

export type PolicyProtocol = "tcp" | "udp" | "tcp_udp";

export const PROTOCOL_LABEL: Record<PolicyProtocol, string> = {
  tcp: "TCP",
  udp: "UDP",
  tcp_udp: "TCP/UDP",
};

export interface FirewallPolicy {
  name: string;
  protocol: PolicyProtocol;
  /** Port numbers, ranges (`8000-8010`), or service names (`https`). */
  ports: string[];
  description: string | null;
}

export type RuleAction = "accept" | "drop" | "reject";

/// Auto-managed OR group backing a multi-entry From/To side.
export interface AutoGroup {
  name: string;
  /** VyOS group node: address-group, network-group, or interface-group. */
  node: string;
  /** Included alias-group names (address/network groups). */
  includes: string[];
  /** Member interfaces (interface groups). */
  interfaces: string[];
}

/// Description marker identifying auto-managed groups.
export const AUTO_MARK = "[qz-rule]";

/// One side of a rule match as stored in the config: a group reference, an
/// interface (by name or interface-group), a literal address, or none (= any).
/// `iface`/`iface_group` map to the rule-level `inbound-interface` (From) /
/// `outbound-interface` (To) node.
export interface RuleEndpoint {
  group_type: string | null;
  group_name: string | null;
  address: string | null;
  iface: string | null;
  iface_group: string | null;
}

export interface FirewallRule {
  rule: number;
  /** Rule name, stored as the VyOS `description` leaf. */
  name: string | null;
  action: RuleAction | null;
  from: RuleEndpoint;
  to: RuleEndpoint;
  /** Policy (destination port-group) name, or null = any port. */
  policy: string | null;
  protocol: string | null;
  enabled: boolean;
  /** Full raw config subtree — used to rebuild the rule when renumbering so
   *  leaves this UI doesn't model (log, state, …) survive a reorder. */
  raw: Cfg;
}

export interface FirewallConfig {
  aliases: FirewallAlias[];
  policies: FirewallPolicy[];
  rules: FirewallRule[];
  /** Auto-managed OR groups created by the rule editor. */
  auto_groups: AutoGroup[];
  /** Every configured group name across all group types — used to pick fresh
   *  auto-group names without colliding with user-defined groups. */
  group_names: string[];
  /** `firewall ipv4 forward filter default-action` (null = VyOS default). */
  default_action: string | null;
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
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Cfg) : null;
}

/// A multi-value leaf — VyOS renders one value as a JSON string and several
/// as a JSON array.
function childList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((m): m is string => typeof m === "string");
  return [];
}

// ── policy protocol marker ────────────────────────────────────────────────────

const PROTO_MARK = /^\[(tcp|udp|tcp_udp)\]\s*/;

/// Split a port-group description into (protocol, user description).
/// A group without a marker (created outside this UI) defaults to tcp_udp.
function decodePolicyDescription(desc: string | null): { protocol: PolicyProtocol; description: string | null } {
  if (!desc) return { protocol: "tcp_udp", description: null };
  const m = desc.match(PROTO_MARK);
  if (!m) return { protocol: "tcp_udp", description: desc };
  const rest = desc.slice(m[0].length).trim();
  return { protocol: m[1] as PolicyProtocol, description: rest === "" ? null : rest };
}

function encodePolicyDescription(protocol: PolicyProtocol, description: string | null): string {
  const d = description?.trim() ?? "";
  return d === "" ? `[${protocol}]` : `[${protocol}] ${d}`;
}

// ── reads ─────────────────────────────────────────────────────────────────────

/// The full running `firewall` config node ({} when nothing is configured).
async function fetchFirewallConfig(): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["firewall"],
  });

  if (resp.success) return resp.data ?? {};
  // "Configuration under specified path is empty" just means no firewall yet.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading the firewall.");
}

function parseAliases(group: Cfg): FirewallAlias[] {
  const out: FirewallAlias[] = [];
  for (const [node, type] of Object.entries(GROUP_NODE_TO_TYPE)) {
    const groups = childCfg(group, node) ?? {};
    for (const [name, raw] of Object.entries(groups)) {
      const cfg = (raw ?? {}) as Cfg;
      const description = childStr(cfg, "description");
      if (description?.startsWith(AUTO_MARK)) continue; // rule-editor internals
      out.push({
        name,
        type,
        description,
        members: childList(cfg, ALIAS_GROUP[type].memberLeaf),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const AUTO_NODES = ["address-group", "network-group", "interface-group"] as const;

function parseAutoGroups(group: Cfg): AutoGroup[] {
  const out: AutoGroup[] = [];
  for (const node of AUTO_NODES) {
    const groups = childCfg(group, node) ?? {};
    for (const [name, raw] of Object.entries(groups)) {
      const cfg = (raw ?? {}) as Cfg;
      if (!(childStr(cfg, "description") ?? "").startsWith(AUTO_MARK)) continue;
      out.push({ name, node, includes: childList(cfg, "include"), interfaces: childList(cfg, "interface") });
    }
  }
  return out;
}

function parseGroupNames(group: Cfg): string[] {
  const out: string[] = [];
  for (const v of Object.values(group)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...Object.keys(v as Cfg));
  }
  return out;
}

function parsePolicies(group: Cfg): FirewallPolicy[] {
  const groups = childCfg(group, "port-group") ?? {};
  return Object.entries(groups)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const { protocol, description } = decodePolicyDescription(childStr(cfg, "description"));
      return { name, protocol, description, ports: childList(cfg, "port") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Group references a rule side can carry that the From/To model understands.
const REF_NODES = ["address-group", "network-group", "domain-group"] as const;

/// Rule-level interface-match node backing each side.
const IFACE_NODE: Record<"source" | "destination", string> = {
  source: "inbound-interface",
  destination: "outbound-interface",
};

function parseEndpoint(cfg: Cfg, side: "source" | "destination"): RuleEndpoint {
  const s = childCfg(cfg, side) ?? {};
  const g = childCfg(s, "group") ?? {};

  // Interface matches live at rule level (`inbound-interface name <if>` or
  // `inbound-interface group <g>`), not under source/destination.
  const ifNode = cfg[IFACE_NODE[side]];
  let iface: string | null = null;
  let iface_group: string | null = null;
  if (typeof ifNode === "string") iface = ifNode.trim() || null;
  else if (ifNode && typeof ifNode === "object") {
    iface = childStr(ifNode as Cfg, "name");
    iface_group = childStr(ifNode as Cfg, "group");
  }

  for (const node of REF_NODES) {
    const name = childStr(g, node);
    if (name) return { group_type: node, group_name: name, address: null, iface, iface_group };
  }
  return { group_type: null, group_name: null, address: childStr(s, "address"), iface, iface_group };
}

const asAction = (v: string | null): RuleAction | null =>
  v === "accept" || v === "drop" || v === "reject" ? v : null;

function parseRules(filter: Cfg): FirewallRule[] {
  const rules = childCfg(filter, "rule") ?? {};
  return Object.entries(rules)
    .map(([num, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const dstGroup = childCfg(childCfg(cfg, "destination") ?? {}, "group") ?? {};
      return {
        rule: Number(num) || 0,
        name: childStr(cfg, "description"),
        action: asAction(childStr(cfg, "action")),
        from: parseEndpoint(cfg, "source"),
        to: parseEndpoint(cfg, "destination"),
        policy: childStr(dstGroup, "port-group"),
        protocol: childStr(cfg, "protocol"),
        enabled: !("disable" in cfg),
        raw: cfg,
      };
    })
    .sort((a, b) => a.rule - b.rule);
}

/// Configured aliases, policies, and forward-filter rules, from the running config.
export async function fetchFirewall(): Promise<FirewallConfig> {
  const fw = await fetchFirewallConfig();
  const group = childCfg(fw, "group") ?? {};
  const filter = childCfg(childCfg(childCfg(fw, "ipv4") ?? {}, "forward") ?? {}, "filter") ?? {};
  return {
    aliases: parseAliases(group),
    policies: parsePolicies(group),
    rules: parseRules(filter),
    auto_groups: parseAutoGroups(group),
    group_names: parseGroupNames(group),
    default_action: childStr(filter, "default-action"),
  };
}

// ── usage lookups (for "in use" counts and delete guards) ─────────────────────

/// Rule numbers referencing an alias in From or To, directly or through an
/// auto-managed OR group that includes it.
export function aliasUsage(rules: FirewallRule[], autoGroups: AutoGroup[], alias: FirewallAlias): number[] {
  const node = ALIAS_GROUP[alias.type].node;
  const viaAuto = new Set(
    autoGroups.filter((g) => g.node === node && g.includes.includes(alias.name)).map((g) => g.name),
  );
  const matches = (e: RuleEndpoint) =>
    e.group_type === node && e.group_name !== null && (e.group_name === alias.name || viaAuto.has(e.group_name));
  return rules.filter((r) => matches(r.from) || matches(r.to)).map((r) => r.rule);
}

/// Rule numbers referencing a policy (port-group).
export function policyUsage(rules: FirewallRule[], name: string): number[] {
  return rules.filter((r) => r.policy === name).map((r) => r.rule);
}

// ── writes: aliases ───────────────────────────────────────────────────────────

const groupBase = (type: AliasType, name: string) => ["firewall", "group", ALIAS_GROUP[type].node, name];

/// Desired alias. `original_*` identify the alias being edited; a change of
/// name or type is a move (old group deleted, new one built fresh).
export interface AliasUpdate {
  name: string;
  type: AliasType;
  description: string | null;
  members: string[];
  original_name: string | null;
  original_type: AliasType | null;
}

export function diffAlias(existing: FirewallAlias[], u: AliasUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved =
    u.original_name !== null &&
    u.original_type !== null &&
    (u.original_name !== u.name || u.original_type !== u.type);
  if (moved) {
    out.push({ op: "delete", path: groupBase(u.original_type!, u.original_name!) });
  }

  const live = moved
    ? null
    : existing.find((a) => a.name === u.name && a.type === u.type) ?? null;

  const base = groupBase(u.type, u.name);
  const leaf = ALIAS_GROUP[u.type].memberLeaf;
  const body: VyosCommand[] = [];

  const newDesc = u.description?.trim() || null;
  if (newDesc !== (live?.description ?? null)) {
    if (newDesc !== null) body.push({ op: "set", path: [...base, "description", newDesc] });
    else body.push({ op: "delete", path: [...base, "description"] });
  }

  const liveMembers = live?.members ?? [];
  const newMembers = u.members.map((m) => m.trim()).filter(Boolean);
  for (const m of newMembers) if (!liveMembers.includes(m)) body.push({ op: "set", path: [...base, leaf, m] });
  for (const m of liveMembers) if (!newMembers.includes(m)) body.push({ op: "delete", path: [...base, leaf, m] });

  // A new group with nothing else set still needs the node created.
  if (live === null && !body.some((c) => c.op === "set")) {
    body.length = 0;
    body.push({ op: "set", path: base });
  }
  out.push(...body);
  return out;
}

/// Apply a desired alias. Returns the number of changes applied.
export function applyAlias(existing: FirewallAlias[], update: AliasUpdate): Promise<number> {
  return commitAndSave(diffAlias(existing, update));
}

/// Delete an alias (fails at commit if a rule still references it).
export function deleteAlias(alias: FirewallAlias): Promise<number> {
  return commitAndSave([{ op: "delete", path: groupBase(alias.type, alias.name) }]);
}

// ── writes: policies ──────────────────────────────────────────────────────────

const policyBase = (name: string) => ["firewall", "group", "port-group", name];

/// Desired policy. `original_name` identifies the policy being edited.
export interface PolicyUpdate {
  name: string;
  protocol: PolicyProtocol;
  ports: string[];
  description: string | null;
  original_name: string | null;
}

/// Diff a desired policy. `rules` is scanned so a protocol change also
/// updates the `protocol` leaf of every rule using this policy.
export function diffPolicy(
  existing: FirewallPolicy[],
  rules: FirewallRule[],
  u: PolicyUpdate,
): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: policyBase(u.original_name!) });
  }

  const live = moved ? null : existing.find((p) => p.name === u.name) ?? null;

  const base = policyBase(u.name);
  const body: VyosCommand[] = [];

  const newDesc = encodePolicyDescription(u.protocol, u.description);
  const liveDesc = live ? encodePolicyDescription(live.protocol, live.description) : null;
  if (newDesc !== liveDesc) body.push({ op: "set", path: [...base, "description", newDesc] });

  const livePorts = live?.ports ?? [];
  const newPorts = u.ports.map((p) => p.trim()).filter(Boolean);
  for (const p of newPorts) if (!livePorts.includes(p)) body.push({ op: "set", path: [...base, "port", p] });
  for (const p of livePorts) if (!newPorts.includes(p)) body.push({ op: "delete", path: [...base, "port", p] });

  out.push(...body);

  // Keep rules using this policy in sync with its protocol.
  if (live && live.protocol !== u.protocol) {
    for (const num of policyUsage(rules, u.name)) {
      out.push({ op: "set", path: [...ruleBase(num), "protocol", u.protocol] });
    }
  }

  return out;
}

/// Apply a desired policy. Returns the number of changes applied.
export function applyPolicy(
  existing: FirewallPolicy[],
  rules: FirewallRule[],
  update: PolicyUpdate,
): Promise<number> {
  return commitAndSave(diffPolicy(existing, rules, update));
}

/// Delete a policy (fails at commit if a rule still references it).
export function deletePolicy(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: policyBase(name) }]);
}

// ── writes: rules ─────────────────────────────────────────────────────────────

const FILTER_BASE = ["firewall", "ipv4", "forward", "filter"];
const ruleBase = (rule: number) => [...FILTER_BASE, "rule", String(rule)];

/// One From/To list entry. `address` and `ifgroup` are legacy — kept so
/// CLI-created rules stay editable, not offered for new selections.
export type EndpointEntry =
  | { kind: "interface"; name: string }
  | { kind: "alias"; type: AliasType; name: string }
  | { kind: "address"; address: string }
  | { kind: "ifgroup"; name: string };

/// A From/To selection: the entries the side matches (any of them, WatchGuard
/// style). Empty = Any.
export type EndpointSelection = EndpointEntry[];

/// Expand a stored endpoint into its list form, resolving auto-managed OR
/// groups back into the aliases/interfaces they carry.
export function endpointToSelection(e: RuleEndpoint, autoGroups: AutoGroup[]): EndpointSelection {
  const out: EndpointEntry[] = [];

  if (e.group_type && e.group_name) {
    const type = GROUP_NODE_TO_TYPE[e.group_type];
    const auto = autoGroups.find((g) => g.node === e.group_type && g.name === e.group_name);
    if (type && auto) for (const name of auto.includes) out.push({ kind: "alias", type, name });
    else if (type) out.push({ kind: "alias", type, name: e.group_name });
  }
  if (e.iface) out.push({ kind: "interface", name: e.iface });
  if (e.iface_group) {
    const auto = autoGroups.find((g) => g.node === "interface-group" && g.name === e.iface_group);
    if (auto) for (const name of auto.interfaces) out.push({ kind: "interface", name });
    else out.push({ kind: "ifgroup", name: e.iface_group });
  }
  if (e.address) out.push({ kind: "address", address: e.address });
  return out;
}

/// Desired forward-filter rule. The rule number is fixed here — ordering is
/// changed by drag-reorder, not by editing.
export interface RuleUpdate {
  rule: number;
  name: string | null;
  action: RuleAction;
  from: EndpointSelection;
  to: EndpointSelection;
  /** Policy name plus its protocol, or null = any port/protocol. */
  policy: { name: string; protocol: PolicyProtocol } | null;
  enabled: boolean;
}

/// Shared allocation context for both sides of a rule diff.
interface AutoCtx {
  autoGroups: AutoGroup[];
  /** Group names already in use (grows as new auto names are allocated). */
  taken: Set<string>;
}

/// A fresh, readable auto-group name. Names carry the rule number only as a
/// label — reorders don't rename groups, so collisions are avoided by suffix.
function allocAutoName(rule: number, side: "source" | "destination", taken: Set<string>): string {
  const base = `QZ-R${rule}-${side === "source" ? "FROM" : "TO"}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/// Create/update an auto group's member leaf and delete stale members.
function diffAutoMembers(
  out: VyosCommand[],
  node: string,
  name: string,
  leaf: "include" | "interface",
  liveMembers: string[] | null,
  desired: string[],
): void {
  const gp = ["firewall", "group", node, name];
  if (liveMembers === null) out.push({ op: "set", path: [...gp, "description", AUTO_MARK] });
  for (const m of desired) if (!liveMembers?.includes(m)) out.push({ op: "set", path: [...gp, leaf, m] });
  for (const m of liveMembers ?? []) if (!desired.includes(m)) out.push({ op: "delete", path: [...gp, leaf, m] });
}

function diffEndpoint(
  out: VyosCommand[],
  rule: number,
  side: "source" | "destination",
  live: RuleEndpoint | null,
  sel: EndpointSelection,
  ctx: AutoCtx,
): void {
  const base = ruleBase(rule);
  const findAuto = (node: string | null, name: string | null) =>
    (node && name && ctx.autoGroups.find((g) => g.node === node && g.name === name)) || null;

  // ── aliases: one → direct group ref; several → auto OR group with includes.
  const aliases = sel.filter((e) => e.kind === "alias");
  const types = new Set(aliases.map((a) => a.type));
  if (types.size > 1) throw new Error("From/To aliases must all be of the same type.");
  const aliasType = aliases[0]?.type ?? null;
  if (aliases.length > 1 && aliasType === "fqdn") {
    throw new Error("FQDN aliases can't be combined — VyOS domain groups don't support includes.");
  }

  const liveAuto = findAuto(live?.group_type ?? null, live?.group_name ?? null);

  let desiredNode: string | null = null;
  let desiredName: string | null = null;
  if (aliasType !== null) {
    desiredNode = ALIAS_GROUP[aliasType].node;
    if (aliases.length === 1) {
      desiredName = aliases[0].name;
    } else {
      // Reuse the side's existing auto group while its type still matches.
      const reuse = liveAuto !== null && liveAuto.node === desiredNode;
      desiredName = reuse ? liveAuto!.name : allocAutoName(rule, side, ctx.taken);
      diffAutoMembers(out, desiredNode, desiredName, "include", reuse ? liveAuto!.includes : null, aliases.map((a) => a.name));
    }
  }
  // A live auto group this side no longer references is deleted outright.
  if (liveAuto && liveAuto.name !== desiredName) {
    out.push({ op: "delete", path: ["firewall", "group", liveAuto.node, liveAuto.name] });
  }

  const liveType = live?.group_type ?? null;
  const liveName = live?.group_name ?? null;
  const refChanged = liveType !== desiredNode || liveName !== desiredName;
  if (liveType && refChanged) out.push({ op: "delete", path: [...base, side, "group", liveType] });
  if (desiredNode && desiredName && refChanged) {
    out.push({ op: "set", path: [...base, side, "group", desiredNode, desiredName] });
  }

  // ── literal address (legacy).
  const addrEntry = sel.find((e) => e.kind === "address");
  const desiredAddr = addrEntry?.address.trim() || null;
  const liveAddr = live?.address ?? null;
  if (desiredAddr !== liveAddr) {
    if (desiredAddr !== null) out.push({ op: "set", path: [...base, side, "address", desiredAddr] });
    else out.push({ op: "delete", path: [...base, side, "address"] });
  }

  // ── interfaces: one → `name <if>`; several → auto interface-group; a legacy
  //    ifgroup entry keeps its `group <g>` form.
  const ifaces = sel.filter((e) => e.kind === "interface").map((e) => e.name.trim()).filter(Boolean);
  const legacyIfGroup = sel.find((e) => e.kind === "ifgroup")?.name ?? null;
  const liveIfAuto = findAuto(live?.iface_group ? "interface-group" : null, live?.iface_group ?? null);

  let desiredIface: string | null = null;
  let desiredIfGroup: string | null = null;
  if (legacyIfGroup !== null) {
    desiredIfGroup = legacyIfGroup;
  } else if (ifaces.length === 1) {
    desiredIface = ifaces[0];
  } else if (ifaces.length > 1) {
    desiredIfGroup = liveIfAuto ? liveIfAuto.name : allocAutoName(rule, side, ctx.taken);
    diffAutoMembers(out, "interface-group", desiredIfGroup, "interface", liveIfAuto ? liveIfAuto.interfaces : null, ifaces);
  }
  if (liveIfAuto && liveIfAuto.name !== desiredIfGroup) {
    out.push({ op: "delete", path: ["firewall", "group", "interface-group", liveIfAuto.name] });
  }

  // The interface match node holds either `name <if>` or `group <g>`.
  const liveIface = live?.iface ?? null;
  const liveIfGroup = live?.iface_group ?? null;
  if (desiredIface !== liveIface || desiredIfGroup !== liveIfGroup) {
    const key = IFACE_NODE[side];
    if (liveIface !== null || liveIfGroup !== null) out.push({ op: "delete", path: [...base, key] });
    if (desiredIface !== null) out.push({ op: "set", path: [...base, key, "name", desiredIface] });
    else if (desiredIfGroup !== null) out.push({ op: "set", path: [...base, key, "group", desiredIfGroup] });
  }
}

export function diffRule(live: FirewallRule | null, u: RuleUpdate, cfg: FirewallConfig): VyosCommand[] {
  const base = ruleBase(u.rule);
  const out: VyosCommand[] = [];
  const leaf = (sub: string[], liveV: string | null, desiredRaw: string | null) => {
    const desired = desiredRaw?.trim() || null;
    if (desired === liveV) return;
    if (desired !== null) out.push({ op: "set", path: [...base, ...sub, desired] });
    else if (liveV !== null) out.push({ op: "delete", path: [...base, ...sub] });
  };

  leaf(["action"], live?.action ?? null, u.action);
  leaf(["description"], live?.name ?? null, u.name);

  const ctx: AutoCtx = { autoGroups: cfg.auto_groups, taken: new Set(cfg.group_names) };
  diffEndpoint(out, u.rule, "source", live?.from ?? null, u.from, ctx);
  diffEndpoint(out, u.rule, "destination", live?.to ?? null, u.to, ctx);

  // Policy = destination port-group + matching protocol leaf.
  const livePolicy = live?.policy ?? null;
  const newPolicy = u.policy?.name ?? null;
  if (newPolicy !== livePolicy) {
    if (livePolicy !== null && newPolicy === null) {
      out.push({ op: "delete", path: [...base, "destination", "group", "port-group"] });
    }
    if (newPolicy !== null) {
      out.push({ op: "set", path: [...base, "destination", "group", "port-group", newPolicy] });
    }
  }
  leaf(["protocol"], live?.protocol ?? null, u.policy?.protocol ?? null);

  // Enabled state — VyOS models "off" as a valueless `disable` leaf.
  const liveEnabled = live?.enabled ?? true;
  if (u.enabled !== liveEnabled) {
    if (u.enabled) out.push({ op: "delete", path: [...base, "disable"] });
    else out.push({ op: "set", path: [...base, "disable"] });
  }

  return out;
}

/// Apply a desired rule. Returns the number of changes applied.
export function applyRule(live: FirewallRule | null, update: RuleUpdate, cfg: FirewallConfig): Promise<number> {
  return commitAndSave(diffRule(live, update, cfg));
}

/// Delete a forward-filter rule, along with the auto-managed OR groups backing
/// its sides (auto groups are per-side, so no other rule references them).
export function deleteRule(rule: FirewallRule, autoGroups: AutoGroup[]): Promise<number> {
  const out: VyosCommand[] = [{ op: "delete", path: ruleBase(rule.rule) }];
  for (const e of [rule.from, rule.to]) {
    const refs = [
      e.group_type && e.group_name ? { node: e.group_type, name: e.group_name } : null,
      e.iface_group ? { node: "interface-group", name: e.iface_group } : null,
    ];
    for (const ref of refs) {
      if (ref && autoGroups.some((g) => g.node === ref.node && g.name === ref.name)) {
        out.push({ op: "delete", path: ["firewall", "group", ref.node, ref.name] });
      }
    }
  }
  return commitAndSave(out);
}

/// Rule number for a newly created rule: appended after the last one.
export function nextRuleNumber(rules: FirewallRule[]): number {
  const max = rules.reduce((m, r) => Math.max(m, r.rule), 0);
  return max + 10;
}

// ── writes: reorder ───────────────────────────────────────────────────────────

/// Serialize a raw config subtree back into `set` commands. Used to rebuild a
/// rule at a new number without losing leaves this UI doesn't model.
function cfgToCommands(base: string[], cfg: Cfg, out: VyosCommand[]): void {
  const entries = Object.entries(cfg);
  if (entries.length === 0) {
    out.push({ op: "set", path: base });
    return;
  }
  for (const [k, v] of entries) {
    if (typeof v === "string") {
      if (v === "") out.push({ op: "set", path: [...base, k] });
      else out.push({ op: "set", path: [...base, k, v] });
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push({ op: "set", path: [...base, k, String(v)] });
    } else if (Array.isArray(v)) {
      for (const item of v) out.push({ op: "set", path: [...base, k, String(item)] });
    } else if (v && typeof v === "object") {
      cfgToCommands([...base, k], v as Cfg, out);
    } else {
      out.push({ op: "set", path: [...base, k] });
    }
  }
}

/// Renumber rules to match the given display order (position × 10). Rules
/// whose number already matches are untouched; moved rules are deleted first
/// (so a target number freed by another move is safe to reuse), then rebuilt
/// from their raw config subtree.
export function reorderCommands(orderedRules: FirewallRule[]): VyosCommand[] {
  const deletes: VyosCommand[] = [];
  const sets: VyosCommand[] = [];
  orderedRules.forEach((r, i) => {
    const target = (i + 1) * 10;
    if (r.rule === target) return;
    deletes.push({ op: "delete", path: ruleBase(r.rule) });
    cfgToCommands(ruleBase(target), r.raw, sets);
  });
  return [...deletes, ...sets];
}

/// Apply a new rule order. Returns the number of rules that were renumbered.
export async function applyRuleOrder(orderedRules: FirewallRule[]): Promise<number> {
  const commands = reorderCommands(orderedRules);
  await commitAndSave(commands);
  return commands.filter((c) => c.op === "delete").length;
}

// ── writes: default action ────────────────────────────────────────────────────

/// Set `firewall ipv4 forward filter default-action` (what happens to traffic
/// no rule matches).
export function setDefaultAction(action: "accept" | "drop"): Promise<number> {
  return commitAndSave([{ op: "set", path: [...FILTER_BASE, "default-action", action] }]);
}
