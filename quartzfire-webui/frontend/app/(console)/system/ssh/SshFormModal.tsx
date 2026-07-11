"use client";

import { useState } from "react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { applySsh, SshSettings } from "@/lib/system";

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

const IP_RE = /^[0-9a-f.:]+$/i;

/// Edit the SSH service. Diffs against the live config and commits
/// immediately (the boot-config save runs in the background).
export function SshFormModal({
  live,
  keylessUsers,
  onClose,
  onSaved,
}: {
  live: SshSettings;
  /** Accounts with no public key — disabling password auth locks them out of SSH. */
  keylessUsers: string[];
  onClose: () => void;
  /** Called after a successful apply with a toast-able summary. */
  onSaved: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(live.enabled);
  const [portsText, setPortsText] = useState(live.ports.join(", "));
  const [listenText, setListenText] = useState(live.listen_addresses.join("\n"));
  const [keysOnly, setKeysOnly] = useState(live.password_auth_disabled);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    const ports = portsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const listen = listenText.split("\n").map((s) => s.trim()).filter(Boolean);

    if (enabled) {
      const badPort = ports.find((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
      if (badPort) {
        setError(`"${badPort}" is not a valid port (1–65535).`);
        return;
      }
      const badListen = listen.find((s) => !IP_RE.test(s));
      if (badListen) {
        setError(`"${badListen}" is not a valid listen address.`);
        return;
      }
    }

    setSaving(true);
    try {
      const applied = await applySsh(live, {
        enabled,
        ports,
        listen_addresses: listen,
        password_auth_disabled: keysOnly,
      });
      onSaved(
        applied === 0
          ? "No changes — config already matches."
          : `Applied ${applied} change${applied === 1 ? "" : "s"} to the SSH service.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply SSH settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title="Edit SSH Service"
        subtitle="Remote console access to the firewall (sshd)"
        onClose={onClose}
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex items-center gap-[10px] cursor-pointer select-none">
          <Switch on={enabled} onChange={setEnabled} />
          <span className="text-[13px] text-[var(--qz-fg-2)]">SSH service enabled</span>
        </label>
        {!enabled && live.enabled && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-warn)" }}>
            Disabling SSH removes remote console access — only the local console and this WebUI remain.
          </p>
        )}

        {enabled && (
          <>
            <Field label="Ports" hint="Comma-separated. Defaults to 22 when empty.">
              <input
                value={portsText}
                onChange={(e) => setPortsText(e.target.value)}
                placeholder="22"
                className={inputCls}
                style={monoSt}
                onFocus={focusBorder}
                onBlur={blurBorder}
              />
            </Field>

            <Field label="Listen Addresses" hint="One address per line. Empty = listen on all addresses.">
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

            <label className="flex items-center gap-[10px] cursor-pointer select-none">
              <Switch on={keysOnly} onChange={setKeysOnly} />
              <span className="text-[13px] text-[var(--qz-fg-2)]">Disable password authentication (keys only)</span>
            </label>
            {keysOnly && !live.password_auth_disabled && keylessUsers.length > 0 && (
              <p className="text-[12px] m-0" style={{ color: "var(--qz-warn)" }}>
                {keylessUsers.length === 1 ? "Account" : "Accounts"}{" "}
                <span style={{ fontFamily: "var(--qz-font-mono)" }}>{keylessUsers.join(", ")}</span>{" "}
                {keylessUsers.length === 1 ? "has" : "have"} no SSH public key and will no longer be able to
                sign in over SSH. WebUI logins are unaffected.
              </p>
            )}
          </>
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
            {saving ? "Applying…" : "Apply changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
