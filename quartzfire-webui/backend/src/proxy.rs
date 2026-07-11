use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderName, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

use crate::AppState;

/// Hop-by-hop headers that must not be forwarded across the proxy boundary.
const STRIP_HEADERS: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

/// Reverse-proxy any `/api/*` request to the local VyOS HTTP API, injecting the
/// API key server-side. The browser never sees the key.
///
/// The incoming path `/api/retrieve` maps to `<vyos_api_url>/retrieve`.
pub async fn handler(State(state): State<Arc<AppState>>, req: Request) -> Response {
    // While a commit-confirm change is awaiting confirmation, raw config
    // writes are refused: another /configure would muddy the revert snapshot,
    // and a /config-file save would persist the unconfirmed change to the
    // boot config — defeating the guard (see guard.rs).
    let path = req.uri().path();
    if (path.starts_with("/api/configure") || path.starts_with("/api/config-file"))
        && state.guard.is_pending()
    {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "success": false,
                "error": "A change is awaiting confirmation — confirm or revert it first.",
            })),
        )
            .into_response();
    }
    match forward(state, req).await {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!("proxy error: {e:#}");
            (StatusCode::BAD_GATEWAY, "upstream VyOS API unreachable").into_response()
        }
    }
}

async fn forward(state: Arc<AppState>, req: Request) -> anyhow::Result<Response> {
    let (parts, body) = req.into_parts();

    // Strip the `/api` prefix; the VyOS API endpoints live at the root.
    let path = parts.path_and_query().unwrap_or("/api");
    let path = path.strip_prefix("/api").unwrap_or(path);
    let path = if path.is_empty() { "/" } else { path };
    let url = format!("{}{}", state.config.vyos_api_url.trim_end_matches('/'), path);

    let mut body_bytes = axum::body::to_bytes(body, usize::MAX).await?.to_vec();

    // VyOS HTTP API authenticates via a `key` form field (application/x-www-
    // form-urlencoded: `data=<json>&key=<key>`). Inject the key server-side and
    // force the form content type, so the browser never carries the key.
    let key = state.config.read_api_key();
    let inject_key = !key.is_empty();
    if inject_key {
        if !body_bytes.is_empty() {
            body_bytes.push(b'&');
        }
        body_bytes.extend_from_slice(b"key=");
        body_bytes.extend_from_slice(percent_encode(&key).as_bytes());
    }

    let mut builder = state
        .http
        .request(parts.method.clone(), &url)
        .body(body_bytes);

    // Forward client headers, except hop-by-hop ones, any client-supplied key,
    // the session cookie (the VyOS API has no business seeing our JWT), and
    // the length/type we are about to override.
    for (name, value) in parts.headers.iter() {
        let n = name.as_str().to_ascii_lowercase();
        if STRIP_HEADERS.contains(&n.as_str())
            || n == "x-api-key"
            || n == "cookie"
            || n == "content-length"
            || (inject_key && n == "content-type")
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    if inject_key {
        builder = builder.header(
            HeaderName::from_static("content-type"),
            "application/x-www-form-urlencoded",
        );
    }

    let upstream = builder.send().await?;

    let status = upstream.status();
    let mut resp = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        let n = name.as_str().to_ascii_lowercase();
        if STRIP_HEADERS.contains(&n.as_str()) {
            continue;
        }
        resp = resp.header(name, value);
    }

    let stream = upstream.bytes_stream();
    Ok(resp.body(Body::from_stream(stream))?)
}

/// Minimal application/x-www-form-urlencoded value encoding for the API key.
/// Keeps RFC 3986 unreserved characters; percent-encodes everything else.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

trait PathAndQuery {
    fn path_and_query(&self) -> Option<&str>;
}

impl PathAndQuery for axum::http::request::Parts {
    fn path_and_query(&self) -> Option<&str> {
        self.uri.path_and_query().map(|pq| pq.as_str())
    }
}
