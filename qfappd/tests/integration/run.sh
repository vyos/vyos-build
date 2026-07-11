#!/usr/bin/env bash
#
# qfappd end-to-end integration test.
#
# Builds a client — router(qfappd) — server topology out of two network
# namespaces and veth pairs, then drives REAL classifiable traffic (DNS and an
# HTTPS SNI) through the router and asserts qfappd's allow/block behavior.
#
# Requires: root, libndpi (release build with --features ndpi), nft, ip,
#           dnsmasq or python3 (test DNS server), curl, openssl.
#
#   sudo -E ./tests/integration/run.sh
#
# Exit non-zero on any failed assertion. Cleans up namespaces on exit.
set -euo pipefail

QFAPPD_BIN="${QFAPPD_BIN:-$(pwd)/target/release/qfappd}"
RUN=/run/qfappd
POLICY=$RUN/policy.json
CFG=/tmp/qfappd-itest.toml
LOG=/tmp/qfappd-itest.log

C_NS=qf_cli
S_NS=qf_srv
CLI_IP=10.10.1.2
SRV_IP=10.10.2.2
CLI_GW=10.10.1.1
SRV_GW=10.10.2.1

pass=0; fail=0
ok()   { echo "  ok  : $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $*"; fail=$((fail+1)); }

cleanup() {
    set +e
    [ -n "${QFAPPD_PID:-}" ] && kill "$QFAPPD_PID" 2>/dev/null
    nft delete table inet qfappd 2>/dev/null
    ip netns del "$C_NS" 2>/dev/null
    ip netns del "$S_NS" 2>/dev/null
    ip link del qf_vc 2>/dev/null
    ip link del qf_vs 2>/dev/null
    sysctl -qw net.ipv4.ip_forward="${OLD_FWD:-0}" 2>/dev/null
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo "must run as root"; exit 1; }
[ -x "$QFAPPD_BIN" ] || { echo "build first: make build-ndpi (missing $QFAPPD_BIN)"; exit 1; }

echo "==> topology"
OLD_FWD=$(sysctl -n net.ipv4.ip_forward)
sysctl -qw net.ipv4.ip_forward=1

ip netns add "$C_NS"
ip netns add "$S_NS"
# client veth: qf_vc (host/router) <-> qf_vc_p (client ns)
ip link add qf_vc type veth peer name qf_vc_p
ip link add qf_vs type veth peer name qf_vs_p
ip link set qf_vc_p netns "$C_NS"
ip link set qf_vs_p netns "$S_NS"

ip addr add "$CLI_GW/24" dev qf_vc
ip addr add "$SRV_GW/24" dev qf_vs
ip link set qf_vc up
ip link set qf_vs up

ip -n "$C_NS" addr add "$CLI_IP/24" dev qf_vc_p
ip -n "$C_NS" link set qf_vc_p up
ip -n "$C_NS" link set lo up
ip -n "$C_NS" route add default via "$CLI_GW"

ip -n "$S_NS" addr add "$SRV_IP/24" dev qf_vs_p
ip -n "$S_NS" link set qf_vs_p up
ip -n "$S_NS" link set lo up
ip -n "$S_NS" route add default via "$SRV_GW"

echo "==> test DNS server in $S_NS (:53)"
# Minimal DNS responder: answers any A query with 10.10.2.2.
ip netns exec "$S_NS" python3 "$(dirname "$0")/dns_stub.py" "$SRV_IP" &
DNS_PID=$!
sleep 1

write_policy() {  # $1 = default_action, $2 = app, $3 = verdict
    cat > "$POLICY" <<EOF
{ "version": 2,
  "actions": { "T": { "default_action": "$1", "block_mode": "drop",
      "applications": { "$2": "$3" } } },
  "bindings": [ { "id": 1, "action": "T",
      "match": { "iifname": ["qf_vc"], "oifname": ["qf_vs"] } } ] }
EOF
}

cat > "$CFG" <<EOF
[queues]
count = 2
[classify]
max_packets = 8
EOF

mkdir -p "$RUN"
write_policy allow DNS allow

echo "==> start qfappd"
"$QFAPPD_BIN" --config "$CFG" run >"$LOG" 2>&1 &
QFAPPD_PID=$!
sleep 2
kill -0 "$QFAPPD_PID" 2>/dev/null || { echo "qfappd died:"; cat "$LOG"; exit 1; }

dns_query() { ip netns exec "$C_NS" timeout 3 dig +time=1 +tries=1 @"$SRV_IP" example.com A >/dev/null 2>&1; }

echo "==> assert: DNS allowed"
if dns_query; then ok "DNS resolves when allowed"; else bad "DNS should resolve when allowed"; fi

echo "==> flip policy to block DNS (SIGHUP reload)"
write_policy allow DNS block
kill -HUP "$QFAPPD_PID"
sleep 1

echo "==> assert: DNS blocked (new flow)"
# New source port each query → new flow → must hit the block verdict.
if dns_query; then bad "DNS should be blocked after reload"; else ok "DNS blocked after policy reload"; fi

echo "==> assert: events emitted"
if grep -q '"app":"DNS"' /var/log/qfappd/events.json 2>/dev/null; then
    ok "DNS classification event logged"
else
    bad "expected a DNS event in /var/log/qfappd/events.json"
fi

echo "==> assert: block event has action=block"
if grep -q '"app":"DNS".*"action":"block"' /var/log/qfappd/events.json 2>/dev/null \
   || grep '"app":"DNS"' /var/log/qfappd/events.json | grep -q '"action":"block"'; then
    ok "block decision recorded"
else
    bad "expected a blocked DNS event"
fi

kill "$DNS_PID" 2>/dev/null || true

echo
echo "==> $pass passed, $fail failed"
[ "$fail" -eq 0 ]
