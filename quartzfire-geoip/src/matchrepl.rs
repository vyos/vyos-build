//! Replicate a VyOS firewall rule's match criteria as an nftables expression.
//!
//! The geo table cannot reference sets inside `vyos_filter` (nftables sets
//! are per-table), so a policy's "attach to firewall rule N" is enforced by
//! replicating that rule's own match in `inet qz_geo` and jumping to the
//! action's verdict chain — the same derivation pattern qfappd bindings use.
//!
//! Group references are resolved to their member lists at render time; the
//! resync path unit (watching /run/nftables.conf) re-resolves them after
//! every firewall commit so group edits converge within a second.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// Firewall groups: group type → group name → leaf → member values
/// (e.g. groups["address-group"]["Servers"]["address"] = [...]).
pub type Groups = BTreeMap<String, BTreeMap<String, BTreeMap<String, Vec<String>>>>;

/// `inbound-interface` / `outbound-interface` node of a rule.
#[derive(Debug, Clone, Default)]
pub struct IfaceSpec {
    pub name: Option<String>,
    pub group: Option<String>,
}

/// `source` / `destination` node of a rule.
#[derive(Debug, Clone, Default)]
pub struct Side {
    pub address: Option<String>,
    pub group_type: Option<String>,
    pub group_name: Option<String>,
    /// Destination only.
    pub port_group: Option<String>,
}

/// The bits of one firewall rule that the geo match replication needs.
#[derive(Debug, Clone, Default)]
pub struct RuleCfg {
    pub inbound_interface: Option<IfaceSpec>,
    pub outbound_interface: Option<IfaceSpec>,
    pub source: Side,
    pub destination: Side,
    pub protocol: Option<String>,
}

/// The rule uses a construct that cannot be replicated (surfaced as a
/// commit-blocking validation error, never silently approximated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchError(pub String);

impl fmt::Display for MatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for MatchError {}

fn member_leaf(gtype: &str) -> Option<&'static str> {
    match gtype {
        "address-group" => Some("address"),
        "network-group" => Some("network"),
        _ => None,
    }
}

/// Flatten a group's literal members, following `include` references
/// (auto-managed OR groups include the aliases the rule selected).
fn group_members(
    groups: &Groups,
    gtype: &str,
    name: &str,
    seen: &mut BTreeSet<(String, String)>,
) -> Result<Vec<String>, MatchError> {
    if !seen.insert((gtype.to_string(), name.to_string())) {
        return Ok(Vec::new());
    }
    let group = groups
        .get(gtype)
        .and_then(|g| g.get(name))
        .ok_or_else(|| MatchError(format!("firewall group {gtype} \"{name}\" does not exist")))?;
    let leaf = member_leaf(gtype).unwrap_or("");
    let mut members = group.get(leaf).cloned().unwrap_or_default();
    for inc in group.get("include").cloned().unwrap_or_default() {
        members.extend(group_members(groups, gtype, &inc, seen)?);
    }
    Ok(members)
}

fn set_literal<I: IntoIterator<Item = String>>(members: I) -> String {
    let inner: Vec<String> = members.into_iter().collect();
    format!("{{ {} }}", inner.join(", "))
}

fn iface_expr(kind: &str, spec: &IfaceSpec, groups: &Groups) -> Result<String, MatchError> {
    if let Some(name) = &spec.name {
        return Ok(format!("{kind} \"{name}\""));
    }
    let gname = spec.group.as_deref().unwrap_or("");
    let names = groups
        .get("interface-group")
        .and_then(|g| g.get(gname))
        .and_then(|g| g.get("interface"))
        .cloned()
        .unwrap_or_default();
    if names.is_empty() {
        return Err(MatchError(format!(
            "interface-group \"{gname}\" has no member interfaces"
        )));
    }
    Ok(format!(
        "{kind} {}",
        set_literal(names.into_iter().map(|n| format!("\"{n}\"")))
    ))
}

fn addr_expr(side_key: &str, side: &Side, groups: &Groups) -> Result<Option<String>, MatchError> {
    if side.group_type.as_deref() == Some("domain-group") {
        return Err(MatchError(format!(
            "the rule matches FQDN group \"{}\" — geolocation cannot be attached \
             to rules that match domain (FQDN) groups",
            side.group_name.as_deref().unwrap_or("")
        )));
    }
    if let (Some(gtype), Some(gname)) = (side.group_type.as_deref(), side.group_name.as_deref()) {
        if member_leaf(gtype).is_some() {
            let members = group_members(groups, gtype, gname, &mut BTreeSet::new())?;
            if members.is_empty() {
                return Err(MatchError(format!(
                    "firewall group {gtype} \"{gname}\" has no members"
                )));
            }
            return Ok(Some(format!("ip {side_key} {}", set_literal(members))));
        }
    }
    if let Some(addr) = side.address.as_deref() {
        if let Some(stripped) = addr.strip_prefix('!') {
            return Ok(Some(format!("ip {side_key} != {stripped}")));
        }
        return Ok(Some(format!("ip {side_key} {addr}")));
    }
    Ok(None)
}

fn port_expr(rule: &RuleCfg, groups: &Groups) -> Result<Option<String>, MatchError> {
    let proto = rule
        .protocol
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    if let Some(pg) = rule.destination.port_group.as_deref() {
        let ports = groups
            .get("port-group")
            .and_then(|g| g.get(pg))
            .and_then(|g| g.get("port"))
            .cloned()
            .unwrap_or_default();
        if ports.is_empty() {
            return Err(MatchError(format!("port-group \"{pg}\" has no member ports")));
        }
        let plist = set_literal(ports);
        return Ok(Some(match proto {
            Some(p @ ("tcp" | "udp")) => format!("{p} dport {plist}"),
            // tcp_udp (or unset — VyOS requires a protocol with port matches,
            // but be liberal): match either transport on the destination port.
            _ => format!("meta l4proto {{ tcp, udp }} th dport {plist}"),
        }));
    }
    Ok(match proto {
        None | Some("all") => None,
        // tcp_udp is a VyOS pseudo-protocol expanding to both transports.
        Some("tcp_udp") => Some("meta l4proto { tcp, udp }".into()),
        Some(p) => Some(format!("meta l4proto {p}")),
    })
}

/// The nftables match expression replicating one firewall rule (may be an
/// empty string when the rule matches everything).
pub fn rule_match_expr(rule: &RuleCfg, groups: &Groups) -> Result<String, MatchError> {
    let mut parts = Vec::new();
    if let Some(spec) = &rule.inbound_interface {
        parts.push(iface_expr("iifname", spec, groups)?);
    }
    if let Some(spec) = &rule.outbound_interface {
        parts.push(iface_expr("oifname", spec, groups)?);
    }
    if let Some(expr) = addr_expr("saddr", &rule.source, groups)? {
        parts.push(expr);
    }
    if let Some(expr) = addr_expr("daddr", &rule.destination, groups)? {
        parts.push(expr);
    }
    if let Some(expr) = port_expr(rule, groups)? {
        parts.push(expr);
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn groups(entries: &[(&str, &str, &[(&str, &[&str])])]) -> Groups {
        let mut out = Groups::new();
        for (gtype, name, leaves) in entries {
            let leaf_map: BTreeMap<String, Vec<String>> = leaves
                .iter()
                .map(|(leaf, vals)| {
                    (leaf.to_string(), vals.iter().map(|v| v.to_string()).collect())
                })
                .collect();
            out.entry(gtype.to_string())
                .or_default()
                .insert(name.to_string(), leaf_map);
        }
        out
    }

    #[test]
    fn empty_rule_matches_everything() {
        assert_eq!(rule_match_expr(&RuleCfg::default(), &Groups::new()).unwrap(), "");
    }

    #[test]
    fn interfaces_and_literal_addresses() {
        let rule = RuleCfg {
            inbound_interface: Some(IfaceSpec { name: Some("eth1".into()), group: None }),
            outbound_interface: Some(IfaceSpec { name: Some("eth0".into()), group: None }),
            source: Side { address: Some("10.0.0.0/8".into()), ..Default::default() },
            destination: Side { address: Some("192.0.2.7".into()), ..Default::default() },
            protocol: None,
        };
        assert_eq!(
            rule_match_expr(&rule, &Groups::new()).unwrap(),
            "iifname \"eth1\" oifname \"eth0\" ip saddr 10.0.0.0/8 ip daddr 192.0.2.7"
        );
    }

    #[test]
    fn negated_address() {
        let rule = RuleCfg {
            source: Side { address: Some("!10.0.0.0/8".into()), ..Default::default() },
            ..Default::default()
        };
        assert_eq!(rule_match_expr(&rule, &Groups::new()).unwrap(), "ip saddr != 10.0.0.0/8");
    }

    #[test]
    fn address_group_flattens_includes() {
        let groups = groups(&[
            (
                "address-group",
                "QZ-R20-FROM",
                &[("address", &["192.0.2.9"][..]), ("include", &["Servers"][..])],
            ),
            (
                "address-group",
                "Servers",
                &[("address", &["198.51.100.1", "198.51.100.2-198.51.100.9"][..])],
            ),
        ]);
        let rule = RuleCfg {
            source: Side {
                group_type: Some("address-group".into()),
                group_name: Some("QZ-R20-FROM".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            rule_match_expr(&rule, &groups).unwrap(),
            "ip saddr { 192.0.2.9, 198.51.100.1, 198.51.100.2-198.51.100.9 }"
        );
    }

    #[test]
    fn interface_group_expands_members() {
        let groups = groups(&[("interface-group", "LANs", &[("interface", &["eth1", "eth2"][..])])]);
        let rule = RuleCfg {
            inbound_interface: Some(IfaceSpec { name: None, group: Some("LANs".into()) }),
            ..Default::default()
        };
        assert_eq!(
            rule_match_expr(&rule, &groups).unwrap(),
            "iifname { \"eth1\", \"eth2\" }"
        );
    }

    #[test]
    fn port_group_with_single_protocol() {
        let groups = groups(&[("port-group", "Web", &[("port", &["80", "443"][..])])]);
        let rule = RuleCfg {
            protocol: Some("tcp".into()),
            destination: Side { port_group: Some("Web".into()), ..Default::default() },
            ..Default::default()
        };
        assert_eq!(rule_match_expr(&rule, &groups).unwrap(), "tcp dport { 80, 443 }");
    }

    #[test]
    fn port_group_with_tcp_udp() {
        let groups = groups(&[("port-group", "DNS", &[("port", &["53"][..])])]);
        let rule = RuleCfg {
            protocol: Some("tcp_udp".into()),
            destination: Side { port_group: Some("DNS".into()), ..Default::default() },
            ..Default::default()
        };
        assert_eq!(
            rule_match_expr(&rule, &groups).unwrap(),
            "meta l4proto { tcp, udp } th dport { 53 }"
        );
    }

    #[test]
    fn bare_protocol() {
        let icmp = RuleCfg { protocol: Some("icmp".into()), ..Default::default() };
        assert_eq!(rule_match_expr(&icmp, &Groups::new()).unwrap(), "meta l4proto icmp");
        let both = RuleCfg { protocol: Some("tcp_udp".into()), ..Default::default() };
        assert_eq!(
            rule_match_expr(&both, &Groups::new()).unwrap(),
            "meta l4proto { tcp, udp }"
        );
    }

    #[test]
    fn domain_group_is_rejected() {
        let groups = groups(&[("domain-group", "CDNs", &[("address", &["example.com"][..])])]);
        let rule = RuleCfg {
            destination: Side {
                group_type: Some("domain-group".into()),
                group_name: Some("CDNs".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(rule_match_expr(&rule, &groups).is_err());
    }

    #[test]
    fn missing_group_is_rejected() {
        let rule = RuleCfg {
            source: Side {
                group_type: Some("address-group".into()),
                group_name: Some("Ghost".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(rule_match_expr(&rule, &Groups::new()).is_err());
    }

    #[test]
    fn include_cycle_terminates() {
        let groups = groups(&[
            (
                "network-group",
                "A",
                &[("network", &["10.1.0.0/16"][..]), ("include", &["B"][..])],
            ),
            (
                "network-group",
                "B",
                &[("network", &["10.2.0.0/16"][..]), ("include", &["A"][..])],
            ),
        ]);
        let rule = RuleCfg {
            source: Side {
                group_type: Some("network-group".into()),
                group_name: Some("A".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            rule_match_expr(&rule, &groups).unwrap(),
            "ip saddr { 10.1.0.0/16, 10.2.0.0/16 }"
        );
    }
}
