import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { deleteAsync } from "expo-file-system/legacy";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { Camera, CircleAlert, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { api, type LiveDetect, type PickedImage } from "../api";
import { useStore } from "../store";
import { radius, space } from "../theme";
import { Button, T, row } from "./ui";

const BOX = { vehicle: "#4ADE9B", space: "#60A5FA", person: "#F5B44A", issue: "#FF6B6B", other: "#E5E7EB" } as const;
// Issue boxes from the local OpenCV detector, one colour per problem.
export const ISSUE_COLOR: Record<string, string> = {
  vehicle: "#4ADE9B", ice: "#7DD3FC", water: "#60A5FA", cone: "#FB923C", object: "#FF6B6B",
};

/** Live camera with labelled boxes around what's in frame (cars, empty spaces, people, other objects).
 *  A frame is sent every time the previous answer comes back; frames are analysed in memory, never stored.
 *  Pops up a message when the camera isn't pointed at cars or parking spaces. "Capture" saves that one photo and hands it
 *  to the normal scan. */
export default function LiveScan({ onCapture, onClose }: { onCapture: (img: PickedImage) => void; onClose: () => void }) {
  const { c } = useStore();
  const [perm, requestPerm, getPerm] = useCameraPermissions();
  // Coming back from Settings: re-read the permission so the camera starts without reopening the screen.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") getPerm().catch(() => {}); });
    return () => sub.remove();
  }, [getPerm]);
  const cam = useRef<CameraView | null>(null);
  const [ready, setReady] = useState(false);
  const [det, setDet] = useState<LiveDetect | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const misses = useRef(0);
  const alive = useRef(true);
  const capturing = useRef(false);

  const asked = useRef(false);
  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain && !asked.current) { asked.current = true; requestPerm().catch(() => {}); }
  }, [perm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame loop: capture a small frame, detect, draw, repeat.
  useEffect(() => {
    alive.current = true;
    if (!ready) return;
    (async () => {
      while (alive.current) {
        if (capturing.current) { await new Promise((r) => setTimeout(r, 300)); continue; }
        try {
          const shot = await cam.current?.takePictureAsync({ quality: 0.4, shutterSound: false });
          if (!shot || !alive.current) break;
          const small = Platform.OS === "web" ? shot
            : await manipulateAsync(shot.uri, [{ resize: { width: 640 } }], { compress: 0.6, format: SaveFormat.JPEG });
          let d: LiveDetect;
          try { d = await api.liveDetect({ uri: small.uri, name: "frame.jpg", mimeType: "image/jpeg" }); }
          finally {
            // Frames are throwaway: remove both temp files from the phone's cache right after analysis.
            if (Platform.OS !== "web") {
              deleteAsync(shot.uri, { idempotent: true }).catch(() => {});
              if (small.uri !== shot.uri) deleteAsync(small.uri, { idempotent: true }).catch(() => {});
            }
          }
          if (!alive.current) break;
          setDet(d); setErr(null);
          // Two misses in a row before the pop-up, so one blurry frame doesn't nag.
          misses.current = d.is_parking_scene ? 0 : misses.current + 1;
          if (d.is_parking_scene) { setPopup(null); setDismissed(false); }
          else if (misses.current >= 2) setPopup(d.message ?? "This doesn't look like a car or a parking space.");
        } catch (e) {
          setErr((e as Error).message);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    })();
    return () => { alive.current = false; };
  }, [ready]);

  // Capture: the only time a frame is kept. Saves a privacy-blurred, annotated copy on the server
  // (data/captures/, hackathon mode), then hands the photo to Analyze. Preview frames are never stored.
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const capture = async () => {
    capturing.current = true;
    setSaving(true);
    try {
      const shot = await cam.current?.takePictureAsync({ quality: 0.7, shutterSound: true });
      if (!shot) return;
      const img = { uri: shot.uri, name: "capture.jpg", mimeType: "image/jpeg" };
      try {
        const r = await api.liveDetect(img, true);
        toast(r.saved ? "Captured and saved" : "Captured", "ok");
      } catch (e) {
        toast(`Captured, but not saved: ${(e as Error).message}`, "error");
      }
      alive.current = false;
      onCapture(img);
    } finally { capturing.current = false; setSaving(false); }
  };

  // Browsers only allow the camera on https or localhost; on http://<LAN IP> getUserMedia doesn't exist.
  const webBlocked = Platform.OS === "web" && typeof window !== "undefined" && !(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  // Granted through the image picker's request (same OS camera permission) even if the camera hook lags behind.
  const [pickerGranted, setPickerGranted] = useState(false);
  const [asking, setAsking] = useState(false);
  const openSettings = () => { if (Platform.OS !== "web") Linking.openSettings().catch(() => {}); };
  const allow = async () => {
    setAsking(true);
    try {
      let r = await requestPerm().catch(() => null);
      if (!r?.granted) {
        // Fallback: the same Android/iOS CAMERA permission via the image picker (the Camera button uses this).
        const ip = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
        if (ip?.granted) { setPickerGranted(true); r = await getPerm().catch(() => r); }
        else if (ip && !ip.canAskAgain) openSettings();   // "Don't allow" earlier: only Settings can turn it on
      }
    } finally { setAsking(false); }
  };

  const granted = !!perm?.granted || pickerGranted;
  if (webBlocked || !granted) {
    const msg = webBlocked
      ? "Your browser blocks the camera on this address (it needs https or localhost). Use the Expo Go app on your phone, or Camera / Library below."
      : perm && !perm.canAskAgain ? "Camera access is turned off for this app. Tap Open Settings, allow Camera, then come back."
        : perm?.canAskAgain ? "Camera access is needed for live scanning."
          : "Camera access is needed for live scanning.";
    return (
      <View style={{ aspectRatio: 3 / 4, borderRadius: radius.md, backgroundColor: c.surfaceAlt, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.lg }}>
        <Camera size={28} color={c.textFaint} />
        <T v="caption" style={{ textAlign: "center" }}>{msg}</T>
        {!webBlocked && (
          <>
            <Button title="Allow camera" onPress={allow} loading={asking} />
            <Button title="Open Settings" variant="secondary" onPress={openSettings} />
          </>
        )}
        <Button title="Close" variant="ghost" onPress={onClose} />
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ aspectRatio: 3 / 4, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#000" }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing="back" onCameraReady={() => setReady(true)} animateShutter={false} />
        {/* Boxes: normalised [x1, y1, x2, y2] from the server, drawn over the preview. */}
        <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
          {det?.objects.map((o, i) => {
            const col = (o.issue && ISSUE_COLOR[o.issue]) || BOX[o.kind] || BOX.other;
            return (
              <View key={i} style={{ position: "absolute", left: `${o.box[0] * 100}%`, top: `${o.box[1] * 100}%`,
                width: `${(o.box[2] - o.box[0]) * 100}%`, height: `${(o.box[3] - o.box[1]) * 100}%`, borderWidth: 2, borderColor: col, borderRadius: 4 }}>
                <Text numberOfLines={1} style={{ position: "absolute", top: -1, left: -1, backgroundColor: col, color: "#0B0F1A",
                  fontSize: 10, fontWeight: "700", paddingHorizontal: 4, paddingVertical: 1, borderBottomRightRadius: 4, maxWidth: 140 }}>
                  {o.label}{o.score != null ? ` ${Math.round(o.score * 100)}%` : ""}
                </Text>
              </View>
            );
          })}
        </View>
        {/* Status chip */}
        <View style={{ position: "absolute", top: 8, left: 8, right: 52, flexDirection: "row" }}>
          <View style={{ backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>
              {!det ? "Looking…" : `${det.objects.length} object${det.objects.length === 1 ? "" : "s"} · ${det.cars} car${det.cars === 1 ? "" : "s"}`}
            </Text>
          </View>
        </View>

        <Pressable onPress={() => { alive.current = false; onClose(); }} accessibilityLabel="Close live camera" hitSlop={8}
          style={{ position: "absolute", top: 8, right: 8, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}>
          <X size={18} color="#fff" />
        </Pressable>
        {/* Pop-up when the camera isn't on cars or parking spaces */}
        {popup && !dismissed && (
          <View style={{ position: "absolute", left: space.lg, right: space.lg, top: "35%", backgroundColor: "rgba(15,18,30,0.95)", borderRadius: radius.lg,
            padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: c.warn }}>
            <View style={row.gap}><CircleAlert size={18} color={c.warn} /><T v="subheading" color={c.warn}>Not a parking scene</T></View>
            <T v="caption" color="#E5E7EB">{popup}</T>
            {det?.scene ? <T v="caption">Seeing: {det.scene}</T> : null}
            <Button size="sm" variant="secondary" title="OK" onPress={() => setDismissed(true)} />
          </View>
        )}
      </View>
      <View style={row.gap}>
        <Button title={saving ? "Capturing…" : "Capture"} icon={<Camera size={16} color={c.onAccent} />} onPress={capture} loading={saving} style={{ flex: 1 }} />
      </View>
      <T v="caption">
        {err ? `Live detection paused: ${err}` : det ? `${det.provider} · ~${(det.latency_ms / 1000).toFixed(1)} s per frame. Only photos you capture are saved.`
          : "Point at a parking lot. Boxes appear as objects are detected. Only photos you capture are saved."}
      </T>
    </View>
  );
}
