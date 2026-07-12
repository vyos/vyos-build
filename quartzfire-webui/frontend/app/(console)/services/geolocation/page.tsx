"use client";

// Geolocation — WatchGuard-style country filtering on top of IPFire libloc.
//
// Actions tab: named, reusable country policies (block-listed / allow-listed
// + unknown-IP handling + logging). Policies tab: which firewall rules each
// action attaches to, with direction and an inline enable toggle. Both are
// real VyOS config (`service geolocation …`) edited under commit-confirm.
// The status card covers the database side: version, signed updates,
// "Update now", and the IP → country lookup utility.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eraser, Pause, Pencil, Play, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useDashboard } from "@/lib/DashboardContext";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig, FirewallRule } from "@/lib/firewall";
import {
  actionUsage,
  applyGeoAction,
  applyGeoPolicy,
  blockedIp,
  countryName,
  deleteGeoAction,
  deleteGeoPolicy,
  emptyGeolocationConfig,
  fetchGeoAlertHistory,
  fetchGeoCountries,
  fetchGeolocation,
  fetchGeoStatus,
  flagEmoji,
  GEO_DIRECTION_LABEL,
  GEO_MODE_LABEL,
  GeoAction,
  GeoCountries,
  GeoDirection,
  GeoEvent,
  geoEventKey,
  GeolocationConfig,
  geoLookup,
  GeoLookupResult,
  GeoPolicy,
  GeoStatus,
  nextPolicyId,
  requestGeoUpdate,
} from "@/lib/geolocation";
import { ActionFormModal } from "./ActionFormModal";

type Tab = "actions" | "policies" | "alerts";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const dash = <span className="text-[var(--qz-fg-4)]">—</span>;

const time = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString(undefined, { hour12: false }) : "never";

// ── status card ───────────────────────────────────────────────────────────────

function LookupTool() {
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GeoLookupResult | null>(null);

  const run = async () => {
    if (!ip.trim()) return;
    setBusy(true);
    try {
      setResult(await geoLookup(ip));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Lookup failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative">
        <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Check an IP…"
          className="rounded-md pl-8 pr-3 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[190px] mono"
          style={inputStyle}
        />
      </div>
      <Button kind="secondary" size="sm" onClick={run} disabled={busy}>
        {busy ? "Looking up…" : "Lookup"}
      </Button>
      {result &&
        (result.error ? (
          <span className="text-[12px] text-[var(--qz-danger)]">{result.error}</span>
        ) : result.country ? (
          <span className="text-[13px] text-[var(--qz-fg-1)]">
            {flagEmoji(result.country)} {result.country_name ?? result.country}
            <span className="text-[var(--qz-fg-4)] mono text-[12px]"> · {result.network}</span>
          </span>
        ) : (
          <span className="text-[13px] text-[var(--qz-fg-3)]">
            Not in the database (unclassified).
          </span>
        ))}
    </div>
  );
}

function StatusCard({
  status,
  onRefresh,
}: {
  status: GeoStatus | null;
  onRefresh: () => void;
}) {
  const { setToast } = useDashboard();
  const [updating, setUpdating] = useState(false);
  const report = status?.status ?? null;
  const db = report?.db ?? null;
  const update = report?.update ?? null;

  const updateNow = async () => {
    setUpdating(true);
    try {
      await requestGeoUpdate();
      setToast("Database update requested — this can take a minute or two.");
      setTimeout(onRefresh, 3000);
      setTimeout(onRefresh, 15000);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to request a database update.");
    } finally {
      setUpdating(false);
    }
  };

  const item = (label: string, value: React.ReactNode) => (
    <div className="flex flex-col gap-[2px]">
      <span className="text-[11px] uppercase tracking-wide text-[var(--qz-fg-4)]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)]">{value}</span>
    </div>
  );

  return (
    <section
      className="rounded-lg px-5 py-4 flex flex-col gap-3"
      style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
    >
      <div className="flex items-center gap-5 flex-wrap">
        {item(
          "Location database",
          db?.present ? (
            <>
              {time(db.version)}{" "}
              {db.signature_ok === false ? (
                <span className="badge badge-crit">Signature invalid</span>
              ) : (
                <span className="badge badge-ok">Signed</span>
              )}
            </>
          ) : (
            <span className="badge badge-warn">Not downloaded yet</span>
          ),
        )}
        {item(
          "Last update",
          update ? (
            update.ok ? (
              time(update.time)
            ) : (
              <span className="text-[var(--qz-danger)]" title={update.message ?? undefined}>
                failed {time(update.time)}
              </span>
            )
          ) : (
            "never"
          ),
        )}
        {item("Schedule", update?.schedule === "daily" ? "Daily (automatic)" : "Daily after first boot")}
        <div className="ml-auto flex items-center gap-2">
          <Button kind="secondary" size="sm" icon={RotateCw} onClick={onRefresh}>
            Refresh
          </Button>
          <Button kind="primary" size="sm" onClick={updateNow} disabled={updating}>
            {updating ? "Requesting…" : "Update now"}
          </Button>
        </div>
      </div>
      {update && !update.ok && update.message && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--qz-danger)]">
          <AlertTriangle size={13} /> {update.message} — the previously downloaded database (if
          any) keeps enforcing.
        </div>
      )}
      <LookupTool />
    </section>
  );
}

// ── Actions tab ───────────────────────────────────────────────────────────────

function ActionsTab({
  config,
  countries,
  status,
  onChanged,
}: {
  config: GeolocationConfig;
  countries: GeoCountries;
  status: GeoStatus | null;
  onChanged: () => void;
}) {
  const { setToast } = useDashboard();
  const [editing, setEditing] = useState<GeoAction | null>(null);
  const [creating, setCreating] = useState(false);

  const hits = status?.counters?.actions ?? {};

  const summarize = (a: GeoAction) => {
    if (a.countries.length === 0) {
      return a.mode === "block-listed" ? "all countries allowed" : "none — blocks everything";
    }
    const names = a.countries.slice(0, 3).map((c) => countryName(countries.countries, c));
    const more = a.countries.length - names.length;
    return names.join(", ") + (more > 0 ? ` +${more} more` : "");
  };

  const save = async (u: Parameters<typeof applyGeoAction>[2]) => {
    try {
      await applyGeoAction(config.actions, config.policies, u);
      setToast("Geolocation action saved — confirm the change in the banner.");
      setEditing(null);
      setCreating(false);
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to save the action.");
    }
  };

  const remove = async (a: GeoAction) => {
    const uses = actionUsage(config.policies, a.name);
    if (uses.length > 0) {
      setToast(
        `"${a.name}" is used by polic${uses.length === 1 ? "y" : "ies"} ${uses.join(", ")} — delete or repoint them first.`,
      );
      return;
    }
    if (!window.confirm(`Delete geolocation action "${a.name}"?`)) return;
    try {
      await deleteGeoAction(a.name);
      setToast("Action deleted — confirm the change in the banner.");
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to delete the action.");
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1050px]">
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-[var(--qz-fg-4)] m-0 flex-1">
          An action is a reusable country policy — block the listed countries, or only allow
          them. Attach actions to firewall rules on the Policies tab.
        </p>
        <Button
          kind="primary"
          size="sm"
          icon={Plus}
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          Add action
        </Button>
      </div>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 180 }} />
            <col style={{ width: 210 }} />
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Action</th>
              <th>Mode</th>
              <th>Countries</th>
              <th>Unknown IPs</th>
              <th>Log</th>
              <th>Policies</th>
              <th>Blocked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {config.actions.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  No actions yet — add one to get started.
                </td>
              </tr>
            ) : (
              config.actions.map((a) => {
                const uses = actionUsage(config.policies, a.name).length;
                const hit = hits[a.name];
                return (
                  <tr key={a.name} style={{ cursor: "pointer" }} onClick={() => { setCreating(false); setEditing(a); }}>
                    <td className="font-semibold text-[var(--qz-fg-1)]">{a.name}</td>
                    <td className="text-[var(--qz-fg-3)]">{a.mode ? GEO_MODE_LABEL[a.mode] : "(mode not set)"}</td>
                    <td className="text-[var(--qz-fg-3)]" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.countries.length > 0 ? `${a.countries.length} — ` : ""}{summarize(a)}
                    </td>
                    <td>
                      {a.unknownIp === "block" ? (
                        <span className="badge badge-crit">Block</span>
                      ) : (
                        <span className="badge badge-muted">Allow</span>
                      )}
                    </td>
                    <td>{a.log ? <span className="badge badge-ok">On</span> : dash}</td>
                    <td className="mono text-[var(--qz-fg-3)]">{uses > 0 ? uses : dash}</td>
                    <td className="mono text-[var(--qz-fg-3)]" title={hit ? `${hit.bytes} bytes` : undefined}>
                      {hit && hit.packets > 0 ? `${hit.packets} pkts` : dash}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          className="icon-btn"
                          title="Edit"
                          onClick={() => { setCreating(false); setEditing(a); }}
                          style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--qz-fg-3)" }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-btn"
                          title={uses > 0 ? "In use by policies — detach first" : "Delete"}
                          disabled={uses > 0}
                          onClick={() => remove(a)}
                          style={{
                            background: "transparent",
                            border: 0,
                            cursor: uses > 0 ? "not-allowed" : "pointer",
                            color: uses > 0 ? "var(--qz-fg-4)" : "var(--qz-danger)",
                            opacity: uses > 0 ? 0.5 : 1,
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <ActionFormModal
          initial={editing}
          countries={countries.countries}
          countriesAvailable={countries.available}
          existingNames={config.actions.map((a) => a.name)}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSave={save}
        />
      )}
    </div>
  );
}

// ── Policies tab ──────────────────────────────────────────────────────────────

/// Interface/group/address a firewall rule side resolves to, for the From → To
/// column (mirrors the Application Control policies table).
function endpoint(side: { iface?: string | null; group_name?: string | null; address?: string | null }): string {
  return side.iface ?? side.group_name ?? side.address ?? "any";
}

const CHAIN_LABEL: Record<string, string> = { forward: "Forward", input: "Input", output: "Output" };

function PoliciesTab({
  config,
  status,
  onChanged,
}: {
  config: GeolocationConfig;
  status: GeoStatus | null;
  onChanged: () => void;
}) {
  const { setToast } = useDashboard();
  const [fw, setFw] = useState<FirewallConfig>(emptyFirewallConfig);
  const [fwState, setFwState] = useState<"loading" | "ready" | "error">("loading");
  const [fwError, setFwError] = useState("");
  const [busyRule, setBusyRule] = useState<string | null>(null);

  const loadFw = useCallback(async () => {
    try {
      setFw(await fetchFirewall());
      setFwState("ready");
    } catch (e) {
      setFwError(e instanceof Error ? e.message : "Failed to load the firewall config.");
      setFwState("error");
    }
  }, []);
  useEffect(() => {
    loadFw();
  }, [loadFw]);

  // At most one policy per firewall rule in this view; prefer an enabled one if
  // the raw config somehow points several policies at the same rule.
  const policyByRule = useMemo(() => {
    const m = new Map<string, GeoPolicy>();
    for (const p of config.policies) {
      const key = `${p.ruleset}:${p.rule}`;
      const cur = m.get(key);
      if (!cur || (!cur.enabled && p.enabled)) m.set(key, p);
    }
    return m;
  }, [config.policies]);

  const policyErrors = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of status?.status?.policy_errors ?? []) m.set(e.policy, e.error);
    return m;
  }, [status]);

  const hits = status?.counters?.policies ?? {};
  const actionNames = config.actions.map((a) => a.name);

  // Attach/detach an action on a rule. Empty action removes the policy; any
  // action (re)creates it, re-enabling a previously disabled one.
  const setRuleAction = async (rule: FirewallRule, action: string) => {
    const key = `${rule.chain}:${rule.rule}`;
    const existing = policyByRule.get(key) ?? null;
    setBusyRule(key);
    try {
      if (!action) {
        if (existing) {
          await deleteGeoPolicy(existing.id);
          setToast("Policy removed — confirm the change in the banner.");
        }
      } else {
        await applyGeoPolicy(config.policies, {
          id: existing?.id ?? nextPolicyId(config.policies),
          action,
          ruleset: rule.chain,
          rule: rule.rule,
          direction: existing?.direction ?? "both",
          enabled: true,
          original_id: existing?.id ?? null,
        });
        setToast("Geolocation policy saved — confirm the change in the banner.");
      }
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to update the policy.");
    } finally {
      setBusyRule(null);
    }
  };

  const setRuleDirection = async (rule: FirewallRule, direction: GeoDirection) => {
    const key = `${rule.chain}:${rule.rule}`;
    const existing = policyByRule.get(key);
    if (!existing) return;
    setBusyRule(key);
    try {
      await applyGeoPolicy(config.policies, {
        id: existing.id,
        action: existing.action,
        ruleset: existing.ruleset,
        rule: existing.rule,
        direction,
        enabled: true,
        original_id: existing.id,
      });
      setToast("Direction updated — confirm the change in the banner.");
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to update the direction.");
    } finally {
      setBusyRule(null);
    }
  };

  if (fwState === "loading")
    return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading firewall rules…</div>;
  if (fwState === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} />
          {fwError}
        </div>
        <div>
          <Button kind="secondary" icon={RotateCw} onClick={loadFw}>
            Retry
          </Button>
        </div>
      </div>
    );

  // Every Allow rule, across the forward/input/output chains, is eligible to
  // carry a geolocation policy. Ordered forward → input → output, then by rule
  // number, so the table reads like the firewall.
  const rank: Record<string, number> = { forward: 0, input: 1, output: 2 };
  const eligible = fw.rules
    .filter((r) => r.action === "accept")
    .sort((a, b) => (rank[a.chain] - rank[b.chain]) || a.rule - b.rule);

  const boundCount = new Set(config.policies.filter((p) => p.enabled).map((p) => `${p.ruleset}:${p.rule}`)).size;

  return (
    <div className="flex flex-col gap-3 max-w-[1050px]">
      <p className="text-[13px] text-[var(--qz-fg-4)] m-0">
        Attach a geolocation action to a firewall Allow rule and its traffic is country-filtered
        before the rule sees it. Every Allow rule (forward, input, or output) is eligible
        ({boundCount} enforced). Create rules under{" "}
        <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
          Firewall → Rules
        </Link>
        .
      </p>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 60 }} />
            <col />
            <col style={{ width: 150 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 190 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 70 }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>From → To</th>
              <th>Action</th>
              <th>Geolocation</th>
              <th>Direction</th>
              <th>Hits</th>
            </tr>
          </thead>
          <tbody>
            {eligible.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  No Allow rules yet — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
                    Firewall → Rules
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              eligible.map((r) => {
                const key = `${r.chain}:${r.rule}`;
                const policy = policyByRule.get(key) ?? null;
                const bound = policy?.action ?? "";
                const busy = busyRule === key;
                const error = policy ? policyErrors.get(policy.id) ?? null : null;
                const hit = policy ? hits[String(policy.id)] : undefined;
                const disabled = !!policy && !policy.enabled;
                return (
                  <tr key={key} style={{ cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                    <td className="mono text-[var(--qz-fg-3)]">{r.rule}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name ?? <span className="text-[var(--qz-fg-4)]">Rule {r.rule}</span>}
                      {r.chain !== "forward" && (
                        <span className="badge badge-muted ml-2" title={`${CHAIN_LABEL[r.chain]} chain`}>
                          {CHAIN_LABEL[r.chain]}
                        </span>
                      )}
                      {disabled && <span className="badge badge-muted ml-2">Disabled</span>}
                      {error && (
                        <span
                          className="inline-flex items-center gap-1 ml-2 text-[12px] text-[var(--qz-danger)]"
                          title={error}
                        >
                          <AlertTriangle size={12} /> not enforced
                        </span>
                      )}
                    </td>
                    <td className="mono text-[12px] text-[var(--qz-fg-3)]">
                      {endpoint(r.from)} → {endpoint(r.to)}
                    </td>
                    <td>
                      <span className="badge badge-ok">Allow</span>
                    </td>
                    <td>
                      <select
                        value={bound}
                        disabled={busy || actionNames.length === 0}
                        onChange={(e) => setRuleAction(r, e.target.value)}
                        className="rounded-md px-2 py-[6px] text-[13px] outline-none cursor-pointer w-full"
                        style={{ ...inputStyle, color: bound ? "var(--qz-accent)" : "var(--qz-fg-4)" }}
                      >
                        <option value="">None</option>
                        {actionNames.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={policy?.direction ?? "both"}
                        disabled={busy || !policy}
                        onChange={(e) => setRuleDirection(r, e.target.value as GeoDirection)}
                        className="rounded-md px-2 py-[6px] text-[13px] outline-none w-full"
                        style={{
                          ...inputStyle,
                          color: policy ? "var(--qz-fg-1)" : "var(--qz-fg-4)",
                          cursor: policy ? "pointer" : "not-allowed",
                        }}
                        title={policy ? undefined : "Attach an action first"}
                      >
                        <option value="source">{GEO_DIRECTION_LABEL.source}</option>
                        <option value="destination">{GEO_DIRECTION_LABEL.destination}</option>
                        <option value="both">{GEO_DIRECTION_LABEL.both}</option>
                      </select>
                    </td>
                    <td className="mono text-[var(--qz-fg-3)]" title="New connections checked against the action">
                      {hit && hit.packets > 0 ? hit.packets : dash}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Alerts tab ────────────────────────────────────────────────────────────────

type AlertRow = GeoEvent & { key: string };
const MAX_GEO_ALERTS = 500;

function AlertsTab() {
  const rowsRef = useRef<AlertRow[]>([]);
  const dirtyRef = useRef(false);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamGen, setStreamGen] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/geolocation/alerts");
    es.onopen = () => setStream("live");
    es.onerror = () => setStream("reconnecting");
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!dirtyRef.current || pausedRef.current) return;
      dirtyRef.current = false;
      setRows(rowsRef.current);
    };
    const scheduleFlush = () => {
      if (throttle) return;
      flush();
      throttle = setTimeout(() => {
        throttle = null;
        flush();
      }, 75);
    };
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as GeoEvent;
        rowsRef.current = [{ ...e, key: `${geoEventKey(e)}:${Math.random()}` }, ...rowsRef.current].slice(0, MAX_GEO_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event
      }
    };

    let cancelled = false;
    fetchGeoAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map((r) => geoEventKey(r)));
        const merged = [
          ...rowsRef.current,
          ...history.filter((e) => !seen.has(geoEventKey(e))).map((e) => ({ ...e, key: `${geoEventKey(e)}:${Math.random()}` })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_GEO_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (throttle) clearTimeout(throttle);
      es.close();
    };
  }, [streamGen]);

  // Block-event log lines carry only IPs, so resolve the filtered country from
  // the remote endpoint via the libloc lookup helper — memoized per IP, since
  // the same foreign peers recur across a burst. `geoByIp[ip]` is undefined
  // while a lookup is in flight, then the result (or null on failure).
  const [geoByIp, setGeoByIp] = useState<Record<string, GeoLookupResult | null>>({});
  const lookedUpRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    const pending = new Set<string>();
    for (const r of rows) {
      const ip = blockedIp(r);
      if (ip && !lookedUpRef.current.has(ip)) {
        lookedUpRef.current.add(ip);
        pending.add(ip);
      }
    }
    pending.forEach((ip) => {
      geoLookup(ip)
        .then((res) => mountedRef.current && setGeoByIp((m) => ({ ...m, [ip]: res })))
        .catch(() => mountedRef.current && setGeoByIp((m) => ({ ...m, [ip]: null })));
    });
  }, [rows]);

  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!q) return true;
        const ip = blockedIp(r);
        const geo = ip ? geoByIp[ip] : undefined;
        const hay = [r.action_name, r.src, r.dst, r.proto, r.iif, r.oif, geo?.country, geo?.country_name]
          .filter((v) => v != null && v !== "")
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    [rows, q, geoByIp],
  );

  const togglePause = () =>
    setPaused((p) => {
      pausedRef.current = !p;
      if (p) setRows(rowsRef.current);
      return !p;
    });
  const clear = () => {
    rowsRef.current = [];
    dirtyRef.current = false;
    setRows([]);
  };
  const clock = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : "—");
  const endpointText = (ip?: string, port?: number) => (ip ? (port ? `${ip}:${port}` : ip) : "—");

  return (
    <div className="flex flex-col gap-3 max-w-[1050px]">
      <p className="text-[13px] text-[var(--qz-fg-4)] m-0">
        Live country-block events — one row per connection dropped by an action with logging
        enabled (the action&apos;s <span className="mono">Log</span> switch). Turn logging on for
        an action on the Actions tab to see its blocks here.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter alerts…"
            className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
            style={inputStyle}
          />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button
            kind="secondary"
            size="sm"
            icon={RotateCw}
            onClick={() => {
              clear();
              setStream("connecting");
              setStreamGen((g) => g + 1);
            }}
          >
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
              style={{ background: paused ? "var(--qz-fg-4)" : stream === "live" ? "var(--qz-success)" : "var(--qz-warn)" }}
            />
            {paused ? "Paused" : stream === "live" ? "Live" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}
            {" · "}
            {visible.length} {visible.length === 1 ? "alert" : "alerts"}
          </span>
        </div>
      </div>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 110 }} />
            <col style={{ width: 160 }} />
            <col style={{ width: 170 }} />
            <col style={{ width: 90 }} />
            <col />
            <col />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Country</th>
              <th>Proto</th>
              <th>Source</th>
              <th>Destination</th>
              <th>Interfaces</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  {rows.length === 0
                    ? "No block events yet — they appear when an action with logging enabled drops traffic."
                    : "No alerts match the filter."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.key} style={{ cursor: "default" }}>
                  <td className="mono text-[12px] text-[var(--qz-fg-3)]">{clock(r.ts)}</td>
                  <td>
                    <span className="badge badge-crit">{r.action_name}</span>
                  </td>
                  <td className="text-[13px] text-[var(--qz-fg-2)]">
                    {(() => {
                      const ip = blockedIp(r);
                      if (!ip) return dash;
                      const geo = geoByIp[ip];
                      if (geo === undefined) return <span className="text-[var(--qz-fg-4)]">…</span>;
                      if (!geo?.country) return dash;
                      return (
                        <span className="inline-flex items-center gap-[6px]">
                          <span>{flagEmoji(geo.country)}</span>
                          <span>{geo.country_name ?? geo.country}</span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="mono text-[12px] text-[var(--qz-fg-3)]">{r.proto ?? dash}</td>
                  <td className="mono text-[12px] text-[var(--qz-fg-2)]">{endpointText(r.src, r.spt)}</td>
                  <td className="mono text-[12px] text-[var(--qz-fg-2)]">{endpointText(r.dst, r.dpt)}</td>
                  <td className="mono text-[12px] text-[var(--qz-fg-4)]">
                    {(r.iif ?? "—") + " → " + (r.oif ?? "—")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── page shell ────────────────────────────────────────────────────────────────

export default function GeolocationPage() {
  const [tab, setTab] = useState<Tab>("actions");
  const [config, setConfig] = useState<GeolocationConfig>(emptyGeolocationConfig);
  const [countries, setCountries] = useState<GeoCountries>({ available: false, db_version: null, countries: [] });
  const [status, setStatus] = useState<GeoStatus | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setState("loading");
    try {
      const [cfg, cc, st] = await Promise.all([
        fetchGeolocation(),
        fetchGeoCountries().catch(() => ({ available: false, db_version: null, countries: [] })),
        fetchGeoStatus().catch(() => null),
      ]);
      setConfig(cfg);
      setCountries(cc);
      setStatus(st);
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load Geolocation.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Commits apply through the guard; re-read shortly after so the tables and
  // status settle (the root helpers run asynchronously).
  const onChanged = useCallback(() => {
    setTimeout(() => load("refresh"), 800);
    setTimeout(() => load("refresh"), 3500);
  }, [load]);

  const applyError = status?.status?.apply?.ok === false ? status.status.apply.error : null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Geolocation
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Block or allow traffic by country, per firewall rule — powered by the signed IPFire
          location database
        </p>
      </div>

      <div className="px-[36px] pb-4 flex-shrink-0">
        <StatusCard status={status} onRefresh={() => load("refresh")} />
      </div>

      <div className="px-[36px] pb-4 flex-shrink-0 flex items-center gap-3">
        <Segmented
          items={[
            { value: "actions", label: "Actions" },
            { value: "policies", label: "Policies" },
            { value: "alerts", label: "Alerts" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
        {status?.status?.active ? (
          <span className="badge badge-ok">Enforcing</span>
        ) : config.policies.some((p) => p.enabled) ? (
          <span className="badge badge-warn">Not enforcing</span>
        ) : (
          <span className="badge badge-muted">No enabled policies</span>
        )}
      </div>

      {applyError && (
        <div
          className="mx-[36px] mb-4 flex items-center gap-3 px-3 py-2 rounded-md flex-shrink-0"
          style={{
            background: "color-mix(in oklab, var(--qz-danger) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--qz-danger) 35%, transparent)",
          }}
        >
          <AlertTriangle size={15} className="text-[var(--qz-danger)] flex-shrink-0" />
          <span className="text-[13px] text-[var(--qz-fg-1)]">{applyError}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {state === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading Geolocation…</div>}
        {state === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={() => load()}>
                Retry
              </Button>
            </div>
          </div>
        )}
        {state === "ready" && (
          <>
            {tab === "actions" && (
              <ActionsTab config={config} countries={countries} status={status} onChanged={onChanged} />
            )}
            {tab === "policies" && (
              <PoliciesTab config={config} status={status} onChanged={onChanged} />
            )}
            {tab === "alerts" && <AlertsTab />}
          </>
        )}
      </div>
    </div>
  );
}
