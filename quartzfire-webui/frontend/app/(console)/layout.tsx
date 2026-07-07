"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { DashboardShell } from "@/components/dashboard/DashboardShell";

/// Shared chrome for every console page: auth gate + sidebar shell. The login
/// page at the site root lives outside this group and stays chrome-free.
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <DashboardShell>{children}</DashboardShell>
    </AuthGuard>
  );
}
