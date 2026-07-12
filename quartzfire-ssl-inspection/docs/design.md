# QuartzFire SSL Inspection (quartzfire-ssl-inspection)

TLS decryption/inspection for QuartzFire — the equivalent of WatchGuard
Fireware's **Content Inspection**. An admin toggles it on, manages the
inspection CA, chooses which traffic is inspected vs. bypassed, and hands the
root CA to clients. This package delivers the **TLS termination layer only**:
Squid `ssl_bump` as the sole MITM, its CA lifecycle, transparent
interface-scoped interception, the do-not-inspect (splice) list, a plain-HTTP
CA distribution page, and a **pre-wired but idle** ICAP seam for the future
content filter.

> **Scope:** content filtering (e2guardian / WebBlocker categorization, ClamAV,
> URL categorization) is a **separate, later** work item. This package must not
> implement it — it only exposes the ICAP seam it will plug into.

## Architecture decision (binding — do not deviate)

**Squid is the sole TLS terminator in QuartzFire. Nothing else on the box
performs MITM.**

This is deliberate. e2guardian ships its own SSL MITM capability *and its own CA
generation*. If it were later added in a chained-proxy layout
(client → e2guardian → Squid), the box would have **two interception engines
and two root CAs** — unmaintainable, and it would require reissuing a CA that
has already been distributed to and trusted by clients.

Therefore:

* Squid owns `ssl_bump`, owns the CA, owns the private key, owns the
  generated-cert store.
* e2guardian (or any future filter) runs as an **ICAP server behind Squid**, a
  pure filtering consumer:

  ```
  client → [nft redirect] → Squid (ssl_bump, holds the CA) → ICAP → e2guardian (filter/AV) → internet
  ```

* Because Squid **bumps before adaptation**, the ICAP engine receives
  already-decrypted **plaintext HTTP**. That is the entire reason e2guardian
  does **not need — and must not have —** its own TLS layer.
* When e2guardian is integrated, its SSL MITM features (`enablessl`,
  `generatecert`, its own root-CA options) stay **off**. Same for any other
  engine (c-icap + ClamAV, URL categorization): it attaches at the ICAP/helper
  boundary and gets **no** TLS layer of its own.

**If you are here to "turn on e2guardian's SSL support": don't.** It breaks the
single-CA invariant. Point e2guardian at Squid over ICAP in plaintext mode.

Exactly one CA and one private key exist on the box, both owned by this package.

## Interception model: transparent

WatchGuard-style: clients configure **no** proxy. The `qz_ssl` nftables table
redirects outbound `tcp/443` on the configured interfaces to Squid's
`https_port <intercept-port> intercept ssl-bump` port. Squid peeks step 1 to
read the SNI, **splices** (passes through undecrypted) do-not-inspect domains,
and **bumps** (decrypts) everything else.

Spliced traffic is opaque to inspection **and** to any future content filter by
definition — the exclusion list means "these domains bypass **both** decryption
and content filtering."

## Root CA

Generated on first enable (or explicit Regenerate) with the exact subject the
acceptance criteria require:

```
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout /config/quartzfire/ssl-inspection/ca.key \
  -out    /config/quartzfire/ssl-inspection/ca.crt \
  -subj   "/CN=QuartzFire SSL Inspection/O=Quartz Systems" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
```

* Stored under `/config/quartzfire/ssl-inspection/` so it **persists across VyOS
  image upgrades and signed-ISO updates** — never anywhere ephemeral.
* Private key is `root:root 0600`. It **never** leaves the box, is **never**
  rendered in the UI/API (the `CaInfo` struct has no key field), and is
  **never** logged.
* Regenerate mints a fresh CA and clears the certgen cache; **all previously
  distributed CAs become invalid** and clients must reinstall. The UI warns
  before doing this.

## Squid / ssl_bump

Rendered drop-in: `/etc/squid/conf.d/quartzfire-ssl-inspection.conf`.

```
https_port <intercept-port> intercept ssl-bump \
  generate-host-certificates=on dynamic_cert_mem_cache_size=8MB \
  tls-cert=/config/quartzfire/ssl-inspection/ca.crt \
  tls-key=/config/quartzfire/ssl-inspection/ca.key
sslcrtd_program /usr/lib/squid/security_file_certgen -s /var/lib/squid/ssl_db -M 8MB
acl step1 at_step SslBump1
acl noInspect ssl::server_name "/config/quartzfire/ssl-inspection/no-inspect.txt"
ssl_bump peek step1
ssl_bump splice noInspect
ssl_bump bump all            # or `splice all` when default-action = splice
tls_outgoing_options ...     # upstream-invalid: block (default) or allow
```

* **Packaging gotcha:** stock Debian/VyOS `squid` is built **without** OpenSSL
  bump support. This package Depends on **`squid-openssl`**. The build is
  verified two ways: `qzssl` `verify()` blocks the commit if `squid -v` lacks
  `--with-openssl`/`--enable-ssl-crtd`, and `scripts/check-squid-caps` fails the
  ISO build. Never silently non-inspecting.
* The certgen DB is initialized once
  (`security_file_certgen -c -s /var/lib/squid/ssl_db -M 8MB`, then
  `chown -R proxy:proxy`).
* **Upstream validation:** invalid origin certs are **blocked by default**
  (`upstream-invalid block`); `allow` relaxes to log-and-continue.
* HSTS / pinned-cert sites: put them on the do-not-inspect list so they are
  spliced. A bumped pinned site produces a clear Squid error event (logged for
  the SIEM), not a silent hang.

## ICAP seam (pre-wired, no engine yet)

Emitted **only** when `content-filter` is configured (default: absent). The
endpoint host/port/service names come from the config tree, never hardcoded, so
e2guardian or c-icap/ClamAV is a drop-in with no change to the TLS layer or CA.

```
icap_enable on
icap_preview_enable on
icap_preview_size 1024
icap_send_client_ip on
icap_send_client_username off
icap_service qf_filter_req  reqmod_precache  icap://<host>:<port>/<reqmod>  bypass=<off|on>
icap_service qf_filter_resp respmod_precache icap://<host>:<port>/<respmod> bypass=<off|on>
adaptation_access qf_filter_req  allow all
adaptation_access qf_filter_resp allow all
```

* **`bypass=off` (fail-closed) is the default.** If a filter is configured and
  its ICAP service is down, traffic **fails closed** — no silent uninspected
  passthrough. `fail-mode open` flips to `bypass=on`. Surfaced as a config
  option, never hardcoded.
* Squid must be built with `--enable-icap-client` (squid-openssl is). `verify()`
  blocks the commit if a content filter is configured on a build without it.
* ICAP service health is probed and reported in status.json
  (`icap.reachable` / `icap.configured=false` when no engine is configured), so
  a dead filter is **visible**, not just felt.

## Configuration: real VyOS config nodes

```
set service quartzfire ssl-inspection enable
set service quartzfire ssl-inspection intercept-port <1024-65535>   # default 3129
set service quartzfire ssl-inspection interface <ifname>             # multi; inspection scope
set service quartzfire ssl-inspection default-action <inspect|splice>
set service quartzfire ssl-inspection no-inspect <domain>            # multi; splice
set service quartzfire ssl-inspection disable-default-exclusions     # drop the shipped baseline
set service quartzfire ssl-inspection upstream-invalid <block|allow>
set service quartzfire ssl-inspection content-filter icap-host <h>
set service quartzfire ssl-inspection content-filter icap-port <n>
set service quartzfire ssl-inspection content-filter reqmod-service <name>
set service quartzfire ssl-inspection content-filter respmod-service <name>
set service quartzfire ssl-inspection content-filter fail-mode <closed|open>
set service quartzfire ssl-inspection ca-download interface <ifname> # multi; defaults to inspection scope
```

Shipped as hand-written cstore templates under
`/opt/vyatta/share/vyatta-cfg/templates/service/quartzfire/ssl-inspection/**`
whose root runs `/usr/libexec/vyos/conf_mode/service_ssl_inspection.py`
(priority 991, after firewall and geolocation). **Three hard constraints** on
out-of-tree config nodes apply verbatim (learned by the geolocation package):

1. `owner:` is **not** a cstore keyword — it exists only in vyos-1x XML, where
   the generator turns it into the `end:` line. An `owner:` line in a node.def
   is a template **syntax error** that aborts every config load, including boot.
2. The conf-mode script name **must end in `.py`** even though the target is an
   ELF binary: vyos-configd regex-parses the committing script path and crashes
   (hanging the commit) otherwise. `qzssl`'s argv[0] `file_stem` dispatch strips
   `.py`, so `service_ssl_inspection.py → qzssl` Just Works.
3. The nodes must be registered in the vyos-1x Python XML reference cache —
   hence `vyos/xml/service_quartzfire_ssl-inspection.xml` (kept in sync with the
   node.defs by hand) plus the postinst `generate_cache.py` + `update_cache.py`
   run. A path missing from the cache raises inside `get_commit_scripts()`,
   configd dies, and the committing vyshim hangs forever.

Because it is ordinary config, SSL inspection participates in commit,
commit-confirm, rollback, and config save/load. A bad inspection config that
passes `verify()` but misbehaves at runtime is auto-reverted by commit-confirm.
The WebUI edits it through the VyOS HTTP API under the commit-confirm guard,
exactly like the firewall and geolocation pages.

**Commit semantics** (`verify()` aborts the commit for):
static value errors (bad port/action/upstream/fail-mode/domain pattern), an
enabled feature with **no interfaces** (nothing would be intercepted), a build
**without OpenSSL bump support** when enabled, and a **content filter on a build
without `--enable-icap-client`**. Runtime apply hiccups (a transient Squid
reload) are warnings surfaced in status.json, not commit aborts.

## Enforcement: the qz_ssl nftables table

Everything lives in `table inet qz_ssl` — per the QuartzFire coexistence rule,
nothing is injected into `vyos_filter`, which VyOS regenerates wholesale on
every commit. Two jobs:

* `chain prerouting` (dstnat): `iifname { <scope> } tcp dport 443 redirect to
  :<intercept-port>` — transparent steering.
* `chain input` (filter): drops `tcp dport 4126` on every interface **except**
  the trusted CA-download scope, so the plain-HTTP CA page is never reachable on
  WAN even though the listener binds all interfaces.

VyOS reloads `/run/nftables.conf` on every firewall commit, which can flush our
table; `quartzfire-ssl-resync.path` watches that file and re-applies from the
committed snapshot.

## CA distribution page (HTTP, :4126)

`qzssl-cadist` serves a plain-HTTP landing page dedicated to CA distribution.
HTTP is **intentional** — a client that does not yet trust our CA cannot
validate our TLS (this matches how WatchGuard and Windows distribute inspection
CAs). It serves:

* `ca.crt` (PEM) and `ca.der` (DER, for Windows/Android),
* the SHA-256 fingerprint for out-of-band verification,
* short per-OS install instructions (Windows root store, macOS Keychain,
  iOS/Android, Firefox's own store, Linux `ca-certificates`).

The **private key is never served.** Reachability is restricted to the
configured trusted interfaces (default: the inspection scope) by the qz_ssl
input guard; the listener is enabled by `qzssl-apply` **only while inspection is
on**, so :4126 is unbound when the feature is off or was never configured.

## Processes and units

One Rust multi-call binary, `/usr/libexec/quartzfire/qzssl`; helper names and
the conf-mode owner are symlinks dispatched on argv[0] (src/main.rs).

| unit | role |
|---|---|
| (vyos commit) | `service_ssl_inspection` (→ qzssl commit) verifies + renders + applies synchronously |
| `quartzfire-ssl-cadist.service` | the :4126 CA-distribution listener (enabled by apply only while on) |
| `quartzfire-ssl-resync.path` + `.service` | re-apply the qz_ssl table after firewall commits flush it |
| `quartzfire-ssl-caregen.path` + `.service` | WebUI "Regenerate" → `qzssl-ca regenerate` |
| `quartzfire-ssl-apply.service` | belt-and-braces boot apply after squid is up |

## File contract

| file | writer | purpose |
|---|---|---|
| `/config/quartzfire/ssl-inspection/ca.key` | qzssl-ca | private key, root:root 0600, **never** exposed |
| `/config/quartzfire/ssl-inspection/ca.crt` / `ca.der` | qzssl-ca | public CA (PEM / DER) |
| `/config/quartzfire/ssl-inspection/no-inspect.txt` | apply | Squid `ssl::server_name` splice list |
| `/etc/squid/conf.d/quartzfire-ssl-inspection.conf` | apply | rendered Squid fragment |
| `/run/quartzfire-ssl/desired.json` | conf-mode owner | committed model (standalone-apply source) |
| `/run/quartzfire-ssl/status.json` | apply/status | squid + icap + ca + apply state for the WebUI |
| `/run/quartzfire-ssl/ca-info.json` | apply/ca | public CA metadata (no key) |
| `/run/quartzfire-ssl/active` | apply | marker: inspection is loaded |
| `/config/quartzfire/ssl-regen-request` | WebUI | "Regenerate" trigger (path unit) |

## WebUI

* Backend (`quartzfire-webui/backend/src/ssl_inspection.rs`):
  `GET /api/ssl-inspection/status`, `GET /api/ssl-inspection/ca.crt`,
  `GET /api/ssl-inspection/ca.der`, `POST /api/ssl-inspection/regenerate`.
  Config CRUD goes through the VyOS API proxy + commit guard, not these
  endpoints.
* Frontend: Services → SSL Inspection (`lib/ssl-inspection.ts`,
  `app/(console)/services/ssl-inspection/`) — enable toggle, CA panel
  (subject/fingerprint/validity/serial, download PEM/DER, Regenerate),
  inspection policy + editable do-not-inspect list, interface scope, status
  indicators, and the inert content-filter section (ICAP fields exposed +
  disabled — the seam the WebBlocker/e2guardian work plugs into).

## Security notes

* CA private key never leaves the box, never in UI/API responses, never logged.
* Bump/splice decisions and cert-generation events log to syslog (`local4`) for
  the SIEM pipeline (the existing ELK/Splunk sources).
* Spliced or blocked pinned/HSTS sites produce a diagnosable event, not a silent
  hang.

## Build / ship / verify

* `quartzfire-ssl-inspection/build-deb.sh` builds the `.deb` (rust:1-bookworm)
  into `packages/`, which `build-vyos-image` bakes into the ISO automatically.
  The `quartzfire` flavor adds `squid-openssl` to its apt list.
* `cargo test` (also run during the deb build): model validation, Squid-fragment
  and nft golden rendering, CA `-noout` text parsing, `squid -v` capability
  parsing, config reading.
* **ICAP seam proof** (`tests/icap-echo/`): a throwaway no-op ICAP echo service +
  `smoke.sh` stand up `squid-openssl` in Docker, drive an HTTPS request through
  the bump, and assert the echo received decrypted plaintext HTTP for both
  REQMOD and RESPMOD — then a fail-closed check with the echo stopped. Proves the
  later filter engine is genuinely a drop-in. Tear down afterwards.
* **On-device acceptance** (deferred to a VyOS box): enable inspection → CA
  generated with the exact subject under /config; a client trusting the CA
  browses HTTPS warning-free with leaf certs from the QuartzFire CA; excluded
  domains are spliced; `http://<box>:4126/` serves PEM+DER+fingerprint reachable
  only from trusted interfaces; commit-confirm rolls a bad config back.
