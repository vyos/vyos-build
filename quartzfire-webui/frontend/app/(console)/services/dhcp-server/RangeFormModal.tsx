"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { applyDhcpRange, DhcpRange, DhcpServer } from "@/lib/services";

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

/// Create/edit an address range within a subnet. Renaming rebuilds the node.
export function RangeFormModal({
  server,
  servers,
  initial,
  onClose,
  onSaved,
}: {
  /** Shared network the range belongs to. */
  server: string;
  /** All shared networks, for the subnet picker and diffing. */
  servers: DhcpServer[];
  /** Present when editing; absent when creating. */
  initial?: { subnet: string; range: DhcpRange };
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const subnets = servers.find((s) => s.name === server)?.subnets ?? [];

  const [subnet, setSubnet] = useState(initial?.subnet ?? subnets[0]?.subnet ?? "");
  const [name, setName] = useState(initial?.range.name ?? "");
  const [start, setStart] = useState(initial?.range.start ?? "");
  const [stop, setStop] = useState(initial?.range.stop ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!subnet) {
      setError("Create a subnet first — ranges live inside one.");
      return;
    }
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Range name may only use letters, digits, hyphens, and underscores.");
      return;
    }
    const clash = subnets
      .find((s) => s.subnet === subnet)
      ?.ranges.some((r) => r.name === n && !(isEdit && r.name === initial!.range.name));
    if (clash) {
      setError(`Range ${n} already exists in ${subnet}.`);
      return;
    }
    if (!IPV4_RE.test(start.trim()) || !IPV4_RE.test(stop.trim())) {
      setError("Start and stop must both be IPv4 addresses.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpRange(servers, {
        server,
        subnet,
        name: n,
        start: start.trim(),
        stop: stop.trim(),
        original_name: initial?.range.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to range ${n} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply range.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Address Range`}
        subtitle={`DHCP server ${server}`}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Subnet" hint={isEdit ? "Ranges cannot move between subnets." : undefined}>
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
          <Field label="Range Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pool-1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Start">
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="192.168.1.100"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Stop">
            <input
              value={stop}
              onChange={(e) => setStop(e.target.value)}
              placeholder="192.168.1.199"
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create range"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
