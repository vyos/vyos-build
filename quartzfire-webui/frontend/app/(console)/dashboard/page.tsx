"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DashboardGrid, TileInstance, findFreeCell, packTiles } from "@/components/dashboard/DashboardGrid";
import { TILE_REGISTRY, TILE_TYPES } from "@/components/dashboard/tiles";

const STORAGE_KEY = "qz-dashboard";

const DEFAULT_TILES: TileInstance[] = [{ id: "system-info-1", type: "system-info", x: 0, y: 0, w: 2, h: 6 }];

let idCounter = 0;
const newId = (type: string) => `${type}-${Date.now().toString(36)}-${idCounter++}`;

export default function DashboardPage() {
  const [tiles, setTiles] = useState<TileInstance[]>(DEFAULT_TILES);
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Load the saved layout (falls back to the default).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as TileInstance[]) : null;
      const valid = parsed?.filter((t) => TILE_REGISTRY[t.type]) ?? [];
      if (!valid.length) {
        setTiles(DEFAULT_TILES);
      } else {
        // Migrate older order-based layouts (no x/y) to explicit coordinates.
        const needsPack = valid.some((t) => t.x == null || t.y == null);
        setTiles(needsPack ? packTiles(valid) : valid);
      }
    } catch {
      setTiles(DEFAULT_TILES);
    }
  }, []);

  const update = useCallback((next: TileInstance[]) => {
    setTiles(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable — keep in-memory layout */
    }
  }, []);

  const addTile = (type: string) => {
    const def = TILE_REGISTRY[type];
    if (!def) return;
    const { x, y } = findFreeCell(tiles, def.defaultW, def.defaultH);
    update([...tiles, { id: newId(type), type, x, y, w: def.defaultW, h: def.defaultH }]);
    setPickerOpen(false);
  };

  const removeTile = (id: string) => update(tiles.filter((t) => t.id !== id));

  // Close the picker on an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  return (
    <div className="p-[28px_36px]">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          Dashboard
        </h1>

        <div className="flex items-center gap-2">
          {editing && (
            <div className="relative" ref={pickerRef}>
              <Button kind="secondary" size="sm" icon={Plus} onClick={() => setPickerOpen((o) => !o)}>
                Add component
              </Button>
              {pickerOpen && (
                <div
                  className="absolute right-0 mt-2 w-60 p-1 z-30 rounded-lg"
                  style={{
                    background: "var(--qz-surface-raised)",
                    border: "1px solid var(--qz-border)",
                    boxShadow: "var(--qz-shadow-2)",
                  }}
                >
                  {TILE_TYPES.map((def) => {
                    const added = tiles.some((t) => t.type === def.type);
                    return (
                      <button
                        key={def.type}
                        type="button"
                        disabled={added}
                        onClick={() => addTile(def.type)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] text-[var(--qz-fg-2)] hover:bg-[var(--qz-surface)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      >
                        {def.title}
                        {added && <span className="text-[11px] text-[var(--qz-fg-4)]">Added</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <Button
            kind={editing ? "primary" : "secondary"}
            size="sm"
            icon={editing ? Check : Pencil}
            onClick={() => {
              setEditing((e) => !e);
              setPickerOpen(false);
            }}
          >
            {editing ? "Done" : "Edit dashboard"}
          </Button>
        </div>
      </div>

      {tiles.length === 0 ? (
        <div className="text-[13px] text-[var(--qz-fg-4)] py-10 text-center">
          No components. Click <span className="text-[var(--qz-fg-2)]">Edit dashboard</span> to add some.
        </div>
      ) : (
        <DashboardGrid tiles={tiles} editing={editing} onChange={update} onRemove={removeTile} />
      )}
    </div>
  );
}
