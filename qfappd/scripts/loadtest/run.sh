#!/usr/bin/env bash
#
# qfappd new-flow load test.
#
# Goal from the spec: classify >= 50k NEW flows/min on 4 cores with no queue
# drops. Because the *fast path* is pure nftables, only new (unclassified)
# flows exercise the userspace queue — so this test hammers unique 5-tuples.
#
# Two generators are supported:
#   * trafgen (from netsniff-ng) — preferred, kernel-rate packet injection;
#   * a bash/hping3 fallback when trafgen isn't available.
#
# Requires root + a running qfappd. Reports flows offered, decisions made
# (from GetStatus via `qfappd`—actually via the status.json), and queue drops.
#
#   sudo -E ./scripts/loadtest/run.sh [DURATION_SECS] [PPS]
set -euo pipefail

DUR="${1:-60}"
PPS="${2:-2000}"          # 2000 new flows/s = 120k/min headroom over target
IFACE="${LOADTEST_IFACE:-qf_lt0}"
STATUS=/run/qfappd/status.json

[ "$(id -u)" -eq 0 ] || { echo "must run as root"; exit 1; }

cleanup() { ip link del "$IFACE" 2>/dev/null || true; }
trap cleanup EXIT

# A dummy interface qfappd's bindings can match; the generator sends unique
# SYNs so each is a fresh flow that reaches the queue.
ip link add "$IFACE" type dummy 2>/dev/null || true
ip link set "$IFACE" up

read_drops() { [ -f "$STATUS" ] && grep -o '"drops":[0-9]*' "$STATUS" | grep -o '[0-9]*' | paste -sd+ | bc || echo 0; }
read_decisions() { [ -f "$STATUS" ] && grep -o '"decisions":[0-9]*' "$STATUS" | grep -o '[0-9]*' || echo 0; }

d0=$(read_decisions); drop0=$(read_drops)
echo "==> generating ~${PPS} new flows/s for ${DUR}s (target >= 50000/min = 834/s)"

if command -v trafgen >/dev/null 2>&1; then
    cfg=$(mktemp)
    # Each packet randomizes source port + a byte of source IP → unique flows,
    # SYN to :443 so it looks like new TLS connections.
    cat > "$cfg" <<'TRAFGEN'
{
  /* eth */ 0x00,0x00,0x00,0x00,0x00,0x02, 0x00,0x00,0x00,0x00,0x00,0x01, 0x08,0x00,
  /* ip  */ 0x45,0x00, const16(40), drnd(2), 0x40,0x00, 0x40,0x06, csumip(14,33),
            10,0,0,drnd(1), 10,0,0,2,
  /* tcp */ drnd(2), 0x01,0xbb, drnd(4), 0x00,0x00,0x00,0x00, 0x50,0x02, 0xff,0xff,
            csumtcp(14,34), 0x00,0x00,
}
TRAFGEN
    timeout "$DUR" trafgen --cpp --dev "$IFACE" --conf "$cfg" --rate "${PPS}pps" --no-sock-mem || true
    rm -f "$cfg"
elif command -v hping3 >/dev/null 2>&1; then
    timeout "$DUR" hping3 --syn -p 443 --faster --rand-source "$IFACE" >/dev/null 2>&1 || true
else
    echo "need trafgen or hping3 for the load test" >&2
    exit 1
fi

sleep 2
d1=$(read_decisions); drop1=$(read_drops)
decisions=$((d1 - d0)); drops=$((drop1 - drop0))
rate=$(( decisions * 60 / DUR ))

echo
echo "==> results over ${DUR}s"
echo "    decisions : $decisions   (~${rate}/min)"
echo "    queue drops: $drops"
if [ "$rate" -ge 50000 ] && [ "$drops" -eq 0 ]; then
    echo "==> PASS: >= 50k/min with zero queue drops"
else
    echo "==> below target or drops occurred — see GetStatus for per-queue detail"
fi
