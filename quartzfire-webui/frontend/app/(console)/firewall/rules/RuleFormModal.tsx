"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import {
  ALIAS_GROUP,
  applyRule,
  AliasType,
  BUILTIN_POLICIES,
  EndpointEntry,
  EndpointSelection,
  FirewallConfig,
  FirewallRule,
  nextRuleNumber,
  PROTOCOL_LABEL,
  RuleAction,
  RuleChain,
  RulePolicyChoice,
  ruleSelection,
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

const aliasKey = (type: AliasType, name: string) => `alias:${type}:${name}`;
const ifaceKey = (name: string) => `iface:${name}`;
const FIREWALL_KEY = "builtin:firewall";

/// Built-in policy sentinels for the policy select — values no port-group can
/// be named (VyOS group names can't contain brackets). Ping writes `protocol
/// icmp`; the others seed a real port-group of that name on first use.
const PING_KEY = "[ping]";
const builtinKey = (name: string) => `[builtin:${name}]`;

const CHAIN_LABEL: Record<RuleChain, string> = {
  forward: "Forward filter",
  input: "Input filter",
  output: "Output filter",
};

/// List-entry label: friendly name first (interface description or alias
/// display name), with the technical name in the sub line.
function entryLabel(
  e: EndpointEntry,
  descriptions: Record<string, string> | undefined,
  aliases: FirewallConfig["aliases"],
): { main: string; sub: string } {
  switch (e.kind) {
    case "alias": {
      const display = aliases.find((a) => a.type === e.type && a.name === e.name)?.display ?? e.name;
      return { main: display, sub: ALIAS_GROUP[e.type].label };
    }
    case "interface": {
      const desc = descriptions?.[e.name];
      return desc ? { main: desc, sub: `${e.name} · Interface` } : { main: e.name, sub: "Interface" };
    }
    case "firewall":
      return { main: "Firewall", sub: "This device" };
    case "ifgroup":
      return { main: e.name, sub: "Interface group" };
    case "address":
      return { main: e.address, sub: "Custom address" };
  }
}

/// From/To picker, WatchGuard style: a list of the entries the side matches
/// (any of them; empty = Any) with add/remove controls. The add dropdown only
/// offers entries VyOS can OR with what's already listed — interfaces and
/// aliases can't be mixed, alias types can't be combined, and FQDN aliases
/// stand alone (domain groups have no include). The built-in Firewall entry
/// (this device itself) stands alone too, and only one side can carry it.
/// Legacy entries (a literal address or an interface-group written on the
/// CLI) stay removable but can't be newly added.
function EndpointField({
  label,
  interfaces,
  descriptions,
  aliases,
  allowFirewall,
  value,
  onChange,
}: {
  label: string;
  interfaces: string[];
  descriptions?: Record<string, string>;
  aliases: FirewallConfig["aliases"];
  /** False when the other side already carries the Firewall entry. */
  allowFirewall: boolean;
  value: EndpointSelection;
  onChange: (sel: EndpointSelection) => void;
}) {
  const hasIface = value.some((e) => e.kind === "interface" || e.kind === "ifgroup");
  const hasFirewall = value.some((e) => e.kind === "firewall");
  const aliasEntry = value.find((e) => e.kind === "alias");
  const aliasType = aliasEntry?.kind === "alias" ? aliasEntry.type : null;
  // A legacy entry can't be OR-combined with anything — matches would AND.
  const hasLegacy = value.some((e) => e.kind === "ifgroup" || e.kind === "address");

  const addableIfaces =
    aliasType || hasLegacy || hasFirewall
      ? []
      : interfaces.filter((n) => !value.some((e) => e.kind === "interface" && e.name === n));
  const addableAliases = hasIface || hasLegacy || hasFirewall
    ? []
    : aliases.filter((a) => {
        if (value.some((e) => e.kind === "alias" && e.type === a.type && e.name === a.name)) return false;
        if (aliasType) return a.type === aliasType && aliasType !== "fqdn";
        return true;
      });
  const firewallAddable = allowFirewall && value.length === 0;
  const canAdd = addableIfaces.length > 0 || addableAliases.length > 0 || firewallAddable;

  const add = (v: string) => {
    if (v === FIREWALL_KEY) onChange([...value, { kind: "firewall" }]);
    else if (v.startsWith("iface:")) onChange([...value, { kind: "interface", name: v.slice("iface:".length) }]);
    else if (v.startsWith("alias:")) {
      const [, type, ...rest] = v.split(":");
      onChange([...value, { kind: "alias", type: type as AliasType, name: rest.join(":") }]);
    }
  };

  return (
    <Field label={label}>
      <div
        className="rounded-md overflow-y-auto"
        style={{ ...monoSt, minHeight: 96, maxHeight: 160, padding: value.length ? "4px 0" : 0 }}
      >
        {value.length === 0 ? (
          <div className="flex items-center justify-center h-[96px] text-[13px] text-[var(--qz-fg-4)]">Any</div>
        ) : (
          value.map((e, i) => {
            const { main, sub } = entryLabel(e, descriptions, aliases);
            return (
              <div
                key={`${e.kind}:${main}:${i}`}
                className="group flex items-center gap-2 px-3 py-[5px] text-[13px] text-[var(--qz-fg-1)]"
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{main}</span>
                <span className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0">{sub}</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                  title={`Remove ${main}`}
                  className="ml-auto flex-shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded cursor-pointer border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)]"
                  style={{ background: "transparent" }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
      <select
        value=""
        onChange={(e) => add(e.target.value)}
        disabled={!canAdd}
        className={`${inputCls} cursor-pointer mt-2`}
        style={{ ...monoSt, opacity: canAdd ? 1 : 0.5 }}
        onFocus={focusBorder}
        onBlur={blurBorder}
      >
        <option value="" disabled>
          {canAdd ? "Add…" : "Nothing more can be added"}
        </option>
        {firewallAddable && (
          <optgroup label="Built-in">
            <option value={FIREWALL_KEY}>Firewall — this device itself</option>
          </optgroup>
        )}
        {addableIfaces.length > 0 && (
          <optgroup label="Interfaces">
            {addableIfaces.map((n) => (
              <option key={ifaceKey(n)} value={ifaceKey(n)}>
                {descriptions?.[n] ? `${descriptions[n]} (${n})` : n}
              </option>
            ))}
          </optgroup>
        )}
        {addableAliases.length > 0 && (
          <optgroup label="Aliases">
            {addableAliases.map((a) => (
              <option key={aliasKey(a.type, a.name)} value={aliasKey(a.type, a.name)}>
                {a.display} ({ALIAS_GROUP[a.type].label})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </Field>
  );
}

/// Create/edit a filter rule (From → To with an action and a policy). Diffs
/// against the live config and commits immediately (the boot-config save runs in the background).
/// New rules are appended at the bottom — drag the table to reorder. A side
/// set to the built-in Firewall entry places the rule in the input/output
/// chain instead of forward.
export function RuleFormModal({
  initial,
  interfaces,
  descriptions,
  config,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing rule; absent when creating. */
  initial?: FirewallRule;
  /** Firewall interface names offered in the From/To pickers. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the picker entries. */
  descriptions?: Record<string, string>;
  /** The full firewall config — aliases and policies for the pickers, rules
   *  for numbering, auto groups and group names for the endpoint diff. */
  config: FirewallConfig;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const { aliases, policies, rules } = config;

  const [name, setName] = useState(initial?.name ?? "");
  const [action, setAction] = useState<RuleAction>(initial?.action ?? "accept");
  const [from, setFrom] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "from", config.auto_groups) : [],
  );
  const [to, setTo] = useState<EndpointSelection>(
    initial ? ruleSelection(initial, "to", config.auto_groups) : [],
  );
  const [policyName, setPolicyName] = useState(
    initial?.policy ?? (initial?.protocol === "icmp" ? PING_KEY : ""),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // New rules log by default so they show in the Traffic Monitor.
  const [log, setLog] = useState(initial?.log ?? true);
  const [ips, setIps] = useState(initial?.ips ?? false);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    let policy: RulePolicyChoice | null = null;
    const builtin = Object.keys(BUILTIN_POLICIES).find((n) => builtinKey(n) === policyName);
    if (policyName === PING_KEY) {
      policy = { kind: "ping" };
    } else if (builtin) {
      // The diff seeds the port-group itself when it doesn't exist yet.
      policy = { kind: "policy", name: builtin, protocol: BUILTIN_POLICIES[builtin].protocol };
    } else if (policyName) {
      const p = policies.find((pol) => pol.name === policyName);
      if (!p) {
        setError(`Policy ${policyName} no longer exists — refresh and try again.`);
        return;
      }
      policy = { kind: "policy", name: p.name, protocol: p.protocol };
    }

    setSaving(true);
    try {
      const rule = initial?.rule ?? nextRuleNumber(rules);
      const applied = await applyRule(
        initial ?? null,
        {
          rule,
          name: name.trim() || null,
          action,
          from,
          to,
          policy,
          enabled,
          log,
          ips,
        },
        config,
      );
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to rule ${rule}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply rule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={640}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Rule`}
        subtitle={isEdit ? `${CHAIN_LABEL[initial!.chain]} rule ${initial!.rule}` : "New rules are added at the bottom — drag to reorder"}
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
          <EndpointField
            label="From"
            interfaces={interfaces}
            descriptions={descriptions}
            aliases={aliases}
            allowFirewall={!to.some((e) => e.kind === "firewall")}
            value={from}
            onChange={setFrom}
          />
          <EndpointField
            label="To"
            interfaces={interfaces}
            descriptions={descriptions}
            aliases={aliases}
            allowFirewall={!from.some((e) => e.kind === "firewall")}
            value={to}
            onChange={setTo}
          />
        </div>
        <p className="text-[11px] text-[var(--qz-fg-4)] m-0 -mt-2">
          Traffic matches any entry in a list; an empty list matches everything. Interfaces and aliases can&apos;t be
          mixed in one list, and aliases must share a type. The built-in Firewall entry matches this device itself —
          use it to control management access, pings, and other traffic to or from the firewall.
        </p>

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
            <option value="">Any</option>
            <option value={PING_KEY}>Ping</option>
            {/* Built-ins step aside for a user policy of the same name. */}
            {Object.entries(BUILTIN_POLICIES)
              .filter(([n]) => !policies.some((p) => p.name === n))
              .map(([n, b]) => (
                <option key={builtinKey(n)} value={builtinKey(n)}>
                  {n} — {PROTOCOL_LABEL[b.protocol].toLowerCase()}:{b.ports.join(",")}
                </option>
              ))}
            {policies.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {PROTOCOL_LABEL[p.protocol].toLowerCase()}:{p.ports.join(",")}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex items-center gap-6">
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={enabled} onChange={setEnabled} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
          </label>
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={log} onChange={setLog} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Log traffic (Traffic Monitor)</span>
          </label>
          {action === "accept" && (
            <label className="flex items-center gap-[10px] cursor-pointer select-none">
              <Switch on={ips} onChange={setIps} />
              <span className="text-[13px] text-[var(--qz-fg-2)]">Enable IPS</span>
            </label>
          )}
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create rule"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
