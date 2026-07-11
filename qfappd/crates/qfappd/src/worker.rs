//! Per-queue classification worker.
//!
//! One worker owns one NFQUEUE, one nDPI [`Engine`], and one private
//! [`FlowTable`] — NFQUEUE `fanout` guarantees a flow only ever lands on one
//! queue, so nothing here is shared or locked on the packet path.
//!
//! The decision state machine ([`WorkerCore::handle_packet`]) is written
//! against the [`Engine`], [`MarkWriter`], [`EventSink`], and stats
//! abstractions so it is unit-tested with the stub classifier and a recording
//! mark writer/sink; [`run_queue`] is the thin nfq driver that feeds it and
//! is exercised by the on-target integration tests.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use qfappd_core::ctmark::Layout;
use qfappd_core::event::{rfc3339_utc, Event};
use qfappd_core::flowtable::{FlowKey, FlowTable};
use qfappd_core::policy::{BlockMode, CompiledPolicy, Verdict};
use qfappd_core::stats::StatsAggregator;

use crate::classify::{ClassifyResult, Engine, Flow};
use crate::pkt::{self, Parsed};
use crate::reset::{self, ResetPair};

/// Where classified-flow events go. Shared across all worker threads
/// (`Arc<dyn EventSink>`), so it must be `Send + Sync`.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: Event);
}

/// Per-flow classification state (only unclassified flows live in the table).
pub struct FlowState {
    flow: Flow,
    pkts: u64,
    bytes: u64,
}

/// What the driver must do with a packet after the core decides.
///
/// qfappd always issues NF_ACCEPT: a block is enforced by the nftables
/// `qfappd-block` rule, which drops the reinjected verdict packet once its
/// mark carries the BLOCK bit. `set_mark`, when present, is the new skb mark
/// the driver must attach to the verdict so nftables can persist it into the
/// ct mark and (for blocks) drop the flow.
pub struct Outcome {
    /// New packet (skb) mark to set on the verdict, or None to leave it.
    pub set_mark: Option<u32>,
    /// RSTs to inject (block_mode reset on a TCP flow).
    pub reset: Option<ResetPair>,
    /// Whether the decision was a block (for stats/logging/tests; the actual
    /// drop is done by nftables, not the NFQUEUE verdict).
    pub blocked: bool,
}

impl Outcome {
    /// Let the packet continue unchanged (still classifying, or non-IP).
    fn pass() -> Self {
        Self { set_mark: None, reset: None, blocked: false }
    }
}

/// The verdict for a finalized flow — pure function of policy + classification.
#[derive(Debug, Clone)]
pub struct Decision {
    pub block: bool,
    pub action_name: String,
    pub block_mode: BlockMode,
    pub default_applied: bool,
    pub reset: bool,
}

/// Pure decision: given the governing action id and a final classification,
/// decide allow/block. No action bound (id 0, shouldn't happen for queued
/// traffic) means allow.
pub fn decide(policy: &CompiledPolicy, action_id: u8, r: &ClassifyResult, is_tcp: bool) -> Decision {
    match policy.action(action_id) {
        Some(a) => {
            let block = a.verdict(r.app_id) == Verdict::Block;
            Decision {
                block,
                action_name: a.name.clone(),
                block_mode: a.block_mode,
                default_applied: a.is_default(r.app_id),
                reset: block && a.block_mode == BlockMode::Reset && is_tcp,
            }
        }
        None => Decision {
            block: false,
            action_name: String::new(),
            block_mode: BlockMode::Drop,
            default_applied: true,
            reset: false,
        },
    }
}

pub struct Budgets {
    pub max_packets: u64,
    pub max_payload_bytes: u64,
}

pub struct WorkerCore {
    pub engine: Engine,
    pub table: FlowTable<FlowKey, FlowState>,
    pub layout: Layout,
    pub budgets: Budgets,
    pub sink: Arc<dyn EventSink>,
    pub stats: Arc<Mutex<StatsAggregator>>,
    /// Catalog lookups for event enrichment (app/category names).
    pub app_name: Arc<dyn Fn(u16) -> (String, String) + Send + Sync>,
    /// Lock-free swappable active policy, shared with the reload task.
    pub policy: PolicyHandle,
}

impl WorkerCore {
    /// Handle one packet. `pkt_mark` is the skb mark set by the binding rule
    /// (carries ACTION_ID); `now_ms` is a monotonic millisecond clock for
    /// nDPI; `now` drives flow-table timing.
    pub fn handle_packet(
        &mut self,
        pkt_mark: u32,
        payload: &[u8],
        in_iface: &str,
        vlan: u16,
        now: Instant,
        now_ms: u64,
    ) -> Outcome {
        let Some(parsed) = pkt::parse(payload) else {
            // Non-IP or non-TCP/UDP: not something we classify, let it pass.
            return Outcome::pass();
        };
        let action_id = self.layout.decode(pkt_mark).action_id;
        let keyed = FlowKey::normalized(
            parsed.tuple.proto,
            parsed.tuple.src,
            parsed.tuple.src_port,
            parsed.tuple.dst,
            parsed.tuple.dst_port,
            vlan,
        );
        let key = keyed.key;

        // Feed the packet into the flow's DPI state (creating the flow on
        // first sight), and learn whether classification concluded.
        let (result, pkts, bytes) = {
            if self.table.get_mut(&key, now).is_none() {
                let flow = match self.engine.new_flow() {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::warn!("new_flow failed: {e}; accepting packet");
                        return Outcome::pass();
                    }
                };
                self.table.insert(key, FlowState { flow, pkts: 0, bytes: 0 }, now);
            }
            let state = self.table.get_mut(&key, now).expect("just inserted");
            state.pkts += 1;
            state.bytes += payload.len() as u64;
            let mut result = self.engine.process(&mut state.flow, payload, now_ms);

            let over_budget =
                state.pkts >= self.budgets.max_packets || state.bytes >= self.budgets.max_payload_bytes;
            if !result.is_final && over_budget {
                result = self.engine.giveup(&mut state.flow);
                result.is_final = true;
            }
            (result, state.pkts, state.bytes)
        };

        if !result.is_final {
            // Keep classifying; the packet flows through meanwhile.
            return Outcome::pass();
        }

        // Finalize: the flow leaves the table (its verdict now rides the packet
        // mark, which nftables persists into the ct mark for the fast path).
        self.table.remove(&key);
        self.finalize(action_id, pkt_mark, &parsed, in_iface, vlan, &result, pkts, bytes)
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize(
        &mut self,
        action_id: u8,
        pkt_mark: u32,
        parsed: &Parsed,
        in_iface: &str,
        vlan: u16,
        result: &ClassifyResult,
        pkts: u64,
        bytes: u64,
    ) -> Outcome {
        let decision = decide(&self.current_policy(), action_id, result, parsed.is_tcp());

        // Offload: encode the verdict into the packet mark (masked over the
        // qfappd bits, keeping the ACTION_ID the binding rule set). nftables'
        // persist rule copies it into the ct mark and drops the flow if BLOCK.
        let new_mark = self.layout.encode_verdict(result.app_id, decision.block).apply(pkt_mark);

        let (app, category) = (self.app_name)(result.app_id);
        self.emit_event(parsed, in_iface, vlan, result, &decision, &app, &category, pkts, bytes);

        {
            let mut s = self.stats.lock().unwrap();
            s.record_decision(result.app_id, decision.block, bytes, pkts);
        }

        // block_mode reset: send RSTs to both ends (the drop is nftables' job).
        let reset = if decision.reset { reset::build(parsed) } else { None };
        Outcome { set_mark: Some(new_mark), reset, blocked: decision.block }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_event(
        &self,
        parsed: &Parsed,
        in_iface: &str,
        vlan: u16,
        result: &ClassifyResult,
        decision: &Decision,
        app: &str,
        category: &str,
        pkts: u64,
        bytes: u64,
    ) {
        let (secs, millis) = now_unix();
        let proto = match parsed.tuple.proto {
            pkt::IPPROTO_TCP => "TCP".to_string(),
            pkt::IPPROTO_UDP => "UDP".to_string(),
            other => other.to_string(),
        };
        let event = Event {
            timestamp: rfc3339_utc(secs, millis),
            event_type: Event::EVENT_TYPE,
            src_ip: parsed.tuple.src.to_string(),
            src_port: parsed.tuple.src_port,
            dest_ip: parsed.tuple.dst.to_string(),
            dest_port: parsed.tuple.dst_port,
            proto,
            vlan,
            in_iface: in_iface.to_owned(),
            app: if app.is_empty() { "Unknown".into() } else { app.to_owned() },
            app_id: result.app_id,
            category: category.to_owned(),
            action: if decision.block { "block".into() } else { "allow".into() },
            action_name: decision.action_name.clone(),
            block_mode: match decision.block_mode {
                BlockMode::Drop => "drop".into(),
                BlockMode::Reset => "reset".into(),
            },
            confidence: result.confidence.clone(),
            default_applied: decision.default_applied,
            sni: result.sni.clone(),
            ja4: result.ja4.clone(),
            bytes,
            pkts,
        };
        self.sink.emit(event);
    }

    fn current_policy(&self) -> Arc<CompiledPolicy> {
        self.policy.load()
    }

    /// Idle-flow eviction; called on a timer tick and opportunistically.
    pub fn sweep(&mut self, now: Instant) {
        let evicted = self.table.sweep(now);
        if !evicted.is_empty() {
            let mut s = self.stats.lock().unwrap();
            s.flowtable_idle_evictions = self.table.evicted_idle;
            s.flowtable_lru_evictions = self.table.evicted_lru;
            drop(s);
            tracing::trace!("swept {} idle flows", evicted.len());
        }
    }
}

/// Lock-free swappable policy pointer shared by all workers and the reload
/// task. Reads clone an `Arc`; writes swap the pointer.
#[derive(Clone)]
pub struct PolicyHandle(Arc<Mutex<Arc<CompiledPolicy>>>);

impl PolicyHandle {
    pub fn new(initial: Arc<CompiledPolicy>) -> Self {
        Self(Arc::new(Mutex::new(initial)))
    }
    pub fn load(&self) -> Arc<CompiledPolicy> {
        Arc::clone(&self.0.lock().unwrap())
    }
    pub fn store(&self, p: Arc<CompiledPolicy>) {
        *self.0.lock().unwrap() = p;
    }
}

fn now_unix() -> (i64, u32) {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    (d.as_secs() as i64, d.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use qfappd_core::catalog::Catalog;
    use qfappd_core::policy::PolicyManager;
    use std::time::Duration;

    struct RecordingSink(Mutex<Vec<Event>>);
    impl EventSink for RecordingSink {
        fn emit(&self, event: Event) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn v4_tcp(sport: u16, dport: u16) -> Vec<u8> {
        let mut p = vec![
            0x45, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00, 0x00, 0x40, pkt::IPPROTO_TCP, 0x00, 0x00,
            10, 0, 0, 1, 10, 0, 0, 2,
        ];
        p.extend_from_slice(&[
            (sport >> 8) as u8, sport as u8, (dport >> 8) as u8, dport as u8,
            0, 0, 0, 1, 0, 0, 0, 0, 0x50, 0x18, 0xff, 0xff, 0, 0, 0, 0,
        ]);
        p
    }

    fn make_core(policy: Arc<CompiledPolicy>, layout: Layout) -> (WorkerCore, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink(Mutex::new(Vec::new())));
        let catalog = Catalog::fixture();
        let cat = catalog.clone();
        let core = WorkerCore {
            engine: crate::classify::stub_classifier(),
            table: FlowTable::new(1000, Duration::from_secs(120)),
            layout,
            budgets: Budgets { max_packets: 3, max_payload_bytes: 4096 },
            sink: sink.clone(),
            stats: Arc::new(Mutex::new(StatsAggregator::default())),
            app_name: Arc::new(move |id| {
                (
                    cat.app_name(id).unwrap_or("Unknown").to_string(),
                    cat.category_of(id).unwrap_or("").to_string(),
                )
            }),
            policy: PolicyHandle::new(policy),
        };
        (core, sink)
    }

    fn policy_json(default_action: &str, apps: serde_json::Value) -> Arc<CompiledPolicy> {
        let text = serde_json::json!({
            "version": 2,
            "actions": { "Global": { "default_action": default_action, "block_mode": "drop", "applications": apps } },
            "bindings": [ { "id": 1, "action": "Global" } ]
        })
        .to_string();
        let mut mgr = PolicyManager::new();
        mgr.load_str(&text, &Catalog::fixture(), &Layout::default()).unwrap()
    }

    // The stub engine never reaches a final classification on its own, so a
    // flow is decided at budget exhaustion as app_id 0 (Unknown) → default.
    #[test]
    fn unknown_flow_follows_default_allow() {
        let layout = Layout::default();
        let policy = policy_json("allow", serde_json::json!({}));
        let (mut core, sink) = make_core(policy, layout);
        let mark = layout.encode_action(1).apply(0);
        let now = Instant::now();

        // budget is 3 packets: first two pass while classifying…
        for _ in 0..2 {
            let o = core.handle_packet(mark, &v4_tcp(1111, 443), "eth1", 0, now, 0);
            assert!(o.set_mark.is_none());
            assert!(!o.blocked);
        }
        // …third gives up → Unknown → default allow, flow leaves the table.
        let o = core.handle_packet(mark, &v4_tcp(1111, 443), "eth1", 0, now, 0);
        assert!(!o.blocked);
        assert!(o.reset.is_none());
        // an allow verdict sets CLASSIFIED (not BLOCK) in the packet mark
        let m = o.set_mark.expect("verdict sets a packet mark");
        let s = layout.decode(m);
        assert!(s.classified && !s.block);
        assert_eq!(s.action_id, 1, "binding action id preserved");
        assert_eq!(core.table.len(), 0);

        let events = sink.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].app, "Unknown");
        assert_eq!(events[0].action, "allow");
        assert!(events[0].default_applied);
    }

    #[test]
    fn unknown_flow_blocked_when_default_block() {
        let layout = Layout::default();
        let policy = policy_json("block", serde_json::json!({}));
        let (mut core, _sink) = make_core(policy, layout);
        let mark = layout.encode_action(1).apply(0);
        let now = Instant::now();
        let mut last = Outcome::pass();
        for _ in 0..3 {
            last = core.handle_packet(mark, &v4_tcp(2222, 80), "eth1", 0, now, 0);
        }
        assert!(last.blocked, "default block should block the flow");
        // the verdict packet mark carries CLASSIFIED|BLOCK so nftables drops it
        let s = layout.decode(last.set_mark.expect("verdict mark"));
        assert!(s.classified && s.block);
    }

    #[test]
    fn block_verdict_encodes_block_bit() {
        let layout = Layout::default();
        // block ChatGPT specifically; but the stub never classifies, so use
        // default block to exercise the block encoding path.
        let policy = policy_json("block", serde_json::json!({}));
        let (mut core, _sink) = make_core(policy, layout);
        let mark = layout.encode_action(1).apply(0);
        let now = Instant::now();
        let mut last = Outcome::pass();
        for _ in 0..3 {
            last = core.handle_packet(mark, &v4_tcp(3333, 80), "eth1", 0, now, 0);
        }
        let m = last.set_mark.expect("verdict mark");
        assert!(m & layout.classified_mask() != 0);
        assert!(m & layout.block_mask() != 0);
    }

    #[test]
    fn non_ip_packet_is_passed_without_flow() {
        let layout = Layout::default();
        let policy = policy_json("block", serde_json::json!({}));
        let (mut core, sink) = make_core(policy, layout);
        let o = core.handle_packet(0, &[0xff, 0x00, 0x11], "eth1", 0, Instant::now(), 0);
        assert!(o.set_mark.is_none());
        assert!(!o.blocked);
        assert_eq!(core.table.len(), 0);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn distinct_flows_tracked_separately() {
        let layout = Layout::default();
        let policy = policy_json("allow", serde_json::json!({}));
        let (mut core, _sink) = make_core(policy, layout);
        let mark = layout.encode_action(1).apply(0);
        let now = Instant::now();
        core.handle_packet(mark, &v4_tcp(1111, 443), "eth1", 0, now, 0);
        core.handle_packet(mark, &v4_tcp(2222, 443), "eth1", 0, now, 0);
        assert_eq!(core.table.len(), 2);
    }
}
