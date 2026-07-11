//! qfappd — QuartzFire Application Control daemon.
//!
//! Linux-only at runtime (NFQUEUE, ctnetlink, libndpi). The non-Linux build
//! exists so the workspace compiles on dev machines; it only refuses to run.

use clap::{Parser, Subcommand};

// Pure / cross-platform modules — their unit tests run on any dev host.
mod classify;
mod eventlog;
mod pkt;
mod reset;
mod worker;

// Linux-only: NFQUEUE driver, gRPC server, and daemon orchestration.
#[cfg(target_os = "linux")]
mod daemon;
#[cfg(target_os = "linux")]
mod grpc;
#[cfg(target_os = "linux")]
mod nft;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "qfappd", version, about = "QuartzFire Application Control daemon")]
struct Cli {
    /// Path to the daemon configuration file.
    #[arg(long, default_value = "/etc/qfappd/qfappd.toml")]
    config: std::path::PathBuf,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the enforcement daemon (default when no subcommand is given).
    Run,
    /// Dump the nDPI application catalog and exit.
    Catalog {
        /// Emit JSON (the only supported format; flag kept for CLI clarity).
        #[arg(long)]
        json: bool,
    },
    /// Validate a policy file against the installed catalog and exit
    /// non-zero on errors (used by qfappd-apply before publishing).
    CheckPolicy {
        path: std::path::PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    run(cli)
}

#[cfg(target_os = "linux")]
fn run(cli: Cli) -> anyhow::Result<()> {
    let config = qfappd_core::config::Config::load(&cli.config).or_else(|e| {
        if matches!(&e, qfappd_core::config::ConfigError::Io { source, .. }
            if source.kind() == std::io::ErrorKind::NotFound)
        {
            tracing::warn!("config {} not found, using defaults", cli.config.display());
            Ok(qfappd_core::config::Config::default())
        } else {
            Err(e)
        }
    })?;

    match cli.command.unwrap_or(Command::Run) {
        Command::Run => daemon::run(config),
        Command::Catalog { .. } => {
            let classifier = classify::new_classifier()?;
            println!("{}", serde_json::to_string_pretty(&classifier.catalog())?);
            Ok(())
        }
        Command::CheckPolicy { path } => {
            let classifier = classify::new_classifier()?;
            let layout = config.mark.layout()?;
            let mut mgr = qfappd_core::policy::PolicyManager::new();
            match mgr.load_path(&path, &classifier.catalog(), &layout) {
                Ok(p) => {
                    for w in &p.warnings {
                        eprintln!("warning: {w}");
                    }
                    println!("policy OK: {} actions, {} bindings", p.actions.len(), p.bindings.len());
                    Ok(())
                }
                Err(e) => anyhow::bail!("policy invalid: {e}"),
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run(_cli: Cli) -> anyhow::Result<()> {
    anyhow::bail!("qfappd only runs on Linux (NFQUEUE/ctnetlink/libndpi); this build is for development only")
}
