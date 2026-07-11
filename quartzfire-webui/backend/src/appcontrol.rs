//! Application Control (qfappd) management.
//!
//! Same desired-state pattern as the IPS module: the backend runs unprivileged
//! and never touches qfappd directly. It edits a desired-state file
//! (`/config/quartzfire/appcontrol.json`; `/config` persists across image
//! upgrades) that the root `qfappd-apply` helper validates and publishes to
//! `/run/qfappd/policy.json`. qfappd hot-reloads it and writes back a status
//! snapshot (`/run/qfappd/status.json`) and an nDPI catalog dump
//! (`/run/qfappd/catalog.json`) for us to read.
//!
//! The schema written here is qfappd's policy schema v2 (named actions +
//! per-firewall-rule bindings — see qfappd/crates/qfappd-core/src/policy.rs).
//! Application/category names come from the catalog dump so the WebUI's
//! Actions editor tracks the installed signature set.
//!
//! Alerts have two paths, exactly like IPS. Live ones stream from the journal:
//! qfappd writes one flat JSON event per flow decision to stdout, captured by
//! journald under `SyslogIdentifier=qfappd`, so `journalctl -t qfappd -f`
//! yields one document per decision. History comes from the persistent events
//! file qfappd also writes (`/var/log/qfappd/events.json`, logrotated).

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
use std::{collections::BTreeMap, convert::Infallible, path::Path, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use tokio_stream::{wrappers::LinesStream, StreamExt};

use crate::error::{AppError, Result};
use crate::AppState;

/// The ct-mark ACTION_ID field is 3 bits by default → at most 7 actions may be
/// bound at once. We enforce it here for a clear error before the file is even
/// written (qfappd's check-policy enforces it authoritatively too).
const MAX_BOUND_ACTIONS: usize = 7;

// ── desired-state schema (qfappd policy v2) ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcAction {
    /// "allow" | "block" — WatchGuard's "when application does not match".
    pub default_action: String,
    /// "drop" | "reset".
    #[serde(default = "default_block_mode")]
    pub block_mode: String,
    #[serde(default)]
    pub categories: BTreeMap<String, String>,
    #[serde(default)]
    pub applications: BTreeMap<String, String>,
}

fn default_block_mode() -> String {
    "drop".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcBinding {
    pub id: u32,
    pub action: String,
    #[serde(default)]
    pub description: String,
    /// nft match (iifname/oifname/saddr/daddr/l4). Opaque here; qfappd
    /// validates it. The Policies tab fills it from the firewall rule.
    #[serde(default, rename = "match")]
    pub match_spec: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcConfig {
    pub version: u32,
    #[serde(default)]
    pub actions: BTreeMap<String, AcAction>,
    #[serde(default)]
    pub bindings: Vec<AcBinding>,
}

impl Default for AcConfig {
    fn default() -> Self {
        let mut actions = BTreeMap::new();
        actions.insert(
            "Global".to_string(),
            AcAction {
                default_action: "allow".into(),
                block_mode: "drop".into(),
                categories: BTreeMap::new(),
                applications: BTreeMap::new(),
            },
        );
        Self { version: 2, actions, bindings: Vec::new() }
    }
}

fn load_config(state: &AppState) -> Result<AcConfig> {
    let path = &state.config.appcontrol_settings_file;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing {}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AcConfig::default()),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("reading {}: {e}", path.display()))),
    }
}

/// Atomic write (temp + rename in the same dir) so the root helper never sees
/// a half-written document.
fn store_config(state: &AppState, cfg: &AcConfig) -> Result<()> {
    let path = &state.config.appcontrol_settings_file;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("settings path has no parent directory")))?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| AppError::Internal(e.into()))?;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".appcontrol.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write Application Control settings ({}): {e} — ensure qfappd is installed and \
             /config/quartzfire is writable, then try again",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(())
}

fn validate(cfg: &AcConfig) -> Result<()> {
    if cfg.version != 2 {
        return Err(AppError::BadRequest(format!(
            "unsupported schema version {} (expected 2)",
            cfg.version
        )));
    }
    for (name, a) in &cfg.actions {
        for v in std::iter::once(&a.default_action)
            .chain(a.categories.values())
            .chain(a.applications.values())
        {
            if v != "allow" && v != "block" {
                return Err(AppError::BadRequest(format!(
                    "action {name:?}: verdict must be \"allow\" or \"block\", got {v:?}"
                )));
            }
        }
        if a.block_mode != "drop" && a.block_mode != "reset" {
            return Err(AppError::BadRequest(format!(
                "action {name:?}: block_mode must be \"drop\" or \"reset\""
            )));
        }
    }
    let mut bound = std::collections::BTreeSet::new();
    for b in &cfg.bindings {
        if !cfg.actions.contains_key(&b.action) {
            return Err(AppError::BadRequest(format!(
                "binding {} references unknown action {:?}",
                b.id, b.action
            )));
        }
        bound.insert(b.action.clone());
    }
    if bound.len() > MAX_BOUND_ACTIONS {
        return Err(AppError::BadRequest(format!(
            "{} actions bound but at most {MAX_BOUND_ACTIONS} may be active at once — \
             unbind an action or widen the mark layout",
            bound.len()
        )));
    }
    Ok(())
}

// ── status ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct AcStatus {
    pub settings: AcConfig,
    /// qfappd's runtime status (`/run/qfappd/status.json`): policy generation,
    /// last error, per-queue counters. Null until qfappd has run once.
    pub status: Option<serde_json::Value>,
    /// Whether qfappd is alive (its status file is fresh / pidfile present).
    pub running: bool,
}

const QFAPPD_PIDFILE: &str = "/run/qfappd/qfappd.pid";

/// qfappd liveness without privileges: prefer a fresh status file (qfappd
/// rewrites it every few seconds), fall back to the process table.
fn qfappd_alive(status: &Option<serde_json::Value>) -> bool {
    if status.is_some() {
        return true;
    }
    if let Ok(pid) = std::fs::read_to_string(QFAPPD_PIDFILE) {
        let pid = pid.trim();
        if !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                return comm.trim() == "qfappd";
            }
        }
    }
    false
}

/// GET /api/appcontrol/status — desired settings plus the applied reality.
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<AcStatus>> {
    let settings = load_config(&state)?;
    let status = std::fs::read_to_string(&state.config.appcontrol_status_file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let running = qfappd_alive(&status);
    Ok(Json(AcStatus { settings, status, running }))
}

/// PUT /api/appcontrol/settings — replace the desired state; qfappd-apply
/// validates and publishes it asynchronously.
pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(desired): Json<AcConfig>,
) -> Result<Json<AcConfig>> {
    validate(&desired)?;
    store_config(&state, &desired)?;
    Ok(Json(desired))
}

// ── catalog ───────────────────────────────────────────────────────────────────

/// GET /api/appcontrol/catalog — the nDPI application/category catalog qfappd
/// dumped at startup. `available:false` (with an empty list) when qfappd
/// hasn't run yet, so the UI can fall back to its shipped fixture.
#[derive(Serialize)]
pub struct CatalogResponse {
    pub available: bool,
    #[serde(flatten)]
    pub catalog: serde_json::Value,
}

pub async fn catalog(State(state): State<Arc<AppState>>) -> Result<Json<CatalogResponse>> {
    match std::fs::read_to_string(&state.config.appcontrol_catalog_file) {
        Ok(text) => {
            let catalog: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
                AppError::Internal(anyhow::anyhow!("parsing the qfappd catalog: {e}"))
            })?;
            Ok(Json(CatalogResponse { available: true, catalog }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Json(CatalogResponse {
            available: false,
            catalog: serde_json::json!({ "ndpi_version": null, "num_protocols": 0, "applications": [] }),
        })),
        Err(e) => Err(AppError::Internal(anyhow::anyhow!("reading the qfappd catalog: {e}"))),
    }
}

// ── alert stream ──────────────────────────────────────────────────────────────

/// One decision event — the SSE payload and history row. A flattened subset of
/// qfappd's event schema (docs/event-schema.md), plus a millisecond `ts`.
#[derive(Serialize)]
pub struct AcEvent {
    ts: u64,
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
    app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    /// "allow" | "block".
    action: String,
    action_name: String,
    block_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sni: Option<String>,
}

/// GET /api/appcontrol/alerts — SSE stream of decision events from the journal
/// (live only; history comes from /api/appcontrol/alerts/history).
pub async fn alerts() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-t", "qfappd", "-f", "-n", "0", "-o", "cat", "--no-pager"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
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

    // `-o cat` gives the raw MESSAGE (the event JSON line qfappd wrote to
    // stdout). Non-JSON lines (tracing diagnostics on stderr share the tag)
    // and non-app_control events are skipped.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_event(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });
    let stream = tokio_stream::once(Ok(Event::default().comment("connected"))).chain(stream);
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Parse one qfappd event line into an alert row; None for non-app_control
/// lines and log chatter.
fn parse_event(line: &str) -> Option<AcEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("event_type")?.as_str()? != "app_control" {
        return None;
    }
    let opt_str = |key: &str| v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string());
    let opt_port = |key: &str| v.get(key).and_then(|x| x.as_u64()).and_then(|p| u32::try_from(p).ok());
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(rfc3339_ms)
        .unwrap_or(0);
    Some(AcEvent {
        ts,
        src: opt_str("src_ip"),
        spt: opt_port("src_port"),
        dst: opt_str("dest_ip"),
        dpt: opt_port("dest_port"),
        proto: opt_str("proto"),
        app: opt_str("app").unwrap_or_else(|| "Unknown".into()),
        category: opt_str("category").filter(|c| !c.is_empty()),
        action: opt_str("action").unwrap_or_else(|| "allow".into()),
        action_name: opt_str("action_name").unwrap_or_default(),
        block_mode: opt_str("block_mode").unwrap_or_else(|| "drop".into()),
        confidence: opt_str("confidence"),
        sni: opt_str("sni"),
    })
}

/// RFC 3339 UTC ("2026-07-11T14:03:22.117Z") → ms since epoch. qfappd always
/// emits UTC with a trailing Z, so this is deliberately narrower than the IPS
/// EVE parser (no numeric offsets).
fn rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.trim().strip_suffix('Z').unwrap_or(s.trim());
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let (sec_str, frac) = t.next()?.split_once('.').unwrap_or((t.clone().next().unwrap_or("0"), ""));
    let second: i64 = sec_str.parse().ok()?;
    let ms: i64 = format!("{:0<3.3}", frac).parse().unwrap_or(0);

    // Days-from-civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    u64::try_from(secs * 1000 + ms).ok()
}

// ── alert history ─────────────────────────────────────────────────────────────

/// GET /api/appcontrol/alerts/history — persisted decision events, newest
/// first, from the events file qfappd writes (survives reboots).
pub async fn alerts_history(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AcEvent>>> {
    let path = state.config.appcontrol_events_file.clone();
    let display = path.display().to_string();
    let entries = tokio::task::spawn_blocking(move || read_event_tail(&path, 2 * 1024 * 1024, 500))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading the events log {display}: {e}")))?;
    Ok(Json(entries))
}

fn read_event_tail(path: &Path, tail_bytes: u64, max: usize) -> std::io::Result<Vec<AcEvent>> {
    use std::io::{ErrorKind, Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(tail_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut out: Vec<AcEvent> = text
        .lines()
        .skip(if start > 0 { 1 } else { 0 })
        .filter_map(parse_event)
        .collect();
    out.reverse();
    out.truncate(max);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_app_control_event() {
        let line = r#"{"timestamp":"2026-07-11T14:03:22.117Z","event_type":"app_control","src_ip":"10.0.1.23","src_port":51544,"dest_ip":"104.16.1.1","dest_port":443,"proto":"TCP","vlan":0,"in_iface":"eth1","app":"ChatGPT","app_id":244,"category":"AI","action":"block","action_name":"Global","block_mode":"drop","confidence":"dpi","default_applied":false,"sni":"chatgpt.com","bytes":3908,"pkts":7}"#;
        let e = parse_event(line).expect("parses");
        assert_eq!(e.app, "ChatGPT");
        assert_eq!(e.action, "block");
        assert_eq!(e.action_name, "Global");
        assert_eq!(e.dpt, Some(443));
        assert_eq!(e.sni.as_deref(), Some("chatgpt.com"));
        assert_eq!(e.ts, rfc3339_ms("2026-07-11T14:03:22.117Z").unwrap());
    }

    #[test]
    fn skips_non_app_control_lines() {
        assert!(parse_event("2026-07-11T14:03:22Z  INFO qfappd: queue 100 started").is_none());
        assert!(parse_event(r#"{"event_type":"other"}"#).is_none());
        assert!(parse_event("not json").is_none());
    }

    #[test]
    fn rfc3339_anchor() {
        assert_eq!(rfc3339_ms("1970-01-02T00:00:00.000Z"), Some(86_400_000));
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00.789Z"), Some(789));
        assert_eq!(rfc3339_ms("garbage"), None);
    }

    #[test]
    fn validate_rejects_too_many_actions() {
        let mut cfg = AcConfig { version: 2, actions: BTreeMap::new(), bindings: Vec::new() };
        for i in 0..8 {
            cfg.actions.insert(
                format!("A{i}"),
                AcAction {
                    default_action: "allow".into(),
                    block_mode: "drop".into(),
                    categories: BTreeMap::new(),
                    applications: BTreeMap::new(),
                },
            );
            cfg.bindings.push(AcBinding {
                id: i,
                action: format!("A{i}"),
                description: String::new(),
                match_spec: serde_json::json!({}),
            });
        }
        assert!(validate(&cfg).is_err());
    }

    #[test]
    fn validate_accepts_default() {
        assert!(validate(&AcConfig::default()).is_ok());
    }
}
