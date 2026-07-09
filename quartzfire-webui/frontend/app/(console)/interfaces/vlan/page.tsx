"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { deleteVlan, fetchEthernet, fetchVlans, VlanInterface } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { VlanFormModal } from "./VlanFormModal";

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

const columns: Column<VlanInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 140 },
  { key: "vlan_id", header: "VLAN ID", value: (r) => r.vlan_id, mono: true, sortable: true, width: 90 },
  { key: "parent", header: "Parent", value: (r) => r.parent, mono: true, sortable: true, width: 110 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "addresses",
    header: "IP Address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : "—"),
    mono: true,
  },
  { key: "mtu", header: "MTU", value: (r) => r.mtu, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

/// Per-row edit/delete. Delete asks for inline confirmation before applying.
function VlanRowActions({ row, onEdit, onDelete }: { row: VlanInterface; onEdit: () => void; onDelete: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  return (
    <div className="inline-flex items-center gap-1 justify-end">
      {confirming ? (
        <>
          <button
            type="button"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try {
                await onDelete();
              } finally {
                setWorking(false);
                setConfirming(false);
              }
            }}
            className="text-[12px] font-semibold px-[10px] py-[5px] rounded cursor-pointer border-0 disabled:opacity-60"
            style={{ background: "var(--qz-danger)", color: "white" }}
          >
            {working ? "…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-[12px] px-[10px] py-[5px] rounded cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-3)" }}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            title={`Edit ${row.name}`}
            aria-label="Edit"
            onClick={onEdit}
            className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            title={`Delete ${row.name}`}
            aria-label="Delete"
            onClick={() => setConfirming(true)}
            className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </div>
  );
}

export default function VlanPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<VlanInterface[]>([]);
  const [parents, setParents] = useState<string[]>([]);
  const [parentDescriptions, setParentDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { vlan: undefined } = create; { vlan } = edit.
  const [modal, setModal] = useState<{ vlan?: VlanInterface } | null>(null);

  const fetchData = useCallback(async () => {
    const [vlans, eths] = await Promise.all([fetchVlans(), fetchEthernet()]);
    setRows(vlans);
    setParents(eths.map((e) => e.name).sort());
    setParentDescriptions(
      Object.fromEntries(eths.filter((e) => e.description).map((e) => [e.name, e.description!])),
    );
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load VLAN interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  const removeVlan = async (row: VlanInterface) => {
    try {
      await deleteVlan(row.parent, row.vlan_id);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  // Parent filter options are derived from the data.
  const filters: FilterDef<VlanInterface>[] = useMemo(() => {
    const fromRows = Array.from(new Set(rows.map((r) => r.parent)));
    return [
      {
        key: "status",
        label: "Status",
        options: [
          { value: "enabled", label: "Enabled" },
          { value: "disabled", label: "Disabled" },
        ],
        predicate: (r, v) => (v === "enabled" ? r.enabled : !r.enabled),
      },
      {
        key: "parent",
        label: "Parent",
        options: fromRows.sort().map((p) => ({ value: p, label: p })),
        predicate: (r, v) => r.parent === v,
      },
    ];
  }, [rows]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          VLAN Interfaces
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">802.1Q VLAN sub-interfaces</p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading VLAN interfaces…</div>
        )}
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
            filters={filters}
            rowId={(r) => r.name}
            storageKey="interfaces-vlan"
            searchPlaceholder="Search VLANs…"
            emptyMessage="No VLAN interfaces configured."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                Create VLAN
              </Button>
            }
            actions={(row) => (
              <VlanRowActions
                row={row}
                onEdit={() => setModal({ vlan: row })}
                onDelete={() => removeVlan(row)}
              />
            )}
          />
        )}
      </div>

      {modal && (
        <VlanFormModal
          initial={modal.vlan}
          parents={parents}
          descriptions={parentDescriptions}
          existing={rows}
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
