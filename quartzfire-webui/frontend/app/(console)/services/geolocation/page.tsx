"use client";

// Geolocation — WatchGuard-style country filtering on top of IPFire libloc.
//
// Actions tab: named, reusable country policies (block-listed / allow-listed
// + unknown-IP handling + logging). Policies tab: which firewall rules each
// action attaches to, with direction and an inline enable toggle. Both are
// real VyOS config (`service geolocation …`) edited under commit-confirm.
// The status card covers the database side: version, signed updates,
// "Update now", and the IP → country lookup utility.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Earth, Pencil, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig } from "@/lib/firewall";
import {
  actionUsage,
  applyGeoAction,
  applyGeoPolicy,
  countryName,
  deleteGeoAction,
  deleteGeoPolicy,
  emptyGeolocationConfig,
  fetchGeoCountries,
  fetchGeolocation,
  fetchGeoStatus,
  flagEmoji,
  GEO_DIRECTION_LABEL,
  GEO_MODE_LABEL,
  GeoAction,
  GeoCountries,
  GeolocationConfig,
  geoLookup,
  GeoLookupResult,
  GeoPolicy,
  GeoStatus,
  requestGeoUpdate,
  setGeoPolicyEnabled,
} from "@/lib/geolocation";
import { ActionFormModal } from "./ActionFormModal";
import { PolicyFormModal, ruleSummary } from "./PolicyFormModal";

type Tab = "actions" | "policies";

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
                      {a.countries.length} — {summarize(a)}
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
  const [editing, setEditing] = useState<GeoPolicy | null>(null);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);

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

  const ruleByKey = useMemo(() => {
    const m = new Map<string, (typeof fw.rules)[number]>();
    for (const r of fw.rules) m.set(`${r.chain}:${r.rule}`, r);
    return m;
  }, [fw.rules]);

  const policyErrors = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of status?.status?.policy_errors ?? []) m.set(e.policy, e.error);
    return m;
  }, [status]);

  const hits = status?.counters?.policies ?? {};

  const save = async (u: Parameters<typeof applyGeoPolicy>[1]) => {
    try {
      await applyGeoPolicy(config.policies, u);
      setToast("Geolocation policy saved — confirm the change in the banner.");
      setEditing(null);
      setCreating(false);
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to save the policy.");
    }
  };

  const remove = async (p: GeoPolicy) => {
    if (!window.confirm(`Delete geolocation policy ${p.id}?`)) return;
    try {
      await deleteGeoPolicy(p.id);
      setToast("Policy deleted — confirm the change in the banner.");
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to delete the policy.");
    }
  };

  const toggle = async (p: GeoPolicy, enabled: boolean) => {
    setToggling(p.id);
    try {
      await setGeoPolicyEnabled(p, enabled);
      setToast(`Policy ${p.id} ${enabled ? "enabled" : "disabled"} — confirm the change in the banner.`);
      onChanged();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to toggle the policy.");
    } finally {
      setToggling(null);
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

  return (
    <div className="flex flex-col gap-4 max-w-[1050px]">
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-[var(--qz-fg-4)] m-0 flex-1">
          A policy attaches an action to one firewall rule: traffic that rule handles is
          country-filtered before the rule sees it. Create rules under{" "}
          <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
            Firewall → Rules
          </Link>
          .
        </p>
        <Button
          kind="primary"
          size="sm"
          icon={Plus}
          onClick={() => { setCreating(true); setEditing(null); }}
          disabled={config.actions.length === 0}
        >
          Add policy
        </Button>
      </div>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 60 }} />
            <col style={{ width: 170 }} />
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Action</th>
              <th>Firewall rule</th>
              <th>Direction</th>
              <th>Hits</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {config.policies.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  {config.actions.length === 0
                    ? "Create an action on the Actions tab first, then attach it to a firewall rule here."
                    : "No policies yet — add one to start enforcing an action."}
                </td>
              </tr>
            ) : (
              config.policies.map((p) => {
                const rule = ruleByKey.get(`${p.ruleset}:${p.rule}`);
                const error = policyErrors.get(p.id) ?? (rule ? null : "target firewall rule no longer exists");
                const hit = hits[String(p.id)];
                return (
                  <tr key={p.id} style={{ cursor: "pointer", opacity: p.enabled ? 1 : 0.55 }} onClick={() => { setCreating(false); setEditing(p); }}>
                    <td className="mono text-[var(--qz-fg-3)]">{p.id}</td>
                    <td className="font-semibold text-[var(--qz-fg-1)]">{p.action}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {rule ? (
                        <span className="text-[var(--qz-fg-2)]">{ruleSummary(rule)}</span>
                      ) : (
                        <span className="text-[var(--qz-fg-4)] mono text-[12px]">
                          {p.ruleset} rule {p.rule}
                        </span>
                      )}
                      {error && (
                        <span
                          className="inline-flex items-center gap-1 ml-2 text-[12px] text-[var(--qz-danger)]"
                          title={error}
                        >
                          <AlertTriangle size={12} /> not enforced
                        </span>
                      )}
                    </td>
                    <td className="text-[var(--qz-fg-3)]">{GEO_DIRECTION_LABEL[p.direction]}</td>
                    <td className="mono text-[var(--qz-fg-3)]" title="New connections checked against the action">
                      {hit && hit.packets > 0 ? hit.packets : dash}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ opacity: toggling === p.id ? 0.5 : 1 }}>
                        <Switch on={p.enabled} onChange={(v) => toggle(p, v)} />
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="Delete"
                        onClick={() => remove(p)}
                        style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--qz-danger)" }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <PolicyFormModal
          initial={editing}
          actions={config.actions}
          policies={config.policies}
          rules={fw.rules}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSave={save}
        />
      )}
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
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0 flex items-center gap-2" style={{ letterSpacing: "-0.015em" }}>
          <Earth size={26} className="text-[var(--qz-accent)]" />
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
          </>
        )}
      </div>
    </div>
  );
}
