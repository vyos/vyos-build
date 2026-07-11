# qfappd — Application Control for QuartzFire

Design document, v1 (checkpoint before implementation).
Status: **awaiting review** — nothing below is code yet.

qfappd is an inline DPI application-control daemon for QuartzFire (VyOS
1.5 / Debian 12, nftables-native). It reproduces WatchGuard Fireware's
Application Control: nDPI-based application identification, named
allow/block **actions** built from per-application and per-category
verdicts, applied per firewall rule, with a WatchGuard-style
Actions / Policies / Alerts UI in the QuartzFire WebUI.

---

## 1. Deviations from the original spec (read this first)

These are the points where this design differs from the prompt, either
because you answered a clarifying question or because the spec was
internally inconsistent. Everything else follows the spec as written.

1. **Language: Rust** (your call). The spec's dependency list was
   Go-specific (cgo, `florianl/go-nfqueue`, `ti-mo/conntrack`, Go 1.22,
   golangci-lint); §9 maps each item to its Rust equivalent. Lint gate
   becomes `cargo clippy -- -D warnings` + `cargo fmt --check`.
2. **Named actions + per-rule bindings** (your call: "full per-rule
   actions now"). The single global `policy.json` schema becomes a
   **v2 schema** with named actions (WatchGuard's "Global" in your
   screenshot) and bindings that scope an action to traffic. §5 has the
   schema; §4.3 explains how a flow learns which action applies to it
   (3 action-ID bits in the ct mark, written by the binding's nftables
   rule before the packet is queued). A degenerate policy with one
   action bound to everything reproduces the spec's original global
   behavior exactly.
3. **App-ID field shrinks from 14 to 11 bits** to make room for the
   action-ID field (§4.1). nDPI 4.8 defines ~400 protocols; 11 bits
   (2048) leaves >4× headroom. Layout stays configurable in one place.
4. **`inet` table instead of `ip`.** The spec says hook `ip vyos_filter`
   forward; an NGFW feature that silently ignores IPv6 is a hole, and a
   single `inet qfappd` table covers both families with one ruleset. We
   also do **not** put rules inside `vyos_filter` at all — VyOS
   regenerates that table on every commit and would wipe them. We own a
   separate table with its own forward-hook base chain at
   `priority filter + 10`, so it runs on packets `vyos_filter` already
   accepted, and survives VyOS commits untouched. (§6, verified
   on-target before final wiring.)
5. **`CAP_NET_RAW` in addition to `CAP_NET_ADMIN`** — only because
   `block_mode: reset` requires crafting RST packets to both ends.
   Everything else needs only `CAP_NET_ADMIN`. If you'd rather keep the
   capability set minimal, reset mode can be dropped or made a
   compile-time feature.
6. **`policy.json` is produced by a root apply-helper, not written
   directly by the WebUI backend.** The backend is `DynamicUser` and
   cannot write into qfappd's `RuntimeDirectory`; also `/run` is tmpfs
   so policy must persist elsewhere anyway. This mirrors your IPS flow
   exactly: backend writes desired state to
   `/config/quartzfire/appcontrol.json`, a `.path` unit runs
   `qfappd-apply` which validates and writes `/run/qfappd/policy.json`,
   qfappd hot-reloads via inotify. From qfappd's point of view the spec
   is unchanged: it reads `/run/qfappd/policy.json`, reloads on
   SIGHUP + inotify, keeps last-known-good on invalid input.
7. **nDPI via FFI, not "cgo".** Rust equivalent: a `ndpi-sys` crate
   generated with bindgen at build time against
   `/usr/local/include/ndpi` (nDPI ≥ 4.8 from source, per spec). No
   vendoring, no reimplementation. When headers are absent (this dev
   machine is Windows; builds happen in the WSL docker container), the
   classifier is stubbed behind a trait so everything else builds and
   tests (§10). I am **not** switching to supervising nDPId — FFI looks
   practical in Rust; if that changes mid-implementation I'll stop and
   ask, per your instruction.

Open items I could not verify from this repo and will confirm on-target
during implementation (none block the design): exact VyOS 1.5 chain
names inside `vyos_filter` (we don't depend on them, see §6), whether
the installed nDPI build exposes JA4 (JA3 fallback if not), and `nfq`
crate conntrack-attribute support (fallback path defined in §9).

---

## 2. Architecture overview

```
                    ┌────────────────────────────── QuartzFire WebUI ─────────────────────────────┐
                    │ frontend: Services ▸ Application Control (Actions / Policies / Alerts tabs) │
                    │ backend (axum, unprivileged): appcontrol.rs                                  │
                    └──────┬───────────────────────────────▲──────────────────────▲───────────────┘
             desired state │ /config/quartzfire/           │ gRPC (catalog,       │ alerts: journald live (SSE)
                           │ appcontrol.json               │ policy, stats,       │ + events file history
                           ▼                               │ status) over         │
                    qfappd-apply (root, .path unit)        │ /run/qfappd/qfappd.sock
                           │ validate + render             │
                           ▼                               │
                    /run/qfappd/policy.json ──inotify──► qfappd (Rust daemon, CAP_NET_ADMIN[+RAW])
                                                           │  ▲ 4 worker threads, one per NFQUEUE 100–103
                                                           │  │ packets            ▲ verdicts + ct mark
                                                           ▼  │                    │
    forward path ──► inet vyos_filter (untouched) ──► inet qfappd (ours, prio filter+10)
                                                       ├─ ct mark & BLOCK  → drop          (block fast path)
                                                       ├─ ct mark & CLASSIFIED → accept    (allow fast path)
                                                       └─ per-binding rules:
                                                            match → ct mark set ACTION_ID (masked)
                                                                  → queue 100-103 fanout,bypass
```

Packet lifecycle for a new flow:

1. First packet traverses `vyos_filter` normally (including Suricata
   IPS queueing if the rule uses `action queue` — qfappd's chain runs
   at a later priority, so IPS verdicts happen first).
2. In `inet qfappd`, no classified bit is set, a binding rule matches,
   writes the binding's action ID into ct mark bits 16–18 (masked
   write), and queues the packet to NFQUEUE 100–103 (`fanout` = same
   flow always hits the same queue; `bypass` = fail-open by default).
3. qfappd's worker for that queue feeds the packet to its nDPI flow
   state and verdicts `NF_ACCEPT` (packet must keep flowing during
   classification — mid-classification packets are allowed through;
   this matches WatchGuard behavior and is unavoidable for SNI-based
   identification).
4. When nDPI reaches a final classification — or the per-flow budget
   (default 12 packets / 4 KB payload, both configurable) is exhausted,
   or nDPI says unknown — qfappd looks up the verdict in the action
   named by the flow's action-ID bits:
   - **allow** → write ct mark `classified=1, block=0, appID` (masked),
     verdict `NF_ACCEPT`. Every later packet short-circuits at the
     "classified → accept" rule: the fast path is pure nftables and
     never touches userspace again.
   - **block** → write ct mark `classified=1, block=1, appID`, verdict
     `NF_DROP`. Later packets die at the "block-mark → drop" rule with
     no queue round-trip. If the action's `block_mode` is `reset` and
     the flow is TCP, qfappd also sends RSTs to both endpoints.
   - **unknown / budget exhausted** → apply the action's
     `default_action` (WatchGuard's "when application does not match"),
     mark `classified=1` with appID = 0 (unknown) so the flow stops
     hitting the queue either way.
5. One flat JSON event per decision goes to the event sinks (§7).

---

## 3. Classification engine

- One `ndpi_detection_module_struct` **per worker thread** (nDPI
  detection modules are not shareable across threads without locking;
  per-thread modules are the upstream-recommended pattern). All four
  are initialized identically from the same protocol/category set.
- Flow key: `(family, proto, src ip, src port, dst ip, dst port, vlan)`
  — VLAN ID taken from NFQUEUE metadata when present, 0 otherwise.
  Direction-normalized so both directions map to one entry.
- Because `fanout` hashes per-flow, a given flow only ever appears on
  one queue → each worker owns a private flow table, no cross-thread
  locking on the hot path.
- Per-worker flow table is bounded: entry cap 512k / 4 = 128k per
  worker (config: total cap), idle eviction 2 min for unclassified
  flows (config). Eviction is a coarse timing-wheel sweep piggybacked
  on the packet loop plus a 10 s timer tick, so no flow lingers past
  its deadline even on an idle queue. Classified flows are dropped from
  the table immediately — the ct mark carries all state they need.
- Classification confidence (`ndpi_confidence_t`), SNI
  (`flow->host_server_name`), and JA4 (JA3 fallback) are captured for
  the event record at decision time.
- `ndpi_detection_giveup()` is called when the packet/byte budget is
  reached so nDPI's guessed classification (by port / IP) is still
  usable and reported with its (lower) confidence value.

## 4. ct mark encoding

### 4.1 Bit layout (default; configurable in one place)

Defined once in `ctmark::Layout` (Rust) **and** rendered into the nft
template from the same values (the template is generated with the
layout constants substituted, so nftables and qfappd can never
disagree). Defaults:

```
bit  31       CLASSIFIED   flow has a final app-control verdict
bit  30       BLOCK        verdict was block (drop rule matches this)
bits 29–19    APP_ID       nDPI protocol id (11 bits, 0 = unknown)
bits 18–16    ACTION_ID    which named action governs this flow
                           (0 = app-control not enabled for this flow;
                            1–7 = index into policy actions)
bits 15–0     (untouched)  reserved for other QuartzFire subsystems
```

- **All writes are masked** (`ct mark set (ct mark & ~QF_MASK) | value`
  in nft; `mark & ~mask | bits` via ctnetlink in qfappd), so your
  existing low-16-bit users are never disturbed.
- `Layout { classified_bit, block_bit, app_shift, app_bits, action_shift,
  action_bits }` is loaded from `/etc/qfappd/qfappd.toml`; the codec
  and the template renderer both consume it. Changing it requires
  restarting qfappd and re-rendering the template (documented).
- 3 action-ID bits ⇒ **max 7 concurrently bound named actions**. The
  UI can store any number of actions; only ones referenced by a binding
  consume an ID. If you foresee >7 simultaneously-bound actions, say so
  now and I'll widen the field (each extra bit comes out of APP_ID
  headroom).

### 4.2 Codec

`internal` module `ctmark` — pure functions
`encode(Verdict) -> (value, mask)` / `decode(u32) -> FlowMarkState`,
fully unit-tested including round-trips, mask non-interference with
low bits, and boundary app IDs.

### 4.3 How a flow learns its action

The binding's nftables rule performs the masked
`ct mark set … ACTION_ID` **before** the `queue` statement, so by the
time the first packet reaches qfappd, the conntrack entry already
carries the action ID. qfappd reads it from the packet's conntrack
info (NFQUEUE `CTA` attributes) — no policy-matching logic is
duplicated in userspace, and rebinding a firewall rule to a different
action applies to new flows immediately.

## 5. Policy model

### 5.1 Files and flow

- **Source of truth (persistent):** `/config/quartzfire/appcontrol.json`
  — written by the WebUI backend, survives image upgrades (same
  contract as `ips.json`).
- **Runtime policy:** `/run/qfappd/policy.json` — rendered by
  `qfappd-apply` (root helper triggered by a `.path` unit watching the
  config file), consumed by qfappd. Hot-reload on **SIGHUP and
  inotify** (both, per spec). On boot, `qfappd-apply` runs once before
  qfappd starts (unit ordering) so the policy exists; `/config` mounts
  late on VyOS (`vyos-router` is `Type=simple`), so the helper polls
  for it rather than relying on unit ordering alone.
- **Validation:** schema + referential checks (every binding references
  an existing action; app names checked against the loaded nDPI catalog
  with unknown names logged as warnings but tolerated — signature
  updates may add/remove names). On any validation failure qfappd keeps
  the **last-known-good** policy, logs a structured error, and exposes
  the failure in `GetStatus` (the UI surfaces it). It never falls back
  to allow-everything because of a bad push.

### 5.2 Schema (v2 — supersedes the v1 single-policy schema)

```json
{
  "version": 2,
  "actions": {
    "Global": {
      "default_action": "allow",
      "block_mode": "drop",
      "categories":   { "Adult": "block", "Artificial Intelligence": "allow" },
      "applications": { "PornHub": "block", "ChatGPT": "block", "BitTorrent": "block" }
    }
  },
  "bindings": [
    {
      "id": 1,
      "action": "Global",
      "description": "LAN→WAN (fw rule 10)",
      "match": {
        "iifname": ["eth1"], "oifname": ["eth0"],
        "saddr": [], "daddr": [],
        "l4": []
      }
    }
  ]
}
```

- `default_action`: `allow | block` — WatchGuard's "when application
  does not match", also applied when classification never completes.
- `block_mode`: `drop | reset` (per action; `reset` = RST to both ends
  for TCP, drop otherwise).
- Precedence within an action: **application > category > default**
  (spec §policy). Category names map to `ndpi_protocol_category_t`
  display names; application names to nDPI protocol short names.
- `bindings[].id` maps 1:1 to ACTION_ID mark values (assigned 1..7 per
  distinct bound action, deterministically). `match` fields become the
  binding rule's nft match; empty array = wildcard. The WebUI owns
  translating a firewall rule into `match` (it already owns the rule
  definitions per the Aliases/Policies/Rules model, and regenerates
  bindings whenever a rule changes).
- Since bindings alter nftables rules, qfappd re-renders its **own**
  binding chain via `nft -f` (atomic, single transaction) on every
  successful policy load. Verdict-table changes alone don't touch
  nftables. Already-classified flows keep their existing verdict
  (ct mark survives); only new flows see the new policy — documented,
  and matches WatchGuard semantics.

### 5.3 Policy engine (pure Rust, first thing built)

`policy` module: parse → validate → compile to a dense
`Vec<Action>` where each `Action` is a `verdict[app_id] -> Allow|Block`
lookup table precomputed from app/category/default precedence (O(1) on
the classification path, no string lookups per flow). Unit tests:
precedence (app beats category beats default), unknown-name tolerance,
invalid-policy rollback to last-known-good, binding/action referential
integrity, action-ID assignment stability.

## 6. nftables integration

`templates/qfappd.nft` (rendered with layout constants + config
variables; `{{…}}` shown here for readability):

```nft
table inet qfappd {
    chain forward {
        type filter hook forward priority filter + 10; policy accept;

        # fast paths — pure nftables, no userspace
        ct mark & {{CLASSIFIED|BLOCK}} == {{CLASSIFIED|BLOCK}} counter drop
        ct mark & {{CLASSIFIED}}       == {{CLASSIFIED}}       counter accept

        jump qf_bindings
    }

    chain qf_bindings {
        # one rule per binding, regenerated atomically on policy load, e.g.:
        # iifname "eth1" oifname "eth0" \
        #   ct mark set (ct mark & ~{{ACTION_MASK}}) | {{action_id << 16}} \
        #   counter queue flags fanout,bypass to 100-103
    }
}
```

- **Why not inside `vyos_filter`:** VyOS regenerates that table on
  every commit; foreign rules are wiped. A separate table with its own
  forward-hook base chain at `priority filter + 10` is commit-proof and
  ordered after VyOS filtering (and after Suricata IPS, which rides
  `action queue` rules inside `vyos_filter` at plain filter priority).
  Only accepted packets reach us; a packet VyOS drops never gets
  classified — correct, since it never becomes a flow.
- The claimed VyOS 1.5 layout (`table ip vyos_filter`, forward base
  chain at priority filter) will be verified on-target with
  `nft list ruleset` during integration; because we hook independently,
  a naming difference costs a docs update, not a design change.
- `bypass` flag = kernel fail-open when the queue is full or qfappd is
  down (spec default). Config `fail_mode = "closed"` renders the rules
  without `bypass` (and the base-chain policy still accepts
  non-matching traffic — fail-closed applies only to traffic selected
  for app control).
- **Graceful shutdown:** on SIGTERM qfappd (a) `nft delete table inet
  qfappd` → instant fail-open, (b) drains and verdicts `NF_ACCEPT` on
  all queued packets, (c) exits. Startup re-creates the table from the
  template + current policy.
- Interface/zone scoping lives entirely in the binding rules; the
  intended `set firewall app-control …` VyOS node design goes in
  `docs/vyos-integration.md` (no VyOS Python config-mode scripts in
  this pass, per spec).

## 7. Event logging

One flat JSON object per flow decision, loosely EVE-shaped, schema
frozen and documented in `docs/event-schema.md`:

```json
{
  "timestamp": "2026-07-11T14:03:22.117Z",
  "event_type": "app_control",
  "src_ip": "10.0.1.23", "src_port": 51544,
  "dest_ip": "104.16.1.1", "dest_port": 443,
  "proto": "TCP", "vlan": 0,
  "app": "ChatGPT", "app_id": 244, "category": "Artificial Intelligence",
  "action": "block", "action_name": "Global", "block_mode": "drop",
  "confidence": "dpi", "default_applied": false,
  "sni": "chatgpt.com", "ja4": "t13d1516h2_8daaf6152771_02713d6af862",
  "bytes": 3908, "pkts": 7
}
```

Sinks (each independently enable-able in `qfappd.toml`):
1. **UNIX datagram socket** `/run/qfappd/events.sock` (spec; fire-and-
   forget, non-blocking, drops counted in `GetStatus`).
2. **File** `/var/log/qfappd/events.json` (spec; line-delimited,
   logrotate config shipped in the deb).
3. **journald** with identifier `qfappd` — this is what the WebUI
   Alerts tab streams live via `journalctl -t qfappd -f` SSE, the exact
   transport your IPS alerts and traffic monitor already use; the file
   provides history across reboots (journal is volatile on VyOS).

Sink 3 is an addition over the spec, added for UI parity with IPS; the
ELK/Splunk pipeline should keep consuming 1 or 2.

## 8. gRPC API

`proto/qfappd/v1/qfappd.proto`, served with tonic over
`/run/qfappd/qfappd.sock` (mode 0660, group `qfappd`; the WebUI unit
gets `SupplementaryGroups=qfappd` so its `DynamicUser` can connect):

- `GetCatalog` — full nDPI app list with categories, read from the
  loaded libndpi at runtime (tracks installed signature version), plus
  nDPI version + `signature_version` string. Same data as
  `qfappd catalog --json` (the CLI subcommand loads libndpi directly so
  it works even when the daemon is stopped).
- `GetPolicy` — the currently-active compiled policy + whether the last
  push was rejected (and why).
- `GetFlowStats` — per-app byte/packet/flow counters and top-N apps
  (in-memory ring aggregation; reset on restart).
- `GetStatus` — queue depth/drops per queue, classification rate,
  unknown %, flow-table occupancy, event-sink drop counters, libndpi
  version, policy generation + last-error.

`qfagent` (your cloud controller agent) consumes the same socket later.

## 9. Rust dependency map (Go spec → Rust)

| Spec (Go) | Rust choice | Notes |
|---|---|---|
| cgo bindings to libndpi | own `ndpi-sys` crate: bindgen at build time against `/usr/local/include/ndpi`, link `-lndpi` from `/usr/local/lib` | feature `ndpi`; stub trait impl without it (§10) |
| `florianl/go-nfqueue` | `nfq` crate (pure-Rust nfnetlink) | needs conntrack attrs (`NFQA_CT`) to read ACTION_ID; if the crate can't expose them, fallback is direct FFI to `libnetfilter_queue` (Debian 12 ships it) — decided at step 4, flagged to you either way |
| `ti-mo/conntrack` / `vishvananda/netlink` | FFI to `libnetfilter_conntrack` (`nfct_*`) for masked ct-mark updates | stable C API, in Debian 12; a hand-rolled ctnetlink path via `neli` is the no-C-deps fallback |
| gRPC | `tonic` + `prost`, tokio `UnixListener` | |
| inotify | `notify` crate; SIGHUP via `tokio::signal` | |
| sd_notify / watchdog | `sd-notify` crate (`Type=notify`, `WatchdogSec`) | |
| JSON | `serde` / `serde_json` | |
| golangci-lint | `cargo clippy -D warnings`, `cargo fmt --check` | CI gate |

Threading model: 4 dedicated OS threads (one per queue, each owning its
nDPI module + flow table, synchronous packet loop — lowest latency,
zero async overhead on the hot path) + a tokio runtime for gRPC,
policy reload, event sinks, and stats, connected by bounded channels.

## 10. Repository layout & build

```
qfappd/                      (this repo, sibling of quartzfire-webui/)
├── Cargo.toml               workspace
├── crates/
│   ├── qfappd/              main binary
│   │   └── src/{main.rs, policy/, ctmark/, classify/, nfq/, bindings/,
│   │            api/, eventlog/, stats/, config.rs}
│   ├── ndpi-sys/            bindgen FFI (feature-gated)
│   └── qfappd-proto/        tonic-build output
├── proto/qfappd/v1/qfappd.proto
├── templates/qfappd.nft
├── etc/qfappd.toml          default config (queues, budgets, layout,
│                            fail mode, eviction, sinks)
├── debian/                  → qfappd_*.deb (binary, unit, apply helper,
│                            .path unit, logrotate, default config)
├── systemd/{qfappd.service, quartzfire-appcontrol.path, …}
├── scripts/{qfappd-apply, loadtest/}
├── docs/{design.md, vyos-integration.md, event-schema.md}
├── tests/integration/       netns + veth harness (make integration-test)
└── Makefile
```

`qfappd.service` sandboxing: `Type=notify`, `WatchdogSec=15`,
`CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW` (+`AmbientCapabilities`),
`ProtectSystem=strict`, `RuntimeDirectory=qfappd`,
`LogsDirectory=qfappd`, `NoNewPrivileges=yes`, dedicated `qfappd`
user/group.

**Build environments.** Dev machine is Windows; qfappd is Linux-only at
runtime. Pure-logic crates/tests (policy, ctmark, eventlog schema)
compile anywhere; anything touching netlink/nDPI builds in the WSL
docker vyos-build container (where the deb is produced, like the WebUI
deb). Integration tests and load tests require Linux root + libndpi —
run in the container or on-target; anything I cannot execute locally is
explicitly marked "needs on-target validation" in its test file and in
the final report, with the exact commands to run.

Load test: Rust flow generator (bursts of unique 5-tuples with realistic
TLS ClientHello payloads through a veth pair into the netns harness)
targeting ≥ 50k new flows/min on 4 cores with zero queue drops;
`trafgen` config included as an alternative. Measured numbers reported
from whatever the WSL container can support, with the caveat that
authoritative numbers need the appliance.

## 11. WebUI (built in parallel, against mocks until the daemon lands)

New page `app/(console)/services/application-control/` following your
existing page/FormModal conventions, plus `appcontrol.rs` in the
backend mirroring `ips.rs` (desired-state file + status read-back +
SSE alerts). Three tabs, WatchGuard-equivalent:

- **Actions** — table of named actions (Action / Applications summary /
  Policies-using-it columns, Add/Clone/Edit/Remove — the right-hand
  dialog in your screenshot). The editor modal is the left-hand dialog:
  category-grouped application tree from `GetCatalog` (proxied by the
  backend; mocked from a checked-in `catalog.fixture.json` until the
  daemon is up), per-app Allow/Block, "Select by Category…", search,
  and the "When application does not match" allow/block dropdown +
  drop-vs-reset block mode. Signature/nDPI version shown at the bottom
  like WatchGuard's "Signature version" line.
- **Policies** — your firewall forward rules (same data layer as
  Firewall ▸ Policies) with an Application Control column: None or a
  named action per rule. Selecting an action creates/updates the
  binding in `appcontrol.json` (backend derives the nft `match` from
  the rule's definition and regenerates bindings whenever the rule
  changes). Enforces the ≤7-bound-actions limit with a clear error.
- **Alerts** — one row per block event: live via SSE from
  `journalctl -t qfappd` filtered to `"action":"block"`, history from
  `/var/log/qfappd/events.json`; columns time / src / dst / app /
  category / action name / mode, matching the IPS alerts view's
  interaction patterns.

## 12. Implementation order (per your process, adjusted for parallel UI)

Daemon track (tests green before each step advances):
1. `policy` engine (pure Rust, fully tested) — includes v2 schema
2. `ctmark` codec
3. `ndpi-sys` + classify wrapper, minimal classify test (stubbed if
   headers absent locally; real test in container)
4. NFQUEUE loop (4 workers, budgets, flow table + eviction tests)
5. conntrack mark offload + binding-chain rendering
6. gRPC API + `catalog --json`
7. event logging (3 sinks) + schema doc
8. nft template + systemd units + debian packaging + `qfappd-apply`
9. integration tests (netns + veth, real curl/DNS classification,
   allow/block assertions) + load test + measured numbers

UI track (can start immediately): catalog fixture + data layer mocks →
Actions tab + editor modal → Policies tab → backend `appcontrol.rs` →
Alerts tab → swap mocks for live backend endpoints after daemon step 6.

---

---

## Implementation notes (changes made during build, post-approval)

Two things changed from the design above once the code met the target
environment. Both were validated by a full compile against libndpi 4.8 in the
build container.

1. **Flow offload no longer uses ctnetlink / libnetfilter_conntrack.** The
   Debian 12 `libnetfilter_conntrack` exposes `ATTR_MARK` but **not**
   `ATTR_MARK_MASK`, so a masked ct-mark write through that library isn't
   possible without hand-rolling raw ctnetlink or a racy read-modify-write.
   Instead, qfappd sets the **packet** mark on its NFQUEUE **ACCEPT** verdict
   (always ACCEPT — even for blocks), and two nftables rules in the forward
   chain do the rest, in-kernel and atomically:
   - a *persist* rule jumps verdict packets (CLASSIFIED bit set) to a
     `qf_persist` chain that copies the qfappd-owned mark bits from the packet
     mark into the ct mark (other subsystems' low bits survive). The copy is
     decomposed into one constant-mask clear plus one conditional OR per owned
     bit, because the nftables shipped on the target (1.0.6, Debian bookworm)
     rejects bitwise ops with a non-constant right-hand side — a single
     `ct mark set ct mark & !QF | meta mark & QF` fails to parse until
     nftables 1.1 (plus kernel ≥ 6.10), and it kept qfappd from booting at
     all until decomposed;
   - a *block* rule drops the reinjected verdict packet when its mark carries
     the BLOCK bit — so a blocked flow's first classified packet is already
     dropped, and every later packet dies at the top-of-chain ct-mark fast
     path.
   This keeps the write masked and race-free, drops the C-library dependency,
   and means the queue never needs `NFQA_CT`. `crates/qfappd/src/ctnl.rs` and
   the `nfct` FFI were removed; the ct-mark **codec** and layout are unchanged.
   The mark bit layout, encode/decode, and precedence logic are all as
   designed.

2. **The `qfappd-sys` crate now binds only libndpi** (bindgen against
   `/usr/local/include/ndpi`). The `nfct` feature is gone with the ctnetlink
   path. `nfq` is pure-Rust, so no `libnetfilter_queue`/`-conntrack` dev
   packages are needed to build — only libndpi + protoc + clang.

Everything else — policy schema v2, named actions, per-rule bindings via the
ACTION_ID mark field, the 7-bound-actions ceiling, the `inet qfappd` table at
`priority filter + 10`, `CAP_NET_ADMIN`+`CAP_NET_RAW`, the gRPC API, the three
event sinks, and the WatchGuard-style Actions/Policies/Alerts UI — is as
described above.

---

**Checkpoint questions for you** (answer any/all, or just say "proceed"):

1. Is the 7-simultaneously-bound-actions ceiling (3 ACTION_ID bits)
   acceptable, or should I widen it at the cost of APP_ID headroom?
2. OK with the extra journald event sink and `CAP_NET_RAW` for reset
   mode?
3. `inet` (dual-stack) table instead of the spec's `ip` — confirm.
4. Binding `match` derived from firewall rules by the WebUI backend
   (criteria duplication, regenerated on rule edits) — this is the main
   structural consequence of "full per-rule actions now"; confirm
   you're happy with it versus the alternative (per-binding queue-number
   ranges, which avoids mark bits but burns 4 queues per action).
