"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/// Interface types that have a page. More land here as they are implemented
/// (vlan, bridge, wireguard, …).
const TYPES = [{ label: "Ethernet", href: "/interfaces/ethernet" }];

/// Shared chrome for the Interfaces section: title + interface-type tabs.
export default function InterfacesLayout({ children }: { children: React.ReactNode }) {
  // Static export emits trailing-slash routes, so normalise before comparing.
  const pathname = (usePathname() ?? "/").replace(/\/+$/, "") || "/";

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] flex-shrink-0">
        <h1
          className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0"
          style={{ letterSpacing: "-0.015em" }}
        >
          Interfaces
        </h1>
        <div
          className="flex items-center gap-1 mt-4"
          style={{ borderBottom: "1px solid var(--qz-border)" }}
        >
          {TYPES.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={[
                  "px-3 py-[9px] text-[13px] font-medium no-underline transition-colors -mb-px",
                  active
                    ? "text-[var(--qz-accent)]"
                    : "text-[var(--qz-fg-3)] hover:text-[var(--qz-fg-1)]",
                ].join(" ")}
                style={{
                  borderBottom: active
                    ? "2px solid var(--qz-accent)"
                    : "2px solid transparent",
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
