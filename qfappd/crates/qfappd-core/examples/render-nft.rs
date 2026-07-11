//! Dump the generated nftables ruleset for the default layout/config —
//! handy for eyeballing and for validating against a real `nft -f` (the
//! target ships nftables 1.0.6, which is pickier than the docs suggest):
//!
//!   cargo run -p qfappd-core --example render-nft | nft -c -f -

use qfappd_core::config::FailMode;
use qfappd_core::ctmark::Layout;
use qfappd_core::nftgen::{render_table, QueueSpec};
use qfappd_core::policy::{CompiledBinding, MatchSpec};

fn main() {
    let layout = Layout::default();
    let queues = QueueSpec { start: 100, count: 4, fail_mode: FailMode::Open };
    // One representative binding so the qf_bindings chain isn't empty.
    let binding = CompiledBinding {
        binding_id: 1,
        action_id: 1,
        action_name: "Global".into(),
        description: String::new(),
        match_spec: MatchSpec { iifname: vec!["eth1".into()], ..Default::default() },
    };
    print!("{}", render_table(&layout, queues, &[binding]));
}
