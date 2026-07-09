"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyEthernet, EthernetInterface } from "@/lib/interfaces";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

// Mbit/s options VyOS accepts; "auto" maps to no explicit speed leaf.
const SPEED_OPTIONS = ["auto", "10", "100", "1000", "2500", "5000", "10000"];
const DUPLEX_OPTIONS = ["auto", "half", "full"];

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

interface AddrRow {
  key: string;
  value: string;
}

let addrKeyCounter = 0;
const nextKey = () => `eth-addr-${addrKeyCounter++}`;
const toRows = (values: string[]): AddrRow[] => values.map((value) => ({ key: nextKey(), value }));

export function EthernetFormModal({
  initial,
  freeNames,
  onClose,
  onSaved,
}: {
  /** Present when editing an existing interface; absent when adding. */
  initial?: EthernetInterface;
  /** Physical NICs free to configure (used only when adding). */
  freeNames: string[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? freeNames[0] ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [addresses, setAddresses] = useState<AddrRow[]>(toRows(initial?.addresses ?? []));
  const [mtu, setMtu] = useState(initial?.mtu != null ? String(initial.mtu) : "");
  const [speed, setSpeed] = useState(initial?.speed ?? "auto");
  const [duplex, setDuplex] = useState(initial?.duplex ?? "auto");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addAddr = () => setAddresses((p) => [...p, { key: nextKey(), value: "" }]);
  const removeAddr = (key: string) => setAddresses((p) => p.filter((a) => a.key !== key));
  const updateAddr = (key: string, value: string) =>
    setAddresses((p) => p.map((a) => (a.key === key ? { ...a, value } : a)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!name) {
      setError("Select a physical interface.");
      return;
    }
    if (mtu.trim() !== "") {
      const m = Number(mtu);
      if (!Number.isInteger(m) || m < 68 || m > 16000) {
        setError("MTU must be a whole number between 68 and 16000.");
        return;
      }
    }
    // VyOS requires speed and duplex to both be auto, or both fixed.
    if ((speed === "auto") !== (duplex === "auto")) {
      setError("Speed and duplex must both be Auto, or both set to a fixed value.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyEthernet(initial ?? null, {
        name,
        description: description.trim() || null,
        addresses: addresses.map((a) => a.value.trim()).filter(Boolean),
        mtu: mtu.trim() === "" ? null : Number(mtu),
        speed: speed === "auto" ? null : speed,
        duplex: duplex === "auto" ? null : duplex,
        enabled,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to ${name}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply interface changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader
        title={isEdit ? "Edit Interface" : "Add Interface"}
        subtitle={isEdit ? initial!.name : "Configure a physical ethernet interface"}
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">
            Physical Interface <span style={{ color: "var(--qz-danger)" }}>*</span>
          </label>
          {isEdit ? (
            <input
              value={name}
              disabled
              className={`${inputCls} disabled:opacity-70`}
              style={monoSt}
            />
          ) : (
            <select
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputCls} cursor-pointer`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {freeNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="WAN uplink"
            className={inputCls}
            style={inputSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-[6px]">
            <label className="block text-[12px] text-[var(--qz-fg-3)]">IP Addresses</label>
            <button
              type="button"
              onClick={addAddr}
              className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0"
            >
              <Plus size={13} /> Add address
            </button>
          </div>
          {addresses.length === 0 ? (
            <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
              No addresses — use <span style={{ fontFamily: "var(--qz-font-mono)" }}>dhcp</span> or a CIDR like 10.0.0.1/24.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {addresses.map((a) => (
                <div key={a.key} className="flex items-center gap-2">
                  <input
                    value={a.value}
                    onChange={(e) => updateAddr(a.key, e.target.value)}
                    placeholder="10.0.0.1/24 or dhcp"
                    className={inputCls}
                    style={monoSt}
                    onFocus={focusBorder}
                    onBlur={blurBorder}
                  />
                  <button
                    type="button"
                    onClick={() => removeAddr(a.key)}
                    title="Remove address"
                    className="grid place-items-center w-9 h-9 flex-shrink-0 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent"
                    style={{ border: "1px solid var(--qz-border)" }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Speed</label>
            <select
              value={speed}
              onChange={(e) => setSpeed(e.target.value)}
              className={`${inputCls} cursor-pointer`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {(SPEED_OPTIONS.includes(speed) ? SPEED_OPTIONS : [speed, ...SPEED_OPTIONS]).map((s) => (
                <option key={s} value={s}>
                  {s === "auto" ? "Auto" : s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Duplex</label>
            <select
              value={duplex}
              onChange={(e) => setDuplex(e.target.value)}
              className={`${inputCls} cursor-pointer`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {(DUPLEX_OPTIONS.includes(duplex) ? DUPLEX_OPTIONS : [duplex, ...DUPLEX_OPTIONS]).map((d) => (
                <option key={d} value={d}>
                  {d === "auto" ? "Auto" : d.charAt(0).toUpperCase() + d.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">MTU</label>
            <input
              type="number"
              min={68}
              max={16000}
              value={mtu}
              onChange={(e) => setMtu(e.target.value)}
              placeholder="1500"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </div>
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
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add interface"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
