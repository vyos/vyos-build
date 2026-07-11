"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { AuthUserInfo, getCurrentUser, logout, setUser } from "@/lib/api";
import { setUserPassword } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

/// Forced password change for accounts that signed in with the factory-default
/// password. The backend flags the login; this modal blocks the console until
/// the password is changed (or the user signs out). Escape/backdrop don't
/// dismiss it — the only ways out are a new password or logout.
export function DefaultPasswordGate() {
  const router = useRouter();
  const { setToast } = useDashboard();
  const [user, setLocalUser] = useState<AuthUserInfo | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // localStorage is unavailable during SSR/prerender — read it after mount
  // (by which time AuthGuard's fetchMe has refreshed the cached user).
  useEffect(() => {
    setLocalUser(getCurrentUser());
  }, []);

  if (!user?.default_password) return null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password === "vyos") {
      setError("That's still the default password — pick a different one.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      await setUserPassword(user.username, password);
      const updated = { ...user, default_password: false };
      setUser(updated);
      setLocalUser(updated);
      setToast("Password changed. Use it for your next sign-in.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the password.");
      setSaving(false);
    }
  };

  const signOut = async () => {
    await logout();
    router.push("/");
  };

  return (
    <ModalShell onClose={() => {}} maxWidth={440}>
      <ModalHeader title="Change the Default Password" onClose={signOut} />
      <div className="flex flex-col gap-4">
        <div
          className="flex items-start gap-[10px] px-4 py-3 rounded-md text-[13px]"
          style={{
            background: "color-mix(in oklab, var(--qz-warn) 10%, transparent)",
            border: "1px solid color-mix(in oklab, var(--qz-warn) 35%, transparent)",
            color: "var(--qz-fg-1)",
          }}
        >
          <ShieldAlert size={16} className="flex-shrink-0 mt-[1px]" style={{ color: "var(--qz-warn)" }} />
          <span>
            The account <span style={{ fontFamily: "var(--qz-font-mono)" }}>{user.username}</span> is still
            using the factory-default password. Anyone who can reach this firewall can sign in with it — set a
            new password to continue.
          </span>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              className={inputCls}
              style={inputSt}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
            />
          </div>
          <div>
            <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">Confirm Password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className={inputCls}
              style={inputSt}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
            />
          </div>

          {error && (
            <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
              {error}
            </p>
          )}

          <div className="flex gap-2 justify-end mt-1">
            <button
              type="button"
              onClick={signOut}
              className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer"
              style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
            >
              Sign out
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
              style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}
            >
              {saving ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}
