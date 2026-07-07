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
