"use client";

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`switch ${on ? "on" : ""}`}
    >
      <div className="switch-knob" />
    </div>
  );
}
