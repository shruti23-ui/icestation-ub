import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import MapView, { Marker, Polygon, PROVIDER_GOOGLE } from "react-native-maps";
import { TriangleAlert } from "lucide-react-native";
import { type Hazard, type Lot, type Meta } from "../api";
import { availability } from "../lotColors";
import { useStore } from "../store";
import { radius } from "../theme";
import LotSheet from "./LotSheet";
import { T } from "./ui";

// Google's standard light ("white") map, as in Google Maps. Labels on top use dark text with a white halo.
const MAP_TEXT = "#202124";      // Google label grey-black
const MAP_SUBTEXT = "#5F6368";
const MAP_HALO = "rgba(255,255,255,0.95)";
// Hide Google's own business pins so lot labels stay readable; everything else is the default light style.
const LIGHT = [{ featureType: "poi.business", stylers: [{ visibility: "off" }] }];

// Label detail by zoom (latitudeDelta of the visible region; smaller = closer):
// overview -> open-space counts only; zoomed in -> lot names; zoomed in close -> building names too.
const NAMES_BELOW = 0.0045;
// Keep the map on UB North Campus: no zooming out past campus level (~2.5 km across), no panning far away.
const MIN_ZOOM = 14;
const BOUNDS_PAD_DEG = 0.006;   // ~600 m of context around the outermost lots
const BUILDINGS_BELOW = 0.0026;

/** Campus map, Wayfinder-style: lot outlines with open-space counts, lot names when you zoom in, building
 *  names when you zoom in close. Tap a lot for its card and Google Maps directions. */
export default function CampusMap({ lots, hazards, meta, height = 300, highlightSlug, onPickLocation, counts = true, pin, onPin }: {
  lots: Lot[]; hazards: Hazard[]; meta: Meta | null; height?: number; highlightSlug?: string | null;
  onPickLocation?: (name: string) => void;
  /** false = no lot space-count pills (e.g. the Reports map) */
  counts?: boolean;
  /** Pin mode: show a draggable `pin`; tapping the map or dragging calls onPin(lat, lng). */
  pin?: { lat: number; lng: number } | null; onPin?: (lat: number, lng: number) => void;
}) {
  const { c } = useStore();
  const [selId, setSelId] = useState<number | null>(null);
  const [delta, setDelta] = useState(0.012);
  const sel = lots.find((l) => l.id === selId) ?? null;
  const mapRef = useRef<MapView | null>(null);
  // Frame every UB lot (falls back to the campus centre before lots load).
  const frame = useMemo(() => {
    const pts = lots.flatMap((l) => l.polygon);
    if (!pts.length) {
      const [lat, lng] = meta?.campus_center ?? [43.0012, -78.788];
      return { region: { latitude: lat, longitude: lng, latitudeDelta: 0.012, longitudeDelta: 0.016 }, ne: null, sw: null };
    }
    const la = pts.map((p) => p[0]), ln = pts.map((p) => p[1]);
    const [s, n, w, e] = [Math.min(...la), Math.max(...la), Math.min(...ln), Math.max(...ln)];
    return {
      region: { latitude: (s + n) / 2, longitude: (w + e) / 2, latitudeDelta: (n - s) * 1.25, longitudeDelta: (e - w) * 1.25 },
      ne: { latitude: n + BOUNDS_PAD_DEG, longitude: e + BOUNDS_PAD_DEG }, sw: { latitude: s - BOUNDS_PAD_DEG, longitude: w - BOUNDS_PAD_DEG },
    };
  }, [lots.length > 0, meta?.campus_center?.[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const region = frame.region;
  const showNames = delta < NAMES_BELOW;
  const showBuildings = delta < BUILDINGS_BELOW;
  // Android draws custom markers as bitmaps. With tracksViewChanges=false from the start the bitmap can be taken
  // before the label has laid out, so the pill shows up empty (no numbers). Track changes until the labels have
  // rendered, then freeze them for smooth panning. Re-arms whenever counts, selection or zoom detail change.
  const labelsKey = lots.map((l) => `${l.id}:${l.available}/${l.snow_adjusted_capacity}`).join(",") + `|${selId}|${showNames}|${showBuildings}`;
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), 1500);
    return () => clearTimeout(t);
  }, [labelsKey]);

  return (
    <View style={{ height, borderRadius: radius.lg, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
      <MapView style={{ flex: 1 }} initialRegion={region} customMapStyle={LIGHT} userInterfaceStyle="light"
        // Google Maps on Android (works in Expo Go). iOS Expo Go only ships Apple Maps; directions still open Google Maps.
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        ref={mapRef} minZoomLevel={MIN_ZOOM} maxZoomLevel={20}
        onMapReady={() => { if (Platform.OS === "android" && frame.ne && frame.sw) mapRef.current?.setMapBoundaries(frame.ne, frame.sw); }}
        showsPointsOfInterests={false} toolbarEnabled={false} rotateEnabled={false} pitchEnabled={false}
        onRegionChangeComplete={(r) => setDelta(r.latitudeDelta)}
        onPress={onPin ? (e) => onPin(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude) : undefined}>
        {lots.map((l) => {
          const hi = l.id === selId || (selId == null && l.slug === highlightSlug);
          const edge = availability(l, c).fill;
          return (
            <Polygon key={l.id} coordinates={l.polygon.map(([a, b]) => ({ latitude: a, longitude: b }))} tappable={!onPin} onPress={onPin ? undefined : () => setSelId(l.id)}
              strokeColor={hi ? edge : edge + "AA"} strokeWidth={hi ? 2.5 : 1.2} fillColor={edge + (hi ? "55" : "26")} />
          );
        })}
        {counts && lots.map((l) => {
          const a = availability(l, c);
          const on = l.id === selId;
          return (
            <Marker key={`m${l.id}`} coordinate={{ latitude: l.lat, longitude: l.lng }}
              onPress={() => setSelId(l.id)} tracksViewChanges={track} anchor={{ x: 0.5, y: showNames ? 0.7 : 0.5 }}
              accessibilityLabel={`${l.name}, ${l.available} of ${l.snow_adjusted_capacity} spaces open`}>
              <View collapsable={false} style={{ alignItems: "center" }}>
                {showNames && (
                  <Text numberOfLines={1} style={{ color: MAP_TEXT, fontSize: 12, fontWeight: "700", marginBottom: 3, maxWidth: 140,
                    textShadowColor: MAP_HALO, textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } }}>
                    {l.name}
                  </Text>
                )}
                <View collapsable={false} style={{ backgroundColor: on ? c.text : a.fill, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3,
                  borderWidth: 2, borderColor: "#FFFFFF", minWidth: 44, alignItems: "center" }}>
                  <Text numberOfLines={1} style={{ color: on ? c.bg : a.ink, fontSize: 13, fontWeight: "800", includeFontPadding: false }}>{a.label}</Text>
                </View>
              </View>
            </Marker>
          );
        })}
        {showBuildings && meta?.buildings.map((b) => (
          <Marker key={`b${b.name}`} coordinate={{ latitude: b.lat, longitude: b.lng }} tracksViewChanges={track} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={{ alignItems: "center", gap: 2 }}>
              <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: MAP_SUBTEXT }} />
              <Text style={{ color: MAP_SUBTEXT, fontSize: 11, fontWeight: "600",
                textShadowColor: MAP_HALO, textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } }}>{b.name}</Text>
            </View>
          </Marker>
        ))}
        {onPickLocation && meta?.hazard_locations.map((h) => (
          <Marker key={h.name} coordinate={{ latitude: h.lat, longitude: h.lng }} title={h.name} description="Tap to report here"
            pinColor={c.textMuted} onCalloutPress={() => onPickLocation(h.name)} onPress={() => onPickLocation(h.name)} />
        ))}
        {hazards.map((h) => (
          <Marker key={`h${h.id}`} coordinate={{ latitude: h.lat, longitude: h.lng }}
            title={`${h.category_label}${h.is_demo ? " (demo)" : ""}`}
            description={`${h.location_name} · ${Math.round(h.confidence * 100)}% · ${h.minutes_left} min left${h.hard_stop_for_wheelchairs ? " · Not passable by wheelchair" : ""}`}
            anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={track}>
            <HazardMark />
          </Marker>
        ))}
        {pin && (
          <Marker coordinate={{ latitude: pin.lat, longitude: pin.lng }} draggable anchor={{ x: 0.5, y: 0.5 }}
            onDragEnd={(e) => onPin?.(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude)}
            title="Hazard here" description="Drag to adjust">
            <HazardMark size={40} />
          </Marker>
        )}
      </MapView>
      {sel ? <LotSheet lot={sel} onClose={() => setSelId(null)} /> : (
        <View pointerEvents="none" style={{ position: "absolute", left: 8, bottom: 8, backgroundColor: "rgba(255,255,255,0.92)", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
          <T v="caption" color={MAP_SUBTEXT}>{showNames ? "Tap a lot for directions" : "Pinch to zoom for lot names · tap a lot for directions"}</T>
        </View>
      )}
    </View>
  );
}

/** Hazard marker: a red warning triangle with a white "!" (lucide outline drawn white over a red fill). */
function HazardMark({ size = 30 }: { size?: number }) {
  return (
    <View collapsable={false} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <TriangleAlert size={size} color="#FFFFFF" fill="#E5383B" strokeWidth={2.2} />
    </View>
  );
}
