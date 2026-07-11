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
//! Alerts have two paths. Live ones stream from the journal: the rendered
//! suricata.yaml sends EVE alert records to syslog, so `journalctl -t
//! suricata -f` yields one JSON document per alert — same transport the
//! Traffic Monitor uses for firewall logs. History comes from the persistent
//! EVE file Suricata also writes (`/var/log/quartzfire/ips-alerts.json`,
//! rotated by logrotate) — the journal is volatile on VyOS, so that file is
//! where alerts live across reboots.

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
use std::{convert::Infallible, path::Path, process::Stdio, sync::Arc};
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
    /// Excepted signature IDs: kept in the ruleset alert-only, so matching
    /// traffic is never blocked but still shows up in the Alerts view.
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
    // The directory is normally created by the quartzfire-ips boot run; try
    // to create it anyway for dev boxes running without the systemd sandbox.
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".ips.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write IPS settings ({}): {e} — run `sudo systemctl start quartzfire-ips.service`, \
             then `sudo systemctl restart quartzfire-webui`, and try again",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display()))
    })?;
    Ok(())
}

// ── status ────────────────────────────────────────────────────────────────────

/// Pidfile the quartzfire systemd drop-in makes suricata write (see
/// scripts/ips-apply DROPIN_TEMPLATE — the paths must stay in sync).
const SURICATA_PIDFILE: &str = "/run/suricata/suricata.pid";

/// Whether the suricata daemon is alive, judged by its pidfile. This runs in
/// the sandboxed backend, where `systemctl is-active` is NOT reliable: an
/// unprivileged caller needs the D-Bus system bus, which the appliance image
/// doesn't necessarily run (root's systemctl — ips-apply — uses
/// /run/systemd/private instead, so the helper never notices). The pidfile +
/// /proc check works with no privileges at all.
fn suricata_pid_alive() -> bool {
    let Ok(pid) = std::fs::read_to_string(SURICATA_PIDFILE) else {
        return false;
    };
    let pid = pid.trim();
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // Guard against a stale pidfile whose pid was recycled: the process must
    // actually be suricata ("Suricata-Main").
    match std::fs::read_to_string(format!("/proc/{pid}/comm")) {
        Ok(comm) => comm.trim().to_ascii_lowercase().starts_with("suricata"),
        Err(_) => false,
    }
}

#[derive(Serialize)]
pub struct IpsStatus {
    pub settings: IpsSettings,
    /// Whether the suricata daemon is alive right now.
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

    // Pidfile first (see suricata_pid_alive); systemctl only as a fallback
    // for layouts without our drop-in (e.g. dev boxes running the distro
    // default unit, whose pidfile lives elsewhere).
    let running = suricata_pid_alive()
        || Command::new("systemctl")
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

/// One EVE alert — the JSON payload of each SSE event and history row.
#[derive(Serialize)]
pub struct AlertEntry {
    /// Alert time, milliseconds since the epoch — from the EVE record's own
    /// timestamp, so the live stream and the history file agree on it.
    ts: u64,
    /// Suricata flow id; with ts+sid it lets the frontend dedupe the live
    /// stream against fetched history.
    #[serde(skip_serializing_if = "Option::is_none")]
    flow_id: Option<u64>,
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

/// GET /api/ips/alerts — SSE stream of EVE alerts from the journal, live
/// only: backfill comes from /api/ips/alerts/history (the persistent file),
/// so replaying the volatile journal here would only produce duplicates.
pub async fn alerts() -> Response {
    let mut child = match Command::new("journalctl")
        .args(["-t", "suricata", "-f", "-n", "0", "-o", "json", "--no-pager"])
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
    // Immediate hello: EventSource only fires `open` once bytes arrive, and
    // with no alerts flowing the first real bytes would be a keep-alive ping
    // seconds away.
    let stream = tokio_stream::once(Ok(Event::default().comment("connected"))).chain(stream);

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
/// types (stats, flow, …) and non-JSON suricata log chatter. `fallback_ts`
/// stands in when the record carries no parseable timestamp.
fn parse_eve(msg: &str, fallback_ts: u64) -> Option<AlertEntry> {
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

    // The record's own timestamp keeps the live stream and the history file
    // agreeing on ts (used in the frontend's dedupe key).
    let ts = eve
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(eve_ts_ms)
        .unwrap_or(fallback_ts);

    Some(AlertEntry {
        ts,
        flow_id: eve.get("flow_id").and_then(|f| f.as_u64()),
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

/// EVE timestamp ("2026-07-09T12:34:56.789012+0200"; offset with or without a
/// colon, or "Z") → milliseconds since the epoch. Hand-rolled — this is the
/// only date parsing in the backend, not worth a chrono dependency.
fn eve_ts_ms(s: &str) -> Option<u64> {
    let (date, rest) = s.trim().split_once('T')?;

    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // The time part contains no '+' or '-', so any hit is the offset.
    let (time, offset) = match rest.find(['+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest.strip_suffix('Z').unwrap_or(rest), ""),
    };

    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let sec_part = t.next()?;
    let (sec_str, frac) = sec_part.split_once('.').unwrap_or((sec_part, ""));
    let second: i64 = sec_str.parse().ok()?;
    // First three fraction digits, right-padded: "789012" → 789, "5" → 500.
    let ms: i64 = format!("{:0<3.3}", frac).parse().ok()?;

    let offset_secs: i64 = if offset.is_empty() {
        0
    } else {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let digits: String = offset[1..].chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() != 4 {
            return None;
        }
        sign * (digits[..2].parse::<i64>().ok()? * 3600 + digits[2..].parse::<i64>().ok()? * 60)
    };

    // Days since the epoch for a civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;

    let secs = days * 86400 + hour * 3600 + minute * 60 + second - offset_secs;
    u64::try_from(secs * 1000 + ms).ok()
}

// ── alert history ─────────────────────────────────────────────────────────────

/// GET /api/ips/alerts/history — the persisted alert log, newest first, read
/// from the EVE file Suricata writes (survives reboots; the journal doesn't).
/// Empty when the file doesn't exist yet — IPS never enabled, or a device
/// predating the persistent log.
pub async fn alerts_history(State(state): State<Arc<AppState>>) -> Result<Json<Vec<AlertEntry>>> {
    let path = state.config.ips_alerts_file.clone();
    let display = path.display().to_string();
    let entries = tokio::task::spawn_blocking(move || read_alert_tail(&path, 2 * 1024 * 1024, 500))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        // A real read failure (typically permissions on the log file) must
        // surface, not masquerade as "no alerts yet".
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading the alert log {display}: {e}")))?;
    Ok(Json(entries))
}

/// The last `max` alerts from the tail of the EVE file (one JSON document per
/// line), newest first. Reads at most `tail_bytes` so a large file stays
/// cheap. A missing file is an empty history (IPS never enabled); any other
/// read problem is an error.
fn read_alert_tail(path: &Path, tail_bytes: u64, max: usize) -> std::io::Result<Vec<AlertEntry>> {
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

    let mut out: Vec<AlertEntry> = text
        .lines()
        // Seeking mid-file usually lands mid-line; drop the partial first line.
        .skip(if start > 0 { 1 } else { 0 })
        .filter_map(|line| parse_eve(line, 0))
        .collect();
    out.reverse();
    out.truncate(max);
    Ok(out)
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
        // ts comes from the EVE timestamp, not the journal fallback.
        assert_eq!(e.ts, eve_ts_ms("2026-07-09T12:00:00.000000+0000").unwrap());
    }

    #[test]
    fn eve_timestamps_parse() {
        // Anchor: one day after the epoch.
        assert_eq!(eve_ts_ms("1970-01-02T00:00:00.000000+0000"), Some(86_400_000));
        // Offsets shift correctly, with or without a colon, and Z = UTC.
        let utc = eve_ts_ms("2026-07-09T12:00:00.000000+0000").unwrap();
        assert_eq!(eve_ts_ms("2026-07-09T14:00:00.000000+0200"), Some(utc));
        assert_eq!(eve_ts_ms("2026-07-09T14:00:00.000000+02:00"), Some(utc));
        assert_eq!(eve_ts_ms("2026-07-09T05:00:00.000000-0700"), Some(utc));
        assert_eq!(eve_ts_ms("2026-07-09T12:00:00Z"), Some(utc));
        // Fractions truncate to milliseconds.
        assert_eq!(eve_ts_ms("1970-01-01T00:00:00.789012+0000"), Some(789));
        // Garbage is rejected, not misparsed.
        assert_eq!(eve_ts_ms("not a timestamp"), None);
        assert_eq!(eve_ts_ms("2026-13-40T99:00:00Z"), None);
    }

    #[test]
    fn reads_alert_tail_newest_first() {
        let alert = |ts: &str, sid: u64| {
            format!(
                r#"{{"timestamp":"{ts}","event_type":"alert","flow_id":7,"src_ip":"10.0.0.5","alert":{{"signature_id":{sid},"signature":"x","severity":3,"action":"allowed"}}}}"#
            )
        };
        let dir = std::env::temp_dir().join(format!("qz-ips-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ips-alerts.json");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{{\"event_type\":\"stats\"}}\n{}\n",
                alert("2026-07-09T10:00:00.000000+0000", 1),
                alert("2026-07-09T11:00:00.000000+0000", 2),
                alert("2026-07-09T12:00:00.000000+0000", 3),
            ),
        )
        .unwrap();

        let all = read_alert_tail(&path, 1024 * 1024, 500).unwrap();
        assert_eq!(all.iter().map(|a| a.sid).collect::<Vec<_>>(), vec![3, 2, 1]);
        assert_eq!(all[0].flow_id, Some(7));

        let capped = read_alert_tail(&path, 1024 * 1024, 2).unwrap();
        assert_eq!(capped.iter().map(|a| a.sid).collect::<Vec<_>>(), vec![3, 2]);

        // Absent file = empty history, not an error.
        assert!(read_alert_tail(&dir.join("missing.json"), 1024, 10).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
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
