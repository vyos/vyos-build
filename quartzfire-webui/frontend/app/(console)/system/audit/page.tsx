"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileDiff, History, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable, FilterDef } from "@/components/dashboard/DataTable";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import {
  CommitEntry,
  fetchCommitDiff,
  fetchCommitHistory,
  fetchSystemLog,
  rollbackToRevision,
  SystemLogEntry,
} from "@/lib/audit";
import { useDashboard } from "@/lib/DashboardContext";

type Tab = "config" | "system";

/// Syslog severity rendered as a badge — the numeric levels mean nothing at a
/// glance.
function PriorityPill({ priority }: { priority: number }) {
  if (priority <= 3) return <span className="badge badge-crit">Error</span>;
  if (priority === 4) return <span className="badge badge-warn">Warning</span>;
  if (priority === 5) return <span className="badge badge-info">Notice</span>;
  return <span className="badge badge-muted">Info</span>;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const commitColumns: Column<CommitEntry>[] = [
  { key: "revision", header: "Revision", value: (r) => r.revision, mono: true, sortable: true, width: 90 },
  { key: "date", header: "Date", value: (r) => r.date, mono: true, sortable: true, width: 180 },
  { key: "user", header: "User", value: (r) => r.user, mono: true, sortable: true, width: 120 },
  { key: "via", header: "Via", value: (r) => r.via, mono: true, sortable: true, width: 100 },
  {
    key: "comment",
    header: "Comment",
    value: (r) => r.comment ?? "",
    render: (r) => (r.comment ? r.comment : <span className="text-[var(--qz-fg-4)]">—</span>),
  },
];

const logColumns: Column<SystemLogEntry>[] = [
  {
    key: "time",
    header: "Time",
    value: (r) => r.ts,
    render: (r) => timeFmt.format(new Date(r.ts)),
    mono: true,
    sortable: true,
    width: 170,
  },
  {
    key: "priority",
    header: "Severity",
    value: (r) => r.priority,
    render: (r) => <PriorityPill priority={r.priority} />,
    sortable: true,
    width: 100,
  },
  { key: "unit", header: "Source", value: (r) => r.unit, mono: true, sortable: true, width: 160 },
  { key: "message", header: "Message", value: (r) => r.message, mono: true },
];

const logFilters: FilterDef<SystemLogEntry>[] = [
  {
    key: "severity",
    label: "Severity",
    options: [
      { value: "error", label: "Errors" },
      { value: "warn", label: "Warnings and up" },
    ],
    predicate: (r, v) => (v === "error" ? r.priority <= 3 : r.priority <= 4),
  },
];

/// Modal showing the device's own diff of one commit revision.
function CommitDiffModal({ revision, onClose }: { revision: number; onClose: () => void }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; text: string }>({
    status: "loading",
    text: "",
  });

  useEffect(() => {
    let live = true;
    fetchCommitDiff(revision)
      .then((text) => live && setState({ status: "ready", text }))
      .catch((e) =>
        live && setState({ status: "error", text: e instanceof Error ? e.message : "Failed to load the diff." }),
      );
    return () => {
      live = false;
    };
  }, [revision]);

  return (
    <ModalShell onClose={onClose} maxWidth={720}>
      <ModalHeader
        title={`Commit revision ${revision}`}
        subtitle="Configuration changes this commit introduced"
        onClose={onClose}
      />
      {state.status === "loading" && (
        <div className="text-[13px] text-[var(--qz-fg-4)]">Loading diff…</div>
      )}
      {state.status === "error" && (
        <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
          <AlertTriangle size={15} />
          {state.text}
        </div>
      )}
      {state.status === "ready" && (
        <pre
          className="m-0 rounded-md p-3 text-[12px] leading-[1.6] overflow-auto"
          style={{
            fontFamily: "var(--qz-font-mono)",
            background: "var(--qz-input-bg)",
            border: "1px solid var(--qz-border)",
            color: "var(--qz-fg-2)",
            maxHeight: "60vh",
            whiteSpace: "pre-wrap",
          }}
        >
          {state.text.trim() || "No differences recorded for this revision."}
        </pre>
      )}
    </ModalShell>
  );
}

/// Confirmation dialog for rolling the config back to a previous revision.
/// The rollback itself runs under commit-confirm, so a bad call auto-reverts.
function RollbackModal({
  commit,
  onClose,
  onStarted,
}: {
  commit: CommitEntry;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      await rollbackToRevision(commit.revision);
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rollback failed.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title={`Roll back to revision ${commit.revision}`}
        subtitle={`Configuration as committed ${commit.date} by ${commit.user}`}
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-[var(--qz-fg-2)] m-0">
          The entire configuration returns to the state of this revision — every change committed since
          (by the WebUI, CLI, or API) is undone. No reboot is needed.
        </p>
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
          The rollback applies under commit-confirm: it must be confirmed in the banner within 2 minutes,
          otherwise the current configuration is restored automatically.
        </p>
        {error && (
          <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-50"
            style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={working}
            onClick={run}
            className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0"
            style={{ background: "var(--qz-danger)", color: "white", opacity: working ? 0.7 : 1 }}
          >
            {working ? "Rolling back…" : "Roll back"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export default function AuditLogPage() {
  const { setToast } = useDashboard();
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  // Journal lines carry no unique key of their own (identical messages can
  // land in the same millisecond), so rows get an index id.
  const [log, setLog] = useState<(SystemLogEntry & { id: number })[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [tab, setTab] = useState<Tab>("config");
  const [diffRevision, setDiffRevision] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<CommitEntry | null>(null);

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      // Either half may fail on its own (e.g. journal unreadable) without
      // taking the other down; fail the page only if both do.
      const [commitsRes, logRes] = await Promise.allSettled([fetchCommitHistory(), fetchSystemLog()]);
      if (commitsRes.status === "rejected" && logRes.status === "rejected") {
        throw commitsRes.reason;
      }
      setCommits(commitsRes.status === "fulfilled" ? commitsRes.value : []);
      setLog(logRes.status === "fulfilled" ? logRes.value.map((e, id) => ({ ...e, id })) : []);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load the audit log.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tabs: [Tab, string, number][] = [
    ["config", "Config Changes", commits.length],
    ["system", "System Log", log.length],
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Audit Log
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Every configuration change committed on this device, and the firewall&apos;s own system logs — traffic
          logs live on the Traffic Monitor
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && <div className="text-[13px] text-[var(--qz-fg-4)]">Loading audit log…</div>}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={() => load()}>
                Retry
              </Button>
            </div>
          </div>
        )}
        {status === "ready" && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-1 border-b border-[var(--qz-border)]">
              {tabs.map(([id, label, count]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={[
                      "px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors cursor-pointer",
                      active
                        ? "text-[var(--qz-accent)] border-[var(--qz-accent)]"
                        : "text-[var(--qz-fg-3)] border-transparent hover:text-[var(--qz-fg-1)]",
                    ].join(" ")}
                  >
                    {label}
                    <span className="ml-[6px] text-[12px] text-[var(--qz-fg-4)]">{count}</span>
                  </button>
                );
              })}
            </div>

            {tab === "config" ? (
              <DataTable
                rows={commits}
                columns={commitColumns}
                rowId={(r) => String(r.revision)}
                storageKey="system-audit-commits"
                searchPlaceholder="Search commits…"
                emptyMessage="No commit history recorded on this device."
                onRefresh={() => load("refresh")}
                actions={(row) => (
                  <span className="inline-flex items-center gap-1 justify-end">
                    <button
                      type="button"
                      title={`Show what revision ${row.revision} changed`}
                      aria-label="Show diff"
                      onClick={() => setDiffRevision(row.revision)}
                      className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
                    >
                      <FileDiff size={14} />
                    </button>
                    {/* Revision 0 IS the current config — nothing to roll back to. */}
                    {row.revision > 0 && (
                      <button
                        type="button"
                        title={`Roll the configuration back to revision ${row.revision}`}
                        aria-label="Roll back to this revision"
                        onClick={() => setRollbackTarget(row)}
                        className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
                      >
                        <History size={14} />
                      </button>
                    )}
                  </span>
                )}
              />
            ) : (
              <DataTable
                rows={log}
                columns={logColumns}
                rowId={(r) => String(r.id)}
                filters={logFilters}
                storageKey="system-audit-log"
                searchPlaceholder="Search log messages…"
                emptyMessage="No system log entries readable on this device."
                onRefresh={() => load("refresh")}
              />
            )}
          </div>
        )}
      </div>

      {diffRevision !== null && (
        <CommitDiffModal revision={diffRevision} onClose={() => setDiffRevision(null)} />
      )}

      {rollbackTarget && (
        <RollbackModal
          commit={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
          onStarted={() => {
            setRollbackTarget(null);
            setToast("Rollback applied — confirm it in the banner to keep it.");
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
