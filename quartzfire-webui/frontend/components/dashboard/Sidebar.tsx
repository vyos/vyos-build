"use client";

import { Gauge, Settings, Search, LogOut, Network, Route, ArrowLeftRight, Shield, Server, LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthUserInfo, getCurrentUser, logout as apiLogout } from "@/lib/api";

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
}

const ITEMS: NavItem[] = [
  { id: "overview",   label: "Dashboard",  icon: Gauge,          href: "/dashboard" },
  { id: "interfaces", label: "Interfaces", icon: Network,        href: "/interfaces" },
  { id: "routing",    label: "Routing",    icon: Route,          href: "/routing" },
  { id: "nat",        label: "NAT",        icon: ArrowLeftRight, href: "/nat" },
  { id: "firewall",   label: "Firewall",   icon: Shield,         href: "/firewall" },
  { id: "services",   label: "Services",   icon: Server,         href: "/services" },
  { id: "system",     label: "System",     icon: Settings,       href: "/system" },
];

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  // Static export emits trailing-slash routes, so normalise before comparing.
  const pathname = (usePathname() ?? "/").replace(/\/+$/, "") || "/";
  const router = useRouter();
  const [user, setUser] = useState<AuthUserInfo | null>(null);

  // localStorage is unavailable during SSR/prerender — read it after mount.
  useEffect(() => {
    setUser(getCurrentUser());
  }, []);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  const logout = async () => {
    await apiLogout();
    router.push("/");
  };

  return (
    <aside
      className="flex flex-col h-full"
      style={{
        borderRight: "1px solid var(--qz-border)",
        background: "var(--qz-ink-0)",
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-[10px] px-4 h-14 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--qz-border)" }}
      >
        <img src="/logo-mark.png" alt="Quartz Systems" className="w-7 h-7 flex-shrink-0" />
        <span
          className="font-bold text-[var(--qz-fg-1)] text-[15px]"
          style={{ letterSpacing: "-0.01em" }}
        >
          QuartzFire
        </span>
      </div>

      {/* Search */}
      <div className="px-3 py-3 flex-shrink-0">
        <button
          type="button"
          onClick={onOpenPalette}
          className="w-full flex items-center gap-2 bg-[var(--qz-input-bg)] border border-[var(--qz-border)] rounded-md px-[10px] py-[7px] cursor-pointer hover:border-[var(--qz-border-strong)] transition-colors text-left"
        >
          <Search size={13} className="text-[var(--qz-fg-4)] flex-shrink-0" />
          <span
            className="flex-1 text-[13px] text-[var(--qz-fg-4)]"
            style={{ fontFamily: "var(--qz-font-sans)" }}
          >
            Search…
          </span>
        </button>
      </div>

      {/* Nav */}
      <div className="flex-1 min-h-0 overflow-auto px-3 flex flex-col gap-[2px] pt-1">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.id}
              href={item.href}
              className={[
                "flex items-center gap-[10px] px-[10px] py-[8px] rounded-md text-[13.5px] font-medium border transition-all duration-[120ms] no-underline w-full text-left cursor-pointer",
                active
                  ? "bg-[var(--qz-accent-soft)] text-[var(--qz-accent)] border-[color-mix(in_oklab,var(--qz-accent)_30%,transparent)]"
                  : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)] hover:bg-[color-mix(in_oklab,white_4%,transparent)]",
              ].join(" ")}
            >
              <Icon size={16} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div
        className="flex-shrink-0 px-4 py-3 flex items-center gap-[10px]"
        style={{ borderTop: "1px solid var(--qz-border)" }}
      >
        <div
          className="w-7 h-7 rounded-full grid place-items-center text-[var(--qz-fg-on-accent)] font-bold text-xs flex-shrink-0"
          style={{
            background: "linear-gradient(135deg, var(--qz-green-700), var(--qz-green-500))",
          }}
        >
          {user ? user.username.slice(0, 2).toUpperCase() : "…"}
        </div>
        <span className="text-[var(--qz-fg-1)] font-semibold text-[13px] truncate flex-1 min-w-0">
          {user?.username ?? ""}
        </span>
        <button
          type="button"
          title="Log out"
          onClick={logout}
          className="flex-shrink-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-fg-1)] transition-colors cursor-pointer bg-transparent border-0 p-0"
        >
          <LogOut size={15} />
        </button>
      </div>
    </aside>
  );
}
