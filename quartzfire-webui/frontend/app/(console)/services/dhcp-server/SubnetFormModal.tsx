"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { applyDhcpSubnet, DhcpServer, DhcpSubnet } from "@/lib/services";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
    </div>
  );
}

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/// Create/edit a subnet within a DHCP shared network. The CIDR is the
/// config-node identity, so it is locked while editing.
export function SubnetFormModal({
  server,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  /** Shared network the subnet belongs to. */
  server: string;
  /** All shared networks, for diffing and subnet-id assignment. */
  servers: DhcpServer[];
  /** Present when editing an existing subnet; absent when creating. */
  initial?: DhcpSubnet;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [subnet, setSubnet] = useState(initial?.subnet ?? "");
  const [gateway, setGateway] = useState(initial?.default_router ?? "");
  const [nameServersText, setNameServersText] = useState(initial?.name_servers.join("\n") ?? "");
  const [domainName, setDomainName] = useState(initial?.domain_name ?? "");
  const [lease, setLease] = useState(initial?.lease ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const cidr = subnet.trim();
    if (!CIDR_RE.test(cidr)) {
      setError("Subnet must be an IPv4 network in CIDR notation (e.g. 192.168.1.0/24).");
      return;
    }
    const taken = servers.find((s) => s.name === server)?.subnets.some((n) => n.subnet === cidr) ?? false;
    if (!isEdit && taken) {
      setError(`Subnet ${cidr} already exists on this server.`);
      return;
    }
    if (gateway.trim() && !IPV4_RE.test(gateway.trim())) {
      setError("Gateway must be an IPv4 address.");
      return;
    }
    const nameServers = nameServersText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const badNs = nameServers.find((s) => !IPV4_RE.test(s));
    if (badNs) {
      setError(`"${badNs}" is not a valid name server address.`);
      return;
    }
    if (lease.trim() && !/^\d+$/.test(lease.trim())) {
      setError("Lease time must be a whole number of seconds.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpSubnet(servers, {
        server,
        subnet: cidr,
        default_router: gateway.trim() || null,
        name_servers: nameServers,
        domain_name: domainName.trim() || null,
        lease: lease.trim() || null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to subnet ${cidr}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply subnet.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Subnet`}
        subtitle={`DHCP server ${server}`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Subnet" hint={isEdit ? "The CIDR is the config identity and cannot be changed." : undefined}>
            <input
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              placeholder="192.168.1.0/24"
              disabled={isEdit}
              className={inputCls}
              style={{ ...monoSt, opacity: isEdit ? 0.5 : 1 }}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Gateway" hint="Handed to clients as their default router.">
            <input
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              placeholder="192.168.1.1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <Field label="DNS Servers" hint="One IPv4 address per line, handed to clients.">
          <textarea
            value={nameServersText}
            onChange={(e) => setNameServersText(e.target.value)}
            placeholder={"192.168.1.1\n1.1.1.1"}
            rows={3}
            className={`${inputCls} resize-y`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Domain Name">
            <input
              value={domainName}
              onChange={(e) => setDomainName(e.target.value)}
              placeholder="lan.example.com"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Lease (seconds)" hint="Defaults to 86400 (24h) when unset.">
            <input
              type="number"
              min={1}
              value={lease}
              onChange={(e) => setLease(e.target.value)}
              placeholder="86400"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create subnet"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
