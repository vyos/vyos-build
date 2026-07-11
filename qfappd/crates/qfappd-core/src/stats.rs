//! Per-application flow statistics and daemon health counters, aggregated
//! from the queue workers for GetFlowStats / GetStatus.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct AppStat {
    pub flows: u64,
    pub blocked_flows: u64,
    /// Bytes/packets observed up to the classification decision (the fast
    /// path bypasses userspace, so post-decision traffic is not counted here;
    /// the nft fast-path counters cover that).
    pub bytes: u64,
    pub pkts: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopApp {
    pub app_id: u16,
    pub app: String,
    pub stat: AppStat,
}

#[derive(Debug, Default, Clone)]
pub struct StatsAggregator {
    per_app: HashMap<u16, AppStat>,
    pub decisions: u64,
    pub blocked: u64,
    pub unknown: u64,
    pub queue_drops: u64,
    pub event_sink_drops: u64,
    pub flowtable_lru_evictions: u64,
    pub flowtable_idle_evictions: u64,
}

impl StatsAggregator {
    /// Fold another aggregator's counters into this one (per-worker → total).
    pub fn merge(&mut self, other: &StatsAggregator) {
        for (&id, s) in &other.per_app {
            let e = self.per_app.entry(id).or_default();
            e.flows += s.flows;
            e.blocked_flows += s.blocked_flows;
            e.bytes += s.bytes;
            e.pkts += s.pkts;
        }
        self.decisions += other.decisions;
        self.blocked += other.blocked;
        self.unknown += other.unknown;
        self.queue_drops += other.queue_drops;
        self.event_sink_drops += other.event_sink_drops;
        self.flowtable_lru_evictions += other.flowtable_lru_evictions;
        self.flowtable_idle_evictions += other.flowtable_idle_evictions;
    }

    pub fn record_decision(&mut self, app_id: u16, blocked: bool, bytes: u64, pkts: u64) {
        let s = self.per_app.entry(app_id).or_default();
        s.flows += 1;
        s.bytes += bytes;
        s.pkts += pkts;
        self.decisions += 1;
        if blocked {
            s.blocked_flows += 1;
            self.blocked += 1;
        }
        if app_id == 0 {
            self.unknown += 1;
        }
    }

    pub fn unknown_pct(&self) -> f64 {
        if self.decisions == 0 {
            0.0
        } else {
            self.unknown as f64 * 100.0 / self.decisions as f64
        }
    }

    pub fn app_stat(&self, app_id: u16) -> AppStat {
        self.per_app.get(&app_id).copied().unwrap_or_default()
    }

    /// Top N applications by flow count (deterministic tie-break on app id).
    pub fn top_n(&self, n: usize, name_of: impl Fn(u16) -> String) -> Vec<TopApp> {
        let mut all: Vec<(u16, AppStat)> = self.per_app.iter().map(|(&k, &v)| (k, v)).collect();
        all.sort_by(|a, b| b.1.flows.cmp(&a.1.flows).then(a.0.cmp(&b.0)));
        all.truncate(n);
        all.into_iter()
            .map(|(app_id, stat)| TopApp { app_id, app: name_of(app_id), stat })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregation_and_top_n() {
        let mut s = StatsAggregator::default();
        for _ in 0..5 {
            s.record_decision(244, true, 1000, 4); // ChatGPT blocked
        }
        for _ in 0..3 {
            s.record_decision(91, false, 500, 2); // TLS allowed
        }
        s.record_decision(0, false, 100, 12); // unknown

        assert_eq!(s.decisions, 9);
        assert_eq!(s.blocked, 5);
        assert_eq!(s.unknown, 1);
        assert!((s.unknown_pct() - 11.111).abs() < 0.01);
        assert_eq!(s.app_stat(244).flows, 5);
        assert_eq!(s.app_stat(244).blocked_flows, 5);
        assert_eq!(s.app_stat(244).bytes, 5000);

        let top = s.top_n(2, |id| format!("app{id}"));
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].app_id, 244);
        assert_eq!(top[1].app_id, 91);
        assert_eq!(top[1].app, "app91");
    }

    #[test]
    fn merge_combines_workers() {
        let mut a = StatsAggregator::default();
        a.record_decision(244, true, 100, 2);
        let mut b = StatsAggregator::default();
        b.record_decision(244, false, 50, 1);
        b.record_decision(0, false, 10, 3);
        a.merge(&b);
        assert_eq!(a.decisions, 3);
        assert_eq!(a.blocked, 1);
        assert_eq!(a.unknown, 1);
        assert_eq!(a.app_stat(244).flows, 2);
        assert_eq!(a.app_stat(244).bytes, 150);
    }

    #[test]
    fn top_n_tie_breaks_on_app_id() {
        let mut s = StatsAggregator::default();
        s.record_decision(50, false, 1, 1);
        s.record_decision(7, false, 1, 1);
        let top = s.top_n(10, |_| String::new());
        assert_eq!(top[0].app_id, 7);
    }
}
