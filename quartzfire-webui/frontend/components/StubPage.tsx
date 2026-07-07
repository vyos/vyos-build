/// Placeholder for a console section that hasn't been implemented yet. Every
/// left-nav destination renders one of these until the real page lands.
export function StubPage({ title }: { title: string }) {
  return (
    <div className="p-[28px_36px]">
      <h1
        className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0"
        style={{ letterSpacing: "-0.015em" }}
      >
        {title}
      </h1>
      <div className="surface mt-6 px-6 py-12 text-center">
        <div className="text-[14px] font-semibold text-[var(--qz-fg-2)]">
          Not implemented yet
        </div>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-2 mb-0">
          This section is a placeholder — {title} management will land here.
        </p>
      </div>
    </div>
  );
}
