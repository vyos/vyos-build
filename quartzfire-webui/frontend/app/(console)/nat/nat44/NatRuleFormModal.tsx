"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyNatRule, NatRule, NatSection } from "@/lib/nat";
import { ALIAS_GROUP, FirewallAlias, InterfaceAlias } from "@/lib/firewall";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

const PROTOCOLS = ["all", "tcp", "udp", "tcp_udp", "icmp", "esp", "gre"];

/// Built-in interface aliases resolve to the interface's connected IPv4
/// network — VyOS NAT has no interface match under `source`, so selecting one
/// writes `source address <network>`. The prefix keeps these apart from
/// `<type> <name>` group references in the same select.
const NET_PREFIX = "network:";

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

/// Create/edit a single NAT44 source (SNAT) or destination (DNAT) rule.
/// Diffs against the live config and commits immediately (saved to boot config).
export function NatRuleFormModal({
  section,
  initial,
  interfaces,
  descriptions,
  aliases,
  builtins,
  existing,
  takenRules,
  onClose,
  onSaved,
}: {
  section: NatSection;
  /** Present when editing an existing rule; absent when creating. */
  initial?: NatRule;
  /** Interface names offered in the interface picker. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the picker entries. */
  descriptions?: Record<string, string>;
  /** Firewall aliases offered as source matches (host/network only). */
  aliases: FirewallAlias[];
  /** Built-in interface aliases, offered as their connected IPv4 networks. */
  builtins: InterfaceAlias[];
  /** Existing rules in this section, for duplicate detection and diffing. */
  existing: NatRule[];
  /** Rule numbers used by 1-to-1 mappings (unavailable here). */
  takenRules: number[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const isSource = section === "source";

  const [rule, setRule] = useState(initial ? String(initial.rule) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [iface, setIface] = useState(initial?.interface ?? interfaces[0] ?? "");
  const [sourceAddress, setSourceAddress] = useState(initial?.source ?? "");
  // A rule whose source address is exactly a built-in interface network opens
  // showing that alias, so a rule created from one round-trips.
  const initialNet =
    initial?.source && builtins.some((b) => b.networks.includes(initial.source!))
      ? `${NET_PREFIX}${initial.source}`
      : null;
  // Source match is an address or an alias (a firewall-group reference stored
  // as `<type> <name>`, or a built-in interface network), mutually exclusive.
  const [sourceMode, setSourceMode] = useState<"address" | "alias">(
    initial?.source_group || initialNet ? "alias" : "address",
  );
  const [sourceGroup, setSourceGroup] = useState(initial?.source_group ?? initialNet ?? "");
  const [sourcePort, setSourcePort] = useState(initial?.source_port ?? "");
  const [destAddress, setDestAddress] = useState(initial?.destination ?? "");
  const [destPort, setDestPort] = useState(initial?.destination_port ?? "");
  // Source rules default to masquerade; anything else translates to an address.
  const [masquerade, setMasquerade] = useState(
    isSource && (initial ? initial.translation === "masquerade" || initial.translation === null : true),
  );
  const [translationAddress, setTranslationAddress] = useState(
    initial?.translation && initial.translation !== "masquerade" ? initial.translation : "",
  );
  const [translationPort, setTranslationPort] = useState(initial?.translation_port ?? "");
  // VyOS treats an unset protocol as "all"; show that explicitly so the field is never blank.
  const [protocol, setProtocol] = useState(initial?.protocol ?? "all");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Keep the current value selectable even if it's missing from the list.
  const ifaceOptions = [...new Set([iface, ...interfaces].filter(Boolean))];

  // Built-in interface aliases, one option per connected IPv4 network (an
  // unaddressed or DHCP interface has none to offer).
  const builtinOptions = builtins.flatMap((b) =>
    b.networks.map((net) => ({ value: `${NET_PREFIX}${net}`, label: `${b.display} — ${net}` })),
  );
  // Host/network aliases as `<type> <name>` group references. VyOS NAT also
  // accepts domain/mac groups, but subnets and hosts are what SNAT wants.
  const aliasOptions = aliases
    .filter((a) => a.type === "host" || a.type === "network")
    .map((a) => ({
      value: `${ALIAS_GROUP[a.type].node} ${a.name}`,
      label: `${a.display} (${ALIAS_GROUP[a.type].label})`,
    }));
  // Keep a group configured outside the Aliases page (CLI, other type) selectable.
  if (
    sourceGroup &&
    !sourceGroup.startsWith(NET_PREFIX) &&
    !aliasOptions.some((o) => o.value === sourceGroup)
  ) {
    aliasOptions.unshift({ value: sourceGroup, label: sourceGroup });
  }
  const hasAliasOptions = builtinOptions.length > 0 || aliasOptions.length > 0;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const num = Number(rule);
    if (!Number.isInteger(num) || num < 1 || num > 999999) {
      setError("Rule number must be a whole number between 1 and 999999.");
      return;
    }
    // Block collisions with another rule in this section (allow re-saving the edited one).
    const clash = existing.some((r) => r.rule === num && !(isEdit && r.rule === initial!.rule));
    if (clash) {
      setError(`Rule ${num} already exists in this section.`);
      return;
    }
    if (takenRules.includes(num)) {
      setError(`Rule ${num} is already used by a 1-to-1 NAT mapping.`);
      return;
    }
    if (!masquerade && translationAddress.trim() === "") {
      setError(isSource ? "Enter a translation address, or use masquerade." : "Enter a forward-to address.");
      return;
    }
    if (sourceMode === "alias" && !sourceGroup) {
      setError("Choose a source alias, or switch the source match to an address.");
      return;
    }

    // A built-in interface alias is stored as a plain source address (its
    // network); only user aliases become group references.
    const netAlias = sourceGroup.startsWith(NET_PREFIX) ? sourceGroup.slice(NET_PREFIX.length) : null;

    setSaving(true);
    try {
      const applied = await applyNatRule(existing, {
        section,
        rule: num,
        description: description.trim() || null,
        interface: iface.trim() || null,
        source_address: sourceMode === "address" ? sourceAddress.trim() || null : netAlias,
        source_group: sourceMode === "alias" && !netAlias ? sourceGroup || null : null,
        source_port: sourcePort.trim() || null,
        destination_address: destAddress.trim() || null,
        destination_port: destPort.trim() || null,
        translation_address: masquerade ? "masquerade" : translationAddress.trim(),
        translation_port: masquerade ? null : translationPort.trim() || null,
        // "all" is the VyOS default — store it as unset rather than an explicit leaf.
        protocol: protocol.trim() && protocol.trim().toLowerCase() !== "all" ? protocol.trim() : null,
        enabled,
        original_rule: initial?.rule ?? null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${section} NAT rule ${num} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply NAT rule.");
    } finally {
      setSaving(false);
    }
  };

  const ifaceLabel = isSource ? "Outbound Interface" : "Inbound Interface";

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} ${isSource ? "Source" : "Destination"} NAT Rule`}
        subtitle={isSource ? "IPv4 SNAT / Masquerade" : "IPv4 DNAT / Port-Forward"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="nat44-protocols">
          {PROTOCOLS.map((p) => (
            <option key={p} value={p} />
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
          <Field label="Protocol">
            <input
              list="nat44-protocols"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              placeholder="all"
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
            placeholder={isSource ? "Office Outbound NAT" : "Web Server Port-Forward"}
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <Field label={ifaceLabel} hint="Interface this rule applies to.">
          {ifaceOptions.length > 0 ? (
            <select
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              className={`${inputCls} cursor-pointer`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {ifaceOptions.map((n) => (
                <option key={n} value={n}>
                  {descriptions?.[n] ? `${n} — ${descriptions[n]}` : n}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              placeholder="eth0"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          )}
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
          <Field
            label="Source"
            hint={
              sourceMode === "alias"
                ? "Interface networks come from each interface's address; aliases are managed under Firewall → Aliases."
                : undefined
            }
          >
            <div className="flex gap-2">
              <div style={{ width: 104, flexShrink: 0 }}>
                <select
                  value={sourceMode}
                  onChange={(e) => setSourceMode(e.target.value as "address" | "alias")}
                  className={`${inputCls} cursor-pointer`}
                  style={inputSt}
                  onFocus={focusBorder}
                  onBlur={blurBorder}
                >
                  <option value="address">Address</option>
                  <option value="alias">Alias</option>
                </select>
              </div>
              <div className="flex-1 min-w-0">
                {sourceMode === "address" ? (
                  <input
                    value={sourceAddress}
                    onChange={(e) => setSourceAddress(e.target.value)}
                    placeholder={isSource ? "10.0.0.0/24" : "any"}
                    className={inputCls}
                    style={monoSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  />
                ) : (
                  <select
                    value={sourceGroup}
                    onChange={(e) => setSourceGroup(e.target.value)}
                    className={`${inputCls} cursor-pointer`}
                    style={monoSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  >
                    <option value="" disabled>
                      {hasAliasOptions ? "Select alias…" : "No aliases defined"}
                    </option>
                    {builtinOptions.length > 0 && (
                      <optgroup label="Interface networks">
                        {builtinOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {aliasOptions.length > 0 && (
                      <optgroup label="Aliases">
                        {aliasOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
              </div>
            </div>
          </Field>
          <Field label="Source Port">
            <input
              value={sourcePort}
              onChange={(e) => setSourcePort(e.target.value)}
              placeholder="any"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
          <Field label="Destination Address">
            <input
              value={destAddress}
              onChange={(e) => setDestAddress(e.target.value)}
              placeholder={isSource ? "any" : "203.0.113.5"}
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Destination Port">
            <input
              value={destPort}
              onChange={(e) => setDestPort(e.target.value)}
              placeholder={isSource ? "any" : "443"}
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        {isSource && (
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={masquerade} onChange={setMasquerade} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Masquerade (use the outbound interface address)</span>
          </label>
        )}

        {!masquerade && (
          <div className="grid gap-4" style={{ gridTemplateColumns: "2fr 1fr" }}>
            <Field
              label={isSource ? "Translation Address" : "Forward-to Address"}
              hint="An IP, CIDR block, or range (192.168.1.10-192.168.1.20)."
            >
              <input
                value={translationAddress}
                onChange={(e) => setTranslationAddress(e.target.value)}
                placeholder="192.168.1.10"
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>
            <Field label="Translation Port">
              <input
                value={translationPort}
                onChange={(e) => setTranslationPort(e.target.value)}
                placeholder="keep original"
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>
          </div>
        )}

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
