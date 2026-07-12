//! Orchestration: turn the desired model into a live Squid ssl_bump setup —
//! the CA, the certgen DB, the drop-in fragment, and the qz_ssl nftables
//! steering — then report health to status.json for the WebUI.
//!
//! Callers (see commands.rs):
//!   * the conf-mode owner's apply stage (fresh session config, synchronous —
//!     failures are reported on the commit);
//!   * `qzssl-apply` standalone (boot resync + the /run/nftables.conf path unit
//!     re-run, so the redirect survives VyOS firewall commits);
//!   * `qzssl-status` (probe only, no changes).
//!
//! File contract (also in docs/design.md):
//!   /etc/squid/conf.d/quartzfire-ssl-inspection.conf  the rendered fragment
//!   /config/quartzfire/ssl-inspection/{ca.crt,ca.key,ca.der,no-inspect.txt}
//!   /run/quartzfire-ssl/desired.json   committed model (standalone resync src)
//!   /run/quartzfire-ssl/status.json    squid/icap/ca/apply status for the WebUI
//!   /run/quartzfire-ssl/ca-info.json   public CA metadata (no key), for the WebUI
//!   /run/quartzfire-ssl/active         marker: inspection is loaded

use std::fmt;
use std::fs;
use std::io::Write as _;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::ca;
use crate::capcheck::{self, Caps};
use crate::model::Model;
use crate::render;

pub const RUN_DIR: &str = "/run/quartzfire-ssl";
pub const SQUID_FRAGMENT: &str = "/etc/squid/conf.d/quartzfire-ssl-inspection.conf";
pub const NO_INSPECT_FILE: &str = "/config/quartzfire/ssl-inspection/no-inspect.txt";
pub const SECURITY_FILE_CERTGEN: &str = "/usr/lib/squid/security_file_certgen";
pub const SSL_DB_DIR: &str = "/var/lib/squid/ssl_db";

pub fn status_file() -> PathBuf {
    Path::new(RUN_DIR).join("status.json")
}
pub fn ca_info_file() -> PathBuf {
    Path::new(RUN_DIR).join("ca-info.json")
}
pub fn desired_file() -> PathBuf {
    Path::new(RUN_DIR).join("desired.json")
}
pub fn active_mark() -> PathBuf {
    Path::new(RUN_DIR).join("active")
}

#[derive(Debug)]
pub struct ApplyError(pub String);
impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ApplyError {}

pub struct Report {
    pub ok: bool,
    pub error: Option<String>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Atomic write (temp + rename): readers/watchers never see a half document.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), ApplyError> {
    let dir = path
        .parent()
        .ok_or_else(|| ApplyError(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir).map_err(|e| ApplyError(format!("creating {}: {e}", dir.display())))?;
    let tmp = path.with_extension("qz-tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
        f.write_all(text.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path).map_err(|e| ApplyError(format!("activating {}: {e}", path.display())))
}

/// Merge top-level sections into status.json.
pub fn update_status(patch: Value) {
    let mut status: Value = fs::read_to_string(status_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(obj), Some(patch_obj)) = (status.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            obj.insert(key.clone(), value.clone());
        }
    }
    let _ = write_atomic(&status_file(), &serde_json::to_string_pretty(&status).unwrap());
}

// ── desired-state snapshot ────────────────────────────────────────────────────

pub fn save_desired(model: &Model) -> Result<(), ApplyError> {
    let body = json!({ "generated_at": now(), "model": model });
    write_atomic(&desired_file(), &serde_json::to_string_pretty(&body).unwrap())
}

pub fn load_desired() -> Result<Option<Model>, ApplyError> {
    match fs::read_to_string(desired_file()) {
        Ok(text) => {
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| ApplyError(format!("corrupt {}: {e}", desired_file().display())))?;
            let model = serde_json::from_value(v.get("model").cloned().unwrap_or(Value::Null))
                .map_err(|e| ApplyError(format!("corrupt model in desired.json: {e}")))?;
            Ok(Some(model))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ApplyError(format!("reading {}: {e}", desired_file().display()))),
    }
}

// ── probes ────────────────────────────────────────────────────────────────────

fn squid_running() -> bool {
    Command::new("systemctl")
        .args(["is-active", "--quiet", "squid"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The certgen DB is initialized once; index.txt is the marker security_file_certgen writes.
fn certgen_db_ready() -> bool {
    Path::new(SSL_DB_DIR).join("index.txt").exists()
}

/// One-shot TCP reachability probe with a short timeout.
fn tcp_reachable(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    match addr.to_socket_addrs() {
        Ok(mut addrs) => addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok()),
        Err(_) => false,
    }
}

// ── system actions ────────────────────────────────────────────────────────────

/// Initialize the certificate-generation DB once (idempotent).
fn ensure_certgen_db() -> Result<(), ApplyError> {
    if certgen_db_ready() {
        return Ok(());
    }
    // security_file_certgen -c creates the ssl_db directory itself, but NOT its
    // parent, and it refuses to run if the target directory already exists. On
    // a real box /var/lib/squid is often absent (the Debian squid cache lives
    // under /var/spool/squid, not here) and a previous half-init can leave a
    // partial ssl_db with no index.txt — either one makes `-c` fail with the
    // opaque error the operator saw. Create the parent and clear any partial
    // store first, exactly as the proven container smoke test does.
    if let Some(parent) = Path::new(SSL_DB_DIR).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApplyError(format!("creating {}: {e}", parent.display())))?;
    }
    if Path::new(SSL_DB_DIR).exists() {
        let _ = fs::remove_dir_all(SSL_DB_DIR);
    }
    // security_file_certgen -c creates the DB; -M 8MB caps the on-disk store.
    let out = Command::new(SECURITY_FILE_CERTGEN)
        .args(["-c", "-s", SSL_DB_DIR, "-M", "8MB"])
        .output()
        .map_err(|e| ApplyError(format!("running security_file_certgen: {e}")))?;
    if !out.status.success() {
        // Surface the helper's own stderr — the bare "…-c failed" that shipped
        // before gave the operator nothing to act on.
        let detail = String::from_utf8_lossy(&out.stderr);
        let detail = detail.trim();
        return Err(ApplyError(if detail.is_empty() {
            "security_file_certgen -c failed".to_string()
        } else {
            format!("security_file_certgen -c failed: {detail}")
        }));
    }
    // The store must be owned by the squid runtime user.
    let _ = Command::new("chown").args(["-R", "proxy:proxy", SSL_DB_DIR]).status();
    Ok(())
}

/// `squid -k parse` validates the config without touching the running service.
fn squid_config_valid() -> Result<(), ApplyError> {
    let out = Command::new("squid").args(["-k", "parse"]).output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(ApplyError(format!(
            "squid rejected the generated config: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ))),
        Err(e) => Err(ApplyError(format!("cannot run squid to validate config: {e}"))),
    }
}

/// Reconfigure a running Squid, or start it if it is not running.
fn reload_squid() -> Result<(), ApplyError> {
    if squid_running() {
        let s = Command::new("squid").args(["-k", "reconfigure"]).status();
        if matches!(s, Ok(st) if st.success()) {
            return Ok(());
        }
        // Fall through to a full restart if reconfigure fails.
    }
    let s = Command::new("systemctl")
        .args(["restart", "squid"])
        .status()
        .map_err(|e| ApplyError(format!("restarting squid: {e}")))?;
    if s.success() {
        Ok(())
    } else {
        Err(ApplyError("systemctl restart squid failed".to_string()))
    }
}

/// Start or stop the CA-distribution listener. It is NOT enabled at boot — we
/// own its lifecycle here so that when inspection is disabled (or was never
/// configured) the plain-HTTP :4126 port is simply not bound anywhere. When
/// enabled, the qz_ssl input guard (loaded before this) restricts it to the
/// trusted interfaces.
fn set_cadist(on: bool) {
    let verb = if on { "enable" } else { "disable" };
    let _ = Command::new("systemctl")
        .args([verb, "--now", "quartzfire-ssl-cadist.service"])
        .status();
}

/// Load (or, when disabled, delete) the qz_ssl nftables table via `nft -f -`.
fn load_nft(ruleset: &str) -> Result<(), ApplyError> {
    let mut child = Command::new("nft")
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ApplyError(format!("spawning nft: {e}")))?;
    child
        .stdin
        .take()
        .ok_or_else(|| ApplyError("nft stdin unavailable".to_string()))?
        .write_all(ruleset.as_bytes())
        .map_err(|e| ApplyError(format!("writing nft ruleset: {e}")))?;
    let out = child
        .wait_with_output()
        .map_err(|e| ApplyError(format!("waiting on nft: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(ApplyError(format!(
            "nft rejected the qz_ssl ruleset: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

// ── apply ─────────────────────────────────────────────────────────────────────

/// Bring the system in line with `model`. `caps` is the live squid probe (None
/// off-device). Writes status.json regardless of outcome.
pub fn apply_model(model: &Model, caps: Option<Caps>) -> Report {
    let result = apply_inner(model, caps);
    let (ok, error) = match &result {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.0.clone())),
    };
    if ok && model.enabled {
        let _ = write_atomic(&active_mark(), "1\n");
    } else if !model.enabled {
        let _ = fs::remove_file(active_mark());
    }
    write_status(model, caps, ok, error.clone());
    Report { ok, error }
}

fn apply_inner(model: &Model, caps: Option<Caps>) -> Result<(), ApplyError> {
    if !model.enabled {
        // Teardown: neutralize the fragment and drop the steering table. Squid
        // keeps running (it may serve nothing, harmless); we just stop bumping.
        write_atomic(Path::new(SQUID_FRAGMENT), &render::squid_fragment(model))?;
        let _ = reload_squid();
        load_nft(&render::nft_ruleset(model))?;
        // Close the plain-HTTP CA page — nothing to distribute when off.
        set_cadist(false);
        return Ok(());
    }

    // A build without bump support cannot inspect — refuse loudly (verify()
    // catches this at commit; this guards the standalone/boot path too).
    if matches!(caps, Some(c) if !c.bump) {
        return Err(ApplyError(
            "the installed Squid lacks OpenSSL ssl_bump support (install squid-openssl)".to_string(),
        ));
    }

    // CA (idempotent on first enable; Regenerate goes through `qzssl-ca`).
    ca::generate(false).map_err(|e| ApplyError(format!("CA: {e}")))?;
    ensure_certgen_db()?;

    write_atomic(Path::new(NO_INSPECT_FILE), &render::no_inspect_file(model))?;
    write_atomic(Path::new(SQUID_FRAGMENT), &render::squid_fragment(model))?;

    squid_config_valid()?;
    reload_squid()?;
    // Load the steering + CA-page guard BEFORE starting cadist, so :4126 is
    // firewalled to the trusted scope the moment it binds.
    load_nft(&render::nft_ruleset(model))?;
    set_cadist(true);
    Ok(())
}

/// Compose and write status.json + ca-info.json for the WebUI.
pub fn write_status(model: &Model, caps: Option<Caps>, apply_ok: bool, apply_err: Option<String>) {
    let ca_info = ca::inspect().unwrap_or_default();
    let _ = write_atomic(&ca_info_file(), &serde_json::to_string_pretty(&ca_info).unwrap());

    let icap = match &model.content_filter {
        Some(cf) => json!({
            "configured": true,
            "endpoint": format!("{}:{}", cf.icap_host, cf.icap_port),
            "fail_mode": cf.fail_mode,
            "reachable": tcp_reachable(&cf.icap_host, cf.icap_port),
        }),
        None => json!({ "configured": false }),
    };

    let status = json!({
        "enabled": model.enabled,
        "squid": {
            "running": squid_running(),
            "bump_capable": caps.map(|c| c.bump),
            "icap_capable": caps.map(|c| c.icap),
        },
        "certgen_db_ready": certgen_db_ready(),
        "intercept_port": model.intercept_port,
        "interfaces": model.interfaces,
        "default_action": model.default_action,
        "no_inspect_count": render::no_inspect_list(model).len(),
        "upstream_invalid": model.upstream_invalid,
        "icap": icap,
        "ca": ca_info,
        "ca_download": {
            "port": 4126u16,
            "interfaces": model.ca_download_scope(),
        },
        "apply": { "time": now(), "ok": apply_ok, "error": apply_err },
    });
    let _ = write_atomic(&status_file(), &serde_json::to_string_pretty(&status).unwrap());
}

/// Finalize a CA (re)generation: a fresh root invalidates every mimicked leaf
/// cached in the certgen DB, so clear and re-init it, reload Squid, and refresh
/// status/ca-info from the committed model. Best-effort — a regenerate should
/// never hard-fail just because Squid is not currently running.
pub fn post_ca_change() {
    let _ = fs::remove_dir_all(SSL_DB_DIR);
    let _ = ensure_certgen_db();
    let _ = reload_squid();
    refresh_status();
}

/// Probe-only status refresh (qzssl-status), from the committed snapshot.
pub fn refresh_status() -> i32 {
    let model = load_desired().ok().flatten().unwrap_or_default();
    let caps = capcheck::probe();
    // Preserve the last apply result if present; this path only re-probes health.
    let last = fs::read_to_string(status_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let (ok, err) = last
        .as_ref()
        .and_then(|v| v.get("apply"))
        .map(|a| {
            (
                a.get("ok").and_then(|b| b.as_bool()).unwrap_or(false),
                a.get("error").and_then(|e| e.as_str()).map(String::from),
            )
        })
        .unwrap_or((false, None));
    write_status(&model, caps, ok, err);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_roundtrip_shape() {
        // save_desired/load_desired agree on the model field.
        let m = Model { enabled: true, interfaces: vec!["eth1".into()], ..Model::default() };
        let body = json!({ "generated_at": now(), "model": &m });
        let text = serde_json::to_string(&body).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let back: Model = serde_json::from_value(v.get("model").cloned().unwrap()).unwrap();
        assert!(back.enabled);
        assert_eq!(back.interfaces, vec!["eth1"]);
    }

    #[test]
    fn write_status_is_pure_json_shape() {
        // Build the status object the same way write_status does and assert the
        // key surface the WebUI depends on. No key material anywhere.
        let m = Model { enabled: true, interfaces: vec!["eth1".into()], ..Model::default() };
        let caps = Some(Caps { bump: true, icap: false });
        let status = json!({
            "enabled": m.enabled,
            "squid": { "running": false, "bump_capable": caps.map(|c| c.bump), "icap_capable": caps.map(|c| c.icap) },
            "certgen_db_ready": false,
            "icap": { "configured": false },
        });
        assert_eq!(status["squid"]["bump_capable"], json!(true));
        assert_eq!(status["icap"]["configured"], json!(false));
        assert!(!status.to_string().contains("BEGIN"));
    }
}
