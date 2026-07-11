//! Policy engine: parse → validate → compile `/run/qfappd/policy.json`.
//!
//! Schema v2 (named actions + per-rule bindings — see docs/design.md §5):
//!
//! ```json
//! {
//!   "version": 2,
//!   "actions": {
//!     "Global": {
//!       "default_action": "allow",
//!       "block_mode": "drop",
//!       "categories":   { "Adult": "block" },
//!       "applications": { "ChatGPT": "block" }
//!     }
//!   },
//!   "bindings": [
//!     { "id": 1, "action": "Global", "description": "LAN→WAN",
//!       "match": { "iifname": ["eth1"], "oifname": [], "saddr": [],
//!                  "daddr": [], "l4": [] } }
//!   ]
//! }
//! ```
//!
//! Precedence within an action: application > category > default.
//! Compilation flattens each action into a dense per-app-id verdict table so
//! the classification hot path is a single indexed load — no string lookups.
//!
//! [`PolicyManager`] enforces the last-known-good contract: an invalid file
//! (unparseable, failed validation, too many bound actions, malformed match
//! values) leaves the active policy untouched and records the error for
//! `GetStatus` / the WebUI. qfappd never falls back to allow-everything
//! because of a bad config push.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use crate::catalog::Catalog;
use crate::ctmark::Layout;

pub const SCHEMA_VERSION: u32 = 2;

// ── raw schema ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockMode {
    /// Silently drop packets of blocked flows.
    Drop,
    /// Drop, and additionally send TCP RST to both endpoints.
    Reset,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyFile {
    pub version: u32,
    #[serde(default)]
    pub actions: BTreeMap<String, ActionSpec>,
    #[serde(default)]
    pub bindings: Vec<BindingSpec>,
    /// Free-form; tolerated for compatibility with the v1 example.
    #[serde(default)]
    pub overrides_note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionSpec {
    pub default_action: Verdict,
    #[serde(default = "default_block_mode")]
    pub block_mode: BlockMode,
    #[serde(default)]
    pub categories: BTreeMap<String, Verdict>,
    #[serde(default)]
    pub applications: BTreeMap<String, Verdict>,
}

fn default_block_mode() -> BlockMode {
    BlockMode::Drop
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingSpec {
    /// Stable id from the WebUI (its firewall-rule linkage), used only for
    /// deterministic ordering and diagnostics — NOT the ct-mark ACTION_ID.
    pub id: u32,
    pub action: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub r#match: MatchSpec,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, default)]
pub struct MatchSpec {
    pub iifname: Vec<String>,
    pub oifname: Vec<String>,
    /// CIDRs or bare addresses; v4 and v6 may be mixed (nftgen splits them).
    pub saddr: Vec<String>,
    pub daddr: Vec<String>,
    pub l4: Vec<L4Match>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct L4Match {
    pub proto: L4Proto,
    #[serde(default)]
    pub dports: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum L4Proto {
    Tcp,
    Udp,
}

// ── compiled form ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CompiledAction {
    pub name: String,
    /// ct-mark ACTION_ID; 1-based, ≤ layout.max_action_id().
    pub action_id: u8,
    pub default_action: Verdict,
    pub block_mode: BlockMode,
    /// Dense verdict table indexed by nDPI app id. Ids beyond the table
    /// (newer signatures than the policy knew about) get `default_action`.
    verdicts: Vec<Verdict>,
    /// Parallel table: true where the verdict came from an explicit app or
    /// category rule (false where it fell through to `default_action`). Feeds
    /// the event's `default_applied` field.
    explicit: Vec<bool>,
}

impl CompiledAction {
    pub fn verdict(&self, app_id: u16) -> Verdict {
        self.verdicts
            .get(usize::from(app_id))
            .copied()
            .unwrap_or(self.default_action)
    }

    /// True when `app_id`'s verdict is the action default rather than an
    /// explicit app/category rule (unknown apps and unlisted apps included).
    pub fn is_default(&self, app_id: u16) -> bool {
        !self.explicit.get(usize::from(app_id)).copied().unwrap_or(false)
    }
}

#[derive(Debug, Clone)]
pub struct CompiledBinding {
    pub binding_id: u32,
    pub action_id: u8,
    pub action_name: String,
    pub description: String,
    pub match_spec: MatchSpec,
}

#[derive(Debug, Clone, Default)]
pub struct CompiledPolicy {
    /// Monotonic load counter, for GetStatus and log correlation.
    pub generation: u64,
    /// Indexed by `action_id - 1`.
    pub actions: Vec<CompiledAction>,
    /// In deterministic (binding id) order — this is what nftgen renders.
    pub bindings: Vec<CompiledBinding>,
    /// Non-fatal issues from the last successful load (unknown app or
    /// category names, e.g. after a signature downgrade).
    pub warnings: Vec<String>,
}

impl CompiledPolicy {
    pub fn action(&self, action_id: u8) -> Option<&CompiledAction> {
        if action_id == 0 {
            return None;
        }
        self.actions.get(usize::from(action_id) - 1)
    }
}

// ── validation errors ────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("read policy: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse policy: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported schema version {0} (expected {SCHEMA_VERSION})")]
    Version(u32),
    #[error("binding {binding_id} references unknown action {action:?}")]
    UnknownAction { binding_id: u32, action: String },
    #[error("duplicate binding id {0}")]
    DuplicateBinding(u32),
    #[error("{count} distinct actions bound but the mark layout supports at most {max} (widen [mark].action_bits or unbind an action)")]
    TooManyActions { count: usize, max: u8 },
    #[error("binding {binding_id}: invalid interface name {name:?}")]
    BadInterface { binding_id: u32, name: String },
    #[error("binding {binding_id}: invalid address/CIDR {addr:?}")]
    BadAddress { binding_id: u32, addr: String },
    #[error("binding {binding_id}: invalid port 0")]
    BadPort { binding_id: u32 },
}

/// nft-safe interface name: what Linux allows, minus anything that could
/// break out of a quoted nft string. 15 chars, no whitespace/quotes/slashes.
fn valid_ifname(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 15
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '@' | ':'))
}

pub fn parse_cidr(s: &str) -> Option<(IpAddr, u8)> {
    let (addr, plen) = match s.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (s, None),
    };
    let ip: IpAddr = addr.parse().ok()?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let plen = match plen {
        Some(p) => p.parse::<u8>().ok().filter(|&p| p <= max)?,
        None => max,
    };
    Some((ip, plen))
}

// ── compile ──────────────────────────────────────────────────────────────────

pub fn compile(
    file: &PolicyFile,
    catalog: &Catalog,
    layout: &Layout,
    generation: u64,
) -> Result<CompiledPolicy, PolicyError> {
    if file.version != SCHEMA_VERSION {
        return Err(PolicyError::Version(file.version));
    }

    let mut warnings = Vec::new();

    // Deterministic binding order; detect duplicate ids.
    let mut bindings = file.bindings.clone();
    bindings.sort_by_key(|b| b.id);
    for pair in bindings.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(PolicyError::DuplicateBinding(pair[0].id));
        }
    }

    // Validate match specs (they end up inside nft scripts run as root).
    for b in &bindings {
        for name in b.r#match.iifname.iter().chain(&b.r#match.oifname) {
            if !valid_ifname(name) {
                return Err(PolicyError::BadInterface { binding_id: b.id, name: name.clone() });
            }
        }
        for addr in b.r#match.saddr.iter().chain(&b.r#match.daddr) {
            if parse_cidr(addr).is_none() {
                return Err(PolicyError::BadAddress { binding_id: b.id, addr: addr.clone() });
            }
        }
        for l4 in &b.r#match.l4 {
            if l4.dports.contains(&0) {
                return Err(PolicyError::BadPort { binding_id: b.id });
            }
        }
    }

    // Assign ACTION_IDs 1..=max to distinct actions in binding order.
    let mut bound_names: Vec<&str> = Vec::new();
    for b in &bindings {
        if !file.actions.contains_key(&b.action) {
            return Err(PolicyError::UnknownAction { binding_id: b.id, action: b.action.clone() });
        }
        if !bound_names.contains(&b.action.as_str()) {
            bound_names.push(&b.action);
        }
    }
    if bound_names.len() > usize::from(layout.max_action_id()) {
        return Err(PolicyError::TooManyActions {
            count: bound_names.len(),
            max: layout.max_action_id(),
        });
    }

    let app_index = catalog.app_index();
    let category_index = catalog.category_index();
    let table_len = catalog
        .applications
        .iter()
        .map(|a| usize::from(a.id) + 1)
        .max()
        .unwrap_or(0);

    let mut actions = Vec::with_capacity(bound_names.len());
    for (i, name) in bound_names.iter().enumerate() {
        let spec = &file.actions[*name];
        let mut verdicts = vec![spec.default_action; table_len];
        let mut explicit = vec![false; table_len];

        // Categories first, then applications overwrite: app > category > default.
        for (cat, verdict) in &spec.categories {
            match category_index.get(&cat.to_ascii_lowercase()) {
                Some(ids) => {
                    for &id in ids {
                        verdicts[usize::from(id)] = *verdict;
                        explicit[usize::from(id)] = true;
                    }
                }
                None => warnings.push(format!("action {name:?}: unknown category {cat:?} (ignored)")),
            }
        }
        for (app, verdict) in &spec.applications {
            match app_index.get(&app.to_ascii_lowercase()) {
                Some(&id) => {
                    verdicts[usize::from(id)] = *verdict;
                    explicit[usize::from(id)] = true;
                }
                None => warnings.push(format!("action {name:?}: unknown application {app:?} (ignored)")),
            }
        }

        // App id 0 is "unknown": nDPI could not identify the flow, so the
        // action's default ("when application does not match") always applies.
        if let Some(v) = verdicts.get_mut(0) {
            *v = spec.default_action;
        }
        if let Some(e) = explicit.get_mut(0) {
            *e = false;
        }

        actions.push(CompiledAction {
            name: (*name).to_owned(),
            action_id: (i + 1) as u8,
            default_action: spec.default_action,
            block_mode: spec.block_mode,
            verdicts,
            explicit,
        });
    }

    let compiled_bindings = bindings
        .iter()
        .map(|b| {
            let action_id = actions.iter().find(|a| a.name == b.action).map(|a| a.action_id).expect("validated above");
            CompiledBinding {
                binding_id: b.id,
                action_id,
                action_name: b.action.clone(),
                description: b.description.clone(),
                match_spec: b.r#match.clone(),
            }
        })
        .collect();

    Ok(CompiledPolicy { generation, actions, bindings: compiled_bindings, warnings })
}

// ── last-known-good manager ──────────────────────────────────────────────────

/// Owns the active policy and the last-known-good contract. Reads are
/// lock-free clones of an `Arc` so the hot path never blocks on a reload.
pub struct PolicyManager {
    current: Arc<CompiledPolicy>,
    generation: u64,
    last_error: Option<String>,
}

impl PolicyManager {
    /// Starts with an empty policy (no bindings → nothing queued → all
    /// traffic flows untouched) until the first file load.
    pub fn new() -> Self {
        Self { current: Arc::new(CompiledPolicy::default()), generation: 0, last_error: None }
    }

    pub fn current(&self) -> Arc<CompiledPolicy> {
        Arc::clone(&self.current)
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Attempt to replace the active policy. On any failure the previous
    /// policy stays active and the error is recorded and returned.
    pub fn load_str(
        &mut self,
        text: &str,
        catalog: &Catalog,
        layout: &Layout,
    ) -> Result<Arc<CompiledPolicy>, PolicyError> {
        let result = serde_json::from_str::<PolicyFile>(text)
            .map_err(PolicyError::from)
            .and_then(|file| compile(&file, catalog, layout, self.generation + 1));
        match result {
            Ok(compiled) => {
                self.generation += 1;
                self.current = Arc::new(compiled);
                self.last_error = None;
                Ok(self.current())
            }
            Err(e) => {
                self.last_error = Some(e.to_string());
                Err(e)
            }
        }
    }

    pub fn load_path(
        &mut self,
        path: &Path,
        catalog: &Catalog,
        layout: &Layout,
    ) -> Result<Arc<CompiledPolicy>, PolicyError> {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                let e = PolicyError::from(e);
                self.last_error = Some(e.to_string());
                return Err(e);
            }
        };
        self.load_str(&text, catalog, layout)
    }
}

impl Default for PolicyManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_policy() -> String {
        serde_json::json!({
            "version": 2,
            "actions": {
                "Global": {
                    "default_action": "allow",
                    "block_mode": "drop",
                    "categories": { "Adult": "block", "AI": "block" },
                    "applications": { "ChatGPT": "allow", "BitTorrent": "block" }
                },
                "Strict": {
                    "default_action": "block",
                    "block_mode": "reset",
                    "applications": { "DNS": "allow", "TLS": "allow" }
                }
            },
            "bindings": [
                { "id": 20, "action": "Strict", "match": { "iifname": ["eth2"] } },
                { "id": 10, "action": "Global",
                  "match": { "iifname": ["eth1"], "oifname": ["eth0"],
                             "saddr": ["10.0.1.0/24"], "l4": [ { "proto": "tcp", "dports": [443] } ] } }
            ]
        })
        .to_string()
    }

    fn load(text: &str) -> Result<CompiledPolicy, PolicyError> {
        let file: PolicyFile = serde_json::from_str(text)?;
        compile(&file, &Catalog::fixture(), &Layout::default(), 1)
    }

    #[test]
    fn precedence_app_over_category_over_default() {
        let p = load(&fixture_policy()).unwrap();
        let global = p.action(1).unwrap();
        assert_eq!(global.name, "Global");
        // category rule: Adult → block
        assert_eq!(global.verdict(211), Verdict::Block); // PornHub via Adult
        // app rule beats category: ChatGPT is AI (block) but app says allow
        assert_eq!(global.verdict(244), Verdict::Allow);
        // category applies to other members: Claude is AI → block
        assert_eq!(global.verdict(245), Verdict::Block);
        // app rule with no category rule
        assert_eq!(global.verdict(37), Verdict::Block); // BitTorrent
        // untouched app falls to default allow
        assert_eq!(global.verdict(124), Verdict::Allow); // YouTube
        // unknown (id 0) gets the default action
        assert_eq!(global.verdict(0), Verdict::Allow);
        // app id newer than the catalog → default
        assert_eq!(global.verdict(1999), Verdict::Allow);

        // is_default tracks explicit vs fall-through
        assert!(!global.is_default(211)); // Adult category rule
        assert!(!global.is_default(244)); // ChatGPT app rule
        assert!(!global.is_default(245)); // Claude via AI category
        assert!(global.is_default(124)); // YouTube — no rule
        assert!(global.is_default(0)); // unknown
        assert!(global.is_default(1999)); // beyond table
    }

    #[test]
    fn default_block_action() {
        let p = load(&fixture_policy()).unwrap();
        let strict = p.action(2).unwrap();
        assert_eq!(strict.default_action, Verdict::Block);
        assert_eq!(strict.block_mode, BlockMode::Reset);
        assert_eq!(strict.verdict(5), Verdict::Allow); // DNS
        assert_eq!(strict.verdict(91), Verdict::Allow); // TLS
        assert_eq!(strict.verdict(124), Verdict::Block); // YouTube → default block
        assert_eq!(strict.verdict(0), Verdict::Block); // unknown → default block
    }

    #[test]
    fn action_id_assignment_is_deterministic_by_binding_id() {
        let p = load(&fixture_policy()).unwrap();
        // binding 10 (Global) sorts before binding 20 (Strict)
        assert_eq!(p.bindings[0].binding_id, 10);
        assert_eq!(p.bindings[0].action_id, 1);
        assert_eq!(p.bindings[1].action_id, 2);
        assert_eq!(p.action(1).unwrap().name, "Global");
        assert_eq!(p.action(2).unwrap().name, "Strict");
        assert!(p.action(0).is_none());
    }

    #[test]
    fn unknown_names_warn_but_load() {
        let text = serde_json::json!({
            "version": 2,
            "actions": { "A": { "default_action": "allow",
                "categories": { "NoSuchCategory": "block" },
                "applications": { "NoSuchApp": "block" } } },
            "bindings": [ { "id": 1, "action": "A" } ]
        })
        .to_string();
        let p = load(&text).unwrap();
        assert_eq!(p.warnings.len(), 2);
    }

    #[test]
    fn rejects_bad_version_unknown_action_dupes_and_injection() {
        assert!(matches!(load(r#"{"version":1,"actions":{},"bindings":[]}"#), Err(PolicyError::Version(1))));

        let unknown = serde_json::json!({ "version": 2, "actions": {},
            "bindings": [ { "id": 1, "action": "Ghost" } ] }).to_string();
        assert!(matches!(load(&unknown), Err(PolicyError::UnknownAction { .. })));

        let dup = serde_json::json!({ "version": 2,
            "actions": { "A": { "default_action": "allow" } },
            "bindings": [ { "id": 1, "action": "A" }, { "id": 1, "action": "A" } ] }).to_string();
        assert!(matches!(load(&dup), Err(PolicyError::DuplicateBinding(1))));

        let inj = serde_json::json!({ "version": 2,
            "actions": { "A": { "default_action": "allow" } },
            "bindings": [ { "id": 1, "action": "A",
                "match": { "iifname": ["eth0\" accept comment \""] } } ] }).to_string();
        assert!(matches!(load(&inj), Err(PolicyError::BadInterface { .. })));

        let addr = serde_json::json!({ "version": 2,
            "actions": { "A": { "default_action": "allow" } },
            "bindings": [ { "id": 1, "action": "A",
                "match": { "saddr": ["10.0.0.0/33"] } } ] }).to_string();
        assert!(matches!(load(&addr), Err(PolicyError::BadAddress { .. })));
    }

    #[test]
    fn too_many_bound_actions_rejected() {
        let mut actions = serde_json::Map::new();
        let mut bindings = Vec::new();
        for i in 1..=8 {
            actions.insert(
                format!("A{i}"),
                serde_json::json!({ "default_action": "allow" }),
            );
            bindings.push(serde_json::json!({ "id": i, "action": format!("A{i}") }));
        }
        let text = serde_json::json!({ "version": 2, "actions": actions, "bindings": bindings }).to_string();
        assert!(matches!(load(&text), Err(PolicyError::TooManyActions { count: 8, max: 7 })));
    }

    #[test]
    fn unbound_actions_do_not_consume_ids() {
        let text = serde_json::json!({
            "version": 2,
            "actions": {
                "Bound": { "default_action": "allow" },
                "Spare1": { "default_action": "block" },
                "Spare2": { "default_action": "block" }
            },
            "bindings": [ { "id": 1, "action": "Bound" } ]
        })
        .to_string();
        let p = load(&text).unwrap();
        assert_eq!(p.actions.len(), 1);
    }

    #[test]
    fn manager_keeps_last_known_good_on_invalid_push() {
        let catalog = Catalog::fixture();
        let layout = Layout::default();
        let mut mgr = PolicyManager::new();

        mgr.load_str(&fixture_policy(), &catalog, &layout).unwrap();
        assert_eq!(mgr.generation(), 1);
        let good = mgr.current();
        assert_eq!(good.actions.len(), 2);
        assert!(mgr.last_error().is_none());

        // garbage JSON
        assert!(mgr.load_str("{ nope", &catalog, &layout).is_err());
        assert_eq!(mgr.generation(), 1, "generation unchanged on failure");
        assert_eq!(mgr.current().actions.len(), 2, "old policy still active");
        assert!(mgr.last_error().unwrap().contains("parse policy"));

        // semantically invalid
        let bad = r#"{"version":2,"actions":{},"bindings":[{"id":1,"action":"Ghost"}]}"#;
        assert!(mgr.load_str(bad, &catalog, &layout).is_err());
        assert_eq!(mgr.current().actions.len(), 2);
        assert!(mgr.last_error().unwrap().contains("Ghost"));

        // a good push clears the error
        mgr.load_str(&fixture_policy(), &catalog, &layout).unwrap();
        assert_eq!(mgr.generation(), 2);
        assert!(mgr.last_error().is_none());
    }

    #[test]
    fn manager_load_path_missing_file_keeps_policy() {
        let catalog = Catalog::fixture();
        let layout = Layout::default();
        let mut mgr = PolicyManager::new();
        mgr.load_str(&fixture_policy(), &catalog, &layout).unwrap();
        assert!(mgr
            .load_path(Path::new("/nonexistent/policy.json"), &catalog, &layout)
            .is_err());
        assert_eq!(mgr.current().actions.len(), 2);
    }

    #[test]
    fn empty_policy_is_valid_and_binds_nothing() {
        let p = load(r#"{"version":2,"actions":{},"bindings":[]}"#).unwrap();
        assert!(p.actions.is_empty());
        assert!(p.bindings.is_empty());
    }
}
