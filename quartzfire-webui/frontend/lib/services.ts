// Services data layer (DHCP relay, DHCP server, DNS forwarding).
//
// Parsing is ported from the vyos-fabric backend (`routes/services.rs`); writes
// follow the QuartzFire model — diff against the live config, commit straight
// to the VyOS API, and save to the boot config.

import { vyosApi } from "./api";
import { commitAndSave, VyosCommand, VyosResponse } from "./interfaces";

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

/// VyOS renders a multi-value leaf as a JSON string when it holds one value
/// and a JSON array when it holds several.
function strList(v: Cfg, key: string): string[] {
  const x = v[key];
  if (typeof x === "string") return [x];
  if (Array.isArray(x)) return x.filter((s): s is string => typeof s === "string");
  return [];
}

/// `disable` is a valueless leaf — its mere presence means the node is off.
const isEnabled = (v: Cfg) => !("disable" in v);

const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/// Fetches one config subtree, returning {} when nothing is configured.
/// Mirrors the interfaces handler: query the parent and read the named child so
/// some VyOS versions don't wrap the tag node oddly.
async function configNode(parent: string[], child: string): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: parent,
  });
  if (resp.success) return childCfg(resp.data ?? {}, child) ?? {};
  // "Configuration under specified path is empty" just means nothing is set yet.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading services.");
}

// ── diff helpers ──────────────────────────────────────────────────────────────

/// Diff a single-value leaf into set/delete commands.
function diffLeaf(out: VyosCommand[], base: string[], sub: string[], liveV: string | null, desiredRaw: string | null): void {
  const desired = trimmed(desiredRaw);
  if (desired === liveV) return;
  if (desired !== null) out.push({ op: "set", path: [...base, ...sub, desired] });
  else out.push({ op: "delete", path: [...base, ...sub] });
}

/// Diff a multi-value leaf (one path segment per value).
function diffMulti(out: VyosCommand[], base: string[], key: string, live: string[], desiredRaw: string[]): void {
  const desired = desiredRaw.map((s) => s.trim()).filter(Boolean);
  for (const v of desired) if (!live.includes(v)) out.push({ op: "set", path: [...base, key, v] });
  for (const v of live) if (!desired.includes(v)) out.push({ op: "delete", path: [...base, key, v] });
}

/// Diff a valueless flag leaf (present = on).
function diffFlag(out: VyosCommand[], base: string[], key: string, live: boolean, desired: boolean): void {
  if (desired === live) return;
  if (desired) out.push({ op: "set", path: [...base, key] });
  else out.push({ op: "delete", path: [...base, key] });
}

/// A new node with nothing else set still needs to be created explicitly.
function ensureCreated(out: VyosCommand[], base: string[], isNew: boolean): void {
  if (isNew && !out.some((c) => c.op === "set")) {
    out.length = 0;
    out.push({ op: "set", path: base });
  }
}

// ══ DHCP relay ════════════════════════════════════════════════════════════════

export interface DhcpRelayConfig {
  interfaces: string[];
  servers: string[];
}

const RELAY_BASE = ["service", "dhcp-relay"];

/// Configured DHCP relay listen interfaces and upstream servers.
export async function fetchDhcpRelay(): Promise<DhcpRelayConfig> {
  const data = await configNode(["service"], "dhcp-relay");
  return {
    interfaces: strList(data, "interface").sort(),
    servers: strList(data, "server").sort(),
  };
}

/// Add one relay listen interface or upstream server.
export function addDhcpRelayEntry(kind: "interface" | "server", value: string): Promise<number> {
  return commitAndSave([{ op: "set", path: [...RELAY_BASE, kind, value.trim()] }]);
}

/// Remove one relay listen interface or upstream server.
export function deleteDhcpRelayEntry(kind: "interface" | "server", value: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...RELAY_BASE, kind, value] }]);
}

// ══ DHCP server ═══════════════════════════════════════════════════════════════

export interface DhcpRange {
  name: string;
  start: string | null;
  stop: string | null;
}

export interface DhcpStaticMapping {
  name: string;
  ip_address: string | null;
  mac_address: string | null;
  description: string | null;
}

export interface DhcpSubnet {
  subnet: string;
  subnet_id: number | null;
  default_router: string | null;
  name_servers: string[];
  domain_name: string | null;
  lease: string | null;
  ranges: DhcpRange[];
  static_mappings: DhcpStaticMapping[];
}

export interface DhcpServer {
  name: string;
  enabled: boolean;
  authoritative: boolean;
  description: string | null;
  subnets: DhcpSubnet[];
}

export interface DhcpLease {
  ip_address: string;
  mac_address: string | null;
  state: string | null;
  lease_start: string | null;
  lease_expiration: string | null;
  remaining: string | null;
  pool: string | null;
  hostname: string | null;
}

export interface DhcpServerConfig {
  servers: DhcpServer[];
  leases: DhcpLease[];
}

/// Subnet option leaf: 1.4+ nests them under `option`; 1.3 kept them flat.
function optStr(subnet: Cfg, key: string): string | null {
  const opt = childCfg(subnet, "option");
  return (opt && childStr(opt, key)) ?? childStr(subnet, key);
}

function optList(subnet: Cfg, key: string): string[] {
  const opt = childCfg(subnet, "option");
  const nested = opt ? strList(opt, key) : [];
  return nested.length ? nested : strList(subnet, key);
}

function parseRanges(subnet: Cfg): DhcpRange[] {
  const node = childCfg(subnet, "range") ?? {};
  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return { name, start: childStr(cfg, "start"), stop: childStr(cfg, "stop") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseStaticMappings(subnet: Cfg): DhcpStaticMapping[] {
  const node = childCfg(subnet, "static-mapping") ?? {};
  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return {
        name,
        ip_address: childStr(cfg, "ip-address"),
        // 1.4+ uses `mac`, 1.3 used `mac-address`.
        mac_address: childStr(cfg, "mac") ?? childStr(cfg, "mac-address"),
        description: childStr(cfg, "description"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseSubnets(network: Cfg): DhcpSubnet[] {
  const node = childCfg(network, "subnet") ?? {};
  return Object.entries(node)
    .map(([cidr, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const id = childStr(cfg, "subnet-id");
      return {
        subnet: cidr,
        subnet_id: id !== null && Number.isInteger(Number(id)) ? Number(id) : null,
        default_router: optStr(cfg, "default-router"),
        name_servers: optList(cfg, "name-server"),
        domain_name: optStr(cfg, "domain-name"),
        lease: childStr(cfg, "lease"),
        ranges: parseRanges(cfg),
        static_mappings: parseStaticMappings(cfg),
      };
    })
    .sort((a, b) => a.subnet.localeCompare(b.subnet));
}

function parseServers(data: Cfg): DhcpServer[] {
  const node = childCfg(data, "shared-network-name") ?? {};
  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return {
        name,
        enabled: isEnabled(cfg),
        authoritative: "authoritative" in cfg,
        description: childStr(cfg, "description"),
        subnets: parseSubnets(cfg),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Parses the fixed-width table printed by `show dhcp server leases`.
///
/// Column positions are derived from the dashed separator line, then each data
/// row is sliced by those offsets — robust to spaces inside date fields.
function parseLeases(text: string): DhcpLease[] {
  const lines = text.split("\n");
  const sepIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t.length > 0 && /^[- ]+$/.test(t) && t.includes("-");
  });
  if (sepIdx <= 0) return [];

  // Column start offsets = the start of each run of dashes.
  const sep = lines[sepIdx];
  const starts: number[] = [];
  let i = 0;
  while (i < sep.length) {
    if (sep[i] === "-") {
      starts.push(i);
      while (i < sep.length && sep[i] === "-") i++;
    } else {
      i++;
    }
  }
  if (starts.length === 0) return [];

  const field = (line: string, col: number): string => {
    const start = starts[col];
    if (start >= line.length) return "";
    const end = Math.min(col + 1 < starts.length ? starts[col + 1] : line.length, line.length);
    return line.slice(start, end).trim();
  };

  // Match header labels to known columns.
  const header = lines[sepIdx - 1];
  const labels = starts.map((_, c) => field(header, c).toLowerCase());
  const find = (needle: string) => {
    const idx = labels.findIndex((l) => l.includes(needle));
    return idx >= 0 ? idx : null;
  };
  // Matches both "IP address" (DHCP) and "IPv6 address" (DHCPv6).
  const ipIdx = labels.findIndex((l) => l.includes("ip") && l.includes("address"));
  const ipCol = ipIdx >= 0 ? ipIdx : null;
  const cols = {
    mac: find("mac"),
    state: find("state"),
    start: find("start"),
    exp: find("expir"),
    rem: find("remain"),
    pool: find("pool"),
    host: find("hostname"),
  };

  const opt = (line: string, col: number | null): string | null => {
    if (col === null) return null;
    const v = field(line, col);
    return v === "" ? null : v;
  };

  const out: DhcpLease[] = [];
  for (const line of lines.slice(sepIdx + 1)) {
    if (line.trim() === "") continue;
    const ip_address = opt(line, ipCol);
    if (!ip_address) continue;
    out.push({
      ip_address,
      mac_address: opt(line, cols.mac),
      state: opt(line, cols.state),
      lease_start: opt(line, cols.start),
      lease_expiration: opt(line, cols.exp),
      remaining: opt(line, cols.rem),
      pool: opt(line, cols.pool),
      hostname: opt(line, cols.host),
    });
  }
  return out;
}

/// Configured DHCP shared networks plus active leases (leases are operational
/// and best-effort — never fail the whole read over them).
export async function fetchDhcpServer(): Promise<DhcpServerConfig> {
  const data = await configNode(["service"], "dhcp-server");
  const servers = parseServers(data);

  let leases: DhcpLease[] = [];
  try {
    const resp = await vyosApi<VyosResponse<string | null>>("show", {
      op: "show",
      path: ["dhcp", "server", "leases"],
    });
    if (resp.success && typeof resp.data === "string") leases = parseLeases(resp.data);
  } catch {
    // No DHCP service running yet — leases stay empty.
  }

  return { servers, leases };
}

// ── DHCP server writes ────────────────────────────────────────────────────────

const serverBase = (name: string) => ["service", "dhcp-server", "shared-network-name", name];
const subnetBase = (server: string, cidr: string) => [...serverBase(server), "subnet", cidr];

/// Desired shared network. The name is the node identity and is locked while
/// editing, so there is no rename path.
export interface DhcpServerUpdate {
  name: string;
  description: string | null;
  authoritative: boolean;
  enabled: boolean;
}

/// Apply a desired shared network. Returns the number of changes applied.
export function applyDhcpServer(existing: DhcpServer[], u: DhcpServerUpdate): Promise<number> {
  const live = existing.find((s) => s.name === u.name) ?? null;
  const base = serverBase(u.name);
  const out: VyosCommand[] = [];

  diffLeaf(out, base, ["description"], live?.description ?? null, u.description);
  diffFlag(out, base, "authoritative", live?.authoritative ?? false, u.authoritative);
  // Enabled state — VyOS models "off" as a valueless `disable` leaf. New
  // networks default enabled.
  diffFlag(out, base, "disable", !(live?.enabled ?? true), !u.enabled);

  ensureCreated(out, base, live === null);
  return commitAndSave(out);
}

/// Delete a shared network and everything under it.
export function deleteDhcpServer(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: serverBase(name) }]);
}

/// Desired subnet. The CIDR is the node identity and is locked while editing.
export interface DhcpSubnetUpdate {
  server: string;
  subnet: string;
  default_router: string | null;
  name_servers: string[];
  domain_name: string | null;
  lease: string | null;
}

/// The next free subnet-id across every shared network (VyOS 1.4+ requires a
/// unique id per subnet).
export function nextSubnetId(servers: DhcpServer[]): number {
  const used = servers.flatMap((s) => s.subnets.map((n) => n.subnet_id ?? 0));
  return Math.max(0, ...used) + 1;
}

/// Apply a desired subnet. Options are written in the 1.4+ `option` form.
/// Returns the number of changes applied.
export function applyDhcpSubnet(servers: DhcpServer[], u: DhcpSubnetUpdate): Promise<number> {
  const server = servers.find((s) => s.name === u.server);
  const live = server?.subnets.find((n) => n.subnet === u.subnet) ?? null;
  const base = subnetBase(u.server, u.subnet);
  const out: VyosCommand[] = [];

  diffLeaf(out, base, ["option", "default-router"], live?.default_router ?? null, u.default_router);
  diffMulti(out, [...base, "option"], "name-server", live?.name_servers ?? [], u.name_servers);
  diffLeaf(out, base, ["option", "domain-name"], live?.domain_name ?? null, u.domain_name);
  diffLeaf(out, base, ["lease"], live?.lease ?? null, u.lease);

  // New subnets need their mandatory unique id.
  if (live === null) {
    out.push({ op: "set", path: [...base, "subnet-id", String(nextSubnetId(servers))] });
  }
  return commitAndSave(out);
}

/// Delete a subnet and its ranges/mappings.
export function deleteDhcpSubnet(server: string, cidr: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: subnetBase(server, cidr) }]);
}

/// Desired address range. `original_name` identifies the range being edited;
/// when it differs from `name` the edit is a rename (old node deleted, new one
/// built fresh).
export interface DhcpRangeUpdate {
  server: string;
  subnet: string;
  name: string;
  start: string | null;
  stop: string | null;
  original_name: string | null;
}

/// Apply a desired address range. Returns the number of changes applied.
export function applyDhcpRange(servers: DhcpServer[], u: DhcpRangeUpdate): Promise<number> {
  const subnet = servers.find((s) => s.name === u.server)?.subnets.find((n) => n.subnet === u.subnet);
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: [...subnetBase(u.server, u.subnet), "range", u.original_name!] });
  }
  const live = moved ? null : subnet?.ranges.find((r) => r.name === u.name) ?? null;

  const base = [...subnetBase(u.server, u.subnet), "range", u.name];
  const body: VyosCommand[] = [];
  diffLeaf(body, base, ["start"], live?.start ?? null, u.start);
  diffLeaf(body, base, ["stop"], live?.stop ?? null, u.stop);
  ensureCreated(body, base, live === null);
  out.push(...body);

  return commitAndSave(out);
}

/// Delete an address range.
export function deleteDhcpRange(server: string, subnet: string, name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...subnetBase(server, subnet), "range", name] }]);
}

/// Desired static mapping. `original_name` identifies the mapping being
/// edited; a differing `name` is a rename (old node deleted, new one built).
export interface DhcpMappingUpdate {
  server: string;
  subnet: string;
  name: string;
  ip_address: string | null;
  mac_address: string | null;
  description: string | null;
  original_name: string | null;
}

/// Apply a desired static mapping. Returns the number of changes applied.
export function applyDhcpMapping(servers: DhcpServer[], u: DhcpMappingUpdate): Promise<number> {
  const subnet = servers.find((s) => s.name === u.server)?.subnets.find((n) => n.subnet === u.subnet);
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: [...subnetBase(u.server, u.subnet), "static-mapping", u.original_name!] });
  }
  const live = moved ? null : subnet?.static_mappings.find((m) => m.name === u.name) ?? null;

  const base = [...subnetBase(u.server, u.subnet), "static-mapping", u.name];
  const body: VyosCommand[] = [];
  diffLeaf(body, base, ["ip-address"], live?.ip_address ?? null, u.ip_address);
  diffLeaf(body, base, ["mac"], live?.mac_address ?? null, u.mac_address);
  diffLeaf(body, base, ["description"], live?.description ?? null, u.description);
  ensureCreated(body, base, live === null);
  out.push(...body);

  return commitAndSave(out);
}

/// Delete a static mapping.
export function deleteDhcpMapping(server: string, subnet: string, name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...subnetBase(server, subnet), "static-mapping", name] }]);
}

// ══ DNS forwarding ════════════════════════════════════════════════════════════

export interface DnsForwardingDomain {
  name: string;
  name_servers: string[];
}

export interface DnsForwardingConfig {
  cache_size: string | null;
  listen_addresses: string[];
  allow_from: string[];
  name_servers: string[];
  system: boolean;
  dnssec: string | null;
  domains: DnsForwardingDomain[];
}

const DNS_BASE = ["service", "dns", "forwarding"];

/// Configured recursive DNS forwarder settings and conditional domains.
export async function fetchDnsForwarding(): Promise<DnsForwardingConfig> {
  const data = await configNode(["service", "dns"], "forwarding");

  const domainNode = childCfg(data, "domain") ?? {};
  const domains = Object.entries(domainNode)
    .map(([name, raw]) => ({
      name,
      name_servers: strList((raw ?? {}) as Cfg, "name-server").sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    cache_size: childStr(data, "cache-size"),
    listen_addresses: strList(data, "listen-address").sort(),
    allow_from: strList(data, "allow-from").sort(),
    name_servers: strList(data, "name-server").sort(),
    system: "system" in data,
    dnssec: childStr(data, "dnssec"),
    domains,
  };
}

/// Desired forwarder settings (everything except the conditional domains).
export interface DnsForwardingUpdate {
  listen_addresses: string[];
  allow_from: string[];
  name_servers: string[];
  system: boolean;
  cache_size: string | null;
  dnssec: string | null;
}

/// Apply desired forwarder settings. Returns the number of changes applied.
export function applyDnsForwarding(live: DnsForwardingConfig, u: DnsForwardingUpdate): Promise<number> {
  const out: VyosCommand[] = [];
  diffMulti(out, DNS_BASE, "listen-address", live.listen_addresses, u.listen_addresses);
  diffMulti(out, DNS_BASE, "allow-from", live.allow_from, u.allow_from);
  diffMulti(out, DNS_BASE, "name-server", live.name_servers, u.name_servers);
  diffFlag(out, DNS_BASE, "system", live.system, u.system);
  diffLeaf(out, DNS_BASE, ["cache-size"], live.cache_size, u.cache_size);
  diffLeaf(out, DNS_BASE, ["dnssec"], live.dnssec, u.dnssec);
  return commitAndSave(out);
}

/// Desired conditional domain. A differing `name` is a rename (old node
/// deleted, new one built fresh).
export interface DnsDomainUpdate {
  name: string;
  name_servers: string[];
  original_name: string | null;
}

/// Apply a desired conditional forwarding domain. Returns the number of
/// changes applied.
export function applyDnsDomain(existing: DnsForwardingDomain[], u: DnsDomainUpdate): Promise<number> {
  const out: VyosCommand[] = [];

  const moved = u.original_name !== null && u.original_name !== u.name;
  if (moved) {
    out.push({ op: "delete", path: [...DNS_BASE, "domain", u.original_name!] });
  }
  const live = moved ? null : existing.find((d) => d.name === u.name) ?? null;

  const base = [...DNS_BASE, "domain", u.name];
  const body: VyosCommand[] = [];
  diffMulti(body, base, "name-server", live?.name_servers ?? [], u.name_servers);
  ensureCreated(body, base, live === null);
  out.push(...body);

  return commitAndSave(out);
}

/// Delete a conditional forwarding domain.
export function deleteDnsDomain(name: string): Promise<number> {
  return commitAndSave([{ op: "delete", path: [...DNS_BASE, "domain", name] }]);
}
