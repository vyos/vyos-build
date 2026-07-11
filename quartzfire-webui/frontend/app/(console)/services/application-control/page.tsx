"use client";

// Application Control — WatchGuard-style app identification on top of qfappd.
//
// Actions tab: named allow/block actions built from a category/app tree (the
// left-hand WatchGuard dialog), the "when application does not match" default,
// and drop-vs-reset block mode — stored as a desired-state policy a root helper
// applies to qfappd. Policies tab: which firewall rules enforce which action
// (each becomes a binding). Alerts tab: the live decision-event stream from the
// journal, with persistent history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, AppWindow, Copy, Eraser, Pause, Play, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { useDashboard } from "@/lib/DashboardContext";
import {
  AcAction,
  AcConfig,
  AcEvent,
  AcStatus,
  Catalog,
  CATALOG_FIXTURE,
  CatalogApp,
  effectiveVerdict,
  emptyAcConfig,
  eventKey,
  fetchAcAlertHistory,
  fetchAcStatus,
  fetchCatalog,
  groupByCategory,
  saveAcConfig,
  Verdict,
} from "@/lib/appcontrol";
import { emptyFirewallConfig, fetchFirewall, FirewallConfig, FirewallRule } from "@/lib/firewall";

type Tab = "actions" | "policies" | "alerts";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const dash = <span className="text-[var(--qz-fg-4)]">—</span>;

/// The ct-mark ACTION_ID field is 3 bits → at most 7 actions bound at once.
const MAX_BOUND_ACTIONS = 7;

// ── Actions tab ────────────────────────────────────────────────────────────────

function verdictBadge(v: Verdict) {
  return v === "block" ? (
    <span className="badge badge-crit">Block</span>
  ) : (
    <span className="badge badge-ok">Allow</span>
  );
}

function ActionsTab({
  config,
  catalog,
  onSave,
  saving,
}: {
  config: AcConfig;
  catalog: Catalog;
  onSave: (next: AcConfig) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState<{ name: string; action: AcAction } | null>(null);
  const [creating, setCreating] = useState(false);

  const actionNames = Object.keys(config.actions);
  const bindingsByAction = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of config.bindings) m.set(b.action, (m.get(b.action) ?? 0) + 1);
    return m;
  }, [config.bindings]);

  const summarize = (a: AcAction) => {
    const apps = Object.keys(a.applications).length;
    const cats = Object.keys(a.categories).length;
    if (apps === 0 && cats === 0) return `Default ${a.default_action} for all`;
    const parts: string[] = [];
    if (cats) parts.push(`${cats} categor${cats === 1 ? "y" : "ies"}`);
    if (apps) parts.push(`${apps} app${apps === 1 ? "" : "s"}`);
    return parts.join(", ");
  };

  const removeAction = (name: string) => {
    if ((bindingsByAction.get(name) ?? 0) > 0) return;
    const actions = { ...config.actions };
    delete actions[name];
    onSave({ ...config, actions });
  };

  const cloneAction = (name: string) => {
    let n = `${name} copy`;
    let i = 2;
    while (config.actions[n]) n = `${name} copy ${i++}`;
    onSave({ ...config, actions: { ...config.actions, [n]: structuredClone(config.actions[name]) } });
  };

  const commitEdit = (name: string, action: AcAction, originalName: string | null) => {
    const actions = { ...config.actions };
    if (originalName && originalName !== name) delete actions[originalName];
    actions[name] = action;
    // Rename: keep bindings pointing at the action.
    const bindings =
      originalName && originalName !== name
        ? config.bindings.map((b) => (b.action === originalName ? { ...b, action: name } : b))
        : config.bindings;
    onSave({ ...config, actions, bindings });
    setEditing(null);
    setCreating(false);
  };

  return (
    <div className="flex flex-col gap-4 max-w-[980px]">
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-[var(--qz-fg-4)] m-0 flex-1">
          An action decides allow or block per application and per category. Attach one to firewall
          rules on the Policies tab. Application rules take precedence over category rules.
        </p>
        <Button
          kind="primary"
          size="sm"
          icon={Plus}
          onClick={() => {
            setCreating(true);
            setEditing({
              name: "",
              action: { default_action: "allow", block_mode: "drop", categories: {}, applications: {} },
            });
          }}
        >
          Add action
        </Button>
      </div>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 200 }} />
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Action</th>
              <th>Applications &amp; categories</th>
              <th>Default</th>
              <th>Policies</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {actionNames.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  No actions yet — add one to get started.
                </td>
              </tr>
            ) : (
              actionNames.map((name) => {
                const a = config.actions[name];
                const uses = bindingsByAction.get(name) ?? 0;
                return (
                  <tr
                    key={name}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setCreating(false);
                      setEditing({ name, action: structuredClone(a) });
                    }}
                  >
                    <td className="font-semibold text-[var(--qz-fg-1)]">{name}</td>
                    <td className="text-[var(--qz-fg-3)]">{summarize(a)}</td>
                    <td>{verdictBadge(a.default_action)}</td>
                    <td className="mono text-[var(--qz-fg-3)]">{uses > 0 ? uses : dash}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          className="icon-btn"
                          title="Clone"
                          onClick={() => cloneAction(name)}
                          style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--qz-fg-3)" }}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="icon-btn"
                          title={uses > 0 ? "In use by policies — detach first" : "Remove"}
                          disabled={uses > 0}
                          onClick={() => removeAction(name)}
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

      <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
        Signature set:{" "}
        {catalog.available
          ? `nDPI ${catalog.ndpi_version} · ${catalog.num_protocols} applications`
          : "qfappd has not reported its catalog yet — showing a built-in sample until the service runs."}
        {saving && " · Saving…"}
      </p>

      {editing && (
        <ActionEditor
          catalog={catalog}
          initialName={editing.name}
          initialAction={editing.action}
          existingNames={actionNames}
          isNew={creating}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onCommit={commitEdit}
        />
      )}
    </div>
  );
}

// ── Action editor (the WatchGuard left-hand dialog) ─────────────────────────────

function ActionEditor({
  catalog,
  initialName,
  initialAction,
  existingNames,
  isNew,
  onCancel,
  onCommit,
}: {
  catalog: Catalog;
  initialName: string;
  initialAction: AcAction;
  existingNames: string[];
  isNew: boolean;
  onCancel: () => void;
  onCommit: (name: string, action: AcAction, originalName: string | null) => void;
}) {
  const { setToast } = useDashboard();
  const [name, setName] = useState(initialName);
  const [action, setAction] = useState<AcAction>(initialAction);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const groups = useMemo(() => groupByCategory(catalog), [catalog]);
  const q = query.trim().toLowerCase();

  const setAppVerdict = (app: CatalogApp, verdict: Verdict | "inherit") => {
    setAction((a) => {
      const applications = { ...a.applications };
      if (verdict === "inherit") delete applications[app.name];
      else applications[app.name] = verdict;
      return { ...a, applications };
    });
  };

  const setCategoryVerdict = (category: string, verdict: Verdict) => {
    setAction((a) => {
      const categories = { ...a.categories };
      const apps = { ...a.applications };
      categories[category] = verdict;
      // "Select by Category" clears per-app overrides in that category so the
      // category rule is what shows.
      for (const app of catalog.applications) if (app.category === category) delete apps[app.name];
      return { ...a, categories, applications: apps };
    });
  };

  const clearCategory = (category: string) => {
    setAction((a) => {
      const categories = { ...a.categories };
      delete categories[category];
      return { ...a, categories };
    });
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return setToast("Give the action a name.");
    if ((isNew || trimmed !== initialName) && existingNames.includes(trimmed))
      return setToast(`An action named "${trimmed}" already exists.`);
    onCommit(trimmed, action, isNew ? null : initialName);
  };

  const visibleGroups = groups
    .filter((g) => categoryFilter === "all" || g.category === categoryFilter)
    .map((g) => ({
      ...g,
      apps: g.apps.filter((app) => !q || app.name.toLowerCase().includes(q) || app.category.toLowerCase().includes(q)),
    }))
    .filter((g) => g.apps.length > 0);

  return (
    <ModalShell onClose={onCancel} maxWidth={760}>
      <ModalHeader
        title={isNew ? "New Application Control Action" : `Edit Action — ${initialName}`}
        subtitle="Set a per-application or per-category verdict; unset apps follow their category, then the default."
        onClose={onCancel}
      />

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <label className="text-[13px] text-[var(--qz-fg-3)] w-[70px]">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Global"
            className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none"
            style={inputStyle}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search applications…"
              className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[220px]"
              style={inputStyle}
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
            style={inputStyle}
          >
            <option value="all">All categories</option>
            {groups.map((g) => (
              <option key={g.category} value={g.category}>
                {g.category}
              </option>
            ))}
          </select>
        </div>

        <div
          className="rounded-md overflow-auto"
          style={{ border: "1px solid var(--qz-border)", maxHeight: "42vh" }}
        >
          {visibleGroups.length === 0 ? (
            <div className="text-center text-[13px] text-[var(--qz-fg-4)] py-6">No applications match.</div>
          ) : (
            visibleGroups.map((g) => {
              const catVerdict = action.categories[g.category];
              return (
                <div key={g.category}>
                  <div
                    className="flex items-center gap-3 px-3 py-[7px] sticky top-0"
                    style={{ background: "var(--qz-input-bg)", borderBottom: "1px solid var(--qz-border)" }}
                  >
                    <span className="text-[13px] font-semibold text-[var(--qz-fg-1)] flex-1">{g.category}</span>
                    <span className="text-[11px] text-[var(--qz-fg-4)]">Select by category:</span>
                    <button
                      onClick={() => setCategoryVerdict(g.category, "allow")}
                      className="text-[11px] px-2 py-[2px] rounded"
                      style={{ border: "1px solid var(--qz-border)", background: catVerdict === "allow" ? "var(--qz-accent-soft)" : "transparent", color: "var(--qz-fg-2)", cursor: "pointer" }}
                    >
                      Allow all
                    </button>
                    <button
                      onClick={() => setCategoryVerdict(g.category, "block")}
                      className="text-[11px] px-2 py-[2px] rounded"
                      style={{ border: "1px solid var(--qz-border)", background: catVerdict === "block" ? "color-mix(in oklab, var(--qz-danger) 15%, transparent)" : "transparent", color: "var(--qz-fg-2)", cursor: "pointer" }}
                    >
                      Block all
                    </button>
                    {catVerdict && (
                      <button
                        onClick={() => clearCategory(g.category)}
                        className="text-[11px] text-[var(--qz-fg-4)]"
                        style={{ background: "transparent", border: 0, cursor: "pointer" }}
                        title="Clear category rule"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {g.apps.map((app) => {
                    const explicit = action.applications[app.name];
                    const eff = effectiveVerdict(action, app);
                    return (
                      <div
                        key={app.id}
                        className="flex items-center gap-3 px-3 py-[6px]"
                        style={{ borderBottom: "1px solid var(--qz-border)" }}
                      >
                        <span className="text-[13px] text-[var(--qz-fg-1)] flex-1">{app.name}</span>
                        <span className="text-[11px] text-[var(--qz-fg-4)] w-[64px] text-right">
                          {explicit ? "app rule" : action.categories[app.category] ? "category" : "default"}
                        </span>
                        <Segmented
                          items={[
                            { value: "allow", label: "Allow" },
                            { value: "block", label: "Block" },
                            { value: "inherit", label: "Auto" },
                          ]}
                          value={explicit ?? "inherit"}
                          onChange={(v) => setAppVerdict(app, v as Verdict | "inherit")}
                        />
                        <span className="w-[54px] text-right">{verdictBadge(eff)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--qz-fg-3)]">When application does not match:</span>
            <Segmented
              items={[
                { value: "allow", label: "Allow" },
                { value: "block", label: "Block" },
              ]}
              value={action.default_action}
              onChange={(v) => setAction((a) => ({ ...a, default_action: v as Verdict }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--qz-fg-3)]">Block mode:</span>
            <Segmented
              items={[
                { value: "drop", label: "Drop" },
                { value: "reset", label: "Reset (TCP RST)" },
              ]}
              value={action.block_mode}
              onChange={(v) => setAction((a) => ({ ...a, block_mode: v as "drop" | "reset" }))}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 justify-end mt-1">
          <Button kind="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button kind="primary" onClick={save}>
            {isNew ? "Add action" : "Save action"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Policies tab ────────────────────────────────────────────────────────────────

/// Derive an app-control binding match from a firewall rule's own criteria.
function bindingMatchFromRule(rule: FirewallRule) {
  const match: Record<string, unknown> = {};
  const iif = rule.from.iface;
  const oif = rule.to.iface;
  if (iif) match.iifname = [iif];
  if (oif) match.oifname = [oif];
  if (rule.from.address) match.saddr = [rule.from.address];
  if (rule.to.address) match.daddr = [rule.to.address];
  return match;
}

function PoliciesTab({
  config,
  onSave,
  saving,
}: {
  config: AcConfig;
  onSave: (next: AcConfig) => void;
  saving: boolean;
}) {
  const { setToast } = useDashboard();
  const [fw, setFw] = useState<FirewallConfig>(emptyFirewallConfig);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setFw(await fetchFirewall());
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the firewall config.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const actionNames = Object.keys(config.actions);
  const bindingByRule = useMemo(() => {
    const m = new Map<number, string>();
    for (const b of config.bindings) m.set(b.id, b.action);
    return m;
  }, [config.bindings]);

  const boundActionCount = new Set(config.bindings.map((b) => b.action)).size;

  const setRuleAction = (rule: FirewallRule, action: string | null) => {
    const bindings = config.bindings.filter((b) => b.id !== rule.rule);
    if (action) {
      // Enforce the concurrently-bound-action ceiling before saving.
      const wouldBind = new Set([...bindings.map((b) => b.action), action]);
      if (wouldBind.size > MAX_BOUND_ACTIONS) {
        setToast(`At most ${MAX_BOUND_ACTIONS} actions can be active at once. Reuse an action already in use.`);
        return;
      }
      bindings.push({
        id: rule.rule,
        action,
        description: rule.name ?? `forward rule ${rule.rule}`,
        match: bindingMatchFromRule(rule),
      });
    }
    onSave({ ...config, bindings });
  };

  if (state === "loading") return <div className="text-[13px] text-[var(--qz-fg-4)]">Loading firewall rules…</div>;
  if (state === "error")
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} />
          {errorMsg}
        </div>
        <div>
          <Button kind="secondary" icon={RotateCw} onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );

  const eligible = fw.rules.filter((r) => r.chain === "forward" && r.action === "accept");

  return (
    <div className="flex flex-col gap-3 max-w-[900px]">
      <p className="text-[13px] text-[var(--qz-fg-4)] m-0">
        Attach an Application Control action to a forward Allow rule to classify and enforce its
        traffic. Only forward Allow rules are eligible. At most {MAX_BOUND_ACTIONS} actions can be
        active at once ({boundActionCount} in use{saving ? " · Saving…" : ""}).
      </p>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
        <table className="qz-table" style={{ width: "100%" }}>
          <colgroup>
            <col style={{ width: 60 }} />
            <col />
            <col style={{ width: 140 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 220 }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>From → To</th>
              <th>Action</th>
              <th>Application Control</th>
            </tr>
          </thead>
          <tbody>
            {eligible.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  No eligible forward Allow rules — create them under{" "}
                  <Link href="/firewall/rules" className="text-[var(--qz-fg-3)]">
                    Firewall → Rules
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              eligible.map((r) => {
                const bound = bindingByRule.get(r.rule) ?? "";
                return (
                  <tr key={r.rule} style={{ cursor: "default", opacity: r.enabled ? 1 : 0.55 }}>
                    <td className="mono text-[var(--qz-fg-3)]">{r.rule}</td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name ?? <span className="text-[var(--qz-fg-4)]">Rule {r.rule}</span>}
                    </td>
                    <td className="mono text-[12px] text-[var(--qz-fg-3)]">
                      {(r.from.iface ?? "any") + " → " + (r.to.iface ?? "any")}
                    </td>
                    <td>
                      <span className="badge badge-ok">Allow</span>
                    </td>
                    <td onMouseDown={(e) => e.stopPropagation()}>
                      <select
                        value={bound}
                        onChange={(e) => setRuleAction(r, e.target.value || null)}
                        className="rounded-md px-2 py-[6px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer w-full"
                        style={{
                          ...inputStyle,
                          color: bound ? "var(--qz-accent)" : "var(--qz-fg-4)",
                        }}
                      >
                        <option value="">None</option>
                        {actionNames.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
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

// ── Alerts tab ──────────────────────────────────────────────────────────────────

type AlertRow = AcEvent & { key: string };
const MAX_ALERTS = 500;

function AlertsTab() {
  const rowsRef = useRef<AlertRow[]>([]);
  const dirtyRef = useRef(false);
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stream, setStream] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamGen, setStreamGen] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/appcontrol/alerts");
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
        const e = JSON.parse(ev.data) as AcEvent;
        rowsRef.current = [{ ...e, key: `${eventKey(e)}:${Math.random()}` }, ...rowsRef.current].slice(0, MAX_ALERTS);
        dirtyRef.current = true;
        scheduleFlush();
      } catch {
        // tolerate a malformed event
      }
    };

    let cancelled = false;
    fetchAcAlertHistory()
      .then((history) => {
        if (cancelled || history.length === 0) return;
        const seen = new Set(rowsRef.current.map((r) => eventKey(r)));
        const merged = [
          ...rowsRef.current,
          ...history.filter((e) => !seen.has(eventKey(e))).map((e) => ({ ...e, key: `${eventKey(e)}:${Math.random()}` })),
        ];
        merged.sort((a, b) => b.ts - a.ts);
        rowsRef.current = merged.slice(0, MAX_ALERTS);
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

  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<"all" | "block" | "allow">("block");

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (actionFilter !== "all" && r.action !== actionFilter) return false;
        if (!q) return true;
        const hay = [r.app, r.category, r.src, r.dst, r.action_name, r.sni, r.proto]
          .filter((v) => v != null && v !== "")
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    [rows, q, actionFilter],
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
  const time = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : "—");

  return (
    <div className="flex flex-col gap-3">
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
        <Segmented
          items={[
            { value: "block", label: "Blocked" },
            { value: "allow", label: "Allowed" },
            { value: "all", label: "All" },
          ]}
          value={actionFilter}
          onChange={(v) => setActionFilter(v as typeof actionFilter)}
        />
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
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 130 }} />
            <col />
            <col style={{ width: 150 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Application</th>
              <th>Category</th>
              <th>Source → Destination</th>
              <th>SNI / Host</th>
              <th>Policy</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  {rows.length === 0
                    ? "No alerts yet — they appear when classified traffic matches an action."
                    : "No alerts match the filter."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr
                  key={r.key}
                  style={{
                    cursor: "default",
                    background: r.action === "block" ? "color-mix(in oklab, var(--qz-danger) 7%, transparent)" : undefined,
                  }}
                >
                  <td className="mono text-[var(--qz-fg-3)]">{time(r.ts)}</td>
                  <td>
                    {r.action === "block" ? (
                      <span className="badge badge-crit">Blocked</span>
                    ) : (
                      <span className="badge badge-ok">Allowed</span>
                    )}
                  </td>
                  <td className="text-[var(--qz-fg-1)]">{r.app}</td>
                  <td className="text-[var(--qz-fg-3)]">{r.category ?? dash}</td>
                  <td className="mono text-[12px]" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.src ?? "?"}
                    {r.spt != null && <span className="text-[var(--qz-fg-4)]">:{r.spt}</span>}
                    {" → "}
                    {r.dst ?? "?"}
                    {r.dpt != null && <span className="text-[var(--qz-fg-4)]">:{r.dpt}</span>}
                  </td>
                  <td className="mono text-[12px]" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.sni ?? dash}
                  </td>
                  <td className="text-[12px] text-[var(--qz-fg-3)]">{r.action_name || dash}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
        Live decisions stream from qfappd; history is read from the persistent event log on the device
        (survives reboots). The newest {MAX_ALERTS} are shown. Blocked rows are highlighted.
      </p>
    </div>
  );
}

// ── page shell ──────────────────────────────────────────────────────────────────

export default function ApplicationControlPage() {
  const { setToast } = useDashboard();
  const [tab, setTab] = useState<Tab>("actions");
  const [status, setStatus] = useState<AcStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(CATALOG_FIXTURE);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setState("loading");
    try {
      const [s, c] = await Promise.all([fetchAcStatus(), fetchCatalog().catch(() => CATALOG_FIXTURE)]);
      setStatus(s);
      setCatalog(c && (c.applications?.length ?? 0) > 0 ? c : CATALOG_FIXTURE);
      setState("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load Application Control.");
      setState("error");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const config = status?.settings ?? emptyAcConfig();

  const save = useCallback(
    async (next: AcConfig) => {
      // Optimistic: reflect immediately, persist, then re-read the applied state.
      setStatus((s) => (s ? { ...s, settings: next } : s));
      setSaving(true);
      try {
        await saveAcConfig(next);
        setToast("Application Control saved — applying on the device…");
        setTimeout(() => load("refresh"), 800);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to save Application Control.");
        load("refresh");
      } finally {
        setSaving(false);
      }
    },
    [load, setToast],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0 flex items-center gap-2" style={{ letterSpacing: "-0.015em" }}>
          <AppWindow size={26} className="text-[var(--qz-accent)]" />
          Application Control
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Identify applications with deep packet inspection (nDPI) and allow or block them per firewall rule
        </p>
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
        {status?.status?.policy_last_error ? (
          <span className="inline-flex items-center gap-[6px] text-[12px] text-[var(--qz-danger)]" title={status.status.policy_last_error}>
            <AlertTriangle size={13} /> Last apply rejected
          </span>
        ) : status?.running ? (
          <span className="badge badge-ok">qfappd running</span>
        ) : (
          <span className="badge badge-muted">qfappd not reporting</span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {state === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading Application Control…</div>}
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
            {tab === "actions" && <ActionsTab config={config} catalog={catalog} onSave={save} saving={saving} />}
            {tab === "policies" && <PoliciesTab config={config} onSave={save} saving={saving} />}
            {tab === "alerts" && <AlertsTab />}
          </>
        )}
      </div>
    </div>
  );
}
