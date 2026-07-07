//! Session authentication against the users configured on VyOS itself.
//!
//! Login flow (security model ported from vyos-fabric):
//!  1. The browser POSTs `{username, password}` to `/api/auth/login`.
//!  2. The backend reads `system login user` from the local VyOS API (using the
//!     server-held API key) and verifies the password against that user's
//!     `encrypted-password` crypt hash (`$6$` sha512-crypt) in-process. The
//!     daemon runs unprivileged (`DynamicUser`), so PAM//etc/shadow is not an
//!     option — the VyOS config tree is the source of truth for users anyway.
//!  3. On success it issues a JWT carried in an httpOnly `SameSite=Lax` cookie
//!     (`Secure` in production). JS can never read the token; the only
//!     client-side state is a non-sensitive cached user for display.
//!  4. `require_auth` gates every `/api/*` route — including the VyOS API
//!     proxy — so no config can be read or changed without a valid session.

use axum::{
    extract::{Request, State},
    http::{header::SET_COOKIE, HeaderMap},
    middleware::Next,
    response::{IntoResponse, Response},
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    error::{AppError, Result},
    vyos, AppState,
};

pub const COOKIE_NAME: &str = "quartzfire_token";

/// JWT payload. `sub` is the VyOS username.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
}

impl Claims {
    fn new(username: &str, session_hours: u64) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            sub: username.to_string(),
            iat: now as usize,
            exp: (now + session_hours * 3600) as usize,
        }
    }
}

// ── JWT ───────────────────────────────────────────────────────────────────────

fn encode_token(claims: &Claims, secret: &str) -> anyhow::Result<String> {
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| anyhow::anyhow!("token encode failed: {e}"))
}

fn decode_token(token: &str, secret: &str) -> anyhow::Result<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| anyhow::anyhow!("token decode failed: {e}"))
}

/// Load the JWT signing secret from `config.jwt_secret_file`, generating and
/// persisting a random one on first start (the systemd unit provides a
/// writable `StateDirectory`). Falls back to an ephemeral in-memory secret if
/// the file cannot be written (local dev) — sessions then die with the process.
pub fn load_jwt_secret(path: &std::path::Path) -> String {
    match std::fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => return s.trim().to_string(),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("could not read jwt secret {}: {e}", path.display()),
    }

    let bytes: [u8; 32] = rand::random();
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(path, &secret) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
            tracing::info!("generated new session secret at {}", path.display());
        }
        Err(e) => tracing::warn!(
            "could not persist session secret to {} ({e}); sessions will not survive restarts",
            path.display()
        ),
    }
    secret
}

// ── Cookies ───────────────────────────────────────────────────────────────────

/// `Set-Cookie` value carrying the session JWT (httpOnly so JS can't read it).
fn session_cookie(token: &str, secure: bool, max_age_secs: u64) -> String {
    let mut c =
        format!("{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age_secs}");
    if secure {
        c.push_str("; Secure");
    }
    c
}

/// `Set-Cookie` value that expires the session cookie immediately.
fn clear_cookie(secure: bool) -> String {
    let mut c = format!("{COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    if secure {
        c.push_str("; Secure");
    }
    c
}

/// Pull the JWT from the session cookie, falling back to `Authorization: Bearer`
/// (handy for curl/tests).
fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(cookie) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    {
        for part in cookie.split(';') {
            if let Some(val) = part.trim().strip_prefix(&format!("{COOKIE_NAME}=")) {
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(str::to_string)
}

// ── VyOS user verification ────────────────────────────────────────────────────

/// Look up `username` under `system login user` and verify `password` against
/// its `encrypted-password` crypt hash. Uniform `Unauthorized` for unknown
/// users, locked accounts, and wrong passwords; a dummy hash round keeps the
/// unknown-user timing indistinguishable from a real verification.
async fn verify_vyos_user(state: &Arc<AppState>, username: &str, password: &str) -> Result<()> {
    let data = vyos::show_config(state, &["system", "login", "user"]).await?;

    // `showConfig` is backed by `cli-shell-api showConfig <path>`, whose output
    // for a tag-node path includes the node name — the subtree arrives as
    // {"user": {"<name>": …}}. Accept the unwrapped shape too, just in case.
    let user_entry = data
        .get(username)
        .or_else(|| data.get("user").and_then(|u| u.get(username)));

    let stored = user_entry
        .and_then(|u| u.get("authentication"))
        .and_then(|a| a.get("encrypted-password"))
        .and_then(Value::as_str)
        .map(str::to_string);

    // The client always gets a uniform 401; the journal gets the real story.
    match &stored {
        None if user_entry.is_none() => {
            tracing::warn!(user = %username, "login failed: no such user in system login config")
        }
        None => {
            tracing::warn!(user = %username, "login failed: user has no encrypted-password")
        }
        Some(h) if !h.starts_with('$') => {
            tracing::warn!(user = %username, "login failed: account locked or hash unusable")
        }
        Some(h) => {
            let scheme: String = h.chars().take(3).collect();
            tracing::debug!(user = %username, %scheme, "verifying password hash");
        }
    }

    // sha512-crypt is deliberately slow (thousands of rounds) — keep it off the
    // async runtime, and burn the same work when the user doesn't exist.
    let had_hash = stored.is_some();
    let password = password.to_string();
    let ok = tokio::task::spawn_blocking(move || match stored {
        Some(hash) => pwhash::unix::verify(&password, &hash),
        None => {
            let _ = pwhash::sha512_crypt::hash(&password);
            false
        }
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("verify task failed: {e}")))?;

    if ok {
        Ok(())
    } else {
        if had_hash {
            tracing::warn!(user = %username, "login failed: password verification failed");
        }
        Err(AppError::Unauthorized)
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

/// The user object returned to the SPA. VyOS 1.4+ has no operator level — every
/// login user is an administrator — so `role` is fixed until that changes.
fn user_body(username: &str) -> Value {
    serde_json::json!({ "username": username, "role": "admin" })
}

/// POST /api/auth/login — public.
pub async fn login(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<LoginRequest>,
) -> Result<Response> {
    if body.username.is_empty() || body.password.is_empty() {
        return Err(AppError::BadRequest("username and password are required".into()));
    }

    verify_vyos_user(&state, &body.username, &body.password).await?;
    tracing::info!(user = %body.username, "login ok");

    let claims = Claims::new(&body.username, state.config.session_hours);
    let token = encode_token(&claims, &state.jwt_secret).map_err(AppError::Internal)?;
    let cookie = session_cookie(
        &token,
        state.config.cookie_secure,
        state.config.session_hours * 3600,
    );

    Ok((
        [(SET_COOKIE, cookie)],
        axum::Json(user_body(&body.username)),
    )
        .into_response())
}

/// POST /api/auth/logout — public (clearing a cookie needs no session).
pub async fn logout(State(state): State<Arc<AppState>>) -> Response {
    (
        [(SET_COOKIE, clear_cookie(state.config.cookie_secure))],
        axum::Json(serde_json::json!({ "ok": true })),
    )
        .into_response()
}

/// GET /api/auth/me — behind `require_auth`. The cookie is httpOnly, so this is
/// how the SPA learns whether (and as whom) it is logged in.
pub async fn me(req: Request) -> Result<axum::Json<Value>> {
    let claims = req
        .extensions()
        .get::<Claims>()
        .ok_or(AppError::Unauthorized)?;
    Ok(axum::Json(user_body(&claims.sub)))
}

// ── Middleware ────────────────────────────────────────────────────────────────

/// Requires a valid session (cookie or Bearer). Inserts `Claims` into the
/// request extensions for downstream handlers.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response> {
    let token = extract_token(req.headers()).ok_or(AppError::Unauthorized)?;
    let claims =
        decode_token(&token, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}
