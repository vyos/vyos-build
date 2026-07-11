//! Browser ISO upload for system-image installs.
//!
//! `add system image <url>` normally makes the DEVICE fetch the ISO; these
//! endpoints let the browser upload one instead. The file is staged in
//! `guard_dir` (`/config/quartzfire`) — the one path both this sandboxed
//! backend (writer) and the root VyOS API (reader; the image add op takes a
//! local path as its url) can reach; `PrivateTmp` rules out /tmp, and the
//! image partition is where the unpacked image lands anyway. The frontend
//! uploads, points the regular image-add op at the returned path, then
//! DELETEs the staging file — which is also safe to call at any time.

use axum::{body::Body, extract::State, Json};
use serde_json::json;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;

use crate::error::{AppError, Result};
use crate::AppState;

const UPLOAD_NAME: &str = "upload.iso";
/// Hard cap — QuartzFire ISOs run ~500 MB; anything past this is not one.
const MAX_ISO_BYTES: u64 = 4 * 1024 * 1024 * 1024;

fn upload_path(state: &AppState) -> std::path::PathBuf {
    state.config.guard_dir.join(UPLOAD_NAME)
}

/// POST /api/image/upload — stream the request body to the staging file.
/// Returns `{path, bytes}`; the client then runs the regular image-add op
/// against `path`.
pub async fn upload(State(state): State<Arc<AppState>>, body: Body) -> Result<Json<serde_json::Value>> {
    let path = upload_path(&state);
    let _ = std::fs::create_dir_all(&state.config.guard_dir);

    let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
        AppError::Internal(anyhow::anyhow!("creating {}: {e}", path.display()))
    })?;

    let mut stream = body.into_data_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                return Err(AppError::BadRequest(format!("upload interrupted: {e}")));
            }
        };
        written += chunk.len() as u64;
        if written > MAX_ISO_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::BadRequest(
                "the uploaded file is larger than any system image (4 GB cap)".into(),
            ));
        }
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::Internal(anyhow::anyhow!(
                "writing {}: {e} — is the config partition out of space?",
                path.display()
            )));
        }
    }
    file.flush().await.ok();
    file.sync_all().await.ok();

    if written == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::BadRequest("the uploaded file is empty".into()));
    }
    Ok(Json(json!({ "path": path.to_string_lossy(), "bytes": written })))
}

/// DELETE /api/image/upload — remove the staging file (idempotent).
pub async fn cleanup(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let _ = tokio::fs::remove_file(upload_path(&state)).await;
    Ok(Json(json!({ "ok": true })))
}
