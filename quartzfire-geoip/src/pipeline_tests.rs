//! End-to-end pipeline over a fixture database: VyOS-config → model →
//! resolved matches → sets → rendered nftables ruleset. The fakes implement
//! the same small traits the production code uses (ConfigRead over a JSON
//! tree, Database over an in-memory network map).
#![cfg(test)]

use std::collections::BTreeMap;
use std::net::IpAddr;

use serde_json::{json, Value};

use crate::apply::{build_sets, resolve_matches};
use crate::config::{read_service, ConfigRead};
use crate::db::{Country, Database, Lookup};
use crate::model::validate;
use crate::render::{render_full, required_sets};

// ── fakes ─────────────────────────────────────────────────────────────────────

/// ConfigRead over a nested JSON tree: multi-value leaves are arrays,
/// valueless leaves are `{}`.
struct FakeConfig {
    tree: Value,
    effective: Value,
}

impl FakeConfig {
    fn new(tree: Value) -> Self {
        let effective = tree.clone();
        Self { tree, effective }
    }

    fn get<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
        let mut node = root;
        for key in path {
            node = node.as_object()?.get(*key)?;
        }
        Some(node)
    }
}

impl ConfigRead for FakeConfig {
    fn exists(&self, path: &[&str]) -> bool {
        Self::get(&self.tree, path).is_some()
    }
    fn list_nodes(&self, path: &[&str]) -> Vec<String> {
        Self::get(&self.tree, path)
            .and_then(Value::as_object)
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default()
    }
    fn return_value(&self, path: &[&str]) -> Option<String> {
        Self::get(&self.tree, path)?.as_str().map(String::from)
    }
    fn return_values(&self, path: &[&str]) -> Vec<String> {
        match Self::get(&self.tree, path) {
            Some(Value::Array(items)) => {
                items.iter().filter_map(Value::as_str).map(String::from).collect()
            }
            Some(Value::String(s)) => vec![s.clone()],
            _ => Vec::new(),
        }
    }
    fn exists_effective(&self, path: &[&str]) -> bool {
        Self::get(&self.effective, path).is_some()
    }
}

/// A tiny, deterministic "location database": two adjacent v4 networks that
/// must merge into one interval, plus v6 coverage.
struct FakeDatabase {
    networks: BTreeMap<&'static str, Vec<&'static str>>,
    version: i64,
}

impl FakeDatabase {
    fn new() -> Self {
        let mut networks = BTreeMap::new();
        networks.insert("CN", vec!["1.0.0.0/24", "1.0.1.0/24", "203.0.113.0/24", "2001:db8:c::/48"]);
        networks.insert("US", vec!["198.51.100.0/24", "2001:db8:a::/48"]);
        networks.insert("DE", vec!["192.0.2.0/25", "192.0.2.128/25"]);
        Self { networks, version: 1_234_567_890 }
    }

    fn family_matches(net: &str, family: u8) -> bool {
        (family == 6) == net.contains(':')
    }
}

impl Database for FakeDatabase {
    fn created_at(&self) -> i64 {
        self.version
    }
    fn verify(&self) -> Option<bool> {
        Some(true)
    }
    fn countries(&self) -> Vec<Country> {
        vec![
            Country { code: "CN".into(), name: "China".into(), continent: Some("AS".into()) },
            Country { code: "DE".into(), name: "Germany".into(), continent: Some("EU".into()) },
            Country { code: "US".into(), name: "United States of America".into(), continent: Some("NA".into()) },
        ]
    }
    fn networks(&self, cc: &str, family: u8) -> Vec<String> {
        self.networks
            .get(cc.to_ascii_uppercase().as_str())
            .into_iter()
            .flatten()
            .filter(|n| Self::family_matches(n, family))
            .map(|n| n.to_string())
            .collect()
    }
    fn all_networks(&self, family: u8) -> Vec<String> {
        self.networks
            .values()
            .flatten()
            .filter(|n| Self::family_matches(n, family))
            .map(|n| n.to_string())
            .collect()
    }
    fn lookup(&self, ip: &str) -> Lookup {
        let Ok(addr) = ip.parse::<IpAddr>() else { return Lookup::default() };
        for (cc, nets) in &self.networks {
            for net in nets {
                let (net_addr, len) = net.split_once('/').unwrap();
                let contains = match (addr, net_addr.parse::<IpAddr>().unwrap()) {
                    (IpAddr::V4(a), IpAddr::V4(n)) => {
                        let len: u32 = len.parse().unwrap();
                        let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
                        (u32::from(a) & mask) == u32::from(n)
                    }
                    (IpAddr::V6(a), IpAddr::V6(n)) => {
                        let len: u32 = len.parse().unwrap();
                        let mask = if len == 0 { 0 } else { u128::MAX << (128 - len) };
                        (u128::from(a) & mask) == u128::from(n)
                    }
                    _ => false,
                };
                if contains {
                    return Lookup { country: Some(cc.to_string()), network: Some(net.to_string()) };
                }
            }
        }
        Lookup::default()
    }
}

fn config_tree() -> Value {
    json!({
        "service": {
            "geolocation": {
                "action": {
                    "Block_CN": {
                        "mode": "block-listed",
                        "country": ["CN"],
                        "unknown-ip": "allow",
                        "log": {},
                    }
                },
                "policy": {
                    "10": {
                        "action": "Block_CN",
                        "ruleset": "forward",
                        "rule": "20",
                        "direction": "source",
                    }
                },
            }
        },
        "firewall": {
            "group": { "interface-group": { "WANs": { "interface": ["eth0"] } } },
            "ipv4": {
                "forward": {
                    "filter": {
                        "rule": {
                            "20": {
                                "action": "accept",
                                "inbound-interface": { "group": "WANs" },
                                "destination": { "address": "192.0.2.0/24" },
                            }
                        }
                    }
                }
            },
        },
    })
}

fn temp_cache() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qzgeo-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[test]
fn full_pipeline() {
    let conf = FakeConfig::new(config_tree());
    let mut db = FakeDatabase::new();
    let cache = temp_cache();

    let model = read_service(&conf);
    assert_eq!(model.actions.keys().collect::<Vec<_>>(), vec!["Block_CN"]);
    assert!(model.actions["Block_CN"].log);
    assert_eq!(model.policies[0].rule, 20);
    assert!(validate(&model, Some(&db.country_codes())).is_empty());

    let (matches, problems) = resolve_matches(&model, Some(&conf), None);
    assert!(problems.is_empty());
    assert_eq!(
        matches.get(&10),
        Some(&Some("iifname { \"eth0\" } ip daddr 192.0.2.0/24".to_string()))
    );

    let sets = build_sets(&db, &required_sets(&model), &cache).unwrap();
    // v4/v6 split with the adjacent fixture networks merged.
    assert_eq!(sets["geo4_cn"], vec!["1.0.0.0/23", "203.0.113.0/24"]);
    assert_eq!(sets["geo6_cn"], vec!["2001:db8:c::/48"]);

    let text = render_full(&model, &matches, &sets, &BTreeMap::new());
    assert!(text.contains("add table inet qz_geo\ndelete table inet qz_geo"));
    assert!(text.contains("1.0.0.0/23, 203.0.113.0/24"));
    assert!(text.contains("2001:db8:c::/48"));
    assert!(text.contains(
        "ct state new iifname { \"eth0\" } ip daddr 192.0.2.0/24 counter \
         jump act_Block_CN_src comment \"qz-geo-p10\""
    ));
    assert!(text.contains(
        "ip saddr @geo4_cn counter name geo_Block_CN log prefix \"[GEO-Block_CN] \" drop"
    ));

    // Second build must come from the cache (mutate the db; result sticks).
    db.networks.insert("CN", vec!["9.9.9.0/24"]);
    let names: std::collections::BTreeSet<String> = ["geo4_cn".to_string()].into_iter().collect();
    let cached = build_sets(&db, &names, &cache).unwrap();
    assert_eq!(cached["geo4_cn"], vec!["1.0.0.0/23", "203.0.113.0/24"]);
    // A version bump invalidates the cache.
    db.version += 1;
    let fresh = build_sets(&db, &names, &cache).unwrap();
    assert_eq!(fresh["geo4_cn"], vec!["9.9.9.0/24"]);

    let _ = std::fs::remove_dir_all(&cache);
}

#[test]
fn dangling_rule_is_surfaced_not_dropped() {
    let mut tree = config_tree();
    tree["firewall"] = json!({ "group": {}, "ipv4": { "forward": { "filter": { "rule": {} } } } });
    let conf = FakeConfig::new(tree);
    let model = read_service(&conf);
    let (matches, problems) = resolve_matches(&model, Some(&conf), None);
    assert_eq!(matches.get(&10), Some(&None));
    assert_eq!(problems.len(), 1);
    assert!(problems[0].error.contains("rule 20 does not exist"));
}

#[test]
fn snapshot_fallback() {
    let model = read_service(&FakeConfig::new(config_tree()));
    let snapshot: BTreeMap<String, Option<String>> =
        [("10".to_string(), Some("iifname \"eth0\"".to_string()))].into_iter().collect();
    let (matches, problems) = resolve_matches(&model, None, Some(&snapshot));
    assert_eq!(matches.get(&10), Some(&Some("iifname \"eth0\"".to_string())));
    assert!(problems.is_empty());
}

#[test]
fn lookup_fixture() {
    let db = FakeDatabase::new();
    assert_eq!(db.lookup("1.0.1.7").country.as_deref(), Some("CN"));
    assert_eq!(db.lookup("8.8.8.8").country, None);
}
