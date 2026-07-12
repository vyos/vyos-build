#!/bin/bash
# Runs INSIDE a debian:bookworm container (see smoke.sh). Proves the SSL
# inspection ICAP seam end-to-end with a real squid-openssl:
#   1. squid-openssl has ssl_bump + ICAP support (the build guard);
#   2. a bumped HTTPS request is delivered to the ICAP echo as PLAINTEXT for
#      both REQMOD and RESPMOD;
#   3. with the ICAP service down and bypass=off, traffic FAILS CLOSED.
set -euo pipefail

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
pass() { printf '\033[32mPASS: %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
log "Installing squid-openssl + tooling"
apt-get update -qq
apt-get install -y --no-install-recommends \
  squid-openssl openssl python3 curl ca-certificates >/dev/null

# ── 1. build capability guard ────────────────────────────────────────────────
log "Checking Squid build capabilities"
V="$(squid -v 2>&1 || true)"
echo "$V" | grep -q -- '--with-openssl' || fail "squid lacks --with-openssl (not squid-openssl?)"
echo "$V" | grep -q -- '--enable-icap-client' || fail "squid lacks --enable-icap-client"
pass "squid-openssl has ssl_bump + ICAP client"

CA=/tmp/ca; mkdir -p "$CA"
DB=/var/lib/squid/ssl_db
ORIGIN_CN=origin.test
echo "127.0.0.1 $ORIGIN_CN" >> /etc/hosts

log "Generating inspection CA (exact QuartzFire subject)"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$CA/ca.key" -out "$CA/ca.crt" \
  -subj "/CN=QuartzFire SSL Inspection/O=Quartz Systems" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
chmod 600 "$CA/ca.key"
openssl x509 -in "$CA/ca.crt" -noout -subject | grep -q "QuartzFire SSL Inspection" \
  || fail "CA subject wrong"
pass "CA generated"

log "Initializing certgen DB"
mkdir -p "$(dirname "$DB")" /var/spool/squid
rm -rf "$DB"
/usr/lib/squid/security_file_certgen -c -s "$DB" -M 4MB >/dev/null
chown -R proxy:proxy "$DB" 2>/dev/null || true
pass "certgen DB ready"

# ── local self-signed HTTPS origin (hermetic — no internet needed) ───────────
log "Starting local HTTPS origin on :8443"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout /tmp/origin.key -out /tmp/origin.crt -subj "/CN=$ORIGIN_CN" 2>/dev/null
cat > /tmp/origin.py <<'PY'
import http.server, ssl
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"HELLO-PLAINTEXT-BODY-42\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-QZ-Origin", "yes")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tmp/origin.crt", "/tmp/origin.key")
srv = http.server.HTTPServer(("127.0.0.1", 8443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
python3 /tmp/origin.py & ORIGIN_PID=$!
sleep 1

# ── ICAP echo ────────────────────────────────────────────────────────────────
LOGF=/tmp/icap.log; : > "$LOGF"
log "Starting ICAP echo on :1344"
python3 /harness/icap_echo.py --host 127.0.0.1 --port 1344 --log "$LOGF" & ECHO_PID=$!
sleep 1

# ── squid.conf: forward-proxy ssl-bump + ICAP (bypass=off → fail closed) ─────
# (The device uses transparent `intercept`; a forward proxy is the practical way
# to drive a bump inside a container. Same ssl_bump / ICAP wiring is proven.)
log "Writing squid.conf and starting Squid"
cat > /etc/squid/squid.conf <<EOF
http_port 3128 ssl-bump generate-host-certificates=on dynamic_cert_mem_cache_size=4MB tls-cert=$CA/ca.crt tls-key=$CA/ca.key
sslcrtd_program /usr/lib/squid/security_file_certgen -s $DB -M 4MB
sslcrtd_children 2
tls_outgoing_options flags=DONT_VERIFY_PEER
acl step1 at_step SslBump1
ssl_bump peek step1
ssl_bump bump all
http_access allow all

icap_enable on
icap_preview_enable on
icap_preview_size 1024
icap_send_client_ip on
icap_service qf_req reqmod_precache icap://127.0.0.1:1344/request bypass=off
icap_service qf_resp respmod_precache icap://127.0.0.1:1344/response bypass=off
adaptation_access qf_req allow all
adaptation_access qf_resp allow all

cache deny all
cache_log /tmp/squid.log
pid_filename /tmp/squid.pid
EOF

squid -k parse -f /etc/squid/squid.conf
squid -N -f /etc/squid/squid.conf & SQUID_PID=$!

# Wait for the proxy port.
for i in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && { exec 3>&-; break; }
  sleep 0.5
done

# ── 2. bumped request delivered to ICAP as plaintext ─────────────────────────
log "Driving a bumped HTTPS request through the proxy"
OUT="$(curl -sS --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 https://$ORIGIN_CN:8443/hello 2>/tmp/curl.err || true)"
echo "origin body via bump: [$OUT]"
echo "$OUT" | grep -q "HELLO-PLAINTEXT-BODY-42" \
  || fail "client did not get the origin body through the bump (see /tmp/curl.err: $(cat /tmp/curl.err))"
pass "HTTPS was bumped: leaf cert issued by the QuartzFire CA, body delivered"

sleep 0.5
log "ICAP echo log:"
cat "$LOGF" || true
grep -q "=== REQMOD" "$LOGF" || fail "REQMOD was not delivered to ICAP"
# Bumped forward-proxy requests carry an absolute-form URI (GET https://…/hello).
grep -Eq "GET .*/hello HTTP" "$LOGF" || fail "REQMOD did not carry the decrypted request line"
pass "REQMOD received decrypted request plaintext (GET …/hello)"
grep -q "=== RESPMOD" "$LOGF" || fail "RESPMOD was not delivered to ICAP"
grep -Eq "HTTP/1\.[01] 200|X-QZ-Origin" "$LOGF" || fail "RESPMOD did not carry the decrypted response"
pass "RESPMOD received decrypted response plaintext"

# ── 3. fail-closed when the filter is down ───────────────────────────────────
log "Stopping ICAP echo — bypass=off must FAIL CLOSED"
kill "$ECHO_PID" 2>/dev/null || true
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 https://$ORIGIN_CN:8443/hello 2>/dev/null || echo 000)"
echo "response code with filter down: $CODE"
# fail-closed: Squid must NOT return the origin's 200; it errors (5xx) or the
# request fails outright.
if [ "$CODE" = "200" ]; then
  fail "traffic passed uninspected with the filter DOWN — not fail-closed!"
fi
pass "with the filter down, traffic failed closed (code=$CODE, not 200)"

kill "$SQUID_PID" "$ORIGIN_PID" 2>/dev/null || true
log "ALL CHECKS PASSED — the ICAP seam is proven; the filter engine is a drop-in."
