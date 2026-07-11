# qfappd ↔ VyOS integration

This document describes the intended `set firewall app-control ...` VyOS
config-node design. **No VyOS Python config-mode scripts are written in this
pass** (per the project spec); this is the contract the future config layer
implements, and it explains how qfappd coexists with the VyOS-generated
nftables ruleset.

## How qfappd coexists with VyOS nftables

VyOS renders its firewall into `table ip vyos_filter` (and `ip6
vyos_filter`) and **regenerates that table on every `commit`**. Any rule an
external daemon injects there is silently wiped on the next commit.

qfappd therefore does **not** touch `vyos_filter`. It owns a separate table:

```
table inet qfappd {
    chain forward         { type filter hook forward priority filter + 10; ... }
    chain forward_verdict { type filter hook forward priority filter + 20; ... }
    chain qf_bindings { ... }
    chain qf_persist  { ... }
}
```

Consequences:

- **Commit-proof:** VyOS commits never see or clear our table.
- **Ordering:** base-chain priority `filter + 10` runs *after* the VyOS filter
  (priority `filter`), so only packets VyOS already accepted are classified,
  and *after* Suricata IPS (which rides `action queue` rules inside
  `vyos_filter`), so IPS accept/drop verdicts happen first.
- **Verification:** confirm the live layout on a target with `nft list ruleset`
  before shipping. If a VyOS version renames chains or shifts priorities, only
  this coexistence note needs revisiting — qfappd's own table is independent.

The ct-mark low 16 bits are left untouched — the persist rule copies only the
qfappd-owned bits (16–31 by default) from the packet mark into the ct mark with
a masked `ct mark set`, so VyOS/other subsystems using the connmark are
unaffected. Confirm no collision with the QuartzFire mark map for bits 16–31
before enabling.

Note: qfappd does **not** use libnetfilter_conntrack/ctnetlink to write the
mark. It sets the packet mark on its NFQUEUE ACCEPT verdict; nftables persists
that into the ct mark and drops blocked flows, all in-kernel. This keeps the
write masked and atomic and removes a C-library dependency.

The persist and block rules live in a **second base chain**
(`forward_verdict`, priority `filter + 20`), not after the queue jump in
`forward`: an NF_ACCEPT verdict from NFQUEUE resumes packet traversal at the
*next forward hook*, skipping the rest of the base chain that queued the
packet, so enforcement rules placed there would never run for verdict packets.

## Proposed config nodes

```
set firewall app-control action <name> default-action <allow|block>
set firewall app-control action <name> block-mode <drop|reset>
set firewall app-control action <name> category <nDPI-category> <allow|block>
set firewall app-control action <name> application <nDPI-app> <allow|block>

set firewall ipv4 forward filter rule <n> application-control action <name>
```

- `firewall app-control action <name> ...` builds the named actions
  (WatchGuard's "Application Control Action", e.g. `Global`).
- Attaching `application-control action <name>` to a forward **filter rule**
  creates a *binding*: the config layer derives the binding's `match`
  (iifname/oifname/saddr/daddr/l4) from that firewall rule's own criteria and
  emits it into `appcontrol.json`.

### Rendering to qfappd

The config-mode script (future work) writes the desired state to
`/config/quartzfire/appcontrol.json` in the schema qfappd consumes
(`crates/qfappd-core/src/policy.rs`, schema v2):

```json
{
  "version": 2,
  "actions": {
    "Global": {
      "default_action": "allow",
      "block_mode": "drop",
      "categories": { "Adult": "block" },
      "applications": { "ChatGPT": "block", "BitTorrent": "block" }
    }
  },
  "bindings": [
    { "id": 10, "action": "Global",
      "description": "fw ipv4 forward filter rule 10",
      "match": { "iifname": ["eth1"], "oifname": ["eth0"],
                 "saddr": ["10.0.0.0/8"], "daddr": [], "l4": [] } }
  ]
}
```

The rest is automatic:

1. `quartzfire-appcontrol.path` sees the file change.
2. `qfappd-apply` (root) validates it with `qfappd check-policy` and, on
   success, publishes `/run/qfappd/policy.json` and SIGHUPs qfappd. A file
   that fails validation is refused; qfappd keeps the last-known-good policy.
3. qfappd recompiles the policy and atomically regenerates its `qf_bindings`
   chain via `nft -f`.

### Binding limits

The ct-mark ACTION_ID field is 3 bits by default → **at most 7 distinct
actions may be bound at once** (an action bound to N rules still costs one id).
Exceeding this is a validation error surfaced by `qfappd check-policy` and in
`GetStatus.policy_last_error`. Widen `[mark].action_bits` in `qfappd.toml`
(at the cost of APP_ID headroom) to raise the ceiling; the nft template is
rendered from the same layout, so no manual rule edits are needed.

## WebUI path (implemented now)

Until the config-node layer exists, the QuartzFire WebUI writes
`/config/quartzfire/appcontrol.json` directly (backend `appcontrol.rs`,
Application Control page). The apply pipeline above is identical regardless of
who authors the file.
