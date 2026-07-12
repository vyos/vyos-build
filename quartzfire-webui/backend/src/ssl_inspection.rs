//! SSL Inspection management.
//!
//! Like geolocation, the CONFIG (enable, interfaces, do-not-inspect list, ICAP
//! endpoint, …) is real VyOS config — `service quartzfire ssl-inspection …`,
//! shipped by the quartzfire-ssl-inspection package — so the frontend reads and
//! edits it through the authenticated VyOS API proxy under the commit-confirm
//! guard, exactly like the firewall pages. This module covers only what the
//! config tree can't:
//!
//!   * GET  /api/ssl-inspection/status     — squid/bump/icap/certgen/CA state
//!     merged from `/run/quartzfire-ssl/status.json` (+ `ca-info.json`), written
//!     by the root qzssl helpers. The CA private key is NEVER present here.
//!   * GET  /api/ssl-inspection/ca.crt|ca.der — download the PUBLIC CA for
//!     client install (convenience; the box also serves these on :4126).
//!   * POST /api/ssl-inspection/regenerate — bump the trigger file that
//!     quartzfire-ssl-caregen.path watches; the root helper mints a fresh CA
//!     asynchronously (all previously distributed CAs then become invalid).
//!
//! The CA private key is never read, returned, or logged by any handler here.

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::{path::Path, sync::Arc};

use crate::error::{AppError, Result};
use crate::AppState;

fn read_json(path: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

// ── status ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SslStatus {
    /// The helpers' report (`status.json`): enabled, squid {running,
    /// bump_capable, icap_capable}, certgen_db_ready, icap {configured,
    /// reachable, …}, ca {subject, fingerprint, validity, serial — no key},
    /// apply {time, ok, error}. Null until inspection has been committed once.
    pub status: Option<serde_json::Value>,
    /// Public CA metadata (`ca-info.json`) — a convenience mirror of
    /// `status.ca` so the CA panel can render before the first apply. No key.
    pub ca: Option<serde_json::Value>,
}

/// GET /api/ssl-inspection/status
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<SslStatus>> {
    Ok(Json(SslStatus {
        status: read_json(&state.config.ssl_status_file),
        ca: read_json(&state.config.ssl_ca_info_file),
    }))
}

// ── CA download ─────────────────────────────────────────────────────────────

fn serve_ca(path: &Path, ctype: &str, filename: &str) -> Result<Response> {
    // Only ever the PUBLIC cert (ca.crt / ca.der). This function must never be
    // pointed at ca.key — the routes below hardcode the public paths.
    let bytes = std::fs::read(path).map_err(|_| {
        AppError::BadRequest(
            "the inspection CA has not been generated yet — enable SSL Inspection first".into(),
        )
    })?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Body::from(bytes),
    )
        .into_response())
}

/// GET /api/ssl-inspection/ca.crt — PEM, for macOS/Linux/iOS/Firefox import.
pub async fn ca_crt(State(state): State<Arc<AppState>>) -> Result<Response> {
    serve_ca(&state.config.ssl_ca_crt, "application/x-pem-file", "quartzfire-ssl-inspection.crt")
}

/// GET /api/ssl-inspection/ca.der — DER, for Windows/Android import.
pub async fn ca_der(State(state): State<Arc<AppState>>) -> Result<Response> {
    serve_ca(&state.config.ssl_ca_der, "application/x-x509-ca-cert", "quartzfire-ssl-inspection.der")
}

// ── regenerate trigger ──────────────────────────────────────────────────────

/// POST /api/ssl-inspection/regenerate — request a fresh inspection CA. WARNING
/// to the caller's UI: all previously distributed CAs become invalid and every
/// client must reinstall. The trigger file is bumped atomically (temp +
/// rename); the regeneration runs asynchronously as root — poll
/// /api/ssl-inspection/status for the new fingerprint.
pub async fn regenerate(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let path = &state.config.ssl_regen_request_file;
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
    let tmp = dir.join(".ssl-regen-request.tmp");
    std::fs::write(&tmp, body.to_string()).map_err(|e| {
        AppError::BadRequest(format!(
            "cannot write the regenerate trigger ({}): {e} — ensure quartzfire-ssl-inspection is \
             installed and /config/quartzfire is writable",
            tmp.display()
        ))
    })?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("activating {}: {e}", path.display())))?;
    Ok(Json(serde_json::json!({ "requested": true, "seq": seq })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn regen_seq_increments_from_existing_body() {
        let existing: serde_json::Value = serde_json::from_str(r#"{"seq": 7}"#).unwrap();
        let seq = existing.get("seq").and_then(|s| s.as_u64()).unwrap_or(0) + 1;
        assert_eq!(seq, 8);
        let missing: Option<serde_json::Value> = None;
        let seq = missing.and_then(|v| v.get("seq").and_then(|s| s.as_u64())).unwrap_or(0) + 1;
        assert_eq!(seq, 1);
    }
}
