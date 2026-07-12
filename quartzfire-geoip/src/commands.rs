//! The qzgeo entry points, one per symlink name (see main.rs):
//!
//!   commit    — conf-mode owner of `service geolocation` (VyOS commit)
//!   apply     — standalone resync from the last committed snapshot
//!   update    — `location update` + verify + set refresh
//!   lookup    — IP → country JSON (the WebUI diagnostic)
//!   countries — selectable country dump (WebUI + CLI completion)
//!   counters  — per-action/per-policy counter dump for the WebUI

use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

use serde_json::json;

use crate::apply;
use crate::config::{self, CliShellApi, ConfigRead};
use crate::db::{self, Database};
use crate::model;
use crate::render;

fn log(msg: &str) {
    eprintln!("quartzfire-geoip: {msg}");
}

fn open_db() -> Option<Box<dyn Database>> {
    match db::open_default() {
        Ok(db) => Some(db),
        Err(e) => {
            log(&format!("location database unavailable: {e}"));
            None
        }
    }
}

// ── commit (conf-mode owner) ──────────────────────────────────────────────────

/// The commit-time owner of `service geolocation`. Stages follow the vyos-1x
/// convention: read the session config, verify (any problem printed to
/// stderr + exit 1 ABORTS the commit), generate the desired-state snapshot,
/// apply the ruleset.
///
/// Match-resolution problems (missing target rule, FQDN groups, empty
/// groups) are deliberately NOT commit failures: the firewall rule can be
/// deleted in a later commit that never runs this owner, and the full config
/// must still commit at boot. The affected policy is skipped at apply,
/// warned about on the commit output, and surfaced as an error state in
/// status.json / the WebUI — never silently dropped.
pub fn commit() -> i32 {
    let conf = CliShellApi::session();
    let model = config::read_service(&conf);
    let (matches, problems) = apply::resolve_matches(&model, Some(&conf), None);

    // verify ─ empty model (feature deleted) is always a valid teardown.
    if !model.actions.is_empty() || !model.policies.is_empty() {
        let database = open_db();
        let known_codes = database.as_ref().map(|d| d.country_codes());
        let mut errors = model::validate(&model, known_codes.as_ref());

        // Distinguish "references an action that never existed" from "tries
        // to delete an action that policies still use".
        for policy in &model.policies {
            let Some(name) = policy.action.as_deref() else { continue };
            if !model.actions.contains_key(name)
                && conf.exists_effective(&["service", "geolocation", "action", name])
            {
                let users: Vec<String> = model
                    .policies
                    .iter()
                    .filter(|p| p.action.as_deref() == Some(name))
                    .map(|p| p.id.to_string())
                    .collect();
                let message = format!(
                    "geolocation action \"{name}\" cannot be deleted: it is still used by \
                     polic{} {} — delete or repoint those policies first",
                    if users.len() == 1 { "y" } else { "ies" },
                    users.join(", ")
                );
                if !errors.contains(&message) {
                    errors.push(message);
                }
            }
        }

        if !errors.is_empty() {
            eprintln!("{}", errors.join("\n"));
            return 1;
        }
    }

    // generate ─ the snapshot the standalone helpers work from.
    if let Err(e) = apply::save_desired(&model, &matches) {
        eprintln!("{e}");
        return 1;
    }

    // apply ─ warnings for skipped policies, then the atomic load.
    for p in &problems {
        eprintln!(
            "WARNING: geolocation policy {} is not enforced: {}",
            p.policy, p.error
        );
    }
    let database = open_db();
    match apply::apply_model(&model, &matches, database.as_deref(), &problems, false) {
        Ok(report) => {
            if !report.ok {
                // Missing database: accept the commit (config is valid and
                // saved) but tell the operator enforcement is not active yet.
                eprintln!("WARNING: {}", report.error.unwrap_or_default());
            }
            0
        }
        Err(e) => {
            eprintln!("loading the geolocation nftables ruleset failed: {e}");
            1
        }
    }
}

// ── apply (standalone resync) ─────────────────────────────────────────────────

/// Re-render OUTSIDE a commit, from the last committed snapshot. No snapshot
/// = geolocation has never been committed this boot = nothing to do —
/// deliberately NOT a teardown, so a path-unit run racing the boot commit
/// can never yank enforcement that the commit is about to put in place.
pub fn standalone_apply() -> i32 {
    let desired = match apply::load_desired() {
        Ok(Some(desired)) => desired,
        Ok(None) => {
            log("no committed geolocation state yet — nothing to apply");
            return 0;
        }
        Err(e) => {
            log(&e.0);
            return 1;
        }
    };

    // Fresh match resolution against the ACTIVE config (that is the drift
    // this resync exists to fix); the commit-time snapshot is the fallback
    // when the active view is unavailable or mid-transition.
    let active = CliShellApi::active();
    let conf: Option<&dyn ConfigRead> = if active.exists(&["service", "geolocation"]) {
        Some(&active)
    } else {
        log("active config unavailable; using the commit snapshot");
        None
    };
    let (matches, problems) =
        apply::resolve_matches(&desired.model, conf, Some(&desired.matches));

    let database = open_db();
    match apply::apply_model(&desired.model, &matches, database.as_deref(), &problems, false) {
        Ok(report) => {
            for p in &problems {
                log(&format!("policy {}: {}", p.policy, p.error));
            }
            if report.ok {
                log("applied");
            } else {
                log(&format!("not applied: {}", report.error.unwrap_or_default()));
            }
            0
        }
        Err(e) => {
            log(&format!("apply failed: {e}"));
            apply::update_status(json!({
                "apply": { "time": apply::now(), "ok": false, "error": e.0 },
                "policy_errors": problems,
            }));
            1
        }
    }
}

// ── update ────────────────────────────────────────────────────────────────────

/// Substrings `location update` prints when the remote database is not newer
/// than the installed one (it then exits non-zero without replacing
/// anything).
const UP_TO_DATE_MARKERS: [&str; 3] = ["up to date", "not modified", "is newer than"];

/// Download/refresh the libloc database and refresh the loaded sets.
///
/// `location update` (the vendor CLI) downloads over HTTPS, VERIFIES THE
/// SIGNATURE, and only then atomically replaces the database file. We
/// re-verify with the vendor key afterwards and refuse to regenerate sets
/// from a database that fails. Fail-closed: any failure leaves the currently
/// loaded sets exactly as they are.
pub fn update() -> i32 {
    let version_before = open_db().map(|d| d.created_at());

    let (rc, output) = match Command::new("location").arg("update").output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.code().unwrap_or(-1), text.trim().to_string())
        }
        Err(e) => (127, format!("cannot run the location CLI: {e}")),
    };

    let after = open_db();
    let changed = matches!((&after, version_before), (Some(db), before) if Some(db.created_at()) != before);
    let lower = output.to_ascii_lowercase();
    let up_to_date = rc != 0 && UP_TO_DATE_MARKERS.iter().any(|m| lower.contains(m));
    let mut ok = after.is_some() && (rc == 0 || up_to_date);

    let signature_ok = after.as_ref().map(|d| d.verify());
    let mut message = None;
    if signature_ok == Some(Some(false)) {
        // location update verified before installing, so this indicates
        // local corruption or a key mismatch — do not regenerate sets.
        ok = false;
        message = Some("database failed signature verification".to_string());
    } else if !ok {
        message = Some(
            output
                .lines()
                .last()
                .map(String::from)
                .unwrap_or_else(|| format!("location update failed (exit {rc})")),
        );
        let tail: String = output.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        log(&format!("update failed ({rc}): {tail}"));
    } else if up_to_date {
        log("database already up to date");
    } else {
        log(&format!(
            "database updated to version {}",
            after.as_ref().map(|d| d.created_at()).unwrap_or(0)
        ));
    }

    apply::update_status(json!({
        "db": {
            "present": after.is_some(),
            "version": after.as_ref().map(|d| d.created_at()),
            "path": db::DEFAULT_DB,
            "signature_ok": signature_ok.flatten(),
        },
        "update": {
            "time": apply::now(),
            "ok": ok,
            "changed": changed,
            "message": message,
            "schedule": "daily",
        },
    }));

    let Some(after) = after else { return 1 };

    // Refresh the WebUI's country list and, when the data actually changed,
    // rebuild the in-use sets from the new database and swap them atomically.
    if let Err(e) = apply::write_countries(after.as_ref()) {
        log(&format!("writing countries.json failed: {e}"));
    }
    if ok {
        // Enforcement can be *pending*: an earlier commit/apply was blocked
        // because the database was missing, so apply_model returned early and
        // never loaded the table (active_mark absent). Now that the DB is
        // present, a full re-render from the committed snapshot installs it.
        // refresh_sets alone cannot — it only swaps set CONTENTS into an
        // already-active table. This also covers "Update now" when the DB was
        // already current (changed == false), which otherwise no-ops.
        let pending_install = !apply::active_mark().exists()
            && apply::load_desired()
                .ok()
                .flatten()
                .map(|d| !render::required_sets(&d.model).is_empty())
                .unwrap_or(false);
        if pending_install {
            log("enforcement was pending a database — re-applying the full ruleset");
            standalone_apply();
        } else if changed {
            match apply::refresh_sets(after.as_ref()) {
                Ok(count) => log(&format!("reloaded {count} in-use set(s) from the new database")),
                Err(e) => {
                    log(&format!("set reload failed — previous sets stay loaded: {e}"));
                    apply::update_status(json!({
                        "update": {
                            "time": apply::now(),
                            "ok": false,
                            "changed": changed,
                            "message": format!("set reload failed: {e}"),
                            "schedule": "daily",
                        },
                    }));
                    return 1;
                }
            }
        }
    }
    if ok {
        0
    } else {
        1
    }
}

// ── lookup / countries / counters ─────────────────────────────────────────────

/// IP → country JSON, always on stdout with exit 0 (errors included) so the
/// WebUI backend only parses. Runs unprivileged (the DB is world-readable).
pub fn lookup(args: &[String]) -> i32 {
    let raw = args.first().map(|s| s.trim()).unwrap_or("");
    let Ok(ip) = raw.parse::<std::net::IpAddr>() else {
        println!(
            "{}",
            json!({ "error": if raw.is_empty() {
                "usage: geoip-lookup <ip>".to_string()
            } else {
                format!("\"{raw}\" is not a valid IP address")
            }})
        );
        return 0;
    };
    let database = match db::open_default() {
        Ok(db) => db,
        Err(e) => {
            println!("{}", json!({ "error": format!("location database unavailable: {e}") }));
            return 0;
        }
    };
    let result = database.lookup(&ip.to_string());
    let name = result.country.as_ref().and_then(|cc| {
        database.countries().into_iter().find(|c| &c.code == cc).map(|c| c.name)
    });
    println!(
        "{}",
        json!({
            "ip": ip.to_string(),
            "country": result.country,
            "country_name": name,
            "network": result.network,
            "db_version": database.created_at(),
        })
    );
    0
}

/// Selectable countries: JSON list, or `--codes` for CLI tab completion.
pub fn countries(args: &[String]) -> i32 {
    let codes_only = args.iter().any(|a| a == "--codes");
    let Ok(database) = db::open_default() else {
        // No database yet — completion offers nothing; format validation
        // still happens in the node.def pattern and verify().
        println!("{}", if codes_only { "" } else { "[]" });
        return 0;
    };
    let list = database.countries();
    if codes_only {
        println!("{}", list.iter().map(|c| c.code.as_str()).collect::<Vec<_>>().join(" "));
    } else {
        println!("{}", serde_json::to_string(&list).unwrap());
    }
    0
}

/// Dump the hit counters for the (unprivileged) WebUI backend. Runs as root
/// from quartzfire-geoip-counters.timer, gated on the `active` marker.
pub fn counters() -> i32 {
    let actions: BTreeMap<String, serde_json::Value> = apply::read_counters()
        .into_iter()
        .map(|(name, (p, b))| (name, json!({ "packets": p, "bytes": b })))
        .collect();
    let policies: BTreeMap<String, serde_json::Value> = apply::read_policy_counters()
        .into_iter()
        .map(|(pid, (p, b))| (pid.to_string(), json!({ "packets": p, "bytes": b })))
        .collect();
    let countries: BTreeMap<String, serde_json::Value> = apply::read_country_counters()
        .into_iter()
        .filter(|(_, (p, _))| *p > 0)
        .map(|(cc, (p, b))| (cc, json!({ "packets": p, "bytes": b })))
        .collect();
    let body = json!({
        "time": apply::now(),
        // Named per-action counters: packets/bytes DROPPED.
        "actions": actions,
        // Per-policy jump-rule counters: new connections CHECKED.
        "policies": policies,
        // Per-country blocked packets/bytes (block-listed actions), for the
        // Top Blocked Countries dashboard tile. Zero-hit countries are omitted.
        "countries": countries,
    });
    match apply::write_atomic(&apply::counters_file(), &body.to_string()) {
        Ok(()) => 0,
        Err(e) => {
            log(&e.0);
            1
        }
    }
}

// ── traffic (conntrack country sampler) ───────────────────────────────────────

/// The `src=`/`dst=` IPs on one conntrack line — the tuple addresses of both
/// the original and reply directions. Deduplicated so one flow counts a
/// country once, not once per tuple.
fn conntrack_line_ips(line: &str) -> BTreeSet<String> {
    let mut ips = BTreeSet::new();
    for tok in line.split_whitespace() {
        if let Some(ip) = tok.strip_prefix("src=").or_else(|| tok.strip_prefix("dst=")) {
            ips.insert(ip.to_string());
        }
    }
    ips
}

/// Aggregate active connections by country. `classify` maps an IP → country
/// code (None for private/unclassified, which drop out). One count per
/// (flow, country); a per-IP memo avoids re-classifying shared peers.
fn count_conntrack_countries(
    conntrack: &str,
    mut classify: impl FnMut(&str) -> Option<String>,
) -> BTreeMap<String, u64> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut memo: BTreeMap<String, Option<String>> = BTreeMap::new();
    for line in conntrack.lines() {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for ip in conntrack_line_ips(line) {
            let cc = memo.entry(ip.clone()).or_insert_with(|| classify(&ip)).clone();
            if let Some(cc) = cc {
                seen.insert(cc);
            }
        }
        for cc in seen {
            *counts.entry(cc).or_insert(0) += 1;
        }
    }
    counts
}

/// Dump active-connection counts per country for the Geolocation Map globe.
/// Runs as root from quartzfire-geoip-traffic.timer. Both endpoints of every
/// conntrack flow are classified via libloc; private/unclassified addresses
/// don't match a country and drop out, so what remains is the set of countries
/// the box is currently exchanging traffic with.
pub fn traffic() -> i32 {
    let database = open_db();
    let counts = match &database {
        Some(db) => {
            let conntrack = std::fs::read_to_string("/proc/net/nf_conntrack").unwrap_or_default();
            count_conntrack_countries(&conntrack, |ip| db.lookup(ip).country)
        }
        None => BTreeMap::new(),
    };

    let mut ranked: Vec<(String, u64)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let countries: Vec<serde_json::Value> = ranked
        .into_iter()
        .map(|(code, count)| json!({ "code": code, "count": count }))
        .collect();

    let body = json!({
        "time": apply::now(),
        "db_version": database.as_ref().map(|d| d.created_at()),
        "countries": countries,
    });
    match apply::write_atomic(&apply::traffic_file(), &body.to_string()) {
        Ok(()) => 0,
        Err(e) => {
            log(&e.0);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conntrack_countries_dedup_per_flow() {
        // Two flows to 8.8.8.8 (US) and one to 1.1.1.1 (AU). Each line lists the
        // external peer twice (original dst + reply src) — must count once.
        let sample = "\
ipv4 2 tcp 6 431999 ESTABLISHED src=10.0.0.5 dst=8.8.8.8 sport=44001 dport=443 src=8.8.8.8 dst=203.0.113.7 sport=443 dport=44001 [ASSURED]
ipv4 2 tcp 6 300 ESTABLISHED src=10.0.0.6 dst=8.8.8.8 sport=44002 dport=443 src=8.8.8.8 dst=203.0.113.7 sport=443 dport=44002 [ASSURED]
ipv4 2 udp 17 29 src=10.0.0.7 dst=1.1.1.1 sport=5000 dport=53 src=1.1.1.1 dst=203.0.113.7 sport=53 dport=5000";
        let classify = |ip: &str| match ip {
            "8.8.8.8" => Some("US".to_string()),
            "1.1.1.1" => Some("AU".to_string()),
            _ => None, // private / the box's own public addr left unclassified here
        };
        let counts = count_conntrack_countries(sample, classify);
        assert_eq!(counts.get("US"), Some(&2));
        assert_eq!(counts.get("AU"), Some(&1));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn conntrack_empty_input_is_empty() {
        assert!(count_conntrack_countries("", |_| Some("US".into())).is_empty());
    }
}
