"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyStaticRoute, RouteFamily, StaticRoute, StaticRouteKind } from "@/lib/routing";

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

const V4_CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/([0-9]|[12][0-9]|3[0-2])$/;
const V4_ADDR_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const V6_CIDR_RE = /^[0-9a-f:]+\/(\d{1,2}|1[01]\d|12[0-8])$/i;
const V6_ADDR_RE = /^[0-9a-f:]+$/i;

const PLACEHOLDERS: Record<RouteFamily, { destination: string; gateway: string }> = {
  ipv4: { destination: "0.0.0.0/0", gateway: "192.168.1.1" },
  ipv6: { destination: "::/0", gateway: "fe80::1" },
};

/// Create/edit one static route next-hop. Diffs against the live config and
/// commits immediately (saved to boot config).
export function StaticRouteFormModal({
  family,
  initial,
  interfaces,
  descriptions,
  existing,
  onClose,
  onSaved,
}: {
  family: RouteFamily;
  /** Present when editing an existing next-hop; absent when creating. */
  initial?: StaticRoute;
  /** Interface names offered as a datalist for the interface fields. */
  interfaces: string[];
  /** Interface descriptions by name, shown next to the datalist entries. */
  descriptions?: Record<string, string>;
  /** Every configured route row, for duplicate detection and diffing. */
  existing: StaticRoute[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [kind, setKind] = useState<StaticRouteKind>(initial?.kind ?? "gateway");
  const [destination, setDestination] = useState(initial?.destination ?? "");
  const [via, setVia] = useState(initial?.via ?? "");
  const [iface, setIface] = useState(initial?.interface ?? "");
  const [distance, setDistance] = useState(initial?.distance !== null && initial ? String(initial.distance) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const cidrRe = family === "ipv4" ? V4_CIDR_RE : V6_CIDR_RE;
  const addrRe = family === "ipv4" ? V4_ADDR_RE : V6_ADDR_RE;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const dst = destination.trim();
    if (!cidrRe.test(dst)) {
      setError(`Destination must be an ${family === "ipv4" ? "IPv4" : "IPv6"} network in CIDR notation.`);
      return;
    }
    const v = via.trim();
    if (kind === "gateway" && !addrRe.test(v)) {
      setError(`Gateway must be an ${family === "ipv4" ? "IPv4" : "IPv6"} address.`);
      return;
    }
    if (kind === "interface" && !v) {
      setError("Pick the interface the route leaves through.");
      return;
    }
    const d = distance.trim();
    if (d && !(Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 255)) {
      setError("Distance must be a whole number between 1 and 255.");
      return;
    }

    // Block collisions with another next-hop of the same identity (allow
    // re-saving the edited one).
    const newVia = kind === "blackhole" ? null : v;
    const clash = existing.some(
      (r) =>
        r.family === family &&
        r.destination === dst &&
        r.kind === kind &&
        (r.via ?? null) === newVia &&
        !(isEdit && r.destination === initial!.destination && r.kind === initial!.kind && (r.via ?? null) === (initial!.via ?? null)),
    );
    if (clash) {
      setError("That exact route already exists.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyStaticRoute(existing, {
        family,
        destination: dst,
        kind,
        via: newVia,
        interface: kind === "gateway" ? iface.trim() || null : null,
        distance: d ? Number(d) : null,
        enabled,
        description: description.trim() || null,
        original: initial
          ? { family: initial.family, destination: initial.destination, kind: initial.kind, via: initial.via }
          : null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to route ${dst} and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply route.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title={`${isEdit ? "Edit" : "Create"} Static Route`}
        subtitle={family === "ipv4" ? "IPv4 static route" : "IPv6 static route"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <datalist id="static-route-interfaces">
          {interfaces.map((n) => (
            <option key={n} value={n} label={descriptions?.[n]} />
          ))}
        </datalist>

        <Field label="Type">
          <Segmented
            items={[
              { value: "gateway", label: "Gateway" },
              { value: "interface", label: "Interface" },
              { value: "blackhole", label: "Blackhole" },
            ]}
            value={kind}
            onChange={(v) => setKind(v as StaticRouteKind)}
          />
        </Field>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Destination">
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder={PLACEHOLDERS[family].destination}
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          {kind === "gateway" && (
            <Field label="Gateway" hint="The next-hop router address.">
              <input
                value={via}
                onChange={(e) => setVia(e.target.value)}
                placeholder={PLACEHOLDERS[family].gateway}
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>
          )}
          {kind === "interface" && (
            <Field label="Interface" hint="Traffic is routed directly out this interface.">
              <input
                list="static-route-interfaces"
                value={via}
                onChange={(e) => setVia(e.target.value)}
                placeholder="eth0"
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>
          )}
          {kind === "blackhole" && (
            <Field label="Gateway" hint="Blackhole routes silently drop matching traffic.">
              <input value="—" disabled className={inputCls} style={{ ...monoSt, opacity: 0.5 }} />
            </Field>
          )}
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {kind === "gateway" && (
            <Field label="Egress Interface" hint="Optional — pin the next-hop to an interface.">
              <input
                list="static-route-interfaces"
                value={iface}
                onChange={(e) => setIface(e.target.value)}
                placeholder="eth0"
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>
          )}
          <Field label="Distance" hint="Optional — administrative distance (default 1).">
            <input
              type="number"
              min={1}
              max={255}
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
              placeholder="1"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <Field label="Description" hint="Stored on the destination — shared by all its next-hops.">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Default route via ISP"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        {kind !== "blackhole" && (
          <label className="flex items-center gap-[10px] cursor-pointer select-none">
            <Switch on={enabled} onChange={setEnabled} />
            <span className="text-[13px] text-[var(--qz-fg-2)]">Enabled</span>
          </label>
        )}

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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Create route"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
