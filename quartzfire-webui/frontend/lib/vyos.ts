// Data layer for the dashboard tiles.
//
// STUB: nothing here talks to the firewall yet. Every fetcher returns plausible
// sample data so the dashboard renders end-to-end. When wiring up, replace the
// bodies with calls through the authenticated VyOS proxy (`vyosApi` in lib/api.ts,
// e.g. `show` ops for uptime/memory and `show interfaces counters`).

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

const GB = 1024 ** 3;

/// Small jitter around a base value so polled tiles look alive.
const jitter = (base: number, spread: number) =>
  Math.round((base + (Math.random() - 0.5) * spread) * 10) / 10;

export async function fetchSystemInfo(): Promise<DeviceSystemInfo> {
  const total = 8 * GB;
  const used = 1.9 * GB + Math.random() * 0.2 * GB;
  return {
    version: "1.5-rolling-202507",
    release_train: "current",
    built_on: "2025-07-01 04:12 UTC",
    hardware_vendor: "Quartz Systems",
    hardware_model: "QF-1000",
    uptime: "12 days, 4 hours, 23 minutes",
    load: { one: jitter(6, 4), five: jitter(8, 3), fifteen: jitter(7, 2) },
    memory: {
      total_bytes: total,
      used_bytes: used,
      free_bytes: total - used,
      used_pct: Math.round((used / total) * 1000) / 10,
    },
    storage: [
      {
        filesystem: "/dev/sda1",
        size_bytes: 32 * GB,
        used_bytes: 4.6 * GB,
        avail_bytes: 27.4 * GB,
        used_pct: 14,
        mount: "/",
      },
    ],
  };
}

// Cumulative counters that tick up between polls so the speed tile computes
// nonzero rates from the deltas.
const IFACE_PROFILES: { name: string; rxRate: number; txRate: number }[] = [
  { name: "eth0", rxRate: 6_400_000, txRate: 1_800_000 },
  { name: "eth1", rxRate: 2_100_000, txRate: 4_900_000 },
  { name: "eth2", rxRate: 240_000, txRate: 90_000 },
  { name: "wg0", rxRate: 610_000, txRate: 350_000 },
  { name: "lo", rxRate: 4_000, txRate: 4_000 },
];

const counters = new Map(
  IFACE_PROFILES.map((p) => [
    p.name,
    {
      rx_bytes: Math.round(p.rxRate * 3600 * (2 + Math.random())),
      tx_bytes: Math.round(p.txRate * 3600 * (2 + Math.random())),
      rx_packets: 0,
      tx_packets: 0,
      last: Date.now(),
    },
  ]),
);

export async function fetchInterfaceStats(): Promise<InterfaceStat[]> {
  const now = Date.now();
  return IFACE_PROFILES.map((p) => {
    const c = counters.get(p.name)!;
    const dt = (now - c.last) / 1000;
    c.last = now;
    c.rx_bytes += Math.round(p.rxRate * dt * (0.5 + Math.random()));
    c.tx_bytes += Math.round(p.txRate * dt * (0.5 + Math.random()));
    c.rx_packets = Math.round(c.rx_bytes / 900);
    c.tx_packets = Math.round(c.tx_bytes / 900);
    return {
      name: p.name,
      rx_bytes: c.rx_bytes,
      tx_bytes: c.tx_bytes,
      rx_packets: c.rx_packets,
      tx_packets: c.tx_packets,
    };
  });
}
