"use client";

interface SegmentedItem {
  value: string;
  label: string;
}

export function Segmented({
  items,
  value,
  onChange,
}: {
  items: SegmentedItem[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="inline-flex bg-[var(--qz-input-bg)] border border-[var(--qz-border)] rounded-lg p-[3px] gap-[2px]"
      style={{ display: "inline-flex" }}
    >
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={[
            "border-none font-medium text-[12.5px] px-3 py-[5px] rounded-[5px] cursor-pointer transition-all duration-[120ms]",
            value === it.value
              ? "bg-[var(--qz-accent-soft)] text-[var(--qz-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
              : "bg-transparent text-[var(--qz-fg-3)] hover:text-[var(--qz-fg-2)]",
          ].join(" ")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
