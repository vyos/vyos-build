// Data layer for the dashboard tiles.
//
// Everything here reads live operational state from the firewall through the
// authenticated VyOS proxy (`vyosApi`). System info is best-effort: each field
// is null when its `show` command fails or its output can't be parsed, and the
// tiles render what they get.

import { vyosApi } from "./api";
import { VyosResponse } from "./interfaces";

export interface LoadAverage {
  one: number | null;
  five: number | null;
  fifteen: number | null;
}

export interface MemoryInfo {
  total_bytes: number | null;
  used_bytes: number | null;
  free_bytes: number | null;
  used_pct: number | null;
}

export interface StorageMount {
  filesystem: string;
  size_bytes: number | null;
  used_bytes: number | null;
  avail_bytes: number | null;
  used_pct: number | null;
  mount: string | null;
}

/// Live operational system info for the dashboard pod. All fields best-effort (may be null).
export interface DeviceSystemInfo {
  version: string | null;
  release_train: string | null;
  built_on: string | null;
  hardware_vendor: string | null;
  hardware_model: string | null;
  uptime: string | null;
  load: LoadAverage;
  memory: MemoryInfo;
  storage: StorageMount[];
}

export interface InterfaceStat {
  name: string;
  rx_bytes: number | null;
  rx_packets: number | null;
  tx_bytes: number | null;
  tx_packets: number | null;
}

/// Run an operational `show` command and return its text payload, or null on
/// any failure (unreachable, API error, missing data).
export async function showText(path: string[]): Promise<string | null> {
  try {
    const resp = await vyosApi<VyosResponse<string | null>>("show", { op: "show", path });
    return resp.success ? resp.data ?? null : null;
  } catch {
    return null;
  }
}

// ── parsers (ported from the vyos-fabric backend) ─────────────────────────────

/// Parse the `Key: value` lines of `show version`.
function parseVersion(text: string | null) {
  const map = new Map<string, string>();
  for (const line of text?.split("\n") ?? []) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k && v) map.set(k, v);
  }
  const version = map.get("version")?.replace(/^vyos\s+/i, "").trim() ?? null;
  return {
    version,
    release_train: map.get("release train") ?? null,
    built_on: map.get("built on") ?? null,
    hardware_vendor: map.get("hardware vendor") ?? null,
    hardware_model: map.get("hardware model") ?? null,
  };
}

/// Extract the numeric percentage after the colon, tolerating a trailing `%`.
function parsePct(line: string): number | null {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const n = Number(line.slice(i + 1).trim().replace(/%$/, "").trim());
  return Number.isFinite(n) ? n : null;
}

/// Parse `show system uptime`: an "Uptime:" line plus 1/5/15-minute load percentages.
function parseUptime(text: string | null): { uptime: string | null; load: LoadAverage } {
  let uptime: string | null = null;
  const load: LoadAverage = { one: null, five: null, fifteen: null };
  for (const line of text?.split("\n") ?? []) {
    // VyOS pads "1  minute:" to align with "15 minutes:" — collapse runs of
    // whitespace before matching.
    const lower = line.trim().toLowerCase().replace(/\s+/g, " ");
    if (lower.startsWith("uptime")) {
      const i = line.indexOf(":");
      const v = i >= 0 ? line.slice(i + 1).trim() : "";
      uptime = v || null;
    } else if (lower.startsWith("1 minute")) {
      load.one = parsePct(line);
    } else if (lower.startsWith("5 minute")) {
      load.five = parsePct(line);
    } else if (lower.startsWith("15 minute")) {
      load.fifteen = parsePct(line);
    }
  }
  return { uptime, load };
}

/// Parse a human size token like "15.6 GB", "184.9 MB", "126G", or a bare number into bytes.
function parseSize(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)\s*([KMGT])?/i);
  if (!m || m[1] === "") return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[
    (m[2] ?? "").toUpperCase() as "K" | "M" | "G" | "T"
  ] ?? 1;
  return Math.round(num * mult);
}

/// Parse `show system memory`: Total/Used/Free lines with optional units.
function parseMemory(text: string | null): MemoryInfo {
  const mem: MemoryInfo = { total_bytes: null, used_bytes: null, free_bytes: null, used_pct: null };
  for (const line of text?.split("\n") ?? []) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "total") mem.total_bytes = parseSize(val);
    else if (key === "used") mem.used_bytes = parseSize(val);
    else if (key === "free") mem.free_bytes = parseSize(val);
  }
  if (mem.total_bytes && mem.used_bytes !== null) {
    mem.used_pct = (mem.used_bytes / mem.total_bytes) * 100;
  }
  return mem;
}

/// Extract a percentage from a parenthesised suffix like "562M (1%)" → 1.
function parseParenPct(s: string): number | null {
  const m = s.match(/\(([\d.]+)\s*%\)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/// Parse `show system storage`, which VyOS emits as `Key: value` blocks (one
/// per filesystem):
///
/// ```text
/// Filesystem: /dev/sda3
/// Size: 126G
/// Used: 562M (1%)
/// Available: 119G (99%)
/// ```
function parseStorage(text: string | null): StorageMount[] {
  const out: StorageMount[] = [];
  let cur: StorageMount | null = null;
  for (const line of text?.split("\n") ?? []) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "filesystem") {
      if (cur) out.push(cur);
      cur = {
        filesystem: val,
        size_bytes: null,
        used_bytes: null,
        avail_bytes: null,
        used_pct: null,
        mount: null,
      };
    } else if (!cur) {
      continue;
    } else if (key === "size") {
      cur.size_bytes = parseSize(val);
    } else if (key === "used") {
      cur.used_bytes = parseSize(val);
      cur.used_pct = parseParenPct(val);
    } else if (key === "available" || key === "avail") {
      cur.avail_bytes = parseSize(val);
    } else if (key === "mounted on" || key === "mount") {
      cur.mount = val;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/// Parse `show interfaces counters`. Columns are `Interface Rx-Packets
/// Rx-Bytes Tx-Packets Tx-Bytes`; the header and separator rows are skipped
/// because their non-name columns don't parse as numbers. Some VyOS builds
/// emit the whole table twice (the op-mode script prints it and the runner
/// prints the returned copy again), so only the first row per interface is kept.
function parseInterfaceCounters(text: string): InterfaceStat[] {
  const out: InterfaceStat[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const nums = cols.slice(1, 5).map((c) => {
      const n = Number(c.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    });
    if (nums.some((n) => n === null)) continue; // header / separator / non-data row
    if (seen.has(cols[0])) continue;
    seen.add(cols[0]);
    out.push({
      name: cols[0],
      rx_packets: nums[0],
      rx_bytes: nums[1],
      tx_packets: nums[2],
      tx_bytes: nums[3],
    });
  }
  return out;
}

// ── fetchers ──────────────────────────────────────────────────────────────────

export async function fetchSystemInfo(): Promise<DeviceSystemInfo> {
  // Independent best-effort reads — fan them out concurrently.
  const [versionTxt, uptimeTxt, memoryTxt, storageTxt] = await Promise.all([
    showText(["version"]),
    showText(["system", "uptime"]),
    showText(["system", "memory"]),
    showText(["system", "storage"]),
  ]);

  const { uptime, load } = parseUptime(uptimeTxt);
  return {
    ...parseVersion(versionTxt),
    uptime,
    load,
    memory: parseMemory(memoryTxt),
    storage: parseStorage(storageTxt),
  };
}

export async function fetchInterfaceStats(): Promise<InterfaceStat[]> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["interfaces", "counters"],
  });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error reading interface counters.");
  }
  return parseInterfaceCounters(resp.data ?? "");
}
