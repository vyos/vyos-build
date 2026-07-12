//! Render the geolocation nftables ruleset.
//!
//! Everything lives in a dedicated table so VyOS commits (which regenerate
//! `vyos_filter` wholesale) can never disturb it:
//!
//!     table inet qz_geo {
//!         counter geo_<action> { ... }              # blocked packets/bytes
//!         set geo4_<cc> { type ipv4_addr; flags interval; auto-merge; ... }
//!         set geo6_<cc> { type ipv6_addr; flags interval; auto-merge; ... }
//!         set geo{4,6}_known { ... }                # union of the whole DB,
//!                                                   # only when unknown-IP
//!                                                   # handling needs it
//!         chain act_<action>_src { ... }            # per-action verdicts
//!         chain act_<action>_dst { ... }
//!         chain geo_forward { type filter hook forward priority filter - 10; ... }
//!         chain geo_input   { ... hook input ... }
//!         chain geo_output  { ... hook output ... }
//!     }
//!
//! The hook chains run at priority `filter - 10`, BEFORE vyos_filter, so a
//! geo block wins over the target rule's accept. Each enabled policy
//! contributes one `ct state new <replicated rule match> counter jump
//! act_<action>_<dir>` rule — one set lookup per connection, nothing
//! per-packet, nothing in userspace.
//!
//! Apply is always a single `nft -f` transaction:
//!   * full replace: `add table` + `delete table` + full definition — atomic,
//!     with counter values re-seeded so hit counts survive re-renders;
//!   * sets-only reload (database update): declare + `flush set` +
//!     `add element` per set — atomic and counter-preserving; there is never
//!     a window where a hook chain exists without its sets.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::model::{action_needs_known, in_use, Action, Model};

pub const TABLE_FAMILY: &str = "inet";
pub const TABLE_NAME: &str = "qz_geo";
pub const TABLE: &str = "inet qz_geo";
pub const HOOK_PRIORITY: &str = "filter - 10";
pub const KNOWN: &str = "known";

pub const HEADER: &str = "#!/usr/sbin/nft -f\n\
# Managed by QuartzFire geolocation (geoip-apply) — do not edit;\n\
# regenerated on every commit, database update, and firewall change.\n";

pub fn hook_chain(ruleset: &str) -> &'static str {
    match ruleset {
        "forward" => "geo_forward",
        "input" => "geo_input",
        _ => "geo_output",
    }
}

/// geo4_cn / geo6_cn (cc may also be the synthetic "known").
pub fn set_name(cc: &str, family: u8) -> String {
    format!("geo{family}_{}", cc.to_ascii_lowercase())
}

pub fn counter_name(action_name: &str) -> String {
    format!("geo_{action_name}")
}

pub fn chain_name(action_name: &str, direction: &str) -> String {
    let suffix = if direction == "source" { "src" } else { "dst" };
    format!("act_{action_name}_{suffix}")
}

// ── interval collapse ─────────────────────────────────────────────────────────

/// Parse a strict CIDR (host bits must be zero, mirroring Python's
/// ipaddress strict mode) of one family into an inclusive address range.
/// A bare address is a full-length prefix. None = foreign family/malformed.
fn parse_strict(entry: &str, family: u8) -> Option<(u128, u128)> {
    let total_bits: u32 = if family == 4 { 32 } else { 128 };
    let (addr_s, len) = match entry.split_once('/') {
        Some((a, l)) => (a, l.parse::<u32>().ok()?),
        None => (entry, total_bits),
    };
    if len > total_bits {
        return None;
    }
    let addr: u128 = if family == 4 {
        u32::from(addr_s.parse::<Ipv4Addr>().ok()?) as u128
    } else {
        u128::from(addr_s.parse::<Ipv6Addr>().ok()?)
    };
    let host_bits = total_bits - len;
    let size_minus1 = if host_bits == 0 { 0 } else { (1u128 << host_bits) - 1 };
    if addr & size_minus1 != 0 {
        return None; // host bits set — not a valid network address
    }
    Some((addr, addr + size_minus1))
}

fn format_cidr(start: u128, prefix: u32, family: u8) -> String {
    if family == 4 {
        format!("{}/{prefix}", Ipv4Addr::from(start as u32))
    } else {
        format!("{}/{prefix}", Ipv6Addr::from(start))
    }
}

/// Emit the minimal CIDR cover of one inclusive range.
fn cover(mut start: u128, end: u128, family: u8, out: &mut Vec<String>) {
    let total_bits: u32 = if family == 4 { 32 } else { 128 };
    loop {
        // Largest block allowed by alignment, capped by what still fits.
        let align = start.trailing_zeros().min(total_bits);
        let span_minus1 = end - start;
        let fit = if span_minus1 == u128::MAX {
            128
        } else {
            (span_minus1 + 1).ilog2()
        };
        let k = align.min(fit).min(total_bits);
        out.push(format_cidr(start, total_bits - k, family));
        let step = if k == 128 { return } else { 1u128 << k };
        match start.checked_add(step) {
            Some(next) if next <= end => start = next,
            _ => return,
        }
    }
}

/// Merge adjacent/overlapping CIDRs of one family into the minimal interval
/// list (nft's auto-merge would also cope, but pre-collapsing keeps the
/// rendered files and kernel sets small). Returns sorted CIDR strings.
pub fn collapse(elements: &[String], family: u8) -> Vec<String> {
    let mut ranges: Vec<(u128, u128)> = elements
        .iter()
        .filter_map(|e| parse_strict(e, family))
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(u128, u128)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            // Extend when overlapping or exactly adjacent.
            Some((_, last_end)) if *last_end >= end => {}
            Some((_, last_end)) if start <= last_end.saturating_add(1) => *last_end = end,
            _ => merged.push((start, end)),
        }
    }
    let mut out = Vec::new();
    for (start, end) in merged {
        cover(start, end, family, &mut out);
    }
    out
}

/// Partition mixed CIDR strings into (v4, v6) lists (uncollapsed).
#[cfg(test)]
pub fn split_families(elements: &[String]) -> (Vec<String>, Vec<String>) {
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();
    for e in elements {
        if parse_strict(e, 4).is_some() {
            v4.push(e.clone());
        } else if parse_strict(e, 6).is_some() {
            v6.push(e.clone());
        }
    }
    (v4, v6)
}

// ── rendering ─────────────────────────────────────────────────────────────────

fn family_of_set(sname: &str) -> u8 {
    if sname.starts_with("geo4_") {
        4
    } else {
        6
    }
}

fn render_set(lines: &mut Vec<String>, name: &str, family: u8, elements: &[String]) {
    let indent = "    ";
    let addr_type = if family == 4 { "ipv4_addr" } else { "ipv6_addr" };
    lines.push(format!("{indent}set {name} {{"));
    lines.push(format!("{indent}    type {addr_type}"));
    lines.push(format!("{indent}    flags interval"));
    lines.push(format!("{indent}    auto-merge"));
    if !elements.is_empty() {
        lines.push(format!("{indent}    elements = {{"));
        // A handful of elements per line keeps huge country sets diffable.
        for (i, chunk) in elements.chunks(8).enumerate() {
            let tail = if (i + 1) * 8 < elements.len() { "," } else { "" };
            lines.push(format!("{indent}        {}{tail}", chunk.join(", ")));
        }
        lines.push(format!("{indent}    }}"));
    }
    lines.push(format!("{indent}}}"));
}

/// Statement sequence that counts, optionally logs, and drops.
fn verdict(action_name: &str, action: &Action) -> String {
    let mut parts = vec![format!("counter name {}", counter_name(action_name))];
    if action.log {
        parts.push(format!("log prefix \"[GEO-{action_name}] \""));
    }
    parts.push("drop".into());
    parts.join(" ")
}

/// Rules of one act_<name>_{src,dst} chain.
fn action_chain_rules(action_name: &str, action: &Action, direction: &str) -> Vec<String> {
    let field = if direction == "source" { "saddr" } else { "daddr" };
    let countries: BTreeSet<String> = action
        .countries
        .iter()
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let mut rules = Vec::new();
    if action.mode.as_deref() == Some("block-listed") {
        for cc in &countries {
            rules.push(format!(
                "ip {field} @{} {}",
                set_name(cc, 4),
                verdict(action_name, action)
            ));
            rules.push(format!(
                "ip6 {field} @{} {}",
                set_name(cc, 6),
                verdict(action_name, action)
            ));
        }
        if action_needs_known(action) {
            // unknown = block
            rules.push(format!("ip {field} @{} return", set_name(KNOWN, 4)));
            rules.push(format!("ip6 {field} @{} return", set_name(KNOWN, 6)));
            rules.push(verdict(action_name, action));
        }
    } else {
        // allow-listed: only the listed countries pass.
        for cc in &countries {
            rules.push(format!("ip {field} @{} return", set_name(cc, 4)));
            rules.push(format!("ip6 {field} @{} return", set_name(cc, 6)));
        }
        if action_needs_known(action) {
            // unknown = allow
            rules.push(format!("ip {field} != @{} return", set_name(KNOWN, 4)));
            rules.push(format!("ip6 {field} != @{} return", set_name(KNOWN, 6)));
        }
        rules.push(verdict(action_name, action));
    }
    rules
}

/// The complete nft file for one atomic apply.
///
/// `matches`: {policy id → replicated match expression | None} — None marks a
/// policy whose target rule is gone/unreplicable; it is skipped here and
/// surfaced through status.json.
/// `counter_seed`: {action name → (packets, bytes)} from the live ruleset so
/// a re-render doesn't zero the WebUI's hit counters.
pub fn render_full(
    model: &Model,
    matches: &BTreeMap<u32, Option<String>>,
    sets: &BTreeMap<String, Vec<String>>,
    counter_seed: &BTreeMap<String, (u64, u64)>,
) -> String {
    // Enabled policies with a usable match, grouped by hook chain in policy
    // order. Direction "both" contributes a rule per direction.
    let mut hook_rules: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut used: BTreeSet<(String, String)> = BTreeSet::new();
    let mut policies: Vec<_> = model.policies.iter().collect();
    policies.sort_by_key(|p| p.id);
    for policy in policies {
        if !policy.enabled {
            continue;
        }
        let Some(Some(expr)) = matches.get(&policy.id) else { continue };
        let Some(action_name) = policy.action.as_deref() else { continue };
        if !model.actions.contains_key(action_name) {
            continue;
        }
        let Some(ruleset) = policy.ruleset.as_deref() else { continue };
        let directions: &[&str] = if policy.direction == "both" {
            &["source", "destination"]
        } else if policy.direction == "source" {
            &["source"]
        } else {
            &["destination"]
        };
        for direction in directions {
            used.insert((action_name.to_string(), direction.to_string()));
            let mut rule = String::from("ct state new");
            if !expr.is_empty() {
                rule.push(' ');
                rule.push_str(expr);
            }
            // The anonymous counter + comment let geoip-counters attribute
            // per-policy hits (connections checked) back to the policy number.
            rule.push_str(&format!(
                " counter jump {} comment \"qz-geo-p{}\"",
                chain_name(action_name, direction),
                policy.id
            ));
            hook_rules
                .entry(hook_chain(ruleset))
                .or_default()
                .push(rule);
        }
    }

    if hook_rules.is_empty() {
        // Nothing enforced — atomically remove the table (add-then-delete is
        // a no-op create when absent, so this never errors).
        return format!("{HEADER}add table {TABLE}\ndelete table {TABLE}\n");
    }

    let mut lines: Vec<String> = vec![HEADER.trim_end().to_string()];
    lines.push(format!("add table {TABLE}"));
    lines.push(format!("delete table {TABLE}"));
    lines.push(format!("table {TABLE} {{"));

    let counter_actions: BTreeSet<&String> = used.iter().map(|(a, _)| a).collect();
    for name in counter_actions {
        let (packets, bytes) = counter_seed.get(name).copied().unwrap_or((0, 0));
        if packets != 0 || bytes != 0 {
            lines.push(format!(
                "    counter {} {{ packets {packets} bytes {bytes} }}",
                counter_name(name)
            ));
        } else {
            lines.push(format!("    counter {} {{ }}", counter_name(name)));
        }
    }

    for (sname, elements) in sets {
        render_set(&mut lines, sname, family_of_set(sname), elements);
    }

    for (action_name, direction) in &used {
        lines.push(format!("    chain {} {{", chain_name(action_name, direction)));
        for rule in action_chain_rules(action_name, &model.actions[action_name], direction) {
            lines.push(format!("        {rule}"));
        }
        lines.push("    }".into());
    }

    for ruleset in ["forward", "input", "output"] {
        let Some(rules) = hook_rules.get(hook_chain(ruleset)) else { continue };
        lines.push(format!("    chain {} {{", hook_chain(ruleset)));
        lines.push(format!(
            "        type filter hook {ruleset} priority {HOOK_PRIORITY}; policy accept;"
        ));
        for rule in rules {
            lines.push(format!("        {rule}"));
        }
        lines.push("    }".into());
    }

    lines.push("}".into());
    lines.join("\n") + "\n"
}

/// Sets-only atomic refresh after a database update: redefines every in-use
/// set's contents without touching chains or counters. The declare + flush +
/// add-element sequence is one transaction, so lookups never see a
/// half-filled set.
pub fn render_sets_reload(sets: &BTreeMap<String, Vec<String>>) -> String {
    let mut lines: Vec<String> = vec![HEADER.trim_end().to_string()];
    lines.push(format!("add table {TABLE}"));
    for (sname, elements) in sets {
        let addr_type = if family_of_set(sname) == 4 { "ipv4_addr" } else { "ipv6_addr" };
        lines.push(format!(
            "add set {TABLE} {sname} {{ type {addr_type}; flags interval; auto-merge; }}"
        ));
        lines.push(format!("flush set {TABLE} {sname}"));
        for chunk in elements.chunks(8) {
            lines.push(format!("add element {TABLE} {sname} {{ {} }}", chunk.join(", ")));
        }
    }
    lines.join("\n") + "\n"
}

/// Set names an apply of this model needs, from the in-use countries of
/// enabled policies (never all ~250 countries).
pub fn required_sets(model: &Model) -> BTreeSet<String> {
    let (countries, need_known, _) = in_use(model);
    let mut names = BTreeSet::new();
    for cc in countries {
        names.insert(set_name(&cc, 4));
        names.insert(set_name(&cc, 6));
    }
    if need_known {
        names.insert(set_name(KNOWN, 4));
        names.insert(set_name(KNOWN, 6));
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Policy;

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn block_cn() -> Action {
        Action {
            description: None,
            mode: Some("block-listed".into()),
            countries: vec!["CN".into()],
            unknown: "allow".into(),
            log: false,
        }
    }

    fn model_with(action: Action, patch: impl FnOnce(&mut Policy)) -> Model {
        let mut policy = Policy {
            id: 10,
            action: Some("Geo".into()),
            ruleset: Some("forward".into()),
            rule: 20,
            direction: "source".into(),
            enabled: true,
        };
        patch(&mut policy);
        Model {
            actions: [("Geo".to_string(), action)].into_iter().collect(),
            policies: vec![policy],
        }
    }

    fn render(
        model: &Model,
        matches: Option<BTreeMap<u32, Option<String>>>,
        sets: Option<BTreeMap<String, Vec<String>>>,
        seed: Option<BTreeMap<String, (u64, u64)>>,
    ) -> String {
        let matches = matches.unwrap_or_else(|| {
            model.policies.iter().map(|p| (p.id, Some(String::new()))).collect()
        });
        let sets = sets.unwrap_or_else(|| {
            required_sets(model).into_iter().map(|n| (n, Vec::new())).collect()
        });
        render_full(model, &matches, &sets, &seed.unwrap_or_default())
    }

    // ── collapse ──

    #[test]
    fn adjacent_intervals_merge() {
        assert_eq!(collapse(&strs(&["1.0.0.0/24", "1.0.1.0/24"]), 4), strs(&["1.0.0.0/23"]));
    }

    #[test]
    fn overlap_and_duplicates_merge() {
        assert_eq!(
            collapse(&strs(&["10.0.0.0/8", "10.1.0.0/16", "10.0.0.0/8"]), 4),
            strs(&["10.0.0.0/8"])
        );
    }

    #[test]
    fn foreign_family_entries_are_dropped() {
        let mixed = strs(&["1.0.0.0/24", "2001:db8::/32"]);
        assert_eq!(collapse(&mixed, 4), strs(&["1.0.0.0/24"]));
        assert_eq!(collapse(&mixed, 6), strs(&["2001:db8::/32"]));
    }

    #[test]
    fn v6_merge() {
        assert_eq!(
            collapse(&strs(&["2001:db8::/33", "2001:db8:8000::/33"]), 6),
            strs(&["2001:db8::/32"])
        );
    }

    #[test]
    fn non_power_of_two_range_gets_minimal_cover() {
        // Three /24s merge into a /23 + /24 (not representable as one CIDR).
        assert_eq!(
            collapse(&strs(&["1.0.0.0/24", "1.0.1.0/24", "1.0.2.0/24"]), 4),
            strs(&["1.0.0.0/23", "1.0.2.0/24"])
        );
    }

    #[test]
    fn host_bits_set_is_rejected() {
        assert_eq!(collapse(&strs(&["1.0.0.1/24", "junk"]), 4), Vec::<String>::new());
        // A bare address is a /32.
        assert_eq!(collapse(&strs(&["1.0.0.1"]), 4), strs(&["1.0.0.1/32"]));
    }

    #[test]
    fn split_families_partitions() {
        let (v4, v6) = split_families(&strs(&["1.0.0.0/24", "2001:db8::/32", "junk"]));
        assert_eq!(v4, strs(&["1.0.0.0/24"]));
        assert_eq!(v6, strs(&["2001:db8::/32"]));
    }

    // ── required sets ──

    #[test]
    fn per_country_pairs_only_for_enabled_policies() {
        let mut model = model_with(block_cn(), |_| {});
        let expected: BTreeSet<String> =
            ["geo4_cn", "geo6_cn"].iter().map(|s| s.to_string()).collect();
        assert_eq!(required_sets(&model), expected);
        model.policies[0].enabled = false;
        assert!(required_sets(&model).is_empty());
    }

    #[test]
    fn known_sets_added_when_unknown_handling_needs_them() {
        let mut action = block_cn();
        action.unknown = "block".into();
        let model = model_with(action, |_| {});
        let expected: BTreeSet<String> = ["geo4_cn", "geo6_cn", "geo4_known", "geo6_known"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(required_sets(&model), expected);
    }

    // ── render_full ──

    #[test]
    fn no_enforcement_renders_teardown() {
        let model = Model::default();
        let text = render(&model, None, None, None);
        assert!(text.contains("add table inet qz_geo"));
        assert!(text.trim_end().ends_with("delete table inet qz_geo"));
    }

    #[test]
    fn block_listed_chain() {
        let model = model_with(block_cn(), |_| {});
        let sets = [("geo4_cn".to_string(), strs(&["1.0.0.0/23"])), ("geo6_cn".to_string(), vec![])]
            .into_iter()
            .collect();
        let text = render(&model, None, Some(sets), None);
        assert!(text.contains("add table inet qz_geo\ndelete table inet qz_geo"));
        assert!(text.contains("set geo4_cn {"));
        assert!(text.contains("flags interval"));
        assert!(text.contains("auto-merge"));
        assert!(text.contains("1.0.0.0/23"));
        assert!(text.contains("chain act_Geo_src {"));
        assert!(text.contains("ip saddr @geo4_cn counter name geo_Geo drop"));
        assert!(text.contains("ip6 saddr @geo6_cn counter name geo_Geo drop"));
        assert!(text.contains("type filter hook forward priority filter - 10; policy accept;"));
        assert!(text.contains("ct state new counter jump act_Geo_src comment \"qz-geo-p10\""));
    }

    #[test]
    fn block_listed_blocking_unknown_uses_known_sets() {
        let mut action = block_cn();
        action.unknown = "block".into();
        let model = model_with(action, |_| {});
        let text = render(&model, None, None, None);
        assert!(text.contains("ip saddr @geo4_known return"));
        assert!(text.contains("ip6 saddr @geo6_known return"));
        assert!(text.contains("        counter name geo_Geo drop"));
    }

    #[test]
    fn allow_listed_chain() {
        let mut action = block_cn();
        action.mode = Some("allow-listed".into());
        action.unknown = "block".into();
        let model = model_with(action, |_| {});
        let text = render(&model, None, None, None);
        assert!(text.contains("ip saddr @geo4_cn return"));
        assert!(text.contains("ip6 saddr @geo6_cn return"));
        assert!(text.contains("        counter name geo_Geo drop"));
        assert!(!text.contains("known")); // unknown=block needs no known sets
    }

    #[test]
    fn allow_listed_allowing_unknown() {
        let mut action = block_cn();
        action.mode = Some("allow-listed".into());
        action.unknown = "allow".into();
        let model = model_with(action, |_| {});
        let text = render(&model, None, None, None);
        assert!(text.contains("ip saddr != @geo4_known return"));
        assert!(text.contains("ip6 saddr != @geo6_known return"));
    }

    #[test]
    fn log_flag_adds_prefixed_log() {
        let mut action = block_cn();
        action.log = true;
        let model = model_with(action, |_| {});
        let text = render(&model, None, None, None);
        assert!(text.contains("log prefix \"[GEO-Geo] \""));
    }

    #[test]
    fn direction_both_emits_src_and_dst() {
        let model = model_with(block_cn(), |p| p.direction = "both".into());
        let text = render(&model, None, None, None);
        assert!(text.contains("chain act_Geo_src {"));
        assert!(text.contains("chain act_Geo_dst {"));
        assert!(text.contains("ip daddr @geo4_cn"));
        assert!(text.contains("jump act_Geo_src"));
        assert!(text.contains("jump act_Geo_dst"));
    }

    #[test]
    fn replicated_match_prefixes_jump() {
        let model = model_with(block_cn(), |_| {});
        let matches = [(10u32, Some("iifname \"eth0\" ip saddr 10.0.0.0/8".to_string()))]
            .into_iter()
            .collect();
        let text = render(&model, Some(matches), None, None);
        assert!(text.contains(
            "ct state new iifname \"eth0\" ip saddr 10.0.0.0/8 counter jump act_Geo_src \
             comment \"qz-geo-p10\""
        ));
    }

    #[test]
    fn dangling_policy_is_skipped_not_rendered() {
        let model = model_with(block_cn(), |_| {});
        let matches = [(10u32, None)].into_iter().collect();
        let text = render(&model, Some(matches), None, None);
        assert!(text.trim_end().ends_with("delete table inet qz_geo"));
    }

    #[test]
    fn policies_ordered_by_number_and_ruleset_chains() {
        let mut model = model_with(block_cn(), |_| {});
        model.policies.push(Policy {
            id: 20,
            action: Some("Geo".into()),
            ruleset: Some("input".into()),
            rule: 5,
            direction: "source".into(),
            enabled: true,
        });
        let text = render(&model, None, None, None);
        assert!(text.contains("chain geo_forward {"));
        assert!(text.contains("chain geo_input {"));
        assert!(text.contains("type filter hook input priority filter - 10"));
    }

    #[test]
    fn counter_seed_survives_rerender() {
        let model = model_with(block_cn(), |_| {});
        let seed = [("Geo".to_string(), (17u64, 4242u64))].into_iter().collect();
        let text = render(&model, None, None, Some(seed));
        assert!(text.contains("counter geo_Geo { packets 17 bytes 4242 }"));
    }

    // ── render_sets_reload ──

    #[test]
    fn reload_is_declare_flush_add() {
        let sets: BTreeMap<String, Vec<String>> = [
            ("geo4_cn".to_string(), strs(&["1.0.0.0/23", "203.0.113.0/24"])),
            ("geo6_cn".to_string(), vec![]),
        ]
        .into_iter()
        .collect();
        let text = render_sets_reload(&sets);
        assert!(text.contains(
            "add set inet qz_geo geo4_cn { type ipv4_addr; flags interval; auto-merge; }"
        ));
        assert!(text.contains("flush set inet qz_geo geo4_cn"));
        assert!(text.contains("add element inet qz_geo geo4_cn { 1.0.0.0/23, 203.0.113.0/24 }"));
        // Empty set is still flushed (stale elements must go) but adds nothing.
        assert!(text.contains("flush set inet qz_geo geo6_cn"));
        assert!(!text.contains("add element inet qz_geo geo6_cn"));
    }

    #[test]
    fn set_names() {
        assert_eq!(set_name("CN", 4), "geo4_cn");
        assert_eq!(set_name("known", 6), "geo6_known");
    }
}
