import { Tabs } from "expo-router";
import { Camera, CloudSun, House, MessageSquareWarning } from "lucide-react-native";
import type { ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "../../src/store";

type Icon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

// Order matches the file routes below. `crew` is reachable from the header profile button, not the bar.
const TABS: Record<string, { label: string; icon: Icon }> = {
  index: { label: "Overview", icon: House },
  scan: { label: "Capture", icon: Camera },
  ice: { label: "Reports", icon: MessageSquareWarning },
  orbit: { label: "Weather", icon: CloudSun },
};

export default function TabLayout() {
  const { c } = useStore();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg } }}
      tabBar={({ state, navigateToTab }) => (
        <View style={{ flexDirection: "row", backgroundColor: "rgba(5,8,23,0.96)", borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth * 2,
          paddingTop: 8, paddingBottom: Math.max(insets.bottom, 8) }}>
          {state.routes.map((route, i) => {
            const cfg = TABS[route.name];
            if (!cfg) return null;
            const focused = state.index === i;
            const Icon = cfg.icon;
            const color = focused ? c.accent : c.textMuted;
            return (
              <Pressable key={route.key} onPress={() => { if (!focused) navigateToTab(route.key); }}
                accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={cfg.label}
                style={{ flex: 1, alignItems: "center", gap: 4, paddingVertical: 2 }}>
                <Icon size={22} color={color} strokeWidth={focused ? 2.2 : 1.8} />
                <Text style={{ color, fontSize: 11, fontWeight: focused ? "600" : "500" }}>{cfg.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="scan" />
      <Tabs.Screen name="ice" />
      <Tabs.Screen name="orbit" />
      <Tabs.Screen name="crew" />
    </Tabs>
  );
}
