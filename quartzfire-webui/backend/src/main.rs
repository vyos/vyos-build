mod config;
mod proxy;

use anyhow::Result;
use axum::{routing::any, Router};
use std::sync::Arc;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use config::Config;

/// Shared state handed to every request handler.
pub struct AppState {
    pub config: Config,
    pub http: reqwest::Client,
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
    let state = Arc::new(AppState { config, http });

    // `/api/*` is reverse-proxied to VyOS; everything else is the static SPA.
    // `ServeDir` falls back to index.html so client-side routing works.
    let static_service =
        ServeDir::new(&www_root).not_found_service(ServeFile::new(www_root.join("index.html")));

    let app = Router::new()
        .route("/api", any(proxy::handler))
        .route("/api/*rest", any(proxy::handler))
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!("QuartzFire WebUI listening on {listen}");
    axum::serve(listener, app).await?;
    Ok(())
}
