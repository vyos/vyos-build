"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { deleteDnsDomain, DnsForwardingConfig, DnsForwardingDomain, fetchDnsForwarding } from "@/lib/services";
import { useDashboard } from "@/lib/DashboardContext";
import { SettingsFormModal } from "./SettingsFormModal";
import { DomainFormModal } from "./DomainFormModal";

const domainColumns: Column<DnsForwardingDomain>[] = [
  { key: "name", header: "Domain", value: (r) => r.name, mono: true, sortable: true },
  {
    key: "name_servers",
    header: "Name Servers",
    value: (r) => r.name_servers.join(", "),
    render: (r) => (r.name_servers.length ? r.name_servers.join(", ") : "—"),
    mono: true,
  },
];

/// One label/value line of the settings card.
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-[9px]" style={{ borderBottom: "1px solid var(--qz-border)" }}>
      <span className="text-[12px] text-[var(--qz-fg-4)] w-[200px] flex-shrink-0 pt-[1px]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] min-w-0">{children}</span>
    </div>
  );
}

function MonoList({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-[var(--qz-fg-4)]">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
      {items.map((v) => (
        <span key={v}>{v}</span>
      ))}
    </span>
  );
}

export default function DnsForwardingPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DnsForwardingConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const [settingsModal, setSettingsModal] = useState(false);
  // null = closed; { domain: undefined } = create; { domain } = edit.
  const [domainModal, setDomainModal] = useState<{ domain?: DnsForwardingDomain } | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData(await fetchDnsForwarding());
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DNS forwarding.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeDomain = async (domain: DnsForwardingDomain) => {
    try {
      await deleteDnsDomain(domain.name);
      setToast(`Deleted domain ${domain.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete domain ${domain.name}.`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          DNS Forwarding
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Recursive DNS forwarder / cache configuration
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading DNS forwarding…</div>
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
        {status === "ready" && data && (
          <div className="flex flex-col gap-7">
            <section
              className="rounded-lg px-5 pt-2 pb-3"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <div className="flex items-center justify-between py-2">
                <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Forwarder Settings</h2>
                <Button kind="secondary" size="sm" icon={Pencil} onClick={() => setSettingsModal(true)}>
                  Edit settings
                </Button>
              </div>
              <InfoRow label="Listen Addresses"><MonoList items={data.listen_addresses} /></InfoRow>
              <InfoRow label="Allow From"><MonoList items={data.allow_from} /></InfoRow>
              <InfoRow label="Upstream Name Servers"><MonoList items={data.name_servers} /></InfoRow>
              <InfoRow label="Use System Name Servers">
                <span className={data.system ? "badge badge-ok" : "badge badge-muted"}>{data.system ? "Yes" : "No"}</span>
              </InfoRow>
              <InfoRow label="Cache Size">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{data.cache_size ?? "10000 (default)"}</span>
              </InfoRow>
              <InfoRow label="DNSSEC">
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{data.dnssec ?? "process-no-validate (default)"}</span>
              </InfoRow>
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Conditional Domains</h2>
              <DataTable
                rows={data.domains}
                columns={domainColumns}
                rowId={(r) => r.name}
                storageKey="services-dns-domains"
                searchPlaceholder="Search domains…"
                emptyMessage="No conditional forwarding domains configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setDomainModal({})}>
                    Create domain
                  </Button>
                }
                actions={(row) => (
                  <RowActions
                    label={`domain ${row.name}`}
                    onEdit={() => setDomainModal({ domain: row })}
                    onDelete={() => removeDomain(row)}
                  />
                )}
              />
            </section>
          </div>
        )}
      </div>

      {settingsModal && data && (
        <SettingsFormModal
          live={data}
          onClose={() => setSettingsModal(false)}
          onSaved={(msg) => {
            setSettingsModal(false);
            setToast(msg);
            load("refresh");
          }}
        />
      )}

      {domainModal && data && (
        <DomainFormModal
          initial={domainModal.domain}
          existing={data.domains}
          onClose={() => setDomainModal(null)}
          onSaved={(msg) => {
            setDomainModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
