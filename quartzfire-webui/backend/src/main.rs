mod auth;
mod config;
mod error;
mod ips;
mod monitor;
mod proxy;
mod vyos;

use anyhow::Result;
use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::{self, Next},
    response::Response,
    routing::{any, get, post, put},
    Router,
};
use std::sync::Arc;
use tower::ServiceExt as _;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use config::Config;

/// Shared state handed to every request handler.
pub struct AppState {
    pub config: Config,
    pub http: reqwest::Client,
    /// Secret used to sign session JWTs (see `auth::load_jwt_secret`).
    pub jwt_secret: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "quartzfire_webui=info,tower_http=info".into()),
        )
        .init();

    let config_path =
        std::env::var("QUARTZFIRE_WEBUI_CONFIG").unwrap_or_else(|_| "/etc/quartzfire/webui.toml".into());
    let config = Config::load(&config_path)?;
    tracing::info!(?config, "loaded configuration");

    let http = reqwest::Client::builder()
        // The VyOS API is local; if it is fronted by self-signed TLS, accept it.
        .danger_accept_invalid_certs(true)
        .build()?;

    let listen = config.listen.clone();
    let www_root = config.www_root.clone();
    let jwt_secret = auth::load_jwt_secret(&config.jwt_secret_file);
    let state = Arc::new(AppState { config, http, jwt_secret });

    // Everything except the SPA itself and login/logout requires a session:
    // the VyOS API proxy is the crown jewels, so it sits behind `require_auth`.
    let protected = Router::new()
        .route("/api/auth/me", get(auth::me))
        // Static routes win over the `/api/*rest` proxy wildcard.
        .route("/api/monitor/firewall-log", get(monitor::firewall_log))
        .route("/api/monitor/system-log", get(monitor::system_log))
        .route("/api/ips/status", get(ips::status))
        .route("/api/ips/settings", put(ips::put_settings))
        .route("/api/ips/update", post(ips::request_update))
        .route("/api/ips/alerts", get(ips::alerts))
        .route("/api/ips/alerts/history", get(ips::alerts_history))
        .route("/api", any(proxy::handler))
        .route("/api/*rest", any(proxy::handler))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    // Static SPA (public — it's just the login shell until a session exists).
    // `ServeDir` falls back to index.html so client-side routing works —
    // but only for page navigations. Asset paths (/_next/*) must 404 honestly
    // when a hashed file is gone (e.g. a stale shell after an image upgrade):
    // serving the HTML fallback there hands the browser HTML where it expects
    // CSS/JS, and it renders the page unstyled.
    let spa_service =
        ServeDir::new(&www_root).not_found_service(ServeFile::new(www_root.join("index.html")));
    let static_router = Router::new()
        .nest_service("/_next", ServeDir::new(www_root.join("_next")))
        .fallback_service(spa_service)
        .layer(middleware::from_fn(static_cache_control));

    let app = Router::new()
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .merge(protected)
        .fallback_service(static_router)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!("QuartzFire WebUI listening on {listen}");

    // Accept connections manually rather than via `axum::serve` so each
    // socket gets TCP_NODELAY. The Traffic Monitor streams one small SSE
    // frame per log entry; with Nagle on, those frames queue behind
    // unacknowledged segments and arrive in delayed batches.
    loop {
        let (socket, _addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                tracing::warn!("accept failed: {e}");
                continue;
            }
        };
        let _ = socket.set_nodelay(true);
        let router = app.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(
                move |request: hyper::Request<hyper::body::Incoming>| router.clone().oneshot(request),
            );
            if let Err(e) = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
                .serve_connection_with_upgrades(hyper_util::rt::TokioIo::new(socket), service)
                .await
            {
                tracing::debug!("connection error: {e}");
            }
        });
    }
}

/// Cache policy for the static SPA. Without an explicit Cache-Control,
/// browsers cache heuristically — after an upgrade a stale HTML shell then
/// references content-hashed chunks that no longer exist and the page renders
/// blank until a hard refresh. Hashed Next.js assets never change under the
/// same name, so they cache forever; everything else (HTML shells, favicon)
/// revalidates on every load, answered with a cheap 304 via the
/// Last-Modified/ETag that `ServeDir` already emits.
async fn static_cache_control(req: Request, next: Next) -> Response {
    let hashed_asset = req.uri().path().starts_with("/_next/static/");
    let mut resp = next.run(req).await;
    // Only successful asset responses may cache forever. A 404 (or the SPA
    // fallback) marked immutable would poison the browser cache for a year
    // under that URL — one bad fetch during an upgrade and the page stays
    // broken until the user clears site data.
    let immutable = hashed_asset && resp.status().is_success();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    resp
}
