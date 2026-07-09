//! Intrusion Prevention (Suricata) management.
//!
//! The backend never touches Suricata itself — it runs unprivileged
//! (DynamicUser, NoNewPrivileges). Instead it edits a desired-state file
//! (`/config/quartzfire/ips.json`; `/config` persists across image upgrades)
//! that a root helper applies: a `quartzfire-ips.path` unit watches the file
//! and runs `ips-apply`, which renders the Suricata NFQUEUE config, maps
//! threat levels onto rule actions, starts/stops the daemon, and writes its
//! results to `/run/quartzfire-ips/status.json` for us to read back.
//!
//! Which traffic gets inspected is not decided here at all — that's the
//! firewall's job: rules with IPS enabled use `action queue`, handing matches
//! to Suricata for an inline accept/drop verdict (see the frontend firewall
//! data layer). This module only manages the engine those packets reach.
//!
//! Alerts stream from the journal: the rendered suricata.yaml sends EVE alert
//! records to syslog, so `journalctl -t suricata` yields one JSON document per
//! alert — same transport the Traffic Monitor uses for firewall logs.

use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_stream::{wrappers::LinesStream, StreamExt};

use crate::error::{AppError, Result};
use crate::AppState;

// ── settings model ────────────────────────────────────────────────────────────

// Threat levels are WatchGuard-style, derived from signature priority (the
// `priority` keyword or the classtype's classification.config priority):
// 1 → critical, 2 → high, 3 → medium, 4 → low, anything else → information.

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LevelAction {
    /// Signatures stay alert-only; matching traffic passes.
    Allow,
    /// Signatures are converted to drop; matching traffic is blocked inline.
    Drop,
    /// Signatures of this level are removed from the ruleset entirely.
    Disable,
}

/// Per-threat-level policy (one row of the Settings table).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelPolicy {
    pub action: LevelAction,
    /// Highlight matches as alarms in the UI.
    pub alarm: bool,
    /// Show matches in the Alerts view.
    pub log: bool,
}

impl LevelPolicy {
    fn new(action: LevelAction, alarm: bool, log: bool) -> Self {
        Self { action, alarm, log }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    /// Inspect entire flows.
    Full,
    /// Stop inspecting a flow after Suricata's stream depth and bypass
    /// encrypted traffic — cheaper per flow, catches less deep in streams.
    Fast,
}

/// Desired IPS state — the JSON document the root helper applies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpsSettings {
    pub enabled: bool,
    pub scan_mode: ScanMode,
    pub critical: LevelPolicy,
    pub high: LevelPolicy,
    pub medium: LevelPolicy,
    pub low: LevelPolicy,
    pub information: LevelPolicy,
    /// Signature IDs excluded from the ruleset (Exceptions…).
    #[serde(default)]
    pub exceptions: Vec<u64>,
    /// suricata-update source URL; null = suricata-update's default source
    /// (Emerging Threats Open).
    #[serde(default)]
    pub update_url: Option<String>,
    /// Bumped by POST /api/ips/update — a seq the helper hasn't applied yet
    /// makes it fetch fresh rules. Managed server-side; ignored on PUT.
    #[serde(default)]
    pub update_seq: u64,
}

impl Default for IpsSettings {
    /// Defaults mirror the WatchGuard out-of-box policy: drop everything that
    /// matters (alarming on critical/high), let informational sigs pass
    /// unlogged, engine off until explicitly enabled.
    fn default() -> Self {
        Self {
            enabled: false,
            scan_mode: ScanMode::Full,
            critical: LevelPolicy::new(LevelAction::Drop, true, true),
            high: LevelPolicy::new(LevelAction::Drop, true, true),
            medium: LevelPolicy::new(LevelAction::Drop, false, true),
            low: LevelPolicy::new(LevelAction::Drop, false, true),
            information: LevelPolicy::new(LevelAction::Allow, false, false),
            exceptions: Vec::new(),
            update_url: None,
            update_seq: 0,
        }
    }
}

fn load_settings(state: &AppState) -> Result<IpsSettings> {
    let path = &state.config.ips_settings_file;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            AppError::Internal(anyhow::anyhow!("parsing {}: {e}", path.display()))
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(IpsSettings::default()),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!(
            "reading {}: {e}",
            path.display()
        ))),
    }
}

/// Write the desired state atomically (temp file + rename in the same
/// directory) — the root helper is triggered by this file changing and must
/// never observe a half-written document.
fn store_settings(state: &AppState, settings: &IpsSettings) -> Result<()> {
    let path = &state.config.ips_settings_file;
    let dir = path.parent().ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("settings path has no parent directory"))
    })?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Internal(e.into()))?;
    let tmp = dir.join(".ips.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write IPS settings ({}): {e} — is the IPS service installed on this device?",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display()))
    })?;
    Ok(())
}

// ── status ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct IpsStatus {
    pub settings: IpsSettings,
    /// Whether suricata.service is active right now.
    pub running: bool,
    /// The helper's last apply report (`/run/quartzfire-ips/status.json`):
    /// rule counts per level, last update time, last error. Null until the
    /// helper has run once.
    pub apply: Option<serde_json::Value>,
}

/// GET /api/ips/status — desired settings plus the applied reality.
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<IpsStatus>> {
    let settings = load_settings(&state)?;

    let apply = std::fs::read_to_string(&state.config.ips_status_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    // Read-only systemd query; works unprivileged.
    let running = Command::new("systemctl")
        .args(["is-active", "--quiet", "suricata.service"])
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);

    Ok(Json(IpsStatus { settings, running, apply }))
}

// ── writes ────────────────────────────────────────────────────────────────────

/// PUT /api/ips/settings — replace the desired state. The helper picks the
/// change up asynchronously; poll /api/ips/status for the applied result.
pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(mut desired): Json<IpsSettings>,
) -> Result<Json<IpsSettings>> {
    if let Some(url) = &desired.update_url {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(AppError::BadRequest(
                "update server must be an http(s) URL".into(),
            ));
        }
    }
    // update_seq is managed by POST /api/ips/update — never trust the client's.
    desired.update_seq = load_settings(&state)?.update_seq;
    store_settings(&state, &desired)?;
    Ok(Json(desired))
}

/// POST /api/ips/update — request a signature update: bump the sequence the
/// helper compares against its last applied one.
pub async fn request_update(State(state): State<Arc<AppState>>) -> Result<Json<IpsSettings>> {
    let mut settings = load_settings(&state)?;
    settings.update_seq += 1;
    store_settings(&state, &settings)?;
    Ok(Json(settings))
}

// ── alert stream ──────────────────────────────────────────────────────────────

/// One EVE alert — the JSON payload of each SSE event.
#[derive(Serialize)]
pub struct AlertEntry {
    /// Journal receive time, milliseconds since the epoch.
    ts: u64,
    /// Threat level derived from the signature severity (see LEVELS).
    level: &'static str,
    /// EVE severity (1 = most severe).
    severity: u8,
    /// `allowed` (alert-only) or `blocked` (dropped inline).
    action: String,
    sid: u64,
    signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dpt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proto: Option<String>,
}

/// Severity → WatchGuard-style threat level. Suricata's classification
/// priorities run 1 (worst) to 4; anything unclassified lands in information.
pub fn severity_level(severity: u8) -> &'static str {
    match severity {
        1 => "critical",
        2 => "high",
        3 => "medium",
        4 => "low",
        _ => "information",
    }
}

/// GET /api/ips/alerts — SSE stream of EVE alerts from the journal, starting
/// with a backfill of recent entries.
pub async fn alerts() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-t", "suricata", "-f", "-n", "500", "-o", "json", "--no-pager"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("cannot start journalctl: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read the system journal on this device",
            )
                .into_response();
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "journalctl produced no output").into_response();
    };

    // The closure owns the child, so the stream keeps journalctl alive; when
    // the browser disconnects the stream is dropped and kill_on_drop reaps it.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_journal_line(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Parse one `journalctl -o json` line whose MESSAGE is an EVE record; None
/// for anything that isn't an alert event.
fn parse_journal_line(line: &str) -> Option<AlertEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let msg = v.get("MESSAGE")?.as_str()?;
    let ts = v
        .get("__REALTIME_TIMESTAMP")
        .and_then(|t| t.as_str())
        .and_then(|t| t.parse::<u64>().ok())
        .map(|us| us / 1000)
        .unwrap_or(0);
    parse_eve(msg, ts)
}

/// Parse one EVE JSON document into an alert entry; None for non-alert event
/// types (stats, flow, …) and non-JSON suricata log chatter.
fn parse_eve(msg: &str, ts: u64) -> Option<AlertEntry> {
    // EVE-over-syslog messages are bare JSON; suricata.log lines are not.
    let eve: serde_json::Value = serde_json::from_str(msg.trim()).ok()?;
    if eve.get("event_type")?.as_str()? != "alert" {
        return None;
    }
    let alert = eve.get("alert")?;
    let severity = alert.get("severity").and_then(|s| s.as_u64()).unwrap_or(255) as u8;

    let opt_str = |v: &serde_json::Value, key: &str| {
        v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
    };
    let opt_port =
        |key: &str| eve.get(key).and_then(|x| x.as_u64()).and_then(|p| u32::try_from(p).ok());

    Some(AlertEntry {
        ts,
        level: severity_level(severity),
        severity,
        action: opt_str(alert, "action").unwrap_or_else(|| "allowed".into()),
        sid: alert.get("signature_id").and_then(|s| s.as_u64()).unwrap_or(0),
        signature: opt_str(alert, "signature").unwrap_or_else(|| "unknown signature".into()),
        category: opt_str(alert, "category").filter(|c| !c.is_empty()),
        src: opt_str(&eve, "src_ip"),
        spt: opt_port("src_port"),
        dst: opt_str(&eve, "dest_ip"),
        dpt: opt_port("dest_port"),
        proto: opt_str(&eve, "proto").map(|p| p.to_ascii_lowercase()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eve_alert() {
        let msg = r#"{"timestamp":"2026-07-09T12:00:00.000000+0000","event_type":"alert",
            "src_ip":"10.0.0.5","src_port":51000,"dest_ip":"1.2.3.4","dest_port":80,
            "proto":"TCP","alert":{"action":"blocked","gid":1,"signature_id":2100498,
            "rev":7,"signature":"GPL ATTACK_RESPONSE id check returned root",
            "category":"Potentially Bad Traffic","severity":2}}"#;
        let e = parse_eve(msg, 42).expect("should parse");
        assert_eq!(e.level, "high");
        assert_eq!(e.action, "blocked");
        assert_eq!(e.sid, 2100498);
        assert_eq!(e.src.as_deref(), Some("10.0.0.5"));
        assert_eq!(e.dpt, Some(80));
        assert_eq!(e.proto.as_deref(), Some("tcp"));
    }

    #[test]
    fn ignores_non_alert_events() {
        assert!(parse_eve(r#"{"event_type":"stats","stats":{}}"#, 1).is_none());
        assert!(parse_eve("suricata: This is Suricata version 7.0", 1).is_none());
    }

    #[test]
    fn severity_maps_to_watchguard_levels() {
        assert_eq!(severity_level(1), "critical");
        assert_eq!(severity_level(2), "high");
        assert_eq!(severity_level(3), "medium");
        assert_eq!(severity_level(4), "low");
        assert_eq!(severity_level(0), "information");
        assert_eq!(severity_level(255), "information");
    }

    #[test]
    fn settings_roundtrip_preserves_seq() {
        let s = IpsSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: IpsSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.update_seq, 0);
        assert!(matches!(back.critical.action, LevelAction::Drop));
        assert!(matches!(back.information.action, LevelAction::Allow));
    }
}
