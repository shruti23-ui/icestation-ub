import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./config";
import { useStore } from "./store";

// One voice for the whole app: a new utterance always stops the previous one.
let current: { id: string; token: number; stop: () => void } | null = null;
let nextToken = 0;
const listeners = new Set<(id: string | null) => void>();
const announce = (id: string | null) => listeners.forEach((l) => l(id));
let audioModeSet = false;

// Device-voice fallback: prefer a soft English female voice when the phone has one (iOS Samantha/Ava/Karen,
// Android en-us "sfg"/"tpc" female voices, Windows Zira). Falls back to the default voice.
let gentleVoice: string | null = null;
Speech.getAvailableVoicesAsync().then((vs) => {
  const en = vs.filter((v) => /^en/i.test(v.language));
  const pick = en.find((v) => /samantha|ava|allison|susan|karen|serena|zira|female|sfg|tpc/i.test(`${v.name} ${v.identifier}`));
  gentleVoice = pick?.identifier ?? null;
}).catch(() => {});

const textUrl = (path: string) => `${API_BASE}${path}${path.includes("?") ? "&" : "?"}text_only=true`;

/** Speaks server-written text from /api/voice/*. ElevenLabs audio when the server has a key (the key never
 *  leaves the server); otherwise, or if the audio doesn't load, the phone's built-in voice reads the same
 *  script. `play()` resolves when speaking finishes or is stopped, so callers can chain turns. */
export function useVoice() {
  const { health } = useStore();
  const [playing, setPlaying] = useState<string | null>(current?.id ?? null);
  useEffect(() => { listeners.add(setPlaying); return () => { listeners.delete(setPlaying); }; }, []);

  const stop = useCallback(() => { current?.stop(); }, []);

  const play = useCallback((path: string, id: string = path) => new Promise<void>((resolve) => {
    current?.stop();
    Speech.stop();                       // never let a device-voice line overlap the next one
    const token = ++nextToken;           // identifies THIS utterance (ids repeat, e.g. every drive line is "drive")
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (current?.token === token) { current = null; announce(null); }
      resolve();
    };

    const speakDevice = async () => {
      let text = "";
      try {
        const r = await fetch(textUrl(path));
        text = r.ok ? ((await r.json()) as { text: string }).text : "";
      } catch { /* fall through */ }
      if (finished || !text) return finish();
      Speech.speak(text, { rate: 1.05, pitch: 1.1, voice: gentleVoice ?? undefined, onDone: finish, onStopped: finish, onError: finish });
    };

    if (health?.voice_enabled === false) {
      current = { id, token, stop: () => { Speech.stop(); finish(); } };
      announce(id);
      speakDevice();
      return;
    }

    // Register now so a stop() before the player exists still ends this utterance.
    current = { id, token, stop: finish };
    announce(id);
    (async () => {
      if (!audioModeSet) {
        audioModeSet = true;
        await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      }
      if (finished) return;
      const player: AudioPlayer = createAudioPlayer({ uri: API_BASE + path });
      let loaded = false;
      // pause() first: on Android remove() alone can let the stream keep playing for a moment (overlapping voices).
      const cleanup = () => { clearTimeout(timeout); sub.remove(); try { player.pause(); } catch { /* released */ } player.remove(); };
      // ElevenLabs outage / bad key = a stream that never loads: switch to the device voice.
      const timeout = setTimeout(() => {
        if (!loaded && !finished) { cleanup(); current = { id, token, stop: () => { Speech.stop(); finish(); } }; speakDevice(); }
      }, 8000);
      const sub = player.addListener("playbackStatusUpdate", (s) => {
        if (s.isLoaded) loaded = true;
        if (s.didJustFinish) { cleanup(); finish(); }
      });
      if (current?.token !== token || finished) { cleanup(); return; }   // superseded while starting
      current = { id, token, stop: () => { cleanup(); Speech.stop(); finish(); } };
      player.play();
    })();
  }), [health?.voice_enabled]);

  return { enabled: health?.voice_enabled !== false, playing, play, stop };
}
