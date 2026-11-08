import { Navigation, Square, Volume2 } from "lucide-react-native";
import { Linking, View } from "react-native";
import { availabilityTone, lotDirectionsUrl, sentence, voicePaths, type LotEval } from "../api";
import { useStore } from "../store";
import { space } from "../theme";
import { useVoice } from "../voice";
import { Badge, Button, Card, Field, T, row } from "./ui";

/** One parking option. Every option has the same layout and numbers; the recommended one is lightly highlighted. */
export default function Choice({ e, primary, briefing, rank }: { e: LotEval; primary?: boolean; briefing?: string; rank?: number }) {
  const { c, lots, toast } = useStore();
  const voice = useVoice();
  const lot = lots?.lots.find((l) => l.slug === e.slug);
  const voiceId = `choice-${e.slug}`;
  const speaking = voice.playing === voiceId;
  // Recommended: the full briefing. Others: that lot's own spoken summary.
  const audio = primary && briefing ? briefing : lot ? voicePaths.lot(lot.id) : null;
  return (
    <Card style={[{ gap: space.md }, primary ? { borderColor: c.accent, backgroundColor: c.accentSoft } : null]}>
      <View style={row.between}>
        <View style={row.gap}>
          <T v="label">{rank ?? 1}</T>
          {primary && <Badge tone="accent">Recommended</Badge>}
        </View>
        <Badge tone={availabilityTone(e.label)}>{sentence(e.label)}</Badge>
      </View>
      <View style={[row.between, { alignItems: "flex-end" }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="heading">{e.name}</T>
          <T v="caption">~{e.expected_open_spaces} spaces open at arrival</T>
        </View>
      </View>
      <View style={row.between}>
        <Field label="Predicted" value={`${Math.round(e.predicted_occupancy * 100)}% full`} />
        <Field label="Chance of a space" value={`${Math.round(e.availability_probability * 100)}%`} />
        <Field label={e.via_shuttle ? "Shuttle" : "Walk"} value={`${Math.round(e.walk_minutes)} min`} />
        <Field label="Searching" value={`~${Math.round(e.search_minutes)} min`} />
      </View>
      {(e.ice_buffer_minutes > 0 || (e.route && e.route.status !== "unverified")) && (
        <View style={row.wrap}>
          {e.ice_buffer_minutes > 0 && <Badge tone="warn">+{e.ice_buffer_minutes} min ice buffer</Badge>}
          {e.route && e.route.status !== "unverified" && <Badge tone={e.route.status === "blocked" ? "danger" : "warn"}>{e.route.label}</Badge>}
        </View>
      )}
      <View style={row.gap}>
        <Button title="Directions" variant={primary ? "primary" : "secondary"} style={{ flex: 1 }}
          icon={<Navigation size={15} color={primary ? c.onAccent : c.text} />}
          onPress={() => lot && Linking.openURL(lotDirectionsUrl(lot)).catch(() => toast("Couldn't open Google Maps.", "error"))} />
        {audio && (
          <Button title={speaking ? "Stop" : "Listen"} variant="secondary" style={{ flex: 1 }}
            icon={speaking ? <Square size={14} color={c.text} /> : <Volume2 size={16} color={c.text} />}
            onPress={() => (speaking ? voice.stop() : voice.play(audio, voiceId))} />
        )}
      </View>
    </Card>
  );
}
