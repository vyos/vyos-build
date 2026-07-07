"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { EthernetInterface, fetchEthernet, fetchPhysicalEthernet } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { EthernetFormModal } from "./EthernetFormModal";

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

const columns: Column<EthernetInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 130 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  {
    key: "addresses",
    header: "IP Address",
    value: (r) => r.addresses.join(", "),
    render: (r) => (r.addresses.length ? r.addresses.join(", ") : "—"),
    mono: true,
  },
  { key: "mtu", header: "MTU", value: (r) => r.mtu, mono: true, sortable: true, width: 80 },
  { key: "hw_id", header: "MAC", value: (r) => r.hw_id ?? "", mono: true, width: 150 },
  { key: "vlan_count", header: "VLANs", value: (r) => r.vlan_count, mono: true, sortable: true, width: 80 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<EthernetInterface>[] = [
  {
    key: "status",
    label: "Status",
    options: [
      { value: "enabled", label: "Enabled" },
      { value: "disabled", label: "Disabled" },
    ],
    predicate: (r, v) => (v === "enabled" ? r.enabled : !r.enabled),
  },
];

export default function EthernetPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<EthernetInterface[]>([]);
  const [physical, setPhysical] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { eth: undefined } = add; { eth } = edit.
  const [modal, setModal] = useState<{ eth?: EthernetInterface } | null>(null);

  const fetchData = useCallback(async () => {
    const [eths, phys] = await Promise.all([fetchEthernet(), fetchPhysicalEthernet()]);
    setRows(eths);
    setPhysical(phys);
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  // Physical NICs that have no configured interface yet — the only ones addable.
  const freeNames = useMemo(
    () => physical.filter((p) => !rows.some((r) => r.name === p)),
    [physical, rows],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-5 pb-2 flex-shrink-0">
        <p className="text-[13px] text-[var(--qz-fg-4)] m-0">Physical ethernet interfaces</p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px] pt-3">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading interfaces…</div>
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
            storageKey="interfaces-ethernet"
            searchPlaceholder="Search interfaces…"
            emptyMessage="No ethernet interfaces configured."
            onRefresh={() => load("refresh")}
            toolbar={
              <span title={freeNames.length === 0 ? "No free physical interfaces available" : undefined}>
                <Button
                  kind="primary"
                  size="sm"
                  icon={Plus}
                  onClick={() => setModal({})}
                  disabled={freeNames.length === 0}
                >
                  Add interface
                </Button>
              </span>
            }
            actions={(row) => (
              <div className="inline-flex items-center justify-end">
                <button
                  type="button"
                  title={`Edit ${row.name}`}
                  aria-label="Edit"
                  onClick={() => setModal({ eth: row })}
                  className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
                >
                  <Pencil size={14} />
                </button>
              </div>
            )}
          />
        )}
      </div>

      {modal && (
        <EthernetFormModal
          initial={modal.eth}
          freeNames={freeNames}
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
