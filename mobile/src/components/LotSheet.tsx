import { Navigation, Square, Volume2, X } from "lucide-react-native";
import { Linking, StyleSheet, View } from "react-native";
import { lotDirectionsUrl, lotFull, sourceLabel, voicePaths, type Lot } from "../api";
import { useStore } from "../store";
import { radius, space } from "../theme";
import { useVoice } from "../voice";
import { Badge, Button, IconButton, T, row } from "./ui";

/** Floating detail card for a tapped lot: availability, Google Maps directions, optional spoken summary. */
export default function LotSheet({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const { c, toast } = useStore();
  const voice = useVoice();
  const speaking = voice.playing === `lot-${lot.id}`;
  const full = lotFull(lot);

  const directions = () => Linking.openURL(lotDirectionsUrl(lot)).catch(() => toast("Couldn't open Google Maps.", "error"));

  return (
    <View style={{ position: "absolute", left: space.sm, right: space.sm, bottom: space.sm, backgroundColor: c.surfaceSolid, borderRadius: radius.lg,
      borderColor: c.border, borderWidth: StyleSheet.hairlineWidth * 2, padding: space.md, gap: space.md,
      shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
      <View style={[row.between, { alignItems: "flex-start" }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="subheading">{lot.name}</T>
          <View style={row.gap}>
            <T v="caption" color={full ? c.warn : c.text}>{full ? `Full · ${lot.snow_adjusted_capacity}/${lot.snow_adjusted_capacity} taken` : `~${lot.available} of ${lot.snow_adjusted_capacity} open`}</T>
            <T v="caption">· {Math.round(lot.occupancy_pct)}% full</T>
            {lot.data_source === "demo" ? <Badge tone="warn">Demo data</Badge> : <Badge>{sourceLabel(lot.data_source)}</Badge>}
          </View>
        </View>
        <IconButton onPress={onClose} label="Close"><X size={18} color={c.textMuted} /></IconButton>
      </View>
      <View style={row.gap}>
        <Button size="sm" title="Directions" icon={<Navigation size={14} color={c.onAccent} />} onPress={directions} style={{ flex: 1 }} />
        {(
          <Button size="sm" variant="secondary" title={speaking ? "Stop" : "Listen"}
            icon={speaking ? <Square size={13} color={c.text} /> : <Volume2 size={15} color={c.text} />}
            onPress={() => (speaking ? voice.stop() : voice.play(voicePaths.lot(lot.id), `lot-${lot.id}`))} style={{ flex: 1 }} />
        )}
      </View>
    </View>
  );
}
