// Ethernet interface data layer.
//
// Unlike vyos-fabric (which stages changes in a controller DB for review),
// QuartzFire manages a single local firewall: reads and writes go straight to
// the VyOS HTTP API through the authenticated backend proxy, commit
// immediately, and are saved to the boot config.

import { vyosApi } from "./api";

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

interface VyosCommand {
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

/// `disable` is a valueless leaf — its mere presence means the iface is down.
const isEnabled = (v: Cfg) => !("disable" in v);

// ── reads ─────────────────────────────────────────────────────────────────────

/// Configured ethernet interfaces, from the running config.
///
/// We query the parent `interfaces` node and read its `ethernet` child —
/// querying the tag node directly gets wrapped as `{"ethernet": {...}}` on
/// some VyOS versions.
export async function fetchEthernet(): Promise<EthernetInterface[]> {
  const resp = await vyosApi<VyosResponse<Cfg | null>>("retrieve", {
    op: "showConfig",
    path: ["interfaces"],
  });

  let node: Cfg = {};
  if (resp.success) {
    const eth = resp.data?.["ethernet"];
    if (eth && typeof eth === "object") node = eth as Cfg;
  } else if (!(resp.error ?? "").toLowerCase().includes("empty")) {
    // VyOS: "Configuration under specified path is empty" just means nothing
    // is configured; anything else is a real error.
    throw new Error(resp.error || "Device returned an error reading interfaces.");
  }

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

/// Parse interface names from the first column of `show interfaces ethernet`
/// op output. The table starts after a dashed separator line; vif
/// sub-interfaces (`eth1.20`) are skipped.
function parseEthernetNames(text: string): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const t = line.trimStart();
    if (!inTable) {
      if (t.startsWith("---")) inTable = true;
      continue;
    }
    const tok = t.split(/\s+/)[0];
    if (!tok || tok.includes(".")) continue; // vif sub-interface, not a physical NIC
    if (/^[a-z]/i.test(tok)) out.push(tok);
  }
  return [...new Set(out)].sort();
}

/// All physical ethernet NICs present on the device (configured or not), read
/// from operational state. The UI subtracts already-configured interfaces from
/// this to find which NICs are free to add.
export async function fetchPhysicalEthernet(): Promise<string[]> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["interfaces", "ethernet"],
  });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error listing physical interfaces.");
  }
  return parseEthernetNames(resp.data ?? "");
}

// ── writes ────────────────────────────────────────────────────────────────────

const trimmed = (s: string | null) => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

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

  // Enabled state — VyOS models "down" as a valueless `disable` leaf. New NICs default up.
  const liveEnabled = live?.enabled ?? true;
  if (u.enabled !== liveEnabled) {
    if (u.enabled) mk("delete", "disable");
    else mk("set", "disable");
  }

  // Configuring a previously-unconfigured NIC with nothing else still needs
  // the node created.
  if (live === null && !out.some((c) => c.op === "set")) {
    out.length = 0;
    out.push({ op: "set", path: base });
  }

  return out;
}

/// Apply a desired ethernet config: diff against the live row, commit all
/// changes in one transaction, and save to the boot config. Returns the number
/// of changes applied (0 = already matched, nothing sent).
export async function applyEthernet(
  live: EthernetInterface | null,
  update: EthernetConfigUpdate,
): Promise<number> {
  const commands = diffEthernet(live, update);
  if (commands.length === 0) return 0;

  const resp = await vyosApi<VyosResponse>("configure", commands);
  if (!resp.success) {
    throw new Error(resp.error || "Device rejected the configuration.");
  }

  // Persist to the boot config so the change survives a reboot.
  const save = await vyosApi<VyosResponse>("config-file", { op: "save" });
  if (!save.success) {
    throw new Error(
      `Applied, but saving to boot config failed: ${save.error ?? "unknown error"}`,
    );
  }

  return commands.length;
}
