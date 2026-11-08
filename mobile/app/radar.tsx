import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { router } from "expo-router";
import { ArrowLeft, Compass, Footprints, MapPin, Navigation, ShieldAlert, Sparkles, Volume2 } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Easing, Linking, Pressable, StyleSheet, View } from "react-native";
import { directionsUrl } from "../src/api";
import Header from "../src/components/Header";
import { Badge, Button, Card, Screen, T, row } from "../src/components/ui";
import { metersBetween } from "../src/parkDetect";
import { useParking } from "../src/parking";
import { useStore } from "../src/store";
import { radius, space } from "../src/theme";

const { width } = Dimensions.get("window");
const RADAR_SIZE = Math.min(width - 48, 320);

function calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export default function BlizzardRadar() {
  const { c, toast } = useStore();
  const pk = useParking();
  const [heading, setHeading] = useState<number>(0);

  const s = pk.session;
  const saved = pk.savedCar;
  const hasSavedCar = Boolean(s?.car_lat || saved?.lat || s?.lot?.lat);
  const demoLat = pk.position ? pk.position.lat + 0.00012 : 43.0033;
  const demoLng = pk.position ? pk.position.lng + 0.00012 : -78.7878;
  const carLat = s?.car_lat ?? saved?.lat ?? s?.lot?.lat ?? demoLat;
  const carLng = s?.car_lng ?? saved?.lng ?? s?.lot?.lng ?? demoLng;
  const carLotName = s?.lot?.name ?? saved?.lotName ?? (hasSavedCar ? "Pinned spot" : "Demo Car Spot (Jarvis A)");

  // Pulse animation
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ])
    ).start();

    Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 4000, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [pulseAnim, spinAnim]);

  // Compass heading subscription
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    Location.watchHeadingAsync((h) => {
      setHeading(h.trueHeading >= 0 ? h.trueHeading : h.magHeading);
    }).then((s) => { sub = s; }).catch(() => {});
    return () => { sub?.remove(); };
  }, []);

  const distM = useMemo(() => {
    if (!pk.position || carLat == null || carLng == null) return null;
    return Math.round(metersBetween(pk.position, { lat: carLat, lng: carLng }));
  }, [pk.position, carLat, carLng]);

  // Bearing to car relative to phone's current heading
  const relativeAngle = useMemo(() => {
    if (!pk.position || carLat == null || carLng == null) return 0;
    const targetBearing = calculateBearing(pk.position.lat, pk.position.lng, carLat, carLng);
    return (targetBearing - heading + 360) % 360;
  }, [pk.position, carLat, carLng, heading]);

  // Haptic feedback as you get closer
  useEffect(() => {
    if (distM == null) return;
    if (distM < 15) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else if (distM < 40) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, [distM]);

  const heatStatus = useMemo(() => {
    if (distM == null) return { title: "Calibrating GPS…", desc: "Locating your car coordinates", color: c.accent };
    if (distM < 8) return { title: "Right here! 🎯", desc: "Your car is within arm's reach", color: c.success };
    if (distM < 25) return { title: "Burning Hot! 🔥", desc: "Look right in front of you in this row", color: c.warn };
    if (distM < 60) return { title: "Getting Warmer ⚡", desc: "Approaching your parked aisle", color: c.accent };
    return { title: "Cold ❄️", desc: "Walk toward the lot entrance", color: c.textMuted };
  }, [distM, c]);

  const openGoogleMaps = () => {
    if (carLat == null || carLng == null) return;
    Linking.openURL(directionsUrl(carLat, carLng, "walking")).catch(() => toast("Couldn't open walking directions.", "error"));
  };

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Screen header={<Header title="Blizzard Radar" subtitle={`Tracking car at ${carLotName}`} onClose={() => router.back()} />}>
      <Card style={{ alignItems: "center", gap: space.md, paddingVertical: space.xl }}>
        <View style={{ alignItems: "center", gap: 4 }}>
          <Badge tone={distM != null && distM < 25 ? "warn" : "accent"}>{heatStatus.title}</Badge>
          <T v="heading" style={{ fontSize: 36, fontVariant: ["tabular-nums"] }}>
            {distM != null ? `${distM} m` : "-- m"}
          </T>
          <T v="caption" color={c.textMuted}>{heatStatus.desc}</T>
        </View>

        {/* Radar View */}
        <View style={[styles.radarContainer, { borderColor: c.border, backgroundColor: c.surfaceAlt }]}>
          {/* Concentric rings */}
          <View style={[styles.ring, { width: RADAR_SIZE * 0.75, height: RADAR_SIZE * 0.75, borderColor: c.border }]} />
          <View style={[styles.ring, { width: RADAR_SIZE * 0.5, height: RADAR_SIZE * 0.5, borderColor: c.border }]} />
          <View style={[styles.ring, { width: RADAR_SIZE * 0.25, height: RADAR_SIZE * 0.25, borderColor: c.border }]} />

          {/* Radar Sweep Line */}
          <Animated.View style={[styles.sweepLine, { transform: [{ rotate: spin }] }]}>
            <View style={[styles.sweepBeam, { backgroundColor: c.accent + "33" }]} />
          </Animated.View>

          {/* Compass Pointer Arrow pointing to car */}
          <View style={[styles.pointerContainer, { transform: [{ rotate: `${relativeAngle}deg` }] }]}>
            <View style={[styles.arrowHead, { borderBottomColor: heatStatus.color }]} />
            <View style={[styles.arrowStem, { backgroundColor: heatStatus.color }]} />
          </View>

          {/* Center User Dot */}
          <View style={[styles.centerDot, { backgroundColor: c.onAccent }]} />
        </View>

        <T v="caption" color={c.textFaint} style={{ textAlign: "center" }}>
          Hold phone flat. The arrow points through the blizzard directly to your vehicle.
        </T>
      </Card>

      <View style={{ gap: space.md }}>
        <Button
          title="Open in Google Maps"
          icon={<Footprints size={18} color={c.onAccent} />}
          onPress={openGoogleMaps}
          style={{ height: 52 }}
        />
        <Button
          title="I found my car"
          variant="secondary"
          icon={<Sparkles size={16} color={c.text} />}
          onPress={() => {
            pk.checkOut("manual");
            toast("Spot cleared! Safe driving!");
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  radarContainer: {
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    borderRadius: RADAR_SIZE / 2,
    borderWidth: 2,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
    overflow: "hidden",
  },
  ring: {
    position: "absolute",
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  sweepLine: {
    position: "absolute",
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    justifyContent: "flex-start",
    alignItems: "center",
  },
  sweepBeam: {
    width: 2,
    height: RADAR_SIZE / 2,
  },
  pointerContainer: {
    position: "absolute",
    width: RADAR_SIZE,
    height: RADAR_SIZE,
    justifyContent: "flex-start",
    alignItems: "center",
  },
  arrowHead: {
    width: 0,
    height: 0,
    backgroundColor: "transparent",
    borderStyle: "solid",
    borderLeftWidth: 14,
    borderRightWidth: 14,
    borderBottomWidth: 24,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    marginTop: 8,
  },
  arrowStem: {
    width: 4,
    height: 28,
  },
  centerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#000",
  },
});
