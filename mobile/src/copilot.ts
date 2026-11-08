import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { askCopilot, directionsUrl, type CopilotAnswer } from "./api";
import { useStore } from "./store";
import { useVoice } from "./voice";

export type CopilotPhase = "idle" | "listening" | "thinking" | "speaking";
export interface ChatMessage { id: number; role: "user" | "assistant"; text: string; meta?: string }

// Voice-activity detection on the recorder's metering (dBFS). The noise floor is measured for the first
// moments of each turn, so a noisy car and a quiet room both work.
const POLL_MS = 100;
const CALIBRATE_MS = 250;
const SPEECH_OVER_FLOOR_DB = 7;      // louder than this above the floor = talking
const SILENCE_OVER_FLOOR_DB = 6;      // back under this = pause
const END_OF_SPEECH_MS = 650;        // pause long enough to mean "I'm done" (snappy response)
const NO_SPEECH_TIMEOUT_MS = 4000;   // nobody said anything: end the conversation
const MAX_TURN_MS = 8000;            // max turn duration
const FALLBACK_TURN_MS = 3500;       // platforms without metering (some browsers): fixed window, tap to send early

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hands-free conversational assistant. `start()` runs listen -> think -> speak -> listen... until the
 *  user says "thanks"/"stop", stays silent, or taps `end()`. Answers come from /api/voice/ask with a
 *  conversation_id, so follow-ups ("is it full?") work. Typed/suggested questions join the same conversation. */
export function useCopilot(opts: { destination: string; arrival?: string; accessible?: boolean; onAnswer?: (a: CopilotAnswer) => void }) {
  const { toast } = useStore();
  const voice = useVoice();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const [phase, setPhase] = useState<CopilotPhase>("idle");
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);              // 0..1 mic level for the UI
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const run = useRef({ active: false, sendNow: false, convo: null as string | null, busy: false });
  const nextId = useRef(1);
  const o = useRef(opts);
  o.current = opts;

  const push = (role: ChatMessage["role"], text: string, meta?: string) =>
    setMessages((m) => [...m.slice(-19), { id: nextId.current++, role, text, meta }]);

  useEffect(() => () => { run.current.active = false; voice.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Record one utterance; resolves with the file URI, or null if nobody spoke. */
  const listenOnce = useCallback(async (): Promise<string | null> => {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    const t0 = Date.now();
    const floor: number[] = [];
    let spoke = false, quietSince = 0, metered = false, peak = -100;
    run.current.sendNow = false;
    try {
      while (run.current.active && !run.current.sendNow) {
        await sleep(POLL_MS);
        const elapsed = Date.now() - t0;
        const db = recorder.getStatus().metering;
        if (typeof db === "number" && Number.isFinite(db)) {
          metered = true;
          setLevel(Math.max(0, Math.min(1, (db + 60) / 50)));
          if (elapsed < CALIBRATE_MS) { floor.push(db); continue; }
          const rawBase = floor.length ? Math.min(...floor) : -55;
          const base = Math.min(-38, rawBase);
          if (db > base + SPEECH_OVER_FLOOR_DB) {
            spoke = true;
            quietSince = 0;
            if (db > peak) peak = db;
          } else if (spoke && (db < base + SILENCE_OVER_FLOOR_DB || (peak > -45 && db < peak - 11))) {
            quietSince ||= Date.now();
            if (Date.now() - quietSince >= END_OF_SPEECH_MS) break;
          }
          if (!spoke && elapsed > NO_SPEECH_TIMEOUT_MS) break;
        } else if (!metered && elapsed > FALLBACK_TURN_MS) {
          spoke = true;   // can't tell, so send what we have
          break;
        }
        if (elapsed > MAX_TURN_MS) break;
      }
    } finally {
      setLevel(0);
      try { await recorder.stop(); } catch { /* already stopped */ }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    }
    if (run.current.sendNow) spoke = true;
    return spoke && run.current.active ? recorder.uri : null;
  }, [recorder]);

  /** Send one question (audio or text), show + speak the answer. Returns it, or null on error. */
  const exchange = useCallback(async (q: { audioUri?: string; text?: string }): Promise<CopilotAnswer | null> => {
    setPhase("thinking");
    if (q.text) push("user", q.text);
    try {
      const { destination, arrival, accessible } = o.current;
      const res = await askCopilot({ ...q, destination, arrival, accessible, conversationId: run.current.convo });
      run.current.convo = res.conversation_id;
      if (q.audioUri) push("user", res.transcript || "(didn't catch that)");
      push("assistant", res.answer, res.answered_by === "gemini" ? "Gemini" : undefined);
      o.current.onAnswer?.(res);
      setPhase("speaking");
      await voice.play(res.speech_path, "copilot");
      if (res.action === "directions" && res.lot) Linking.openURL(directionsUrl(res.lot.lat, res.lot.lng)).catch(() => {});
      return res;
    } catch (e) {
      toast((e as Error).message, "error");
      return null;
    } finally {
      setPhase(run.current.active ? "listening" : "idle");
    }
  }, [voice, toast]);

  const end = useCallback(() => {
    run.current.active = false;
    run.current.sendNow = false;
    voice.stop();
    setActive(false);
    setPhase("idle");
  }, [voice]);

  /** Start a hands-free conversation (tap again to end it). */
  const start = useCallback(async () => {
    if (run.current.active) return end();
    if (!voice.enabled) return toast("Voice needs the ElevenLabs key on the server. Tap a suggested question instead.", "info");
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) return toast("Microphone access is off. Enable it in Settings, or tap a suggested question.", "error");
    } catch (e) { return toast(`Couldn't use the microphone: ${(e as Error).message}`, "error"); }
    voice.stop();
    run.current.active = true;
    setActive(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      while (run.current.active) {
        setPhase("listening");
        const uri = await listenOnce();
        if (!run.current.active) break;
        if (!uri) { push("assistant", "Didn't hear anything, so I stopped listening. Tap the mic to talk again."); break; }
        const res = await exchange({ audioUri: uri });
        if (!res || res.end_conversation || res.action === "directions") break;
        Haptics.selectionAsync().catch(() => {});
      }
    } catch (e) {
      toast(`Voice error: ${(e as Error).message}`, "error");
    } finally {
      run.current.active = false;
      setActive(false);
      setPhase("idle");
    }
  }, [voice, toast, listenOnce, exchange, end]);

  /** While listening: stop now and send. */
  const sendNow = useCallback(() => { run.current.sendNow = true; }, []);

  /** Typed or suggested question; joins the current conversation (keeps follow-up memory). */
  const askText = useCallback(async (text: string) => {
    if (phase === "thinking") return;
    if (run.current.active) { run.current.sendNow = false; end(); }
    voice.stop();
    await exchange({ text });
    setPhase("idle");
  }, [phase, voice, exchange, end]);

  const reset = useCallback(() => { end(); run.current.convo = null; setMessages([]); }, [end]);

  /** Barge-in: cut the current answer short; in a conversation it goes straight back to listening. */
  const interrupt = useCallback(() => { voice.stop(); }, [voice]);

  return { phase, active, level, messages, start, end, sendNow, interrupt, askText, reset, voiceEnabled: voice.enabled };
}
