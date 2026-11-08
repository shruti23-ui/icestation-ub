"""Spoken briefings and the voice co-pilot (ElevenLabs TTS + speech-to-text).

All spoken text is written by the server. Clients can ask questions (audio or text) and request
alerts by kind, but can never make the server speak arbitrary text, so the ElevenLabs key can't be
used as an open TTS proxy.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from collections import OrderedDict

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..campus import BUILDINGS
from ..config import get_settings
from ..database import get_db
from ..models import ParkingLot
from ..services import copilot, llm, voice
from ..services import hazards as hz
from ..services import weather
from ..services.engine import display_reason
from ..services.lot_state import get_state, is_ice, lot_status
from .parking import compute_recommendation

log = logging.getLogger("weparkit.voice")
router = APIRouter(prefix="/api/voice", tags=["voice"])
settings = get_settings()

# Answers waiting to be spoken: token -> (expires_at, text). Small and short-lived.
_ANSWER_TTL_S, _ANSWER_MAX = 600, 200
_answers: OrderedDict[str, tuple[float, str]] = OrderedDict()
# Sync endpoints run on a thread pool: guard the shared in-memory stores.
_store_lock = threading.Lock()


def _remember(text: str) -> str:
    token = secrets.token_urlsafe(9)
    with _store_lock:
        _answers[token] = (time.time() + _ANSWER_TTL_S, text)
        while len(_answers) > _ANSWER_MAX:
            _answers.popitem(last=False)
    return token


def _speak(text: str) -> Response:
    try:
        audio = voice.synthesize(text)
    except voice.VoiceError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    # Text goes in a header so clients can show a caption alongside the audio (ASCII-safe).
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "no-store", "X-Voice-Text": text.encode("ascii", "ignore").decode()[:500]})


def _out(text: str, text_only: bool):
    return {"text": text} if text_only else _speak(text)


def _clock(hhmm: str) -> str:
    return voice._clock(hhmm)


@router.get("/status")
def status():
    return {"enabled": voice.configured(), "provider": "ElevenLabs" if voice.configured() else None,
            "speech_to_text": voice.configured()}


@router.get("/briefing")
def briefing(destination: str = Query("Davis Hall"), arrival: str | None = Query(None, description="HH:MM 24h"),
             accessible: bool = False, text_only: bool = False, intro: bool = False, drive: bool = False,
             db: Session = Depends(get_db)):
    """Speaks the current parking recommendation. `text_only=true` returns the script without calling ElevenLabs.
    `intro=true` (drive mode opening) adds a greeting and the gesture options."""
    rec = compute_recommendation(db, destination, arrival, accessible)
    text = voice.drive_intro_text(rec) if intro else voice.drive_briefing_text(rec) if drive else voice.briefing_text(rec)
    return _out(text, text_only)


@router.get("/lot/{lot_id}")
def lot(lot_id: int, text_only: bool = False, drive: bool = False, db: Session = Depends(get_db)):
    """Speaks one lot's current availability."""
    row = db.get(ParkingLot, lot_id)
    if not row:
        raise HTTPException(404, f"Lot {lot_id} not found")
    s = lot_status(db, row, get_state(db))
    return _out(voice.drive_lot_text(s) if drive else voice.lot_text(s), text_only)


# ------------------------------------------------------------------ co-pilot

def _lot_ref(row: ParkingLot | None) -> dict | None:
    if not row:
        return None
    from ..campus import ENTRANCES
    return {"id": row.id, "slug": row.slug, "name": row.name, "lat": row.lat, "lng": row.lng,
            "entrance": list(ENTRANCES.get(row.slug, (row.lat, row.lng)))}


def answer(db: Session, intent: copilot.Intent, destination: str, arrival: str | None, accessible: bool,
           drive: bool = False) -> dict:
    """Server-written spoken answer for a parsed question. Honesty rules: estimates are called
    estimates, nothing is reserved, no route is called safe."""
    dest = intent.destination or destination
    state = get_state(db)
    lots = {l.slug: l for l in db.scalars(select(ParkingLot))}
    rec = compute_recommendation(db, dest, arrival, accessible)
    best = rec["best"]
    asked = lots.get(intent.lot_slug) if intent.lot_slug else None
    target = asked or (lots.get(best["slug"]) if best else None)
    action = None

    if intent.kind == "best":
        text = voice.drive_briefing_text(rec) if drive else voice.briefing_text(rec)
    elif intent.kind == "lot_status" and asked:
        s = lot_status(db, asked, state)
        text = voice.drive_lot_text(s) if drive else voice.lot_text(s)
        full = s["available"] <= max(2, s["snow_adjusted_capacity"] * 0.02)
        if best and best["slug"] != asked.slug and (full or s["occupancy_pct"] >= 90):
            text += f" For {dest}, {best['name']} is a better bet, with about {best['expected_open_spaces']} spaces."
    elif intent.kind == "leave_time":
        e = next((x for x in rec["all"] if asked and x["slug"] == asked.slug), None) or best
        text = (f"To park at {e['name']} and reach {dest} by {_clock(rec['arrival_time'])}, leave by {_clock(e['recommended_departure'])}."
                + (f" That includes {e['ice_buffer_minutes']} extra minutes for ice." if e.get("ice_buffer_minutes") else "")
                if e else f"I couldn't find a lot with space for {dest} right now.")
    elif intent.kind == "directions":
        if target:
            text, action = f"Opening directions to {target.name}.", "directions"
        else:
            text = "I couldn't find a lot to navigate to right now."
    elif intent.kind == "conditions":
        wx = weather.current()
        alerts = [a["event"] for a in wx["alerts"] if a["winter"]]
        if is_ice(state):
            text = (f"Ice season is on. {display_reason(state)} Lot capacity is reduced and leave-by times include "
                    f"{settings.ice_departure_buffer_min} extra minutes.")
        else:
            text = f"Standard conditions. {display_reason(state)}"
        if alerts:
            text += f" Active weather alert: {alerts[0]}."
    elif intent.kind == "hazards":
        active = hz.active_hazards(db)
        if not active:
            text = "No walkway hazards have been reported right now. Conditions are unverified, so take care."
        else:
            parts = [f"{hz.CATEGORY_LABELS[h.category]} at {h.location_name}" for h in active[:2]]
            text = f"{len(active)} walkway {'hazard' if len(active) == 1 else 'hazards'} reported: {'; '.join(parts)}."
            if any(h.category == "blocked_ramp" for h in active):
                text += " A blocked curb ramp is impassable for wheelchairs."
    else:
        text = copilot.HELP_TEXT
    return {"text": text, "lot": _lot_ref(target if intent.kind in ("lot_status", "directions", "best", "leave_time") else None),
            "action": action, "destination": dest}


# Conversation memory for follow-ups ("is it full?"): conversation_id -> state. In-memory, short-lived.
_CONVO_TTL_S, _CONVO_MAX = 900, 300
_convos: OrderedDict[str, dict] = OrderedDict()


def _convo(cid: str | None) -> tuple[str, dict]:
    now = time.time()
    with _store_lock:
        if cid and cid in _convos and _convos[cid]["expires"] > now:
            c = _convos[cid]
            _convos.move_to_end(cid)
        else:
            cid = secrets.token_urlsafe(9)
            c = _convos[cid] = {"turns": [], "lot": None}
            while len(_convos) > _CONVO_MAX:
                _convos.popitem(last=False)
        c["expires"] = now + _CONVO_TTL_S
    return cid, c


def _llm_context(db: Session, destination: str, arrival: str | None, accessible: bool) -> str:
    """Compact live snapshot for Gemini: mode, the recommendation, and lot availability."""
    state = get_state(db)
    rec = compute_recommendation(db, destination, arrival, accessible)
    lots = [lot_status(db, l, state) for l in db.scalars(select(ParkingLot))]
    top = sorted(lots, key=lambda s: -s["available"])[:10]
    lines = [f"Mode: {'ice season' if is_ice(state) else 'standard'}. {display_reason(state)}",
             f"Destination: {destination}. " + (f"Best lot: {rec['best']['name']}, about {rec['best']['expected_open_spaces']} open "
                                                f"at arrival {rec['arrival_time']}, leave by {rec['best']['recommended_departure']}."
                                                if rec["best"] else "No lot recommended."),
             f"UB North Campus has {len(lots)} lots, about {sum(s['available'] for s in lots)} spaces estimated open.",
             "Most open lots: " + "; ".join(f"{s['name']} ~{s['available']} open ({round(s['occupancy_pct'])}% full)" for s in top),
             f"Active walkway hazards: {len(hz.active_hazards(db))}."]
    return "\n".join(lines)


@router.post("/ask")
async def ask(file: UploadFile | None = File(None, description="Short spoken question (m4a/webm/wav)"),
              text: str | None = Form(None, description="Typed question; skips speech-to-text"),
              destination: str = Form("Davis Hall"), arrival: str | None = Form(None), accessible: bool = Form(False),
              conversation_id: str | None = Form(None, description="Returned by the previous turn; enables follow-ups"),
              drive: bool = Form(False, description="Drive mode: short spoken answers"),
              upload_id: str | None = Form(None, description="Recording sent in pieces via /api/parking/upload-chunk"),
              wake: bool = Form(False, description="Hands-free: only answer when it starts with 'Hey Parky'"),
              db: Session = Depends(get_db)):
    """Conversational co-pilot: speech-to-text (ElevenLabs Scribe) -> intent (with follow-up memory) ->
    answer. Common questions get deterministic, data-backed answers; anything else goes to Gemini with live
    lot data as context. Play the reply from `speech_path`; `end_conversation` tells the client to stop listening."""
    if destination not in BUILDINGS:
        raise HTTPException(400, "Unknown destination")
    cid, convo = _convo(conversation_id)
    transcript = (text or "").strip()
    if not transcript and (file is not None or upload_id):
        if file is not None:
            audio, name, ctype = await file.read(), file.filename or "question.m4a", file.content_type or "audio/mp4"
        else:
            from ..services import uploads
            try:
                audio, name, ctype = uploads.take(upload_id), "question.m4a", "audio/mp4"
            except (KeyError, ValueError) as exc:
                raise HTTPException(400, str(exc).strip("'\"")) from exc
        try:
            transcript = voice.transcribe(audio, name, ctype)
        except voice.VoiceError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
    source = "rules"
    if wake:
        heard, rest = copilot.split_wake(transcript)
        if not heard:   # background talk / radio: ignore silently, keep nothing
            return {"transcript": transcript, "ignored": True, "intent": "none", "answer": "", "lot": None, "action": None,
                    "destination": destination, "speech_path": None, "conversation_id": cid, "end_conversation": False,
                    "answered_by": "rules", "listen_again": False}
        if not rest:    # just "Hey Parky": answer and listen for the question
            token = _remember("Yes? What can I help with?")
            return {"transcript": transcript, "ignored": False, "intent": "wake", "answer": "Yes? What can I help with?",
                    "lot": None, "action": None, "destination": destination, "speech_path": f"/api/voice/say/{token}",
                    "conversation_id": cid, "end_conversation": False, "answered_by": "rules", "listen_again": True}
        transcript = rest
    if not transcript:
        if file is None and not upload_id:
            raise HTTPException(400, "Send a recording (file) or a typed question (text).")
        res = {"text": "Sorry, I didn't catch that. " + copilot.HELP_TEXT, "lot": None, "action": None, "destination": destination}
        intent = copilot.Intent("help")
    else:
        lot_names = [(l.slug, l.name) for l in db.scalars(select(ParkingLot))]
        intent = copilot.parse(transcript, list(BUILDINGS), lot_names, convo["lot"])
        if intent.kind == "end":
            res = {"text": copilot.END_TEXT, "lot": None, "action": None, "destination": destination}
        elif intent.kind == "help":
            reply = llm.answer(transcript, _llm_context(db, intent.destination or destination, arrival, accessible), convo["turns"])
            res = {"text": reply or copilot.HELP_TEXT, "lot": None, "action": None, "destination": intent.destination or destination}
            source = "gemini" if reply else "rules"
        else:
            res = answer(db, intent, destination, arrival, accessible, drive)
        if res["lot"]:
            convo["lot"] = res["lot"]["slug"]
        convo["turns"] = (convo["turns"] + [(transcript, res["text"])])[-8:]
    token = _remember(res["text"])
    return {"transcript": transcript, "intent": intent.kind, "answer": res["text"], "lot": res["lot"],
            "action": res["action"], "destination": res["destination"], "speech_path": f"/api/voice/say/{token}",
            "conversation_id": cid, "end_conversation": intent.kind == "end", "answered_by": source,
            "ignored": False, "listen_again": False}


@router.get("/say/{token}")
def say(token: str, text_only: bool = False):
    """Speaks a co-pilot answer created by /ask (expires after 10 minutes)."""
    with _store_lock:
        item = _answers.get(token)
    if not item or item[0] < time.time():
        raise HTTPException(404, "Answer expired. Ask again.")
    return _out(item[1], text_only)


@router.get("/alert")
def alert(kind: str = Query(..., pattern="^(ice_on|ice_off|lot_full)$"), lot_id: int | None = None,
          destination: str = Query("Davis Hall"), text_only: bool = False, db: Session = Depends(get_db)):
    """Proactive drive-mode announcements, spoken before the driver asks."""
    if destination not in BUILDINGS:
        raise HTTPException(400, "Unknown destination")
    rec = compute_recommendation(db, destination, None, False)
    best = rec["best"]
    if kind == "ice_on":
        text = (f"Heads up. Ice season just switched on. Lot capacity is reduced and leave-by times now include "
                f"{settings.ice_departure_buffer_min} extra minutes.")
        if best:
            text += f" Best option now: {best['name']}."
    elif kind == "ice_off":
        text = "Ice season has ended. Back to standard conditions."
    else:
        row = db.get(ParkingLot, lot_id) if lot_id else None
        if not row:
            raise HTTPException(404, "Lot not found")
        s = lot_status(db, row, get_state(db))
        alt = next((e for e in rec["all"] if e["slug"] != row.slug and not e["accessible_blocked"]), None)
        text = f"{row.name} is filling up, about {s['available']} spaces left."
        if alt:
            text += f" Try {alt['name']}, with about {alt['expected_open_spaces']} open."
    return _out(text, text_only)
