"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { fetchSystemConfig, GeneralSettings } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { GeneralFormModal } from "./GeneralFormModal";

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

function MonoValue({ value, fallback }: { value: string | null; fallback: string }) {
  if (value === null) return <span className="text-[var(--qz-fg-4)]">{fallback}</span>;
  return <span style={{ fontFamily: "var(--qz-font-mono)" }}>{value}</span>;
}

export default function GeneralSettingsPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<GeneralSettings | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setData((await fetchSystemConfig()).general);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load system settings.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          General
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Identity, DNS, time, and NTP settings of the firewall itself
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading system settings…</div>
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
          <section
            className="rounded-lg px-5 pt-2 pb-3"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
          >
            <div className="flex items-center justify-between py-2">
              <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">System Settings</h2>
              <Button kind="secondary" size="sm" icon={Pencil} onClick={() => setModal(true)}>
                Edit settings
              </Button>
            </div>
            <InfoRow label="Hostname"><MonoValue value={data.hostname} fallback="vyos (default)" /></InfoRow>
            <InfoRow label="Domain Name"><MonoValue value={data.domain_name} fallback="—" /></InfoRow>
            <InfoRow label="DNS Servers"><MonoList items={data.name_servers} /></InfoRow>
            <InfoRow label="NTP Servers"><MonoList items={data.ntp_servers} /></InfoRow>
            <InfoRow label="Time Zone"><MonoValue value={data.timezone} fallback="UTC (default)" /></InfoRow>
          </section>
        )}
      </div>

      {modal && data && (
        <GeneralFormModal
          live={data}
          onClose={() => setModal(false)}
          onSaved={(msg) => {
            setModal(false);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
