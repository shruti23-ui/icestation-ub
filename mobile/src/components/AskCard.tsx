import { Mic, Send, Square, Volume2, X } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useCopilot } from "../copilot";
import { useStore } from "../store";
import { radius, space } from "../theme";
import { Ufo } from "./SpaceArt";
import { Card, T, row } from "./ui";

const SUGGESTIONS = ["Where should I park?", "Is Jarvis A full?", "When should I leave?", "Is it icy?", "Any walkway hazards?"];

/** Conversational assistant: tap once and talk. It listens, answers out loud, and listens again
 *  (follow-ups like "is it full?" work) until you say thanks, go quiet, or tap End. */
export default function AskCard({ destination }: { destination: string }) {
  const { c } = useStore();
  const cp = useCopilot({ destination });
  const { phase, active } = cp;

  const label = phase === "listening" ? "Listening… tap when you're done"
    : phase === "thinking" ? "Thinking…"
      : phase === "speaking" ? (active ? "Speaking… tap to interrupt" : "Speaking…")
        : "Talk to WeParkit";
  const hint = phase === "listening" ? "I'll answer when you pause."
    : active ? "Hands-free: I keep listening after each answer. Say “thanks” to finish."
      : "Tap once and ask anything about UB parking. It's a conversation, so ask follow-ups.";
  const color = phase === "listening" ? c.danger : phase === "speaking" ? c.success : c.accent;

  const onMain = () => {
    if (phase === "listening") return cp.sendNow();        // done talking
    if (phase === "speaking") return cp.interrupt();       // skip the rest; a conversation listens again
    if (!active) return cp.start();
  };

  return (
    <Card style={{ gap: space.md }}>
      <View style={[row.gap, { gap: space.md }]}>
        <Pressable onPress={onMain} disabled={phase === "thinking"} accessibilityRole="button"
          accessibilityLabel={phase === "listening" ? "Done talking" : active ? "Stop" : "Start voice conversation"}
          style={({ pressed }) => ({ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center",
            backgroundColor: color, opacity: pressed ? 0.85 : 1, shadowColor: color, shadowOpacity: 0.55, shadowRadius: 14, elevation: 6 })}>
          {phase === "listening" ? <Send size={24} color="#fff" />
            : phase === "speaking" ? <Volume2 size={26} color="#fff" />
              : phase === "thinking" ? <Ufo size={34} beam />
                : <Mic size={28} color="#FFFFFF" />}
        </Pressable>
        <View style={{ flex: 1, gap: 4 }}>
          <T v="subheading">{label}</T>
          {phase === "listening" ? (
            <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surfaceAlt, overflow: "hidden" }}>
              <View style={{ width: `${Math.round(8 + cp.level * 92)}%`, height: "100%", backgroundColor: c.danger, borderRadius: 3 }} />
            </View>
          ) : <T v="caption">{hint}</T>}
        </View>
        {active && (
          <Pressable onPress={cp.end} hitSlop={10} accessibilityLabel="End conversation"
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceAlt }}>
            <X size={18} color={c.text} />
          </Pressable>
        )}
      </View>

      {cp.messages.length > 0 && (
        <View style={{ gap: space.sm }}>
          {cp.messages.slice(-6).map((m) => (
            <View key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%",
              backgroundColor: m.role === "user" ? c.surfaceAlt : c.accentSoft, borderRadius: radius.lg,
              borderTopRightRadius: m.role === "user" ? 4 : radius.lg, borderTopLeftRadius: m.role === "user" ? radius.lg : 4,
              paddingHorizontal: space.md, paddingVertical: space.sm }}>
              <T v="body" style={{ fontSize: 14, lineHeight: 20 }}>{m.text}</T>
              {m.meta && <T v="caption" style={{ fontSize: 10, marginTop: 2 }}>{m.meta}</T>}
            </View>
          ))}
          <View style={[row.between]}>
            {phase === "speaking" ? (
              <Pressable onPress={cp.end} hitSlop={8} style={row.gap}><Square size={12} color={c.accent} /><T v="caption" color={c.accent}>Stop</T></Pressable>
            ) : <View />}
            {!active && <Pressable onPress={cp.reset} hitSlop={8}><T v="caption" color={c.accent}>New conversation</T></Pressable>}
          </View>
        </View>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {SUGGESTIONS.map((q) => (
          <Pressable key={q} onPress={() => cp.askText(q)} disabled={phase === "thinking"}
            style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: c.border, backgroundColor: pressed ? c.accentSoft : c.surfaceAlt, opacity: phase === "thinking" ? 0.5 : 1 })}>
            <T v="caption" color={c.text}>{q}</T>
          </Pressable>
        ))}
      </ScrollView>
    </Card>
  );
}
