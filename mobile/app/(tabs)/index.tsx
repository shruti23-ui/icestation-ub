import { router, useFocusEffect } from "expo-router";
import { Car, Filter, Navigation, Square, TriangleAlert, Volume2 } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { api, availabilityTone, directionsUrl, hhmm12, sentence, voicePaths, type Recommendation } from "../../src/api";
import Header from "../../src/components/Header";
import LotRow from "../../src/components/LotCard";
import AskCard from "../../src/components/AskCard";
import ParkingStatus from "../../src/components/ParkingStatus";
import SpotSniperCard from "../../src/components/SpotSniperCard";
import { Badge, Banner, Button, Card, Chips, DemoTag, Empty, List, Loading, Metrics, Section, Screen, T, row } from "../../src/components/ui";
import { useStore } from "../../src/store";
import { space } from "../../src/theme";
import { useVoice } from "../../src/voice";
import { useParking } from "../../src/parking";
import { metersBetween } from "../../src/parkDetect";

const DEFAULT_DEST = "Davis Hall";

const PERMIT_OPTIONS = [
  { value: "all", label: "All Permits" },
  { value: "commuter", label: "Commuter" },
  { value: "park_and_ride", label: "Park & Ride" },
  { value: "residence", label: "Residence" },
  { value: "visitor", label: "Visitor" },
];

export default function Overview() {
  const { c, lots, state, hazards, weather, meta, refresh, toast } = useStore();
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [permitFilter, setPermitFilter] = useState("all");
  const pk = useParking();

  // Nearest first when we know where you are; otherwise most open spaces first.
  const sortedLots = useMemo(() => {
    const all = (lots?.lots ?? []).map((lot) => ({ lot, d: pk.position ? Math.round(metersBetween(pk.position, lot)) : null }));
    return all.sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : b.lot.available - a.lot.available));
  }, [lots, pk.position]);

  const filteredLots = useMemo(() => {
    if (permitFilter === "all") return sortedLots;
    return sortedLots.filter(({ lot }) => lot.kind === permitFilter);
  }, [sortedLots, permitFilter]);

  const voice = useVoice();

  const loadRec = useCallback(async () => {
    try { setRec(await api.recommend({ destination: DEFAULT_DEST, arrival: "", accessible: false })); }
    catch { setRec(null); }
  }, []);
  // Recompute when lots or mode change, or the tab regains focus.
  useFocusEffect(useCallback(() => { loadRec(); }, [loadRec, lots, state?.mode]));

  const onRefresh = async () => { setRefreshing(true); await refresh(); await loadRec(); setRefreshing(false); };
  const reset = async () => {
    try { await api.reset(); await refresh("lots", "state", "hazards", "notifications", "weather", "crew"); toast("Demo data reset"); }
    catch (e) { toast((e as Error).message, "error"); }
  };

  const obs = weather?.observation;
  const tempF = obs?.temperature_c != null ? `${Math.round((obs.temperature_c * 9) / 5 + 32)}°` : null;
  const weatherSummary = [tempF, obs?.condition].filter(Boolean).join(" ");
  const conditionTag = state?.mode === "ice" ? "❄️ Snow-adjusted" : null;
  const headerSubtitle = `UB North Campus${weatherSummary ? ` · ${weatherSummary}` : ""}${conditionTag ? ` · ${conditionTag}` : ""}`;

  const t = lots?.totals;
  const best = rec?.best;

  return (
    <Screen header={<Header brand title="WeParkit" subtitle={headerSubtitle} />}
      onRefresh={onRefresh} refreshing={refreshing}>

      <ParkingStatus />

      <SpotSniperCard />

      <AskCard destination={DEFAULT_DEST} />

      <Section title={`Recommended for ${DEFAULT_DEST}`}>
        <Card onPress={() => router.push("/dock")} style={{ gap: space.md }}>
          {best ? (
            <>
              <View style={row.between}>
                <T v="caption">Arriving {hhmm12(rec?.arrival_time)}</T>
                <Badge tone={availabilityTone(best.label)}>{sentence(best.label)}</Badge>
              </View>
              <View style={[row.between, { alignItems: "flex-end" }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="heading">{best.name}</T>
                  <T v="caption">~{best.expected_open_spaces} spaces open{state?.mode === "ice" ? " · snow-adjusted" : ""}</T>
                </View>
                <View style={{ alignItems: "flex-end", gap: 2 }}>
                  <T v="caption">Leave by</T>
                  <T v="heading" color={c.accent} style={{ fontVariant: ["tabular-nums"] }}>{hhmm12(best.recommended_departure)}</T>
                </View>
              </View>
              <View style={row.between}>
                <View style={row.gap}>
                  <Button size="sm" title="Directions" icon={<Navigation size={14} color={c.onAccent} />}
                    onPress={() => { const l = lots?.lots.find((x) => x.slug === best.slug); if (l) Linking.openURL(directionsUrl(l.lat, l.lng)).catch(() => {}); }} />
                  {(
                    <Button size="sm" variant="secondary" title={voice.playing === "briefing" ? "Stop" : "Listen"}
                      icon={voice.playing === "briefing" ? <Square size={13} color={c.text} /> : <Volume2 size={15} color={c.text} />}
                      onPress={() => (voice.playing === "briefing" ? voice.stop() : voice.play(voicePaths.briefing(DEFAULT_DEST), "briefing"))} />
                  )}
                </View>
                <Button size="sm" variant="secondary" title="Drive HUD" icon={<Car size={15} color={c.text} />}
                  onPress={() => router.push({ pathname: "/drive", params: { destination: DEFAULT_DEST } })} />
              </View>
            </>
          ) : <Loading label="Calculating recommendation" />}
        </Card>
      </Section>

      <Section title="Permit filter">
        <Chips options={PERMIT_OPTIONS} value={permitFilter} onChange={setPermitFilter} />
      </Section>

      <Section title={`UB parking lots (${filteredLots.length})`}
        action={{ label: detailed ? "Less detail" : "More detail", onPress: () => setDetailed((d) => !d) }}
        footer={`${lots?.disclaimer ?? ""} Lot outlines © OpenStreetMap contributors.`}>
        {lots ? (
          <Card padded={false}>
            <List>{filteredLots.slice(0, showAll ? undefined : 8).map(({ lot: l, d }) => (
              <LotRow key={l.id} lot={l} detailed={detailed} highlight={l.slug === best?.slug} distanceM={d} />
            ))}</List>
            {filteredLots.length > 8 && (
              <Pressable onPress={() => setShowAll((v) => !v)} style={{ padding: space.lg, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.divider }}>
                <T v="label" color={c.accent}>{showAll ? "Show fewer" : `Show all ${filteredLots.length} lots`}</T>
              </Pressable>
            )}
          </Card>
        ) : <Loading label="Loading lots" />}
      </Section>

      <Section title="Demo controls" footer="Replay lake-effect snowstorm or reset occupancy.">
        <Card style={{ gap: space.md }}>
          <View style={{ gap: 2 }}>
            <T v="subheading">Guided walkthrough</T>
            <T v="caption">Scan a lot, replay a lake-effect storm, and see the recommendation update. About a minute.</T>
          </View>
          <View style={row.gap}>
            <Button title="Start demo" onPress={() => router.push("/demo")} style={{ flex: 1 }} />
            <Button title="Reset data" variant="secondary" onPress={reset} style={{ flex: 1 }} />
          </View>
        </Card>
      </Section>
    </Screen>
  );
}
