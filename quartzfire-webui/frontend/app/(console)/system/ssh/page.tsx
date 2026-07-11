"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Pencil, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { fetchSystemConfig, SshSettings, SystemUser } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { SshFormModal } from "./SshFormModal";

/// One label/value line of the settings card.
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-[9px]" style={{ borderBottom: "1px solid var(--qz-border)" }}>
      <span className="text-[12px] text-[var(--qz-fg-4)] w-[200px] flex-shrink-0 pt-[1px]">{label}</span>
      <span className="text-[13px] text-[var(--qz-fg-1)] min-w-0">{children}</span>
    </div>
  );
}

function MonoList({ items, fallback }: { items: string[]; fallback: string }) {
  if (items.length === 0) return <span className="text-[var(--qz-fg-4)]">{fallback}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
      {items.map((v) => (
        <span key={v}>{v}</span>
      ))}
    </span>
  );
}

export default function SshPage() {
  const { setToast } = useDashboard();
  const [ssh, setSsh] = useState<SshSettings | null>(null);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [modal, setModal] = useState(false);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      const cfg = await fetchSystemConfig();
      setSsh(cfg.ssh);
      setUsers(cfg.users);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load SSH settings.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usersWithKeys = users.filter((u) => u.keys.length > 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          SSH
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Remote console access to the firewall (sshd)
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading SSH settings…</div>
        )}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={load}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && ssh && (
          <div className="flex flex-col gap-7">
            <section
              className="rounded-lg px-5 pt-2 pb-3"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <div className="flex items-center justify-between py-2">
                <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">SSH Service</h2>
                <Button kind="secondary" size="sm" icon={Pencil} onClick={() => setModal(true)}>
                  Edit settings
                </Button>
              </div>
              <InfoRow label="Service">
                <span className={ssh.enabled ? "badge badge-ok" : "badge badge-muted"}>
                  {ssh.enabled ? "Enabled" : "Disabled"}
                </span>
              </InfoRow>
              <InfoRow label="Ports"><MonoList items={ssh.ports} fallback="22 (default)" /></InfoRow>
              <InfoRow label="Listen Addresses"><MonoList items={ssh.listen_addresses} fallback="All addresses" /></InfoRow>
              <InfoRow label="Password Authentication">
                <span className={ssh.password_auth_disabled ? "badge badge-warn" : "badge badge-ok"}>
                  {ssh.password_auth_disabled ? "Disabled (keys only)" : "Allowed"}
                </span>
              </InfoRow>
            </section>

            <section
              className="rounded-lg px-5 pt-2 pb-3"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <div className="flex items-center justify-between py-2">
                <h2 className="text-[15px] font-semibold text-[var(--qz-fg-1)] m-0">Authorized Keys</h2>
                <Link
                  href="/system/users"
                  className="text-[12px] text-[var(--qz-accent)] no-underline hover:underline"
                >
                  Manage on the Users page →
                </Link>
              </div>
              {usersWithKeys.length === 0 ? (
                <p className="text-[13px] text-[var(--qz-fg-4)] py-2 m-0">
                  No account has SSH public keys yet. Keys are managed per user account.
                </p>
              ) : (
                usersWithKeys.map((u) => (
                  <InfoRow key={u.name} label={u.name}>
                    <span className="flex flex-wrap gap-x-3 gap-y-1" style={{ fontFamily: "var(--qz-font-mono)" }}>
                      {u.keys.map((k) => (
                        <span key={k.id}>
                          {k.id}
                          <span className="text-[var(--qz-fg-4)]"> ({k.type ?? "?"})</span>
                        </span>
                      ))}
                    </span>
                  </InfoRow>
                ))
              )}
            </section>
          </div>
        )}
      </div>

      {modal && ssh && (
        <SshFormModal
          live={ssh}
          keylessUsers={users.filter((u) => u.keys.length === 0).map((u) => u.name)}
          onClose={() => setModal(false)}
          onSaved={(msg) => {
            setModal(false);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
