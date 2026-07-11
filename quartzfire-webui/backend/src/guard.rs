//! Commit-confirm safety net and config lifecycle (backup / restore / rollback).
//!
//! The #1 way to lose a remote firewall is committing a change that severs
//! your own session — you can't undo what you can no longer reach. Risky
//! changes (firewall, interfaces, NAT, routing, restores, rollbacks) therefore
//! go through this module instead of straight to `/configure`:
//!
//!  1. `apply` snapshots the running config (`config-file save` to a file in
//!     `guard_dir` — NOT `show configuration`, which masks secrets; see
//!     `save_running_config`), commits the change, and arms a server-side
//!     revert timer.
//!  2. The user must `confirm` within the window (default 60s). Only then is
//!     the change persisted to the boot config.
//!  3. No confirmation — because the change cut the session, or the user
//!     walked away — and the timer loads the snapshot back via the VyOS API,
//!     restoring the pre-change config. The boot config was never touched, so
//!     a panic power-cycle also comes back in the old state.
//!
//! On top of the timer, `apply` runs a static anti-lockout check: a change
//! that deletes or disables the very interface/address the management session
//! rides on is refused outright unless the client passes `override_lockout`
//! (the UI asks first). Firewall-rule reachability is NOT statically analysed
//! — that's what the revert timer is for.
//!
//! Restore and rollback reuse the same machinery: the target config is loaded
//! with `config-file load` (which commits), guarded by the same snapshot +
//! timer. The snapshot travels through `guard_dir` (default
//! `/config/quartzfire`) because the sandboxed backend and the root VyOS API
//! need a common readable path — `PrivateTmp` rules out /tmp.

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

use crate::{
    error::{AppError, Result},
    vyos, AppState,
};

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MIN_TIMEOUT_SECS: u64 = 15;
const MAX_TIMEOUT_SECS: u64 = 600;
/// Uploaded config size cap — config.boot files are tens of KB; anything
/// megabytes-large is not a config.
const MAX_RESTORE_BYTES: usize = 4 * 1024 * 1024;

// ── state ─────────────────────────────────────────────────────────────────────

/// One committed-but-unconfirmed change.
struct Pending {
    id: String,
    description: String,
    deadline: Instant,
    timeout_secs: u64,
    /// Pre-change running config, saved to a file in `guard_dir` by the VyOS
    /// API itself (`config-file save`) — what the revert loads back. A file
    /// path rather than text: the API writes and reads it as root, so the
    /// sandboxed backend never needs to touch the (secret-bearing) contents.
    snapshot_path: PathBuf,
}

/// How the last guarded change ended — kept until the next one starts so the
/// UI can tell the user what happened after an expiry (or a lockout+recovery).
#[derive(Clone, Serialize)]
pub struct LastOutcome {
    /// "confirmed" | "reverted" | "revert_failed"
    outcome: &'static str,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Default)]
struct GuardInner {
    pending: Option<Pending>,
    /// True while a revert is executing — blocks new applies so a snapshot is
    /// never taken of a half-reverted config.
    reverting: bool,
    /// Last outcome and when it happened, so /guard/pending can report a
    /// recent auto-revert to a session that reconnects after being cut off.
    last: Option<(LastOutcome, Instant)>,
}

/// Shared commit-confirm state, one per process (hangs off `AppState`).
#[derive(Default)]
pub struct Guard {
    inner: Mutex<GuardInner>,
}

/// The pending-change descriptor returned to the client. `remaining_secs` is
/// computed server-side so the browser never has to trust the appliance's
/// wall clock.
#[derive(Serialize)]
pub struct PendingInfo {
    id: String,
    description: String,
    remaining_secs: u64,
    timeout_secs: u64,
}

fn pending_info(p: &Pending) -> PendingInfo {
    PendingInfo {
        id: p.id.clone(),
        description: p.description.clone(),
        remaining_secs: p.deadline.saturating_duration_since(Instant::now()).as_secs(),
        timeout_secs: p.timeout_secs,
    }
}

impl Guard {
    /// Whether a change is awaiting confirmation (or a revert is running).
    /// The proxy uses this to refuse raw `/configure` and `/config-file`
    /// calls that would muddy the snapshot or persist an unconfirmed config.
    pub fn is_pending(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.pending.is_some() || inner.reverting
    }
}

fn conflict(msg: &str) -> Response {
    (StatusCode::CONFLICT, Json(json!({ "error": msg }))).into_response()
}

// ── request bodies ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ApplyRequest {
    /// The `/configure` payload: an array of `{op, path}` commands, forwarded
    /// verbatim to the VyOS API after the checks pass.
    commands: Value,
    /// Short human label shown in the confirm banner ("Firewall rule change").
    description: String,
    timeout_secs: Option<u64>,
    /// Client acknowledged the anti-lockout warning and wants the change anyway.
    #[serde(default)]
    override_lockout: bool,
}

#[derive(Deserialize)]
pub struct IdRequest {
    id: String,
}

#[derive(Deserialize)]
pub struct RestoreRequest {
    /// Full config.boot-style text to load.
    content: String,
    timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
pub struct RollbackRequest {
    revision: u64,
    timeout_secs: Option<u64>,
}

fn clamp_timeout(req: Option<u64>) -> u64 {
    req.unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS)
}

fn clean_description(s: &str) -> String {
    let d = s.trim();
    let d = if d.is_empty() { "Configuration change" } else { d };
    d.chars().take(120).collect()
}

// ── snapshot / revert plumbing ────────────────────────────────────────────────

/// Save the running config to `name` under `guard_dir` via the VyOS API
/// (`config-file save` with a file argument) and return the path.
///
/// This must NOT be `show configuration`: that op runs
/// `cli-shell-api showCfg --show-hide-secrets`, which replaces every secret
/// (API keys, password hashes, PSKs, …) with a `****************` mask.
/// Loading such a snapshot back would commit the mask literals over the real
/// values — bricking, among other things, the very API key this backend uses
/// and every user's login password. `config-file save` writes the real config
/// (with the version footer `config-file load` migration wants).
async fn save_running_config(state: &Arc<AppState>, name: &str) -> Result<PathBuf> {
    let dir = &state.config.guard_dir;
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(name);
    // Best-effort removal so a stale file from an earlier run can never pass
    // the freshness check below. The API's save overwrites as root anyway.
    let _ = std::fs::remove_file(&path);

    vyos::api_request(
        state,
        "config-file",
        &json!({ "op": "save", "file": path.to_string_lossy() }),
    )
    .await?;

    // An empty (or unwritten) snapshot could never be restored — refuse to
    // arm a guard that cannot revert.
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > 0 => Ok(path),
        _ => Err(AppError::Gateway(
            "could not snapshot the running configuration; change not applied".into(),
        )),
    }
}

/// Load the config file at `path` as the full running config via the VyOS
/// API (load + commit). `path` must be under `guard_dir` — the one directory
/// both the sandboxed backend and the root VyOS API process can reach.
async fn load_config_file(state: &Arc<AppState>, path: &std::path::Path) -> Result<()> {
    vyos::api_request(
        state,
        "config-file",
        &json!({ "op": "load", "file": path.to_string_lossy() }),
    )
    .await
    .map(|_| ())
}

/// Load `config_text` as the full running config via the VyOS API (load +
/// commit). The text goes through a file in `guard_dir` because the API takes
/// a path, and that directory is the one both the sandboxed backend (writer)
/// and the root API process (reader) can reach.
async fn load_config_text(state: &Arc<AppState>, config_text: &str, name: &str) -> Result<()> {
    let dir = &state.config.guard_dir;
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(name);
    std::fs::write(&path, config_text).map_err(|e| {
        AppError::Internal(anyhow::anyhow!("writing {}: {e}", path.display()))
    })?;

    let result = load_config_file(state, &path).await;
    let _ = std::fs::remove_file(&path);
    result
}

/// Register a pending change and arm its revert timer. Caller must have
/// already committed the change successfully.
fn begin_pending(
    state: &Arc<AppState>,
    snapshot_path: PathBuf,
    description: String,
    timeout_secs: u64,
) -> PendingInfo {
    let id: String = {
        let bytes: [u8; 8] = rand::random();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let pending = Pending {
        id: id.clone(),
        description,
        deadline,
        timeout_secs,
        snapshot_path,
    };
    let info = pending_info(&pending);
    state.guard.inner.lock().unwrap().pending = Some(pending);

    let timer_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        expire(timer_state, id).await;
    });
    info
}

/// Timer body: if the same change is still unconfirmed at its deadline, load
/// the snapshot back.
async fn expire(state: Arc<AppState>, id: String) {
    let pending = {
        let mut inner = state.guard.inner.lock().unwrap();
        match &inner.pending {
            Some(p) if p.id == id => {
                inner.reverting = true;
                inner.pending.take()
            }
            _ => return, // confirmed, manually reverted, or superseded
        }
    };
    let Some(pending) = pending else { return };
    tracing::warn!(
        change = %pending.description,
        "commit-confirm window expired — reverting"
    );
    revert_pending(&state, pending).await;
}

/// Load the snapshot back and record the outcome. Used by both the expiry
/// timer and the manual revert endpoint (caller has already detached the
/// `Pending` and set `reverting`).
async fn revert_pending(state: &Arc<AppState>, pending: Pending) -> LastOutcome {
    let result = load_config_file(state, &pending.snapshot_path).await;
    let outcome = match result {
        Ok(()) => {
            tracing::info!(change = %pending.description, "reverted unconfirmed change");
            let _ = std::fs::remove_file(&pending.snapshot_path);
            LastOutcome {
                outcome: "reverted",
                description: pending.description,
                error: None,
            }
        }
        Err(e) => {
            // The worst case: an unconfirmed change we cannot undo. Leave a
            // loud trace — console access may be needed.
            tracing::error!(change = %pending.description, "REVERT FAILED: {e}");
            LastOutcome {
                outcome: "revert_failed",
                description: pending.description,
                error: Some(e.to_string()),
            }
        }
    };
    let mut inner = state.guard.inner.lock().unwrap();
    inner.reverting = false;
    inner.last = Some((outcome.clone(), Instant::now()));
    outcome
}

// ── anti-lockout analysis ─────────────────────────────────────────────────────

/// The IP the browser reached us via, from the `Host` header (nginx forwards
/// `$host`). None when the UI is reached by DNS name — the static check then
/// stands down and the revert timer alone protects the session.
fn management_ip(headers: &HeaderMap) -> Option<IpAddr> {
    let host = headers.get(header::HOST)?.to_str().ok()?.trim();
    if host.is_empty() {
        return None;
    }
    // [v6]:port / [v6]
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next()?.parse().ok();
    }
    // Bare v6 (multiple colons), v4:port, or bare v4/hostname.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    let (h, _port) = host.rsplit_once(':')?;
    h.parse().ok()
}

/// Typed view of one `/configure` command, for analysis only (the original
/// JSON is what gets forwarded).
#[derive(Deserialize)]
struct CmdCheck {
    op: String,
    #[serde(default)]
    path: Vec<String>,
}

/// Does `addr` ("192.0.2.1/24") carry `ip`?
fn cidr_matches_ip(addr: &str, ip: &IpAddr) -> bool {
    addr.split('/')
        .next()
        .and_then(|a| a.parse::<IpAddr>().ok())
        .map(|a| a == *ip)
        .unwrap_or(false)
}

fn node_addresses(cfg: &Value) -> Vec<String> {
    match cfg.get("address") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Config paths (under `interfaces`) of every interface/vif that carries the
/// management IP, e.g. `["interfaces","ethernet","eth0"]` or
/// `[…,"eth0","vif","20"]`, paired with a display name ("eth0", "eth0.20").
async fn mgmt_interface_paths(state: &Arc<AppState>, ip: &IpAddr) -> Vec<(Vec<String>, String)> {
    let Ok(data) = vyos::show_config(state, &["interfaces"]).await else {
        // Can't read the config — don't block the change; the revert timer
        // still protects it.
        return Vec::new();
    };
    // showConfig may or may not wrap the subtree in its own node name.
    let data = data.get("interfaces").unwrap_or(&data);

    let mut out = Vec::new();
    let Some(kinds) = data.as_object() else {
        return out;
    };
    for (kind, nodes) in kinds {
        let Some(nodes) = nodes.as_object() else { continue };
        for (name, cfg) in nodes {
            if node_addresses(cfg).iter().any(|a| cidr_matches_ip(a, ip)) {
                out.push((
                    vec!["interfaces".into(), kind.clone(), name.clone()],
                    name.clone(),
                ));
            }
            let Some(vifs) = cfg.get("vif").and_then(Value::as_object) else {
                continue;
            };
            for (vid, vcfg) in vifs {
                if node_addresses(vcfg).iter().any(|a| cidr_matches_ip(a, ip)) {
                    out.push((
                        vec![
                            "interfaces".into(),
                            kind.clone(),
                            name.clone(),
                            "vif".into(),
                            vid.clone(),
                        ],
                        format!("{name}.{vid}"),
                    ));
                }
            }
        }
    }
    out
}

/// Reasons the command list would sever the management session, empty when it
/// looks safe. Only interface-level cuts are detected statically (deleting or
/// disabling the interface/address the session rides on); firewall reachability
/// is left to the commit-confirm timer.
async fn lockout_reasons(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    commands: &[Value],
) -> Vec<String> {
    let cmds: Vec<CmdCheck> = commands
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    // Only interface ops can trip the static check — skip the config read
    // (an extra API round trip) for firewall/NAT changes.
    if !cmds.iter().any(|c| c.path.first().map(String::as_str) == Some("interfaces")) {
        return Vec::new();
    }
    let Some(ip) = management_ip(headers) else {
        return Vec::new();
    };
    let mgmt = mgmt_interface_paths(state, &ip).await;
    check_commands(&cmds, &mgmt, &ip)
}

/// Pure half of the anti-lockout analysis, split out for testability.
fn check_commands(
    cmds: &[CmdCheck],
    mgmt: &[(Vec<String>, String)],
    ip: &IpAddr,
) -> Vec<String> {
    let mut reasons = Vec::new();
    for cmd in cmds {
        for (prefix, display) in mgmt {
            let is_prefix_of_mgmt =
                cmd.path.len() <= prefix.len() && prefix.starts_with(&cmd.path[..]);
            let rest = cmd.path.strip_prefix(prefix.as_slice());
            match (cmd.op.as_str(), rest) {
                ("delete", _) if is_prefix_of_mgmt && !cmd.path.is_empty() => {
                    reasons.push(format!(
                        "deletes interface {display}, which carries your management session ({ip})"
                    ));
                }
                ("delete", Some([leaf])) if leaf == "address" => {
                    reasons.push(format!(
                        "removes every address from interface {display}, including the one your session uses ({ip})"
                    ));
                }
                ("delete", Some([leaf, addr]))
                    if leaf == "address" && cidr_matches_ip(addr, ip) =>
                {
                    reasons.push(format!(
                        "removes address {addr} from interface {display} — the address your session is connected to"
                    ));
                }
                ("set", Some([leaf])) if leaf == "disable" => {
                    reasons.push(format!(
                        "administratively disables interface {display}, which carries your management session ({ip})"
                    ));
                }
                _ => {}
            }
        }
    }
    reasons.sort();
    reasons.dedup();
    reasons
}

// ── endpoints: commit-confirm ─────────────────────────────────────────────────

/// POST /api/guard/apply — commit a command list under commit-confirm.
/// 409 with `{lockout: [...]}` when the anti-lockout check trips (retry with
/// `override_lockout: true` to proceed anyway); 409 without it when another
/// change is already awaiting confirmation.
pub async fn apply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ApplyRequest>,
) -> Result<Response> {
    let commands = match req.commands.as_array() {
        Some(a) if !a.is_empty() => a.clone(),
        _ => return Err(AppError::BadRequest("commands must be a non-empty array".into())),
    };
    if state.guard.is_pending() {
        return Ok(conflict(
            "Another change is awaiting confirmation — confirm or revert it first.",
        ));
    }

    if !req.override_lockout {
        let reasons = lockout_reasons(&state, &headers, &commands).await;
        if !reasons.is_empty() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "This change would cut off your own access to the firewall.",
                    "lockout": reasons,
                })),
            )
                .into_response());
        }
    }

    let snapshot_path = save_running_config(&state, "guard-snapshot.boot").await?;
    vyos::api_request(&state, "configure", &Value::Array(commands)).await?;

    let info = begin_pending(
        &state,
        snapshot_path,
        clean_description(&req.description),
        clamp_timeout(req.timeout_secs),
    );
    Ok(Json(info).into_response())
}

/// POST /api/guard/confirm — keep the pending change: cancel the revert and
/// persist the running config to the boot config.
pub async fn confirm(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IdRequest>,
) -> Result<Response> {
    let confirmed = {
        let mut inner = state.guard.inner.lock().unwrap();
        match &inner.pending {
            Some(p) if p.id == req.id => inner.pending.take().unwrap(),
            Some(_) => return Ok(conflict("A different change is pending.")),
            None => {
                return Ok(conflict(
                    "No change is awaiting confirmation — it may have already been reverted.",
                ))
            }
        }
    };
    let description = confirmed.description;
    // The snapshot is no longer a revert target — don't leave secret-bearing
    // config files lying around longer than needed.
    let _ = std::fs::remove_file(&confirmed.snapshot_path);

    // The change is now permanent in the running config; persist it so it
    // survives a reboot. A save failure doesn't un-confirm — report it.
    let save = vyos::api_request(&state, "config-file", &json!({ "op": "save" })).await;
    let (boot_saved, error) = match save {
        Ok(_) => (true, None),
        Err(e) => {
            tracing::error!("boot-config save after confirm failed: {e}");
            (false, Some(e.to_string()))
        }
    };
    state.guard.inner.lock().unwrap().last = Some((
        LastOutcome {
            outcome: "confirmed",
            description,
            error: error.clone(),
        },
        Instant::now(),
    ));
    Ok(Json(json!({ "ok": true, "boot_saved": boot_saved, "error": error })).into_response())
}

/// POST /api/guard/revert — undo the pending change immediately instead of
/// waiting out the timer.
pub async fn revert(
    State(state): State<Arc<AppState>>,
    Json(req): Json<IdRequest>,
) -> Result<Response> {
    let pending = {
        let mut inner = state.guard.inner.lock().unwrap();
        match &inner.pending {
            Some(p) if p.id == req.id => {
                inner.reverting = true;
                inner.pending.take().unwrap()
            }
            Some(_) => return Ok(conflict("A different change is pending.")),
            None => {
                return Ok(conflict(
                    "No change is awaiting confirmation — it may have already been reverted.",
                ))
            }
        }
    };
    let outcome = revert_pending(&state, pending).await;
    if outcome.outcome == "revert_failed" {
        return Err(AppError::Gateway(format!(
            "revert failed: {} — the unconfirmed change is still live",
            outcome.error.unwrap_or_default()
        )));
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

/// GET /api/guard/pending — current pending change (if any) plus how the last
/// one ended. The UI polls this on load and after an expiry to learn what
/// happened.
pub async fn pending(State(state): State<Arc<AppState>>) -> Result<Response> {
    let inner = state.guard.inner.lock().unwrap();
    let pending = inner.pending.as_ref().map(pending_info);
    // `ago_secs` lets a reconnecting session distinguish "my change was just
    // auto-reverted" from ancient history, without trusting wall clocks.
    let last = inner.last.as_ref().map(|(outcome, at)| {
        let mut v = serde_json::to_value(outcome).unwrap_or(Value::Null);
        if let Some(obj) = v.as_object_mut() {
            obj.insert("ago_secs".into(), json!(at.elapsed().as_secs()));
        }
        v
    });
    Ok(Json(json!({ "pending": pending, "last": last })).into_response())
}

// ── endpoints: backup / restore / rollback ────────────────────────────────────

/// GET /api/config/backup — the running configuration as a downloadable
/// config.boot-style file.
///
/// Sourced from the commit archive (`show system commit file 0` — the most
/// recent commit, which through the API always equals the running config,
/// since every API change commits). NOT `config-file save` to a file: the
/// VyOS API writes that as root via write_file_atomic (temp + rename), with
/// a mode the sandboxed backend cannot read back (the snapshot flow never
/// reads its files — only backup does). And NOT `show configuration`, whose
/// output masks every secret — restoring such a backup would commit the mask
/// literals over the real values.
pub async fn backup(State(state): State<Arc<AppState>>) -> Result<Response> {
    let body = vyos::api_request(
        &state,
        "show",
        &json!({ "op": "show", "path": ["system", "commit", "file", "0"] }),
    )
    .await
    .map_err(|e| {
        AppError::Gateway(format!("could not read the current configuration: {e}"))
    })?;
    let text = body.get("data").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return Err(AppError::Gateway(
            "the device returned an empty configuration for the current commit".into(),
        ));
    }
    let mut text = text.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.contains("vyos-config-version") {
        if let Ok(boot) = std::fs::read_to_string("/config/config.boot") {
            let trailer: String = boot
                .lines()
                .filter(|l| l.trim_start().starts_with("//"))
                .map(|l| format!("{l}\n"))
                .collect();
            if trailer.contains("vyos-config-version") {
                text.push('\n');
                text.push_str(&trailer);
            }
        }
    }
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"config.boot\"",
            ),
        ],
        text,
    )
        .into_response())
}

/// Cheap sanity check that `content` is a config.boot-style document before
/// handing it to `config-file load` (whose own parser/commit is the real
/// validation). Catches the classic mistakes: an empty file, a `set`-command
/// dump, or a totally unrelated file.
fn validate_config_text(content: &str) -> std::result::Result<(), String> {
    if content.len() > MAX_RESTORE_BYTES {
        return Err("file is too large to be a configuration".into());
    }
    let mut braces: i64 = 0;
    let mut significant = false;
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") {
            continue;
        }
        significant = true;
        // A "****************" value is showCfg's secret mask — the file came
        // from a secrets-hidden export. Loading it would commit the mask
        // literal over every real key/password on the box.
        if t.contains("****************") {
            return Err(
                "this file has masked-out secrets (\"****************\") and cannot be restored — download a fresh backup, which includes real values"
                    .into(),
            );
        }
        if t.starts_with("set ") || t.starts_with("delete ") {
            return Err(
                "this looks like a list of `set` commands — restore expects a config.boot-style file (the format the backup download produces)"
                    .into(),
            );
        }
        for c in t.chars() {
            match c {
                '{' => braces += 1,
                '}' => braces -= 1,
                _ => {}
            }
            if braces < 0 {
                return Err("unbalanced braces — not a valid configuration file".into());
            }
        }
    }
    if !significant {
        return Err("the file is empty".into());
    }
    if braces != 0 {
        return Err("unbalanced braces — the file looks truncated".into());
    }
    Ok(())
}

/// Guarded full-config load shared by restore and rollback: snapshot, load
/// the new config (which commits), arm the revert timer.
async fn guarded_load(
    state: &Arc<AppState>,
    new_config: &str,
    description: String,
    timeout_secs: Option<u64>,
) -> Result<Response> {
    if state.guard.is_pending() {
        return Ok(conflict(
            "Another change is awaiting confirmation — confirm or revert it first.",
        ));
    }
    let snapshot_path = save_running_config(state, "guard-snapshot.boot").await?;
    load_config_text(state, new_config, "guard-load.boot").await?;
    let info = begin_pending(state, snapshot_path, description, clamp_timeout(timeout_secs));
    Ok(Json(info).into_response())
}

/// POST /api/config/restore — replace the entire configuration with an
/// uploaded config.boot, under commit-confirm.
pub async fn restore(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RestoreRequest>,
) -> Result<Response> {
    validate_config_text(&req.content).map_err(AppError::BadRequest)?;
    guarded_load(
        &state,
        &req.content,
        "Restore configuration from backup".into(),
        req.timeout_secs,
    )
    .await
}

/// POST /api/config/rollback — return to the configuration of a previous
/// commit revision (`show system commit`), under commit-confirm. Unlike the
/// CLI's `rollback`, no reboot: the revision's config is loaded and committed
/// in place.
pub async fn rollback(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RollbackRequest>,
) -> Result<Response> {
    let body = vyos::api_request(
        &state,
        "show",
        &json!({ "op": "show", "path": ["system", "commit", "file", req.revision.to_string()] }),
    )
    .await
    .map_err(|e| {
        AppError::Gateway(format!(
            "could not read the config of revision {}: {e}",
            req.revision
        ))
    })?;
    let text = body.get("data").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() || validate_config_text(text).is_err() {
        return Err(AppError::Gateway(format!(
            "the device did not return a usable configuration for revision {} (it may have aged out of the archive)",
            req.revision
        )));
    }
    guarded_load(
        &state,
        text,
        format!("Roll back to commit revision {}", req.revision),
        req.timeout_secs,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, host.parse().unwrap());
        h
    }

    #[test]
    fn management_ip_parses_host_forms() {
        assert_eq!(
            management_ip(&headers("192.0.2.1")),
            Some("192.0.2.1".parse().unwrap())
        );
        assert_eq!(
            management_ip(&headers("192.0.2.1:8443")),
            Some("192.0.2.1".parse().unwrap())
        );
        assert_eq!(
            management_ip(&headers("[2001:db8::1]:443")),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            management_ip(&headers("[2001:db8::1]")),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            management_ip(&headers("2001:db8::1")),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(management_ip(&headers("firewall.example.com")), None);
        assert_eq!(management_ip(&headers("firewall.example.com:443")), None);
    }

    #[test]
    fn cidr_match() {
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(cidr_matches_ip("10.0.0.1/24", &ip));
        assert!(cidr_matches_ip("10.0.0.1", &ip));
        assert!(!cidr_matches_ip("10.0.0.2/24", &ip));
        assert!(!cidr_matches_ip("dhcp", &ip));
    }

    #[test]
    fn config_text_validation() {
        assert!(validate_config_text("interfaces {\n ethernet eth0 {\n }\n}\n").is_ok());
        assert!(validate_config_text("").is_err());
        assert!(validate_config_text("// only comments\n").is_err());
        assert!(validate_config_text("set interfaces ethernet eth0 address 1.2.3.4/24").is_err());
        // showCfg's secret mask — a secrets-hidden export must be refused.
        assert!(validate_config_text(
            "service {\n https {\n api {\n keys {\n id quartzfire {\n key ****************\n }\n }\n }\n }\n}\n"
        )
        .is_err());
        assert!(validate_config_text("interfaces {\n").is_err()); // truncated
        assert!(validate_config_text("}\ninterfaces {").is_err()); // unbalanced
    }

    #[test]
    fn lockout_detection() {
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let mgmt = vec![
            (
                vec!["interfaces".into(), "ethernet".into(), "eth0".into()],
                "eth0".to_string(),
            ),
            (
                vec![
                    "interfaces".into(),
                    "ethernet".into(),
                    "eth1".into(),
                    "vif".into(),
                    "20".into(),
                ],
                "eth1.20".to_string(),
            ),
        ];
        let cmd = |op: &str, path: &[&str]| CmdCheck {
            op: op.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
        };

        // Deleting the mgmt interface, its vif, or an ancestor trips the check.
        for path in [
            &["interfaces", "ethernet", "eth0"][..],
            &["interfaces", "ethernet", "eth1", "vif", "20"],
            &["interfaces", "ethernet", "eth1"], // parent of the mgmt vif
        ] {
            assert!(
                !check_commands(&[cmd("delete", path)], &mgmt, &ip).is_empty(),
                "delete {path:?} should be flagged"
            );
        }
        // Removing the mgmt address (or all addresses) trips it.
        assert!(!check_commands(
            &[cmd("delete", &["interfaces", "ethernet", "eth0", "address", "10.0.0.1/24"])],
            &mgmt,
            &ip
        )
        .is_empty());
        assert!(!check_commands(
            &[cmd("delete", &["interfaces", "ethernet", "eth0", "address"])],
            &mgmt,
            &ip
        )
        .is_empty());
        // Disabling the mgmt interface trips it.
        assert!(!check_commands(
            &[cmd("set", &["interfaces", "ethernet", "eth0", "disable"])],
            &mgmt,
            &ip
        )
        .is_empty());

        // Safe operations don't: other interfaces, other addresses, edits on
        // the mgmt interface that keep it reachable, re-enabling.
        for (op, path) in [
            ("delete", &["interfaces", "ethernet", "eth2"][..]),
            ("delete", &["interfaces", "ethernet", "eth0", "address", "192.168.5.1/24"]),
            ("set", &["interfaces", "ethernet", "eth0", "address", "10.0.0.2/24"]),
            ("set", &["interfaces", "ethernet", "eth0", "description", "wan"]),
            ("delete", &["interfaces", "ethernet", "eth0", "disable"]),
            ("delete", &["interfaces", "ethernet", "eth1", "vif", "30"]),
        ] {
            assert!(
                check_commands(&[cmd(op, path)], &mgmt, &ip).is_empty(),
                "{op} {path:?} should be allowed"
            );
        }

        // Duplicate reasons collapse.
        let two = check_commands(
            &[
                cmd("delete", &["interfaces", "ethernet", "eth0"]),
                cmd("delete", &["interfaces", "ethernet", "eth0"]),
            ],
            &mgmt,
            &ip,
        );
        assert_eq!(two.len(), 1);
    }

    #[test]
    fn timeout_clamping() {
        assert_eq!(clamp_timeout(None), 60);
        assert_eq!(clamp_timeout(Some(1)), 15);
        assert_eq!(clamp_timeout(Some(120)), 120);
        assert_eq!(clamp_timeout(Some(10_000)), 600);
    }
}
