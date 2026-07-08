"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applyDnsForwarding, DnsForwardingConfig } from "@/lib/services";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
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

const IP_RE = /^[0-9a-f.:]+$/i;
const IP_OR_CIDR_RE = /^[0-9a-f.:/]+$/i;

// VyOS `dnssec` mode values.
const DNSSEC_MODES = ["", "off", "process-no-validate", "process", "log-fail", "validate"];

/// Edit the recursive DNS forwarder settings. Diffs against the live config
/// and commits immediately (saved to boot config).
export function SettingsFormModal({
  live,
  onClose,
  onSaved,
}: {
  live: DnsForwardingConfig;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const [listenText, setListenText] = useState(live.listen_addresses.join("\n"));
  const [allowText, setAllowText] = useState(live.allow_from.join("\n"));
  const [serversText, setServersText] = useState(live.name_servers.join("\n"));
  const [system, setSystem] = useState(live.system);
  const [cacheSize, setCacheSize] = useState(live.cache_size ?? "");
  const [dnssec, setDnssec] = useState(live.dnssec ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
    const listen = lines(listenText);
    const allow = lines(allowText);
    const servers = lines(serversText);

    if (listen.length === 0) {
      setError("Add at least one listen address — the forwarder must bind somewhere.");
      return;
    }
    if (allow.length === 0) {
      setError("Add at least one allow-from network — VyOS requires it.");
      return;
    }
    const badListen = listen.find((s) => !IP_RE.test(s));
    if (badListen) {
      setError(`"${badListen}" is not a valid listen address.`);
      return;
    }
    const badAllow = allow.find((s) => !IP_OR_CIDR_RE.test(s));
    if (badAllow) {
      setError(`"${badAllow}" is not a valid network.`);
      return;
    }
    const badServer = servers.find((s) => !IP_RE.test(s));
    if (badServer) {
      setError(`"${badServer}" is not a valid name server address.`);
      return;
    }
    if (cacheSize.trim() && !/^\d+$/.test(cacheSize.trim())) {
      setError("Cache size must be a whole number of entries.");
      return;
    }

    setSaving(true);
    try {
      const applied = await applyDnsForwarding(live, {
        listen_addresses: listen,
        allow_from: allow,
        name_servers: servers,
        system,
        cache_size: cacheSize.trim() || null,
        dnssec: dnssec || null,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to DNS forwarding and saved to boot config.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply DNS forwarding settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title="Edit DNS Forwarding"
        subtitle="Recursive DNS forwarder / cache configuration"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Listen Addresses" hint="One address per line the forwarder binds to.">
            <textarea
              value={listenText}
              onChange={(e) => setListenText(e.target.value)}
              placeholder={"192.168.1.1"}
              rows={3}
              className={`${inputCls} resize-y`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Allow From" hint="One client network (CIDR) per line.">
            <textarea
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder={"192.168.1.0/24"}
              rows={3}
              className={`${inputCls} resize-y`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <Field label="Upstream Name Servers" hint="One address per line. Leave empty to recurse from the roots or use system servers.">
          <textarea
            value={serversText}
            onChange={(e) => setServersText(e.target.value)}
            placeholder={"1.1.1.1\n8.8.8.8"}
            rows={3}
            className={`${inputCls} resize-y`}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
        </Field>

        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={system} onChange={setSystem} />
          <span className="text-[13px] text-[var(--qz-fg-2)]">Also forward to the system name servers</span>
        </label>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Cache Size" hint="Entries; defaults to 10000 when unset.">
            <input
              type="number"
              min={0}
              value={cacheSize}
              onChange={(e) => setCacheSize(e.target.value)}
              placeholder="10000"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="DNSSEC">
            <select
              value={dnssec}
              onChange={(e) => setDnssec(e.target.value)}
              className={`${inputCls} cursor-pointer`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            >
              {DNSSEC_MODES.map((m) => (
                <option key={m} value={m}>
                  {m === "" ? "default (process-no-validate)" : m}
                </option>
              ))}
            </select>
          </Field>
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
            {saving ? "Applying…" : "Apply changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
