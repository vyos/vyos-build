"use client";

import { LucideIcon } from "lucide-react";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps {
  kind?: ButtonKind;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  onClick?: () => void;
  type?: "button" | "submit";
  children?: React.ReactNode;
  disabled?: boolean;
}

const kindStyles: Record<ButtonKind, string> = {
  primary:
    "bg-[var(--qz-accent)] text-[var(--qz-fg-on-accent)] hover:bg-[var(--qz-accent-hover)]",
  secondary:
    "bg-[var(--qz-surface-raised)] text-[var(--qz-fg-1)] border border-[var(--qz-border)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:bg-[color-mix(in_oklab,white_4%,var(--qz-surface-raised))]",
  ghost:
    "bg-transparent text-[var(--qz-fg-2)] hover:bg-[var(--qz-surface)] hover:text-[var(--qz-fg-1)]",
  danger:
    "bg-[var(--qz-danger)] text-white hover:opacity-90",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-[10px] py-[5px] text-xs gap-[6px]",
  md: "px-[14px] py-[8px] text-[13px] gap-[7px]",
};

export function Button({
  kind = "primary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  onClick,
  type = "button",
  children,
  disabled,
}: ButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center font-semibold leading-none rounded-md cursor-pointer border border-transparent",
        "transition-all duration-[140ms] ease-[var(--qz-ease-out)]",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        kindStyles[kind],
        sizeStyles[size],
      ].join(" ")}
    >
      {Icon && <Icon size={iconSize} />}
      {children}
      {IconRight && <IconRight size={iconSize} />}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  onClick,
  label,
}: {
  icon: LucideIcon;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="w-8 h-8 rounded-md grid place-items-center bg-transparent text-[var(--qz-fg-3)] border border-transparent hover:bg-[var(--qz-surface)] hover:text-[var(--qz-fg-1)] hover:border-[var(--qz-border)] transition-all duration-[120ms] cursor-pointer"
    >
      <Icon size={16} />
    </button>
  );
}
