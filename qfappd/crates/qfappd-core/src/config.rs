//! Daemon configuration (`/etc/qfappd/qfappd.toml`).
//!
//! Every tunable named in the spec lives here: queue range, classification
//! budgets, flow-table bounds, fail mode, the ct-mark bit layout, and the
//! event sinks. All fields have defaults so an empty file is a valid config.

use serde::Deserialize;
use std::path::{Path, PathBuf};

use crate::ctmark::Layout;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub queues: Queues,
    pub classify: Classify,
    pub flow_table: FlowTable,
    pub mark: MarkConfig,
    pub events: Events,
    pub policy: PolicyCfg,
    pub api: Api,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Queues {
    /// First NFQUEUE number; workers bind `start .. start + count`.
    pub start: u16,
    pub count: u16,
    /// `open`: kernel bypasses the queue when it is full or unbound
    /// (nft `bypass` flag + NFQA_CFG_F_FAIL_OPEN). `closed`: selected
    /// traffic is dropped instead when qfappd cannot keep up.
    pub fail_mode: FailMode,
}

impl Default for Queues {
    fn default() -> Self {
        Self { start: 100, count: 4, fail_mode: FailMode::Open }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailMode {
    Open,
    Closed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Classify {
    /// Give up and apply the action's default after this many packets…
    pub max_packets: u32,
    /// …or this much L4 payload, whichever comes first.
    pub max_payload_bytes: u32,
}

impl Default for Classify {
    fn default() -> Self {
        Self { max_packets: 12, max_payload_bytes: 4096 }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct FlowTable {
    /// Total in-flight (unclassified) flow entries across all workers.
    pub max_entries: usize,
    /// Unclassified flows idle longer than this are evicted.
    pub idle_timeout_secs: u64,
}

impl Default for FlowTable {
    fn default() -> Self {
        Self { max_entries: 524_288, idle_timeout_secs: 120 }
    }
}

/// The ct-mark bit layout, configurable in exactly one place (here).
/// See `ctmark::Layout` for semantics and validation.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct MarkConfig {
    pub classified_bit: u8,
    pub block_bit: u8,
    pub app_shift: u8,
    pub app_bits: u8,
    pub action_shift: u8,
    pub action_bits: u8,
}

impl Default for MarkConfig {
    fn default() -> Self {
        Self {
            classified_bit: 31,
            block_bit: 30,
            app_shift: 19,
            app_bits: 11,
            action_shift: 16,
            action_bits: 3,
        }
    }
}

impl MarkConfig {
    pub fn layout(&self) -> Result<Layout, crate::ctmark::LayoutError> {
        Layout::new(
            self.classified_bit,
            self.block_bit,
            self.app_shift,
            self.app_bits,
            self.action_shift,
            self.action_bits,
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Events {
    /// UNIX datagram socket sink (fire-and-forget; drops are counted).
    pub socket: bool,
    pub socket_path: PathBuf,
    /// Line-delimited JSON file sink.
    pub file: bool,
    pub file_path: PathBuf,
    /// Mirror events to syslog/journald tagged `qfappd` (feeds the WebUI
    /// Alerts tab, same transport as the IPS alerts).
    pub journald: bool,
}

impl Default for Events {
    fn default() -> Self {
        Self {
            socket: true,
            socket_path: PathBuf::from("/run/qfappd/events.sock"),
            file: true,
            file_path: PathBuf::from("/var/log/qfappd/events.json"),
            journald: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PolicyCfg {
    pub path: PathBuf,
}

impl Default for PolicyCfg {
    fn default() -> Self {
        Self { path: PathBuf::from("/run/qfappd/policy.json") }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Api {
    pub socket_path: PathBuf,
    /// Periodic status snapshot for unprivileged readers (WebUI), mirroring
    /// the quartzfire-ips status.json contract. Empty string disables.
    pub status_path: PathBuf,
    pub status_interval_secs: u64,
    /// nDPI catalog dumped once at startup for the WebUI's app/category tree
    /// (unprivileged read; tracks the installed signature set). Empty disables.
    pub catalog_path: PathBuf,
}

impl Default for Api {
    fn default() -> Self {
        Self {
            socket_path: PathBuf::from("/run/qfappd/qfappd.sock"),
            status_path: PathBuf::from("/run/qfappd/status.json"),
            status_interval_secs: 5,
            catalog_path: PathBuf::from("/run/qfappd/catalog.json"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("read {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("invalid [mark] layout: {0}")]
    Layout(#[from] crate::ctmark::LayoutError),
    #[error("queues.count must be 1..=16, got {0}")]
    QueueCount(u16),
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.to_owned(),
            source,
        })?;
        let cfg: Config = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.to_owned(),
            source,
        })?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        self.mark.layout()?;
        if self.queues.count == 0 || self.queues.count > 16 {
            return Err(ConfigError::QueueCount(self.queues.count));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_is_valid_defaults() {
        let cfg: Config = toml::from_str("").unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.queues.start, 100);
        assert_eq!(cfg.queues.count, 4);
        assert_eq!(cfg.queues.fail_mode, FailMode::Open);
        assert_eq!(cfg.classify.max_packets, 12);
        assert_eq!(cfg.classify.max_payload_bytes, 4096);
        assert_eq!(cfg.flow_table.max_entries, 524_288);
        assert_eq!(cfg.flow_table.idle_timeout_secs, 120);
        assert!(cfg.events.journald);
    }

    #[test]
    fn overrides_parse() {
        let cfg: Config = toml::from_str(
            r#"
            [queues]
            start = 200
            count = 2
            fail_mode = "closed"

            [classify]
            max_packets = 20
            max_payload_bytes = 8192

            [mark]
            action_bits = 4
            app_bits = 10
            app_shift = 20
            "#,
        )
        .unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.queues.start, 200);
        assert_eq!(cfg.queues.fail_mode, FailMode::Closed);
        assert_eq!(cfg.classify.max_packets, 20);
        let layout = cfg.mark.layout().unwrap();
        assert_eq!(layout.max_action_id(), 15);
    }

    #[test]
    fn unknown_keys_rejected() {
        assert!(toml::from_str::<Config>("[queues]\nbogus = 1\n").is_err());
    }

    #[test]
    fn zero_queues_rejected() {
        let cfg: Config = toml::from_str("[queues]\ncount = 0\n").unwrap();
        assert!(matches!(cfg.validate(), Err(ConfigError::QueueCount(0))));
    }
}
