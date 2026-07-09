"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import {
  BondInterface,
  BridgeInterface,
  deleteBond,
  fetchBonds,
  fetchBridges,
  fetchEthernet,
  fetchPhysicalEthernet,
} from "@/lib/interfaces";
import { useDashboard } from "@/lib/DashboardContext";
import { BondFormModal } from "./BondFormModal";

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

const columns: Column<BondInterface>[] = [
  { key: "name", header: "Interface", value: (r) => r.name, mono: true, sortable: true, width: 120 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", sortable: true },
  { key: "mode", header: "Mode", value: (r) => r.mode ?? "802.3ad", mono: true, sortable: true, width: 140 },
  {
    key: "members",
    header: "Members",
    value: (r) => r.members.join(", "),
    render: (r) => (r.members.length ? r.members.join(", ") : "—"),
    mono: true,
  },
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

const filters: FilterDef<BondInterface>[] = [
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

/// Per-row edit/delete. Delete asks for inline confirmation before applying.
function BondRowActions({ row, onEdit, onDelete }: { row: BondInterface; onEdit: () => void; onDelete: () => Promise<unknown> }) {
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

export default function BondingPage() {
  const { setToast } = useDashboard();
  const [rows, setRows] = useState<BondInterface[]>([]);
  const [bridges, setBridges] = useState<BridgeInterface[]>([]);
  const [ethNames, setEthNames] = useState<string[]>([]);
  const [addressedEth, setAddressedEth] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { bond: undefined } = create; { bond } = edit.
  const [modal, setModal] = useState<{ bond?: BondInterface; candidates: string[] } | null>(null);

  const fetchData = useCallback(async () => {
    const [bonds, brs, physical, eths] = await Promise.all([
      fetchBonds(),
      fetchBridges(),
      fetchPhysicalEthernet(),
      fetchEthernet(),
    ]);
    setRows(bonds);
    setBridges(brs);
    setEthNames([...new Set([...physical.map((p) => p.name), ...eths.map((e) => e.name)])].sort());
    setAddressedEth(eths.filter((e) => e.addresses.length > 0).map((e) => e.name));
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load bond interfaces.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  /// Ethernet interfaces free to enslave: not addressed, not in a bridge, not
  /// in another bond (the bond being edited keeps its own members selectable).
  const openModal = (bond?: BondInterface) => {
    const taken = new Set<string>([
      ...addressedEth,
      ...bridges.flatMap((b) => b.members),
      ...rows.filter((b) => b.name !== bond?.name).flatMap((b) => b.members),
    ]);
    setModal({ bond, candidates: ethNames.filter((n) => !taken.has(n)) });
  };

  const removeBond = async (row: BondInterface) => {
    try {
      await deleteBond(row.name);
      setToast(`Deleted ${row.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${row.name}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Bonding Interfaces
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">Link aggregation (bonding) interfaces</p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading bond interfaces…</div>
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
            storageKey="interfaces-bonding"
            searchPlaceholder="Search bonds…"
            emptyMessage="No bond interfaces configured."
            onRefresh={() => load("refresh")}
            toolbar={
              <Button kind="primary" size="sm" icon={Plus} onClick={() => openModal()}>
                Create bond
              </Button>
            }
            actions={(row) => (
              <BondRowActions
                row={row}
                onEdit={() => openModal(row)}
                onDelete={() => removeBond(row)}
              />
            )}
          />
        )}
      </div>

      {modal && (
        <BondFormModal
          initial={modal.bond}
          candidates={modal.candidates}
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
