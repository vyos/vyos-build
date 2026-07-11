//! Applies the generated nftables scripts via `nft -f -` (single atomic
//! transaction each). qfappd owns the `inet qfappd` table exclusively, so
//! these never touch VyOS's `vyos_filter` table.

use std::io::Write;
use std::process::{Command, Stdio};

use qfappd_core::ctmark::Layout;
use qfappd_core::nftgen::{self, QueueSpec};
use qfappd_core::policy::CompiledBinding;

fn queue_spec(cfg: &qfappd_core::config::Config) -> QueueSpec {
    QueueSpec {
        start: cfg.queues.start,
        count: cfg.queues.count,
        fail_mode: cfg.queues.fail_mode,
    }
}

/// Run an nft script over stdin. Returns the combined stderr on failure so
/// the daemon can log exactly which rule nft rejected.
fn apply(script: &str) -> anyhow::Result<()> {
    let mut child = Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn nft: {e} (is nftables installed?)"))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(script.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        anyhow::bail!(
            "nft -f failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// Install the base table + fast paths + initial bindings (startup).
pub fn install_table(
    cfg: &qfappd_core::config::Config,
    layout: &Layout,
    bindings: &[CompiledBinding],
) -> anyhow::Result<()> {
    apply(&nftgen::render_table(layout, queue_spec(cfg), bindings))
}

/// Atomically replace the bindings chain (policy hot-reload).
pub fn reload_bindings(
    cfg: &qfappd_core::config::Config,
    layout: &Layout,
    bindings: &[CompiledBinding],
) -> anyhow::Result<()> {
    apply(&nftgen::render_bindings_reload(layout, queue_spec(cfg), bindings))
}

/// Remove the table — fail-open teardown on shutdown. Never errors on a
/// missing table.
pub fn teardown() -> anyhow::Result<()> {
    apply(&nftgen::render_teardown())
}
