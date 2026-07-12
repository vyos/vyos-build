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

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use tokio::process::Command;

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

#[cfg(test)]
mod tests {
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
