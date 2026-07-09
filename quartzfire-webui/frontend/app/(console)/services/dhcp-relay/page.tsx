"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { addDhcpRelayEntry, deleteDhcpRelayEntry, DhcpRelayConfig, fetchDhcpRelay } from "@/lib/services";
import { fetchInterfaceDescriptions } from "@/lib/interfaces";
import { fetchInterfaceStats } from "@/lib/vyos";
import { useDashboard } from "@/lib/DashboardContext";

type EntryKind = "interface" | "server";

interface NameRow {
  value: string;
}

const interfaceColumns: Column<NameRow>[] = [
  { key: "value", header: "Interface", value: (r) => r.value, mono: true, sortable: true },
];

const serverColumns: Column<NameRow>[] = [
  { key: "value", header: "Upstream Server", value: (r) => r.value, mono: true, sortable: true },
];

/// Delete-only row action with inline confirmation (relay entries are single
/// values — there is nothing to edit).
function DeleteAction({ label, onDelete }: { label: string; onDelete: () => Promise<unknown> }) {
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
        <button
          type="button"
          title={`Delete ${label}`}
          aria-label="Delete"
          onClick={() => setConfirming(true)}
          className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

const KIND_META: Record<EntryKind, { title: string; label: string; hint: string; placeholder: string }> = {
  interface: {
    title: "Add Listen Interface",
    label: "Interface",
    hint: "The relay listens for DHCP requests on this interface.",
    placeholder: "eth1",
  },
  server: {
    title: "Add Upstream Server",
    label: "Server Address",
    hint: "DHCP requests are forwarded to this server.",
    placeholder: "10.0.0.5",
  },
};

/// Add one relay listen interface or upstream server.
function AddEntryModal({
  kind,
  interfaces,
  descriptions,
  existing,
  onClose,
  onSaved,
}: {
  kind: EntryKind;
  /** Interface names offered as a datalist when adding an interface. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the datalist entries. */
  descriptions?: Record<string, string>;
  existing: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const meta = KIND_META[kind];
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const v = value.trim();
    if (!v) {
      setError(`${meta.label} is required.`);
      return;
    }
    if (existing.includes(v)) {
      setError(`${v} is already configured.`);
      return;
    }

    setSaving(true);
    try {
      await addDhcpRelayEntry(kind, v);
      onSaved(`Added DHCP relay ${kind} ${v}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply change.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader title={meta.title} subtitle="DHCP relay" onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        {kind === "interface" && (
          <datalist id="dhcp-relay-interfaces">
            {interfaces.map((n) => (
              <option key={n} value={n} label={descriptions?.[n]} />
            ))}
          </datalist>
        )}
        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{meta.label}</label>
          <input
            list={kind === "interface" ? "dhcp-relay-interfaces" : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            autoFocus
            className="w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)", fontFamily: "var(--qz-font-mono)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
          />
          <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{meta.hint}</p>
        </div>

        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Applying…" : "Add"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export default function DhcpRelayPage() {
  const { setToast } = useDashboard();
  const [data, setData] = useState<DhcpRelayConfig>({ interfaces: [], servers: [] });
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ifaceDescriptions, setIfaceDescriptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState<EntryKind | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Interface names populate the add form's picker; tolerate their failure
      // so the relay read still renders.
      const [relay, ifs, descs] = await Promise.all([
        fetchDhcpRelay(),
        fetchInterfaceStats().catch(() => []),
        fetchInterfaceDescriptions().catch(() => ({})),
      ]);
      setData(relay);
      setInterfaces(ifs.map((i) => i.name).sort());
      setIfaceDescriptions(descs);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load DHCP relay.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (kind: EntryKind, value: string) => {
    try {
      await deleteDhcpRelayEntry(kind, value);
      setToast(`Deleted DHCP relay ${kind} ${value}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete ${value}.`);
    }
  };

  const interfaceRows: NameRow[] = useMemo(() => data.interfaces.map((value) => ({ value })), [data]);
  const serverRows: NameRow[] = useMemo(() => data.servers.map((value) => ({ value })), [data]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          DHCP Relay
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Forward DHCP requests to upstream servers across subnets
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading DHCP relay…</div>
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
          <div className="flex flex-col gap-7">
            <section className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Listen Interfaces</h2>
              <DataTable
                rows={interfaceRows}
                columns={interfaceColumns}
                rowId={(r) => r.value}
                storageKey="services-dhcp-relay-interfaces"
                searchPlaceholder="Search interfaces…"
                emptyMessage="No relay interfaces configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal("interface")}>
                    Add interface
                  </Button>
                }
                actions={(row) => (
                  <DeleteAction label={`interface ${row.value}`} onDelete={() => remove("interface", row.value)} />
                )}
              />
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Upstream Servers</h2>
              <DataTable
                rows={serverRows}
                columns={serverColumns}
                rowId={(r) => r.value}
                storageKey="services-dhcp-relay-servers"
                searchPlaceholder="Search servers…"
                emptyMessage="No upstream servers configured."
                onRefresh={() => load("refresh")}
                toolbar={
                  <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal("server")}>
                    Add server
                  </Button>
                }
                actions={(row) => (
                  <DeleteAction label={`server ${row.value}`} onDelete={() => remove("server", row.value)} />
                )}
              />
            </section>
          </div>
        )}
      </div>

      {modal && (
        <AddEntryModal
          kind={modal}
          interfaces={interfaces}
          descriptions={ifaceDescriptions}
          existing={modal === "interface" ? data.interfaces : data.servers}
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
