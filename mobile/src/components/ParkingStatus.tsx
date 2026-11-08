import { router } from "expo-router";
import { Car, Compass, Footprints, LogOut, MapPin } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { directionsUrl, fmtTime } from "../api";
import { metersBetween } from "../parkDetect";
import { useParking } from "../parking";
import { useStore } from "../store";
import { space } from "../theme";
import { Badge, Button, Card, Chips, StatusDot, T, Toggle, row } from "./ui";

/** Main-page hero: where am I (auto-detected UB lot) and am I parked? */
export default function ParkingStatus() {
  const { c, lots, toast } = useStore();
  const pk = useParking();
  const [picking, setPicking] = useState(false);
  const [pickReason, setPickReason] = useState<string | null>(null);
  const openPicker = (reason: string | null) => { setPickReason(reason); setPicking(true); };
  const parked = async () => {
    const r = await pk.parkHere();
    if (!r.ok) openPicker(r.reason);
  };
  const s = pk.session;
  const saved = pk.savedCar;
  const isParked = Boolean(s || saved);
  const here = lots?.lots.find((l) => l.id === pk.hereLotId);
  const near = lots?.lots.find((l) => l.id === pk.nearest?.lotId);
  // The lot "Yes, I'm parked" will use: the one you're inside, else the nearest UB lot within 400 m.
  const target = here ?? (near && pk.nearest && pk.nearest.distanceM <= 400 ? near : undefined);
  // Lot lists: nearest first when we know where you are.
  const byDistance = [...(lots?.lots ?? [])].sort((a, b) => pk.position
    ? metersBetween(pk.position, a) - metersBetween(pk.position, b) : a.name.localeCompare(b.name));

  const carLat = s?.car_lat ?? saved?.lat ?? s?.lot?.lat;
  const carLng = s?.car_lng ?? saved?.lng ?? s?.lot?.lng;
  const carLotName = s?.lot?.name ?? saved?.lotName ?? "UB Campus";
  const parkedTime = s?.started_at ? fmtTime(s.started_at) : saved?.timestamp ? fmtTime(new Date(saved.timestamp).toISOString()) : null;
  const distToCar = pk.position && carLat && carLng ? Math.round(metersBetween(pk.position, { lat: carLat, lng: carLng })) : null;

  const where = pk.gps === "starting" ? { icon: <ActivityIndicator size="small" color={c.textMuted} />, text: "Finding your location…" }
    : pk.gps === "denied" ? { icon: <MapPin size={16} color={c.warn} />, text: "Location is off. Turn it on to detect your lot automatically." }
      : pk.gps === "off" ? { icon: <MapPin size={16} color={c.textMuted} />, text: "Location detection is off." }
        : pk.gps === "unavailable" ? { icon: <MapPin size={16} color={c.warn} />, text: "GPS isn't available on this device." }
          : here ? { icon: <MapPin size={16} color={c.success} />, text: `You're in ${here.name}` }
            : pk.onCampus && near ? { icon: <MapPin size={16} color={c.accent} />, text: `On North Campus · ${pk.nearest!.distanceM} m from ${near.name}` }
              : pk.onCampus === false ? { icon: <MapPin size={16} color={c.textMuted} />, text: "You're not on UB North Campus" }
                : { icon: <ActivityIndicator size="small" color={c.textMuted} />, text: "Finding your location…" };

  const findCar = () => {
    if (carLat == null || carLng == null) return;
    Linking.openURL(directionsUrl(carLat, carLng, "walking")).catch(() => toast("Couldn't open walking directions.", "error"));
  };

  const pinCurrentSpot = () => {
    if (!pk.position) return toast("Waiting for GPS location...", "info");
    pk.saveCar({
      lotId: here?.id ?? near?.id ?? null,
      lotName: here?.name ?? near?.name ?? "Pinned Location",
      lat: pk.position.lat,
      lng: pk.position.lng,
      timestamp: Date.now(),
    });
    toast("Saved your parked spot pin!");
  };

  return (
    <Card padded={false} style={{ borderColor: isParked ? c.success + "77" : c.accent + "55" }}>
      <View style={{ padding: space.lg, gap: space.md }}>
        <View style={row.between}>
          <View style={[row.gap, { flex: 1 }]}>
            {where.icon}
            <T v="label" color={here ? c.success : c.textMuted} style={{ flex: 1 }} numberOfLines={2}>{where.text}</T>
          </View>
          <View style={row.gap}>
            <StatusDot color={isParked ? c.success : c.textFaint} />
            <T v="caption" color={isParked ? c.success : c.textMuted}>{isParked ? "Parked" : "Not parked"}</T>
          </View>
        </View>

        {isParked ? (
          <>
            <View style={{ gap: 2 }}>
              <View style={row.gap}>
                <T v="heading" style={{ fontSize: 24 }}>Parked at {carLotName}</T>
                {s?.source === "auto" && <Badge tone="accent">Auto</Badge>}
                {saved && !s && <Badge tone="success">Pinned GPS</Badge>}
              </View>
              <T v="caption">
                {parkedTime ? `Since ${parkedTime}` : "Car pinned"}
                {distToCar != null ? ` · ${distToCar} m away` : ""} · GPS pin saved
              </T>
            </View>
            <View style={row.gap}>
              <Button
                title="Blizzard Radar"
                icon={<Compass size={18} color={c.onAccent} />}
                onPress={() => router.push("/radar")}
                style={{ flex: 1, height: 50 }}
              />
              <Button
                title="Walk directions"
                variant="secondary"
                icon={<Footprints size={16} color={c.text} />}
                onPress={findCar}
                style={{ flex: 1, height: 50 }}
              />
            </View>
            <View style={row.gap}>
              <Button
                title="I left (Free up spot)"
                variant="secondary"
                icon={<LogOut size={16} color={c.text} />}
                onPress={() => pk.checkOut("manual")}
                loading={pk.busy}
                style={{ flex: 1 }}
              />
              <Button title="Change lot" variant="ghost" onPress={() => openPicker(null)} />
            </View>
            {picking && (
              <View style={{ gap: space.sm }}>
                <T v="caption">Move your car pin to:</T>
                <Chips options={byDistance.filter((l) => l.id !== s?.lot?.id).map((l) => ({ value: String(l.id), label: l.name }))} value={null}
                  onChange={(v) => { setPicking(false); pk.checkIn(Number(v), "manual"); }} />
              </View>
            )}
          </>
        ) : picking ? (
          <View style={{ gap: space.sm }}>
            {pickReason && <T v="caption" color={c.warn}>{pickReason}</T>}
            <T v="subheading">Which UB lot?</T>
            <Chips options={byDistance.map((l) => ({ value: String(l.id), label: l.name }))} value={null}
              onChange={(v) => { setPicking(false); pk.checkIn(Number(v), "manual"); }} />
            <Button title="Cancel" variant="ghost" size="sm" onPress={() => setPicking(false)} />
          </View>
        ) : (
          <>
            <T v="heading" style={{ fontSize: 24 }}>{target ? `Parked at ${target.name}?` : "Did you just park?"}</T>
            <Button title={pk.locating ? "Finding your lot…" : target ? `Yes, I'm parked at ${target.name}` : "Yes, I'm parked"}
              icon={<Car size={18} color={c.onAccent} />} onPress={() => (target ? pk.checkIn(target.id, "manual") : parked())} loading={pk.busy || pk.locating} style={{ height: 52 }} />
            <Button title="I'm leaving" variant="secondary" onPress={() => pk.checkOut("manual")} style={{ height: 48, marginTop: 4 }} />
            <View style={row.between}>
              <Pressable onPress={pinCurrentSpot} hitSlop={8} style={row.gap}>
                <MapPin size={14} color={c.accent} />
                <T v="caption" color={c.accent}>Pin exact GPS spot without lot</T>
              </Pressable>
              <Pressable onPress={() => router.push("/radar")} hitSlop={8} style={row.gap}>
                <Compass size={14} color={c.accent} />
                <T v="caption" color={c.accent}>Radar</T>
              </Pressable>
              <Pressable onPress={() => openPicker(null)} hitSlop={8}>
                <T v="caption" color={c.textMuted}>Choose another lot</T>
              </Pressable>
            </View>
          </>
        )}
      </View>

      <View style={[row.between, { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.divider }]}>
        <View style={{ flex: 1 }}>
          <T v="subheading" style={{ fontSize: 14 }}>Auto-detect parking</T>
          <T v="caption">{pk.autoDetect ? "Checks you in and out automatically while the app is open" : "Off"}</T>
        </View>
        <Toggle value={pk.autoDetect} onChange={(v) => { pk.setAutoDetect(v); }} label="Auto-detect parking" />
      </View>
    </Card>
  );
}
