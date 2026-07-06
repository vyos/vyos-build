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

    let bytes = axum::body::to_bytes(body, usize::MAX).await?;

    let mut builder = state
        .http
        .request(parts.method.clone(), &url)
        .body(bytes.to_vec());

    // Forward client headers except hop-by-hop ones and any client-supplied key.
    for (name, value) in parts.headers.iter() {
        let n = name.as_str().to_ascii_lowercase();
        if STRIP_HEADERS.contains(&n.as_str()) || n == "x-api-key" {
            continue;
        }
        builder = builder.header(name, value);
    }

    // Inject the real key server-side. VyOS HTTP API authenticates via `key`
    // form field; newer builds also honor the X-API-KEY header. We set the
    // header here and let the frontend include `key` placeholders if needed.
    let key = state.config.read_api_key();
    if !key.is_empty() {
        builder = builder.header(HeaderName::from_static("x-api-key"), key);
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

trait PathAndQuery {
    fn path_and_query(&self) -> Option<&str>;
}

impl PathAndQuery for axum::http::request::Parts {
    fn path_and_query(&self) -> Option<&str> {
        self.uri.path_and_query().map(|pq| pq.as_str())
    }
}
