//! Normalized geolocation model + validation.
//!
//! The model is plain data so the same validation runs in three places: the
//! conf-mode owner's verify stage (authoritative — a failure aborts the
//! commit), the standalone resync (defensive), and the unit tests.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MODES: [&str; 2] = ["block-listed", "allow-listed"];
pub const UNKNOWN_HANDLING: [&str; 2] = ["allow", "block"];
pub const DIRECTIONS: [&str; 3] = ["source", "destination", "both"];
pub const RULESETS: [&str; 3] = ["forward", "input", "output"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Action {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Upper-cased ISO 3166-1 alpha-2 codes.
    #[serde(default)]
    pub countries: Vec<String>,
    /// Handling of IPs absent from the location database.
    #[serde(default = "default_unknown")]
    pub unknown: String,
    #[serde(default)]
    pub log: bool,
}

fn default_unknown() -> String {
    "allow".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    /// Policy number (the config tag).
    pub id: u32,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub ruleset: Option<String>,
    /// Target rule in `firewall ipv4 <ruleset> filter` (0 = not set).
    #[serde(default)]
    pub rule: u32,
    #[serde(default = "default_direction")]
    pub direction: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_direction() -> String {
    "both".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Model {
    #[serde(default)]
    pub actions: BTreeMap<String, Action>,
    #[serde(default)]
    pub policies: Vec<Policy>,
}

/// Action names become nftables chain/counter identifiers (act_<name>_src,
/// geo_<name>) and log prefixes, so they are restricted to characters nft
/// accepts unquoted. Enforced again by the node.def syntax expression.
pub fn name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn cc_ok(cc: &str) -> bool {
    cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic())
}

/// Return a list of human-readable problems (empty = model is valid).
///
/// `known_codes`: optional set of upper-case country codes present in the
/// location database — country membership is only checked when given (the
/// database may not have been downloaded yet; code *format* is always
/// checked).
pub fn validate(model: &Model, known_codes: Option<&BTreeSet<String>>) -> Vec<String> {
    let mut problems = Vec::new();

    for (name, action) in &model.actions {
        let where_ = format!("action \"{name}\"");
        if !name_ok(name) {
            problems.push(format!(
                "{where_}: the name must start with a letter and contain only \
                 letters, digits, and underscores (at most 32 characters)"
            ));
        }
        match action.mode.as_deref() {
            Some(mode) if MODES.contains(&mode) => {}
            Some(mode) => problems.push(format!(
                "{where_}: mode must be set to block-listed or allow-listed (got \"{mode}\")"
            )),
            None => problems.push(format!(
                "{where_}: mode must be set to block-listed or allow-listed"
            )),
        }
        // An empty country list means "all countries": harmless for
        // block-listed (allow all — the default Global action ships this way),
        // but for allow-listed it would block every classified IP, which is
        // almost always a mistake rather than an intent.
        if action.countries.is_empty() && action.mode.as_deref() != Some("block-listed") {
            problems.push(format!(
                "{where_}: at least one country is required — an allow-listed \
                 action with no countries blocks everything (use block-listed \
                 to allow all countries)"
            ));
        }
        let mut seen = BTreeSet::new();
        for cc in &action.countries {
            if !cc_ok(cc) {
                problems.push(format!(
                    "{where_}: \"{cc}\" is not a two-letter ISO 3166-1 country code"
                ));
                continue;
            }
            let up = cc.to_ascii_uppercase();
            if !seen.insert(up.clone()) {
                problems.push(format!("{where_}: country {up} is listed twice"));
            }
            if let Some(known) = known_codes {
                if !known.contains(&up) {
                    problems.push(format!(
                        "{where_}: country {up} is not present in the location database"
                    ));
                }
            }
        }
        if !UNKNOWN_HANDLING.contains(&action.unknown.as_str()) {
            problems.push(format!(
                "{where_}: unknown-ip must be allow or block (got \"{}\")",
                action.unknown
            ));
        }
    }

    let mut seen_ids = BTreeSet::new();
    for policy in &model.policies {
        let where_ = format!("policy {}", policy.id);
        if !seen_ids.insert(policy.id) {
            problems.push(format!("{where_}: duplicate policy number"));
        }
        match policy.action.as_deref() {
            None | Some("") => problems.push(format!("{where_}: no geolocation action is set")),
            Some(action) if !model.actions.contains_key(action) => problems.push(format!(
                "{where_} references geolocation action \"{action}\", which is not configured"
            )),
            _ => {}
        }
        match policy.ruleset.as_deref() {
            Some(rs) if RULESETS.contains(&rs) => {}
            _ => problems.push(format!("{where_}: ruleset must be forward, input, or output")),
        }
        if policy.rule < 1 {
            problems.push(format!("{where_}: no target firewall rule number is set"));
        }
        if !DIRECTIONS.contains(&policy.direction.as_str()) {
            problems.push(format!(
                "{where_}: direction must be source, destination, or both"
            ));
        }
    }

    problems
}

/// Whether an action's unknown-IP handling requires the synthetic
/// geo{4,6}_known sets (the union of every network in the database).
///
/// block-listed + unknown=block: unclassified IPs must be dropped in
/// addition to the listed countries → "not in known" is the drop test.
/// allow-listed + unknown=allow: unclassified IPs must be let through the
/// final drop → "not in known" is the return test.
/// The other two combinations fall out of the mode's default behaviour.
pub fn action_needs_known(action: &Action) -> bool {
    match (action.mode.as_deref(), action.unknown.as_str()) {
        (Some("block-listed"), "block") => true,
        (Some("allow-listed"), "allow") => true,
        _ => false,
    }
}

/// What an apply run must materialize, considering only enabled policies:
/// (upper-case country codes, whether the known sets are needed, action
/// names referenced by an enabled policy).
pub fn in_use(model: &Model) -> (BTreeSet<String>, bool, BTreeSet<String>) {
    let mut used_actions = BTreeSet::new();
    for policy in &model.policies {
        if let Some(action) = policy.action.as_deref() {
            if policy.enabled && model.actions.contains_key(action) {
                used_actions.insert(action.to_string());
            }
        }
    }
    let mut countries = BTreeSet::new();
    let mut need_known = false;
    for name in &used_actions {
        let action = &model.actions[name];
        countries.extend(action.countries.iter().map(|c| c.to_ascii_uppercase()));
        if action_needs_known(action) {
            need_known = true;
        }
    }
    (countries, need_known, used_actions)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn make_action() -> Action {
        Action {
            description: None,
            mode: Some("block-listed".into()),
            countries: vec!["CN".into(), "RU".into()],
            unknown: "allow".into(),
            log: false,
        }
    }

    pub fn make_policy() -> Policy {
        Policy {
            id: 10,
            action: Some("Block_bad".into()),
            ruleset: Some("forward".into()),
            rule: 20,
            direction: "both".into(),
            enabled: true,
        }
    }

    fn model_of(actions: &[(&str, Action)], policies: Vec<Policy>) -> Model {
        Model {
            actions: actions
                .iter()
                .map(|(n, a)| (n.to_string(), a.clone()))
                .collect(),
            policies,
        }
    }

    #[test]
    fn valid_model_passes() {
        let model = model_of(&[("Block_bad", make_action())], vec![make_policy()]);
        assert!(validate(&model, None).is_empty());
    }

    #[test]
    fn zero_countries_rejected_for_allow_listed() {
        let mut action = make_action();
        action.mode = Some("allow-listed".into());
        action.countries.clear();
        let model = model_of(&[("A", action)], vec![]);
        assert!(validate(&model, None)
            .iter()
            .any(|p| p.contains("at least one country")));
    }

    #[test]
    fn zero_countries_allowed_for_block_listed() {
        // block-listed + no countries = allow all (the default Global action).
        let mut action = make_action();
        action.countries.clear();
        let model = model_of(&[("Global", action)], vec![]);
        assert!(validate(&model, None).is_empty());
    }

    #[test]
    fn bad_country_code_rejected() {
        let mut action = make_action();
        action.countries = vec!["CHN".into()];
        let model = model_of(&[("A", action)], vec![]);
        assert!(validate(&model, None)
            .iter()
            .any(|p| p.contains("not a two-letter")));
    }

    #[test]
    fn unknown_country_rejected_when_db_present() {
        let mut action = make_action();
        action.countries = vec!["ZZ".into()];
        let model = model_of(&[("A", action)], vec![]);
        let known: BTreeSet<String> = ["CN", "US"].iter().map(|s| s.to_string()).collect();
        assert!(validate(&model, Some(&known))
            .iter()
            .any(|p| p.contains("not present in the location database")));
        // Without a database only the format is checked.
        assert!(validate(&model, None).is_empty());
    }

    #[test]
    fn missing_mode_rejected() {
        let mut action = make_action();
        action.mode = None;
        let model = model_of(&[("A", action)], vec![]);
        assert!(validate(&model, None)
            .iter()
            .any(|p| p.contains("mode must be set")));
    }

    #[test]
    fn bad_name_rejected() {
        let model = model_of(&[("has-hyphen", make_action())], vec![]);
        assert!(validate(&model, None)
            .iter()
            .any(|p| p.contains("must start with a letter")));
    }

    #[test]
    fn policy_referencing_missing_action_rejected() {
        let mut policy = make_policy();
        policy.action = Some("Ghost".into());
        let model = model_of(&[], vec![policy]);
        assert!(validate(&model, None)
            .iter()
            .any(|p| p.contains("references geolocation action \"Ghost\"")));
    }

    #[test]
    fn bad_direction_and_ruleset_rejected() {
        let mut policy = make_policy();
        policy.direction = "sideways".into();
        policy.ruleset = Some("postrouting".into());
        let model = model_of(&[("Block_bad", make_action())], vec![policy]);
        let problems = validate(&model, None);
        assert!(problems.iter().any(|p| p.contains("direction must be")));
        assert!(problems.iter().any(|p| p.contains("ruleset must be")));
    }

    #[test]
    fn only_enabled_policies_materialize_sets() {
        let mut a = make_action();
        a.countries = vec!["CN".into()];
        let mut b = make_action();
        b.countries = vec!["US".into()];
        let mut p1 = make_policy();
        p1.id = 1;
        p1.action = Some("A".into());
        let mut p2 = make_policy();
        p2.id = 2;
        p2.action = Some("B".into());
        p2.enabled = false;
        let model = model_of(&[("A", a), ("B", b)], vec![p1, p2]);
        let (countries, need_known, used) = in_use(&model);
        assert_eq!(countries.into_iter().collect::<Vec<_>>(), vec!["CN"]);
        assert_eq!(used.into_iter().collect::<Vec<_>>(), vec!["A"]);
        assert!(!need_known);
    }

    #[test]
    fn known_needed_for_the_right_mode_unknown_combinations() {
        let mut a = make_action();
        a.unknown = "block".into();
        assert!(action_needs_known(&a));
        a.unknown = "allow".into();
        assert!(!action_needs_known(&a));
        a.mode = Some("allow-listed".into());
        assert!(action_needs_known(&a));
        a.unknown = "block".into();
        assert!(!action_needs_known(&a));
    }
}
