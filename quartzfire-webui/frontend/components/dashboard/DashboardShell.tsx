"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { CommandPalette } from "@/components/dashboard/CommandPalette";
import { SaveIndicator } from "@/components/dashboard/SaveIndicator";
import { Toast } from "@/components/dashboard/Toast";
import { DefaultPasswordGate } from "@/components/DefaultPasswordGate";
import { DashboardProvider, useDashboard } from "@/lib/DashboardContext";

function Shell({ children }: { children: React.ReactNode }) {
  const nextRouter = useRouter();
  const { toast, setToast } = useDashboard();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div
      className="h-screen overflow-hidden"
      style={{ display: "grid", gridTemplateColumns: "240px 1fr", gridTemplateRows: "minmax(0, 1fr)" }}
    >
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      <main className="overflow-auto" style={{ background: "var(--qz-bg)" }}>
        {children}
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(href) => nextRouter.push(href)}
      />
      <SaveIndicator />
      <DefaultPasswordGate />
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <Shell>{children}</Shell>
    </DashboardProvider>
  );
}
