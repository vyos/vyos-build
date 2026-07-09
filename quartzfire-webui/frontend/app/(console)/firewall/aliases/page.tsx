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
} from "@/lib/firewall";
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

export default function FirewallAliasesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>(emptyFirewallConfig);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { alias: undefined } = create; { alias } = edit.
  const [modal, setModal] = useState<{ alias?: FirewallAlias } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData(await fetchFirewall());
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

  const remove = async (alias: FirewallAlias) => {
    const rules = usedBy(alias);
    if (rules.length > 0) {
      setToast(`Cannot delete ${alias.name} — used by rule${rules.length === 1 ? "" : "s"} ${rules.join(", ")}.`);
      return;
    }
    try {
      await deleteAlias(alias);
      setToast(`Deleted alias ${alias.name} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete alias ${alias.name}.`);
    }
  };

  const columns: Column<FirewallAlias>[] = [
    { key: "name", header: "Name", value: (a) => a.name, mono: true, sortable: true, width: 180 },
    {
      key: "type",
      header: "Type",
      value: (a) => a.type,
      render: (a) => <TypePill type={a.type} />,
      sortable: true,
      width: 110,
    },
    {
      key: "members",
      header: "Members",
      value: (a) => a.members.join(", "),
      render: (a) => (a.members.length ? a.members.join(", ") : "—"),
      mono: true,
    },
    {
      key: "description",
      header: "Description",
      value: (a) => a.description ?? "",
      render: (a) => a.description ?? "—",
      sortable: true,
    },
    {
      key: "used",
      header: "In Use",
      value: (a) => usedBy(a).length,
      render: (a) => {
        const n = usedBy(a).length;
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

  const filters: FilterDef<FirewallAlias>[] = [
    {
      key: "type",
      label: "Type",
      options: (Object.keys(ALIAS_GROUP) as AliasType[]).map((t) => ({ value: t, label: ALIAS_GROUP[t].label })),
      predicate: (a, v) => a.type === v,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Aliases
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Named hosts, networks, and FQDNs used as From/To targets in firewall rules
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
            rows={data.aliases}
            columns={columns}
            rowId={(a) => `${a.type}:${a.name}`}
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
            actions={(row) => (
              <RowActions
                label={`alias ${row.name}`}
                onEdit={() => setModal({ alias: row })}
                onDelete={() => remove(row)}
              />
            )}
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
