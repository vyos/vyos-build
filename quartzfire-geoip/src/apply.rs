//! Orchestration: turn (model, database) into a loaded nftables ruleset.
//!
//! Used by three callers with different entry points:
//!   * the conf-mode owner's apply stage (fresh session config, synchronous,
//!     failures make the commit report them);
//!   * `geoip-apply` standalone (boot resync, firewall-commit resync via the
//!     /run/nftables.conf path unit) — never removes enforcement on
//!     transient read problems;
//!   * `geoip-update` (sets-only refresh after a database update) — never
//!     touches chains, so a failed update can't disturb enforcement.
//!
//! File contract (also documented in docs/design.md):
//!   /run/quartzfire-geoip/desired.json   model + resolved matches, written
//!                                        by the conf-mode owner per commit
//!   /run/quartzfire-geoip/status.json    db/update/apply status for the WebUI
//!   /run/quartzfire-geoip/counters.json  per-action/per-policy hit counters
//!   /run/quartzfire-geoip/countries.json country list dump for the WebUI
//!   /run/quartzfire-geoip/active         marker: the qz_geo table is loaded
//!   /run/quartzfire-geoip/last.nft       last applied ruleset (skip no-ops)
//!   /var/cache/quartzfire-geoip/<ver>/   collapsed set elements per version

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{self, ConfigRead};
use crate::db::Database;
use crate::matchrepl::rule_match_expr;
use crate::model::Model;
use crate::render;

pub const RUN_DIR: &str = "/run/quartzfire-geoip";
pub const CACHE_DIR: &str = "/var/cache/quartzfire-geoip";

pub fn desired_file() -> PathBuf {
    Path::new(RUN_DIR).join("desired.json")
}
pub fn status_file() -> PathBuf {
    Path::new(RUN_DIR).join("status.json")
}
pub fn countries_file() -> PathBuf {
    Path::new(RUN_DIR).join("countries.json")
}
pub fn counters_file() -> PathBuf {
    Path::new(RUN_DIR).join("counters.json")
}
pub fn traffic_file() -> PathBuf {
    Path::new(RUN_DIR).join("traffic.json")
}
pub fn active_mark() -> PathBuf {
    Path::new(RUN_DIR).join("active")
}
pub fn last_applied() -> PathBuf {
    Path::new(RUN_DIR).join("last.nft")
}

#[derive(Debug)]
pub struct ApplyError(pub String);

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ApplyError {}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Atomic write (temp + rename in the same directory): watchers and readers
/// must never observe a half-written document.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), ApplyError> {
    let dir = path
        .parent()
        .ok_or_else(|| ApplyError(format!("{} has no parent directory", path.display())))?;
    fs::create_dir_all(dir)
        .map_err(|e| ApplyError(format!("creating {}: {e}", dir.display())))?;
    let tmp = path.with_extension("qz-tmp");
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
        f.write_all(text.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|e| ApplyError(format!("writing {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path)
        .map_err(|e| ApplyError(format!("activating {}: {e}", path.display())))
}

/// Merge top-level sections into status.json (single shared report file;
/// apply and update each own distinct keys).
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

#[derive(Debug, Serialize, Deserialize)]
pub struct Desired {
    pub generated_at: i64,
    pub model: Model,
    /// JSON object keys are strings; converted back to u32 on use.
    pub matches: BTreeMap<String, Option<String>>,
}

pub fn load_desired() -> Result<Option<Desired>, ApplyError> {
    match fs::read_to_string(desired_file()) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| ApplyError(format!("corrupt {}: {e}", desired_file().display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ApplyError(format!("reading {}: {e}", desired_file().display()))),
    }
}

pub fn save_desired(
    model: &Model,
    matches: &BTreeMap<u32, Option<String>>,
) -> Result<(), ApplyError> {
    let desired = Desired {
        generated_at: now(),
        model: model.clone(),
        matches: matches.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
    };
    write_atomic(&desired_file(), &serde_json::to_string_pretty(&desired).unwrap())
}

// ── match resolution ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    pub policy: u32,
    pub error: String,
}

/// Resolve every policy's replicated rule match.
///
/// `conf`: fresh resolution against that config view. `snapshot`: matches
/// from a previous desired.json — used when no config view is available
/// (e.g. mid-commit races in the standalone resync path).
///
/// A None match means the policy is skipped by the renderer (enforcement for
/// the OTHER policies is unaffected) and the problem is surfaced.
pub fn resolve_matches(
    model: &Model,
    conf: Option<&dyn ConfigRead>,
    snapshot: Option<&BTreeMap<String, Option<String>>>,
) -> (BTreeMap<u32, Option<String>>, Vec<Problem>) {
    let mut matches = BTreeMap::new();
    let mut problems = Vec::new();
    let groups = conf.map(config::read_groups);
    for policy in &model.policies {
        let pid = policy.id;
        if let (Some(conf), Some(groups)) = (conf, groups.as_ref()) {
            let ruleset = policy.ruleset.as_deref().unwrap_or("forward");
            match config::read_rule_cfg(conf, ruleset, policy.rule) {
                None => {
                    matches.insert(pid, None);
                    problems.push(Problem {
                        policy: pid,
                        error: format!(
                            "target firewall ipv4 {ruleset} filter rule {} does not exist",
                            policy.rule
                        ),
                    });
                }
                Some(rule_cfg) => match rule_match_expr(&rule_cfg, groups) {
                    Ok(expr) => {
                        matches.insert(pid, Some(expr));
                    }
                    Err(e) => {
                        matches.insert(pid, None);
                        problems.push(Problem { policy: pid, error: e.0 });
                    }
                },
            }
        } else if let Some(snapshot) = snapshot {
            let expr = snapshot.get(&pid.to_string()).cloned().flatten();
            if expr.is_none() {
                problems.push(Problem {
                    policy: pid,
                    error: "unresolved in the last commit snapshot".into(),
                });
            }
            matches.insert(pid, expr);
        } else {
            matches.insert(pid, None);
            problems.push(Problem { policy: pid, error: "no configuration view available".into() });
        }
    }
    (matches, problems)
}

// ── set building (with per-DB-version cache) ──────────────────────────────────

fn elements_for(db: &dyn Database, sname: &str) -> Vec<String> {
    let family = if sname.starts_with("geo4_") { 4 } else { 6 };
    let cc = sname.splitn(2, '_').nth(1).unwrap_or("");
    let raw = if cc == render::KNOWN {
        db.all_networks(family)
    } else {
        db.networks(&cc.to_ascii_uppercase(), family)
    };
    render::collapse(&raw, family)
}

fn prune_cache(cache_dir: &Path, version: i64) {
    let Ok(entries) = fs::read_dir(cache_dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() != version.to_string() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// {set name → collapsed CIDRs} for the given names, reusing the on-disk
/// cache when the database version matches (regenerating a country is cheap;
/// the synthetic known set is not).
pub fn build_sets(
    db: &dyn Database,
    set_names: &std::collections::BTreeSet<String>,
    cache_dir: &Path,
) -> Result<BTreeMap<String, Vec<String>>, ApplyError> {
    let version = db.created_at();
    prune_cache(cache_dir, version);
    let mut sets = BTreeMap::new();
    for sname in set_names {
        let cache = cache_dir.join(version.to_string()).join(format!("{sname}.list"));
        if let Ok(text) = fs::read_to_string(&cache) {
            sets.insert(
                sname.clone(),
                text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect(),
            );
            continue;
        }
        let elements = elements_for(db, sname);
        let mut body = elements.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        write_atomic(&cache, &body)?;
        sets.insert(sname.clone(), elements);
    }
    Ok(sets)
}

// ── nft interaction ───────────────────────────────────────────────────────────

pub fn nft_apply(text: &str) -> Result<(), ApplyError> {
    let mut child = Command::new("nft")
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ApplyError(format!("running nft: {e}")))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(text.as_bytes())
        .map_err(|e| ApplyError(format!("feeding nft: {e}")))?;
    let output = child
        .wait_with_output()
        .map_err(|e| ApplyError(format!("waiting for nft: {e}")))?;
    if !output.status.success() {
        let mut message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if message.is_empty() {
            message = String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
        message.truncate(2000);
        return Err(ApplyError(format!("nft -f failed: {message}")));
    }
    Ok(())
}

fn nft_json(args: &[&str]) -> Option<Value> {
    let output = Command::new("nft").arg("-j").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Live per-action counters, {action → (packets, bytes)}. Empty on any
/// problem (table absent, nft missing) — callers treat it as best-effort.
pub fn read_counters() -> BTreeMap<String, (u64, u64)> {
    let mut out = BTreeMap::new();
    let Some(doc) = nft_json(&["list", "counters", "table", render::TABLE_FAMILY, render::TABLE_NAME])
    else {
        return out;
    };
    for item in doc.get("nftables").and_then(Value::as_array).into_iter().flatten() {
        let Some(counter) = item.get("counter") else { continue };
        let Some(name) = counter.get("name").and_then(Value::as_str) else { continue };
        if let Some(action) = name.strip_prefix("geo_") {
            out.insert(
                action.to_string(),
                (
                    counter.get("packets").and_then(Value::as_u64).unwrap_or(0),
                    counter.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                ),
            );
        }
    }
    out
}

/// Live per-country blocked counters, {UPPER CC → (packets, bytes)}, from the
/// `geoc_<cc>` named counters. Best-effort like read_counters; feeds both the
/// re-render seed and the Top Blocked Countries dashboard dump.
pub fn read_country_counters() -> BTreeMap<String, (u64, u64)> {
    let mut out = BTreeMap::new();
    let Some(doc) = nft_json(&["list", "counters", "table", render::TABLE_FAMILY, render::TABLE_NAME])
    else {
        return out;
    };
    for item in doc.get("nftables").and_then(Value::as_array).into_iter().flatten() {
        let Some(counter) = item.get("counter") else { continue };
        let Some(name) = counter.get("name").and_then(Value::as_str) else { continue };
        if let Some(cc) = name.strip_prefix("geoc_") {
            out.insert(
                cc.to_ascii_uppercase(),
                (
                    counter.get("packets").and_then(Value::as_u64).unwrap_or(0),
                    counter.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                ),
            );
        }
    }
    out
}

/// Per-policy hit counters (connections checked), {policy id → (packets,
/// bytes)}, from the anonymous counters on the `comment "qz-geo-p<id>"` jump
/// rules. Best-effort like read_counters.
pub fn read_policy_counters() -> BTreeMap<u32, (u64, u64)> {
    let mut out = BTreeMap::new();
    let Some(doc) = nft_json(&["list", "table", render::TABLE_FAMILY, render::TABLE_NAME]) else {
        return out;
    };
    for item in doc.get("nftables").and_then(Value::as_array).into_iter().flatten() {
        let Some(rule) = item.get("rule") else { continue };
        let Some(comment) = rule.get("comment").and_then(Value::as_str) else { continue };
        let Some(pid) = comment.strip_prefix("qz-geo-p").and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        for expr in rule.get("expr").and_then(Value::as_array).into_iter().flatten() {
            if let Some(counter) = expr.get("counter") {
                out.insert(
                    pid,
                    (
                        counter.get("packets").and_then(Value::as_u64).unwrap_or(0),
                        counter.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                    ),
                );
                break;
            }
        }
    }
    out
}

// ── top-level operations ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Report {
    pub time: i64,
    pub ok: bool,
    pub error: Option<String>,
}

/// Render and (atomically) load the full ruleset. `db` may be None —
/// database not downloaded yet — in which case enforcement is left exactly
/// as it is (fail open before the first download, fail closed on data loaded
/// earlier in this boot) and the situation is surfaced via status.json.
pub fn apply_model(
    model: &Model,
    matches: &BTreeMap<u32, Option<String>>,
    db: Option<&dyn Database>,
    problems: &[Problem],
    force: bool,
) -> Result<Report, ApplyError> {
    let mut report = Report { time: now(), ok: true, error: None };

    let set_names = render::required_sets(model);
    let db = match (db, set_names.is_empty()) {
        (Some(db), _) => Some(db),
        (None, true) => None,
        (None, false) => {
            report.ok = false;
            report.error = Some(
                "location database is missing — geolocation is NOT enforced for new \
                 changes; run an update (Update now, or geoip-update) to download it"
                    .into(),
            );
            update_status(json!({
                "apply": report,
                "policy_errors": problems,
            }));
            return Ok(report);
        }
    };

    let sets = match db {
        Some(db) if !set_names.is_empty() => build_sets(db, &set_names, Path::new(CACHE_DIR))?,
        _ => BTreeMap::new(),
    };
    let text = render::render_full(model, matches, &sets, &read_counters(), &read_country_counters());

    let previous = fs::read_to_string(last_applied()).unwrap_or_default();
    if force || text != previous {
        nft_apply(&text)?;
        write_atomic(&last_applied(), &text)?;
    }

    // The "nothing enforced" render ends with the bare table delete.
    let active = !text.trim_end().ends_with(&format!("delete table {}", render::TABLE));
    if active {
        write_atomic(&active_mark(), "")?;
    } else {
        let _ = fs::remove_file(active_mark());
    }

    let set_counts: BTreeMap<&String, usize> =
        sets.iter().map(|(name, elements)| (name, elements.len())).collect();
    update_status(json!({
        "apply": report,
        "policy_errors": problems,
        "set_counts": set_counts,
        "active": active,
    }));
    Ok(report)
}

/// After a successful database update: rebuild every in-use set from the new
/// database and swap the contents in one transaction. Chains, counters, and
/// (on failure) the previously loaded elements are untouched.
pub fn refresh_sets(db: &dyn Database) -> Result<usize, ApplyError> {
    let Some(desired) = load_desired()? else {
        update_status(json!({ "set_counts": {} }));
        return Ok(0);
    };
    let set_names = render::required_sets(&desired.model);
    if set_names.is_empty() {
        return Ok(0);
    }
    let sets = build_sets(db, &set_names, Path::new(CACHE_DIR))?;
    if active_mark().exists() {
        nft_apply(&render::render_sets_reload(&sets))?;
    }
    let set_counts: BTreeMap<&String, usize> =
        sets.iter().map(|(name, elements)| (name, elements.len())).collect();
    update_status(json!({ "set_counts": set_counts }));
    Ok(sets.len())
}

/// Dump the selectable country list for the WebUI/CLI completion.
pub fn write_countries(db: &dyn Database) -> Result<(), ApplyError> {
    write_atomic(
        &countries_file(),
        &serde_json::to_string_pretty(&json!({
            "available": true,
            "db_version": db.created_at(),
            "countries": db.countries(),
        }))
        .unwrap(),
    )
}
