//! Bounded per-worker flow table: LRU capacity eviction + idle timeout.
//!
//! NFQUEUE `fanout` hashes a flow to exactly one queue, so each worker owns a
//! private table — no locking on the packet path. Classified flows are
//! removed immediately (the ct mark carries their state); the table only
//! holds flows still being classified, bounded by `max_entries / n_workers`
//! and an idle timeout so memory can never grow without bound.

use lru::LruCache;
use std::hash::Hash;
use std::net::IpAddr;
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

/// Direction-normalized flow key. Both directions of a connection map to the
/// same entry; `forward` on [`Keyed`] tells the caller which way the packet
/// went relative to the normalized key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FlowKey {
    pub proto: u8,
    pub lo_addr: IpAddr,
    pub hi_addr: IpAddr,
    pub lo_port: u16,
    pub hi_port: u16,
    pub vlan: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keyed {
    pub key: FlowKey,
    /// True when (src, sport) is the (lo, lo) side of the key.
    pub forward: bool,
}

impl FlowKey {
    pub fn normalized(proto: u8, src: IpAddr, sport: u16, dst: IpAddr, dport: u16, vlan: u16) -> Keyed {
        let forward = (src, sport) <= (dst, dport);
        let (lo_addr, lo_port, hi_addr, hi_port) = if forward {
            (src, sport, dst, dport)
        } else {
            (dst, dport, src, sport)
        };
        Keyed {
            key: FlowKey { proto, lo_addr, hi_addr, lo_port, hi_port, vlan },
            forward,
        }
    }
}

struct Entry<V> {
    value: V,
    last_seen: Instant,
}

pub struct FlowTable<K: Hash + Eq, V> {
    entries: LruCache<K, Entry<V>>,
    idle_timeout: Duration,
    /// Cumulative evictions, split by cause, for GetStatus.
    pub evicted_lru: u64,
    pub evicted_idle: u64,
}

impl<K: Hash + Eq + Clone, V> FlowTable<K, V> {
    pub fn new(max_entries: usize, idle_timeout: Duration) -> Self {
        Self {
            entries: LruCache::new(NonZeroUsize::new(max_entries.max(1)).unwrap()),
            idle_timeout,
            evicted_lru: 0,
            evicted_idle: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Fetch-and-touch. Refreshes both LRU position and idle deadline.
    pub fn get_mut(&mut self, key: &K, now: Instant) -> Option<&mut V> {
        let entry = self.entries.get_mut(key)?;
        entry.last_seen = now;
        Some(&mut entry.value)
    }

    /// Insert a new flow; if at capacity the least-recently-seen entry is
    /// evicted and returned so the caller can count/log it.
    pub fn insert(&mut self, key: K, value: V, now: Instant) -> Option<V> {
        let evicted = if self.entries.len() == self.entries.cap().get() && !self.entries.contains(&key) {
            self.evicted_lru += 1;
            self.entries.pop_lru().map(|(_, e)| e.value)
        } else {
            None
        };
        self.entries.put(key, Entry { value, last_seen: now });
        evicted
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        self.entries.pop(key).map(|e| e.value)
    }

    /// Evict every entry idle longer than the timeout. LRU order means the
    /// least-recently-seen entry is at the tail, so we can stop at the first
    /// fresh one. Returns the evicted values.
    pub fn sweep(&mut self, now: Instant) -> Vec<(K, V)> {
        let mut out = Vec::new();
        while let Some((_, entry)) = self.entries.peek_lru() {
            if now.duration_since(entry.last_seen) < self.idle_timeout {
                break;
            }
            let (k, e) = self.entries.pop_lru().expect("peeked entry exists");
            self.evicted_idle += 1;
            out.push((k, e.value));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, last))
    }

    #[test]
    fn key_is_direction_normalized() {
        let a = FlowKey::normalized(6, ip(1), 50000, ip(2), 443, 0);
        let b = FlowKey::normalized(6, ip(2), 443, ip(1), 50000, 0);
        assert_eq!(a.key, b.key);
        assert!(a.forward);
        assert!(!b.forward);
        // vlan separates otherwise-identical tuples
        let c = FlowKey::normalized(6, ip(1), 50000, ip(2), 443, 10);
        assert_ne!(a.key, c.key);
    }

    #[test]
    fn capacity_evicts_least_recent() {
        let now = Instant::now();
        let mut t: FlowTable<u32, &str> = FlowTable::new(2, Duration::from_secs(120));
        t.insert(1, "one", now);
        t.insert(2, "two", now);
        // touch 1 so 2 becomes least-recent
        assert!(t.get_mut(&1, now).is_some());
        let evicted = t.insert(3, "three", now);
        assert_eq!(evicted, Some("two"));
        assert_eq!(t.len(), 2);
        assert_eq!(t.evicted_lru, 1);
        assert!(t.get_mut(&1, now).is_some());
        assert!(t.get_mut(&2, now).is_none());
    }

    #[test]
    fn idle_sweep_respects_touch() {
        let t0 = Instant::now();
        let mut t: FlowTable<u32, &str> = FlowTable::new(10, Duration::from_secs(120));
        t.insert(1, "stale", t0);
        t.insert(2, "touched", t0);

        let t1 = t0 + Duration::from_secs(100);
        assert!(t.get_mut(&2, t1).is_some()); // refresh 2's deadline

        let t2 = t0 + Duration::from_secs(121);
        let evicted = t.sweep(t2);
        assert_eq!(evicted, vec![(1, "stale")]);
        assert_eq!(t.evicted_idle, 1);
        assert_eq!(t.len(), 1);

        // 2 expires 120s after its touch
        let t3 = t1 + Duration::from_secs(120);
        assert_eq!(t.sweep(t3).len(), 1);
        assert!(t.is_empty());
    }

    #[test]
    fn sweep_on_fresh_table_is_noop() {
        let now = Instant::now();
        let mut t: FlowTable<u32, ()> = FlowTable::new(10, Duration::from_secs(120));
        t.insert(1, (), now);
        assert!(t.sweep(now).is_empty());
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn remove_returns_value() {
        let now = Instant::now();
        let mut t: FlowTable<u32, &str> = FlowTable::new(10, Duration::from_secs(1));
        t.insert(7, "gone", now);
        assert_eq!(t.remove(&7), Some("gone"));
        assert_eq!(t.remove(&7), None);
    }
}
