//! Daemon orchestration (Linux only).
//!
//! Wires together: N synchronous NFQUEUE worker threads (one per queue, each
//! owning an nDPI engine + private flow table), a tokio runtime hosting the
//! gRPC server + policy-reload watcher + status writer + watchdog, the
//! nftables table lifecycle, and graceful shutdown (remove rules first =
//! fail-open, then drain).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qfappd_core::catalog::Catalog;
use qfappd_core::config::{Config, FailMode};
use qfappd_core::ctmark::Layout;
use qfappd_core::policy::PolicyManager;
use qfappd_core::stats::StatsAggregator;

use crate::classify;
use crate::eventlog::EventWriter;
use crate::grpc;
use crate::nft;
use crate::worker::{Budgets, EventSink, PolicyHandle, WorkerCore};

/// Per-queue live counters, updated by the worker thread and read by GetStatus.
pub struct QueueCounter {
    pub queue_num: u16,
    pub packets: AtomicU64,
    pub drops: AtomicU64,
    pub flow_entries: AtomicU64,
}

/// State shared between the workers, the async services, and the gRPC API.
pub struct SharedState {
    pub catalog: Catalog,
    pub policy: PolicyHandle,
    pub policy_last_error: Arc<Mutex<Option<String>>>,
    pub stats: Vec<Arc<Mutex<StatsAggregator>>>,
    pub queue_counters: Vec<Arc<QueueCounter>>,
    pub event_drops: Arc<AtomicU64>,
    pub ndpi_version: String,
    pub fail_mode: FailMode,
    pub rate: Arc<Mutex<RateWindow>>,
}

impl SharedState {
    pub fn policy_last_error(&self) -> String {
        self.policy_last_error.lock().unwrap().clone().unwrap_or_default()
    }

    pub fn merged_stats(&self) -> StatsAggregator {
        let mut acc = StatsAggregator::default();
        for s in &self.stats {
            acc.merge(&s.lock().unwrap());
        }
        acc.event_sink_drops = self.event_drops.load(Ordering::Relaxed);
        acc
    }

    pub fn status_snapshot(&self) -> grpc::PbStatusMsg {
        let merged = self.merged_stats();
        let flow_entries: u64 = self.queue_counters.iter().map(|q| q.flow_entries.load(Ordering::Relaxed)).sum();
        let policy = self.policy.load();
        grpc::PbStatusMsg {
            qfappd_version: crate::VERSION.to_string(),
            ndpi_version: self.ndpi_version.clone(),
            policy_generation: policy.generation,
            policy_last_error: self.policy_last_error(),
            queues: self
                .queue_counters
                .iter()
                .map(|q| grpc::QueueStatusMsg {
                    queue_num: u32::from(q.queue_num),
                    packets: q.packets.load(Ordering::Relaxed),
                    drops: q.drops.load(Ordering::Relaxed),
                })
                .collect(),
            decisions: merged.decisions,
            blocked: merged.blocked,
            unknown_pct: merged.unknown_pct(),
            classification_rate_per_min: self.rate.lock().unwrap().per_min(merged.decisions),
            flowtable_entries: flow_entries,
            flowtable_lru_evictions: merged.flowtable_lru_evictions,
            flowtable_idle_evictions: merged.flowtable_idle_evictions,
            event_sink_drops: merged.event_sink_drops,
            fail_mode: match self.fail_mode {
                FailMode::Open => "open".into(),
                FailMode::Closed => "closed".into(),
            },
        }
    }
}

/// Sliding-window decision rate (last 60 s), sampled by the status task.
#[derive(Default)]
pub struct RateWindow {
    samples: std::collections::VecDeque<(Instant, u64)>,
}

impl RateWindow {
    pub fn per_min(&mut self, total_decisions: u64) -> u64 {
        let now = Instant::now();
        self.samples.push_back((now, total_decisions));
        while let Some(&(t, _)) = self.samples.front() {
            if now.duration_since(t) > Duration::from_secs(60) {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        match self.samples.front() {
            Some(&(_, oldest)) => total_decisions.saturating_sub(oldest),
            None => 0,
        }
    }
}

pub fn run(config: Config) -> anyhow::Result<()> {
    let layout = config.mark.layout()?;
    let n_queues = config.queues.count as usize;

    // Catalog once (its own short-lived engine). Workers get their own engines.
    let catalog = classify::new_classifier()?.catalog();
    let ndpi_version = catalog.ndpi_version.clone();
    tracing::info!(
        "loaded nDPI catalog: {} protocols (version {})",
        catalog.num_protocols,
        ndpi_version
    );

    // Publish the catalog once for the WebUI's app/category tree (unprivileged
    // read). Best-effort: a stale/missing file just falls back to the shipped
    // fixture in the UI.
    if !config.api.catalog_path.as_os_str().is_empty() {
        if let Some(parent) = config.api.catalog_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        match serde_json::to_string(&catalog) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&config.api.catalog_path, json) {
                    tracing::warn!("could not write catalog {}: {e}", config.api.catalog_path.display());
                }
            }
            Err(e) => tracing::warn!("catalog serialize failed: {e}"),
        }
    }

    // Initial policy: last-known-good semantics from the very first load.
    let mut mgr = PolicyManager::new();
    let initial = match mgr.load_path(&config.policy.path, &catalog, &layout) {
        Ok(p) => {
            tracing::info!("policy loaded: {} actions, {} bindings", p.actions.len(), p.bindings.len());
            for w in &p.warnings {
                tracing::warn!("policy: {w}");
            }
            p
        }
        Err(e) => {
            tracing::warn!("no valid policy at startup ({e}); running with empty policy (all traffic passes) until a valid one is pushed");
            mgr.current()
        }
    };
    let policy = PolicyHandle::new(initial.clone());
    let policy_last_error = Arc::new(Mutex::new(mgr.last_error().map(str::to_owned)));

    // Install our nftables table (fast paths + bindings). Fatal if it fails —
    // without it nothing is enforced.
    nft::install_table(&config, &layout, &initial.bindings)?;
    tracing::info!("installed nftables table `inet qfappd`");

    // Shared per-worker state.
    let event_writer = Arc::new(EventWriter::new(&config.events)?);
    let event_drops = event_writer.drops();
    let mut stats = Vec::with_capacity(n_queues);
    let mut queue_counters = Vec::with_capacity(n_queues);
    for i in 0..n_queues {
        stats.push(Arc::new(Mutex::new(StatsAggregator::default())));
        queue_counters.push(Arc::new(QueueCounter {
            queue_num: config.queues.start + i as u16,
            packets: AtomicU64::new(0),
            drops: AtomicU64::new(0),
            flow_entries: AtomicU64::new(0),
        }));
    }

    let state = Arc::new(SharedState {
        catalog: catalog.clone(),
        policy: policy.clone(),
        policy_last_error: policy_last_error.clone(),
        stats: stats.clone(),
        queue_counters: queue_counters.clone(),
        event_drops,
        ndpi_version,
        fail_mode: config.queues.fail_mode,
        rate: Arc::new(Mutex::new(RateWindow::default())),
    });

    let shutdown = Arc::new(AtomicBool::new(false));
    let fail_open = config.queues.fail_mode == FailMode::Open;

    // Spawn the synchronous worker threads.
    let mut handles = Vec::new();
    let app_name = make_app_name(&catalog);
    for i in 0..n_queues {
        let core = build_worker_core(&config, &layout, &policy, &stats[i], &event_writer, &app_name)?;
        let counter = queue_counters[i].clone();
        let shutdown = shutdown.clone();
        let queue_num = config.queues.start + i as u16;
        let handle = std::thread::Builder::new()
            .name(format!("qfappd-q{queue_num}"))
            .spawn(move || {
                if let Err(e) = run_queue(queue_num, core, counter, shutdown, fail_open) {
                    tracing::error!("queue {queue_num} worker exited: {e}");
                }
            })?;
        handles.push(handle);
    }

    // Async services on a tokio runtime.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;

    let async_result = rt.block_on(async_main(
        config.clone(),
        layout,
        catalog.clone(),
        policy.clone(),
        policy_last_error.clone(),
        state.clone(),
        shutdown.clone(),
    ));

    // Graceful shutdown: rules are already gone (async_main removes them on
    // signal → fail-open); now drain workers.
    shutdown.store(true, Ordering::SeqCst);
    for h in handles {
        let _ = h.join();
    }
    tracing::info!("qfappd stopped");
    async_result
}

fn build_worker_core(
    config: &Config,
    layout: &Layout,
    policy: &PolicyHandle,
    stats: &Arc<Mutex<StatsAggregator>>,
    event_writer: &Arc<EventWriter>,
    app_name: &Arc<dyn Fn(u16) -> (String, String) + Send + Sync>,
) -> anyhow::Result<WorkerCore> {
    let engine = classify::new_classifier()?;
    let table = qfappd_core::flowtable::FlowTable::new(
        (config.flow_table.max_entries / config.queues.count.max(1) as usize).max(1),
        Duration::from_secs(config.flow_table.idle_timeout_secs),
    );
    let sink: Arc<dyn EventSink> = event_writer.clone();
    Ok(WorkerCore {
        engine,
        table,
        layout: *layout,
        budgets: Budgets {
            max_packets: u64::from(config.classify.max_packets),
            max_payload_bytes: u64::from(config.classify.max_payload_bytes),
        },
        sink,
        stats: stats.clone(),
        app_name: app_name.clone(),
        policy: policy.clone(),
    })
}

fn make_app_name(catalog: &Catalog) -> Arc<dyn Fn(u16) -> (String, String) + Send + Sync> {
    let c = catalog.clone();
    Arc::new(move |id| {
        (
            c.app_name(id).unwrap_or("Unknown").to_string(),
            c.category_of(id).unwrap_or("").to_string(),
        )
    })
}

#[allow(clippy::too_many_arguments)]
async fn async_main(
    config: Config,
    layout: Layout,
    catalog: Catalog,
    policy: PolicyHandle,
    policy_last_error: Arc<Mutex<Option<String>>>,
    state: Arc<SharedState>,
    shutdown: Arc<AtomicBool>,
) -> anyhow::Result<()> {
    use tokio::signal::unix::{signal, SignalKind};

    // Notify systemd we're up, and start pinging the watchdog.
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Ready]);
    spawn_watchdog();

    // Policy reload: inotify on the policy file + SIGHUP, both → reload.
    spawn_policy_reload(config.clone(), layout, catalog, policy.clone(), policy_last_error.clone());

    // Periodic status.json for unprivileged readers (WebUI fallback path).
    spawn_status_writer(config.clone(), state.clone());

    // Serve gRPC until we get SIGTERM/SIGINT.
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let grpc_state = state.clone();
    let grpc_sock = config.api.socket_path.clone();
    let grpc_task = tokio::spawn(async move {
        let _ = grpc::serve(grpc_state, grpc_sock, async {
            let _ = stop_rx.await;
        })
        .await;
    });

    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = sigterm.recv() => tracing::info!("SIGTERM received"),
        _ = sigint.recv() => tracing::info!("SIGINT received"),
    }

    // Fail-open FIRST: drop the nft table so no new packets are queued, then
    // let workers drain their in-flight packets and exit.
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Stopping]);
    if let Err(e) = nft::teardown() {
        tracing::warn!("nft teardown failed: {e}");
    } else {
        tracing::info!("removed nftables table (fail-open)");
    }
    shutdown.store(true, Ordering::SeqCst);
    let _ = stop_tx.send(());
    let _ = grpc_task.await;
    Ok(())
}

fn spawn_watchdog() {
    let mut usec = 0u64;
    if sd_notify::watchdog_enabled(false, &mut usec) && usec > 0 {
        let interval = Duration::from_micros(usec / 2);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            loop {
                tick.tick().await;
                let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Watchdog]);
            }
        });
    }
}

fn spawn_policy_reload(
    config: Config,
    layout: Layout,
    catalog: Catalog,
    policy: PolicyHandle,
    last_error: Arc<Mutex<Option<String>>>,
) {
    use tokio::signal::unix::{signal, SignalKind};

    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(8);

        // inotify via the `notify` crate on the policy file's directory.
        let watch_tx = tx.clone();
        let watch_path = config.policy.path.clone();
        let _watcher = spawn_inotify(watch_path, watch_tx);

        // SIGHUP → reload too.
        let hup_tx = tx.clone();
        tokio::spawn(async move {
            if let Ok(mut hup) = signal(SignalKind::hangup()) {
                loop {
                    if hup.recv().await.is_none() {
                        break;
                    }
                    let _ = hup_tx.send(()).await;
                }
            }
        });

        let mut mgr = PolicyManager::new();
        // Re-seed the manager's generation to match the already-loaded policy
        // so generations keep climbing monotonically.
        let _ = mgr.load_path(&config.policy.path, &catalog, &layout);

        while rx.recv().await.is_some() {
            // Debounce bursts (editors/atomic renames emit several events).
            tokio::time::sleep(Duration::from_millis(100)).await;
            while rx.try_recv().is_ok() {}

            match mgr.load_path(&config.policy.path, &catalog, &layout) {
                Ok(p) => {
                    tracing::info!("policy reloaded (gen {}): {} actions, {} bindings", p.generation, p.actions.len(), p.bindings.len());
                    for w in &p.warnings {
                        tracing::warn!("policy: {w}");
                    }
                    // Bindings changed → refresh the nft chain atomically.
                    if let Err(e) = nft::reload_bindings(&config, &layout, &p.bindings) {
                        tracing::error!("nft bindings reload failed: {e}");
                        *last_error.lock().unwrap() = Some(format!("nft reload failed: {e}"));
                        continue;
                    }
                    policy.store(p);
                    *last_error.lock().unwrap() = None;
                }
                Err(e) => {
                    tracing::error!("policy reload rejected, keeping last-known-good: {e}");
                    *last_error.lock().unwrap() = Some(e.to_string());
                }
            }
        }
    });
}

fn spawn_inotify(
    path: std::path::PathBuf,
    tx: tokio::sync::mpsc::Sender<()>,
) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};

    // Watch the parent dir: atomic writes (rename-into-place) replace the
    // inode, which a file-level watch would miss.
    let dir = path.parent().map(|p| p.to_owned()).unwrap_or_else(|| ".".into());
    let target = path.clone();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p == &target) || ev.paths.is_empty() {
                let _ = tx.blocking_send(());
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("inotify unavailable ({e}); relying on SIGHUP for policy reload");
            return None;
        }
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        tracing::warn!("failed to watch {}: {e}; relying on SIGHUP", dir.display());
        return None;
    }
    Some(watcher)
}

fn spawn_status_writer(config: Config, state: Arc<SharedState>) {
    if config.api.status_path.as_os_str().is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(config.api.status_interval_secs.max(1)));
        loop {
            tick.tick().await;
            let snapshot = state.status_snapshot();
            if let Ok(json) = serde_json::to_string(&StatusJson::from(&snapshot)) {
                let tmp = config.api.status_path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, &config.api.status_path);
                }
            }
        }
    });
}

/// Flat JSON mirror of the gRPC Status for the WebUI status.json fallback
/// (same idea as quartzfire-ips status.json).
#[derive(serde::Serialize)]
struct StatusJson {
    qfappd_version: String,
    ndpi_version: String,
    policy_generation: u64,
    policy_last_error: String,
    decisions: u64,
    blocked: u64,
    unknown_pct: f64,
    classification_rate_per_min: u64,
    flowtable_entries: u64,
    event_sink_drops: u64,
    fail_mode: String,
    queues: Vec<QueueJson>,
}

#[derive(serde::Serialize)]
struct QueueJson {
    queue_num: u32,
    packets: u64,
    drops: u64,
}

impl From<&grpc::PbStatusMsg> for StatusJson {
    fn from(s: &grpc::PbStatusMsg) -> Self {
        Self {
            qfappd_version: s.qfappd_version.clone(),
            ndpi_version: s.ndpi_version.clone(),
            policy_generation: s.policy_generation,
            policy_last_error: s.policy_last_error.clone(),
            decisions: s.decisions,
            blocked: s.blocked,
            unknown_pct: s.unknown_pct,
            classification_rate_per_min: s.classification_rate_per_min,
            flowtable_entries: s.flowtable_entries,
            event_sink_drops: s.event_sink_drops,
            fail_mode: s.fail_mode.clone(),
            queues: s
                .queues
                .iter()
                .map(|q| QueueJson { queue_num: q.queue_num, packets: q.packets, drops: q.drops })
                .collect(),
        }
    }
}

/// One NFQUEUE worker loop. Synchronous; owns its `WorkerCore`.
fn run_queue(
    queue_num: u16,
    mut core: WorkerCore,
    counter: Arc<QueueCounter>,
    shutdown: Arc<AtomicBool>,
    fail_open: bool,
) -> anyhow::Result<()> {
    use nfq::{Queue, Verdict};

    let mut queue = Queue::open()?;
    queue.bind(queue_num)?;
    // Copy the whole packet so nDPI sees full payloads.
    queue.set_copy_range(queue_num, 0xffff)?;
    queue.set_fail_open(queue_num, fail_open)?;
    // Non-blocking recv so we can observe the shutdown flag promptly.
    queue.set_nonblocking(true);

    let mut last_sweep = Instant::now();
    tracing::info!("queue {queue_num} worker started (fail-{})", if fail_open { "open" } else { "closed" });

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let mut msg = match queue.recv() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
                maybe_sweep(&mut core, &counter, &mut last_sweep);
                continue;
            }
            Err(e) => {
                tracing::error!("queue {queue_num} recv error: {e}");
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };

        counter.packets.fetch_add(1, Ordering::Relaxed);
        let now = Instant::now();
        let now_ms = now.duration_since(core_epoch()).as_millis() as u64;
        let mark = msg.get_nfmark();
        let in_iface = if_index_name(msg.get_indev());
        let outcome = core.handle_packet(mark, msg.get_payload(), &in_iface, 0, now, now_ms);

        // Always ACCEPT: a block is enforced by the nftables qfappd-block rule,
        // which drops the reinjected verdict packet once its mark carries the
        // BLOCK bit. Setting the packet mark is what lets nftables persist the
        // verdict into the ct mark and drop the flow.
        if let Some(new_mark) = outcome.set_mark {
            msg.set_nfmark(new_mark);
        }
        msg.set_verdict(Verdict::Accept);
        if let Err(e) = queue.verdict(msg) {
            tracing::warn!("queue {queue_num} verdict error: {e}");
        }

        if let Some(reset_pair) = outcome.reset {
            send_reset(&reset_pair);
        }
        if outcome.blocked {
            tracing::trace!("queue {queue_num} blocked a flow");
        }

        counter.flow_entries.store(core.table.len() as u64, Ordering::Relaxed);
        maybe_sweep(&mut core, &counter, &mut last_sweep);
    }

    tracing::info!("queue {queue_num} worker draining");
    Ok(())
}

fn maybe_sweep(core: &mut WorkerCore, counter: &QueueCounter, last: &mut Instant) {
    if last.elapsed() >= Duration::from_secs(10) {
        core.sweep(Instant::now());
        counter.flow_entries.store(core.table.len() as u64, Ordering::Relaxed);
        *last = Instant::now();
    }
}

/// A per-process monotonic epoch for nDPI packet timestamps.
fn core_epoch() -> Instant {
    use std::sync::OnceLock;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn if_index_name(idx: u32) -> String {
    if idx == 0 {
        return String::new();
    }
    let mut buf = [0u8; libc::IF_NAMESIZE];
    let p = unsafe { libc::if_indextoname(idx, buf.as_mut_ptr() as *mut libc::c_char) };
    if p.is_null() {
        return String::new();
    }
    unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

/// RST sender is thread-local: one raw socket per worker, opened on first use.
fn send_reset(pair: &crate::reset::ResetPair) {
    thread_local! {
        static SENDER: std::cell::RefCell<Option<crate::reset::RstSender>> = const { std::cell::RefCell::new(None) };
    }
    SENDER.with(|s| {
        let mut slot = s.borrow_mut();
        if slot.is_none() {
            match crate::reset::RstSender::new() {
                Ok(snd) => *slot = Some(snd),
                Err(e) => {
                    tracing::warn!("RST sender unavailable: {e}");
                    return;
                }
            }
        }
        if let Some(snd) = slot.as_ref() {
            if let Err(e) = snd.send(pair) {
                tracing::debug!("RST send failed: {e}");
            }
        }
    });
}
