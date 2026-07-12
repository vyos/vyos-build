//! Read the geolocation model and firewall facts out of the VyOS config.
//!
//! The config is accessed through `cli-shell-api` — the same C++ tool the
//! vyos-1x Python Config class wraps — so a compiled binary can act as a
//! conf-mode owner script. Two views:
//!   * session (inside a commit, the proposed config): exists / listNodes /
//!     returnValue / returnValues / existsEffective — the owner script's env
//!     carries the session context;
//!   * active (outside a commit, the running config): the *Active verbs —
//!     used by the standalone resync.
//!
//! Only these primitives are used, deliberately: vyos-1x's higher-level
//! config dictionaries consult its XML reference cache, which knows nothing
//! about nodes added by this package.

use std::collections::BTreeMap;
use std::process::Command;

use crate::matchrepl::{Groups, IfaceSpec, RuleCfg, Side};
use crate::model::{Action, Model, Policy};

pub const BASE: [&str; 2] = ["service", "geolocation"];

const GROUP_TYPES: [&str; 5] = [
    "address-group",
    "network-group",
    "domain-group",
    "interface-group",
    "port-group",
];

fn group_leaves(gtype: &str) -> &'static [&'static str] {
    match gtype {
        "address-group" => &["address", "include"],
        "network-group" => &["network", "include"],
        "domain-group" => &["address", "include"],
        "interface-group" => &["interface"],
        "port-group" => &["port"],
        _ => &[],
    }
}

/// The four primitive reads (plus the effective-config existence check used
/// to phrase "cannot delete while referenced" errors). Implemented by
/// CliShellApi on a device and by the test fake.
pub trait ConfigRead {
    fn exists(&self, path: &[&str]) -> bool;
    fn list_nodes(&self, path: &[&str]) -> Vec<String>;
    fn return_value(&self, path: &[&str]) -> Option<String>;
    fn return_values(&self, path: &[&str]) -> Vec<String>;
    fn exists_effective(&self, path: &[&str]) -> bool;
}

// ── cli-shell-api ─────────────────────────────────────────────────────────────

pub struct CliShellApi {
    /// false = session view (conf-mode owner, inherits the commit env);
    /// true = active/running config (standalone resync).
    active: bool,
}

impl CliShellApi {
    pub fn session() -> Self {
        Self { active: false }
    }
    pub fn active() -> Self {
        Self { active: true }
    }

    fn run(&self, verb: &str, path: &[&str]) -> Option<String> {
        let output = Command::new("cli-shell-api")
            .arg(verb)
            .args(path)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// cli-shell-api list output: whitespace-separated tokens, each single-quoted
/// ('eth0' 'eth1'); values may contain spaces inside the quotes.
fn parse_quoted_list(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in text.chars() {
        match ch {
            '\'' => {
                if in_quotes {
                    out.push(std::mem::take(&mut current));
                }
                in_quotes = !in_quotes;
            }
            _ if in_quotes => current.push(ch),
            _ => {}
        }
    }
    out
}

impl ConfigRead for CliShellApi {
    fn exists(&self, path: &[&str]) -> bool {
        let verb = if self.active { "existsActive" } else { "exists" };
        self.run(verb, path).is_some()
    }

    fn list_nodes(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "listActiveNodes" } else { "listNodes" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
    }

    fn return_value(&self, path: &[&str]) -> Option<String> {
        let verb = if self.active { "returnActiveValue" } else { "returnValue" };
        let value = self.run(verb, path)?.trim_end_matches('\n').to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    fn return_values(&self, path: &[&str]) -> Vec<String> {
        let verb = if self.active { "returnActiveValues" } else { "returnValues" };
        self.run(verb, path).map(|t| parse_quoted_list(&t)).unwrap_or_default()
    }

    fn exists_effective(&self, path: &[&str]) -> bool {
        // In active mode "effective" IS the active config.
        let verb = if self.active { "existsActive" } else { "existsEffective" };
        self.run(verb, path).is_some()
    }
}

// ── readers ───────────────────────────────────────────────────────────────────

fn join<'a>(base: &[&'a str], rest: &[&'a str]) -> Vec<&'a str> {
    base.iter().chain(rest.iter()).copied().collect()
}

/// The service geolocation subtree as a normalized model.
pub fn read_service(conf: &dyn ConfigRead) -> Model {
    let mut model = Model::default();
    if !conf.exists(&BASE) {
        return model;
    }
    for name in conf.list_nodes(&join(&BASE, &["action"])) {
        let p: Vec<&str> = vec!["service", "geolocation", "action", &name];
        model.actions.insert(
            name.clone(),
            Action {
                description: conf.return_value(&join(&p, &["description"])),
                mode: conf.return_value(&join(&p, &["mode"])),
                countries: conf
                    .return_values(&join(&p, &["country"]))
                    .iter()
                    .map(|c| c.to_ascii_uppercase())
                    .collect(),
                unknown: conf
                    .return_value(&join(&p, &["unknown-ip"]))
                    .unwrap_or_else(|| "allow".into()),
                log: conf.exists(&join(&p, &["log"])),
            },
        );
    }
    for num in conf.list_nodes(&join(&BASE, &["policy"])) {
        let p: Vec<&str> = vec!["service", "geolocation", "policy", &num];
        model.policies.push(Policy {
            id: num.parse().unwrap_or(0),
            action: conf.return_value(&join(&p, &["action"])),
            ruleset: conf.return_value(&join(&p, &["ruleset"])),
            rule: conf
                .return_value(&join(&p, &["rule"]))
                .and_then(|r| r.parse().ok())
                .unwrap_or(0),
            direction: conf
                .return_value(&join(&p, &["direction"]))
                .unwrap_or_else(|| "both".into()),
            enabled: !conf.exists(&join(&p, &["disable"])),
        });
    }
    model.policies.sort_by_key(|p| p.id);
    model
}

/// The bits of one firewall rule that the geo match replication needs, or
/// None when the rule does not exist (a dangling policy).
pub fn read_rule_cfg(conf: &dyn ConfigRead, ruleset: &str, rule: u32) -> Option<RuleCfg> {
    let rule_s = rule.to_string();
    let base: Vec<&str> = vec!["firewall", "ipv4", ruleset, "filter", "rule", &rule_s];
    if !conf.exists(&base) {
        return None;
    }

    let iface = |key: &str| -> Option<IfaceSpec> {
        if let Some(name) = conf.return_value(&join(&base, &[key, "name"])) {
            return Some(IfaceSpec { name: Some(name), group: None });
        }
        if let Some(group) = conf.return_value(&join(&base, &[key, "group"])) {
            return Some(IfaceSpec { name: None, group: Some(group) });
        }
        None
    };

    let side = |key: &str| -> Side {
        let mut out = Side {
            address: conf.return_value(&join(&base, &[key, "address"])),
            ..Default::default()
        };
        for gt in ["address-group", "network-group", "domain-group"] {
            if let Some(name) = conf.return_value(&join(&base, &[key, "group", gt])) {
                out.group_type = Some(gt.into());
                out.group_name = Some(name);
                break;
            }
        }
        out
    };

    let mut destination = side("destination");
    destination.port_group = conf.return_value(&join(&base, &["destination", "group", "port-group"]));

    Some(RuleCfg {
        inbound_interface: iface("inbound-interface"),
        outbound_interface: iface("outbound-interface"),
        source: side("source"),
        destination,
        protocol: conf.return_value(&join(&base, &["protocol"])),
    })
}

/// Every firewall group's members, for group-reference resolution.
pub fn read_groups(conf: &dyn ConfigRead) -> Groups {
    let mut groups = Groups::new();
    for gt in GROUP_TYPES {
        groups.insert(gt.to_string(), BTreeMap::new());
    }
    if !conf.exists(&["firewall", "group"]) {
        return groups;
    }
    for gt in GROUP_TYPES {
        if !conf.exists(&["firewall", "group", gt]) {
            continue;
        }
        for name in conf.list_nodes(&["firewall", "group", gt]) {
            let mut entry = BTreeMap::new();
            for leaf in group_leaves(gt) {
                entry.insert(
                    leaf.to_string(),
                    conf.return_values(&["firewall", "group", gt, &name, leaf]),
                );
            }
            groups.get_mut(gt).unwrap().insert(name, entry);
        }
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_list_parses() {
        assert_eq!(parse_quoted_list("'eth0' 'eth1'"), vec!["eth0", "eth1"]);
        assert_eq!(parse_quoted_list("'with space' 'b'"), vec!["with space", "b"]);
        assert_eq!(parse_quoted_list(""), Vec::<String>::new());
        assert_eq!(parse_quoted_list("'one'\n"), vec!["one"]);
    }
}
