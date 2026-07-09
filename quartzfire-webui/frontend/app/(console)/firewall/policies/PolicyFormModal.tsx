"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { applyPolicy, FirewallPolicy, FirewallRule, PolicyProtocol, PROTOCOL_LABEL } from "@/lib/firewall";

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

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/// A port entry: a number (443), a range (8000-8010), or a service name (https).
function validPort(p: string): boolean {
  if (/^[a-z][a-z0-9-]*$/i.test(p)) return true;
  const inRange = (n: string) => Number(n) >= 1 && Number(n) <= 65535;
  const m = p.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return false;
  if (!inRange(m[1])) return false;
  return m[2] === undefined || (inRange(m[2]) && Number(m[1]) < Number(m[2]));
}

/// Create/edit a policy (a named port set with a protocol). Diffs against the
/// live config and commits immediately (saved to boot config). Changing the
/// protocol also updates every rule using the policy.
export function PolicyFormModal({
  initial,
  existing,
  rules,
  usedByRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing policy; absent when creating. */
  initial?: FirewallPolicy;
  /** All existing policies, for duplicate detection and diffing. */
  existing: FirewallPolicy[];
  /** All rules — a protocol change is propagated to rules using this policy. */
  rules: FirewallRule[];
  /** Rule numbers referencing the edited policy — locks renaming. */
  usedByRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const locked = isEdit && usedByRules.length > 0;

  const [name, setName] = useState(initial?.name ?? "");
  const [protocol, setProtocol] = useState<PolicyProtocol>(initial?.protocol ?? "tcp");
  const [portsText, setPortsText] = useState(initial?.ports.join("\n") ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

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
    const clash = existing.some((p) => p.name === n && !(isEdit && p.name === initial!.name));
    if (clash) {
      setError(`A policy named ${n} already exists.`);
      return;
    }

    const ports = portsText
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (ports.length === 0) {
      setError("Add at least one port.");
      return;
    }
    const bad = ports.find((p) => !validPort(p));
    if (bad) {
      setError(`"${bad}" is not a valid port, range, or service name.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyPolicy(existing, rules, {
        name: n,
        protocol,
        ports,
        description: description.trim() || null,
        original_name: initial?.name ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to policy ${n} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply policy.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Policy`}
        subtitle="A named set of TCP/UDP ports for firewall rules"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={locked ? `In use by rule${usedByRules.length === 1 ? "" : "s"} ${usedByRules.join(", ")} — the name is locked.` : undefined}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="HTTPS"
            disabled={locked}
            className={inputCls}
            style={{ ...monoSt, opacity: locked ? 0.5 : 1 }}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field
          label="Protocol"
          hint={locked ? "Changing the protocol updates every rule using this policy." : undefined}
        >
          <Segmented
            items={(Object.keys(PROTOCOL_LABEL) as PolicyProtocol[]).map((p) => ({
              value: p,
              label: PROTOCOL_LABEL[p],
            }))}
            value={protocol}
            onChange={(v) => setProtocol(v as PolicyProtocol)}
          />
        </Field>

        <Field label="Ports" hint="One per line (commas work too): numbers (443), ranges (8000-8010), or service names (https).">
          <textarea
            value={portsText}
            onChange={(e) => setPortsText(e.target.value)}
            placeholder={"80\n443\n8000-8010"}
            rows={4}
            className={`${inputCls} resize-y`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Web browsing"
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create policy"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
