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
}

fn default_listen() -> String {
    "127.0.0.1:8443".to_string()
}
fn default_vyos_api_url() -> String {
    "http://127.0.0.1:8080".to_string()
}
fn default_key_file() -> PathBuf {
    PathBuf::from("/etc/quartzfire/vyos-api.key")
}
fn default_www_root() -> PathBuf {
    PathBuf::from("/usr/share/quartzfire-webui/www")
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
