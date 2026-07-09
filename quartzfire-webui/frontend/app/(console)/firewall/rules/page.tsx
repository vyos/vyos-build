"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, GripVertical, Plus, RotateCw, Search, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  applyRuleOrder,
  AutoGroup,
  deleteRule,
  fetchFirewall,
  FirewallConfig,
  FirewallRule,
  PROTOCOL_LABEL,
  ruleSelection,
  setDefaultAction,
} from "@/lib/firewall";
import { fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { RuleFormModal } from "./RuleFormModal";

function ActionPill({ action }: { action: FirewallRule["action"] }) {
  if (action === "accept") return <span className="badge badge-ok">Allow</span>;
  if (action === "drop") return <span className="badge badge-crit">Deny</span>;
  if (action === "reject") return <span className="badge badge-warn">Reject</span>;
  return <span className="badge badge-muted">—</span>;
}

/// Stable row identity — rule numbers are only unique within a chain.
const ruleKey = (r: FirewallRule) => `${r.chain}:${r.rule}`;

function EndpointCell({ rule, side, autoGroups }: { rule: FirewallRule; side: "from" | "to"; autoGroups: AutoGroup[] }) {
  const sel = ruleSelection(rule, side, autoGroups);
  if (sel.length === 0) return <span className="text-[var(--qz-fg-4)]">Any</span>;
  const names = sel.map((e) => (e.kind === "address" ? e.address : e.kind === "firewall" ? "Firewall" : e.name));
  const allIfaces = sel.every((e) => e.kind === "interface" || e.kind === "ifgroup");
  return (
    <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--qz-fg-1)" }} title={names.join(", ")}>
      {names.join(", ")}
      {allIfaces && <span className="text-[var(--qz-fg-4)]"> · iface</span>}
    </span>
  );
}

export default function FirewallRulesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>({
    aliases: [],
    policies: [],
    rules: [],
    auto_groups: [],
    group_names: [],
    default_action: null,
    setup: {
      input: { baseline: false, default_action: null },
      output: { baseline: false, default_action: null },
    },
  });
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // null = closed; { rule: undefined } = create; { rule } = edit.
  const [modal, setModal] = useState<{ rule?: FirewallRule } | null>(null);

  // Display order as a list of rule keys. Dragging edits this locally;
  // "Apply order" commits the renumbering in one transaction.
  const [order, setOrder] = useState<string[]>([]);
  const [applyingOrder, setApplyingOrder] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the rule form's From/To pickers; tolerate
      // their failure so a firewall read still renders.
      const [fw, ifs, descs] = await Promise.all([
        fetchFirewall(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
      ]);
      setData(fw);
      setInterfaces(ifs.map((i) => i.name).sort());
      setIfaceDescriptions(descs);
      setOrder(fw.rules.map(ruleKey));
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall rules.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load("refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const byKey = useMemo(() => new Map(data.rules.map((r) => [ruleKey(r), r])), [data.rules]);
  const orderedRules = useMemo(
    () => order.map((k) => byKey.get(k)).filter((r): r is FirewallRule => !!r),
    [order, byKey],
  );
  const orderDirty = useMemo(
    () =>
      orderedRules.some((r, i) => {
        const original = data.rules[i];
        return !original || ruleKey(original) !== ruleKey(r);
      }),
    [orderedRules, data.rules],
  );

  const policyByName = useMemo(() => new Map(data.policies.map((p) => [p.name, p])), [data.policies]);

  const q = query.trim().toLowerCase();
  const visibleRules = useMemo(() => {
    if (!q) return orderedRules;
    return orderedRules.filter((r) => {
      const hay = [
        r.name,
        r.action,
        r.chain !== "forward" ? "firewall" : null,
        r.from.group_name,
        r.from.address,
        r.from.iface,
        r.to.group_name,
        r.to.address,
        r.to.iface,
        r.policy,
        r.protocol,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orderedRules, q]);
  // Dragging against a filtered list would reorder rules the user can't see.
  const dragEnabled = !q && visibleRules.length > 1;

  // ── row drag-and-drop (native HTML5, reorders live while hovering) ──────────
  const dragIndex = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onRowDragOver = (e: React.DragEvent, over: number) => {
    const from = dragIndex.current;
    if (from === null || from === over) return;
    e.preventDefault();
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(over, 0, moved);
      return next;
    });
    dragIndex.current = over;
  };

  const commitOrder = async () => {
    setApplyingOrder(true);
    try {
      const moved = await applyRuleOrder(orderedRules);
      setToast(`Reordered ${moved} rule${moved === 1 ? "" : "s"} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to apply the new rule order.");
    } finally {
      setApplyingOrder(false);
    }
  };

  const remove = async (rule: FirewallRule) => {
    try {
      await deleteRule(rule, data.auto_groups);
      setToast(`Deleted rule ${rule.rule} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete rule ${rule.rule}.`);
    }
  };

  const changeDefaultAction = async (action: "accept" | "drop") => {
    try {
      await setDefaultAction(action);
      setToast(`Default action set to ${action === "accept" ? "Allow" : "Deny"} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Failed to set the default action.");
    }
  };

  const policyCell = (r: FirewallRule) => {
    if (r.policy) {
      const p = policyByName.get(r.policy);
      return (
        <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--qz-fg-1)" }}>
          {r.policy}
          {p && (
            <span className="text-[var(--qz-fg-4)]">
              {" "}
              · {PROTOCOL_LABEL[p.protocol].toLowerCase()}:{p.ports.join(",")}
            </span>
          )}
        </span>
      );
    }
    if (r.protocol) {
      return (
        <span style={{ fontFamily: "var(--qz-font-mono)", color: "var(--qz-fg-1)" }}>
          {r.protocol === "icmp" ? "ping" : r.protocol}
        </span>
      );
    }
    return <span className="text-[var(--qz-fg-4)]">Any</span>;
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Rules
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          IPv4 rules for forwarded traffic and traffic to or from the firewall itself, evaluated top to bottom — drag
          to reorder
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading firewall rules…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={load}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && (
          <div className="flex flex-col gap-3">
            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search rules…"
                  className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
                  style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[var(--qz-fg-4)]">Default action</span>
                <select
                  value={data.default_action === "accept" ? "accept" : "drop"}
                  onChange={(e) => changeDefaultAction(e.target.value as "accept" | "drop")}
                  className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
                  style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
                >
                  <option value="drop">Deny</option>
                  <option value="accept">Allow</option>
                </select>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <Button kind="secondary" size="sm" icon={RotateCw} onClick={refresh} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Refresh"}
                </Button>
                <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                  Create rule
                </Button>
                <span className="text-[12px] text-[var(--qz-fg-4)]">
                  {visibleRules.length} {visibleRules.length === 1 ? "rule" : "rules"}
                </span>
              </div>
            </div>

            {/* Pending-order bar */}
            {orderDirty && (
              <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{
                  background: "var(--qz-accent-soft)",
                  border: "1px solid color-mix(in oklab, var(--qz-accent) 30%, transparent)",
                }}
              >
                <span className="text-[13px] font-medium text-[var(--qz-fg-1)]">
                  Rule order changed — not applied yet.
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button kind="secondary" size="sm" icon={Undo2} onClick={() => setOrder(data.rules.map(ruleKey))} disabled={applyingOrder}>
                    Reset
                  </Button>
                  <Button kind="primary" size="sm" icon={Check} onClick={commitOrder} disabled={applyingOrder}>
                    {applyingOrder ? "Applying…" : "Apply order"}
                  </Button>
                </div>
              </div>
            )}

            {/* Table */}
            <div className="rounded-md overflow-hidden" style={{ border: "1px solid var(--qz-border)" }}>
              <table className="qz-table" style={{ width: "100%" }}>
                <colgroup>
                  <col style={{ width: 70 }} />
                  <col style={{ width: 100 }} />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 90 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Action</th>
                    <th>Name</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Policy</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRules.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                        {q ? "No rules match the search." : "No firewall rules configured."}
                      </td>
                    </tr>
                  ) : (
                    visibleRules.map((r) => {
                      const position = orderedRules.indexOf(r) + 1;
                      return (
                        <tr
                          key={ruleKey(r)}
                          draggable={dragEnabled}
                          onDragStart={(e) => {
                            dragIndex.current = orderedRules.indexOf(r);
                            setDragging(true);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragOver={(e) => onRowDragOver(e, orderedRules.indexOf(r))}
                          onDrop={(e) => e.preventDefault()}
                          onDragEnd={() => {
                            dragIndex.current = null;
                            setDragging(false);
                          }}
                          style={{
                            opacity: r.enabled ? 1 : 0.55,
                            cursor: dragEnabled ? (dragging ? "grabbing" : "grab") : "default",
                          }}
                        >
                          <td className="mono">
                            <span className="inline-flex items-center gap-[6px]">
                              {dragEnabled && (
                                <GripVertical size={13} className="text-[var(--qz-fg-4)] flex-shrink-0" />
                              )}
                              {position}
                            </span>
                          </td>
                          <td>
                            <ActionPill action={r.action} />
                          </td>
                          <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.name ?? <span className="text-[var(--qz-fg-4)]">—</span>}
                          </td>
                          <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <EndpointCell rule={r} side="from" autoGroups={data.auto_groups} />
                          </td>
                          <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            <EndpointCell rule={r} side="to" autoGroups={data.auto_groups} />
                          </td>
                          <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {policyCell(r)}
                          </td>
                          <td>
                            <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>
                              {r.enabled ? "Enabled" : "Disabled"}
                            </span>
                          </td>
                          <td onMouseDown={(e) => e.stopPropagation()} style={{ cursor: "default" }} className="text-right">
                            <RowActions
                              label={`rule ${r.rule}`}
                              onEdit={() => setModal({ rule: r })}
                              onDelete={() => remove(r)}
                            />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
              Forwarded traffic matching no rule falls through to the default action. Traffic to or from the Firewall
              itself is allowed unless a rule denies it.
              {q && " Reordering is disabled while a search filter is active."}
            </p>
          </div>
        )}
      </div>

      {modal && (
        <RuleFormModal
          initial={modal.rule}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          config={data}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
