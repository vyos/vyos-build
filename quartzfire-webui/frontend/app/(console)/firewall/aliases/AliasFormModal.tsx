"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { ALIAS_GROUP, AliasType, applyAlias, FirewallAlias, sanitizeAliasName } from "@/lib/firewall";

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

// Friendly names may contain spaces — the backing VyOS group name can't, so
// spaces become hyphens on save (see sanitizeAliasName).
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]*$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV4_RANGE_RE = /^(\d{1,3}\.){3}\d{1,3}-(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const FQDN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const MEMBER_INFO: Record<AliasType, { placeholder: string; hint: string; valid: (m: string) => boolean }> = {
  host: {
    placeholder: "172.16.20.2\n172.16.20.10-172.16.20.20",
    hint: "One IPv4 address or range per line.",
    valid: (m) => IPV4_RE.test(m) || IPV4_RANGE_RE.test(m),
  },
  network: {
    placeholder: "172.16.20.0/24",
    hint: "One IPv4 network in CIDR notation per line.",
    valid: (m) => CIDR_RE.test(m),
  },
  fqdn: {
    placeholder: "vpn.example.com",
    hint: "One fully-qualified domain name per line. No wildcards — VyOS resolves each name to its DNS addresses, and subdomains are not covered.",
    valid: (m) => FQDN_RE.test(m),
  },
};

/// Create/edit an alias (a named host / network / FQDN group). Diffs against
/// the live config and commits immediately (the boot-config save runs in the background).
export function AliasFormModal({
  initial,
  existing,
  usedByRules,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing alias; absent when creating. */
  initial?: FirewallAlias;
  /** All existing aliases, for duplicate detection and diffing. */
  existing: FirewallAlias[];
  /** Rule numbers referencing the edited alias — locks name/type changes. */
  usedByRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const locked = isEdit && usedByRules.length > 0;

  const [name, setName] = useState(initial?.display ?? "");
  const [type, setType] = useState<AliasType>(initial?.type ?? "host");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [membersText, setMembersText] = useState(initial?.members.join("\n") ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const display = name.trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(display)) {
      setError("Name must start with a letter and use only letters, digits, spaces, hyphens, and underscores.");
      return;
    }
    // The device name is the hyphenated form — VyOS group names can't hold spaces.
    const n = sanitizeAliasName(display);
    // Same VyOS group node = same namespace; different alias types don't clash.
    const clash = existing.some(
      (a) => a.name === n && a.type === type && !(isEdit && a.name === initial!.name && a.type === initial!.type),
    );
    if (clash) {
      setError(`A ${ALIAS_GROUP[type].label.toLowerCase()} alias named ${display} already exists (device name ${n}).`);
      return;
    }

    const members = membersText
      .split("\n")
      .map((m) => m.trim())
      .filter(Boolean);
    if (members.length === 0) {
      setError("Add at least one member.");
      return;
    }
    const bad = members.find((m) => !MEMBER_INFO[type].valid(m));
    if (bad) {
      setError(`"${bad}" is not a valid ${ALIAS_GROUP[type].label.toLowerCase()} entry.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyAlias(existing, {
        name: n,
        display,
        type,
        description: description.trim() || null,
        members,
        original_name: initial?.name ?? null,
        original_type: initial?.type ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to alias ${display}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply alias.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Alias`}
        subtitle="Named hosts, networks, or FQDNs for firewall rules"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Type"
          hint={locked ? `In use by rule${usedByRules.length === 1 ? "" : "s"} ${usedByRules.join(", ")} — type and name are locked.` : undefined}
        >
          <div style={locked ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <Segmented
              items={[
                { value: "host", label: "IPv4 Host" },
                { value: "network", label: "IPv4 Network" },
                { value: "fqdn", label: "FQDN" },
              ]}
              value={type}
              onChange={(v) => setType(v as AliasType)}
            />
          </div>
        </Field>

        <Field
          label="Name"
          hint={
            /\s/.test(name.trim())
              ? `Spaces are fine here — stored on the device as ${sanitizeAliasName(name)}.`
              : undefined
          }
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Approved DNS Servers"
            disabled={locked}
            className={inputCls}
            style={{ ...monoSt, opacity: locked ? 0.5 : 1 }}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field label="Members" hint={MEMBER_INFO[type].hint}>
          <textarea
            value={membersText}
            onChange={(e) => setMembersText(e.target.value)}
            placeholder={MEMBER_INFO[type].placeholder}
            rows={5}
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
            placeholder="Internal server subnet"
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create alias"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
