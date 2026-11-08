import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams } from "expo-router";
import { Camera, CircleCheck, ScanEye, ImageIcon, Minus, Plus, ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { api, media, type Hazard, type PickedImage, type Sample, type ScanResult } from "../../src/api";
import GpsRow from "../../src/components/GpsRow";
import Header from "../../src/components/Header";
import LiveScan, { ISSUE_COLOR } from "../../src/components/LiveScan";
import {
  Badge, Banner, Button, Card, Chips, DemoTag, ErrorNote, Field, IconButton, List, ListRow, ProgressBar, Section, Screen, Segmented, StatusDot, T, row,
} from "../../src/components/ui";
import { useLotLocator } from "../../src/location";
import { useParking } from "../../src/parking";
import { useStore } from "../../src/store";
import { radius, space } from "../../src/theme";

const HAZARD_CATS = [
  { value: "auto", label: "Detect from photo" }, { value: "ice", label: "Ice" }, { value: "slush", label: "Slush" },
  { value: "snow", label: "Snow" }, { value: "unplowed", label: "Unplowed" }, { value: "blocked_ramp", label: "Blocked ramp" },
];

type Source = { kind: "photo"; image: PickedImage } | { kind: "sample"; sample: Sample } | null;

export default function Scan() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const { c, lots, meta, user, state, refresh, toast } = useStore();
  const [mode, setMode] = useState<"lot" | "hazard">("lot");
  const [lotId, setLotId] = useState<number | null>(null);
  const [source, setSource] = useState<Source>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ occupied: 0, open: 0, blocked: 0 });
  const [sent, setSent] = useState(false);
  // hazard path
  const [location, setLocation] = useState<string | null>(null);
  const [category, setCategory] = useState("auto");
  const [hazard, setHazard] = useState<Hazard | null>(null);

  useEffect(() => { if (params.mode === "ice") setMode("hazard"); }, [params.mode]);
  useEffect(() => { if (!lotId && lots?.lots.length) setLotId(lots.lots[0].id); }, [lots, lotId]);

  // GPS identifies the lot / nearest walkway. A manual pick always wins.
  const gps = useLotLocator();
  // Checked in ("Yes, I'm parked")? That lot is queued up automatically. Order: your pick > where you parked > GPS.
  const pk = useParking();
  const parkedLot = pk.session?.active ? pk.session.lot : null;
  useEffect(() => {
    if (parkedLot && !handPicked.lot) setLotId(parkedLot.id);
  }, [parkedLot?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [handPicked, setHandPicked] = useState({ lot: false, location: false });
  useEffect(() => {
    const r = gps.result;
    if (!r) return;
    if (r.lot && !handPicked.lot && !parkedLot) setLotId(r.lot.id);
    if (r.hazard_location && !handPicked.location) setLocation(r.hazard_location.name);
  }, [gps.result]); // eslint-disable-line react-hooks/exhaustive-deps
  const relocate = () => { setHandPicked({ lot: false, location: false }); gps.locate(); };

  const resetFlow = () => { setResult(null); setHazard(null); setSent(false); setEditing(false); setErr(null); };
  const startOver = () => { setSource(null); resetFlow(); };
  const switchMode = (m: "lot" | "hazard") => { setMode(m); startOver(); };

  const pick = async (camera: boolean) => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast("Permission denied. Enable it in Settings or use a sample photo.", "error");
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7 };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r.canceled && r.assets[0]) {
      const a = r.assets[0];
      resetFlow();
      setSource({ kind: "photo", image: { uri: a.uri, name: a.fileName ?? "scan.jpg", mimeType: a.mimeType ?? "image/jpeg" } });
    }
  };

  const analyze = async () => {
    if (!source) return toast("Take or choose a photo first.", "info");
    setBusy(true); setErr(null);
    try {
      if (mode === "lot") {
        if (!lotId) throw new Error("Choose which lot this photo shows.");
        const r = await api.scan(lotId, source.kind === "photo" ? { file: source.image } : { sample_id: source.sample.id });
        setResult(r);
        setEdit({ occupied: r.occupied_spaces, open: r.estimated_open_spaces, blocked: r.snow_blocked_spaces });
      } else {
        if (!location) throw new Error("Choose where the hazard is.");
        const r = await api.reportHazard({ location_name: location, category, user_id: user?.id,
          ...(source.kind === "photo" ? { file: source.image } : { sample_id: source.sample.id }) });
        if (!r.created) { toast(r.message ?? "No hazard found in that photo.", "info"); return; }
        setHazard(r.hazard!);
        toast(`Hazard reported (+${r.points_awarded ?? 0} pts)`);
        refresh("hazards", "notifications", "crew");
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const submit = async (corrected: boolean) => {
    if (!result || !lotId) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { lot_id: lotId, scan_id: result.scan_id, user_id: user?.id, is_demo: result.sample_is_synthetic };
      if (corrected) Object.assign(body, { occupied_spaces: edit.occupied, open_spaces: edit.open, snow_blocked_spaces: edit.blocked });
      const r = await api.report(body);
      setSent(true); setEditing(false);
      toast(`${r.lot.name} updated: ~${r.lot.available} open (+${r.points_awarded} pts)`);
      refresh("lots", "notifications", "crew");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(false); }
  };

  const preview = source?.kind === "photo" ? source.image.uri : source ? media(source.sample.image_url) : null;
  const lotName = lots?.lots.find((l) => l.id === lotId)?.name;
  const done = !!(result || hazard);

  return (
    <Screen header={<Header title="Capture" subtitle="Photograph a lot to update its spaces, or a walkway to report a hazard" />}>
      <Segmented options={[{ value: "lot", label: "Parking lot" }, { value: "hazard", label: "Walkway hazard" }]} value={mode} onChange={switchMode} />

      {!done && (
        <>
          {mode === "lot" ? (
            <Section title="Lot" footer="Matched from your location when available. Tap to correct it.">
              <Card style={{ gap: space.md }}>
                <GpsRow status={gps.status} result={gps.result} error={gps.error} onLocate={relocate}
                  override={parkedLot && parkedLot.id === lotId ? `You're parked at ${parkedLot.name}` : undefined}
                  showConfidence={!(parkedLot && parkedLot.id === lotId)}
                  matchedName={gps.result?.lot && gps.result.lot.id === lotId ? gps.result.lot.name : null} />
                <Chips limit={6} options={(lots?.lots ?? []).map((l) => ({ value: String(l.id), label: l.name }))} value={lotId ? String(lotId) : null}
                  onChange={(v) => { setLotId(Number(v)); setHandPicked((p) => ({ ...p, lot: true })); resetFlow(); }} />
              </Card>
            </Section>
          ) : (
            <>
              {state?.mode !== "ice" && <T v="caption">Hazard reports matter most in ice season, but you can report any time.</T>}
              <Section title="Location">
                <Card style={{ gap: space.md }}>
                  <GpsRow status={gps.status} result={gps.result} error={gps.error} onLocate={relocate} showConfidence={false}
                    label={gps.result?.hazard_location
                      ? `${Math.round(gps.result.hazard_location.distance_m)} m from ${gps.result.hazard_location.name}`
                      : gps.result?.on_campus ? "No named spot within 150 m. Pick the closest." : "You're not on North Campus."} />
                  <Chips limit={4} options={(meta?.hazard_locations ?? []).map((h) => ({ value: h.name, label: h.name }))} value={location}
                    onChange={(v) => { setLocation(v); setHandPicked((p) => ({ ...p, location: true })); }} />
                </Card>
              </Section>
              <Section title="Type">
                <Chips options={HAZARD_CATS} value={category} onChange={setCategory} />
              </Section>
            </>
          )}

          <Section title="Photo" footer={mode === "lot" ? "Fit as many stalls in frame as you can. Faces and plates are blurred before anything is stored." : "Show the walking surface clearly."}>
            <Card style={{ gap: space.md }}>
              {live ? (
                <LiveScan onClose={() => setLive(false)}
                  onCapture={(img) => { setLive(false); resetFlow(); setSource({ kind: "photo", image: img }); }} />
              ) : preview ? (
                <View style={{ gap: space.sm }}>
                  <Image source={{ uri: preview }} style={{ width: "100%", aspectRatio: 1.5, borderRadius: radius.md, backgroundColor: c.surfaceAlt }} resizeMode="contain" />
                  {source?.kind === "sample" && <DemoTag label="Synthetic sample photo" />}
                </View>
              ) : (
                <View style={{ borderRadius: radius.md, aspectRatio: 1.5, backgroundColor: c.surfaceAlt, alignItems: "center", justifyContent: "center", gap: space.sm }}>
                  <Camera size={28} color={c.textFaint} />
                  <T v="caption">No photo selected</T>
                </View>
              )}
              {!live && mode === "lot" && (
                <Button title="Live camera with object boxes" icon={<ScanEye size={16} color={c.onAccent} />} onPress={() => setLive(true)} />
              )}
              {!live && <View style={row.gap}>
                <Button title="Camera" variant="secondary" icon={<Camera size={16} color={c.text} />} onPress={() => pick(true)} style={{ flex: 1 }} />
                <Button title="Library" variant="secondary" icon={<ImageIcon size={16} color={c.text} />} onPress={() => pick(false)} style={{ flex: 1 }} />
              </View>}
            </Card>
          </Section>

          {err && <ErrorNote>{err}</ErrorNote>}
          <Button title={busy ? "Analyzing" : "Analyze photo"} onPress={analyze} loading={busy} disabled={!source} />
        </>
      )}

      {result && (
        <>
          <Card style={{ gap: space.md }}>
            <View style={row.between}>
              <T v="label">{lotName}</T>
              <Badge>{result.space_method_label}</Badge>
            </View>
            <View style={[row.gap, { alignItems: "baseline" }]}>
              <T v="title" color={result.frame_occupancy_fraction >= 0.85 ? c.warn : c.text}>~{result.estimated_open_spaces}</T>
              <T v="body" color={c.textMuted}>open spaces in frame</T>
            </View>
            <ProgressBar pct={result.frame_occupancy_fraction * 100} height={6} />
            <View style={row.between}>
              <Field label="Vehicles" value={String(result.vehicles_detected)} />
              <Field label="Snow-blocked" value={String(result.snow_blocked_spaces)} color={result.snow_blocked_spaces ? c.warn : undefined} />
              <Field label="Unplowed rows" value={String(result.unplowed_rows ?? 0)} />
              <Field label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
            </View>
          </Card>

          {result.verdict && (
            <Section title="Why spaces are unusable" footer={result.issues_method}>
              <Card padded={false}>
                <List>
                  <ListRow left={<StatusDot color={result.verdict.blocked ? c.danger : result.verdict.usable ? c.success : c.warn} />}
                    title={<T v="subheading">{result.verdict.headline}</T>} />
                  {(result.issues ?? []).map((i, n) => (
                    <ListRow key={n} left={<View style={{ width: 12, height: 12, borderRadius: 3, borderWidth: 2, borderColor: ISSUE_COLOR[i.kind] ?? c.danger }} />}
                      title={i.label} subtitle={i.detail || undefined} right={<T v="caption">{Math.round(i.score * 100)}%</T>} />
                  ))}
                </List>
              </Card>
            </Section>
          )}

          <Section title="Summary" footer={result.explanation_source}>
            <Card><T v="body">{result.explanation}</T></Card>
          </Section>

          <Section title="Annotated photo">
            <Card style={{ gap: space.sm }}>
              <Image source={{ uri: media(result.annotated_image_url) }} style={{ width: "100%", aspectRatio: 1.5, borderRadius: radius.md, backgroundColor: c.surfaceAlt }} resizeMode="contain" />
              <View style={row.gap}>
                <ShieldCheck size={14} color={c.success} />
                <T v="caption" style={{ flex: 1 }}>{result.privacy.regions_blurred} regions blurred before storage · {result.detector}</T>
              </View>
              {result.detector_note ? <T v="caption">{result.detector_note}</T> : null}
            </Card>
          </Section>

          {editing && (
            <Section title="Correct the counts">
              <Card padded={false}>
                <List>
                  <Stepper label="Occupied" value={edit.occupied} onChange={(v) => setEdit({ ...edit, occupied: v })} />
                  <Stepper label="Open" value={edit.open} onChange={(v) => setEdit({ ...edit, open: v })} />
                  <Stepper label="Snow-blocked" value={edit.blocked} onChange={(v) => setEdit({ ...edit, blocked: v })} />
                </List>
              </Card>
              <View style={row.gap}>
                <Button title="Cancel" variant="secondary" onPress={() => setEditing(false)} style={{ flex: 1 }} />
                <Button title="Submit corrected" onPress={() => submit(true)} loading={busy} style={{ flex: 1 }} />
              </View>
            </Section>
          )}

          {sent ? (
            <Banner tone="success" icon={<CircleCheck size={18} color={c.success} />} title="Report submitted"
              right={<Button size="sm" variant="secondary" title="New scan" onPress={startOver} />}>
              Everyone sees the update now. It expires in 30 minutes.
            </Banner>
          ) : !editing && (
            <View style={{ gap: space.sm }}>
              <Button title="Submit report" onPress={() => submit(false)} loading={busy} />
              <Button title="Counts look wrong? Correct them" variant="ghost" onPress={() => setEditing(true)} />
            </View>
          )}
        </>
      )}

      {hazard && (
        <>
          <Card style={{ gap: space.md }}>
            <View style={row.between}>
              <T v="label">{hazard.location_name}</T>
              {hazard.is_demo && <DemoTag />}
            </View>
            <T v="heading" color={hazard.category === "blocked_ramp" ? c.danger : c.warn}>{hazard.category_label}</T>
            <View style={row.between}>
              <Field label="Confidence" value={`${Math.round(hazard.confidence * 100)}%`} />
              <Field label="Expires in" value={`${Math.round(hazard.minutes_left / 60)} h`} />
              <Field label="Classified by" value={hazard.classified_by === "reporter" ? "You" : "Photo analysis"} />
            </View>
            <T v="body">{hazard.explanation}</T>
            {hazard.hard_stop_for_wheelchairs && (
              <Banner tone="danger">Wheelchair routes now treat this location as impassable.</Banner>
            )}
          </Card>
          {hazard.image_url && <Image source={{ uri: media(hazard.image_url) }} style={{ width: "100%", aspectRatio: 1.5, borderRadius: radius.lg }} resizeMode="cover" />}
          <Button title="Report another" variant="secondary" onPress={startOver} />
        </>
      )}
    </Screen>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const { c } = useStore();
  return (
    <ListRow title={label} right={
      <View style={row.gap}>
        <IconButton onPress={() => onChange(Math.max(0, value - 1))} label={`Decrease ${label}`}><Minus size={18} color={c.text} /></IconButton>
        <T v="subheading" style={{ minWidth: 32, textAlign: "center", fontVariant: ["tabular-nums"] }}>{value}</T>
        <IconButton onPress={() => onChange(value + 1)} label={`Increase ${label}`}><Plus size={18} color={c.text} /></IconButton>
      </View>
    } />
  );
}
