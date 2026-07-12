"use client";

// Geolocation Map — a WebGL globe (cobe) with a marker on every country the
// firewall is currently exchanging traffic with. Data is the conntrack
// country sample the qzgeo `geoip-traffic` helper dumps to
// /run/quartzfire-geoip/traffic.json; positions come from a static centroid
// table. Marker size scales with the active-connection count.

import { useEffect, useMemo, useRef, useState } from "react";
import createGlobe, { Globe, Marker } from "cobe";
import { Globe2 } from "lucide-react";
import { countryCentroid } from "@/lib/countryCentroids";
import { countryName, fetchGeoCountries, fetchGeoTraffic, GeoCountry, GeoTrafficEntry } from "@/lib/geolocation";
import { LiveButton } from "./LiveButton";

const POLL_MS = 15_000;

export function GeolocationMapTile() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<Globe | null>(null);
  const phiRef = useRef(0);
  const pausedRef = useRef(false);
  const markersRef = useRef<Marker[]>([]);
  const pointer = useRef({ down: false, startX: 0, delta: 0 });

  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<GeoTrafficEntry[]>([]);
  const [countries, setCountries] = useState<GeoCountry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    fetchGeoCountries()
      .then((c) => setCountries(c.countries))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const load = async () => {
      try {
        const t = await fetchGeoTraffic();
        if (!alive) return;
        setEntries(t.countries ?? []);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [paused]);

  // Only countries we have a centroid for can be plotted; size by count.
  const markers = useMemo<Marker[]>(() => {
    const max = entries.reduce((m, e) => Math.max(m, e.count), 0) || 1;
    const out: Marker[] = [];
    for (const e of entries) {
      const loc = countryCentroid(e.code);
      if (loc) out.push({ location: loc, size: 0.02 + (e.count / max) * 0.06 });
    }
    return out;
  }, [entries]);

  // Push new markers to the live globe without recreating it.
  useEffect(() => {
    markersRef.current = markers;
    globeRef.current?.update({ markers });
  }, [markers]);

  // Create the globe once and drive it from a rAF loop (cobe v2 has no
  // onRender). Rotation auto-advances unless paused or being dragged.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let side = Math.max(1, Math.min(wrap.clientWidth, wrap.clientHeight));
    const applySize = () => {
      side = Math.max(1, Math.min(wrap.clientWidth, wrap.clientHeight));
      canvas.style.width = `${side}px`;
      canvas.style.height = `${side}px`;
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);

    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: side * 2,
      height: side * 2,
      phi: phiRef.current,
      theta: 0.22,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 6,
      baseColor: [0.09, 0.42, 0.32],
      markerColor: [0.96, 0.35, 0.35],
      glowColor: [0.0, 0.55, 0.38],
      markers: markersRef.current,
    });
    globeRef.current = globe;

    let raf = requestAnimationFrame(function tick() {
      if (!pointer.current.down && !pausedRef.current) phiRef.current += 0.004;
      globe.update({ phi: phiRef.current + pointer.current.delta, width: side * 2, height: side * 2 });
      raf = requestAnimationFrame(tick);
    });

    const onDown = (e: PointerEvent) => {
      pointer.current.down = true;
      pointer.current.startX = e.clientX;
      canvas.style.cursor = "grabbing";
    };
    const onUp = () => {
      if (!pointer.current.down) return;
      pointer.current.down = false;
      phiRef.current += pointer.current.delta;
      pointer.current.delta = 0;
      canvas.style.cursor = "grab";
    };
    const onMove = (e: PointerEvent) => {
      if (pointer.current.down) pointer.current.delta = (e.clientX - pointer.current.startX) / 200;
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointermove", onMove);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointermove", onMove);
      globe.destroy();
      globeRef.current = null;
    };
  }, []);

  const total = entries.reduce((n, e) => n + e.count, 0);
  const top = useMemo(
    () =>
      [...entries]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map((e) => countryName(countries, e.code))
        .join(", "),
    [entries, countries],
  );

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3 flex-shrink-0">
        <div className="flex items-center gap-[9px] min-w-0">
          <Globe2 size={18} className="text-[var(--qz-accent)]" />
          <h2 className="text-[16px] font-bold text-[var(--qz-fg-1)] m-0 truncate" style={{ letterSpacing: "-0.01em" }}>
            Geolocation Map
          </h2>
          <span className="text-[11px] text-[var(--qz-fg-4)] flex-shrink-0">traffic by country</span>
        </div>
        <LiveButton paused={paused} onToggle={() => setPaused((p) => !p)} />
      </div>

      {error && entries.length === 0 && <div className="text-[13px] text-[var(--qz-danger)] mb-2">{error}</div>}

      <div ref={wrapRef} className="flex-1 min-h-[160px] grid place-items-center overflow-hidden">
        <canvas ref={canvasRef} style={{ cursor: "grab", contain: "layout paint size", maxWidth: "100%", maxHeight: "100%" }} />
      </div>

      <div className="mt-2 flex-shrink-0 text-center text-[12px] text-[var(--qz-fg-4)]">
        {markers.length === 0
          ? "No traffic sampled yet."
          : `${markers.length} ${markers.length === 1 ? "country" : "countries"} · ${total.toLocaleString()} active connections${top ? ` · ${top}` : ""}`}
      </div>
    </div>
  );
}
