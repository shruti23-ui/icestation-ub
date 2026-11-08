import { router } from "expo-router";
import { Bell, BellDot, X } from "lucide-react-native";
import { useContext, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ParkingContext } from "../parking";
import { useStore } from "../store";
import { space } from "../theme";
import Logo from "./Logo";
import { T } from "./ui";

const SIZE = 40;

/** Screen title with notifications and profile actions. Modals pass `onClose` instead. */
export default function Header({ title, subtitle, onClose, brand }: { title: string; subtitle?: string; onClose?: () => void; brand?: boolean }) {
  const { c, unread, toast } = useStore();
  const taps = useRef(0);
  const ping = () => {
    taps.current += 1;
    if (taps.current % 5 === 0) toast("👽 Greetings, earthling. Take me to your parking lot.", "info");
  };
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md, flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {brand && <Pressable onPress={ping} hitSlop={8} accessibilityLabel="WeParkit logo"><Logo /></Pressable>}
          {title === "WeParkit" ? (
            <Text style={{ fontSize: 24, fontWeight: "800", color: "#FFFFFF", letterSpacing: -0.5 }}>
              WePark<Text style={{ color: c.accent }}>It</Text>
            </Text>
          ) : (
            <T v="title" numberOfLines={1}>{title}</T>
          )}
        </View>
        {subtitle ? <T v="caption" numberOfLines={1} style={{ marginTop: 2 }}>{subtitle}</T> : null}
      </View>
      {onClose ? (
        <RoundButton onPress={onClose} label="Close"><X size={20} color={c.text} /></RoundButton>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <RoundButton onPress={() => router.push("/notifications")} label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            {unread > 0 ? <BellDot size={19} color={c.accent} /> : <Bell size={19} color={c.text} />}
            {unread > 0 && (
              <View style={{ position: "absolute", top: -3, right: -3, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
                backgroundColor: c.danger, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: c.bg }}>
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{unread > 9 ? "9+" : unread}</Text>
              </View>
            )}
          </RoundButton>
          <Avatar />
        </View>
      )}
    </View>
  );
}

function RoundButton({ children, onPress, label }: { children: ReactNode; onPress: () => void; label: string }) {
  const { c } = useStore();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => ({ width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? c.surfaceAlt : c.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: c.border,
        transform: [{ scale: pressed ? 0.94 : 1 }] })}>
      {children}
    </Pressable>
  );
}

/** Profile button: your initials, with a green dot while you're parked. */
function Avatar() {
  const { c, user } = useStore();
  const parking = useContext(ParkingContext);   // optional: Header can render outside the provider
  const parked = !!parking?.session;
  const initials = (user?.handle ?? "")
    .replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <Pressable onPress={() => router.push("/crew")} accessibilityRole="button"
      accessibilityLabel={`Profile${user?.handle ? `, ${user.handle}` : ""}${parked ? ", parked" : ""}`} hitSlop={6}
      style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.94 : 1 }] })}>
      <View style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: "center", justifyContent: "center",
        backgroundColor: c.accent, borderWidth: 1.5, borderColor: c.accent }}>
        <Text style={{ color: "#FFFFFF", fontSize: initials.length > 1 ? 14 : 16, fontWeight: "800", letterSpacing: 0.5 }}>{initials}</Text>
      </View>
      {parked && (
        <View style={{ position: "absolute", right: -1, bottom: -1, width: 13, height: 13, borderRadius: 7,
          backgroundColor: c.success, borderWidth: 2, borderColor: c.bg }} />
      )}
    </Pressable>
  );
}
