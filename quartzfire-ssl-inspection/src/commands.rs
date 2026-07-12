//! The qzssl entry points, one per symlink name (see main.rs):
//!
//!   commit    — conf-mode owner of `service quartzfire ssl-inspection`
//!   apply     — standalone resync from the last committed snapshot
//!   ca        — generate | regenerate | info the inspection CA
//!   cadist    — the plain-HTTP CA distribution listener (:4126)
//!   capcheck  — squid -v build-capability probe → status.json
//!   status    — re-probe squid/ICAP health → status.json

use serde_json::json;

use crate::apply;
use crate::ca;
use crate::cadist;
use crate::capcheck;
use crate::config::{self, CliShellApi};
use crate::model;

fn log(msg: &str) {
    eprintln!("quartzfire-ssl: {msg}");
}

// ── commit (conf-mode owner) ──────────────────────────────────────────────────

/// Commit-time owner of `service quartzfire ssl-inspection`. Stages follow the
/// vyos-1x convention: read the session config, verify (any problem → stderr +
/// exit 1 ABORTS the commit), snapshot the desired state, apply.
///
/// verify() is where a build lacking OpenSSL bump support (or ICAP, when a
/// content filter is configured) fails the commit LOUDLY. Runtime apply
/// failures (a transient squid reload, off-device) are warnings, not commit
/// aborts, so the config still commits and can be fixed / commit-confirm
/// rolled back — the error is surfaced in status.json.
pub fn commit() -> i32 {
    let conf = CliShellApi::session();
    let model = config::read_service(&conf);
    let caps = capcheck::probe();

    let problems = model::validate(&model, caps.map(|c| c.bump), caps.map(|c| c.icap));
    if !problems.is_empty() {
        eprintln!("{}", problems.join("\n"));
        return 1;
    }

    if let Err(e) = apply::save_desired(&model) {
        eprintln!("{e}");
        return 1;
    }

    let report = apply::apply_model(&model, caps);
    if !report.ok {
        eprintln!(
            "WARNING: SSL inspection config committed but not fully applied: {}",
            report.error.unwrap_or_default()
        );
    }
    0
}

// ── apply (standalone resync) ─────────────────────────────────────────────────

/// Re-apply OUTSIDE a commit, from the last committed snapshot. No snapshot =
/// SSL inspection has never been committed this boot = nothing to do
/// (deliberately NOT a teardown, so a path-unit run racing the boot commit
/// cannot yank the redirect the commit is about to install).
pub fn standalone_apply() -> i32 {
    let model = match apply::load_desired() {
        Ok(Some(m)) => m,
        Ok(None) => {
            log("no committed SSL-inspection state yet — nothing to apply");
            return 0;
        }
        Err(e) => {
            log(&e.0);
            return 1;
        }
    };
    let caps = capcheck::probe();
    let report = apply::apply_model(&model, caps);
    if report.ok {
        log("applied");
        0
    } else {
        log(&format!("not applied: {}", report.error.unwrap_or_default()));
        1
    }
}

// ── ca (generate | regenerate | info) ─────────────────────────────────────────

/// CA lifecycle. `generate` is idempotent (no-op if a CA exists); `regenerate`
/// mints a fresh CA — WARN: every previously distributed copy becomes invalid
/// and clients must reinstall. `info` prints the public metadata as JSON.
pub fn ca(args: &[String]) -> i32 {
    let sub = args.first().map(String::as_str).unwrap_or("info");
    match sub {
        "generate" | "regenerate" => {
            let force = sub == "regenerate";
            match ca::generate(force) {
                Ok(info) => {
                    if force {
                        log("CA regenerated — all previously distributed CAs are now INVALID; \
                             clients must reinstall the new certificate");
                    }
                    // A new CA invalidates every mimicked leaf cached in the
                    // certgen DB; clear it and reload so Squid re-mints under
                    // the new root. Then refresh status/ca-info.
                    apply::post_ca_change();
                    println!("{}", serde_json::to_string_pretty(&info).unwrap());
                    0
                }
                Err(e) => {
                    log(&format!("CA {sub} failed: {e}"));
                    1
                }
            }
        }
        "info" => {
            let info = ca::inspect().unwrap_or_default();
            println!("{}", serde_json::to_string_pretty(&info).unwrap());
            0
        }
        other => {
            log(&format!("unknown ca subcommand \"{other}\" (use generate|regenerate|info)"));
            2
        }
    }
}

// ── cadist ────────────────────────────────────────────────────────────────────

pub fn cadist() -> i32 {
    cadist::serve()
}

// ── capcheck ──────────────────────────────────────────────────────────────────

/// Probe the Squid build and record the booleans in status.json. Prints the
/// result; a build lacking bump support is a non-zero exit so the ISO build
/// (scripts/check-squid-caps) can fail loudly.
pub fn capcheck() -> i32 {
    match capcheck::probe() {
        Some(c) => {
            println!("{}", json!({ "bump_capable": c.bump, "icap_capable": c.icap }));
            apply::update_status(json!({
                "squid": { "bump_capable": c.bump, "icap_capable": c.icap },
                "capcheck_time": apply::now(),
            }));
            if c.bump {
                0
            } else {
                log("Squid is built WITHOUT OpenSSL ssl_bump support — install squid-openssl");
                1
            }
        }
        None => {
            println!("{}", json!({ "bump_capable": null, "icap_capable": null }));
            log("could not run `squid -v` — is squid installed?");
            1
        }
    }
}

// ── status ────────────────────────────────────────────────────────────────────

pub fn status() -> i32 {
    apply::refresh_status()
}
