//! qzssl — QuartzFire SSL Inspection multi-call binary.
//!
//! Installed once at /usr/libexec/quartzfire/qzssl with symlinks providing the
//! stable entry-point names every other component references (systemd units,
//! the WebUI backend, the conf-mode owner). Same argv[0]-dispatch scheme as
//! quartzfire-geoip's qzgeo:
//!
//!   qzssl-apply              → apply     (standalone resync / boot / path unit)
//!   qzssl-ca                 → ca        (generate | regenerate | info)
//!   qzssl-cadist             → cadist    (plain-HTTP CA distribution :4126)
//!   qzssl-capcheck           → capcheck  (squid -v bump/ICAP capability probe)
//!   qzssl-status             → status    (squid + ICAP health → status.json)
//!   service_ssl_inspection.py → commit   (conf-mode owner, in conf_mode/; the
//!                              .py suffix is required by vyos-configd's
//!                              script-path regex and stripped by file_stem)
//!
//! Invoked as plain `qzssl`, the first argument selects the same operations.

mod apply;
mod ca;
mod cadist;
mod capcheck;
mod commands;
mod config;
mod model;
mod render;

fn dispatch(op: &str, rest: &[String]) -> Option<i32> {
    Some(match op {
        "commit" | "service_ssl_inspection" => commands::commit(),
        "apply" | "qzssl-apply" => commands::standalone_apply(),
        "ca" | "qzssl-ca" => commands::ca(rest),
        "cadist" | "qzssl-cadist" => commands::cadist(),
        "capcheck" | "qzssl-capcheck" => commands::capcheck(),
        "status" | "qzssl-status" => commands::status(),
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

    // Direct invocation: qzssl <op> [args…].
    if let Some(op) = args.get(1) {
        if let Some(code) = dispatch(op, &args[2..]) {
            std::process::exit(code);
        }
    }
    eprintln!(
        "usage: qzssl <commit|apply|ca <generate|regenerate|info>|cadist|capcheck|status>"
    );
    std::process::exit(2);
}
