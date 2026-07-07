"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { getCurrentUser, logout, vyosApi } from "@/lib/api";

/// Placeholder console landing page. Confirms the authenticated proxy path to
/// the VyOS API works end-to-end; the real dashboard replaces this next.
function Dashboard() {
  const router = useRouter();
  const [status, setStatus] = useState<string>("checking…");
  const user = getCurrentUser();

  useEffect(() => {
    vyosApi("retrieve", { op: "showConfig", path: [] })
      .then(() => setStatus("connected to VyOS API"))
      .catch((e) => setStatus(`API not reachable: ${e.message}`));
  }, []);

  const handleLogout = async () => {
    await logout();
    router.replace("/");
  };

  return (
    <main className="p-12 max-w-[720px] mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0">QuartzFire</h1>
          <p className="text-[var(--qz-fg-3)] mt-1 mb-0 text-[13px]">
            Signed in as{" "}
            <span className="font-semibold text-[var(--qz-fg-2)]">
              {user?.username ?? "…"}
            </span>
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="rounded-md px-3 py-[8px] text-[12.5px] font-semibold cursor-pointer transition-colors"
          style={{
            background: "var(--qz-surface-raised)",
            border: "1px solid var(--qz-border)",
            color: "var(--qz-fg-2)",
          }}
        >
          Sign out
        </button>
      </div>

      <div className="surface mt-8 px-5 py-4 text-[13px]">
        <strong className="text-[var(--qz-fg-1)]">Backend status:</strong>{" "}
        <span className="text-[var(--qz-fg-2)]">{status}</span>
      </div>
      {/* TODO: replace placeholder with the real dashboard from the design
          (KPIs, interfaces, firewall views) mapped to the VyOS HTTP API. */}
    </main>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      <Dashboard />
    </AuthGuard>
  );
}
