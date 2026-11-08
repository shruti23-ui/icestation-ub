// Native Google sign-in flow. Loaded ONLY by GoogleButton.tsx, lazily, in real installed builds.
// expo-auth-session pulls in expo-application, whose native module crashes inside Expo Go on Android when the
// app reloads ("The ExpoContext of expo.modules.application.ApplicationModule is closed"), so this file must
// never be imported at the top level of anything that Expo Go evaluates.
import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, T } from "./ui";

WebBrowser.maybeCompleteAuthSession();

export default function GoogleNative({ webClientId, androidClientId, iosClientId, onIdToken, onError }: {
  webClientId?: string; androidClientId?: string; iosClientId?: string;
  onIdToken: (t: string) => Promise<void>; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({ webClientId, androidClientId, iosClientId });
  useEffect(() => {
    if (!response) return;
    if (response.type === "success" && response.params.id_token) {
      setBusy(true);
      onIdToken(response.params.id_token).catch((e) => onError((e as Error).message)).finally(() => setBusy(false));
    } else if (response.type === "error") {
      onError(response.error?.message ?? "Google sign-in failed.");
    }
  }, [response]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Button title="Continue with Google" variant="secondary" icon={<GoogleG />} onPress={() => promptAsync()} disabled={!request} loading={busy} />;
}

/** Google "G" mark, drawn with plain views (no image asset). */
function GoogleG() {
  return (
    <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" }}>
      <T v="caption" color="#4285F4" style={{ fontWeight: "800", fontSize: 12, lineHeight: 14 }}>G</T>
    </View>
  );
}
