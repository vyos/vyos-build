"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/// Centered overlay dialog. Clicking the backdrop or pressing Escape closes it.
export function ModalShell({
  onClose,
  maxWidth = 520,
  children,
}: {
  onClose: () => void;
  maxWidth?: number;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--qz-ink-0)",
          border: "1px solid var(--qz-border)",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
          width: "100%",
          maxWidth,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 28,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h2 className="text-[17px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.01em" }}>
          {title}
        </h2>
        {subtitle && <p className="text-[13px] text-[var(--qz-fg-3)] m-0 mt-[3px]">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)] transition-colors cursor-pointer bg-transparent border-0 p-0 mt-[2px]"
      >
        <X size={18} />
      </button>
    </div>
  );
}
