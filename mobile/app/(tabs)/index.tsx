import { router, useFocusEffect } from "expo-router";
import { Car, ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, hhmm12, voicePaths, type Recommendation } from "../../src/api";
import CampusMap from "../../src/components/CampusMap";
import Header from "../../src/components/Header";
import LotRow from "../../src/components/LotCard";
import AskCard from "../../src/components/AskCard";
import Choice from "../../src/components/Choice";
import ParkingStatus from "../../src/components/ParkingStatus";
import { Banner, Card, Empty, List, Loading, Metrics, Section, Screen, Segmented, Select, T, row } from "../../src/components/ui";
import { useStore } from "../../src/store";
import { space } from "../../src/theme";
import { useParking } from "../../src/parking";
import { useCampusClock } from "../../src/campusTime";
import { metersBetween } from "../../src/parkDetect";

const DEFAULT_DEST = "Davis Hall";

export default function Overview() {
  const { c, lots, state, hazards, meta, user, refresh } = useStore();
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailed, setDetailed] = useState(false);
  // Lot list: 3 at first, "Load more" reveals 3 more at a time.
  const PAGE = 3;
  const [visible, setVisible] = useState(PAGE);
  const clock = useCampusClock();   // live New York time
  const pk = useParking();
  // Nearest first when we know where you are; otherwise most open spaces first.
  const sortedLots = useMemo(() => {
    const all = (lots?.lots ?? []).map((lot) => ({ lot, d: pk.position ? Math.round(metersBetween(pk.position, lot)) : null }));
    return all.sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : b.lot.available - a.lot.available));
  }, [lots, pk.position]);

  const [dest, setDest] = useState(DEFAULT_DEST);
  const [moreOpen, setMoreOpen] = useState(false);
  const [assistMode, setAssistMode] = useState<"talk" | "drive">("talk");
  const loadRec = useCallback(async () => {
    try { setRec(await api.recommend({ destination: dest, arrival: "", accessible: user?.needs_accessible_routes ?? false, user_id: user?.id })); }
    catch { setRec(null); }
  }, [dest, user?.id, user?.needs_accessible_routes]);
  // Recompute when lots or mode change, or the tab regains focus.
  useFocusEffect(useCallback(() => { loadRec(); }, [loadRec, lots, state?.mode]));

  const onRefresh = async () => { setRefreshing(true); await refresh(); await loadRec(); setRefreshing(false); };

  const t = lots?.totals;
  const best = rec?.best;
  const others = best ? (rec?.all ?? []).filter((e) => e.slug !== best.slug && e.expected_open_spaces > 0).slice(0, 2) : [];

  return (
    <Screen header={<Header brand title="WeParkit" subtitle={`UB North Campus · ${meta?.simulated_clock ? `${hhmm12(meta.campus_time)} (simulated clock)` : `${clock.label} ${clock.zone}`}`} />}
      onRefresh={onRefresh} refreshing={refreshing}>

      <ParkingStatus />

      <Section>
        <Select label="Destination" title="Destination" value={dest}
          options={(meta?.buildings ?? [{ name: DEFAULT_DEST }]).map((b) => ({ value: b.name, label: b.name }))} onChange={setDest} />
        {rec ? (rec.best ? <Choice e={rec.best} primary briefing={voicePaths.briefing(dest)} /> : <Banner tone="warn">{rec.explanation}</Banner>)
          : <Loading label="Calculating recommendation" />}
        {/* Options 2 and 3 (next best-scoring lots with space) stay folded until "Load more". */}
        {rec?.best && moreOpen && others.map((e, i) => <Choice key={e.slug} e={e} rank={i + 2} />)}
        {rec?.best && others.length > 0 && (
          <Pressable accessibilityRole="button" onPress={() => setMoreOpen((v) => !v)}
            style={({ pressed }) => ({ alignItems: "center", paddingVertical: space.sm, opacity: pressed ? 0.7 : 1 })}>
            <T v="label" color={c.accent}>{moreOpen ? "Show fewer" : `Load more (${others.length} more option${others.length === 1 ? "" : "s"})`}</T>
          </Pressable>
        )}
      </Section>

      {/* One assistant card, two modes: Talk (ask by voice or text) and Drive (hands-free gestures). */}
      <Section>
        <Segmented options={[{ value: "talk", label: "Talk" }, { value: "drive", label: "Drive" }]} value={assistMode} onChange={setAssistMode} />
        {assistMode === "talk" ? <AskCard destination={dest} /> : <DriveCard destination={dest} />}
      </Section>

      <Section title="UB parking map" footer={<MapLegend />}>
        {lots ? <CampusMap lots={lots.lots} hazards={hazards} meta={meta} highlightSlug={best?.slug} height={340} />
          : <Empty title="Map appears once lot data loads" />}
      </Section>

      <Section title={pk.position ? "Nearest UB lots" : `UB lots (${lots?.lots.length ?? 0})`}
        action={{ label: detailed ? "Less detail" : "More detail", onPress: () => setDetailed((d) => !d) }}
>
        {lots ? (
          <Card padded={false}>
            <List>{sortedLots.slice(0, visible).map(({ lot: l, d }) => (
              <LotRow key={l.id} lot={l} detailed={detailed} highlight={l.slug === best?.slug} distanceM={d} />
            ))}</List>
            {sortedLots.length > PAGE && (
              <Pressable accessibilityRole="button"
                onPress={() => setVisible((v) => (v >= sortedLots.length ? PAGE : Math.min(v + PAGE, sortedLots.length)))}
                style={({ pressed }) => ({ padding: space.lg, alignItems: "center", gap: 2, borderTopWidth: StyleSheet.hairlineWidth * 2,
                  borderTopColor: c.divider, opacity: pressed ? 0.7 : 1 })}>
                <T v="label" color={c.accent}>{visible >= sortedLots.length ? "Show fewer" : "Load more"}</T>
                <T v="caption">{`Showing ${Math.min(visible, sortedLots.length)} of ${sortedLots.length} lots`}</T>
              </Pressable>
            )}
          </Card>
        ) : <Loading label="Loading lots" />}
      </Section>

      {t && (
        <Section title="Campus at a glance"
          footer={`About ${t.available.toLocaleString()} of ${t.total_capacity.toLocaleString()} spaces are open across ${lots?.lots.length ?? 0} UB lots, `
            + `${Math.round(t.occupancy_pct)}% full overall, with ${hazards.length} active hazard report${hazards.length === 1 ? "" : "s"}.`}>
          <Metrics center items={[
            { label: "Spaces open", value: `~${t.available}` },
            { label: "Occupancy", value: `${Math.round(t.occupancy_pct)}%` },
            { label: "Hazards", value: hazards.length, color: hazards.length ? c.warn : undefined },
          ]} />
        </Section>
      )}



    </Screen>
  );
}

/** Map key, shown right under the map: what the coloured "open/total" labels mean. */
function MapLegend() {
  const { c } = useStore();
  const items = [
    { color: c.success, label: "Plenty open" },
    { color: c.warn, label: "Filling up" },
    { color: c.danger, label: "Full (20/20 = all taken)" },
  ];
  return (
    <View style={{ gap: 6 }}>
      <View style={[row.wrap, { gap: space.md }]}>
        {items.map((i) => (
          <View key={i.label} style={row.gap}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: i.color, borderWidth: 2, borderColor: "#FFFFFF" }} />
            <T v="caption" color={c.text}>{i.label}</T>
          </View>
        ))}
        <View style={row.gap}>
          <View style={{ backgroundColor: c.success, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 1, borderWidth: 1.5, borderColor: "#FFFFFF" }}>
            <Text style={{ color: "#04210F", fontSize: 10, fontWeight: "700" }}>12/30</Text>
          </View>
          <T v="caption" color={c.text}>spaces open / total</T>
        </View>
      </View>
      <T v="caption">Space counts are estimates. Tap a lot for directions; zoom in for lot names. Map © OpenStreetMap contributors.</T>
    </View>
  );
}

/** Entry to Drive mode: hands-free briefing, gestures and voice, for when you're behind the wheel. */
function DriveCard({ destination }: { destination: string }) {
  const { c } = useStore();
  return (
    <Card onPress={() => router.push({ pathname: "/drive", params: { destination } })}>
      <View style={[row.gap, { gap: space.md }]}>
        <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: c.accentSoft,
          borderWidth: 2, borderColor: c.accent }}>
          <Car size={28} color={c.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="subheading">Drive mode</T>
          <T v="caption">Hands-free while driving: big screen, spoken briefing, tap and swipe gestures, voice questions.</T>
        </View>
        <ChevronRight size={20} color={c.textMuted} />
      </View>
    </Card>
  );
}
