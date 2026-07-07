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

    /// Host header presented to the VyOS HTTPS API. VyOS and the WebUI share one
    /// nginx on :443; VyOS's server block matches `server_name <hostname>` while
    /// the WebUI is the `default_server`. Proxied API requests must carry this
    /// Host so nginx routes them to VyOS (→ /run/api.sock) instead of looping
    /// back into the WebUI. Defaults to the system hostname.
    #[serde(default = "default_vyos_api_host")]
    pub vyos_api_host: String,
}

fn default_listen() -> String {
    "127.0.0.1:8443".to_string()
}
fn default_vyos_api_url() -> String {
    // VyOS exposes the HTTP API through its HTTPS service on :443; the internal
    // backend is a local socket, not a public TCP port. reqwest is configured to
    // accept the self-signed cert on localhost.
    "https://127.0.0.1".to_string()
}
fn default_key_file() -> PathBuf {
    PathBuf::from("/etc/quartzfire/vyos-api.key")
}
fn default_www_root() -> PathBuf {
    PathBuf::from("/usr/share/quartzfire-webui/www")
}
fn default_vyos_api_host() -> String {
    // VyOS sets nginx server_name to the system hostname.
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "vyos".to_string())
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
