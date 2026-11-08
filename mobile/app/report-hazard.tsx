import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { router } from "expo-router";
import { Camera, ImageIcon, LocateFixed, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, TextInput, View } from "react-native";
import { api, type PickedImage } from "../src/api";
import CampusMap from "../src/components/CampusMap";
import Header from "../src/components/Header";
import { Button, Card, Chips, ErrorNote, Section, Screen, T, row } from "../src/components/ui";
import { useStore } from "../src/store";
import { radius, space } from "../src/theme";

const TYPES = [
  { value: "ice", label: "Ice" }, { value: "slush", label: "Slush" }, { value: "snow", label: "Snow" },
  { value: "unplowed", label: "Unplowed path" }, { value: "blocked_ramp", label: "Blocked curb ramp" },
];

/** Report a hazard: your location is detected and pinned on the map (tap or drag to adjust), you pick what it is,
 *  optionally add a photo, and it's saved to Reports for everyone. */
export default function ReportHazard() {
  const { c, lots, hazards, meta, user, refresh, toast } = useStore();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [gps, setGps] = useState<"locating" | "found" | "off" | "error">("locating");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const locate = useCallback(async () => {
    setGps("locating");
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) { setGps("off"); return; }
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
      ]);
      setPin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setAccuracy(pos.coords.accuracy ?? null);
      setGps("found");
    } catch { setGps("error"); }
  }, []);
  useEffect(() => { locate(); }, [locate]);

  const pick = async (camera: boolean) => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast("Permission denied. Enable it in Settings.", "error");
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7 };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r.canceled && r.assets[0]) {
      const a = r.assets[0];
      setPhoto({ uri: a.uri, name: a.fileName ?? "hazard.jpg", mimeType: a.mimeType ?? "image/jpeg" });
    }
  };

  const submit = async () => {
    if (!pin) return setErr("Drop a pin on the map first.");
    if (!type && !text.trim()) return setErr("Describe the hazard or tap a suggestion.");
    setBusy(true); setErr(null);
    try {
      const r = await api.reportHazard({ lat: pin.lat, lng: pin.lng, category: type ?? "auto",
        description: text.trim() || undefined, user_id: user?.id, file: photo });
      if (!r.created) { setErr(r.message ?? "Report not saved."); return; }
      toast(`Reported: ${r.hazard?.category_label ?? "hazard"}, ${r.hazard?.location_name ?? ""}${r.points_awarded ? ` (+${r.points_awarded} pts)` : ""}`);
      refresh("hazards", "notifications", "crew");
      router.back();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const gpsText = gps === "locating" ? "Finding your location…"
    : gps === "found" ? `Location detected${accuracy ? ` (±${Math.round(accuracy)} m)` : ""}. Tap the map or drag the pin to adjust.`
      : gps === "off" ? "Location is off. Tap the map to drop a pin where the hazard is."
        : "Couldn't get your location. Tap the map to drop a pin.";

  return (
    <Screen header={<Header title="Report a hazard" subtitle="Pin it, say what it is, add a photo if you like" home />}>
      <Section title="Where is it?">
        <Card style={{ gap: space.sm }}>
          <View style={row.between}>
            <View style={[row.gap, { flex: 1 }]}>
              {gps === "locating" ? <ActivityIndicator size="small" color={c.textMuted} /> : <LocateFixed size={16} color={gps === "found" ? c.success : c.textMuted} />}
              <T v="caption" style={{ flex: 1 }}>{gpsText}</T>
            </View>
            <Button size="sm" variant="secondary" title="Locate me" onPress={locate} disabled={gps === "locating"} />
          </View>
        </Card>
        {lots && <CampusMap lots={lots.lots} hazards={hazards} meta={meta} height={300} counts={false}
          pin={pin} onPin={(lat, lng) => { setPin({ lat, lng }); setAccuracy(null); }} />}
      </Section>

      <Section title="What is it?" footer="Type it in your own words, or tap a suggestion.">
        <TextInput value={text} onChangeText={setText} placeholder="e.g. Black ice by the library stairs"
          placeholderTextColor={c.textFaint} maxLength={200} multiline accessibilityLabel="Describe the hazard"
          style={{ minHeight: 64, color: c.text, fontSize: 15, backgroundColor: c.surfaceSolid, borderRadius: radius.md,
            borderWidth: StyleSheet.hairlineWidth * 2, borderColor: c.border, paddingHorizontal: space.md, paddingVertical: space.sm,
            textAlignVertical: "top" }} />
        <T v="label">Suggestions</T>
        <Chips options={TYPES} value={type} onChange={(v) => setType((cur) => (cur === v ? null : v))} />
      </Section>

      <Section title="Photo (optional)" footer="Faces and plates are blurred before anything is stored.">
        <Card style={{ gap: space.md }}>
          {photo ? (
            <View style={{ gap: space.sm }}>
              <Image source={{ uri: photo.uri }} style={{ width: "100%", aspectRatio: 1.5, borderRadius: radius.md, backgroundColor: c.surfaceAlt }} resizeMode="cover" />
              <Button size="sm" variant="ghost" title="Remove photo" icon={<Trash2 size={14} color={c.text} />} onPress={() => setPhoto(null)} />
            </View>
          ) : (
            <View style={row.gap}>
              <Button title="Camera" variant="secondary" icon={<Camera size={16} color={c.text} />} onPress={() => pick(true)} style={{ flex: 1 }} />
              <Button title="Library" variant="secondary" icon={<ImageIcon size={16} color={c.text} />} onPress={() => pick(false)} style={{ flex: 1 }} />
            </View>
          )}
        </Card>
      </Section>

      {err && <ErrorNote>{err}</ErrorNote>}
      <Button title={busy ? "Saving" : "Submit report"} onPress={submit} loading={busy} disabled={!pin || (!type && !text.trim())} />
    </Screen>
  );
}
