"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { TILE_REGISTRY } from "./tiles";

export interface TileInstance {
  id: string;
  type: string;
  /// Grid position (top-left), 0-based column/row. Size in grid units.
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID_COLS = 4;
const ROW_H = 76;
const GAP = 20;
const MAX_ROWS = 16;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Layout math (explicit coordinates) ────────────────────────────────────────
// Tiles are placed at explicit (x, y) cells rather than flowed by array order, so
// a tile stays exactly where it is dropped. Overlaps are resolved by pushing the
// other tiles straight down — the dragged/resized tile is treated as immovable.

const collides = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/// First empty cell (scanning top-to-bottom, left-to-right) that fits a w×h block
/// without overlapping anything already placed.
export function findFreeCell(placed: TileInstance[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      if (!placed.some((p) => collides(p, { x, y, w, h }))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/// Assign positions to tiles that have none (migrating an old order-based layout):
/// dense first-fit packing, preserving array order.
export function packTiles(tiles: TileInstance[]): TileInstance[] {
  const placed: TileInstance[] = [];
  for (const t of tiles) {
    const w = clamp(t.w, 1, GRID_COLS);
    const h = Math.max(1, t.h);
    const { x, y } = findFreeCell(placed, w, h);
    placed.push({ ...t, x, y, w, h });
  }
  return placed;
}

/// Resolve overlaps after a tile moved/resized. The `staticId` tile keeps its spot;
/// every other overlapping tile is pushed down until it clears. Returns tiles in the
/// original array order (positions updated).
function resolveLayout(tiles: TileInstance[], staticId: string): TileInstance[] {
  const placed: TileInstance[] = [];
  const staticTile = tiles.find((t) => t.id === staticId);
  if (staticTile) placed.push(staticTile);
  const rest = tiles.filter((t) => t.id !== staticId).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of rest) {
    let cur = t;
    while (placed.some((p) => collides(p, cur))) cur = { ...cur, y: cur.y + 1 };
    placed.push(cur);
  }
  return tiles.map((t) => placed.find((p) => p.id === t.id)!);
}

/// A 4-column dashboard grid. In edit mode tiles can be dragged to any cell (and stay
/// there) and resized via the corner handle. Layout changes are reported through
/// `onChange`; the parent owns persistence.
///
/// Each tile carries an explicit (x, y). Dragging snaps the tile's top-left to the grid
/// cell under the cursor and pushes any overlapped tiles down; the drag is always
/// recomputed from a layout snapshot taken at drag start, so moving the cursor around
/// never cascades tiles permanently.
///
/// While dragging, the tile is lifted into a cursor-following ghost (rendered in a portal
/// so the grid's overflow can't clip it) and its slot becomes a dimmed placeholder that
/// snaps between cells to preview the drop.
///
/// Pointer interactions use `setPointerCapture` + React handlers (not window listeners),
/// so each handler closes over the current `tiles`/`onChange` and never reads stale state.
export function DashboardGrid({
  tiles,
  editing,
  onChange,
  onRemove,
}: {
  tiles: TileInstance[];
  editing: boolean;
  onChange: (tiles: TileInstance[]) => void;
  onRemove: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  // Grab offset (pointer → tile top-left) and tile pixel size, so the ghost tracks the cursor.
  const dragMeta = useRef<{ grabX: number; grabY: number; width: number; height: number } | null>(null);
  // Stable layout captured at drag/resize start; every move recomputes from this.
  const baseTiles = useRef<TileInstance[]>([]);
  const resize = useRef<
    | null
    | { id: string; startX: number; startY: number; startW: number; startH: number; minW: number; minH: number; stepX: number }
  >(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);

  // Pixel size of one column, derived from the live container width.
  const cellWidth = () => {
    const cont = containerRef.current;
    if (!cont) return 0;
    return (cont.clientWidth - GAP * (GRID_COLS - 1)) / GRID_COLS;
  };

  // ── Drag (move a tile to an exact cell) ─────────────────────────────────────
  const onTileDown = (e: React.PointerEvent, id: string) => {
    if (!editing) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragMeta.current = {
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    baseTiles.current = tiles;
    dragId.current = id;
    setDraggingId(id);
    setGhost({ x: e.clientX, y: e.clientY });
  };

  const onTileMove = (e: React.PointerEvent, id: string) => {
    if (dragId.current !== id) return;
    setGhost({ x: e.clientX, y: e.clientY });

    const cont = containerRef.current;
    const meta = dragMeta.current;
    if (!cont || !meta) return;
    const tile = baseTiles.current.find((t) => t.id === id);
    if (!tile) return;

    // Snap the tile's top-left to the nearest cell under the cursor.
    const contRect = cont.getBoundingClientRect();
    const stepX = cellWidth() + GAP;
    const stepY = ROW_H + GAP;
    const x = clamp(Math.round((e.clientX - meta.grabX - contRect.left) / stepX), 0, GRID_COLS - tile.w);
    const y = clamp(Math.round((e.clientY - meta.grabY - contRect.top) / stepY), 0, MAX_ROWS);

    const moved = baseTiles.current.map((t) => (t.id === id ? { ...t, x, y } : t));
    onChange(resolveLayout(moved, id));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragId.current) (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragId.current = null;
    dragMeta.current = null;
    setDraggingId(null);
    setGhost(null);
  };

  // ── Resize (corner handle) ──────────────────────────────────────────────────
  const onResizeDown = (e: React.PointerEvent, tile: TileInstance) => {
    e.stopPropagation();
    e.preventDefault();
    const cont = containerRef.current;
    if (!cont) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResizingId(tile.id);
    baseTiles.current = tiles;
    const def = TILE_REGISTRY[tile.type];
    resize.current = {
      id: tile.id,
      startX: e.clientX,
      startY: e.clientY,
      startW: tile.w,
      startH: tile.h,
      minW: def?.minW ?? 1,
      minH: def?.minH ?? 1,
      stepX: cellWidth() + GAP,
    };
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r) return;
    const base = baseTiles.current.find((t) => t.id === r.id);
    if (!base) return;
    // Don't let a tile grow past the right edge from its current column.
    const w = clamp(r.startW + Math.round((e.clientX - r.startX) / r.stepX), r.minW, GRID_COLS - base.x);
    const h = clamp(r.startH + Math.round((e.clientY - r.startY) / (ROW_H + GAP)), r.minH, MAX_ROWS);
    const resized = baseTiles.current.map((t) => (t.id === r.id ? { ...t, w, h } : t));
    onChange(resolveLayout(resized, r.id));
  };

  const endResize = () => {
    resize.current = null;
    setResizingId(null);
  };

  const dragTile = draggingId ? tiles.find((t) => t.id === draggingId) : undefined;
  const dragDef = dragTile ? TILE_REGISTRY[dragTile.type] : undefined;

  // Enough rows to hold every tile, plus a few spare rows in edit mode so tiles can be
  // dropped into empty space below the current content.
  const maxBottom = tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  const rows = Math.max(maxBottom, 1) + (editing ? 3 : 0);

  return (
    <>
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, ${ROW_H}px)`,
        gridAutoRows: `${ROW_H}px`,
        gap: GAP,
      }}
    >
      {tiles.map((tile) => {
        const def = TILE_REGISTRY[tile.type];
        if (!def) return null;
        const isDragging = draggingId === tile.id;
        const isResizing = resizingId === tile.id;
        const w = clamp(tile.w, 1, GRID_COLS);
        return (
          <div
            key={tile.id}
            data-tile-id={tile.id}
            onPointerDown={(e) => onTileDown(e, tile.id)}
            onPointerMove={(e) => onTileMove(e, tile.id)}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            style={{
              gridColumn: `${tile.x + 1} / span ${w}`,
              gridRow: `${tile.y + 1} / span ${Math.max(1, tile.h)}`,
            }}
            className={[
              "surface relative overflow-hidden transition-shadow",
              editing ? "cursor-move select-none" : "",
              isResizing
                ? "ring-2 ring-[var(--qz-accent)] shadow-[var(--qz-shadow-3)] z-20"
                : isDragging
                  ? "border-2 border-dashed border-[var(--qz-accent)] opacity-50"
                  : editing
                    ? "ring-1 ring-[var(--qz-border-strong)]"
                    : "",
            ].join(" ")}
          >
            <div
              className={
                isDragging
                  ? "invisible h-full"
                  : editing
                    ? "pointer-events-none h-full overflow-hidden"
                    : "h-full overflow-auto"
              }
            >
              {def.render()}
            </div>

            {editing && !isDragging && (
              <>
                {isResizing && (
                  <div
                    className="absolute top-2 left-2 z-20 rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--qz-fg-on-accent)]"
                    style={{ background: "var(--qz-accent)", fontFamily: "var(--qz-font-mono)" }}
                  >
                    {tile.w} × {tile.h}
                  </div>
                )}
                <button
                  type="button"
                  aria-label="Remove tile"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(tile.id)}
                  className="absolute top-2 right-2 z-20 grid h-6 w-6 place-items-center rounded-md border border-[var(--qz-border)] bg-[var(--qz-surface-raised)] text-[var(--qz-fg-3)] transition-colors hover:border-[var(--qz-danger)] hover:text-[var(--qz-danger)]"
                >
                  <X size={13} />
                </button>
                <div
                  aria-label="Resize tile"
                  onPointerDown={(e) => onResizeDown(e, tile)}
                  onPointerMove={onResizeMove}
                  onPointerUp={endResize}
                  onPointerCancel={endResize}
                  className="absolute bottom-[5px] right-[5px] z-20 h-3.5 w-3.5 cursor-se-resize border-b-2 border-r-2 border-[var(--qz-fg-3)] hover:border-[var(--qz-accent)]"
                />
              </>
            )}
          </div>
        );
      })}
    </div>

      {/* Cursor-following ghost of the tile being dragged. Portalled to the body so the
          grid container's overflow never clips it. */}
      {ghost &&
        dragMeta.current &&
        dragDef &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: ghost.x - dragMeta.current.grabX,
              top: ghost.y - dragMeta.current.grabY,
              width: dragMeta.current.width,
              height: dragMeta.current.height,
              pointerEvents: "none",
              zIndex: 60,
            }}
            className="surface overflow-hidden opacity-95 rotate-[1deg] ring-2 ring-[var(--qz-accent)] shadow-[var(--qz-shadow-3)]"
          >
            <div className="pointer-events-none h-full overflow-hidden">{dragDef.render()}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
