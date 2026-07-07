"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, ArrowUp, ArrowDown, RotateCw, X, Columns3, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface Column<T> {
  key: string;
  header: string;
  /** Value used for search + sort (and default display). */
  value: (row: T) => string | number | null;
  /** Optional custom cell rendering. */
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  mono?: boolean;
  width?: number;
  /** Smallest width (px) the column may be resized to. Defaults to 60. */
  minWidth?: number;
}

export interface FilterDef<T> {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  predicate: (row: T, value: string) => boolean;
}

const ALL = "__all__";
const MIN_COL = 60;

interface Layout {
  order: string[];
  widths: Record<string, number>;
  hidden: string[];
}

export function DataTable<T>({
  rows,
  columns,
  rowId,
  filters = [],
  searchPlaceholder = "Search…",
  emptyMessage = "No rows.",
  toolbar,
  actions,
  onRefresh,
  storageKey,
}: {
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  filters?: FilterDef<T>[];
  searchPlaceholder?: string;
  emptyMessage?: string;
  /** Right-aligned controls (e.g. a Create button). */
  toolbar?: React.ReactNode;
  /** Trailing per-row actions cell (e.g. edit/delete). Does not trigger row selection. */
  actions?: (row: T) => React.ReactNode;
  /** When provided, renders a Refresh button that re-runs this in place (spinner managed here). */
  onRefresh?: () => void | Promise<void>;
  /** Namespace for persisting column layout (order/width/visibility). Falls back to the column set. */
  storageKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── column layout (order / width / visibility), persisted per table ───────────
  const persistKey = `qz-table:${storageKey ?? columns.map((c) => c.key).join(",")}`;
  const defaultOrder = useMemo(() => columns.map((c) => c.key), [columns]);

  const stored = useMemo<Partial<Layout>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(persistKey);
      return raw ? (JSON.parse(raw) as Partial<Layout>) : {};
    } catch {
      return {};
    }
  }, [persistKey]);

  const [order, setOrder] = useState<string[]>(stored.order ?? defaultOrder);
  const [widths, setWidths] = useState<Record<string, number>>(stored.widths ?? {});
  const [hidden, setHidden] = useState<Set<string>>(new Set(stored.hidden ?? []));
  const [seeded, setSeeded] = useState(Object.keys(stored.widths ?? {}).length > 0);

  // Reconcile order with the actual column set (columns added/removed across versions).
  const orderedKeys = useMemo(() => {
    const known = new Set(defaultOrder);
    const kept = order.filter((k) => known.has(k));
    for (const k of defaultOrder) if (!kept.includes(k)) kept.push(k);
    return kept;
  }, [order, defaultOrder]);

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const visibleCols = useMemo(
    () => orderedKeys.map((k) => byKey.get(k)!).filter((c) => c && !hidden.has(c.key)),
    [orderedKeys, byKey, hidden],
  );

  const colWidth = (c: Column<T>) => widths[c.key] ?? c.width ?? (seeded ? 120 : undefined);

  // Persist layout whenever it changes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: Layout = { order: orderedKeys, widths, hidden: [...hidden] };
      window.localStorage.setItem(persistKey, JSON.stringify(payload));
    } catch {
      /* ignore quota / serialization errors */
    }
  }, [persistKey, orderedKeys, widths, hidden]);

  // Seed widths from the natural (auto-layout) render, then switch to fixed layout.
  const tableRef = useRef<HTMLTableElement>(null);
  useLayoutEffect(() => {
    if (seeded) return;
    const table = tableRef.current;
    if (!table) return;
    const measured: Record<string, number> = {};
    table.querySelectorAll<HTMLElement>("thead th[data-col-key]").forEach((th) => {
      const k = th.dataset.colKey!;
      measured[k] = Math.round(th.getBoundingClientRect().width);
    });
    setWidths((prev) => ({ ...measured, ...prev }));
    setSeeded(true);
  }, [seeded]);

  const resetLayout = () => {
    setOrder(defaultOrder);
    setHidden(new Set());
    setWidths({});
    setSeeded(false);
  };

  // ── column resize (transfers width to the right-hand neighbour) ───────────────
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{
    leftKey: string;
    rightKey: string;
    startX: number;
    startLeft: number;
    startRight: number;
    leftMin: number;
    rightMin: number;
  } | null>(null);

  const onResizeDown = (e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const left = visibleCols[index];
    const right = visibleCols[index + 1];
    if (!right) return;
    const th = (e.currentTarget.parentElement as HTMLElement).closest("th") as HTMLElement | null;
    const rightTh = th?.nextElementSibling as HTMLElement | null;
    resizeRef.current = {
      leftKey: left.key,
      rightKey: right.key,
      startX: e.clientX,
      startLeft: widths[left.key] ?? th?.getBoundingClientRect().width ?? 120,
      startRight: widths[right.key] ?? rightTh?.getBoundingClientRect().width ?? 120,
      leftMin: left.minWidth ?? MIN_COL,
      rightMin: right.minWidth ?? MIN_COL,
    };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [resizing]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      let delta = e.clientX - r.startX;
      delta = Math.max(delta, -(r.startLeft - r.leftMin));
      delta = Math.min(delta, r.startRight - r.rightMin);
      setWidths((w) => ({ ...w, [r.leftKey]: r.startLeft + delta, [r.rightKey]: r.startRight - delta }));
    };
    const up = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      setResizing(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  // ── column reorder (drag header onto another header) ──────────────────────────
  const dragColRef = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const reorderColumn = (from: string, to: string) => {
    if (!from || from === to) return;
    setOrder(() => {
      const arr = [...orderedKeys];
      const fi = arr.indexOf(from);
      if (fi < 0) return arr;
      arr.splice(fi, 1);
      const ti = arr.indexOf(to);
      if (ti < 0) return arr;
      arr.splice(ti, 0, from);
      return arr;
    });
  };

  // ── columns menu (visibility) ─────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const toggleColumn = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else if (visibleCols.length > 1) next.add(key); // keep at least one column
      return next;
    });

  // filter → search → sort
  const displayed = useMemo(() => {
    let r = rows;
    for (const f of filters) {
      const v = filterValues[f.key];
      if (v && v !== ALL) r = r.filter((row) => f.predicate(row, v));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      r = r.filter((row) =>
        columns.some((c) => {
          const val = c.value(row);
          return val != null && String(val).toLowerCase().includes(q);
        }),
      );
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col) {
        r = [...r].sort((a, b) => {
          const av = col.value(a);
          const bv = col.value(b);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          const cmp =
            typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av).localeCompare(String(bv), undefined, { numeric: true });
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
    }
    return r;
  }, [rows, columns, filters, filterValues, query, sortKey, sortDir]);

  const displayedIds = useMemo(() => displayed.map(rowId), [displayed, rowId]);

  // ── selection ────────────────────────────────────────────────────────────────
  const anchorRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const dragAdditiveRef = useRef(false);
  const dragBaseRef = useRef<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const end = () => {
      draggingRef.current = false;
      setIsDragging(false);
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  const allSelected = displayedIds.length > 0 && displayedIds.every((id) => selected.has(id));
  const someSelected = displayedIds.some((id) => selected.has(id));

  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) displayedIds.forEach((id) => next.delete(id));
      else displayedIds.forEach((id) => next.add(id));
      return next;
    });

  const toggleOne = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const id = displayedIds[index];
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setRange = (from: number, to: number, base: Set<string>) => {
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const next = new Set(base);
    for (let i = lo; i <= hi; i++) next.add(displayedIds[i]);
    setSelected(next);
  };

  // All selection logic happens on mousedown so it composes with drag.
  const onRowMouseDown = (e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    setIsDragging(true);

    if (e.shiftKey && anchorRef.current != null) {
      dragAdditiveRef.current = false;
      dragBaseRef.current = new Set();
      setRange(anchorRef.current, index, new Set());
      return; // keep existing anchor for continued range
    }

    if (e.ctrlKey || e.metaKey) {
      toggleOne(index);
      anchorRef.current = index;
      dragAdditiveRef.current = true;
      const base = new Set(selected);
      const id = displayedIds[index];
      if (base.has(id)) base.delete(id);
      else base.add(id);
      dragBaseRef.current = base;
      return;
    }

    anchorRef.current = index;
    dragAdditiveRef.current = false;
    dragBaseRef.current = new Set();
    setSelected(new Set([displayedIds[index]]));
  };

  const onRowMouseEnter = (index: number) => {
    if (!draggingRef.current || anchorRef.current == null) return;
    setRange(anchorRef.current, index, dragAdditiveRef.current ? dragBaseRef.current : new Set());
  };

  const selectedCount = selected.size;
  const colSpan = visibleCols.length + 1 + (actions ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
            style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--qz-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--qz-border)")}
          />
        </div>

        {filters.map((f) => (
          <div key={f.key} className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--qz-fg-4)]">{f.label}</span>
            <select
              value={filterValues[f.key] ?? ALL}
              onChange={(e) => setFilterValues((p) => ({ ...p, [f.key]: e.target.value }))}
              className="rounded-md px-2 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none cursor-pointer"
              style={{ background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" }}
            >
              <option value={ALL}>All</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ))}

        <div className="ml-auto flex items-center gap-3">
          {/* Columns menu */}
          <div className="relative" ref={menuRef}>
            <Button kind="secondary" size="sm" icon={Columns3} onClick={() => setMenuOpen((o) => !o)}>
              Columns
            </Button>
            {menuOpen && (
              <div
                className="absolute right-0 mt-1 z-20 rounded-md py-1 min-w-[200px]"
                style={{
                  background: "var(--qz-surface)",
                  border: "1px solid var(--qz-border)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                }}
              >
                <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--qz-fg-4)]">
                  Show columns
                </div>
                {orderedKeys.map((k) => {
                  const c = byKey.get(k);
                  if (!c) return null;
                  const visible = !hidden.has(k);
                  const lastVisible = visible && visibleCols.length === 1;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleColumn(k)}
                      disabled={lastVisible}
                      className="flex items-center gap-2 w-full px-3 py-[6px] text-[13px] text-left bg-transparent border-0 text-[var(--qz-fg-2)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span
                        className="grid place-items-center w-[15px] h-[15px] rounded-[4px] flex-shrink-0"
                        style={{
                          border: "1px solid var(--qz-border-strong)",
                          background: visible ? "var(--qz-accent)" : "var(--qz-input-bg)",
                        }}
                      >
                        {visible && <Check size={11} style={{ color: "var(--qz-fg-on-accent)" }} />}
                      </span>
                      {c.header}
                    </button>
                  );
                })}
                <div className="my-1 mx-3 border-t" style={{ borderColor: "var(--qz-divider)" }} />
                <button
                  type="button"
                  onClick={() => {
                    resetLayout();
                    setMenuOpen(false);
                  }}
                  className="flex items-center gap-2 w-full px-3 py-[6px] text-[13px] text-left bg-transparent border-0 text-[var(--qz-fg-3)] hover:bg-[color-mix(in_oklab,white_5%,transparent)] hover:text-[var(--qz-fg-1)] transition-colors cursor-pointer"
                >
                  <RotateCcw size={13} /> Reset layout
                </button>
              </div>
            )}
          </div>

          {onRefresh && (
            <Button kind="secondary" size="sm" icon={RotateCw} onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          )}
          {toolbar}
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            {displayed.length} {displayed.length === 1 ? "row" : "rows"}
          </span>
        </div>
      </div>

      {/* Selection bar */}
      {selectedCount > 0 && (
        <div
          className="flex items-center gap-3 px-3 py-2 rounded-md"
          style={{ background: "var(--qz-accent-soft)", border: "1px solid color-mix(in oklab, var(--qz-accent) 30%, transparent)" }}
        >
          <span className="text-[13px] font-medium text-[var(--qz-fg-1)]">
            {selectedCount} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-fg-1)] transition-colors cursor-pointer bg-transparent border-0 p-0 ml-auto"
          >
            <X size={13} /> Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div
        className="rounded-md overflow-hidden"
        style={{
          border: "1px solid var(--qz-border)",
          userSelect: isDragging ? "none" : "auto",
        }}
      >
        <table
          ref={tableRef}
          className="qz-table"
          style={{ tableLayout: seeded ? "fixed" : "auto", width: "100%" }}
        >
          <colgroup>
            <col style={{ width: 40 }} />
            {visibleCols.map((c) => (
              <col key={c.key} style={{ width: colWidth(c) }} />
            ))}
            {actions && <col style={{ width: 90 }} />}
          </colgroup>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleAll}
                  className="qz-check"
                  aria-label="Select all"
                />
              </th>
              {visibleCols.map((c, index) => (
                <th
                  key={c.key}
                  data-col-key={c.key}
                  draggable
                  onDragStart={(e) => {
                    if (resizeRef.current) {
                      e.preventDefault();
                      return;
                    }
                    dragColRef.current = c.key;
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!dragColRef.current || dragColRef.current === c.key) return;
                    e.preventDefault();
                    if (dragOverKey !== c.key) setDragOverKey(c.key);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragColRef.current) reorderColumn(dragColRef.current, c.key);
                    dragColRef.current = null;
                    setDragOverKey(null);
                  }}
                  onDragEnd={() => {
                    dragColRef.current = null;
                    setDragOverKey(null);
                  }}
                  style={{
                    cursor: c.sortable ? "pointer" : "grab",
                    position: "relative",
                    boxShadow:
                      dragOverKey === c.key ? "inset 2px 0 0 0 var(--qz-accent)" : undefined,
                  }}
                  onClick={() => {
                    if (!c.sortable) return;
                    if (sortKey === c.key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortKey(c.key);
                      setSortDir("asc");
                    }
                  }}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {sortKey === c.key &&
                      (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </span>
                  {index < visibleCols.length - 1 && (
                    <span
                      onMouseDown={(e) => onResizeDown(e, index)}
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e) => e.preventDefault()}
                      style={{
                        position: "absolute",
                        top: 0,
                        right: -3,
                        width: 7,
                        height: "100%",
                        cursor: "col-resize",
                        zIndex: 2,
                        userSelect: "none",
                      }}
                      aria-hidden
                    />
                  )}
                </th>
              ))}
              {actions && <th style={{ width: 90 }} className="text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="text-center text-[var(--qz-fg-4)]" style={{ cursor: "default" }}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              displayed.map((row, index) => {
                const id = displayedIds[index];
                const isSel = selected.has(id);
                return (
                  <tr
                    key={id}
                    className={isSel ? "selected" : ""}
                    onMouseDown={(e) => onRowMouseDown(e, index)}
                    onMouseEnter={() => onRowMouseEnter(index)}
                  >
                    <td onMouseDown={(e) => e.stopPropagation()} style={{ cursor: "default" }}>
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleOne(index)}
                        className="qz-check"
                        aria-label="Select row"
                      />
                    </td>
                    {visibleCols.map((c) => (
                      <td
                        key={c.key}
                        className={c.mono ? "mono" : undefined}
                        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {c.render ? c.render(row) : (c.value(row) ?? "—")}
                      </td>
                    ))}
                    {actions && (
                      <td
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{ cursor: "default" }}
                        className="text-right"
                      >
                        {actions(row)}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
