//! qzgeo — QuartzFire geolocation multi-call binary.
//!
//! Installed once at /usr/libexec/quartzfire/qzgeo with symlinks providing
//! the stable entry-point names every other component references (systemd
//! units, node.def `allowed:` lines, the WebUI backend, the conf-mode owner):
//!
//!   geoip-apply             → apply      (standalone resync)
//!   geoip-update            → update     (database update + set refresh)
//!   geoip-lookup            → lookup     (IP → country JSON)
//!   geoip-countries         → countries  (country list / --codes completion)
//!   geoip-counters          → counters   (hit-counter dump)
//!   service_geolocation.py  → commit     (conf-mode owner, in conf_mode/;
//!                             the .py suffix is required by vyos-configd's
//!                             script-path regex and stripped by file_stem)
//!
//! Invoked as plain `qzgeo`, the first argument selects the same operations.

mod apply;
mod commands;
mod config;
mod db;
mod matchrepl;
mod model;
#[cfg(test)]
mod pipeline_tests;
mod render;

fn dispatch(op: &str, rest: &[String]) -> Option<i32> {
    Some(match op {
        "commit" | "service_geolocation" => commands::commit(),
        "apply" | "geoip-apply" => commands::standalone_apply(),
        "update" | "geoip-update" => commands::update(),
        "lookup" | "geoip-lookup" => commands::lookup(rest),
        "countries" | "geoip-countries" => commands::countries(rest),
        "counters" | "geoip-counters" => commands::counters(),
        _ => return None,
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Symlink dispatch: the basename decides the operation.
    let argv0 = std::path::Path::new(args.first().map(String::as_str).unwrap_or(""))
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(code) = dispatch(&argv0, &args[1..]) {
        std::process::exit(code);
    }

    // Direct invocation: qzgeo <op> [args…].
    if let Some(op) = args.get(1) {
        if let Some(code) = dispatch(op, &args[2..]) {
            std::process::exit(code);
        }
    }
    eprintln!("usage: qzgeo <commit|apply|update|lookup <ip>|countries [--codes]|counters>");
    std::process::exit(2);
}
