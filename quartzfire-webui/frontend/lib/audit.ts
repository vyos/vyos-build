// Audit data layer: the device's commit history (every configuration change,
// whoever made it — WebUI, CLI, or API) and the system journal (the firewall
// OS's own logs). Traffic logs are deliberately excluded — they live on the
// Traffic Monitor page.

import { apiFetch, vyosApi } from "./api";
import { VyosResponse } from "./interfaces";

/// One configuration commit, from `show system commit`. Revision 0 is the
/// most recent commit.
export interface CommitEntry {
  revision: number;
  /** Device-local commit time, as the CLI renders it. */
  date: string;
  user: string;
  /** How the commit was made: cli, api, init, … */
  via: string;
  comment: string | null;
}

/// One system journal entry, from the backend's journalctl reader.
export interface SystemLogEntry {
  /** Milliseconds since the epoch. */
  ts: number;
  unit: string;
  /** Syslog priority 0–7, lower = more severe. */
  priority: number;
  message: string;
}

/// Parse `show system commit` output. Each revision renders as
/// `0   2026-07-09 12:34:56 by vyos via api`; a commit comment follows on its
/// own indented line.
export function parseCommitHistory(text: string): CommitEntry[] {
  const out: CommitEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+by\s+(\S+)(?:\s+via\s+(\S+))?/.exec(line);
    if (m) {
      out.push({
        revision: Number(m[1]),
        date: m[2].replace(/\s+/g, " "),
        user: m[3],
        via: m[4] ?? "",
        comment: null,
      });
    } else if (out.length > 0 && line.trim() && !/^Revisions/i.test(line.trim())) {
      // Continuation line — the previous revision's commit comment.
      const last = out[out.length - 1];
      last.comment = last.comment ? `${last.comment} ${line.trim()}` : line.trim();
    }
  }
  return out;
}

/// Commit history, newest first (revision 0 = latest).
export async function fetchCommitHistory(): Promise<CommitEntry[]> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["system", "commit"],
  });
  if (!resp.success) {
    throw new Error(resp.error || "Device returned an error reading the commit history.");
  }
  return parseCommitHistory(resp.data ?? "");
}

/// What one commit changed, as the device's own diff text (empty when the
/// device can no longer produce it, e.g. the oldest retained revision).
export async function fetchCommitDiff(revision: number): Promise<string> {
  const resp = await vyosApi<VyosResponse<string | null>>("show", {
    op: "show",
    path: ["system", "commit", "diff", String(revision)],
  });
  if (!resp.success) {
    throw new Error(resp.error || `Device returned an error diffing revision ${revision}.`);
  }
  return resp.data ?? "";
}

/// Recent system journal entries, newest first, traffic lines excluded.
export function fetchSystemLog(): Promise<SystemLogEntry[]> {
  return apiFetch<SystemLogEntry[]>("/monitor/system-log");
}
