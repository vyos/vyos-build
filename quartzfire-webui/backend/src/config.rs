use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

/// Runtime configuration, loaded from `/etc/quartzfire/webui.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Address the axum server binds to. nginx reverse-proxies to this.
    #[serde(default = "default_listen")]
    pub listen: String,

    /// Base URL of the local VyOS HTTP API (`vyos-http-api-tools`).
    #[serde(default = "default_vyos_api_url")]
    pub vyos_api_url: String,

    /// File containing the VyOS API key. Kept out of the config so it can be
    /// managed / permissioned separately (mode 0600, root-only).
    #[serde(default = "default_key_file")]
    pub vyos_api_key_file: PathBuf,

    /// Directory holding the exported Next.js frontend.
    #[serde(default = "default_www_root")]
    pub www_root: PathBuf,

    /// File holding the JWT session-signing secret. Generated on first start
    /// if absent; the systemd unit's `StateDirectory=` makes it writable.
    #[serde(default = "default_jwt_secret_file")]
    pub jwt_secret_file: PathBuf,

    /// Mark the session cookie `Secure` (HTTPS-only). True in production —
    /// nginx always terminates TLS; set false only for plain-HTTP local dev.
    #[serde(default = "default_cookie_secure")]
    pub cookie_secure: bool,

    /// Session (JWT + cookie) lifetime in hours.
    #[serde(default = "default_session_hours")]
    pub session_hours: u64,

    /// Desired IPS state, applied by the root `ips-apply` helper. Lives under
    /// `/config` so it survives image upgrades. The webui unit grants write
    /// access via `ReadWritePaths=`; the helper's boot run creates the
    /// directory group-writable.
    #[serde(default = "default_ips_settings_file")]
    pub ips_settings_file: PathBuf,

    /// The helper's last apply report (read-only for us).
    #[serde(default = "default_ips_status_file")]
    pub ips_status_file: PathBuf,

    /// Directory the commit-confirm guard stages config files in (snapshot
    /// reverts, restores, rollbacks). Must be writable by us AND readable by
    /// the root VyOS API process (`config-file load` takes a path) — the
    /// shared `/config/quartzfire` dir fits; `PrivateTmp` rules out /tmp.
    #[serde(default = "default_guard_dir")]
    pub guard_dir: PathBuf,

    /// Persistent EVE alert log Suricata writes (read-only for us) — where
    /// alerts live across reboots; backs /api/ips/alerts/history.
    #[serde(default = "default_ips_alerts_file")]
    pub ips_alerts_file: PathBuf,

    /// Desired Application Control state, applied by the root `qfappd-apply`
    /// helper. Lives under `/config` so it survives image upgrades (same
    /// contract as the IPS settings file).
    #[serde(default = "default_appcontrol_settings_file")]
    pub appcontrol_settings_file: PathBuf,

    /// qfappd's runtime status snapshot (read-only for us): policy generation,
    /// last error, per-queue counters, classification stats.
    #[serde(default = "default_appcontrol_status_file")]
    pub appcontrol_status_file: PathBuf,

    /// qfappd's nDPI application catalog, written at daemon startup (read-only
    /// for us) — backs the Actions editor's category/app tree.
    #[serde(default = "default_appcontrol_catalog_file")]
    pub appcontrol_catalog_file: PathBuf,

    /// qfappd's persistent decision-event log (read-only for us) — backs
    /// /api/appcontrol/alerts/history across reboots.
    #[serde(default = "default_appcontrol_events_file")]
    pub appcontrol_events_file: PathBuf,

    /// qfappd-apply's last-run report (read-only for us). Validation happens
    /// before the policy reaches qfappd, so a refused desired state is only
    /// visible here — qfappd's own status shows no error for it.
    #[serde(default = "default_appcontrol_apply_file")]
    pub appcontrol_apply_file: PathBuf,

    /// Geolocation status report (read-only for us), merged by the root
    /// geoip-apply/geoip-update helpers: database version, last update,
    /// signature status, apply result, per-set entry counts, policy errors.
    #[serde(default = "default_geoip_status_file")]
    pub geoip_status_file: PathBuf,

    /// Per-action geolocation hit counters (read-only), dumped by the
    /// quartzfire-geoip-counters timer while the qz_geo table is loaded.
    #[serde(default = "default_geoip_counters_file")]
    pub geoip_counters_file: PathBuf,

    /// Selectable country list dumped from the libloc database (read-only);
    /// absent until the first successful database download.
    #[serde(default = "default_geoip_countries_file")]
    pub geoip_countries_file: PathBuf,

    /// Active-connections-by-country sample (read-only), dumped by the
    /// quartzfire-geoip-traffic timer; feeds the Geolocation Map globe.
    #[serde(default = "default_geoip_traffic_file")]
    pub geoip_traffic_file: PathBuf,

    /// "Update now" trigger file watched by quartzfire-geoip-update-request
    /// .path. Lives under /config/quartzfire (writable for us) like the other
    /// desired-state files.
    #[serde(default = "default_geoip_update_request_file")]
    pub geoip_update_request_file: PathBuf,

    /// The unprivileged IP → country lookup helper (quartzfire-geoip).
    #[serde(default = "default_geoip_lookup_helper")]
    pub geoip_lookup_helper: PathBuf,
}

fn default_listen() -> String {
    "127.0.0.1:8443".to_string()
}
fn default_vyos_api_url() -> String {
    // The VyOS HTTPS API serves TLS itself; QuartzFire pins it to loopback on
    // a dedicated port (register-api-key injects `service https listen-address
    // 127.0.0.1` + `port 4443`) so nginx keeps sole ownership of :443. reqwest
    // is configured to accept the self-signed cert on localhost.
    "https://127.0.0.1:4443".to_string()
}
fn default_key_file() -> PathBuf {
    PathBuf::from("/etc/quartzfire/vyos-api.key")
}
fn default_www_root() -> PathBuf {
    PathBuf::from("/usr/share/quartzfire-webui/www")
}
fn default_jwt_secret_file() -> PathBuf {
    PathBuf::from("/var/lib/quartzfire-webui/jwt.secret")
}
fn default_cookie_secure() -> bool {
    true
}
fn default_ips_settings_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/ips.json")
}
fn default_ips_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-ips/status.json")
}
fn default_ips_alerts_file() -> PathBuf {
    PathBuf::from("/var/log/quartzfire/ips-alerts.json")
}
fn default_appcontrol_settings_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/appcontrol.json")
}
fn default_appcontrol_status_file() -> PathBuf {
    PathBuf::from("/run/qfappd/status.json")
}
fn default_appcontrol_catalog_file() -> PathBuf {
    PathBuf::from("/run/qfappd/catalog.json")
}
fn default_appcontrol_events_file() -> PathBuf {
    PathBuf::from("/var/log/qfappd/events.json")
}
fn default_appcontrol_apply_file() -> PathBuf {
    PathBuf::from("/run/qfappd/apply.json")
}
fn default_geoip_status_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/status.json")
}
fn default_geoip_counters_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/counters.json")
}
fn default_geoip_countries_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/countries.json")
}
fn default_geoip_traffic_file() -> PathBuf {
    PathBuf::from("/run/quartzfire-geoip/traffic.json")
}
fn default_geoip_update_request_file() -> PathBuf {
    PathBuf::from("/config/quartzfire/geoip-update-request")
}
fn default_geoip_lookup_helper() -> PathBuf {
    PathBuf::from("/usr/libexec/quartzfire/geoip-lookup")
}
fn default_guard_dir() -> PathBuf {
    PathBuf::from("/config/quartzfire")
}
fn default_session_hours() -> u64 {
    24
}
impl Config {
    /// Load config from `path`, falling back to built-in defaults if the file
    /// is absent (useful for local `cargo run`).
    pub fn load(path: &str) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                toml::from_str(&text).with_context(|| format!("parsing config {path}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!("config {path} not found, using defaults");
                Ok(toml::from_str("").unwrap())
            }
            Err(e) => Err(e).with_context(|| format!("reading config {path}")),
        }
    }

    /// Read the VyOS API key from `vyos_api_key_file`, trimming whitespace.
    /// Returns an empty string if the file is missing (dev mode / API disabled).
    pub fn read_api_key(&self) -> String {
        std::fs::read_to_string(&self.vyos_api_key_file)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }
}
