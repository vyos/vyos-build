//! Server-side client for the local VyOS HTTP API, used by the backend itself
//! (e.g. to read `system login user` for authentication). Browser traffic goes
//! through `proxy.rs` instead; both inject the API key so it never leaves the box.

use serde_json::Value;
use std::sync::Arc;

use crate::{
    error::{AppError, Result},
    AppState,
};

/// POST an operation to a VyOS API endpoint (`/retrieve`, `/show`, …) and
/// return the parsed envelope (`{"success": bool, "data": …, "error": …}`).
pub async fn api_request(state: &Arc<AppState>, endpoint: &str, data: &Value) -> Result<Value> {
    let url = format!(
        "{}/{}",
        state.config.vyos_api_url.trim_end_matches('/'),
        endpoint.trim_start_matches('/')
    );
    let key = state.config.read_api_key();

    let resp = state
        .http
        .post(&url)
        .form(&[("data", data.to_string().as_str()), ("key", key.as_str())])
        .send()
        .await
        .map_err(|e| AppError::Gateway(format!("VyOS API unreachable: {e}")))?;

    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Gateway(format!("invalid VyOS API response: {e}")))?;

    // VyOS reports failures both via HTTP status and the `success` flag.
    if !status.is_success() || body.get("success").and_then(Value::as_bool) != Some(true) {
        let err = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(AppError::Gateway(format!("VyOS API error: {err}")));
    }
    Ok(body)
}

/// `showConfig` at `path`, returning the JSON subtree under that node.
pub async fn show_config(state: &Arc<AppState>, path: &[&str]) -> Result<Value> {
    let body = api_request(
        state,
        "retrieve",
        &serde_json::json!({ "op": "showConfig", "path": path }),
    )
    .await?;
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}
