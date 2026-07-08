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

/// One side of a rule match: a group reference, a literal address, or
/// neither (= any). Only one of `group_*`/`address` is set.
export interface RuleEndpoint {
  group_type: string | null;
  group_name: string | null;
  address: string | null;
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
      out.push({
        name,
        type,
        description: childStr(cfg, "description"),
        members: childList(cfg, ALIAS_GROUP[type].memberLeaf),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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

function parseEndpoint(cfg: Cfg, side: "source" | "destination"): RuleEndpoint {
  const s = childCfg(cfg, side) ?? {};
  const g = childCfg(s, "group") ?? {};
  for (const node of REF_NODES) {
    const name = childStr(g, node);
    if (name) return { group_type: node, group_name: name, address: null };
  }
  return { group_type: null, group_name: null, address: childStr(s, "address") };
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
    default_action: childStr(filter, "default-action"),
  };
}

// ── usage lookups (for "in use" counts and delete guards) ─────────────────────

function endpointMatches(e: RuleEndpoint, alias: FirewallAlias): boolean {
  return e.group_type === ALIAS_GROUP[alias.type].node && e.group_name === alias.name;
}

/// Rule numbers referencing an alias in From or To.
export function aliasUsage(rules: FirewallRule[], alias: FirewallAlias): number[] {
  return rules
    .filter((r) => endpointMatches(r.from, alias) || endpointMatches(r.to, alias))
    .map((r) => r.rule);
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

/// From/To selection in the rule form: any, an alias, or a literal address.
export type EndpointSelection =
  | { kind: "any" }
  | { kind: "alias"; type: AliasType; name: string }
  | { kind: "address"; address: string };

export function endpointToSelection(e: RuleEndpoint): EndpointSelection {
  if (e.group_type && e.group_name) {
    const type = GROUP_NODE_TO_TYPE[e.group_type];
    if (type) return { kind: "alias", type, name: e.group_name };
  }
  if (e.address) return { kind: "address", address: e.address };
  return { kind: "any" };
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

function diffEndpoint(
  out: VyosCommand[],
  base: string[],
  side: "source" | "destination",
  live: RuleEndpoint | null,
  sel: EndpointSelection,
): void {
  const desiredType = sel.kind === "alias" ? ALIAS_GROUP[sel.type].node : null;
  const desiredName = sel.kind === "alias" ? sel.name : null;
  const desiredAddr = sel.kind === "address" ? sel.address.trim() || null : null;

  const liveType = live?.group_type ?? null;
  const liveName = live?.group_name ?? null;
  const refChanged = liveType !== desiredType || liveName !== desiredName;
  if (liveType && refChanged) out.push({ op: "delete", path: [...base, side, "group", liveType] });
  if (desiredType && desiredName && refChanged) {
    out.push({ op: "set", path: [...base, side, "group", desiredType, desiredName] });
  }

  const liveAddr = live?.address ?? null;
  if (desiredAddr !== liveAddr) {
    if (desiredAddr !== null) out.push({ op: "set", path: [...base, side, "address", desiredAddr] });
    else out.push({ op: "delete", path: [...base, side, "address"] });
  }
}

export function diffRule(live: FirewallRule | null, u: RuleUpdate): VyosCommand[] {
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

  diffEndpoint(out, base, "source", live?.from ?? null, u.from);
  diffEndpoint(out, base, "destination", live?.to ?? null, u.to);

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
export function applyRule(live: FirewallRule | null, update: RuleUpdate): Promise<number> {
  return commitAndSave(diffRule(live, update));
}

/// Delete a forward-filter rule.
export function deleteRule(rule: number): Promise<number> {
  return commitAndSave([{ op: "delete", path: ruleBase(rule) }]);
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
