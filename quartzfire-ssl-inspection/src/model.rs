//! Normalized SSL-inspection model + validation.
//!
//! Plain data so the same validation runs in the conf-mode owner's verify
//! stage (authoritative — a failure aborts the commit), the standalone resync
//! (defensive), and the unit tests. Mirrors quartzfire-geoip's model.rs.

use serde::{Deserialize, Serialize};

pub const DEFAULT_ACTIONS: [&str; 2] = ["inspect", "splice"];
pub const UPSTREAM_INVALID: [&str; 2] = ["block", "allow"];
pub const FAIL_MODES: [&str; 2] = ["closed", "open"];

pub const DEFAULT_INTERCEPT_PORT: u16 = 3129;
pub const DEFAULT_ICAP_HOST: &str = "127.0.0.1";
pub const DEFAULT_ICAP_PORT: u16 = 1344;
pub const DEFAULT_REQMOD_SERVICE: &str = "request";
pub const DEFAULT_RESPMOD_SERVICE: &str = "response";

/// The content-filter (ICAP) seam. Present in the config tree ⇒ Squid emits an
/// adaptation block pointing at this endpoint. Absent ⇒ no ICAP at all (the
/// default). No filtering engine ships in this task; this only wires the seam
/// so e2guardian / c-icap becomes a drop-in later. See docs/design.md — Squid
/// stays the sole TLS terminator; whatever attaches here receives already
/// decrypted plaintext HTTP and must NEVER do its own TLS MITM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentFilter {
    #[serde(default = "default_icap_host")]
    pub icap_host: String,
    #[serde(default = "default_icap_port")]
    pub icap_port: u16,
    #[serde(default = "default_reqmod_service")]
    pub reqmod_service: String,
    #[serde(default = "default_respmod_service")]
    pub respmod_service: String,
    /// fail-closed (default) ⇒ Squid `bypass=off`: if the filter is enabled and
    /// its ICAP service is down, traffic FAILS CLOSED rather than silently
    /// passing uninspected.
    #[serde(default = "default_fail_mode")]
    pub fail_mode: String,
}

fn default_icap_host() -> String {
    DEFAULT_ICAP_HOST.into()
}
fn default_icap_port() -> u16 {
    DEFAULT_ICAP_PORT
}
fn default_reqmod_service() -> String {
    DEFAULT_REQMOD_SERVICE.into()
}
fn default_respmod_service() -> String {
    DEFAULT_RESPMOD_SERVICE.into()
}
fn default_fail_mode() -> String {
    "closed".into()
}

impl Default for ContentFilter {
    fn default() -> Self {
        ContentFilter {
            icap_host: default_icap_host(),
            icap_port: default_icap_port(),
            reqmod_service: default_reqmod_service(),
            respmod_service: default_respmod_service(),
            fail_mode: default_fail_mode(),
        }
    }
}

impl ContentFilter {
    pub fn fail_closed(&self) -> bool {
        self.fail_mode != "open"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_intercept_port")]
    pub intercept_port: u16,
    /// Interfaces inspection applies to — drives the nftables redirect and the
    /// CA-distribution reachability guard. Never inspect on a WAN/untrusted
    /// interface unless the admin explicitly lists it.
    #[serde(default)]
    pub interfaces: Vec<String>,
    /// inspect all / splice all — the fall-through when nothing matches the
    /// no-inspect list.
    #[serde(default = "default_action")]
    pub default_action: String,
    /// User-managed do-not-inspect (splice) domains, editable from the UI.
    #[serde(default)]
    pub no_inspect: Vec<String>,
    /// Whether the shipped default exclusion baseline (banking/healthcare/gov/
    /// cert-pinned) is applied on top of the user list. Removable as a whole so
    /// an admin who wants to inspect everything can.
    #[serde(default = "default_true")]
    pub default_exclusions: bool,
    /// Upstream (origin) cert validation failure handling. Block by default.
    #[serde(default = "default_upstream_invalid")]
    pub upstream_invalid: String,
    /// The ICAP seam — None ⇒ no content filter attached (default).
    #[serde(default)]
    pub content_filter: Option<ContentFilter>,
    /// Interfaces the plain-HTTP :4126 CA-download page is reachable on.
    /// Defaults to the inspection `interfaces` when unset; never WAN.
    #[serde(default)]
    pub ca_download_interfaces: Vec<String>,
}

fn default_intercept_port() -> u16 {
    DEFAULT_INTERCEPT_PORT
}
fn default_action() -> String {
    "inspect".into()
}
fn default_upstream_invalid() -> String {
    "block".into()
}
fn default_true() -> bool {
    true
}

impl Default for Model {
    fn default() -> Self {
        Model {
            enabled: false,
            intercept_port: DEFAULT_INTERCEPT_PORT,
            interfaces: Vec::new(),
            default_action: default_action(),
            no_inspect: Vec::new(),
            default_exclusions: true,
            upstream_invalid: default_upstream_invalid(),
            content_filter: None,
            ca_download_interfaces: Vec::new(),
        }
    }
}

impl Model {
    /// Interfaces the CA-download page binds/allows on — the explicit list, or
    /// the inspection scope as a sensible LAN default.
    pub fn ca_download_scope(&self) -> &[String] {
        if self.ca_download_interfaces.is_empty() {
            &self.interfaces
        } else {
            &self.ca_download_interfaces
        }
    }
}

/// nftables/ifname sanity — matches Linux interface naming (letters, digits,
/// and `.`/`-`/`_`, up to IFNAMSIZ-1). Rejects the shell-metacharacter and
/// whitespace injection a rendered nft ruleset would choke on.
pub fn iface_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 15
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A do-not-inspect entry as accepted by Squid's `ssl::server_name` file: a
/// hostname, a `.suffix` (subdomain match), or a `*.` wildcard. Kept strict so
/// a bad line can't smuggle anything into the rendered file.
pub fn domain_pattern_ok(pat: &str) -> bool {
    let core = pat.strip_prefix("*.").or_else(|| pat.strip_prefix('.')).unwrap_or(pat);
    if core.is_empty() || core.len() > 253 {
        return false;
    }
    core.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Return human-readable problems (empty = valid). `bump_capable` /
/// `icap_capable` come from the live `squid -v` probe (None = not checked, e.g.
/// off-device); when Some(false) and the feature needs it, that is a hard
/// error so a build lacking the support fails the commit loudly instead of
/// silently not inspecting.
pub fn validate(
    model: &Model,
    bump_capable: Option<bool>,
    icap_capable: Option<bool>,
) -> Vec<String> {
    let mut problems = Vec::new();
    if !model.enabled {
        // A disabled feature is always a valid teardown; nothing else matters.
        return problems;
    }

    if model.intercept_port < 1024 {
        problems.push(format!(
            "intercept-port must be a non-privileged port (1024-65535); got {}",
            model.intercept_port
        ));
    }
    if !DEFAULT_ACTIONS.contains(&model.default_action.as_str()) {
        problems.push(format!(
            "default-action must be inspect or splice (got \"{}\")",
            model.default_action
        ));
    }
    if !UPSTREAM_INVALID.contains(&model.upstream_invalid.as_str()) {
        problems.push(format!(
            "upstream-invalid must be block or allow (got \"{}\")",
            model.upstream_invalid
        ));
    }
    if model.interfaces.is_empty() {
        problems.push(
            "at least one interface must be in the inspection scope — refusing to \
             enable SSL inspection with no interfaces (nothing would be intercepted)"
                .to_string(),
        );
    }
    for i in model.interfaces.iter().chain(model.ca_download_interfaces.iter()) {
        if !iface_ok(i) {
            problems.push(format!("\"{i}\" is not a valid interface name"));
        }
    }
    for d in &model.no_inspect {
        if !domain_pattern_ok(d) {
            problems.push(format!(
                "do-not-inspect entry \"{d}\" is not a valid domain pattern \
                 (use example.com, .example.com, or *.example.com)"
            ));
        }
    }

    // A build without OpenSSL ssl_bump support can never inspect — fail loudly.
    if bump_capable == Some(false) {
        problems.push(
            "the installed Squid was built WITHOUT OpenSSL ssl_bump support \
             (squid -v shows no --with-openssl/--enable-ssl-crtd) — install the \
             squid-openssl package. Refusing to enable inspection that cannot work."
                .to_string(),
        );
    }

    if let Some(cf) = &model.content_filter {
        if !FAIL_MODES.contains(&cf.fail_mode.as_str()) {
            problems.push(format!(
                "content-filter fail-mode must be closed or open (got \"{}\")",
                cf.fail_mode
            ));
        }
        if cf.icap_host.trim().is_empty() {
            problems.push("content-filter icap-host must not be empty".to_string());
        }
        if cf.icap_port == 0 {
            problems.push("content-filter icap-port must be 1-65535".to_string());
        }
        // The ICAP block is emitted only with a filter engine configured; that
        // needs an ICAP-capable Squid build.
        if icap_capable == Some(false) {
            problems.push(
                "a content filter (ICAP) is configured but the installed Squid was \
                 built WITHOUT --enable-icap-client — install squid-openssl."
                    .to_string(),
            );
        }
    }

    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_model() -> Model {
        Model {
            enabled: true,
            interfaces: vec!["eth1".into()],
            ..Model::default()
        }
    }

    #[test]
    fn default_model_disabled_is_valid() {
        assert!(validate(&Model::default(), Some(true), Some(true)).is_empty());
    }

    #[test]
    fn minimal_enabled_model_valid() {
        assert!(validate(&enabled_model(), Some(true), Some(true)).is_empty());
    }

    #[test]
    fn enabled_without_interfaces_rejected() {
        let mut m = enabled_model();
        m.interfaces.clear();
        assert!(validate(&m, Some(true), None)
            .iter()
            .any(|p| p.contains("at least one interface")));
    }

    #[test]
    fn build_without_bump_fails_loudly() {
        let problems = validate(&enabled_model(), Some(false), None);
        assert!(problems.iter().any(|p| p.contains("WITHOUT OpenSSL ssl_bump")));
    }

    #[test]
    fn content_filter_needs_icap_build() {
        let mut m = enabled_model();
        m.content_filter = Some(ContentFilter::default());
        let problems = validate(&m, Some(true), Some(false));
        assert!(problems.iter().any(|p| p.contains("--enable-icap-client")));
    }

    #[test]
    fn bad_action_and_upstream_rejected() {
        let mut m = enabled_model();
        m.default_action = "mangle".into();
        m.upstream_invalid = "maybe".into();
        let problems = validate(&m, Some(true), None);
        assert!(problems.iter().any(|p| p.contains("default-action must be")));
        assert!(problems.iter().any(|p| p.contains("upstream-invalid must be")));
    }

    #[test]
    fn bad_fail_mode_rejected() {
        let mut m = enabled_model();
        m.content_filter = Some(ContentFilter {
            fail_mode: "sideways".into(),
            ..ContentFilter::default()
        });
        assert!(validate(&m, Some(true), Some(true))
            .iter()
            .any(|p| p.contains("fail-mode must be")));
    }

    #[test]
    fn fail_closed_is_the_default() {
        assert!(ContentFilter::default().fail_closed());
        assert!(!ContentFilter { fail_mode: "open".into(), ..ContentFilter::default() }.fail_closed());
    }

    #[test]
    fn domain_patterns() {
        assert!(domain_pattern_ok("example.com"));
        assert!(domain_pattern_ok(".example.com"));
        assert!(domain_pattern_ok("*.mozilla.org"));
        assert!(domain_pattern_ok("a-b.co.uk"));
        assert!(!domain_pattern_ok(""));
        assert!(!domain_pattern_ok("bad_underscore.com"));
        assert!(!domain_pattern_ok("-lead.com"));
        assert!(!domain_pattern_ok("space in.com"));
        assert!(!domain_pattern_ok("semi;colon.com"));
    }

    #[test]
    fn iface_names() {
        assert!(iface_ok("eth0"));
        assert!(iface_ok("eth0.100"));
        assert!(iface_ok("bond0-lan"));
        assert!(!iface_ok(""));
        assert!(!iface_ok("eth0; rm -rf /"));
        assert!(!iface_ok("way-too-long-iface-name"));
    }

    #[test]
    fn invalid_domain_pattern_flagged_when_enabled() {
        let mut m = enabled_model();
        m.no_inspect = vec!["bad name".into()];
        assert!(validate(&m, Some(true), None)
            .iter()
            .any(|p| p.contains("not a valid domain pattern")));
    }

    #[test]
    fn ca_download_scope_defaults_to_inspection_scope() {
        let m = enabled_model();
        assert_eq!(m.ca_download_scope(), &["eth1".to_string()]);
        let m2 = Model {
            ca_download_interfaces: vec!["eth2".into()],
            ..enabled_model()
        };
        assert_eq!(m2.ca_download_scope(), &["eth2".to_string()]);
    }
}
