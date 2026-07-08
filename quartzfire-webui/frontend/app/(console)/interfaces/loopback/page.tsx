"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { fetchLoopback, LoopbackInterface } from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { LoopbackFormModal } from "./LoopbackFormModal";

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

const columns: Column<LoopbackInterface>[] = [
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
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 120,
  },
];

const filters: FilterDef<LoopbackInterface>[] = [
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

export default function LoopbackPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<LoopbackInterface[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { lo: undefined } = configure `lo`; { lo } = edit.
  const [modal, setModal] = useState<{ lo?: LoopbackInterface } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setRows(await fetchLoopback());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load loopback interfaces.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // VyOS supports exactly one loopback node, `lo` — offer to configure it only
  // when it's absent from the config.
  const loMissing = !rows.some((r) => r.name === "lo");

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Loopback Interfaces
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">Loopback interfaces for stable local addressing</p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading loopback interfaces…</div>
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
            storageKey="interfaces-loopback"
            searchPlaceholder="Search loopback interfaces…"
            emptyMessage="Loopback `lo` is not in the config yet — configure it to add addresses."
            onRefresh={() => load("refresh")}
            toolbar={
              loMissing ? (
                <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                  Configure lo
                </Button>
              ) : undefined
            }
            actions={(row) => (
              <div className="inline-flex items-center justify-end">
                <button
                  type="button"
                  title={`Edit ${row.name}`}
                  aria-label="Edit"
                  onClick={() => setModal({ lo: row })}
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
        <LoopbackFormModal
          initial={modal.lo}
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
