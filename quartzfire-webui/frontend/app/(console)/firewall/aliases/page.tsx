"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import {
  ALIAS_GROUP,
  aliasUsage,
  AliasType,
  deleteAlias,
  emptyFirewallConfig,
  fetchFirewall,
  FirewallAlias,
  FirewallConfig,
  InterfaceAlias,
  interfaceAliases,
  interfaceUsage,
} from "@/lib/firewall";
import { fetchEthernet, fetchVlans } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { AliasFormModal } from "./AliasFormModal";

const TYPE_BADGE: Record<AliasType, string> = {
  host: "badge-info",
  network: "badge-ok",
  fqdn: "badge-warn",
};

function TypePill({ type }: { type: AliasType }) {
  return <span className={`badge ${TYPE_BADGE[type]}`}>{ALIAS_GROUP[type].label}</span>;
}

/// Table row: a user-defined alias, or a built-in one derived from a
/// configured interface (named by the interface description, edited by
/// editing the interface).
type AliasRow = { kind: "user"; alias: FirewallAlias } | { kind: "builtin"; alias: InterfaceAlias };

export default function FirewallAliasesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>(emptyFirewallConfig);
  const [builtins, setBuiltins] = useState<InterfaceAlias[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { alias: undefined } = create; { alias } = edit.
  const [modal, setModal] = useState<{ alias?: FirewallAlias } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface reads back the built-in aliases; tolerate their failure so
      // the user-defined aliases still render.
      const [fw, eth, vlans] = await Promise.all([
        fetchFirewall(),
        fetchEthernet().catch(() => []),
        fetchVlans().catch(() => []),
      ]);
      setData(fw);
      setBuiltins(interfaceAliases([...eth, ...vlans]));
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall aliases.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usedBy = (alias: FirewallAlias) => aliasUsage(data.rules, data.auto_groups, alias);
  const rowUsage = (r: AliasRow) =>
    r.kind === "user" ? usedBy(r.alias) : interfaceUsage(data.rules, data.auto_groups, r.alias.iface);

  const rows: AliasRow[] = [
    ...data.aliases.map((alias): AliasRow => ({ kind: "user", alias })),
    ...builtins.map((alias): AliasRow => ({ kind: "builtin", alias })),
  ];

  const remove = async (alias: FirewallAlias) => {
    const rules = usedBy(alias);
    if (rules.length > 0) {
      setToast(`Cannot delete ${alias.display} — used by rule${rules.length === 1 ? "" : "s"} ${rules.join(", ")}.`);
      return;
    }
    try {
      await deleteAlias(alias);
      setToast(`Deleted alias ${alias.display} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete alias ${alias.display}.`);
    }
  };

  const columns: Column<AliasRow>[] = [
    {
      key: "name",
      header: "Name",
      value: (r) => r.alias.display,
      render: (r) => (
        <span title={r.kind === "user" ? `Device name: ${r.alias.name}` : `Interface ${r.alias.iface}`}>
          {r.alias.display}
        </span>
      ),
      mono: true,
      sortable: true,
      width: 180,
    },
    {
      key: "type",
      header: "Type",
      value: (r) => (r.kind === "user" ? r.alias.type : "interface"),
      render: (r) =>
        r.kind === "user" ? <TypePill type={r.alias.type} /> : <span className="badge badge-muted">Interface</span>,
      sortable: true,
      width: 110,
    },
    {
      key: "members",
      header: "Members",
      value: (r) => (r.kind === "user" ? r.alias.members.join(", ") : r.alias.iface),
      render: (r) => (r.kind === "user" ? (r.alias.members.length ? r.alias.members.join(", ") : "—") : r.alias.iface),
      mono: true,
    },
    {
      key: "description",
      header: "Description",
      value: (r) => (r.kind === "user" ? r.alias.description ?? "" : "Built-in"),
      render: (r) =>
        r.kind === "user" ? (
          r.alias.description ?? "—"
        ) : (
          <span className="text-[var(--qz-fg-4)]">Built-in — edit under Interfaces</span>
        ),
      sortable: true,
    },
    {
      key: "used",
      header: "In Use",
      value: (r) => rowUsage(r).length,
      render: (r) => {
        const n = rowUsage(r).length;
        return n > 0 ? (
          <span className="badge badge-ok">{n} rule{n === 1 ? "" : "s"}</span>
        ) : (
          <span className="badge badge-muted">unused</span>
        );
      },
      sortable: true,
      width: 110,
    },
  ];

  const filters: FilterDef<AliasRow>[] = [
    {
      key: "type",
      label: "Type",
      options: [
        ...(Object.keys(ALIAS_GROUP) as AliasType[]).map((t) => ({ value: t, label: ALIAS_GROUP[t].label })),
        { value: "interface", label: "Interface" },
      ],
      predicate: (r, v) => (v === "interface" ? r.kind === "builtin" : r.kind === "user" && r.alias.type === v),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Aliases
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Named hosts, networks, and FQDNs used as From/To targets in firewall rules — every configured interface
          and VLAN gets a built-in alias named by its description
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading aliases…</div>}
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
          <DataTable
            rows={rows}
            columns={columns}
            rowId={(r) => (r.kind === "user" ? `${r.alias.type}:${r.alias.name}` : `iface:${r.alias.iface}`)}
            filters={filters}
            storageKey="firewall-aliases"
            searchPlaceholder="Search aliases…"
            emptyMessage="No aliases defined."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                Create alias
              </Button>
            }
            actions={(row) =>
              row.kind === "user" ? (
                <RowActions
                  label={`alias ${row.alias.display}`}
                  onEdit={() => setModal({ alias: row.alias })}
                  onDelete={() => remove(row.alias)}
                />
              ) : null
            }
          />
        )}
      </div>

      {modal && (
        <AliasFormModal
          initial={modal.alias}
          existing={data.aliases}
          usedByRules={modal.alias ? usedBy(modal.alias) : []}
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
