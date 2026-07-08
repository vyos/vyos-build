"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { applyDhcpMapping, DhcpServer, DhcpStaticMapping } from "@/lib/services";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
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

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

/// Create/edit a static mapping (fixed IP reservation) within a subnet.
/// Renaming rebuilds the node.
export function MappingFormModal({
  server,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  /** Shared network the mapping belongs to. */
  server: string;
  /** All shared networks, for the subnet picker and diffing. */
  servers: DhcpServer[];
  /** Present when editing; absent when creating. */
  initial?: { subnet: string; mapping: DhcpStaticMapping };
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const subnets = servers.find((s) => s.name === server)?.subnets ?? [];

  const [subnet, setSubnet] = useState(initial?.subnet ?? subnets[0]?.subnet ?? "");
  const [name, setName] = useState(initial?.mapping.name ?? "");
  const [ipAddress, setIpAddress] = useState(initial?.mapping.ip_address ?? "");
  const [macAddress, setMacAddress] = useState(initial?.mapping.mac_address ?? "");
  const [description, setDescription] = useState(initial?.mapping.description ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!subnet) {
      setError("Create a subnet first — static mappings live inside one.");
      return;
    }
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Mapping name may only use letters, digits, hyphens, and underscores.");
      return;
    }
    const clash = subnets
      .find((s) => s.subnet === subnet)
      ?.static_mappings.some((m) => m.name === n && !(isEdit && m.name === initial!.mapping.name));
    if (clash) {
      setError(`Mapping ${n} already exists in ${subnet}.`);
      return;
    }
    if (!IPV4_RE.test(ipAddress.trim())) {
      setError("IP address must be an IPv4 address.");
      return;
    }
    if (!MAC_RE.test(macAddress.trim())) {
      setError("MAC address must look like aa:bb:cc:dd:ee:ff.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpMapping(servers, {
        server,
        subnet,
        name: n,
        ip_address: ipAddress.trim(),
        mac_address: macAddress.trim().toLowerCase(),
        description: description.trim() || null,
        original_name: initial?.mapping.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to mapping ${n} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply mapping.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Static Mapping`}
        subtitle={`DHCP server ${server}`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Subnet" hint={isEdit ? "Mappings cannot move between subnets." : undefined}>
            <select
              value={subnet}
              onChange={(e) => setSubnet(e.target.value)}
              disabled={isEdit}
              className={`${inputCls} cursor-pointer`}
              style={{ ...monoSt, opacity: isEdit ? 0.5 : 1 }}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {subnets.map((s) => (
                <option key={s.subnet} value={s.subnet}>
                  {s.subnet}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="printer-1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="IP Address" hint="The fixed address handed to this client.">
            <input
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              placeholder="192.168.1.50"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="MAC Address">
            <input
              value={macAddress}
              onChange={(e) => setMacAddress(e.target.value)}
              placeholder="aa:bb:cc:dd:ee:ff"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Front-office printer"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create mapping"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
