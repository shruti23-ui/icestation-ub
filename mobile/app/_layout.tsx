import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth";
import AuthScreen from "../src/components/AuthScreen";
import Toasts from "../src/components/Toasts";
import { ParkingProvider } from "../src/parking";
import { StoreProvider, useStore } from "../src/store";

SplashScreen.preventAutoHideAsync().catch(() => {});

// On web the app is a phone-shaped column: full width on phones, centred on tablets and desktops.
const WEB_MAX_WIDTH = 520;

/** Signed in -> the app (parking/location start only now). Signed out -> UB-email login. */
function Gate() {
  const { c } = useStore();
  const { status } = useAuth();
  useEffect(() => { if (status !== "loading") SplashScreen.hideAsync().catch(() => {}); }, [status]);
  if (status === "loading") {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}><ActivityIndicator color={c.textMuted} /></View>;
  }
  if (status === "signedOut") return <AuthScreen />;
  return (
    <ParkingProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="demo" options={{ presentation: "modal" }} />
        <Stack.Screen name="notifications" options={{ presentation: "modal" }} />
        <Stack.Screen name="report-hazard" options={{ presentation: "modal" }} />
        <Stack.Screen name="drive" options={{ presentation: "fullScreenModal", animation: "fade" }} />
      </Stack>
    </ParkingProvider>
  );
}

function Shell() {
  const { c } = useStore();
  const frame: ViewStyle = Platform.OS === "web"
    ? { flex: 1, width: "100%", maxWidth: WEB_MAX_WIDTH, alignSelf: "center", overflow: "hidden",
        borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: c.border }
    : { flex: 1 };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={frame}>
        <StatusBar style="light" />
        <AuthProvider>
          <Gate />
        </AuthProvider>
        <Toasts />
      </View>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
