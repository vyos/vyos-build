"use client";

// Create/Edit dialog for a geolocation policy: which action, which firewall
// rule (picker over the same rule list the Firewall pages use), the match
// direction, and the enabled flag.

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import { FirewallRule } from "@/lib/firewall";
import {
  GeoAction,
  GeoDirection,
  GeoPolicy,
  GeoPolicyUpdate,
  nextPolicyId,
} from "@/lib/geolocation";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

/// Human-readable one-liner for a firewall rule row in the picker.
export function ruleSummary(rule: FirewallRule): string {
  const name = rule.name ?? `Rule ${rule.rule}`;
  const from = rule.from.iface ?? rule.from.group_name ?? rule.from.address ?? "any";
  const to = rule.to.iface ?? rule.to.group_name ?? rule.to.address ?? "any";
  return `${name} (${rule.chain} ${rule.rule}: ${from} → ${to}, ${rule.action ?? "?"})`;
}

export function PolicyFormModal({
  initial,
  actions,
  policies,
  rules,
  onCancel,
  onSave,
}: {
  /** Policy being edited, or null when creating. */
  initial: GeoPolicy | null;
  actions: GeoAction[];
  policies: GeoPolicy[];
  /** All user firewall rules (forward/input/output), from lib/firewall. */
  rules: FirewallRule[];
  onCancel: () => void;
  onSave: (update: GeoPolicyUpdate) => Promise<void>;
}) {
  const { setToast } = useDashboard();
  const [action, setAction] = useState(initial?.action ?? actions[0]?.name ?? "");
  // The rule picker binds chain+number together (a rule is identified by both).
  const [target, setTarget] = useState<string>(
    initial ? `${initial.ruleset}:${initial.rule}` : "",
  );
  const [direction, setDirection] = useState<GeoDirection>(initial?.direction ?? "both");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  // A policy may point at a rule that no longer exists (error state) — keep
  // it selectable so the form can be re-pointed without losing the row.
  const targets = rules.map((r) => ({ key: `${r.chain}:${r.rule}`, label: ruleSummary(r) }));
  if (initial && !targets.some((t) => t.key === `${initial.ruleset}:${initial.rule}`)) {
    targets.unshift({
      key: `${initial.ruleset}:${initial.rule}`,
      label: `${initial.ruleset} rule ${initial.rule} (no longer exists)`,
    });
  }

  const save = async () => {
    if (!action) return setToast("Pick a geolocation action (create one on the Actions tab first).");
    if (!target) return setToast("Pick the firewall rule this policy attaches to.");
    const [ruleset, ruleStr] = target.split(":");
    setBusy(true);
    try {
      await onSave({
        id: initial?.id ?? nextPolicyId(policies),
        action,
        ruleset: ruleset as GeoPolicyUpdate["ruleset"],
        rule: Number(ruleStr),
        direction,
        enabled,
        original_id: initial?.id ?? null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} maxWidth={560}>
      <ModalHeader
        title={initial ? `Edit Policy ${initial.id}` : "New Geolocation Policy"}
        subtitle="Bind an action to a firewall rule; the rule's traffic is then country-filtered."
        onClose={onCancel}
      />

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <label className="text-[13px] text-[var(--qz-fg-3)] w-[110px]">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="flex-1 rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
            style={inputStyle}
          >
            {actions.length === 0 && <option value="">No actions defined yet</option>}
            {actions.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-[13px] text-[var(--qz-fg-3)] w-[110px]">Firewall rule</label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="flex-1 rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
            style={inputStyle}
          >
            <option value="">Select a rule…</option>
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[13px] text-[var(--qz-fg-3)] w-[110px]">Direction</span>
          <Segmented
            items={[
              { value: "source", label: "Source" },
              { value: "destination", label: "Destination" },
              { value: "both", label: "Both" },
            ]}
            value={direction}
            onChange={(v) => setDirection(v as GeoDirection)}
          />
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            Which address is matched against the action&apos;s countries.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[13px] text-[var(--qz-fg-3)] w-[110px]">Enabled</span>
          <Switch on={enabled} onChange={setEnabled} />
        </div>

        <div className="flex items-center gap-3 justify-end mt-1">
          <Button kind="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : initial ? "Save policy" : "Add policy"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
