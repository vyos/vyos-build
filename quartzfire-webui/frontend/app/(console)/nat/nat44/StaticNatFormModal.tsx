"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyStaticNat, StaticNatMapping } from "@/lib/nat";

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

/// Create/edit a 1-to-1 (static) NAT mapping — a paired source + destination
/// rule applied in one transaction and saved to the boot config.
export function StaticNatFormModal({
  initial,
  interfaces,
  descriptions,
  existing,
  takenRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing mapping; absent when creating. */
  initial?: StaticNatMapping;
  /** Interface names offered as a datalist for the interface field. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the datalist entries. */
  descriptions?: Record<string, string>;
  /** Existing mappings, for duplicate rule-number detection. */
  existing: StaticNatMapping[];
  /** Rule numbers used by plain source/destination rules (unavailable here). */
  takenRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [rule, setRule] = useState(initial ? String(initial.rule) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iface, setIface] = useState(initial?.interface ?? "");
  const [internalAddress, setInternalAddress] = useState(initial?.internal_address ?? "");
  const [externalAddress, setExternalAddress] = useState(initial?.external_address ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const num = Number(rule);
    if (!Number.isInteger(num) || num < 1 || num > 999999) {
      setError("Rule number must be a whole number between 1 and 999999.");
      return;
    }
    if (!internalAddress.trim() || !externalAddress.trim()) {
      setError("Internal and external addresses are both required.");
      return;
    }
    // Block collisions with another mapping (allow re-saving the edited one).
    const clash = existing.some((m) => m.rule === num && !(isEdit && m.rule === initial!.rule));
    if (clash) {
      setError(`Rule ${num} already exists.`);
      return;
    }
    if (takenRules.includes(num)) {
      setError(`Rule ${num} is already used by a source or destination NAT rule.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyStaticNat({
        rule: num,
        description: description.trim() || null,
        interface: iface.trim() || null,
        internal_address: internalAddress.trim(),
        external_address: externalAddress.trim(),
        enabled,
        original_rule: initial?.rule ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to 1-to-1 NAT rule ${num}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply mapping.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} 1-to-1 NAT Mapping`}
        subtitle="Bidirectional static IPv4 mapping (paired SNAT + DNAT)"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="static-nat-interfaces">
          {interfaces.map((n) => (
            <option key={n} value={n} label={descriptions?.[n]} />
          ))}
        </datalist>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Rule Number">
            <input
              type="number"
              min={1}
              max={999999}
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              placeholder="100"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Interface" hint="Optional — leave blank to match any interface.">
            <input
              list="static-nat-interfaces"
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              placeholder="eth0"
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
            placeholder="Web server 1:1"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Internal Address" hint="The private host (LAN side).">
            <input
              value={internalAddress}
              onChange={(e) => setInternalAddress(e.target.value)}
              placeholder="192.168.1.10"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="External Address" hint="The public address (WAN side).">
            <input
              value={externalAddress}
              onChange={(e) => setExternalAddress(e.target.value)}
              placeholder="203.0.113.10"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create mapping"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
