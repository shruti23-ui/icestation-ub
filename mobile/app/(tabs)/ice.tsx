import { router } from "expo-router";
import { Check, Plus, Snowflake, X } from "lucide-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { api, ago, media } from "../../src/api";
import CampusMap from "../../src/components/CampusMap";
import Header from "../../src/components/Header";
import { Banner, Button, Card, DemoTag, Empty, Section, Screen, T, row } from "../../src/components/ui";
import { useStore } from "../../src/store";
import { radius, space } from "../../src/theme";


export default function Reports() {
  const { c, lots, hazards, meta, user, state, refresh, toast } = useStore();
  const [busy, setBusy] = useState<number | null>(null);


  const vote = async (id: number, kind: "confirm" | "clear") => {
    if (!user) return;
    setBusy(id);
    try {
      const r = kind === "confirm" ? await api.vote(id, user.id, "confirm") : await api.clearHazard(id, user.id);
      toast(r.cleared ? "Marked clear for everyone" : kind === "confirm" ? `Confirmed. Expiry timer restarted (+${r.points_awarded} pts)` : `Clear vote recorded (+${r.points_awarded} pts)`);
      refresh("hazards", "crew", "notifications");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(null); }
  };

  return (
    <Screen header={<Header title="Reports" subtitle="Hazards reported by students around North Campus" />} onRefresh={() => refresh("hazards")}>
      {state?.mode === "ice" && (
        <Banner tone="warn" icon={<Snowflake size={18} color={c.warn} />} title="Ice season is on">
          Walk times are slower and unreported paths may be icy.
        </Banner>
      )}
      <Button title="Report a hazard" icon={<Plus size={16} color={c.onAccent} />} onPress={() => router.push("/report-hazard")} />

      {/* Hazard pins only: no lot space counts on this map */}
      {lots && <CampusMap lots={lots.lots} hazards={hazards} meta={meta} height={260} counts={false} />}

      <Section title={`Active reports (${hazards.length})`}>
        {hazards.length === 0 ? (
          <Empty title="No active reports">Seen ice, slush or a blocked ramp? Report it so others can route around it.</Empty>
        ) : hazards.map((h) => (
          <Card key={h.id} style={{ gap: space.md }}>
            <View style={row.between}>
              <View style={[row.gap, { flex: 1 }]}>
                <T v="subheading" color={h.category === "blocked_ramp" ? c.danger : c.warn}>{h.category_label}</T>
                {h.is_demo && <DemoTag />}
              </View>
              <T v="caption">{Math.round(h.confidence * 100)}% · {h.minutes_left} min left</T>
            </View>
            <View style={{ gap: 2 }}>
              <T v="body">{h.location_name}</T>
              {h.classified_by === "reporter" && h.explanation && h.explanation !== "Reported by a student." && (
                <T v="caption" color={c.text}>“{h.explanation}”</T>
              )}
              <T v="caption">Reported {ago(h.created_at)} · {h.confirmations} confirmed · {h.clear_votes} cleared</T>
              {h.hard_stop_for_wheelchairs && <T v="caption" color={c.danger}>Not passable by wheelchair.</T>}
            </View>
            {h.image_url && <Image source={{ uri: media(h.image_url) }} style={{ width: "100%", height: 140, borderRadius: radius.md }} />}
            <View style={row.gap}>
              <Button size="sm" title="Still there" variant="secondary" icon={<Check size={14} color={c.text} />} onPress={() => vote(h.id, "confirm")} loading={busy === h.id} style={{ flex: 1 }} />
              <Button size="sm" title="It's clear" variant="secondary" icon={<X size={14} color={c.text} />} onPress={() => vote(h.id, "clear")} disabled={busy === h.id} style={{ flex: 1 }} />
            </View>
          </Card>
        ))}
      </Section>

    </Screen>
  );
}
