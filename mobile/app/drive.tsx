import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, Mic, Navigation, Square, Volume2, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, askCopilot, availabilityTone, directionsUrl, hhmm12, sentence, voicePaths, type Recommendation } from "../src/api";
import Starfield from "../src/components/Starfield";
import { Badge, T, row } from "../src/components/ui";
import { useStore } from "../src/store";
import { radius, space } from "../src/theme";
import { useVoice } from "../src/voice";

type Phase = "idle" | "listening" | "thinking";

/** Simple, driver-safe HUD focusing on car parking.
 *  Large high-contrast display, clear lot recommendation, one-tap navigation, and voice co-pilot. */
export default function DriveMode() {
  useKeepAwake();
  const p = useLocalSearchParams<{ destination?: string; arrival?: string; accessible?: string }>();
  const destination = p.destination || "Davis Hall";
  const accessible = p.accessible === "true";
  const { c, lots, state, toast } = useStore();
  const voice = useVoice();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);

  const load = useCallback(() => {
    api.recommend({ destination, arrival: p.arrival ?? "", accessible })
      .then(setRec)
      .catch((e) => toast((e as Error).message, "error"));
  }, [destination, p.arrival, accessible, toast]);

  useEffect(() => { load(); }, [load]);

  const options = useMemo(() => (rec?.all ?? []).filter((e) => !e.accessible_blocked), [rec]);
  const cur = options[idx];
  const lot = lots?.lots.find((l) => l.slug === cur?.slug);

  // Speak initial briefing once loaded
  const spokeFirst = useRef(false);
  useEffect(() => {
    if (rec && options.length && !spokeFirst.current) {
      spokeFirst.current = true;
      voice.play(voicePaths.briefing(destination, p.arrival, accessible), "drive");
    }
  }, [rec, options.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => voice.stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Voice recording toggle
  const listenRef = useRef(false);
  const toggleVoice = async () => {
    if (phase === "listening") {
      listenRef.current = false;
      setPhase("thinking");
      try { await recorder.stop(); } catch { /* ignore */ }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = recorder.uri;
      if (!uri) { setPhase("idle"); return; }
      try {
        const res = await askCopilot({ audioUri: uri, destination, arrival: p.arrival, accessible });
        setTranscript(res.transcript || "(didn't catch that)");
        if (res.lot) {
          const i = options.findIndex((o) => o.slug === res.lot!.slug);
          if (i >= 0) setIdx(i);
        }
        voice.play(res.speech_path, "drive");
        if (res.action === "directions" && res.lot) {
          const { lat, lng } = res.lot;
          setTimeout(() => Linking.openURL(directionsUrl(lat, lng)).catch(() => {}), 1500);
        }
      } catch (e) {
        toast((e as Error).message, "error");
      } finally {
        setPhase("idle");
      }
      return;
    }

    voice.stop();
    const perm = await requestRecordingPermissionsAsync().catch(() => null);
    if (!perm?.granted) return toast("Mic permission required for voice.", "error");

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      listenRef.current = true;
      setPhase("listening");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch (e) {
      toast((e as Error).message, "error");
      setPhase("idle");
    }
  };

  const nextLot = () => {
    if (options.length > 1) {
      const next = (idx + 1) % options.length;
      setIdx(next);
      Haptics.selectionAsync().catch(() => {});
      const l = lots?.lots.find((x) => x.slug === options[next].slug);
      if (l) voice.play(voicePaths.lot(l.id), "drive");
    }
  };

  const prevLot = () => {
    if (options.length > 1) {
      const prev = (idx - 1 + options.length) % options.length;
      setIdx(prev);
      Haptics.selectionAsync().catch(() => {});
      const l = lots?.lots.find((x) => x.slug === options[prev].slug);
      if (l) voice.play(voicePaths.lot(l.id), "drive");
    }
  };

  const openNavigation = () => {
    if (!lot) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    Linking.openURL(directionsUrl(lot.lat, lot.lng)).catch(() => toast("Couldn't open Google Maps", "error"));
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#02040A" }}>
      <Starfield />

      {/* Top Header */}
      <View style={[row.between, { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }]}>
        <View style={{ gap: 2 }}>
          <T v="label" color={c.accent}>DRIVE HUD · {destination.toUpperCase()}</T>
          <T v="caption" color={c.textMuted}>
            {state?.mode === "ice" ? "❄️ Ice Season Active · Snow reduction applied" : "Standard Campus Conditions"}
          </T>
        </View>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center" }}
        >
          <X size={22} color={c.text} />
        </Pressable>
      </View>

      {/* Main Lot Card */}
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: space.lg, gap: space.xl }}>
        {cur ? (
          <View
            style={{
              backgroundColor: "rgba(10, 16, 32, 0.85)",
              borderRadius: radius.lg,
              borderWidth: 2,
              borderColor: idx === 0 ? c.accent : c.border,
              padding: space.xl,
              gap: space.lg,
            }}
          >
            <View style={row.between}>
              <Badge tone={idx === 0 ? "accent" : "neutral"}>
                {idx === 0 ? "PRIMARY RECOMMENDATION" : `BACKUP OPTION #${idx}`}
              </Badge>
              <Badge tone={availabilityTone(cur.label)}>
                {sentence(cur.label)}
              </Badge>
            </View>

            <View style={{ gap: 6 }}>
              <T v="title" style={{ fontSize: 32, fontWeight: "700" }}>{cur.name}</T>
              <T v="heading" color={c.accent} style={{ fontSize: 24, fontVariant: ["tabular-nums"] }}>
                ~{cur.expected_open_spaces} spaces open
              </T>
            </View>

            <View style={[row.between, { paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: c.divider }]}>
              <View style={{ gap: 2 }}>
                <T v="caption" color={c.textMuted}>Walk to {destination}</T>
                <T v="subheading">{Math.round(cur.walk_minutes)} min {cur.via_shuttle ? "(shuttle)" : ""}</T>
              </View>
              <View style={{ gap: 2, alignItems: "flex-end" }}>
                <T v="caption" color={c.textMuted}>Leave By</T>
                <T v="subheading" color={c.accent}>{hhmm12(cur.recommended_departure)}</T>
              </View>
            </View>

            {/* Switch Lots Controls */}
            {options.length > 1 && (
              <View style={[row.between, { paddingTop: space.xs }]}>
                <Pressable onPress={prevLot} style={[row.gap, { padding: space.xs }]}>
                  <ChevronLeft size={18} color={c.textMuted} />
                  <T v="caption" color={c.textMuted}>Previous lot</T>
                </Pressable>
                <T v="caption" color={c.textMuted}>{idx + 1} of {options.length}</T>
                <Pressable onPress={nextLot} style={[row.gap, { padding: space.xs }]}>
                  <T v="caption" color={c.textMuted}>Next lot</T>
                  <ChevronRight size={18} color={c.textMuted} />
                </Pressable>
              </View>
            )}
          </View>
        ) : null}

        {transcript && (
          <View style={{ backgroundColor: "rgba(255,255,255,0.06)", borderRadius: radius.md, padding: space.md }}>
            <T v="caption" color={c.textMuted}>Heard: "{transcript}"</T>
          </View>
        )}
      </View>

      {/* Giant Driver Buttons */}
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.xl, gap: space.md }}>
        <Pressable
          onPress={openNavigation}
          style={({ pressed }) => ({
            backgroundColor: c.accent,
            borderRadius: radius.lg,
            height: 64,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: space.md,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Navigation size={26} color={c.onAccent} />
          <T v="heading" color={c.onAccent} style={{ fontSize: 20, fontWeight: "700" }}>
            Start Navigation
          </T>
        </Pressable>

        <View style={row.gap}>
          <Pressable
            onPress={toggleVoice}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: phase === "listening" ? c.danger : "rgba(255,255,255,0.1)",
              borderRadius: radius.lg,
              height: 54,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space.sm,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Mic size={22} color={phase === "listening" ? "#fff" : c.text} />
            <T v="subheading" color={phase === "listening" ? "#fff" : c.text}>
              {phase === "listening" ? "Listening… tap to send" : phase === "thinking" ? "Thinking…" : "Ask Voice"}
            </T>
          </Pressable>

          <Pressable
            onPress={() => voice.playing ? voice.stop() : voice.play(voicePaths.briefing(destination, p.arrival, accessible), "drive")}
            style={({ pressed }) => ({
              width: 54,
              height: 54,
              borderRadius: radius.lg,
              backgroundColor: "rgba(255,255,255,0.1)",
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            {voice.playing ? <Square size={20} color={c.accent} /> : <Volume2 size={22} color={c.text} />}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
