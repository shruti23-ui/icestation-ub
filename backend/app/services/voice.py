"""Spoken parking briefings via ElevenLabs text-to-speech.

The API key stays on the server; clients fetch MP3 audio from /api/voice/*. Briefing text is
built here (not accepted from clients) so the endpoint can't be used as an open TTS proxy, and
it follows the honesty rules: estimates are called estimates, nothing is "reserved" or "safe".
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict

import httpx

from ..config import get_settings

settings = get_settings()
API_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
MAX_AUDIO_BYTES = 5 * 1024 * 1024  # ~5 s voice clips are tens of KB
MAX_CHARS = 600
_CACHE_SIZE = 32
_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()  # synthesize() runs on many request threads


class VoiceError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(settings.elevenlabs_api_key.strip())


def _clock(hhmm: str) -> str:
    """'09:40' -> '9:40 AM' (spoken naturally by the TTS model)."""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{(h + 11) % 12 + 1}:{m:02d} {'AM' if h < 12 else 'PM'}"


DRIVE_GREETING = "Hey, I'm Parky."
DRIVE_OPTIONS = ("Tap to hear it again. Swipe left or right for other lots. Swipe up for directions. "
                 "Swipe down to ask me a question.")


def drive_intro_text(rec: dict) -> str:
    """What drive mode says when it opens: a greeting, the briefing, then the gesture options."""
    return f"{DRIVE_GREETING} {drive_briefing_text(rec)} {DRIVE_OPTIONS}"


def drive_briefing_text(rec: dict) -> str:
    """Drive mode: short, glanceable-by-ear lines. Lot first, numbers second, no data-source footnotes."""
    best, backup = rec.get("best"), rec.get("backup")
    dest = rec.get("destination", "your destination")
    if not best:
        return f"I couldn't find a lot with open spaces for {dest} right now."
    parts = [f"For {dest}, park at {best['name']}. About {best['expected_open_spaces']} spaces open."]
    if backup:
        parts.append(f"If it's full, try {backup['name']}.")
    if best.get("ice_buffer_minutes"):
        parts.append("Roads may be icy, so allow extra time.")
    route = best.get("route") or {}
    if route.get("status") == "blocked":
        parts.append("Heads up: a curb ramp on the walk from there is blocked.")
    elif route.get("status") == "hazard":
        parts.append("Watch your step on the walk in; a hazard was reported.")
    return " ".join(parts)


def drive_lot_text(lot: dict) -> str:
    """Drive mode: one lot in one breath."""
    if lot["available"] <= 0:
        return f"{lot['name']} is full."
    return f"{lot['name']}: about {lot['available']} of {lot['snow_adjusted_capacity']} spaces open."


def briefing_text(rec: dict) -> str:
    """Turns a /api/parking/recommendations result into one or two short spoken sentences."""
    best, backup = rec.get("best"), rec.get("backup")
    dest = rec.get("destination", "your destination")
    if not best:
        return f"I couldn't find a lot with space for {dest} right now. {rec.get('explanation', '')}".strip()
    parts = [
        f"For {dest}, the best option is {best['name']}, with about {best['expected_open_spaces']} spaces "
        f"expected open when you arrive at {_clock(rec['arrival_time'])}.",
    ]
    if best.get("ice_buffer_minutes"):
        parts.append(f"Ice season is on, so that includes {best['ice_buffer_minutes']} extra minutes.")
    route = best.get("route") or {}
    if route.get("status") == "blocked":
        parts.append("A blocked curb ramp has been reported on the walk from that lot.")
    elif route.get("status") == "hazard":
        parts.append("Walkway hazards have been reported on the way, so watch your step.")
    if backup:
        parts.append(f"If it fills up, try {backup['name']}.")
    if best.get("data_source") == "seed_model":
        parts.append("This is an estimate, not live UB parking data.")
    elif best.get("data_source") == "demo":
        parts.append("These are demo numbers, not live UB parking data.")
    return " ".join(parts)


def lot_text(lot: dict) -> str:
    """Short spoken summary of one lot from lot_status()."""
    basis = {"seed_model": " by our estimate", "demo": " in demo data"}.get(lot["data_source"], " based on a recent student report")
    s = (f"{lot['name']} has about {lot['available']} spaces open, and is {round(lot['occupancy_pct'])} percent full"
         f"{basis}.")
    if lot["snow_blocked_spaces"]:
        s += f" About {lot['snow_blocked_spaces']} spaces are blocked by snow."
    if lot["pending_departures"]:
        s += f" {lot['pending_departures']} {'driver is' if lot['pending_departures'] == 1 else 'drivers are'} leaving soon."
    return s


def transcribe(data: bytes, filename: str = "question.m4a", content_type: str = "audio/mp4") -> str:
    """Speech-to-text (ElevenLabs Scribe) for a short spoken question. Audio is not stored."""
    if not configured():
        raise VoiceError(503, "Voice questions need ELEVENLABS_API_KEY in backend/.env.")
    if not data:
        raise VoiceError(400, "Empty recording.")
    if len(data) > MAX_AUDIO_BYTES:
        raise VoiceError(413, "Recording too long. Ask a short question.")
    try:
        r = httpx.post(STT_URL, headers={"xi-api-key": settings.elevenlabs_api_key.strip()},
                       data={"model_id": settings.elevenlabs_stt_model, "language_code": "en", "tag_audio_events": "false"},
                       files={"file": (filename, data, content_type or "application/octet-stream")}, timeout=30)
    except httpx.HTTPError as exc:
        raise VoiceError(502, f"ElevenLabs unreachable: {type(exc).__name__}") from exc
    if r.status_code == 401:
        raise VoiceError(502, "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY.")
    if r.status_code >= 400:
        raise VoiceError(502, f"ElevenLabs speech-to-text error {r.status_code}: {r.text[:160]}")
    return str(r.json().get("text", "")).strip()


def synthesize(text: str) -> bytes:
    """MP3 bytes for `text`. Small in-memory LRU so repeated briefings don't spend credits."""
    if not configured():
        raise VoiceError(503, "Voice briefings are off. Set ELEVENLABS_API_KEY in backend/.env.")
    text = text[:MAX_CHARS]
    key = hashlib.sha256(f"{settings.elevenlabs_voice_id}|{settings.elevenlabs_model}|{settings.elevenlabs_stability}|"
                         f"{settings.elevenlabs_speed}|{text}".encode()).hexdigest()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    try:
        r = httpx.post(
            API_URL.format(voice_id=settings.elevenlabs_voice_id),
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": settings.elevenlabs_api_key.strip(), "Accept": "audio/mpeg"},
            json={"text": text, "model_id": settings.elevenlabs_model,
                  "voice_settings": {"stability": settings.elevenlabs_stability, "similarity_boost": settings.elevenlabs_similarity,
                                     "style": 0.0, "use_speaker_boost": True, "speed": settings.elevenlabs_speed}},
            timeout=20,
        )
    except httpx.HTTPError as exc:
        raise VoiceError(502, f"ElevenLabs unreachable: {type(exc).__name__}") from exc
    if r.status_code == 401:
        raise VoiceError(502, "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY.")
    if r.status_code >= 400:
        detail = r.text[:160]
        raise VoiceError(502, f"ElevenLabs error {r.status_code}: {detail}")
    with _cache_lock:
        _cache[key] = r.content
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return r.content
