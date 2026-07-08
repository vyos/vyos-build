"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  ALIAS_GROUP,
  applyRule,
  AliasType,
  endpointToSelection,
  EndpointSelection,
  FirewallAlias,
  FirewallPolicy,
  FirewallRule,
  nextRuleNumber,
  PROTOCOL_LABEL,
  RuleAction,
} from "@/lib/firewall";

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

const ANY = "any";
const CUSTOM = "custom";
const aliasKey = (type: AliasType, name: string) => `alias:${type}:${name}`;

/// From/To picker: Any, an alias, or a custom literal address.
function EndpointField({
  label,
  aliases,
  value,
  onChange,
}: {
  label: string;
  aliases: FirewallAlias[];
  value: EndpointSelection;
  onChange: (sel: EndpointSelection) => void;
}) {
  const selectValue =
    value.kind === "any" ? ANY : value.kind === "address" ? CUSTOM : aliasKey(value.type, value.name);

  const onSelect = (v: string) => {
    if (v === ANY) onChange({ kind: "any" });
    else if (v === CUSTOM) onChange({ kind: "address", address: value.kind === "address" ? value.address : "" });
    else {
      const [, type, ...rest] = v.split(":");
      onChange({ kind: "alias", type: type as AliasType, name: rest.join(":") });
    }
  };

  return (
    <Field label={label}>
      <div className="flex flex-col gap-2">
        <select
          value={selectValue}
          onChange={(e) => onSelect(e.target.value)}
          className={`${inputCls} cursor-pointer`}
          style={monoSt}
          onFocus={focusBorder}
          onBlur={blurBorder}
        >
          <option value={ANY}>Any</option>
          {aliases.length > 0 && (
            <optgroup label="Aliases">
              {aliases.map((a) => (
                <option key={aliasKey(a.type, a.name)} value={aliasKey(a.type, a.name)}>
                  {a.name} ({ALIAS_GROUP[a.type].label})
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM}>Custom address…</option>
        </select>
        {value.kind === "address" && (
          <input
            value={value.address}
            onChange={(e) => onChange({ kind: "address", address: e.target.value })}
            placeholder="172.16.20.0/24"
            className={inputCls}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        )}
      </div>
    </Field>
  );
}

/// Create/edit a forward-filter rule (From → To with an action and a policy).
/// Diffs against the live config and commits immediately (saved to boot
/// config). New rules are appended at the bottom — drag the table to reorder.
export function RuleFormModal({
  initial,
  aliases,
  policies,
  rules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing rule; absent when creating. */
  initial?: FirewallRule;
  aliases: FirewallAlias[];
  policies: FirewallPolicy[];
  /** All existing rules — a new rule is numbered after the last one. */
  rules: FirewallRule[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [action, setAction] = useState<RuleAction>(initial?.action ?? "accept");
  const [from, setFrom] = useState<EndpointSelection>(initial ? endpointToSelection(initial.from) : { kind: "any" });
  const [to, setTo] = useState<EndpointSelection>(initial ? endpointToSelection(initial.to) : { kind: "any" });
  const [policyName, setPolicyName] = useState(initial?.policy ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (from.kind === "address" && from.address.trim() === "") {
      setError("Enter a From address, or pick Any.");
      return;
    }
    if (to.kind === "address" && to.address.trim() === "") {
      setError("Enter a To address, or pick Any.");
      return;
    }
    const policy = policies.find((p) => p.name === policyName) ?? null;
    if (policyName && !policy) {
      setError(`Policy ${policyName} no longer exists — refresh and try again.`);
      return;
    }

    setSaving(true);
    try {
      const rule = initial?.rule ?? nextRuleNumber(rules);
      const applied = await applyRule(initial ?? null, {
        rule,
        name: name.trim() || null,
        action,
        from,
        to,
        policy: policy ? { name: policy.name, protocol: policy.protocol } : null,
        enabled,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to rule ${rule} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply rule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Rule`}
        subtitle={isEdit ? `Forward filter rule ${initial!.rule}` : "New rules are added at the bottom — drag to reorder"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Allow LAN to Web"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field label="Action">
          <Segmented
            items={[
              { value: "accept", label: "Allow" },
              { value: "drop", label: "Deny" },
              { value: "reject", label: "Reject" },
            ]}
            value={action}
            onChange={(v) => setAction(v as RuleAction)}
          />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <EndpointField label="From" aliases={aliases} value={from} onChange={setFrom} />
          <EndpointField label="To" aliases={aliases} value={to} onChange={setTo} />
        </div>

        <Field
          label="Policy"
          hint={policies.length === 0 ? "No policies defined yet — create them under Firewall › Policies." : "The ports and protocol this rule matches."}
        >
          <select
            value={policyName}
            onChange={(e) => setPolicyName(e.target.value)}
            className={`${inputCls} cursor-pointer`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          >
            <option value="">Any (all traffic)</option>
            {policies.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {PROTOCOL_LABEL[p.protocol].toLowerCase()}:{p.ports.join(",")}
              </option>
            ))}
          </select>
        </Field>

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create rule"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
