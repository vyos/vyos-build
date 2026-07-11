"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { applyGeneral, GeneralSettings } from "@/lib/system";

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

const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const IP_RE = /^[0-9a-f.:]+$/i;
const NTP_RE = /^[a-z0-9.:_-]+$/i;

/// Common IANA zones offered as suggestions — the field stays free-text and
/// the device validates the final value at commit.
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Toronto", "America/Mexico_City", "America/Sao_Paulo",
  "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm",
  "Europe/Warsaw", "Europe/Kyiv", "Europe/Moscow", "Europe/Istanbul",
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka",
  "Asia/Bangkok", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai",
  "Asia/Tokyo", "Asia/Seoul", "Australia/Perth", "Australia/Sydney",
  "Pacific/Auckland",
];

/// Edit hostname, domain, DNS, NTP, and timezone. Diffs against the live
/// config and commits immediately (the boot-config save runs in the
/// background).
export function GeneralFormModal({
  live,
  onClose,
  onSaved,
}: {
  live: GeneralSettings;
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const [hostname, setHostname] = useState(live.hostname ?? "");
  const [domainName, setDomainName] = useState(live.domain_name ?? "");
  const [dnsText, setDnsText] = useState(live.name_servers.join("\n"));
  const [ntpText, setNtpText] = useState(live.ntp_servers.join("\n"));
  const [timezone, setTimezone] = useState(live.timezone ?? "");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
    const dns = lines(dnsText);
    const ntp = lines(ntpText);

    if (hostname.trim() && !HOSTNAME_RE.test(hostname.trim())) {
      setError("Hostname may only contain letters, digits, and hyphens (max 63 characters).");
      return;
    }
    if (domainName.trim() && !DOMAIN_RE.test(domainName.trim())) {
      setError(`"${domainName.trim()}" is not a valid domain name.`);
      return;
    }
    const badDns = dns.find((s) => !IP_RE.test(s));
    if (badDns) {
      setError(`"${badDns}" is not a valid DNS server address.`);
      return;
    }
    const badNtp = ntp.find((s) => !NTP_RE.test(s));
    if (badNtp) {
      setError(`"${badNtp}" is not a valid NTP server address or hostname.`);
      return;
    }

    setSaving(true);
    try {
      const applied = await applyGeneral(live, {
        hostname: hostname.trim() || null,
        domain_name: domainName.trim() || null,
        name_servers: dns,
        timezone: timezone.trim() || null,
        ntp_servers: ntp,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to system settings.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply system settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader
        title="Edit System Settings"
        subtitle="Identity, DNS, time, and NTP of the firewall itself"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Hostname" hint="Defaults to vyos when empty.">
            <input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="firewall-01"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="Domain Name" hint="Optional DNS domain of this device.">
            <input
              value={domainName}
              onChange={(e) => setDomainName(e.target.value)}
              placeholder="example.com"
              className={inputCls}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="DNS Servers" hint="One address per line — used by the firewall itself.">
            <textarea
              value={dnsText}
              onChange={(e) => setDnsText(e.target.value)}
              placeholder={"1.1.1.1\n8.8.8.8"}
              rows={3}
              className={`${inputCls} resize-y`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
          <Field label="NTP Servers" hint="One server per line. Clearing the list disables NTP.">
            <textarea
              value={ntpText}
              onChange={(e) => setNtpText(e.target.value)}
              placeholder={"time1.vyos.net"}
              rows={3}
              className={`${inputCls} resize-y`}
              style={monoSt}
              onFocus={focusBorder}
              onBlur={blurBorder}
            />
          </Field>
        </div>

        <Field label="Time Zone" hint="IANA zone name, e.g. America/New_York. Defaults to UTC when empty.">
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="UTC"
            list="qz-timezones"
            className={inputCls}
            style={monoSt}
            onFocus={focusBorder}
            onBlur={blurBorder}
          />
          <datalist id="qz-timezones">
            {COMMON_TIMEZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
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
            {saving ? "Applying…" : "Apply changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
