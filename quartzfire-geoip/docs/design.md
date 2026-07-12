# QuartzFire Geolocation (quartzfire-geoip)

Country-based allow/block filtering attached to firewall rules — the
equivalent of WatchGuard Fireware's Geolocation service — plus the database
update machinery. Two concepts, mirroring the WebUI's tabs:

* **Action** — a named, reusable country policy: `block-listed` (allow all
  countries except those listed) or `allow-listed` (block all except those
  listed), a country list, per-action handling of IPs *not in the database*
  (`unknown-ip allow|block`, default allow), and an optional log flag
  (kernel-log prefix `[GEO-<action>]`).
* **Policy** — binds an action to one firewall rule (`ruleset` forward /
  input / output + rule number, matching how the WebUI models
  `firewall ipv4 <chain> filter` rules), with a `direction` (source /
  destination / both) and an enable flag.

## Database: IPFire libloc — not MaxMind

The GeoIP source is the IPFire location database (location.ipfire.org),
queried by linking the libloc C library directly (through the small
`src/shim.c` wrapper, compiled against the real headers at package build so
API drift fails the build, never the runtime); updates go through the vendor
`location` CLI. The database is free, cryptographically signed, updated
regularly, and its license permits
shipping it inside the appliance image and the signed-ISO update pipeline.
**MaxMind GeoLite2 is deliberately not used anywhere** — its EULA's
redistribution restrictions conflict with a commercial appliance image.

* Database file: `/var/lib/location/database.db` (the location package's
  default path).
* Updates: `location update` downloads over HTTPS, **verifies the signature,
  and only then atomically replaces the file** — a failed or tampered
  download never touches the installed database. `geoip-update` re-verifies
  against the vendor key (`/usr/share/location/signing-key.pem`) afterwards
  and refuses to regenerate sets from a database that fails.
* Fail-closed: any update failure leaves the currently loaded sets untouched
  — stale-but-valid data keeps enforcing.
* First boot: no database until the first successful update (the timer runs
  ~10 minutes after boot). Committing geolocation config in that window is
  accepted; enforcement degrades **open** with the error surfaced in
  status.json and the WebUI.

## Configuration: real VyOS config nodes

```
set service geolocation action <name> mode <block-listed|allow-listed>
set service geolocation action <name> country <CC>          # multi
set service geolocation action <name> unknown-ip <allow|block>
set service geolocation action <name> log
set service geolocation action <name> description <text>

set service geolocation policy <n> action <name>
set service geolocation policy <n> ruleset <forward|input|output>
set service geolocation policy <n> rule <number>
set service geolocation policy <n> direction <source|destination|both>
set service geolocation policy <n> disable
```

Shipped as hand-written cstore templates
(`/opt/vyatta/share/vyatta-cfg/templates/service/geolocation/**/node.def`)
owned by `/usr/libexec/vyos/conf_mode/service_geolocation` (priority 990,
after the firewall) — a symlink to the qzgeo binary, whose `commit` mode
reads the session config through `cli-shell-api` (exists / listNodes /
returnValue(s) / existsEffective), the same primitives vyos-1x's Python
Config wraps. Because vyos-1x is consumed as a prebuilt .deb in this repo,
this is the supported way for a third-party package to add config nodes;
only those primitives are used, deliberately — vyos-1x's higher-level config
dictionaries consult its XML reference cache, which knows nothing about
these nodes.

Commit semantics:

* verify() blocks the commit for: invalid/duplicate country codes (checked
  against the database when present, format-only otherwise), an action with
  zero countries, a missing mode, a policy referencing an undefined action,
  and **deleting an action that policies still reference** (explicit
  "cannot delete … still used by policy N" error).
* A policy whose target rule is missing or unreplicable (see below) does
  **not** fail the commit — the firewall rule can be deleted in a later
  commit that never runs this script, and the full config must still load at
  boot. The policy is skipped, warned about on the commit output, and
  surfaced as an error state in status.json / the WebUI.
* Because it is ordinary config, geolocation participates in commit,
  commit-confirm, rollback, and config save/load. The WebUI edits it through
  the VyOS HTTP API under the commit-confirm guard like the firewall pages.

## Enforcement: nftables sets in a dedicated table

Everything lives in `table inet qz_geo` — per the QuartzFire coexistence
rule (see qfappd/docs/vyos-integration.md), nothing may be injected into
`vyos_filter`, which VyOS regenerates wholesale on every commit.

Naming conventions:

| object | name |
|---|---|
| table | `inet qz_geo` |
| per-country sets | `geo4_<cc>` / `geo6_<cc>` (e.g. `geo4_cn`), `type ipv4_addr/ipv6_addr; flags interval; auto-merge` |
| whole-database sets | `geo4_known` / `geo6_known` (only when an action's unknown-IP handling needs them) |
| verdict chains | `act_<action>_src` / `act_<action>_dst` |
| hook chains | `geo_forward` / `geo_input` / `geo_output`, `type filter hook <h> priority filter - 10; policy accept` |
| drop counters | named counter `geo_<action>` |
| policy jump rules | anonymous counter + `comment "qz-geo-p<id>"` |

* Only countries referenced by an **enabled** policy are materialized —
  never all ~250. Set elements are pre-collapsed (adjacent/overlapping CIDRs
  merged) and cached per database version under
  `/var/cache/quartzfire-geoip/<version>/`.
* Hook chains run at `filter - 10`, **before** `vyos_filter`, so a geo block
  wins over the target rule's accept. Each enabled policy contributes
  `ct state new <replicated rule match> counter jump act_<action>_<dir>` —
  one set lookup per new connection, nothing per-packet, nothing in
  userspace.
* The replicated match is derived from the target rule's own criteria
  (interfaces, addresses, address/network groups flattened to members,
  port-groups, protocol). Rules matching **domain (FQDN) groups cannot be
  replicated** and are rejected with a clear error. Group edits are
  re-synced by the resync path unit (below).
* Unknown-IP handling uses the synthetic `known` sets (the collapsed union
  of every network in the database): `block-listed + unknown block` drops
  anything not in `known` after the listed countries; `allow-listed +
  unknown allow` returns anything not in `known` before the final drop. The
  other two combinations fall out of the mode's defaults.
* **Atomicity**: a full apply is one `nft -f` transaction using the
  `add table` + `delete table` + full-definition idiom; database refreshes
  use a sets-only transaction (declare + `flush set` + `add element`) that
  never touches chains or counters. There is never a window where a hook
  chain exists without its sets, or where sets are half-filled. Full
  re-renders re-seed the named counters with their live values so hit
  counts survive.

## Processes and units

Everything is one Rust multi-call binary, `/usr/libexec/quartzfire/qzgeo`;
the `geoip-*` helper names and the conf-mode owner are symlinks dispatched
on argv[0] (src/main.rs), so every referencing path is stable.

| unit | role |
|---|---|
| (vyos commit) | `service_geolocation` (→ qzgeo commit) renders + loads the ruleset synchronously |
| `quartzfire-geoip-update.service` + `.timer` | `location update` (signed, atomic) + set refresh; 10 min after boot, then daily with jitter |
| `quartzfire-geoip-update-request.path` | WebUI "Update now": watches `/config/quartzfire/geoip-update-request` |
| `quartzfire-geoip-resync.path` + `.service` | watches `/run/nftables.conf` (rewritten on every firewall commit) and re-runs `geoip-apply` so group-membership drift and deleted target rules converge |
| `quartzfire-geoip-counters.service` + `.timer` | dumps per-action / per-policy counters every minute while the table is loaded |

`geoip-apply` (standalone) only ever works from the last committed snapshot
(`desired.json`) — with no snapshot it is a no-op, so racing the boot-time
config load can never tear down enforcement the commit is about to install.
The package postinst disables the location package's own `location-update`
timer so there is exactly one updater.

## File contract (`/run/quartzfire-geoip/`)

| file | writer | purpose |
|---|---|---|
| `desired.json` | conf-mode script | committed model + resolved matches |
| `status.json` | apply/update helpers | `db` {present, version, signature_ok}, `update` {time, ok, message, schedule}, `apply` {time, ok, error}, `policy_errors`, `set_counts`, `active` |
| `countries.json` | geoip-update | selectable country list for the WebUI/CLI |
| `counters.json` | geoip-counters | per-action drops, per-policy checks |
| `active` | geoip-apply | marker: table loaded (gates the counters timer) |
| `last.nft` | geoip-apply | last applied ruleset (skips no-op re-renders) |

## WebUI

* Backend (`quartzfire-webui/backend/src/geolocation.rs`):
  `GET /api/geolocation/status`, `GET /api/geolocation/countries`,
  `POST /api/geolocation/update` (bumps the trigger file),
  `GET /api/geolocation/lookup?ip=…` (via the unprivileged `geoip-lookup`
  helper). Action/policy CRUD goes through the VyOS API proxy + commit
  guard, not these endpoints.
* Frontend: Services → Geolocation (`lib/geolocation.ts`,
  `app/(console)/services/geolocation/`) — Actions and Policies tabs, the
  database status card with Update-now and the IP lookup utility.

## Build / ship

* `quartzfire-geoip/build-deb.sh` builds the .deb (rust:1-bookworm +
  libloc-dev) into `packages/`, which `build-vyos-image` bakes into the ISO
  automatically. The deb is compiled with the `libloc` cargo feature; local
  development builds without it (database access then reports unavailable),
  so `cargo test` runs anywhere.
* The `quartzfire` flavor pulls `location` (the vendor updater CLI) from the
  Debian mirror (data/build-flavors/quartzfire.toml); libloc1 arrives as a
  shared-library dependency. If the mirror names these packages differently,
  adjust the flavor list and debian/control.
* Tests: `cargo test` (also run during the deb build) — set generation
  (interval merging + minimal CIDR cover, v4/v6 split), model validation,
  match replication, and a fixture-database pipeline test asserting the
  rendered ruleset.
