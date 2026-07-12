//! Read the SSL-inspection model out of the VyOS config via `cli-shell-api` —
//! the same C++ tool the vyos-1x Python Config class wraps — so this compiled
//! binary can act as the `service quartzfire ssl-inspection` conf-mode owner.
//!
//! Two views: session (inside a commit, the proposed config) and active (the
//! running config, for the standalone resync). Only the primitive verbs are
//! used, deliberately — vyos-1x's higher-level config dictionaries consult its
//! XML reference cache, which knows nothing about nodes this package adds.
//! Identical machinery to quartzfire-geoip's config.rs.

use std::process::Command;

use crate::model::{ContentFilter, Model};

pub const BASE: [&str; 3] = ["service", "quartzfire", "ssl-inspection"];

pub trait ConfigRead {
    fn exists(&self, path: &[&str]) -> bool;
    /// Enumerate tag-node children. Unused by ssl-inspection today (its tree has
    /// only leaves + one tag-less `content-filter` node), but kept on the trait
    /// so the reader machinery stays a drop-in match for geoip's.
    #[allow(dead_code)]
    fn list_nodes(&self, path: &[&str]) -> Vec<String>;
    fn return_value(&self, path: &[&str]) -> Option<String>;
    fn return_values(&self, path: &[&str]) -> Vec<String>;
}

pub struct CliShellApi {
    active: bool,
}

impl CliShellApi {
    pub fn session() -> Self {
        Self { active: false }
    }
    /// The running-config view. The standalone resync works from the committed
    /// desired.json snapshot (there is no live drift to reconcile as geoip has),
    /// so this is currently unused — kept for parity and future use.
    #[allow(dead_code)]
    pub fn active() -> Self {
        Self { active: true }
    }

    fn run(&self, verb: &str, path: &[&str]) -> Option<String> {
        let output = Command::new("cli-shell-api").arg(verb).args(path).output().ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// cli-shell-api list output: whitespace-separated single-quoted tokens
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
}

fn join<'a>(base: &[&'a str], rest: &[&'a str]) -> Vec<&'a str> {
    base.iter().chain(rest.iter()).copied().collect()
}

/// Full path to the valueless `enable` node — used by the commit owner to
/// detect the off→on transition (session has it, the active config did not).
pub fn join_enable() -> Vec<&'static str> {
    join(&BASE, &["enable"])
}

/// The `service quartzfire ssl-inspection` subtree as a normalized model.
pub fn read_service(conf: &dyn ConfigRead) -> Model {
    let mut model = Model::default();
    if !conf.exists(&BASE) {
        return model;
    }
    model.enabled = conf.exists(&join(&BASE, &["enable"]));
    if let Some(p) = conf.return_value(&join(&BASE, &["intercept-port"])).and_then(|v| v.parse().ok()) {
        model.intercept_port = p;
    }
    model.interfaces = conf.return_values(&join(&BASE, &["interface"]));
    if let Some(a) = conf.return_value(&join(&BASE, &["default-action"])) {
        model.default_action = a;
    }
    model.no_inspect = conf.return_values(&join(&BASE, &["no-inspect"]));
    model.default_exclusions = !conf.exists(&join(&BASE, &["disable-default-exclusions"]));
    if let Some(u) = conf.return_value(&join(&BASE, &["upstream-invalid"])) {
        model.upstream_invalid = u;
    }
    model.ca_download_interfaces =
        conf.return_values(&join(&BASE, &["ca-download", "interface"]));

    if conf.exists(&join(&BASE, &["content-filter"])) {
        let cf_base = join(&BASE, &["content-filter"]);
        let mut cf = ContentFilter::default();
        if let Some(h) = conf.return_value(&join(&cf_base, &["icap-host"])) {
            cf.icap_host = h;
        }
        if let Some(p) = conf.return_value(&join(&cf_base, &["icap-port"])).and_then(|v| v.parse().ok()) {
            cf.icap_port = p;
        }
        if let Some(s) = conf.return_value(&join(&cf_base, &["reqmod-service"])) {
            cf.reqmod_service = s;
        }
        if let Some(s) = conf.return_value(&join(&cf_base, &["respmod-service"])) {
            cf.respmod_service = s;
        }
        if let Some(f) = conf.return_value(&join(&cf_base, &["fail-mode"])) {
            cf.fail_mode = f;
        }
        model.content_filter = Some(cf);
    }

    model
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// In-memory fake: a set of existing paths + single/multi values, keyed by
    /// the space-joined path. Mirrors the geoip test fake style.
    #[derive(Default)]
    struct Fake {
        present: BTreeSet<String>,
        values: std::collections::BTreeMap<String, String>,
        multi: std::collections::BTreeMap<String, Vec<String>>,
    }
    impl Fake {
        fn key(path: &[&str]) -> String {
            path.join(" ")
        }
        fn set(&mut self, path: &[&str]) {
            // Mark this path and all ancestors present.
            for i in 1..=path.len() {
                self.present.insert(Self::key(&path[..i]));
            }
        }
        fn value(&mut self, path: &[&str], v: &str) {
            self.set(path);
            self.values.insert(Self::key(path), v.to_string());
        }
        fn values_of(&mut self, path: &[&str], vs: &[&str]) {
            self.set(path);
            self.multi.insert(Self::key(path), vs.iter().map(|s| s.to_string()).collect());
        }
    }
    impl ConfigRead for Fake {
        fn exists(&self, path: &[&str]) -> bool {
            self.present.contains(&Self::key(path))
        }
        fn list_nodes(&self, _path: &[&str]) -> Vec<String> {
            Vec::new()
        }
        fn return_value(&self, path: &[&str]) -> Option<String> {
            self.values.get(&Self::key(path)).cloned()
        }
        fn return_values(&self, path: &[&str]) -> Vec<String> {
            self.multi.get(&Self::key(path)).cloned().unwrap_or_default()
        }
    }

    #[test]
    fn absent_tree_is_disabled_default() {
        let m = read_service(&Fake::default());
        assert!(!m.enabled);
        assert_eq!(m.intercept_port, 3129);
        assert!(m.default_exclusions);
    }

    #[test]
    fn reads_full_model() {
        let mut f = Fake::default();
        f.set(&["service", "quartzfire", "ssl-inspection", "enable"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "intercept-port"], "3130");
        f.values_of(&["service", "quartzfire", "ssl-inspection", "interface"], &["eth1", "eth2"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "default-action"], "inspect");
        f.values_of(&["service", "quartzfire", "ssl-inspection", "no-inspect"], &["internal.example"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "upstream-invalid"], "allow");
        f.set(&["service", "quartzfire", "ssl-inspection", "content-filter"]);
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "icap-host"], "10.0.0.9");
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "icap-port"], "1345");
        f.value(&["service", "quartzfire", "ssl-inspection", "content-filter", "fail-mode"], "open");

        let m = read_service(&f);
        assert!(m.enabled);
        assert_eq!(m.intercept_port, 3130);
        assert_eq!(m.interfaces, vec!["eth1", "eth2"]);
        assert_eq!(m.no_inspect, vec!["internal.example"]);
        assert_eq!(m.upstream_invalid, "allow");
        let cf = m.content_filter.expect("content filter present");
        assert_eq!(cf.icap_host, "10.0.0.9");
        assert_eq!(cf.icap_port, 1345);
        assert_eq!(cf.fail_mode, "open");
    }

    #[test]
    fn disable_default_exclusions_flag() {
        let mut f = Fake::default();
        f.set(&["service", "quartzfire", "ssl-inspection", "enable"]);
        f.set(&["service", "quartzfire", "ssl-inspection", "disable-default-exclusions"]);
        let m = read_service(&f);
        assert!(!m.default_exclusions);
    }

    #[test]
    fn quoted_list_parses() {
        assert_eq!(parse_quoted_list("'eth0' 'eth1'"), vec!["eth0", "eth1"]);
        assert_eq!(parse_quoted_list("'with space' 'b'"), vec!["with space", "b"]);
        assert_eq!(parse_quoted_list(""), Vec::<String>::new());
    }
}
