"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import {
  deleteDhcpMapping,
  deleteDhcpRange,
  deleteDhcpServer,
  deleteDhcpSubnet,
  DhcpLease,
  DhcpRange,
  DhcpServer,
  DhcpServerConfig,
  DhcpStaticMapping,
  DhcpSubnet,
  fetchDhcpServer,
} from "@/lib/services";
import { useDashboard } from "@/lib/DashboardContext";
import { ServerFormModal } from "./ServerFormModal";
import { SubnetFormModal } from "./SubnetFormModal";
import { RangeFormModal } from "./RangeFormModal";
import { MappingFormModal } from "./MappingFormModal";

type Tab = "subnets" | "ranges" | "mappings" | "leases";

const TABS: { id: Tab; label: string }[] = [
  { id: "subnets", label: "Subnets" },
  { id: "ranges", label: "Ranges" },
  { id: "mappings", label: "Static Mappings" },
  { id: "leases", label: "Leases" },
];

// Rows for ranges/mappings carry their subnet context (the tables flatten
// every subnet of the selected server).
interface RangeRow {
  subnet: string;
  range: DhcpRange;
}
interface MappingRow {
  subnet: string;
  mapping: DhcpStaticMapping;
}

const dash = (v: string | null | undefined) => (v && v.length ? v : "—");

const subnetColumns: Column<DhcpSubnet>[] = [
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "default_router", header: "Gateway", value: (r) => r.default_router ?? "", render: (r) => dash(r.default_router), mono: true },
  { key: "name_servers", header: "DNS", value: (r) => r.name_servers.join(", "), render: (r) => dash(r.name_servers.join(", ")), mono: true },
  { key: "domain_name", header: "Domain", value: (r) => r.domain_name ?? "", render: (r) => dash(r.domain_name) },
  { key: "lease", header: "Lease (s)", value: (r) => r.lease ?? "", render: (r) => dash(r.lease), mono: true, sortable: true, width: 110 },
  { key: "ranges", header: "Ranges", value: (r) => r.ranges.length, mono: true, sortable: true, width: 90 },
  { key: "mappings", header: "Mappings", value: (r) => r.static_mappings.length, mono: true, sortable: true, width: 100 },
];

const rangeColumns: Column<RangeRow>[] = [
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "name", header: "Range", value: (r) => r.range.name, mono: true, sortable: true },
  { key: "start", header: "Start", value: (r) => r.range.start ?? "", render: (r) => dash(r.range.start), mono: true },
  { key: "stop", header: "Stop", value: (r) => r.range.stop ?? "", render: (r) => dash(r.range.stop), mono: true },
];

const mappingColumns: Column<MappingRow>[] = [
  { key: "name", header: "Name", value: (r) => r.mapping.name, sortable: true },
  { key: "subnet", header: "Subnet", value: (r) => r.subnet, mono: true, sortable: true },
  { key: "ip_address", header: "IP Address", value: (r) => r.mapping.ip_address ?? "", render: (r) => dash(r.mapping.ip_address), mono: true },
  { key: "mac_address", header: "MAC Address", value: (r) => r.mapping.mac_address ?? "", render: (r) => dash(r.mapping.mac_address), mono: true },
  { key: "description", header: "Description", value: (r) => r.mapping.description ?? "", render: (r) => dash(r.mapping.description) },
];

const leaseColumns: Column<DhcpLease>[] = [
  { key: "ip_address", header: "IP Address", value: (r) => r.ip_address, mono: true, sortable: true },
  { key: "mac_address", header: "MAC Address", value: (r) => r.mac_address ?? "", render: (r) => dash(r.mac_address), mono: true },
  { key: "hostname", header: "Hostname", value: (r) => r.hostname ?? "", render: (r) => dash(r.hostname) },
  {
    key: "state",
    header: "State",
    value: (r) => r.state ?? "",
    render: (r) =>
      r.state ? (
        <span className={r.state.toLowerCase() === "active" ? "badge badge-ok" : "badge badge-muted"}>{r.state}</span>
      ) : (
        "—"
      ),
    sortable: true,
    width: 110,
  },
  { key: "lease_expiration", header: "Expires", value: (r) => r.lease_expiration ?? "", render: (r) => dash(r.lease_expiration), mono: true },
  { key: "remaining", header: "Remaining", value: (r) => r.remaining ?? "", render: (r) => dash(r.remaining), mono: true },
];

export default function DhcpServerPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DhcpServerConfig>({ servers: [], leases: [] });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("subnets");
  const [confirmingServer, setConfirmingServer] = useState(false);

  // null = closed; {} = create; { <entity> } = edit.
  const [serverModal, setServerModal] = useState<{ server?: DhcpServer } | null>(null);
  const [subnetModal, setSubnetModal] = useState<{ subnet?: DhcpSubnet } | null>(null);
  const [rangeModal, setRangeModal] = useState<{ row?: RangeRow } | null>(null);
  const [mappingModal, setMappingModal] = useState<{ row?: MappingRow } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const cfg = await fetchDhcpServer();
      setData(cfg);
      setSelectedName((prev) =>
        prev && cfg.servers.some((s) => s.name === prev) ? prev : cfg.servers[0]?.name ?? null,
      );
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DHCP servers.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected: DhcpServer | null = useMemo(
    () => data.servers.find((s) => s.name === selectedName) ?? null,
    [data, selectedName],
  );

  const rangeRows: RangeRow[] = useMemo(
    () => (selected?.subnets ?? []).flatMap((s) => s.ranges.map((range) => ({ subnet: s.subnet, range }))),
    [selected],
  );

  const mappingRows: MappingRow[] = useMemo(
    () => (selected?.subnets ?? []).flatMap((s) => s.static_mappings.map((mapping) => ({ subnet: s.subnet, mapping }))),
    [selected],
  );

  // VyOS labels each lease with its shared-network "Pool"; leases with no pool show everywhere.
  const leaseRows: DhcpLease[] = useMemo(() => {
    if (!selected) return [];
    const name = selected.name.toLowerCase();
    return data.leases.filter((l) => !l.pool || l.pool.toLowerCase() === name);
  }, [data, selected]);

  const toastAfter = async (action: Promise<unknown>, ok: string, fail: string) => {
    try {
      await action;
      setToast(ok);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : fail);
    }
  };

  const removeServer = async () => {
    if (!selected) return;
    setConfirmingServer(false);
    await toastAfter(
      deleteDhcpServer(selected.name),
      `Deleted DHCP server ${selected.name} and saved to boot config.`,
      `Failed to delete DHCP server ${selected.name}.`,
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          DHCP Server
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Shared networks, their subnets, ranges, static mappings, and active leases
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading DHCP servers…</div>
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
          <div className="flex flex-col gap-5">
            {/* Server selector */}
            <div className="flex items-center gap-3 flex-wrap">
              {data.servers.length === 0 ? (
                <div className="text-[13px] text-[var(--qz-fg-4)]">No DHCP servers configured.</div>
              ) : (
                data.servers.map((s) => {
                  const active = s.name === selectedName;
                  return (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => setSelectedName(s.name)}
                      className={[
                        "flex flex-col items-start gap-[6px] px-4 py-3 rounded-lg border text-left transition-all duration-[120ms] cursor-pointer min-w-[180px]",
                        active
                          ? "bg-[var(--qz-accent-soft)] border-[color-mix(in_oklab,var(--qz-accent)_40%,transparent)]"
                          : "bg-[var(--qz-input-bg)] border-[var(--qz-border)] hover:border-[var(--qz-border-strong)]",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2">
                        <span className={["text-[14px] font-semibold", active ? "text-[var(--qz-accent)]" : "text-[var(--qz-fg-1)]"].join(" ")}>
                          {s.name}
                        </span>
                        <span className={s.enabled ? "badge badge-ok" : "badge badge-muted"}>{s.enabled ? "Enabled" : "Disabled"}</span>
                        {s.authoritative && <span className="badge badge-ok">Authoritative</span>}
                      </div>
                      <span className="text-[12px] text-[var(--qz-fg-4)]">
                        {s.subnets.length} {s.subnets.length === 1 ? "subnet" : "subnets"}
                        {s.description ? ` · ${s.description}` : ""}
                      </span>
                    </button>
                  );
                })
              )}
              <div className="ml-auto flex items-center gap-2">
                {selected && (
                  confirmingServer ? (
                    <>
                      <span className="text-[12px] text-[var(--qz-fg-3)]">Delete {selected.name}?</span>
                      <button
                        type="button"
                        onClick={removeServer}
                        className="text-[12px] font-semibold px-[10px] py-[5px] rounded cursor-pointer border-0"
                        style={{ background: "var(--qz-danger)", color: "white" }}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingServer(false)}
                        className="text-[12px] px-[10px] py-[5px] rounded cursor-pointer"
                        style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-3)" }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <Button kind="secondary" size="sm" icon={Pencil} onClick={() => setServerModal({ server: selected })}>
                        Edit server
                      </Button>
                      <Button kind="secondary" size="sm" icon={Trash2} onClick={() => setConfirmingServer(true)}>
                        Delete server
                      </Button>
                    </>
                  )
                )}
                <Button kind="primary" size="sm" icon={Plus} onClick={() => setServerModal({})}>
                  Create DHCP server
                </Button>
              </div>
            </div>

            {selected && (
              <>
                {/* Tabs */}
                <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
                  {TABS.map((t) => {
                    const counts: Record<Tab, number> = {
                      subnets: selected.subnets.length,
                      ranges: rangeRows.length,
                      mappings: mappingRows.length,
                      leases: leaseRows.length,
                    };
                    const active = tab === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTab(t.id)}
                        className={[
                          "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                          active
                            ? "text-[var(--qz-accent)] border-[var(--qz-accent)]"
                            : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                        ].join(" ")}
                      >
                        {t.label}
                        <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{counts[t.id]}</span>
                      </button>
                    );
                  })}
                </div>

                {tab === "subnets" && (
                  <DataTable
                    rows={selected.subnets}
                    columns={subnetColumns}
                    rowId={(r) => r.subnet}
                    storageKey="services-dhcp-subnets"
                    searchPlaceholder="Search subnets…"
                    emptyMessage="No subnets configured for this server."
                    onRefresh={() => load("refresh")}
                    toolbar={
                      <Button kind="primary" size="sm" icon={Plus} onClick={() => setSubnetModal({})}>
                        Create subnet
                      </Button>
                    }
                    actions={(row) => (
                      <RowActions
                        label={`subnet ${row.subnet}`}
                        onEdit={() => setSubnetModal({ subnet: row })}
                        onDelete={() =>
                          toastAfter(
                            deleteDhcpSubnet(selected.name, row.subnet),
                            `Deleted subnet ${row.subnet} and saved to boot config.`,
                            `Failed to delete subnet ${row.subnet}.`,
                          )
                        }
                      />
                    )}
                  />
                )}
                {tab === "ranges" && (
                  <DataTable
                    rows={rangeRows}
                    columns={rangeColumns}
                    rowId={(r) => `${r.subnet}/${r.range.name}`}
                    storageKey="services-dhcp-ranges"
                    searchPlaceholder="Search ranges…"
                    emptyMessage="No address ranges configured for this server."
                    onRefresh={() => load("refresh")}
                    toolbar={
                      <Button kind="primary" size="sm" icon={Plus} onClick={() => setRangeModal({})}>
                        Create range
                      </Button>
                    }
                    actions={(row) => (
                      <RowActions
                        label={`range ${row.range.name}`}
                        onEdit={() => setRangeModal({ row })}
                        onDelete={() =>
                          toastAfter(
                            deleteDhcpRange(selected.name, row.subnet, row.range.name),
                            `Deleted range ${row.range.name} and saved to boot config.`,
                            `Failed to delete range ${row.range.name}.`,
                          )
                        }
                      />
                    )}
                  />
                )}
                {tab === "mappings" && (
                  <DataTable
                    rows={mappingRows}
                    columns={mappingColumns}
                    rowId={(r) => `${r.subnet}/${r.mapping.name}`}
                    storageKey="services-dhcp-mappings"
                    searchPlaceholder="Search static mappings…"
                    emptyMessage="No static mappings configured for this server."
                    onRefresh={() => load("refresh")}
                    toolbar={
                      <Button kind="primary" size="sm" icon={Plus} onClick={() => setMappingModal({})}>
                        Create mapping
                      </Button>
                    }
                    actions={(row) => (
                      <RowActions
                        label={`mapping ${row.mapping.name}`}
                        onEdit={() => setMappingModal({ row })}
                        onDelete={() =>
                          toastAfter(
                            deleteDhcpMapping(selected.name, row.subnet, row.mapping.name),
                            `Deleted mapping ${row.mapping.name} and saved to boot config.`,
                            `Failed to delete mapping ${row.mapping.name}.`,
                          )
                        }
                      />
                    )}
                  />
                )}
                {tab === "leases" && (
                  <DataTable
                    rows={leaseRows}
                    columns={leaseColumns}
                    rowId={(r) => `${r.ip_address}/${r.mac_address ?? ""}`}
                    storageKey="services-dhcp-leases"
                    searchPlaceholder="Search leases…"
                    emptyMessage="No active leases for this server."
                    onRefresh={() => load("refresh")}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {serverModal && (
        <ServerFormModal
          initial={serverModal.server}
          existing={data.servers}
          onClose={() => setServerModal(null)}
          onSaved={(msg) => {
            setServerModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && subnetModal && (
        <SubnetFormModal
          server={selected.name}
          servers={data.servers}
          initial={subnetModal.subnet}
          onClose={() => setSubnetModal(null)}
          onSaved={(msg) => {
            setSubnetModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && rangeModal && (
        <RangeFormModal
          server={selected.name}
          servers={data.servers}
          initial={rangeModal.row}
          onClose={() => setRangeModal(null)}
          onSaved={(msg) => {
            setRangeModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {selected && mappingModal && (
        <MappingFormModal
          server={selected.name}
          servers={data.servers}
          initial={mappingModal.row}
          onClose={() => setMappingModal(null)}
          onSaved={(msg) => {
            setMappingModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
