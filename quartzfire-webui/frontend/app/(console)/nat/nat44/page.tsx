"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { deleteNatRule, deleteStaticNat, fetchNat44, Nat44Config, NatRule, NatSection, StaticNatMapping } from "@/lib/nat";
import { fetchFirewall, FirewallAlias, InterfaceAlias, interfaceAliases } from "@/lib/firewall";
import { fetchEthernet, fetchInterfaceDescriptions, fetchVlans } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";
import { NatRuleFormModal } from "./NatRuleFormModal";
import { StaticNatFormModal } from "./StaticNatFormModal";

type Tab = NatSection | "static";

function StatePill({ enabled }: { enabled: boolean }) {
  return <span className={enabled ? "badge badge-ok" : "badge badge-muted"}>{enabled ? "Enabled" : "Disabled"}</span>;
}

const dash = (v: string | null) => (v && v.length ? v : "—");
// An unset match address means "any" in VyOS NAT — surface that rather than a blank dash.
const any = (v: string | null) => (v && v.length ? v : "any");

const columns: Column<NatRule>[] = [
  { key: "rule", header: "Rule", value: (r) => r.rule, mono: true, sortable: true, width: 80 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", render: (r) => dash(r.description), sortable: true },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 110 },
  { key: "source", header: "Source", value: (r) => r.source ?? r.source_group ?? "any", render: (r) => any(r.source ?? r.source_group), mono: true },
  { key: "destination", header: "Destination", value: (r) => r.destination ?? r.destination_group ?? "any", render: (r) => any(r.destination ?? r.destination_group), mono: true },
  {
    key: "translation",
    header: "Translation",
    value: (r) => r.translation ?? "",
    render: (r) => (r.translation ? `${r.translation}${r.translation_port ? `:${r.translation_port}` : ""}` : "—"),
    mono: true,
  },
  // An unset protocol means "all" in VyOS NAT — surface that rather than a blank dash.
  { key: "protocol", header: "Protocol", value: (r) => r.protocol ?? "all", mono: true, width: 90 },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 110,
  },
];

const staticColumns: Column<StaticNatMapping>[] = [
  { key: "rule", header: "Rule", value: (r) => r.rule, mono: true, sortable: true, width: 80 },
  { key: "description", header: "Description", value: (r) => r.description ?? "", render: (r) => dash(r.description), sortable: true },
  { key: "interface", header: "Interface", value: (r) => r.interface ?? "", render: (r) => dash(r.interface), mono: true, width: 110 },
  { key: "internal_address", header: "Internal Address", value: (r) => r.internal_address, mono: true },
  { key: "external_address", header: "External Address", value: (r) => r.external_address, mono: true },
  {
    key: "status",
    header: "Status",
    value: (r) => (r.enabled ? "enabled" : "disabled"),
    render: (r) => <StatePill enabled={r.enabled} />,
    sortable: true,
    width: 110,
  },
];

/// Per-row edit/delete. Delete asks for inline confirmation before applying.
function NatRowActions({ ruleNum, onEdit, onDelete }: { ruleNum: number; onEdit: () => void; onDelete: () => Promise<unknown> }) {
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
            title={`Edit rule ${ruleNum}`}
            aria-label="Edit"
            onClick={onEdit}
            className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            title={`Delete rule ${ruleNum}`}
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

export default function Nat44Page() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<Nat44Config>({ source: [], destination: [], static_nat: [] });
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [aliases, setAliases] = useState<FirewallAlias[]>([]);
  const [builtins, setBuiltins] = useState<InterfaceAlias[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("source");

  // null = closed; { section, rule: undefined } = create; { section, rule } = edit.
  const [modal, setModal] = useState<{ section: NatSection; rule?: NatRule } | null>(null);
  // null = closed; { mapping: undefined } = create; { mapping } = edit.
  const [staticModal, setStaticModal] = useState<{ mapping?: StaticNatMapping } | null>(null);

  const fetchData = useCallback(async () => {
    // Interface names and aliases populate the rule form's pickers; tolerate
    // their failure so a NAT read still renders.
    const [nat, ifs, descs, fw, eth, vlans] = await Promise.all([
      fetchNat44(),
      fetchInterfaceStats().catch(() => []),
      fetchInterfaceDescriptions().catch(() => ({})),
      fetchFirewall().catch(() => null),
      fetchEthernet().catch(() => []),
      fetchVlans().catch(() => []),
    ]);
    setData(nat);
    setInterfaces(ifs.map((i) => i.name).sort());
    setIfaceDescriptions(descs);
    setAliases(fw?.aliases ?? []);
    setBuiltins(interfaceAliases([...eth, ...vlans]));
  }, []);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      await fetchData();
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load NAT44 rules.");
      setStatus("error");
    }
  }, [fetchData]);

  useEffect(() => {
    load();
  }, [load]);

  const removeRule = async (section: NatSection, row: NatRule) => {
    try {
      await deleteNatRule(section, row.rule);
      setToast(`Deleted ${section} NAT rule ${row.rule}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete rule ${row.rule}.`);
    }
  };

  const removeStatic = async (row: StaticNatMapping) => {
    try {
      await deleteStaticNat(row.rule);
      setToast(`Deleted 1-to-1 NAT rule ${row.rule}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete rule ${row.rule}.`);
    }
  };

  const tabs: [Tab, string, number][] = [
    ["source", "Source NAT", data.source.length],
    ["destination", "Destination NAT", data.destination.length],
    ["static", "Static (1-to-1)", data.static_nat.length],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          NAT44
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          IPv4-to-IPv4 source (SNAT) and destination (DNAT) translation
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading NAT44 rules…</div>
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

            {tab === "static" ? (
              <DataTable
                rows={data.static_nat}
                columns={staticColumns}
                rowId={(r) => String(r.rule)}
                storageKey="nat-nat44-static"
                searchPlaceholder="Search mappings…"
                emptyMessage="No 1-to-1 NAT mappings configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setStaticModal({})}>
                    Create mapping
                  </Button>
                }
                actions={(row) => (
                  <NatRowActions
                    ruleNum={row.rule}
                    onEdit={() => setStaticModal({ mapping: row })}
                    onDelete={() => removeStatic(row)}
                  />
                )}
              />
            ) : (
              <DataTable
                rows={tab === "source" ? data.source : data.destination}
                columns={columns}
                rowId={(r) => String(r.rule)}
                storageKey={`nat-nat44-${tab}`}
                searchPlaceholder="Search rules…"
                emptyMessage={`No ${tab} NAT rules configured.`}
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({ section: tab })}>
                    Create rule
                  </Button>
                }
                actions={(row) => (
                  <NatRowActions
                    ruleNum={row.rule}
                    onEdit={() => setModal({ section: tab as NatSection, rule: row })}
                    onDelete={() => removeRule(tab as NatSection, row)}
                  />
                )}
              />
            )}
          </div>
        )}
      </div>

      {modal && (
        <NatRuleFormModal
          section={modal.section}
          initial={modal.rule}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          aliases={aliases}
          builtins={builtins}
          existing={modal.section === "source" ? data.source : data.destination}
          takenRules={data.static_nat.map((m) => m.rule)}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {staticModal && (
        <StaticNatFormModal
          initial={staticModal.mapping}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          existing={data.static_nat}
          takenRules={[...data.source, ...data.destination].map((r) => r.rule)}
          onClose={() => setStaticModal(null)}
          onSaved={(msg) => {
            setStaticModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
