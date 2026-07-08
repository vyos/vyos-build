"use client";

import { useEffect, useRef, useState } from "react";
import { Search, ArrowRight } from "lucide-react";

interface PaletteAction {
  id: string;
  section: string;
  label: string;
  kbd: string;
  href?: string;
}

const ACTIONS: PaletteAction[] = [
  { id: "nav-dashboard",  section: "Go to", label: "Dashboard",  kbd: "G D", href: "/dashboard" },
  { id: "nav-interfaces", section: "Go to", label: "Interfaces", kbd: "G I", href: "/interfaces" },
  { id: "nav-if-ethernet", section: "Go to", label: "Interfaces › Ethernet", kbd: "", href: "/interfaces/ethernet" },
  { id: "nav-if-vlan",     section: "Go to", label: "Interfaces › VLAN",     kbd: "", href: "/interfaces/vlan" },
  { id: "nav-if-bonding",  section: "Go to", label: "Interfaces › Bonding",  kbd: "", href: "/interfaces/bonding" },
  { id: "nav-if-bridge",   section: "Go to", label: "Interfaces › Bridge",   kbd: "", href: "/interfaces/bridge" },
  { id: "nav-if-loopback", section: "Go to", label: "Interfaces › Loopback", kbd: "", href: "/interfaces/loopback" },
  { id: "nav-routing",    section: "Go to", label: "Routing",    kbd: "G R", href: "/routing" },
  { id: "nav-nat",        section: "Go to", label: "NAT",        kbd: "G N", href: "/nat" },
  { id: "nav-firewall",   section: "Go to", label: "Firewall",   kbd: "G F", href: "/firewall" },
  { id: "nav-services",   section: "Go to", label: "Services",   kbd: "G V", href: "/services" },
  { id: "nav-system",     section: "Go to", label: "System",     kbd: "G S", href: "/system" },
];

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setQ("");
  }, [open]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  if (!open) return null;

  const filtered = ACTIONS.filter((a) =>
    a.label.toLowerCase().includes(q.toLowerCase())
  );

  const grouped = filtered.reduce<Record<string, PaletteAction[]>>((acc, a) => {
    (acc[a.section] = acc[a.section] || []).push(a);
    return acc;
  }, {});

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div
          className="flex items-center gap-[10px] p-[14px_18px]"
          style={{ borderBottom: "1px solid var(--qz-border)" }}
        >
          <Search size={16} className="text-[var(--qz-fg-3)]" />
          <input
            ref={inputRef}
            placeholder="Jump to a section…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-transparent border-0 outline-none text-[var(--qz-fg-1)] text-[15px]"
            style={{ fontFamily: "var(--qz-font-sans)" }}
          />
          <span
            className="text-[10px] text-[var(--qz-fg-4)]"
            style={{ fontFamily: "var(--qz-font-mono)" }}
          >
            esc
          </span>
        </div>

        <div className="p-2 max-h-[50vh] overflow-auto">
          {Object.entries(grouped).map(([section, items]) => (
            <div key={section}>
              <div
                className="px-[10px] py-[6px] pb-[2px] text-[10px] tracking-[0.1em] text-[var(--qz-fg-4)] uppercase"
                style={{ fontFamily: "var(--qz-font-mono)" }}
              >
                {section}
              </div>
              {items.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-[10px] px-3 py-2 rounded-md text-[13.5px] text-[var(--qz-fg-2)] cursor-pointer hover:bg-[var(--qz-accent-soft)] hover:text-[var(--qz-fg-1)]"
                  onClick={() => {
                    if (a.href) onNavigate(a.href);
                    onClose();
                  }}
                >
                  <ArrowRight size={14} className="text-[var(--qz-fg-4)]" />
                  <span className="flex-1">{a.label}</span>
                  {a.kbd && (
                    <span
                      className="text-[10px] text-[var(--qz-fg-4)] border border-[var(--qz-border)] px-[5px] py-[1px] rounded"
                      style={{ fontFamily: "var(--qz-font-mono)" }}
                    >
                      {a.kbd}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="p-5 text-[13px] text-[var(--qz-fg-3)]">No matches.</div>
          )}
        </div>
      </div>
    </div>
  );
}
