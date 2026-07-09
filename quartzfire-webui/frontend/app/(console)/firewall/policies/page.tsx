"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import {
  deletePolicy,
  fetchFirewall,
  FirewallConfig,
  FirewallPolicy,
  policyUsage,
  PolicyProtocol,
  PROTOCOL_LABEL,
} from "@/lib/firewall";
import { useDashboard } from "@/lib/DashboardContext";
import { RowActions } from "@/components/dashboard/RowActions";
import { PolicyFormModal } from "./PolicyFormModal";

function ProtocolPill({ protocol }: { protocol: PolicyProtocol }) {
  return <span className="badge badge-info">{PROTOCOL_LABEL[protocol]}</span>;
}

export default function FirewallPoliciesPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<FirewallConfig>({
    aliases: [],
    policies: [],
    rules: [],
    auto_groups: [],
    group_names: [],
    default_action: null,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { policy: undefined } = create; { policy } = edit.
  const [modal, setModal] = useState<{ policy?: FirewallPolicy } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData(await fetchFirewall());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load firewall policies.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usedBy = (p: FirewallPolicy) => policyUsage(data.rules, p.name);

  const remove = async (p: FirewallPolicy) => {
    const rules = usedBy(p);
    if (rules.length > 0) {
      setToast(`Cannot delete ${p.name} — used by rule${rules.length === 1 ? "" : "s"} ${rules.join(", ")}.`);
      return;
    }
    try {
      await deletePolicy(p.name);
      setToast(`Deleted policy ${p.name} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete policy ${p.name}.`);
    }
  };

  const columns: Column<FirewallPolicy>[] = [
    { key: "name", header: "Name", value: (p) => p.name, mono: true, sortable: true, width: 180 },
    {
      key: "protocol",
      header: "Protocol",
      value: (p) => p.protocol,
      render: (p) => <ProtocolPill protocol={p.protocol} />,
      sortable: true,
      width: 110,
    },
    {
      key: "ports",
      header: "Ports",
      value: (p) => p.ports.join(", "),
      render: (p) => (p.ports.length ? p.ports.join(", ") : "—"),
      mono: true,
    },
    {
      key: "description",
      header: "Description",
      value: (p) => p.description ?? "",
      render: (p) => p.description ?? "—",
      sortable: true,
    },
    {
      key: "used",
      header: "In Use",
      value: (p) => usedBy(p).length,
      render: (p) => {
        const n = usedBy(p).length;
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

  const filters: FilterDef<FirewallPolicy>[] = [
    {
      key: "protocol",
      label: "Protocol",
      options: (Object.keys(PROTOCOL_LABEL) as PolicyProtocol[]).map((p) => ({ value: p, label: PROTOCOL_LABEL[p] })),
      predicate: (p, v) => p.protocol === v,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Policies
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Named TCP/UDP port sets (HTTP, DNS, …) applied by firewall rules
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading policies…</div>}
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
            rows={data.policies}
            columns={columns}
            rowId={(p) => p.name}
            filters={filters}
            storageKey="firewall-policies"
            searchPlaceholder="Search policies…"
            emptyMessage="No policies defined."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                Create policy
              </Button>
            }
            actions={(row) => (
              <RowActions
                label={`policy ${row.name}`}
                onEdit={() => setModal({ policy: row })}
                onDelete={() => remove(row)}
              />
            )}
          />
        )}
      </div>

      {modal && (
        <PolicyFormModal
          initial={modal.policy}
          existing={data.policies}
          rules={data.rules}
          usedByRules={modal.policy ? usedBy(modal.policy) : []}
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
