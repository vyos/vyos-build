"use client";

import { createContext, useContext, useState } from "react";

interface DashboardState {
  toast: string | null;
  setToast: (msg: string | null) => void;
}

const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<string | null>(null);

  return (
    <DashboardContext.Provider value={{ toast, setToast }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be inside DashboardProvider");
  return ctx;
}
