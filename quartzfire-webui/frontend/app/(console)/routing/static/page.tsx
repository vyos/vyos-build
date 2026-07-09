"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteStaticRoute, fetchStaticRoutes, RouteFamily, StaticRoute } from "@/lib/routing";
import { fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { StaticRouteFormModal } from "./StaticRouteFormModal";

const KIND_LABEL: Record<StaticRoute["kind"], string> = {
  gateway: "Gateway",
  interface: "Interface",
  blackhole: "Blackhole",
};

const KIND_BADGE: Record<StaticRoute["kind"], string> = {
  gateway: "badge-ok",
  interface: "badge-info",
  blackhole: "badge-muted",
};

const dash = (v: string | null) => (v && v.length ? v : "—");

const columns: Column<StaticRoute>[] = [
  { key: "destination", header: "Destination", value: (r) => r.destination, mono: true, sortable: true },
  {
    key: "kind",
    header: "Type",
    value: (r) => r.kind,
    render: (r) => <span className={`badge ${KIND_BADGE[r.kind]}`}>{KIND_LABEL[r.kind]}</span>,
    sortable: true,
    width: 110,
  },
  {
    key: "via",
    header: "Next Hop",
    value: (r) => r.via ?? "",
    render: (r) => (r.kind === "blackhole" ? "drop" : dash(r.via)),
    mono: true,
    sortable: true,
  },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 110 },
  { key: "distance", header: "Distance", value: (r) => r.distance ?? 1, mono: true, sortable: true, width: 100 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", render: (r) => dash(r.description), sortable: true },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => (
      <span className={r.enabled ? "badge badge-ok" : "badge badge-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>
    ),
    sortable: true,
    width: 110,
  },
];

export default function StaticRoutesPage() {
  const { setToast } = useDashboard();
  const [routes, setRoutes] = useState<StaticRoute[]>([]);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<RouteFamily>("ipv4");

  // null = closed; { route: undefined } = create; { route } = edit.
  const [modal, setModal] = useState<{ route?: StaticRoute } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the route form's pickers; tolerate their
      // failure so a routing read still renders.
      const [rts, ifs, descs] = await Promise.all([
        fetchStaticRoutes(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
      ]);
      setRoutes(rts);
      setInterfaces(ifs.map((i) => i.name).sort());
      setIfaceDescriptions(descs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load static routes.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => routes.filter((r) => r.family === tab), [routes, tab]);

  const remove = async (row: StaticRoute) => {
    try {
      await deleteStaticRoute(routes, row);
      setToast(`Deleted route ${row.destination} and saved to boot config.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete route ${row.destination}.`);
    }
  };

  const tabs: [RouteFamily, string, number][] = [
    ["ipv4", "IPv4", routes.filter((r) => r.family === "ipv4").length],
    ["ipv6", "IPv6", routes.filter((r) => r.family === "ipv6").length],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Static Routes
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Manually configured routes via a gateway, an interface, or a blackhole
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading static routes…</div>
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
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label, count]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={[
                      "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      active
                        ? "text-[var(--qz-accent)] border-[var(--qz-accent)]"
                        : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                    ].join(" ")}
                  >
                    {label}
                    <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{count}</span>
                  </button>
                );
              })}
            </div>

            <DataTable
              rows={rows}
              columns={columns}
              rowId={(r) => `${r.destination}|${r.kind}|${r.via ?? ""}`}
              storageKey={`routing-static-${tab}`}
              searchPlaceholder="Search routes…"
              emptyMessage={`No ${tab === "ipv4" ? "IPv4" : "IPv6"} static routes configured.`}
              onRefresh={() => load("refresh")}
              toolbar={
                <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                  Create route
                </Button>
              }
              actions={(row) => (
                <RowActions
                  label={`route ${row.destination}`}
                  onEdit={() => setModal({ route: row })}
                  onDelete={() => remove(row)}
                />
              )}
            />
          </div>
        )}
      </div>

      {modal && (
        <StaticRouteFormModal
          family={tab}
          initial={modal.route}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          existing={routes}
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
