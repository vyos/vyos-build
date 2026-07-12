"use client";

// Create/Edit dialog for a geolocation action: name, mode, the searchable
// country multi-select (grouped by continent with select-all conveniences),
// unknown-IP handling, and the log toggle.

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useDashboard } from "@/lib/DashboardContext";
import {
  CONTINENT_NAMES,
  flagEmoji,
  GeoAction,
  GeoActionUpdate,
  GeoCountry,
  GeoMode,
  GeoUnknown,
  validateActionName,
} from "@/lib/geolocation";

const inputStyle = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;

export function ActionFormModal({
  initial,
  countries,
  countriesAvailable,
  existingNames,
  onCancel,
  onSave,
}: {
  /** Action being edited, or null when creating. */
  initial: GeoAction | null;
  countries: GeoCountry[];
  /** False before the first database download — the picker still works from
   *  any codes already in the config, plus manual code entry. */
  countriesAvailable: boolean;
  existingNames: string[];
  onCancel: () => void;
  onSave: (update: GeoActionUpdate) => Promise<void>;
}) {
  const { setToast } = useDashboard();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [mode, setMode] = useState<GeoMode>(initial?.mode ?? "block-listed");
  const [selected, setSelected] = useState<Set<string>>(new Set(initial?.countries ?? []));
  const [unknownIp, setUnknownIp] = useState<GeoUnknown>(initial?.unknownIp ?? "allow");
  const [log, setLog] = useState(initial?.log ?? false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  // Codes present in the config but absent from the database list (older
  // database, or no database yet) still need rows so they can be deselected.
  const allCountries = useMemo(() => {
    const known = new Set(countries.map((c) => c.code));
    const extras = [...selected]
      .filter((code) => !known.has(code))
      .map((code) => ({ code, name: code, continent: null as string | null }));
    return [...countries, ...extras];
  }, [countries, selected]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byContinent = new Map<string, GeoCountry[]>();
    for (const c of allCountries) {
      if (q && !c.name.toLowerCase().includes(q) && !c.code.toLowerCase().includes(q)) continue;
      const key = c.continent ?? "??";
      const list = byContinent.get(key) ?? [];
      list.push(c);
      byContinent.set(key, list);
    }
    return [...byContinent.entries()]
      .map(([code, list]) => ({
        code,
        name: CONTINENT_NAMES[code] ?? "Other",
        countries: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allCountries, q]);

  const toggle = (code: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const setContinent = (codes: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const code of codes) {
        if (on) next.add(code);
        else next.delete(code);
      }
      return next;
    });

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setToast("Give the action a name.");
    const nameError = validateActionName(trimmed);
    if (nameError) return setToast(nameError);
    if ((initial === null || trimmed !== initial.name) && existingNames.includes(trimmed)) {
      return setToast(`An action named "${trimmed}" already exists.`);
    }
    // block-listed with no countries = allow all (the default Global action);
    // allow-listed with none would block everything, which is a mistake.
    if (selected.size === 0 && mode !== "block-listed") {
      return setToast("Select at least one country — an allow-listed action with no countries blocks everything.");
    }
    setBusy(true);
    try {
      await onSave({
        name: trimmed,
        description: description.trim() || null,
        mode,
        countries: [...selected].sort(),
        unknownIp,
        log,
        original_name: initial?.name ?? null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onCancel} maxWidth={720}>
      <ModalHeader
        title={initial ? `Edit Action — ${initial.name}` : "New Geolocation Action"}
        subtitle="A reusable country policy; attach it to firewall rules on the Policies tab."
        onClose={onCancel}
      />

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <label className="text-[13px] text-[var(--qz-fg-3)] w-[90px]">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Block_high_risk"
            className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none"
            style={inputStyle}
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-[13px] text-[var(--qz-fg-3)] w-[90px]">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className="flex-1 rounded-md px-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none"
            style={inputStyle}
          />
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[13px] text-[var(--qz-fg-3)] w-[90px]">Mode</span>
          <Segmented
            items={[
              { value: "block-listed", label: "Block selected countries" },
              { value: "allow-listed", label: "Only allow selected countries" },
            ]}
            value={mode}
            onChange={(v) => setMode(v as GeoMode)}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search size={14} className="absolute left-[10px] top-1/2 -translate-y-1/2 text-[var(--qz-fg-4)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search countries…"
              className="rounded-md pl-8 pr-3 py-[7px] text-[13px] text-[var(--qz-fg-1)] outline-none w-[240px]"
              style={inputStyle}
            />
          </div>
          <span className="text-[12px] text-[var(--qz-fg-4)]">
            {selected.size} {selected.size === 1 ? "country" : "countries"} selected
            {selected.size > 0 && (
              <button
                onClick={() => setSelected(new Set())}
                className="ml-2 text-[var(--qz-fg-4)] underline"
                style={{ background: "transparent", border: 0, cursor: "pointer" }}
              >
                clear
              </button>
            )}
          </span>
        </div>

        {!countriesAvailable && (
          <p className="text-[12px] text-[var(--qz-fg-4)] m-0">
            The location database has not been downloaded yet, so the full country list is
            unavailable — trigger an update from the status card first.
          </p>
        )}

        <div
          className="rounded-md overflow-auto"
          style={{ border: "1px solid var(--qz-border)", maxHeight: "40vh" }}
        >
          {groups.length === 0 ? (
            <div className="text-center text-[13px] text-[var(--qz-fg-4)] py-6">
              No countries match.
            </div>
          ) : (
            groups.map((g) => {
              const codes = g.countries.map((c) => c.code);
              const allOn = codes.every((code) => selected.has(code));
              return (
                <div key={g.code}>
                  <div
                    className="flex items-center gap-3 px-3 py-[7px] sticky top-0"
                    style={{ background: "var(--qz-input-bg)", borderBottom: "1px solid var(--qz-border)" }}
                  >
                    <span className="text-[13px] font-semibold text-[var(--qz-fg-1)] flex-1">
                      {g.name}
                    </span>
                    <button
                      onClick={() => setContinent(codes, !allOn)}
                      className="text-[11px] px-2 py-[2px] rounded"
                      style={{
                        border: "1px solid var(--qz-border)",
                        background: allOn ? "var(--qz-accent-soft)" : "transparent",
                        color: "var(--qz-fg-2)",
                        cursor: "pointer",
                      }}
                    >
                      {allOn ? "Deselect all" : "Select all"}
                    </button>
                  </div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    {g.countries.map((c) => (
                      <label
                        key={c.code}
                        className="flex items-center gap-2 px-3 py-[5px] text-[13px] text-[var(--qz-fg-1)] cursor-pointer"
                        style={{ borderBottom: "1px solid var(--qz-border)" }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(c.code)}
                          onChange={() => toggle(c.code)}
                          style={{ accentColor: "var(--qz-accent)" }}
                        />
                        <span>{flagEmoji(c.code)}</span>
                        <span className="flex-1" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name}
                        </span>
                        <span className="mono text-[11px] text-[var(--qz-fg-4)]">{c.code}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--qz-fg-3)]">Unclassified (unknown) IPs:</span>
            <Segmented
              items={[
                { value: "allow", label: "Allow" },
                { value: "block", label: "Block" },
              ]}
              value={unknownIp}
              onChange={(v) => setUnknownIp(v as GeoUnknown)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch on={log} onChange={setLog} />
            <span className="text-[13px] text-[var(--qz-fg-3)]">
              Log blocked packets <span className="mono text-[11px]">[GEO-{name.trim() || "name"}]</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 justify-end mt-1">
          <Button kind="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : initial ? "Save action" : "Add action"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
