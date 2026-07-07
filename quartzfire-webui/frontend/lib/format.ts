// Shared formatting helpers for dashboard tiles.

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;

/// Human byte size (2 decimals, 1024-based, GB/MB/KB) — for cumulative totals.
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(2)} KB`;
  return `${bytes} B`;
}

/// Network rate from bytes/sec, shown in bits/sec (the conventional "speed" unit).
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bits)} bps`;
}
