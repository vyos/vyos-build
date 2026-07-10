"use client";

// Traffic Monitor — a live, WatchGuard-style view of traffic and the firewall
// rule (policy) each connection hit. The backend follows the kernel journal
// and streams parsed firewall log entries over SSE (/api/monitor/firewall-log);
// this page renders them and maps rule numbers back to the friendly rule names
// from the firewall config.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eraser, Pause, Play, RotateCw, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import {
  emptyFirewallConfig,
  enableTrafficLogging,
  fetchFirewall,
  FirewallConfig,
  loggingStatus,
  RuleChain,
} from "@/lib/firewall";
import { useDashboard } from "@/lib/DashboardContext";

/// One SSE payload from the backend (see backend/src/monitor.rs LogEntry).
interface MonitorEntry {
  ts: number;
  family: string;
  chain: RuleChain;
  /** Rule number; null = the chain's default action fired. */
  rule: number | null;
  action: "accept" | "drop" | "reject";
  /** True when the rule queues matches to the IPS engine (Allow with IPS on). */
  ips: boolean;
  in?: string;
  out?: string;
  src?: string;
  dst?: string;
  proto?: string;
  spt?: number;
  dpt?: number;
  len?: number;
  icmp_type?: number;
}

/// Entry plus a client-side id for stable React keys.
type Row = MonitorEntry & { id: number };

const MAX_ROWS = 500;

/// Protocols with their own filter entry; everything else falls under Other.
const KNOWN_PROTOS = ["tcp", "udp", "icmp"];

function ActionPill({ action }: { action: Row["action"] }) {
  if (action === "accept") return <span className="badge badge-ok">Allow</span>;
  if (action === "drop") return <span className="badge badge-crit">Deny</span>;
  return <span className="badge badge-warn">Reject</span>;
}

const dash = <span className="text-[var(--qz-fg-4)]">—</span>;

export default function TrafficMonitorPage() {
  const { setToast } = useDashboard();

  // ── firewall config (rule names + logging status) ───────────────────────────
  const [config, setConfig] = useState<FirewallConfig>(emptyFirewallConfig);
  const [configState, setConfigState] = useState<"loading" | "ready" | "error">("loading");
  const [enabling, setEnabling] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetchFirewall());
      setConfigState("ready");
    } catch {
      setConfigState("error"); // names/banner degrade; the stream still works
    }
  }, []);

  useEffect(() => {
    loadConfig();
    // Rule numbers change when rules are reordered, recreated, or deleted —
    // a mapping fetched only at mount would then caption new log lines with
    // the wrong rule name. Refresh it periodically and when the tab regains
    // focus. (Backfilled lines older than the last renumber can still carry
    // pre-renumber numbers; only live labels can be kept honest.)
    const refetch = () => {
      if (!document.hidden) loadConfig();
    };
    const timer = setInterval(refetch, 30_000);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [loadConfig]);

  const logging = useMemo(() => loggingStatus(config), [config]);
  const ruleNames = useMemo(
    () => new Map(config.rules.map((r) => [`${r.chain}:${r.rule}`, r.name])),
    [config.rules],
  );

  const enableLogging = async () => {
    setEnabling(true);
    try {
      const n = await enableTrafficLogging(config);
      setToast(
        n === 0
          ? "Traffic logging is already fully enabled."
          : `Enabled traffic logging (${n} change${n === 1 ? "" : "s"}).`,
      );
      await loadConfig();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to enable traffic logging.");
    } finally {
      setEnabling(false);
    }
  };

  // ── live stream ─────────────────────────────────────────────────────────────
  // Entries accumulate in a ref (newest first) and render as soon as they
  // arrive: the first entry after a quiet spell flushes immediately, and a
  // burst then batches into one render per FLUSH_MS so a busy firewall doesn't
  // force a render per packet. Pausing stops the flush, not the collection —
  // resume shows what happened meanwhile.
  const rowsRef = useRef<Row[]>([]);
  const dirtyRef = useRef(false);
  const nextId = useRef(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  // Bumped by the Refresh button to tear down and reopen the stream (a fresh
  // connection re-backfills from the journal).
  const [streamGen, setStreamGen] = useState(0);

  const FLUSH_MS = 75;

  useEffect(() => {
    const es = new EventSource("/api/monitor/firewall-log");
    es.onopen = () => setStream("live");
    es.onerror = () => setStream("reconnecting"); // EventSource retries itself
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!dirtyRef.current || pausedRef.current) return;
      dirtyRef.current = false;
      setRows(rowsRef.current);
    };
    const scheduleFlush = () => {
      if (throttle) return; // burst in progress — the trailing flush covers it
      flush();
      throttle = setTimeout(() => {
        throttle = null;
        flush();
      }, FLUSH_MS);
    };
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data) as MonitorEntry;
        rowsRef.current = [{ ...entry, id: nextId.current++ }, ...rowsRef.current].slice(0, MAX_ROWS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event rather than killing the stream
      }
    };
    return () => {
      if (throttle) clearTimeout(throttle);
      es.close();
    };
  }, [streamGen]);

  const togglePause = () => {
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows(rowsRef.current); // resuming — catch up immediately
      return !p;
    });
  };

  const clear = () => {
    rowsRef.current = [];
    dirtyRef.current = false;
    setRows([]);
  };

  /// Start over: drop the table, reconnect the stream (which re-backfills
  /// from the journal), and re-read rule names.
  const refresh = () => {
    clear();
    setStream("connecting");
    setStreamGen((g) => g + 1);
    loadConfig();
  };

  // ── filters ─────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | "accept" | "blocked">("all");
  const [protoFilter, setProtoFilter] = useState("all");
  const [ifaceFilter, setIfaceFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");

  const ruleLabel = useCallback(
    (r: Row): string => {
      if (r.rule === null) return "Default action";
      return ruleNames.get(`${r.chain}:${r.rule}`) ?? `Rule ${r.rule}`;
    },
    [ruleNames],
  );

  // Interfaces offered in the filter: whatever the entries have actually seen
  // (plus the current selection, so it can't silently vanish).
  const ifaceOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.in) seen.add(r.in);
      if (r.out) seen.add(r.out);
    }
    if (ifaceFilter !== "all") seen.add(ifaceFilter);
    return [...seen].sort();
  }, [rows, ifaceFilter]);

  const ruleOptions = useMemo(
    () =>
      config.rules.map((r) => ({
        value: `${r.chain}:${r.rule}`,
        label: r.name ?? `Rule ${r.rule}`,
      })),
    [config.rules],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter === "accept" && r.action !== "accept") return false;
      if (actionFilter === "blocked" && r.action === "accept") return false;
      if (protoFilter !== "all") {
        const p = r.proto ?? "";
        if (protoFilter === "other" ? KNOWN_PROTOS.includes(p) : p !== protoFilter) return false;
      }
      if (ifaceFilter !== "all" && r.in !== ifaceFilter && r.out !== ifaceFilter) return false;
      if (ruleFilter !== "all") {
        if (ruleFilter === "default" ? r.rule !== null : `${r.chain}:${r.rule}` !== ruleFilter) return false;
      }
      if (!q) return true;
      const hay = [ruleLabel(r), r.src, r.dst, r.spt, r.dpt, r.proto, r.in, r.out, r.chain, r.action]
        .filter((v) => v != null && v !== "")
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, q, actionFilter, protoFilter, ifaceFilter, ruleFilter, ruleLabel]);

  const time = (ts: number) =>
    ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : "—";

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Traffic Monitor
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Live traffic and the firewall rule each connection hit — one entry per new connection
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div className="flex flex-col gap-3">
          {/* Logging setup banner */}
          {configState === "ready" && !logging.complete && (
            <div
              className="flex items-center gap-3 px-3 py-2 rounded-md flex-wrap"
              style={{
                background: "var(--qz-accent-soft)",
                border: "1px solid color-mix(in oklab, var(--qz-accent) 30%, transparent)",
              }}
            >
              <AlertTriangle size={15} className="text-[var(--qz-fg-2)] flex-shrink-0" />
              <span className="text-[13px] text-[var(--qz-fg-1)]">
                {logging.total_rules === 0 && logging.chains_without_default_log.length === 3
                  ? "Traffic logging is off — nothing will appear here until it's enabled."
                  : `Logging is only partially enabled (${logging.logged_rules} of ${logging.total_rules} rules) — some traffic won't appear here.`}
              </span>
              <div className="ml-auto">
                <Button kind="primary" size="sm" onClick={enableLogging} disabled={enabling}>
                  {enabling ? "Enabling…" : "Enable logging"}
                </Button>
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter traffic…"
                className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
                style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
                onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
              />
            </div>

            <Segmented
              items={[
                { value: "all", label: "All" },
                { value: "accept", label: "Allowed" },
                { value: "blocked", label: "Blocked" },
              ]}
              value={actionFilter}
              onChange={(v) => setActionFilter(v as typeof actionFilter)}
            />

            <select
              value={protoFilter}
              onChange={(e) => setProtoFilter(e.target.value)}
              title="Filter by protocol"
              className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <option value="all">All protocols</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="icmp">ICMP</option>
              <option value="other">Other</option>
            </select>

            <select
              value={ifaceFilter}
              onChange={(e) => setIfaceFilter(e.target.value)}
              title="Filter by interface (matches either side)"
              className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <option value="all">All interfaces</option>
              {ifaceOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>

            <select
              value={ruleFilter}
              onChange={(e) => setRuleFilter(e.target.value)}
              title="Filter by the rule that fired"
              className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)", maxWidth: 220 }}
            >
              <option value="all">All rules</option>
              <option value="default">Default action</option>
              {ruleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-3">
              <Button kind="secondary" size="sm" icon={RotateCw} onClick={refresh}>
                Refresh
              </Button>
              <Button kind="secondary" size="sm" icon={paused ? Play : Pause} onClick={togglePause}>
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button kind="secondary" size="sm" icon={Eraser} onClick={clear}>
                Clear
              </Button>
              <span className="inline-flex items-center gap-[6px] text-[12px] text-[var(--qz-fg-4)]">
                <span
                  className="inline-block w-[7px] h-[7px] rounded-full"
                  style={{
                    background: paused
                      ? "var(--qz-fg-4)"
                      : stream === "live"
                        ? "var(--qz-success)"
                        : "var(--qz-warn)",
                  }}
                />
                {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
                {" · "}
                {visible.length} {visible.length === 1 ? "entry" : "entries"}
              </span>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
            <table className="qz-table" style={{ width: "100%" }}>
              <colgroup>
                <col style={{ width: 90 }} />
                <col style={{ width: 100 }} />
                <col />
                <col />
                <col style={{ width: 70 }} />
                <col />
                <col style={{ width: 70 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 140 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Rule</th>
                  <th>Source</th>
                  <th>Port</th>
                  <th>Destination</th>
                  <th>Port</th>
                  <th>Protocol</th>
                  <th>Interface</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                      {rows.length === 0
                        ? "Waiting for traffic… (only logged rules and default-log traffic appear here)"
                        : "No entries match the filter."}
                    </td>
                  </tr>
                ) : (
                  visible.map((r) => (
                    <tr key={r.id} style={{ cursor: "default" }}>
                      <td className="mono text-[var(--qz-fg-3)]">{time(r.ts)}</td>
                      <td>
                        <span className="inline-flex items-center gap-[5px]">
                          <ActionPill action={r.action} />
                          {r.ips && (
                            <span className="badge badge-warn" title="Inspected by the IPS engine">
                              IPS
                            </span>
                          )}
                        </span>
                      </td>
                      <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Link
                          href="/firewall/rules"
                          className="no-underline text-[var(--qz-fg-1)] hover:text-[var(--qz-accent)]"
                          title={r.rule === null ? `${r.chain} default action` : `${r.chain} rule ${r.rule}`}
                        >
                          {ruleLabel(r)}
                        </Link>
                        {r.chain !== "forward" && (
                          <span className="text-[11px] text-[var(--qz-fg-4)]"> · {r.chain}</span>
                        )}
                      </td>
                      <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.src ?? dash}
                      </td>
                      <td className="mono">{r.spt ?? dash}</td>
                      <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.dst ?? dash}
                      </td>
                      <td className="mono">{r.dpt ?? dash}</td>
                      <td className="mono">
                        {r.proto ?? "—"}
                        {r.proto === "icmp" && r.icmp_type != null && (
                          <span className="text-[var(--qz-fg-4)]"> t{r.icmp_type}</span>
                        )}
                      </td>
                      <td className="mono text-[var(--qz-fg-3)]">
                        {r.in ?? "—"}
                        {r.out ? ` → ${r.out}` : ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
            Entries stream from the firewall&apos;s kernel log; the newest {MAX_ROWS} are kept. Each rule&apos;s
            logging can be toggled individually when editing it under{" "}
            <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
              Rules
            </Link>
            .
          </p>

          {configState === "error" && (
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-fg-4)]">
              <AlertTriangle size={14} />
              Couldn&apos;t read the firewall config — rule names are unavailable.
              <Button kind="secondary" size="sm" icon={RotateCw} onClick={loadConfig}>
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
