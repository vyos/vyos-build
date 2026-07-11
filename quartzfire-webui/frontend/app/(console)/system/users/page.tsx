"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Pencil, Plus, RotateCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Column, DataTable } from "@/components/dashboard/DataTable";
import { RowActions } from "@/components/dashboard/RowActions";
import { getCurrentUser } from "@/lib/api";
import { deleteUser, fetchSystemConfig, SystemUser } from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";
import { UserFormModal } from "./UserFormModal";

const columns: Column<SystemUser>[] = [
  { key: "name", header: "Username", value: (r) => r.name, mono: true, sortable: true, width: 160 },
  {
    key: "full_name",
    header: "Full Name",
    value: (r) => r.full_name ?? "",
    render: (r) => (r.full_name ? r.full_name : <span className="text-[var(--qz-fg-4)]">—</span>),
  },
  {
    key: "auth",
    header: "Authentication",
    value: (r) => (r.has_password ? "password" : "keys only"),
    render: (r) =>
      r.has_password ? (
        <span className="badge badge-ok">Password</span>
      ) : (
        <span className="badge badge-warn">Keys only</span>
      ),
    width: 130,
  },
  {
    key: "keys",
    header: "SSH Keys",
    value: (r) => r.keys.length,
    render: (r) =>
      r.keys.length > 0 ? (
        <span className="inline-flex items-center gap-[6px]">
          <KeyRound size={13} className="text-[var(--qz-fg-4)]" />
          {r.keys.length}
        </span>
      ) : (
        <span className="text-[var(--qz-fg-4)]">—</span>
      ),
    sortable: true,
    width: 100,
  },
];

export default function UsersPage() {
  const { setToast } = useDashboard();
  const [users, setUsers] = useState<SystemUser[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  // null = closed; { user: undefined } = create; { user } = edit.
  const [modal, setModal] = useState<{ user?: SystemUser } | null>(null);

  const currentUser = getCurrentUser()?.username ?? null;

  const load = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") setStatus("loading");
    try {
      setUsers((await fetchSystemConfig()).users);
      setStatus("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to load user accounts.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (user: SystemUser) => {
    try {
      await deleteUser(user.name);
      setToast(`Deleted user ${user.name}.`);
      await load("refresh");
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete user ${user.name}.`);
    }
  };

  const defaultVyosUser = users?.some((u) => u.name === "vyos") ?? false;

  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Users
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Administrator accounts — used for both the WebUI and console/SSH logins
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        {status === "loading" && (
          <div className="text-[13px] text-[var(--qz-fg-4)]">Loading user accounts…</div>
        )}
        {status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px] text-[var(--qz-danger)]">
              <AlertTriangle size={15} />
              {errorMsg}
            </div>
            <div>
              <Button kind="secondary" icon={RotateCw} onClick={load}>Retry</Button>
            </div>
          </div>
        )}
        {status === "ready" && users && (
          <div className="flex flex-col gap-4">
            {defaultVyosUser && (
              <div
                className="flex items-start gap-[10px] px-4 py-3 rounded-md text-[13px]"
                style={{
                  background: "color-mix(in oklab, var(--qz-warn) 10%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--qz-warn) 35%, transparent)",
                  color: "var(--qz-fg-1)",
                }}
              >
                <ShieldAlert size={16} className="flex-shrink-0 mt-[1px]" style={{ color: "var(--qz-warn)" }} />
                <span>
                  The built-in <span style={{ fontFamily: "var(--qz-font-mono)" }}>vyos</span> account exists on
                  every installation. Make sure its default password has been changed, or replace it with a
                  personal account and delete it.
                </span>
              </div>
            )}

            <DataTable
              rows={users}
              columns={columns}
              rowId={(r) => r.name}
              storageKey="system-users"
              searchPlaceholder="Search users…"
              emptyMessage="No user accounts configured."
              onRefresh={() => load("refresh")}
              toolbar={
                <Button kind="primary" size="sm" icon={Plus} onClick={() => setModal({})}>
                  Create user
                </Button>
              }
              actions={(row) => {
                // Deleting yourself would strand the session mid-flight, and
                // VyOS refuses an empty user set — guard both up front.
                if (row.name === currentUser || users.length === 1) {
                  return (
                    <div className="inline-flex items-center justify-end gap-1">
                      <button
                        type="button"
                        title={`Edit user ${row.name}`}
                        aria-label="Edit"
                        onClick={() => setModal({ user: row })}
                        className="grid place-items-center w-7 h-7 rounded-md bg-transparent border-0 text-[var(--qz-fg-4)] hover:text-[var(--qz-accent)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer"
                      >
                        <Pencil size={14} />
                      </button>
                      <span
                        className="text-[11px] text-[var(--qz-fg-4)] px-1"
                        title={row.name === currentUser ? "You can't delete the account you're signed in as." : "The last account can't be deleted."}
                      >
                        {row.name === currentUser ? "you" : "last"}
                      </span>
                    </div>
                  );
                }
                return (
                  <RowActions
                    label={`user ${row.name}`}
                    onEdit={() => setModal({ user: row })}
                    onDelete={() => remove(row)}
                  />
                );
              }}
            />
          </div>
        )}
      </div>

      {modal && users && (
        <UserFormModal
          initial={modal.user}
          existing={users}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            setToast(msg);
            load("refresh");
          }}
        />
      )}
    </div>
  );
}
