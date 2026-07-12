//! Geolocation (country filtering) management.
//!
//! Unlike IPS/Application Control, the geolocation CONFIG does not live in a
//! desired-state file: actions and policies are real VyOS config nodes
//! (`service geolocation …`, shipped by the quartzfire-geoip package), so the
//! frontend reads and edits them through the authenticated VyOS API proxy
//! under the commit-confirm guard, exactly like the firewall pages. This
//! module only covers what the config tree can't:
//!
//!   * GET  /api/geolocation/status    — database version / update / apply
//!     state (`/run/quartzfire-geoip/status.json`, written by the root
//!     helpers) plus per-action hit counters (`counters.json`, dumped by a
//!     one-minute timer while the qz_geo table is loaded).
//!   * GET  /api/geolocation/countries — the selectable country list dumped
//!     from the libloc database (`countries.json`); `available:false` before
//!     the first successful database download.
//!   * POST /api/geolocation/update    — bump the trigger file that
//!     quartzfire-geoip-update-request.path watches; the root updater runs
//!     `location update` (signed download, atomic install) asynchronously.
//!   * GET  /api/geolocation/lookup?ip=… — one-off IP → country diagnostic,
//!     via the unprivileged geoip-lookup helper.
//!   * GET  /api/geolocation/alerts[/history] — the block-event stream. Unlike
//!     IPS/App Control there is no daemon emitting structured events: an
//!     action with `log` set installs an nftables `log prefix "[GEO-<action>]"`
//!     on its drop rule, so blocks land in the kernel log. We tail the journal
//!     (`journalctl -k -g '\[GEO-' -o json`) and parse the netfilter LOG lines.

use axum::{
    extract::{Query, State},
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

fn read_json(path: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
}

// ── status ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GeoStatus {
    /// The helpers' merged report (`status.json`): db {present, version,
    /// signature_ok}, update {time, ok, changed, message, schedule},
    /// apply {time, ok, error}, policy_errors, set_counts, active.
    /// Null until an update or commit has run once.
    pub status: Option<serde_json::Value>,
    /// Per-action blocked packet/byte counters (`counters.json`). Null until
    /// the counters timer has run with the geo table loaded.
    pub counters: Option<serde_json::Value>,
}

/// GET /api/geolocation/status
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<GeoStatus>> {
    Ok(Json(GeoStatus {
        status: read_json(&state.config.geoip_status_file),
        counters: read_json(&state.config.geoip_counters_file),
    }))
}

/// GET /api/geolocation/traffic — active connections grouped by country
/// (`traffic.json`, dumped by the quartzfire-geoip-traffic timer). Feeds the
/// Geolocation Map globe. Empty shape before the first sample so the tile can
/// render its idle state.
pub async fn traffic(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    Ok(Json(read_json(&state.config.geoip_traffic_file).unwrap_or_else(|| {
        serde_json::json!({ "time": 0, "db_version": null, "countries": [] })
    })))
}

// ── countries ─────────────────────────────────────────────────────────────────

/// GET /api/geolocation/countries — `available:false` (empty list) before the
/// first database download so the UI can show its empty state.
pub async fn countries(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    Ok(Json(read_json(&state.config.geoip_countries_file).unwrap_or_else(|| {
        serde_json::json!({ "available": false, "db_version": null, "countries": [] })
    })))
}

// ── update trigger ────────────────────────────────────────────────────────────

/// POST /api/geolocation/update — request an immediate database update. The
/// trigger file is bumped atomically (temp + rename, same contract as every
/// other path-unit watcher); the update itself runs asynchronously as root —
/// poll /api/geolocation/status for the outcome.
pub async fn request_update(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let path = &state.config.geoip_update_request_file;
    let seq = read_json(path)
        .and_then(|v| v.get("seq").and_then(|s| s.as_u64()))
        .unwrap_or(0)
        + 1;
    let body = serde_json::json!({
        "seq": seq,
        "requested_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("trigger path has no parent directory")))?;
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join(".geoip-update-request.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write the update trigger ({}): {e} — ensure quartzfire-geoip is installed and \
             /config/quartzfire is writable",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(Json(serde_json::json!({ "requested": true, "seq": seq })))
}

// ── IP lookup ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LookupQuery {
    ip: String,
}

/// GET /api/geolocation/lookup?ip=… — the "check an IP" diagnostic. The
/// helper always answers with a JSON body (errors included) on exit 0.
pub async fn lookup(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LookupQuery>,
) -> Result<Json<serde_json::Value>> {
    let ip = q.ip.trim().to_string();
    // Parse locally first: a clear 400 beats shelling out with garbage.
    if ip.parse::<std::net::IpAddr>().is_err() {
        return Err(AppError::BadRequest(format!(
            "\"{ip}\" is not a valid IPv4 or IPv6 address"
        )));
    }
    let output = Command::new(&state.config.geoip_lookup_helper)
        .arg(&ip)
        .output()
        .await
        .map_err(|e| {
            AppError::BadRequest(format!(
                "cannot run the lookup helper ({}): {e} — is quartzfire-geoip installed?",
                state.config.geoip_lookup_helper.display()
            ))
        })?;
    let body: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("parsing geoip-lookup output: {e}")))?;
    Ok(Json(body))
}

// ── alert stream ──────────────────────────────────────────────────────────────

/// One geolocation block event — the SSE payload and history row, parsed from a
/// netfilter LOG line (`[GEO-<action>] IN=… OUT=… SRC=… DST=… PROTO=… SPT=…
/// DPT=…`). Every field beyond the action name is best-effort: the kernel LOG
/// target omits ports for non-TCP/UDP traffic and interfaces on some chains.
#[derive(Serialize)]
pub struct GeoEvent {
    /// Milliseconds since the Unix epoch (journal `__REALTIME_TIMESTAMP`).
    ts: u64,
    /// The action whose drop rule logged this — the `<name>` in `[GEO-<name>]`.
    action_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    iif: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oif: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dst: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proto: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dpt: Option<u32>,
}

/// journalctl argument list selecting kernel `[GEO-…]` LOG lines as JSON.
/// `extra` adds the follow/backlog flags the two endpoints differ on.
fn journal_args(extra: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = ["-k", "-g", r"\[GEO-", "-o", "json", "--no-pager"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(extra.iter().map(|s| s.to_string()));
    args
}

/// GET /api/geolocation/alerts — SSE stream of block events from the journal
/// (live only; history comes from /api/geolocation/alerts/history).
pub async fn alerts() -> Response {
    let mut child = match Command::new("journalctl")
        .args(journal_args(&["-f", "-n", "0"]))
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

    // Each line is one journal entry as JSON; parse_geo_event drops anything
    // that is not a `[GEO-…]` netfilter LOG record.
    let stream = LinesStream::new(BufReader::new(stdout).lines()).filter_map(move |line| {
        let _keep_child_alive = &child;
        let entry = parse_geo_event(&line.ok()?)?;
        let json = serde_json::to_string(&entry).ok()?;
        Some(Ok::<Event, Infallible>(Event::default().data(json)))
    });
    let stream = tokio_stream::once(Ok(Event::default().comment("connected"))).chain(stream);
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// GET /api/geolocation/alerts/history — recent block events, newest first,
/// read from the journal's kernel backlog (survives reboots as far as the
/// persistent journal reaches).
pub async fn alerts_history() -> Result<Json<Vec<GeoEvent>>> {
    let output = Command::new("journalctl")
        .args(journal_args(&["--since", "-48h", "-n", "1000"]))
        .stderr(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("running journalctl: {e}")))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut events: Vec<GeoEvent> = text.lines().filter_map(parse_geo_event).collect();
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    events.truncate(500);
    Ok(Json(events))
}

/// Parse one journal line (a JSON entry) into a block event, or None for
/// anything that is not a `[GEO-<action>]` netfilter LOG record.
fn parse_geo_event(line: &str) -> Option<GeoEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let msg = v.get("MESSAGE")?.as_str()?;
    let start = msg.find("[GEO-")?;
    let rest = &msg[start + "[GEO-".len()..];
    let end = rest.find(']')?;
    let action_name = rest[..end].to_string();
    if action_name.is_empty() {
        return None;
    }

    let (mut iif, mut oif, mut src, mut dst, mut proto, mut spt, mut dpt) =
        (None, None, None, None, None, None, None);
    for tok in rest[end + 1..].split_whitespace() {
        let Some((key, val)) = tok.split_once('=') else { continue };
        match key {
            "IN" => iif = Some(val.to_string()).filter(|s| !s.is_empty()),
            "OUT" => oif = Some(val.to_string()).filter(|s| !s.is_empty()),
            "SRC" => src = Some(val.to_string()),
            "DST" => dst = Some(val.to_string()),
            "PROTO" => proto = Some(val.to_string()),
            "SPT" => spt = val.parse().ok(),
            "DPT" => dpt = val.parse().ok(),
            _ => {}
        }
    }

    // __REALTIME_TIMESTAMP is microseconds-since-epoch as a decimal string.
    let ts = v
        .get("__REALTIME_TIMESTAMP")
        .and_then(|t| t.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|us| us / 1000)
        .unwrap_or(0);

    Some(GeoEvent { ts, action_name, iif, oif, src, dst, proto, spt, dpt })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_netfilter_geo_log_line() {
        let line = r#"{"__REALTIME_TIMESTAMP":"1752284602117000","MESSAGE":"[GEO-China] IN=eth1 OUT=eth6 MAC=00:11 SRC=1.2.3.4 DST=5.6.7.8 LEN=60 PROTO=TCP SPT=443 DPT=51000 SYN"}"#;
        let e = parse_geo_event(line).expect("should parse");
        assert_eq!(e.action_name, "China");
        assert_eq!(e.ts, 1_752_284_602_117);
        assert_eq!(e.iif.as_deref(), Some("eth1"));
        assert_eq!(e.oif.as_deref(), Some("eth6"));
        assert_eq!(e.src.as_deref(), Some("1.2.3.4"));
        assert_eq!(e.dst.as_deref(), Some("5.6.7.8"));
        assert_eq!(e.proto.as_deref(), Some("TCP"));
        assert_eq!(e.spt, Some(443));
        assert_eq!(e.dpt, Some(51000));
    }

    #[test]
    fn ignores_non_geo_and_malformed_lines() {
        // A kernel line without our prefix.
        assert!(parse_geo_event(r#"{"MESSAGE":"usb 1-1: new device"}"#).is_none());
        // Not JSON.
        assert!(parse_geo_event("[GEO-China] SRC=1.2.3.4").is_none());
        // Empty action name.
        assert!(parse_geo_event(r#"{"MESSAGE":"[GEO-] SRC=1.2.3.4"}"#).is_none());
    }

    #[test]
    fn parses_input_chain_line_without_out_or_ports() {
        // ICMP on the input chain: no OUT, no ports.
        let line = r#"{"__REALTIME_TIMESTAMP":"1000000","MESSAGE":"[GEO-Block_RU] IN=eth0 SRC=9.9.9.9 DST=10.0.0.1 PROTO=ICMP TYPE=8"}"#;
        let e = parse_geo_event(line).expect("should parse");
        assert_eq!(e.action_name, "Block_RU");
        assert_eq!(e.iif.as_deref(), Some("eth0"));
        assert!(e.oif.is_none());
        assert!(e.spt.is_none() && e.dpt.is_none());
        assert_eq!(e.proto.as_deref(), Some("ICMP"));
        assert_eq!(e.ts, 1000);
    }

    #[test]
    fn lookup_ip_validation() {
        // The handler rejects before spawning; mirror its check here.
        assert!("1.2.3.4".parse::<std::net::IpAddr>().is_ok());
        assert!("2001:db8::1".parse::<std::net::IpAddr>().is_ok());
        assert!("1.2.3".parse::<std::net::IpAddr>().is_err());
        assert!("example.com".parse::<std::net::IpAddr>().is_err());
        assert!("1.2.3.4; rm -rf /".parse::<std::net::IpAddr>().is_err());
    }

    #[test]
    fn update_seq_increments_from_existing_body() {
        let existing: serde_json::Value = serde_json::from_str(r#"{"seq": 41}"#).unwrap();
        let seq = existing.get("seq").and_then(|s| s.as_u64()).unwrap_or(0) + 1;
        assert_eq!(seq, 42);
        // A missing/corrupt trigger file restarts at 1.
        let missing: Option<serde_json::Value> = None;
        let seq = missing
            .and_then(|v| v.get("seq").and_then(|s| s.as_u64()))
            .unwrap_or(0)
            + 1;
        assert_eq!(seq, 1);
    }
}
