import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeftRight, ArrowUp, Hand, Mic, Smartphone, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Linking, PanResponder, Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, askCopilot, availabilityTone, hhmm12, lotDirectionsUrl, lotFull, sentence, voicePaths, type CopilotAnswer, type Recommendation } from "../src/api";
import { Ufo } from "../src/components/SpaceArt";
import Starfield from "../src/components/Starfield";
import { Badge, T, row } from "../src/components/ui";
import { useStore } from "../src/store";
import { radius, space } from "../src/theme";
import { useVoice } from "../src/voice";

const SWIPE = 60;         // px before a drag counts as a swipe
const TAP_SLOP = 14;      // px of wobble still treated as a tap
const TAP_MS = 650;       // a touch longer than this is not a tap (no long-press action)
// Voice-activity detection on the recorder's metering (dBFS): measure the car's noise floor first, then wait for
// speech and stop after a real pause, so the driver can take their time.
const POLL_MS = 100;
const CALIBRATE_MS = 400;
const SPEECH_OVER_FLOOR_DB = 9;
const SILENCE_OVER_FLOOR_DB = 5;
const END_OF_SPEECH_MS = 1300;
const NO_SPEECH_MS = 5000;   // driver said nothing for 5 s: answer with the latest briefing anyway
const MAX_LISTEN_MS = 20000;
const FALLBACK_MS = 6000;   // no metering available: fixed window, tap to send early
const BARS = 28;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const buzz = (kind: "tap" | "ok" = "tap") =>
  (kind === "ok" ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).catch(() => {});

type Phase = "idle" | "listening" | "thinking";

/** Eyes-free driving screen. The whole surface is one gesture pad and everything is spoken back.
 *  tap = briefing · swipe ←/→ = other lots · swipe ↑ = directions · swipe ↓ = ask a question
 *  Also speaks first when ice season starts or the lot fills up. */
export default function DriveMode() {
  useKeepAwake();
  const p = useLocalSearchParams<{ destination?: string; arrival?: string; accessible?: string }>();
  const destination = p.destination || "Davis Hall";
  const accessible = p.accessible === "true";
  const { c, lots, state, toast } = useStore();
  const voice = useVoice();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [idx, setIdx] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const load = useCallback(() => {
    setLoadErr(false);
    api.recommend({ destination, arrival: p.arrival ?? "", accessible }).then(setRec).catch(() => setLoadErr(true));
  }, [destination, p.arrival, accessible]);
  useEffect(() => { load(); }, [load]);

  const options = useMemo(() => (rec?.all ?? []).filter((e) => !e.accessible_blocked), [rec]);
  const cur = options[idx];
  const lot = lots?.lots.find((l) => l.slug === cur?.slug);

  const flash = (text: string) => { setHint(text); setTimeout(() => setHint((h) => (h === text ? null : h)), 1400); };

  const speak = async (i: number, intro = false) => {
    const e = options[i];
    if (!e || !rec) return;
    // Opening: "Hey, I'm Parky." + the briefing + the gesture options. Later taps repeat just the briefing.
    if (i === 0) return voice.play(voicePaths.briefing(destination, p.arrival, accessible, intro, true), "drive");
    const l = lots?.lots.find((x) => x.slug === e.slug);
    if (l) voice.play(voicePaths.lot(l.id, true), "drive");
  };

  // Speak the briefing as soon as the recommendation arrives.
  const spokeFirst = useRef(false);
  useEffect(() => { if (rec && options.length && !spokeFirst.current) { spokeFirst.current = true; speak(0, true); } }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => voice.stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- voice (ElevenLabs STT)
  // Swipe down (or the mic button): listen until the driver finishes, then answer.
  const listen = useRef<{ active: boolean; sendNow: boolean; mode: "ask" | "wake" | null; done: Promise<void> | null }>(
    { active: false, sendNow: false, mode: null, done: null });
  useEffect(() => () => { listen.current.active = false; }, []);

  /** Record one utterance with VAD. Returns the file URI, or null if nothing was said or it was cancelled. */
  const capture = async (mode: "ask" | "wake"): Promise<string | null> => {
    let finished: () => void = () => {};
    listen.current = { active: true, sendNow: false, mode, done: new Promise<void>((r) => { finished = r; }) };
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      const t0 = Date.now();
      const floor: number[] = [];
      let spoke = false, quietSince = 0, metered = false;
      const noSpeechMs = mode === "wake" ? 25000 : NO_SPEECH_MS;   // wake: keep clips short, then start a fresh one
      while (listen.current.active && !listen.current.sendNow) {
        await sleep(POLL_MS);
        const elapsed = Date.now() - t0;
        const db = recorder.getStatus().metering;
        if (typeof db === "number" && Number.isFinite(db)) {
          metered = true;
          if (mode === "ask") setLevels((prev) => [...prev.slice(1), Math.max(0.04, Math.min(1, (db + 60) / 50))]);
          if (elapsed < CALIBRATE_MS) { floor.push(db); continue; }
          const base = floor.length ? floor.reduce((a, b) => a + b, 0) / floor.length : -55;
          if (db > base + SPEECH_OVER_FLOOR_DB) { spoke = true; quietSince = 0; }
          else if (spoke && db < base + SILENCE_OVER_FLOOR_DB) {
            quietSince ||= Date.now();
            if (Date.now() - quietSince >= END_OF_SPEECH_MS) break;
          }
          if (!spoke && elapsed > noSpeechMs) break;
        } else {
          if (mode === "ask") setLevels((prev) => [...prev.slice(1), 0.15 + 0.1 * Math.random()]);
          if (!metered && elapsed > FALLBACK_MS) {
            if (mode === "wake") { listen.current.active = false; break; }   // no metering: no hands-free wake word
            spoke = true; break;
          }
        }
        // Questions can run up to MAX_LISTEN_MS; ("wake" capture mode is unused since Hey Parky was removed).
        if (mode === "wake" ? spoke && elapsed > 8000 : elapsed > MAX_LISTEN_MS) { spoke = true; break; }
      }
      const cancelled = !listen.current.active;
      try { await recorder.stop(); } catch { /* already stopped */ }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      if (cancelled) return null;
      return spoke || listen.current.sendNow ? recorder.uri : null;
    } catch {
      try { await recorder.stop(); } catch { /* ignore */ }
      return null;
    } finally {
      listen.current.active = false;
      listen.current.mode = null;
      if (mode === "ask") setLevels(Array(BARS).fill(0));
      finished();
    }
  };

  /** Release the microphone if a background capture is running (none in this version). */
  const stopWake = async () => {
    if (listen.current.mode !== "wake") return;
    listen.current.active = false;
    await listen.current.done;
  };

  const handleAnswer = (res: CopilotAnswer) => {
    setHeard(res.transcript || "(didn't catch that)");
    if (res.lot) {
      const i = options.findIndex((o) => o.slug === res.lot!.slug);
      if (i >= 0) setIdx(i);
    }
    if (res.speech_path) voice.play(res.speech_path, "drive");
    if (res.action === "directions" && res.lot) {
      const target = res.lot;
      setTimeout(() => Linking.openURL(lotDirectionsUrl(target)).catch(() => {}), 1800);
    }
  };

  const startAsk = async () => {
    if (listen.current.active && listen.current.mode === "ask") return;   // already listening: let the driver finish
    if (!voice.enabled) return toast("Voice questions need the ElevenLabs key on the server.", "info");
    await stopWake();
    voice.stop();
    const perm = await requestRecordingPermissionsAsync().catch(() => null);
    if (!perm?.granted) return toast("Microphone access is off. Enable it in Settings to ask questions.", "error");
    setHeard(null);
    setPhase("listening");
    buzz();
    const uri = await capture("ask");
    if (!uri) {
      // Silence for 5 s: don't leave the driver hanging, give them the current best option.
      setPhase("idle");
      speak(0);
      return;
    }
    setPhase("thinking");
    try { handleAnswer(await askCopilot({ audioUri: uri, destination, arrival: p.arrival, accessible, drive: true })); }
    catch (e) { toast((e as Error).message, "error"); }
    finally { setPhase("idle"); }
  };


  // ---------------------------------------------------------------- proactive alerts
  const prevMode = useRef(state?.mode);
  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = state?.mode;
    if (!prev || !state || prev === state.mode) return;
    if (state.mode === "ice") { flash("Ice season on"); voice.play(voicePaths.alert("ice_on", destination), "drive"); load(); }
    else if (prev === "ice") { flash("Ice season off"); voice.play(voicePaths.alert("ice_off", destination), "drive"); load(); }
  }, [state?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const wasFull = useRef<Record<number, boolean>>({});
  useEffect(() => {
    const target = lots?.lots.find((l) => l.slug === options[0]?.slug);
    if (!target) return;
    const full = lotFull(target) || target.occupancy_pct >= 95;
    const before = wasFull.current[target.id];
    wasFull.current[target.id] = full;
    if (before === false && full) { flash(`${target.name} filling up`); voice.play(voicePaths.alert("lot_full", destination, target.id), "drive"); load(); }
  }, [lots, options]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- gestures
  // Rebuilt every render so the (once-created) PanResponder always calls current state.
  const swipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (swipeTimer.current) clearTimeout(swipeTimer.current); }, []);
  const actions = useRef({ tap: () => {}, next: (_: 1 | -1) => {}, directions: () => {}, stop: () => {}, ask: () => {} });
  actions.current = {
    tap: () => {
      if (listen.current.active && listen.current.mode === "ask") return;   // listening: taps don't cut the driver off
      if (!cur) { buzz(); load(); return; }                  // nothing loaded yet: tap retries
      if (voice.playing === "drive") { buzz(); flash("Stopped"); voice.stop(); return; }   // tap while talking = stop
      buzz(); flash("Repeating"); speak(idx);
    },
    next: (dir) => {
      const n = options.length;
      if (!n) return;
      const i = (idx + dir + n) % n;
      buzz(); setIdx(i); flash(dir > 0 ? "Next lot" : "Previous lot");
      // Swiping through lots quickly: stop the current line now, speak only the lot you settle on.
      voice.stop();
      if (swipeTimer.current) clearTimeout(swipeTimer.current);
      swipeTimer.current = setTimeout(() => speak(i), 450);
    },
    directions: () => {
      if (!lot) return;
      buzz("ok"); flash("Opening Google Maps");
      Linking.openURL(lotDirectionsUrl(lot)).catch(() => toast("Couldn't open Google Maps.", "error"));
    },
    stop: () => { buzz(); flash("Stopped"); voice.stop(); },
    ask: () => { if (swipeTimer.current) clearTimeout(swipeTimer.current); flash("Listening…"); startAsk(); },
  };

  const pan = useMemo(() => {
    let start = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Keep the gesture: without this a vertical drag can be handed to the system/navigator and never "release".
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => { start = Date.now(); },
      onPanResponderRelease: (_, g) => {
        const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
        if (g.dy < -SWIPE && ay > ax * 0.8) return actions.current.directions();
        if (g.dy > SWIPE && ay > ax * 0.8) return actions.current.ask();
        if (ax > SWIPE && ax > ay) return actions.current.next(g.dx < 0 ? 1 : -1);
        if (ax < TAP_SLOP && ay < TAP_SLOP && Date.now() - start < TAP_MS) return actions.current.tap();
      },
    });
  }, []);

  const speaking = voice.playing === "drive";
  const status = phase === "listening" ? "Listening… take your time"
    : phase === "thinking" ? "Thinking…"
      : speaking ? "Speaking…" : hint;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <Starfield />
      <View style={[row.between, { paddingHorizontal: space.lg, paddingTop: space.sm }]}>
        <Pressable onPress={() => router.back()} accessibilityLabel="Exit drive mode" hitSlop={12}
          style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
          <X size={24} color={c.text} />
        </Pressable>
        <View style={{ alignItems: "flex-end" }}>
          <T v="label">Drive mode · {destination}</T>
          <T v="caption">Voice guidance on</T>
        </View>
      </View>

      <View {...pan.panHandlers} style={{ flex: 1, justifyContent: "center", paddingHorizontal: space.xl, gap: space.lg }}
        accessibilityRole="adjustable"
        accessibilityLabel="Gesture pad. Tap to hear the briefing, swipe left or right for other lots, swipe up for directions, swipe down to ask a question."
        accessibilityActions={[{ name: "activate" }, { name: "increment" }, { name: "decrement" }, { name: "magicTap" }]}
        onAccessibilityAction={(e) => {
          const a = e.nativeEvent.actionName;
          if (a === "activate") actions.current.tap();
          else if (a === "increment") actions.current.next(1);
          else if (a === "decrement") actions.current.next(-1);
          else if (a === "magicTap") actions.current.ask();
        }}>
        {!cur ? (
          <View style={{ alignItems: "center", gap: space.md }}>
            <Ufo size={90} />
            <T v="body" color={loadErr ? c.warn : c.textMuted}>{loadErr ? "Couldn't load parking. Tap to retry." : "Finding the best lot…"}</T>
          </View>
        ) : (
          <>
            <View style={row.between}>
              <T v="label">{idx === 0 ? "Best option" : `Option ${idx + 1} of ${options.length}`}</T>
              <Badge tone={availabilityTone(cur.label)}>{sentence(cur.label)}</Badge>
            </View>
            <T v="title" style={{ fontSize: 46, lineHeight: 52 }} numberOfLines={2}>{cur.name}</T>
            <T v="heading" color={c.textMuted} style={{ fontSize: 26 }}>{cur.expected_open_spaces > 0 ? `${cur.expected_open_spaces} spaces open` : "Full"}</T>
          </>
        )}
        <View style={{ minHeight: 64, gap: 4 }}>
          {phase === "listening" && (
            <View style={{ gap: space.sm, alignItems: "center", paddingVertical: space.sm }}>
              <VoiceWave levels={levels} color={c.danger} />
              <T v="caption">I'll answer when you stop talking</T>
            </View>
          )}
          {status && (
            <View style={row.gap}>
              {phase === "listening" ? <Mic size={22} color={c.danger} /> : (speaking || phase === "thinking") ? <Ufo size={30} beam={phase === "thinking"} /> : null}
              <T v="body" color={phase === "listening" ? c.danger : c.accent}>{status}</T>
            </View>
          )}
          {heard && phase !== "listening" && <T v="caption" numberOfLines={2}>You asked: “{heard}”</T>}
        </View>
      </View>

      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Gesture icon={<Hand size={18} color={c.text} />} label={speaking ? "Tap: stop" : "Tap: hear it"} />
          <Gesture icon={<ArrowLeftRight size={18} color={c.text} />} label="Swipe: other lots" />
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Gesture icon={<Mic size={18} color={c.accent} />} label="Swipe down or tap: ask" onPress={() => actions.current.ask()} />
          <Gesture icon={<ArrowUp size={18} color={c.text} />} label="Swipe up: directions" />
        </View>
        <View style={[row.gap, { justifyContent: "center" }]}>
          <Smartphone size={13} color={c.textFaint} />
          <T v="caption" color={c.textFaint}>Mount your phone before driving</T>
        </View>
      </View>
    </SafeAreaView>
  );
}

function Gesture({ icon, label, onPress }: { icon: ReactNode; label: string; onPress?: () => void }) {
  const { c } = useStore();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? "button" : undefined} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingVertical: space.md,
      borderRadius: radius.md, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: c.border }}>
      {icon}
      <T v="caption">{label}</T>
    </Pressable>
  );
}

/** Live microphone level as a rolling bar waveform (newest on the right), so the driver sees they're heard. */
function VoiceWave({ levels, color }: { levels: number[]; color: string }) {
  return (
    <View style={{ height: 72, flexDirection: "row", alignItems: "center", gap: 4 }} accessibilityLabel="Microphone level">
      {levels.map((l, i) => (
        <View key={i} style={{ width: 6, height: Math.max(6, l * 72), borderRadius: 3, backgroundColor: color,
          opacity: 0.35 + 0.65 * (i / levels.length) }} />
      ))}
    </View>
  );
}
