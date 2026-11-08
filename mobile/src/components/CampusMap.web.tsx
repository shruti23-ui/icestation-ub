// Web fallback for CampusMap: react-native-maps has no browser implementation, so on web we draw the same
// data (lot outlines, buildings, hazard pins) as an SVG schematic, Wayfinder-style: zoom (+/- buttons,
// mouse wheel, double-click) and drag to pan. Lot names appear as you zoom in; building names when zoomed
// in close. Shapes scale with zoom; labels and strokes stay constant-size and crisp.
// Plain DOM <svg> (not react-native-svg): its web shapes crash on pressable groups in this version.
import { Minus, Plus, RotateCcw } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { type Hazard, type Lot, type Meta } from "../api";
import { availability } from "../lotColors";
import { useStore } from "../store";
import { radius } from "../theme";
import LotSheet from "./LotSheet";
import { T } from "./ui";

const PAD = 28;
const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";
// Google Maps light ("white") palette for the schematic.
const MAP = {
  land: "#F1F3F4", text: "#202124", subtext: "#5F6368", halo: "#FFFFFF", building: "#BDC1C6",
  controlBg: "#FFFFFF", controlBorder: "#DADCE0", controlIcon: "#3C4043", hintBg: "rgba(255,255,255,0.92)",
};
const MIN_Z = 1, MAX_Z = 12;
const NAMES_AT = 2.2;       // zoom where lot names appear
const BUILDINGS_AT = 3.5;   // zoom where building names appear

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, list: Box[]) => list.some((p) => a.x0 < p.x1 && a.x1 > p.x0 && a.y0 < p.y1 && a.y1 > p.y0);

export default function CampusMap({ lots, hazards, meta, height = 300, highlightSlug, onPickLocation, counts = true, pin, onPin }: {
  lots: Lot[]; hazards: Hazard[]; meta: Meta | null; height?: number; highlightSlug?: string | null;
  onPickLocation?: (name: string) => void;
  /** false = no lot space-count pills (e.g. the Reports map) */
  counts?: boolean;
  /** Pin mode: show `pin` and call onPin(lat, lng) when the map is tapped. */
  pin?: { lat: number; lng: number } | null; onPin?: (lat: number, lng: number) => void;
}) {
  const { c } = useStore();
  const [width, setWidth] = useState(360);
  const [selId, setSelId] = useState<number | null>(null);
  const [hzId, setHzId] = useState<number | null>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });       // zoom + pan (screen px)
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const zoomAt = (factor: number, mx = width / 2, my = height / 2) =>
    setView((v) => {
      const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * factor));
      if (z === v.z) return v;
      return { z, x: mx - (mx - v.x) * (z / v.z), y: my - (my - v.y) * (z / v.z) };
    });

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }); // re-bind each render so zoomAt sees current size

  // Fit everything into the box at zoom 1 (equirectangular; fine at campus scale).
  const pts: [number, number][] = [
    ...lots.flatMap((l) => l.polygon as [number, number][]),
    ...(meta?.buildings ?? []).map((b) => [b.lat, b.lng] as [number, number]),
  ];
  if (!pts.length) return <View style={{ height }} />;
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = (maxLng - minLng) * k || 1e-6, spanY = maxLat - minLat || 1e-6;
  const usableH = height - 2 * PAD - 30;
  const base = Math.min((width - 2 * PAD) / spanX, usableH / spanY);
  const ox = (width - spanX * base) / 2, oy = PAD + (usableH - spanY * base) / 2;
  // Keep campus in view: the viewport centre must stay inside the lots' bounding box.
  const clamp = (v: { z: number; x: number; y: number }) => {
    const x0 = ox, x1 = ox + spanX * base, y0 = oy, y1 = oy + spanY * base;
    return { z: v.z,
      x: Math.min(width / 2 - x0 * v.z, Math.max(width / 2 - x1 * v.z, v.x)),
      y: Math.min(height / 2 - y0 * v.z, Math.max(height / 2 - y1 * v.z, v.y)) };
  };
  const world = (lat: number, lng: number) => [ox + (lng - minLng) * k * base, oy + (maxLat - lat) * base] as const;
  const v = clamp(view);   // zoom buttons/wheel can push the view off campus; clamp at render
  const screen = (lat: number, lng: number) => { const [x, y] = world(lat, lng); return [x * v.z + v.x, y * v.z + v.y] as const; };
  const visible = (x: number, y: number) => x > -40 && x < width + 40 && y > -20 && y < height + 20;

  const sel = lots.find((l) => l.id === selId) ?? null;
  const selHz = hazards.find((h) => h.id === hzId) ?? null;
  const showNames = view.z >= NAMES_AT;
  const select = (id: number) => { if (suppressClick.current) return; setSelId(id); setHzId(null); };

  // ---- labels: priority order, collision-avoided; a label that doesn't fit becomes a dot
  // Label priority: selected > recommended > FULL lots (drivers must see where not to go) > most open spaces.
  const priority = (l: Lot) => (l.id === selId ? 4e6 : 0) + (selId == null && l.slug === highlightSlug ? 2e6 : 0)
    + (availability(l, c).level === "full" ? 1e6 : 0) + l.available;
  const placed: Box[] = [];
  const labels = [...lots].sort((a, b) => priority(b) - priority(a)).flatMap((l) => {
    const [x, y] = screen(l.lat, l.lng);
    if (!visible(x, y)) return [];
    const av = availability(l, c), on = l.id === selId;
    const count = av.label;
    const pillW = 12 + count.length * 7, pillH = 20;
    const named = showNames || on || (selId == null && l.slug === highlightSlug);
    const nameW = named ? l.name.length * 6.6 + 6 : 0;
    const boxAt = (px: number, py: number, withName: boolean): Box => {
      const w = Math.max(pillW, withName ? nameW : 0);
      return { x0: px - w / 2 - 2, y0: py - pillH / 2 - (withName ? 17 : 2), x1: px + w / 2 + 2, y1: py + pillH / 2 + 2 };
    };
    // Try the lot's centre first; if that collides, nudge the pill (no name) to a nearby free spot before
    // falling back to a dot. Lots are packed tightly on campus, so this keeps FULL lots readable.
    // Every lot gets its number: try rings of nearby spots; if all collide, draw it at the lot anyway.
    const spots: [number, number, boolean][] = [[x, y, named], [x, y, false]];
    for (const r of [1, 2, 3]) {
      const dx = (pillW / 2 + 8) * r, dy = 18 * r;
      spots.push([x, y - dy, false], [x, y + dy, false], [x - dx, y, false], [x + dx, y, false],
        [x - dx, y - dy, false], [x + dx, y - dy, false], [x - dx, y + dy, false], [x + dx, y + dy, false]);
    }
    const free = spots.filter(([px, py]) => px - pillW / 2 > 2 && px + pillW / 2 < width - 2 && py - pillH / 2 > 2 && py + pillH / 2 < height - 2);
    const hit = on ? spots[0] : free.find(([px, py, n]) => !overlaps(boxAt(px, py, n), placed)) ?? [x, y, false] as [number, number, boolean];
    placed.push(boxAt(hit[0], hit[1], hit[2]));
    const [px, py, n] = hit;
    return [{ l, x: px, y: py, ax: x, ay: y, av, on, count, pillW, pillH, named: n, dot: false }];
  });

  const buildingLabels = view.z >= BUILDINGS_AT ? (meta?.buildings ?? []).flatMap((b) => {
    const [x, y] = screen(b.lat, b.lng);
    if (!visible(x, y)) return [];
    const box: Box = { x0: x - b.name.length * 3.2, y0: y + 4, x1: x + b.name.length * 3.2, y1: y + 18 };
    if (overlaps(box, placed)) return [];
    placed.push(box);
    return [{ b, x, y }];
  }) : [];

  return (
    <View style={{ height, borderRadius: radius.lg, overflow: "hidden", borderWidth: 1, borderColor: c.border, backgroundColor: MAP.land }}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <svg ref={svgRef} width={width} height={height}
        style={{ display: "block", cursor: drag.current?.moved ? "grabbing" : "grab", touchAction: "none", userSelect: "none" }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false }; suppressClick.current = false; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          setView((v) => clamp({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={() => { suppressClick.current = !!drag.current?.moved; drag.current = null; }}
        onPointerLeave={() => { drag.current = null; }}
        onDoubleClick={(e) => { const r = svgRef.current!.getBoundingClientRect(); zoomAt(1.8, e.clientX - r.left, e.clientY - r.top); }}
        onClick={(e) => {
          if (suppressClick.current) return;
          if (onPin) {   // screen -> lat/lng (inverse of world() + zoom/pan)
            const r = svgRef.current!.getBoundingClientRect();
            const wx = (e.clientX - r.left - v.x) / v.z, wy = (e.clientY - r.top - v.y) / v.z;
            onPin(maxLat - (wy - oy) / base, minLng + (wx - ox) / (k * base));
            return;
          }
          setSelId(null); setHzId(null);
        }}>
        <rect x={0} y={0} width={width} height={height} fill={MAP.land} />
        {/* Shapes scale with zoom; strokes stay 1-2 px */}
        <g transform={`translate(${v.x},${v.y}) scale(${v.z})`}>
          {lots.map((l) => {
            const edge = availability(l, c).fill;
            const hi = l.id === selId || (selId == null && l.slug === highlightSlug);
            return (
              <polygon key={l.id} points={l.polygon.map(([a, b]) => world(a, b).join(",")).join(" ")}
                fill={edge} fillOpacity={hi ? 0.35 : 0.2} stroke={edge} strokeOpacity={hi ? 1 : 0.65}
                strokeWidth={hi ? 2 : 1} vectorEffect="non-scaling-stroke"
                onClick={onPin ? undefined : (e) => { e.stopPropagation(); select(l.id); }}
                style={{ cursor: "pointer", pointerEvents: onPin ? "none" : undefined }} />
            );
          })}
        </g>
        {meta?.buildings.map((b) => {
          const [x, y] = screen(b.lat, b.lng);
          return visible(x, y) ? <rect key={b.name} x={x - 3} y={y - 3} width={6} height={6} rx={1.5} fill={MAP.building}><title>{b.name}</title></rect> : null;
        })}
        {buildingLabels.map(({ b, x, y }) => (
          <text key={`bl${b.name}`} x={x} y={y + 15} fill={MAP.subtext} fontSize={10.5} fontWeight={600} fontFamily={FONT} textAnchor="middle"
            stroke={MAP.halo} strokeWidth={3} paintOrder="stroke">{b.name}</text>
        ))}
        {onPickLocation && meta?.hazard_locations.map((h) => {
          const [x, y] = screen(h.lat, h.lng);
          return <circle key={h.name} cx={x} cy={y} r={6} fill="none" stroke={MAP.subtext} strokeWidth={1.5}
            onClick={(e) => { e.stopPropagation(); onPickLocation(h.name); }} style={{ cursor: "pointer" }} />;
        })}
        {hazards.map((h) => {
          const [x, y] = screen(h.lat, h.lng);
          return (
            <g key={h.id} onClick={(e) => { e.stopPropagation(); setHzId(h.id); setSelId(null); }} style={{ cursor: "pointer" }}>
              <title>{`${h.category_label}: ${h.location_name}`}</title>
              <WarningShape x={x} y={y} />
            </g>
          );
        })}
        {/* Lot labels (drawn low-priority first so important ones sit on top) */}
        {counts && [...labels].reverse().map(({ l, x, y, ax, ay, av, on, count, pillW, pillH, named, dot }) => (
          <g key={`t${l.id}`} onClick={(e) => { e.stopPropagation(); select(l.id); }} style={{ cursor: "pointer" }}>
            <title>{`${l.name}: ${l.available} of ${l.snow_adjusted_capacity} spaces open (estimate)`}</title>
            {dot ? <circle cx={x} cy={y} r={4} fill={av.fill} stroke={MAP.halo} strokeWidth={1.5} /> : (
              <>
                {(x !== ax || y !== ay) && (
                  <>
                    <line x1={ax} y1={ay} x2={x} y2={y} stroke={av.fill} strokeWidth={1.5} />
                    <circle cx={ax} cy={ay} r={3} fill={av.fill} stroke={MAP.halo} strokeWidth={1} />
                  </>
                )}
                {named && (
                  <text x={x} y={y - pillH / 2 - 5} fill={MAP.text} fontSize={11.5} fontWeight={700} fontFamily={FONT} textAnchor="middle"
                    stroke={MAP.halo} strokeWidth={3.5} strokeLinejoin="round" paintOrder="stroke">{l.name}</text>
                )}
                <rect x={x - pillW / 2} y={y - pillH / 2} width={pillW} height={pillH} rx={pillH / 2} fill={on ? MAP.text : av.fill} stroke={MAP.halo} strokeWidth={1.5} />
                <text x={x} y={y + 4} fill={on ? "#FFFFFF" : av.ink} fontSize={12} fontWeight={700} fontFamily={FONT} textAnchor="middle">{count}</text>
              </>
            )}
          </g>
        ))}
        {pin && (() => {   // the hazard being reported: a warning triangle on the spot
          const [x, y] = screen(pin.lat, pin.lng);
          return <g pointerEvents="none"><WarningShape x={x} y={y} scale={1.5} /></g>;
        })()}
      </svg>

      {/* Zoom controls */}
      <View style={{ position: "absolute", right: 8, top: 8, gap: 6 }}>
        <MapButton label="Zoom in" onPress={() => zoomAt(1.5)}><Plus size={16} color={MAP.controlIcon} /></MapButton>
        <MapButton label="Zoom out" onPress={() => zoomAt(1 / 1.5)}><Minus size={16} color={MAP.controlIcon} /></MapButton>
        {view.z > 1.01 && <MapButton label="Reset map" onPress={() => setView({ z: 1, x: 0, y: 0 })}><RotateCcw size={14} color={MAP.controlIcon} /></MapButton>}
      </View>

      {sel ? <LotSheet lot={sel} onClose={() => setSelId(null)} /> : (
        <View pointerEvents="none" style={{ position: "absolute", left: 8, right: 8, bottom: 8, flexDirection: "row", justifyContent: "space-between" }}>
          <T v="caption" color={MAP.subtext} style={{ backgroundColor: MAP.hintBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            {selHz ? `${selHz.category_label}${selHz.is_demo ? " (demo)" : ""} · ${selHz.location_name} · ${selHz.minutes_left} min left`
              : showNames ? "Tap a lot for directions" : "Zoom in for lot names · drag to move"}
          </T>
          <T v="caption" color={MAP.subtext} style={{ backgroundColor: MAP.hintBg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 }}>Schematic</T>
        </View>
      )}
    </View>
  );
}

function MapButton({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string }) {
  const { c } = useStore();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? "#F1F3F4" : MAP.controlBg, borderWidth: 1, borderColor: MAP.controlBorder,
        shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } })}>
      {children}
    </Pressable>
  );
}

/** Hazard marker: red warning triangle with a white "!", centred on the spot, white outline for the light map. */
function WarningShape({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const s = 11 * scale;   // half the side
  const top = y - s * 1.0, base = y + s * 0.75;
  return (
    <>
      <path d={`M ${x} ${top} L ${x + s} ${base} L ${x - s} ${base} Z`} fill="#E5383B" stroke="#FFFFFF" strokeWidth={2} strokeLinejoin="round" />
      <line x1={x} y1={top + s * 0.55} x2={x} y2={base - s * 0.62} stroke="#FFFFFF" strokeWidth={2.2 * scale} strokeLinecap="round" />
      <circle cx={x} cy={base - s * 0.3} r={1.3 * scale} fill="#FFFFFF" />
    </>
  );
}
