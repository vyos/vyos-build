// Interface data layer (ethernet, VLAN, loopback, bond, bridge).
//
// Unlike vyos-fabric (which stages changes in a controller DB for review),
// QuartzFire manages a single local firewall: reads and writes go straight to
// the VyOS HTTP API through the authenticated backend proxy, commit
// immediately, and are saved to the boot config in the background.

import { apiFetch, vyosApi } from "./api";
import { scheduleBootSave } from "./bootSave";
import { guardedCommitAndSave } from "./guard";

/// Every VyOS API endpoint answers `{success, data, error}`.
export interface VyosResponse<T = unknown> {
  success: boolean;
  data: T;
  error: string | null;
}

export interface EthernetInterface {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  hw_id: string | null;
  speed: string | null;
  duplex: string | null;
  enabled: boolean;
  vlan_count: number;
}

/// Desired physical ethernet config. `speed`/`duplex` are null for auto (the default).
export interface EthernetConfigUpdate {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  speed: string | null;
  duplex: string | null;
  enabled: boolean;
}

export interface VlanInterface {
  name: string;
  parent: string;
  vlan_id: number;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  enabled: boolean;
}

/// Desired VLAN config. `original_*` identify the vif being edited; when they
/// differ from `parent`/`vlan_id` the edit is a move (old vif deleted, new one
/// built fresh).
export interface VlanConfigUpdate {
  parent: string;
  vlan_id: number;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  enabled: boolean;
  original_parent: string | null;
  original_vlan_id: number | null;
}

export interface LoopbackInterface {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  enabled: boolean;
}

/// Desired loopback config. VyOS only supports the fixed `lo` node, with
/// `address` and `description` leaves.
export interface LoopbackConfigUpdate {
  name: string;
  description: string | null;
  addresses: string[];
}

export interface BondInterface {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  mode: string | null;
  members: string[];
  enabled: boolean;
}

/// Desired bond config. `mode` is always concrete — the modal preselects the
/// VyOS default (802.3ad) so the diff can compare against an absent leaf.
export interface BondConfigUpdate {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  mode: string;
  members: string[];
  enabled: boolean;
}

export interface BridgeInterface {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  members: string[];
  enabled: boolean;
}

export interface BridgeConfigUpdate {
  name: string;
  description: string | null;
  addresses: string[];
  mtu: number | null;
  members: string[];
  enabled: boolean;
}

export interface VyosCommand {
  op: "set" | "delete";
  path: string[];
}

// ── parse helpers ─────────────────────────────────────────────────────────────

type Cfg = Record<string, unknown>;

function childStr(v: Cfg, key: string): string | null {
  const x = v[key];
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s === "" ? null : s;
}

function asMtu(v: Cfg): number | null {
  const m = v["mtu"];
  if (typeof m === "number") return m;
  if (typeof m === "string") {
    const n = Number(m.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/// VyOS renders a multi-value node (`address`) as a JSON string when it holds
/// one value and a JSON array when it holds several.
function asAddresses(v: Cfg): string[] {
  const a = v["address"];
  if (typeof a === "string") return [a];
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
  return [];
}

/// Bond/bridge members live under `member interface <name>` (VyOS 1.4+).
function asMembers(v: Cfg): string[] {
  const member = v["member"];
  if (!member || typeof member !== "object") return [];
  const iface = (member as Cfg)["interface"];
  if (!iface || typeof iface !== "object") return [];
  return Object.keys(iface).sort();
}

/// `disable` is a valueless leaf — its mere presence means the iface is down.
const isEnabled = (v: Cfg) => !("disable" in v);

// ── reads ─────────────────────────────────────────────────────────────────────

/// The full running `interfaces` config node ({} when nothing is configured).
///
/// We query the parent `interfaces` node and read type children from it —
/// querying a tag node directly gets wrapped as `{"ethernet": {...}}` on some
/// VyOS versions.
async function fetchInterfacesConfig(): Promise<Cfg> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["interfaces"],
  });

  if (resp.success) return resp.data ?? {};
  // VyOS: "Configuration under specified path is empty" just means nothing is
  // configured; anything else is a real error.
  if ((resp.error ?? "").toLowerCase().includes("empty")) return {};
  throw new Error(resp.error || "Device returned an error reading interfaces.");
}

/// One interface type's map (keyed by interface name, e.g. `eth0`).
function kindNode(interfaces: Cfg, kind: string): Record<string, Cfg> {
  const node = interfaces[kind];
  return node && typeof node === "object" ? (node as Record<string, Cfg>) : {};
}

/// Configured ethernet interfaces, from the running config.
export async function fetchEthernet(): Promise<EthernetInterface[]> {
  const node = kindNode(await fetchInterfacesConfig(), "ethernet");

  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      const vif = cfg["vif"];
      return {
        name,
        description: childStr(cfg, "description"),
        addresses: asAddresses(cfg),
        mtu: asMtu(cfg),
        hw_id: childStr(cfg, "hw-id"),
        speed: childStr(cfg, "speed"),
        duplex: childStr(cfg, "duplex"),
        enabled: isEnabled(cfg),
        vlan_count: vif && typeof vif === "object" ? Object.keys(vif).length : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Configured 802.1Q VLAN sub-interfaces (`vif` children of ethernet nodes).
export async function fetchVlans(): Promise<VlanInterface[]> {
  const eths = kindNode(await fetchInterfacesConfig(), "ethernet");

  const out: VlanInterface[] = [];
  for (const [parent, raw] of Object.entries(eths)) {
    const vifs = (raw ?? {})["vif"];
    if (!vifs || typeof vifs !== "object") continue;
    for (const [vid, vraw] of Object.entries(vifs as Record<string, Cfg>)) {
      const cfg = (vraw ?? {}) as Cfg;
      out.push({
        name: `${parent}.${vid}`,
        parent,
        vlan_id: Number(vid) || 0,
        description: childStr(cfg, "description"),
        addresses: asAddresses(cfg),
        mtu: asMtu(cfg),
        enabled: isEnabled(cfg),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/// Configured loopback interfaces (normally just `lo`).
export async function fetchLoopback(): Promise<LoopbackInterface[]> {
  const node = kindNode(await fetchInterfacesConfig(), "loopback");

  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return {
        name,
        description: childStr(cfg, "description"),
        addresses: asAddresses(cfg),
        mtu: asMtu(cfg),
        enabled: isEnabled(cfg),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Configured bond (link aggregation) interfaces.
export async function fetchBonds(): Promise<BondInterface[]> {
  const node = kindNode(await fetchInterfacesConfig(), "bonding");

  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return {
        name,
        description: childStr(cfg, "description"),
        addresses: asAddresses(cfg),
        mtu: asMtu(cfg),
        mode: childStr(cfg, "mode"),
        members: asMembers(cfg),
        enabled: isEnabled(cfg),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Configured bridge interfaces.
export async function fetchBridges(): Promise<BridgeInterface[]> {
  const node = kindNode(await fetchInterfacesConfig(), "bridge");

  return Object.entries(node)
    .map(([name, raw]) => {
      const cfg = (raw ?? {}) as Cfg;
      return {
        name,
        description: childStr(cfg, "description"),
        addresses: asAddresses(cfg),
        mtu: asMtu(cfg),
        members: asMembers(cfg),
        enabled: isEnabled(cfg),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Description of every configured interface, keyed by name (VLAN
/// sub-interfaces included as `eth0.10`) — for annotating interface pickers.
export async function fetchInterfaceDescriptions(): Promise<Record<string, string>> {
  const interfaces = await fetchInterfacesConfig();
  const out: Record<string, string> = {};
  for (const kind of Object.keys(interfaces)) {
    for (const [name, raw] of Object.entries(kindNode(interfaces, kind))) {
      const cfg = (raw ?? {}) as Cfg;
      const desc = childStr(cfg, "description");
      if (desc) out[name] = desc;
      const vifs = cfg["vif"];
      if (!vifs || typeof vifs !== "object") continue;
      for (const [vid, vraw] of Object.entries(vifs as Record<string, Cfg>)) {
        const vdesc = childStr((vraw ?? {}) as Cfg, "description");
        if (vdesc) out[`${name}.${vid}`] = vdesc;
      }
    }
  }
  return out;
}

/// Carrier state of a physical NIC, from operational (not config) state.
export type LinkState = "up" | "down" | "unknown";

export interface PhysicalEthernet {
  name: string;
  link: LinkState;
}

/// Parse `show interfaces ethernet` op output. The table starts after a dashed
/// separator line; vif sub-interfaces (`eth1.20`) are skipped. The S/L column
/// (`u/u`, `u/D`, `A/D`) encodes admin state / link state — the second letter
/// is the carrier.
function parseEthernetTable(text: string): PhysicalEthernet[] {
  const out = new Map<string, LinkState>();
  let inTable = false;
  for (const line of text.split("\n")) {
    const t = line.trimStart();
    if (!inTable) {
      if (t.startsWith("---")) inTable = true;
      continue;
    }
    const toks = t.split(/\s+/);
    const name = toks[0];
    if (!name || name.includes(".")) continue; // vif sub-interface, not a physical NIC
    if (!/^[a-z]/i.test(name)) continue; // continuation line (extra IP address)
    const sl = toks.find((tok) => /^[uDA]\/[uDA]$/.test(tok));
    const link: LinkState = sl ? (sl.endsWith("u") ? "up" : "down") : "unknown";
    if (!out.has(name)) out.set(name, link);
  }
  return [...out.entries()]
    .map(([name, link]) => ({ name, link }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Operational phy state of one physical NIC (backend `/api/interfaces/phy`:
/// sysfs + ethtool). `supported_speeds` is empty when the port doesn't report
/// its capabilities — offer every speed then.
export interface PhyInfo {
  name: string;
  link: boolean | null;
  /** Negotiated speed in Mb/s; null when the link is down. */
  speed_mbps: number | null;
  duplex: string | null;
  /** Speeds (Mb/s) the port supports, ascending. */
  supported_speeds: number[];
}

/// Phy capabilities + negotiated state of every physical NIC. Best-effort:
/// callers treat a failure as "no phy data" (columns show — and the speed
/// picker offers everything).
export function fetchEthernetPhy(): Promise<PhyInfo[]> {
  return apiFetch<PhyInfo[]>("/interfaces/phy");
}

/// Human display of a negotiated/configured speed in Mb/s.
export function formatSpeed(mbps: number | null): string | null {
  if (mbps == null) return null;
  if (mbps < 1000) return `${mbps} Mb/s`;
  const g = mbps / 1000;
  return `${Number.isInteger(g) ? g : g.toFixed(1)} Gb/s`;
}

/// All physical ethernet NICs present on the device (configured or not), with
/// their link state, read from operational state. The UI subtracts
/// already-configured interfaces from this to find which NICs are free to add.
export async function fetchPhysicalEthernet(): Promise<PhysicalEthernet[]> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["interfaces", "ethernet"],
  });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error listing physical interfaces.");
  }
  return parseEthernetTable(resp.data ?? "");
}

// ── writes ────────────────────────────────────────────────────────────────────

const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/// Commit a command list in one transaction — the DIRECT path, for domains
/// that can't sever the management session (services, system settings).
/// Firewall/interface/NAT/routing writes go through `guardedCommitAndSave`
/// (lib/guard) instead, which adds a confirm-or-revert window.
///
/// The change is live once this resolves; persisting it to the boot config is
/// a second slow VyOS API round trip the user shouldn't wait on, so it runs
/// in the background (the shell's SaveIndicator shows progress and surfaces
/// failures with a retry). Returns the number of changes applied.
export async function commitAndSave(commands: VyosCommand[]): Promise<number> {
  if (commands.length === 0) return 0;

  const resp = await vyosApi<VyosResponse>("configure", commands);
  if (!resp.success) {
    throw new Error(resp.error || "Device rejected the configuration.");
  }

  scheduleBootSave();
  return commands.length;
}

/// Interface changes CAN sever the management session (deleting the address
/// you're connected through), so this module's own writes go through
/// commit-confirm — live immediately, auto-reverted unless confirmed.
const guardedApply = (commands: VyosCommand[]) =>
  guardedCommitAndSave(commands, "Interface configuration change");

/// Diff description + addresses + MTU + enabled against a live row — the leaf
/// set every interface type shares. Returns whether any `set` was emitted.
function diffCommonLeaves(
  out: VyosCommand[],
  base: string[],
  live: { description: string | null; addresses: string[]; mtu: number | null; enabled: boolean } | null,
  u: { description: string | null; addresses: string[]; mtu: number | null; enabled: boolean },
): void {
  const mk = (op: "set" | "delete", ...suffix: string[]) =>
    out.push({ op, path: [...base, ...suffix] });

  // Description.
  const newDesc = trimmed(u.description);
  if (newDesc !== (live?.description ?? null)) {
    if (newDesc !== null) mk("set", "description", newDesc);
    else mk("delete", "description");
  }

  // Addresses (multi-value).
  const liveAddrs = live?.addresses ?? [];
  const newAddrs = u.addresses.map((a) => a.trim()).filter(Boolean);
  for (const a of newAddrs) if (!liveAddrs.includes(a)) mk("set", "address", a);
  for (const a of liveAddrs) if (!newAddrs.includes(a)) mk("delete", "address", a);

  // MTU.
  if (u.mtu !== (live?.mtu ?? null)) {
    if (u.mtu !== null) mk("set", "mtu", String(u.mtu));
    else mk("delete", "mtu");
  }

  // Enabled state — VyOS models "down" as a valueless `disable` leaf. New
  // interfaces default up.
  const liveEnabled = live?.enabled ?? true;
  if (u.enabled !== liveEnabled) {
    if (u.enabled) mk("delete", "disable");
    else mk("set", "disable");
  }
}

/// A new node with nothing else set still needs to be created explicitly.
function ensureCreated(out: VyosCommand[], base: string[], isNew: boolean): void {
  if (isNew && !out.some((c) => c.op === "set")) {
    out.length = 0;
    out.push({ op: "set", path: base });
  }
}

// ── ethernet ──────────────────────────────────────────────────────────────────

/// Diff a desired ethernet config against the live row into a minimal
/// set/delete command list (empty when the config already matches).
export function diffEthernet(
  live: EthernetInterface | null,
  u: EthernetConfigUpdate,
): VyosCommand[] {
  const base = ["interfaces", "ethernet", u.name];
  const out: VyosCommand[] = [];
  const mk = (op: "set" | "delete", ...suffix: string[]) =>
    out.push({ op, path: [...base, ...suffix] });

  diffCommonLeaves(out, base, live, u);

  // Speed / duplex — null means auto (the default), modelled by deleting the leaf.
  const newSpeed = trimmed(u.speed);
  if (newSpeed !== (live?.speed ?? null)) {
    if (newSpeed !== null) mk("set", "speed", newSpeed);
    else mk("delete", "speed");
  }
  const newDuplex = trimmed(u.duplex);
  if (newDuplex !== (live?.duplex ?? null)) {
    if (newDuplex !== null) mk("set", "duplex", newDuplex);
    else mk("delete", "duplex");
  }

  ensureCreated(out, base, live === null);
  return out;
}

/// Apply a desired ethernet config against the live row. Returns the number of
/// changes applied (0 = already matched, nothing sent).
export function applyEthernet(
  live: EthernetInterface | null,
  update: EthernetConfigUpdate,
): Promise<number> {
  return guardedApply(diffEthernet(live, update));
}

// ── VLAN ──────────────────────────────────────────────────────────────────────

/// Config path of a VLAN sub-interface node: `interfaces ethernet <parent> vif <id>`.
const vifBase = (parent: string, vid: number) => [
  "interfaces",
  "ethernet",
  parent,
  "vif",
  String(vid),
];

/// Diff a desired VLAN against the live list into a minimal set/delete command
/// list. An edit that changes parent or id is a move: drop the old vif and
/// rebuild fresh.
export function diffVlan(existing: VlanInterface[], u: VlanConfigUpdate): VyosCommand[] {
  const out: VyosCommand[] = [];

  const moved =
    u.original_parent !== null &&
    u.original_vlan_id !== null &&
    (u.original_parent !== u.parent || u.original_vlan_id !== u.vlan_id);
  if (moved) {
    out.push({ op: "delete", path: vifBase(u.original_parent!, u.original_vlan_id!) });
  }

  // After a move the target is brand new, so diff against an empty live config.
  const live = moved
    ? null
    : existing.find((v) => v.parent === u.parent && v.vlan_id === u.vlan_id) ?? null;

  const base = vifBase(u.parent, u.vlan_id);
  const body: VyosCommand[] = [];
  diffCommonLeaves(body, base, live, u);
  ensureCreated(body, base, live === null);
  out.push(...body);

  return out;
}

/// Apply a desired VLAN config. Returns the number of changes applied.
export function applyVlan(existing: VlanInterface[], update: VlanConfigUpdate): Promise<number> {
  return guardedApply(diffVlan(existing, update));
}

/// Delete a VLAN sub-interface.
export function deleteVlan(parent: string, vlanId: number): Promise<number> {
  return guardedApply([{ op: "delete", path: vifBase(parent, vlanId) }]);
}

// ── loopback ──────────────────────────────────────────────────────────────────

/// Diff a desired loopback config. Only `description` and `address` exist on
/// the VyOS loopback node, so that's all the diff touches.
export function diffLoopback(
  live: LoopbackInterface | null,
  u: LoopbackConfigUpdate,
): VyosCommand[] {
  const base = ["interfaces", "loopback", u.name];
  const out: VyosCommand[] = [];
  const mk = (op: "set" | "delete", ...suffix: string[]) =>
    out.push({ op, path: [...base, ...suffix] });

  const newDesc = trimmed(u.description);
  if (newDesc !== (live?.description ?? null)) {
    if (newDesc !== null) mk("set", "description", newDesc);
    else mk("delete", "description");
  }

  const liveAddrs = live?.addresses ?? [];
  const newAddrs = u.addresses.map((a) => a.trim()).filter(Boolean);
  for (const a of newAddrs) if (!liveAddrs.includes(a)) mk("set", "address", a);
  for (const a of liveAddrs) if (!newAddrs.includes(a)) mk("delete", "address", a);

  ensureCreated(out, base, live === null);
  return out;
}

/// Apply a desired loopback config. Returns the number of changes applied.
export function applyLoopback(
  live: LoopbackInterface | null,
  update: LoopbackConfigUpdate,
): Promise<number> {
  return guardedApply(diffLoopback(live, update));
}

// ── bond / bridge ─────────────────────────────────────────────────────────────

/// Diff member lists — `member interface <name>` nodes, multi-value like `address`.
function diffMembers(
  out: VyosCommand[],
  base: string[],
  liveMembers: string[],
  newMembers: string[],
): void {
  for (const m of newMembers)
    if (!liveMembers.includes(m)) out.push({ op: "set", path: [...base, "member", "interface", m] });
  for (const m of liveMembers)
    if (!newMembers.includes(m)) out.push({ op: "delete", path: [...base, "member", "interface", m] });
}

/// Diff a desired bond config against the live row into a minimal set/delete
/// command list (empty when the config already matches).
export function diffBond(live: BondInterface | null, u: BondConfigUpdate): VyosCommand[] {
  const base = ["interfaces", "bonding", u.name];
  const out: VyosCommand[] = [];

  diffCommonLeaves(out, base, live, u);

  // Mode — an absent leaf means the VyOS default, 802.3ad.
  if (u.mode !== (live?.mode ?? "802.3ad")) {
    out.push({ op: "set", path: [...base, "mode", u.mode] });
  }

  diffMembers(out, base, live?.members ?? [], u.members);

  ensureCreated(out, base, live === null);
  return out;
}

/// Apply a desired bond config. Returns the number of changes applied.
export function applyBond(live: BondInterface | null, update: BondConfigUpdate): Promise<number> {
  return guardedApply(diffBond(live, update));
}

/// Delete a bond interface.
export function deleteBond(name: string): Promise<number> {
  return guardedApply([{ op: "delete", path: ["interfaces", "bonding", name] }]);
}

/// Diff a desired bridge config against the live row into a minimal set/delete
/// command list (empty when the config already matches).
export function diffBridge(live: BridgeInterface | null, u: BridgeConfigUpdate): VyosCommand[] {
  const base = ["interfaces", "bridge", u.name];
  const out: VyosCommand[] = [];

  diffCommonLeaves(out, base, live, u);
  diffMembers(out, base, live?.members ?? [], u.members);

  ensureCreated(out, base, live === null);
  return out;
}

/// Apply a desired bridge config. Returns the number of changes applied.
export function applyBridge(
  live: BridgeInterface | null,
  update: BridgeConfigUpdate,
): Promise<number> {
  return guardedApply(diffBridge(live, update));
}

/// Delete a bridge interface.
export function deleteBridge(name: string): Promise<number> {
  return guardedApply([{ op: "delete", path: ["interfaces", "bridge", name] }]);
}
