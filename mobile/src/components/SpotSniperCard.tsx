import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Car, Crosshair, Navigation, Sparkles, Target, Zap } from "lucide-react-native";
import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Linking, StyleSheet, View } from "react-native";
import { ago, directionsUrl } from "../api";
import { useStore } from "../store";
import { radius, space } from "../theme";
import { Badge, Button, Card, T, row } from "./ui";

export default function SpotSniperCard() {
  const { c, lots, notifications, toast } = useStore();

  // Pulse animation for the target icon
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.15, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);

  // Find most recent "leaving" notification within the last 8 minutes
  const activeSnipe = useMemo(() => {
    const now = Date.now();
    const recent = notifications.find((n) => {
      if (n.kind !== "leaving" || !n.lot_id) return false;
      const ageMs = now - new Date(n.created_at).getTime();
      return ageMs < 8 * 60 * 1000; // 8 minutes
    });
    if (!recent) return null;
    const lot = lots?.lots.find((l) => l.id === recent.lot_id);
    return { notif: recent, lot };
  }, [notifications, lots]);

  const snipeSpot = () => {
    if (!activeSnipe?.lot) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast(`🎯 Target locked! Navigating to ${activeSnipe.lot.name}`);
    Linking.openURL(directionsUrl(activeSnipe.lot.lat, activeSnipe.lot.lng)).catch(() => {});
  };

  if (!activeSnipe?.lot) {
    return (
      <Card style={{ borderColor: c.border, backgroundColor: c.surfaceSolid, gap: space.xs }}>
        <View style={[row.between, { alignItems: "center" }]}>
          <View style={[row.gap, { alignItems: "center" }]}>
            <Crosshair size={16} color={c.accent} />
            <T v="label" color={c.accent}>🎯 Spot Sniper: Active</T>
          </View>
          <T v="caption" color={c.textFaint}>Listening for departing cars</T>
        </View>
        <T v="caption" color={c.textMuted}>
          Circling a lot? The instant a student taps "I'm leaving", their spot will pop up here for you to claim.
        </T>
      </Card>
    );
  }

  return (
    <Card style={{ borderColor: c.success, backgroundColor: c.surfaceAlt, gap: space.md, borderWidth: 1.5 }}>
      <View style={[row.between, { alignItems: "center" }]}>
        <View style={[row.gap, { alignItems: "center" }]}>
          <Animated.View style={{ transform: [{ scale: pulse }] }}>
            <Target size={20} color={c.success} />
          </Animated.View>
          <T v="subheading" color={c.success}>🎯 LIVE SPOT OPENING</T>
        </View>
        <Badge tone="success">Opening Now</Badge>
      </View>

      <View style={{ gap: 2 }}>
        <T v="heading" style={{ fontSize: 22 }}>
          {activeSnipe.lot.name}
        </T>
        <T v="caption" color={c.text}>
          {activeSnipe.notif.body} · {ago(activeSnipe.notif.created_at)}
        </T>
      </View>

      <View style={row.gap}>
        <Button
          title="Snipe this spot"
          icon={<Navigation size={16} color={c.onAccent} />}
          onPress={snipeSpot}
          style={{ flex: 1, height: 48 }}
        />
        <Button
          title="Drive HUD"
          variant="secondary"
          icon={<Car size={16} color={c.text} />}
          onPress={() => router.push({ pathname: "/drive", params: { destination: activeSnipe.lot!.name } })}
        />
      </View>
    </Card>
  );
}

