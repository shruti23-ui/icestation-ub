// Native "Continue with Google" (iOS / Android) entry point. Web uses GoogleButton.web.tsx.
//
// Expo Go: Google rejects Expo Go's exp:// redirect, AND the auth library's native dependency crashes Expo Go
// on Android when the app reloads. So in Expo Go we show a note and never load the library; in a real build
// with EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID / EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID set, GoogleNative is required
// lazily at render time.
import Constants, { ExecutionEnvironment } from "expo-constants";
import type { ComponentType } from "react";
import { Platform } from "react-native";
import { T } from "./ui";

const ANDROID_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
const IOS_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type Props = { webClientId?: string; onIdToken: (token: string) => Promise<void>; onError: (msg: string) => void };
type NativeProps = Props & { androidClientId?: string; iosClientId?: string };

export default function GoogleButton({ webClientId, onIdToken, onError }: Props) {
  const nativeId = Platform.OS === "ios" ? IOS_ID : ANDROID_ID;
  if (inExpoGo || !nativeId) {
    return (
      <T v="caption" style={{ textAlign: "center" }}>
        {inExpoGo ? "Google sign-in works in the installed app, not Expo Go. Use email here." : "Google sign-in isn't set up for this platform yet."}
      </T>
    );
  }
  // Lazy require: keeps expo-auth-session (and expo-application) out of Expo Go entirely.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const GoogleNative = (require("./GoogleNative") as { default: ComponentType<NativeProps> }).default;
  return <GoogleNative webClientId={webClientId} androidClientId={ANDROID_ID} iosClientId={IOS_ID} onIdToken={onIdToken} onError={onError} />;
}
