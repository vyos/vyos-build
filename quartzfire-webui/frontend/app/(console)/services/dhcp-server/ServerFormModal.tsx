"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyDhcpServer, DhcpServer } from "@/lib/services";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
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

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/// Create/edit a DHCP shared network. The name is the config-node identity, so
/// it is locked while editing.
export function ServerFormModal({
  initial,
  existing,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing shared network; absent when creating. */
  initial?: DhcpServer;
  /** All existing shared networks, for duplicate detection and diffing. */
  existing: DhcpServer[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [authoritative, setAuthoritative] = useState(initial?.authoritative ?? true);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setError("Name must start with a letter and use only letters, digits, hyphens, and underscores.");
      return;
    }
    if (!isEdit && existing.some((s) => s.name === n)) {
      setError(`A DHCP server named ${n} already exists.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDhcpServer(existing, {
        name: n,
        description: description.trim() || null,
        authoritative,
        enabled,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to DHCP server ${n} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply DHCP server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} DHCP Server`}
        subtitle="A shared network grouping one or more subnets"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint={isEdit ? "The name is the config identity and cannot be changed." : undefined}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LAN"
            disabled={isEdit}
            className={inputCls}
            style={{ ...monoSt, opacity: isEdit ? 0.5 : 1 }}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Office LAN pool"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={authoritative} onChange={setAuthoritative} />
          <span className="text-[13px] text-[var(--qz-fg-2)]">Authoritative — answer clients as the definitive server for these subnets</span>
        </label>

        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
        </label>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create server"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
