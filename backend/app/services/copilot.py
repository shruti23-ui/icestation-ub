"""Voice co-pilot intent parsing (pure, no DB, unit-tested).

Driving questions are short and predictable, so a deterministic keyword parser answers the common ones
instantly and reliably: "Where should I park?", "Is Hochstetter full?", "When should I leave?",
"Take me to Stadium", "Is it icy?". It knows every UB lot by name (passed in from config), resolves
follow-ups ("is it full?") from the previous turn, and recognises the end of a conversation.
Anything it can't classify is "help", which the router hands to Gemini with live data as context.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Legacy spoken aliases -> lot slug. Speech-to-text often drops letters ("Jarvis A" -> "Jarvis").
LOT_ALIASES = {
    "jarvis": "jarvis-a",
    "hochstetter": "hochstetter-b", "hoffstetter": "hochstetter-b", "hochstatter": "hochstetter-b", "hockstetter": "hochstetter-b",
    "center for tomorrow": "center-for-tomorrow", "centre for tomorrow": "center-for-tomorrow", "tomorrow": "center-for-tomorrow",
    "stadium": "stadium",
}

KINDS = ("end", "directions", "lot_status", "leave_time", "best", "conditions", "hazards", "help")
END_PHRASES = ("stop", "thanks", "thank you", "thats all", "bye", "goodbye", "never mind", "nevermind",
               "no thanks", "done", "nothing", "im good", "all good")
PRONOUNS = ("it", "there", "that", "that one", "same", "this one", "that lot")
STATUS_WORDS = ("full", "space", "spaces", "spot", "spots", "open", "room", "busy", "available", "parking",
                "how many", "is", "status", "about", "what", "park", "can i")


@dataclass(frozen=True)
class Intent:
    kind: str                        # one of KINDS
    lot_slug: str | None = None      # lot the question is about, if any
    destination: str | None = None   # building named in the question, if any


def _norm(text: str) -> str:
    # Drop apostrophes first so speech-to-text's "Governor's A" becomes "governors a".
    t = text.lower().replace("'", "").replace("’", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", t)).strip()


def _has(t: str, *words: str) -> bool:
    return any(re.search(rf"\b{re.escape(w)}\b", t) for w in words)


def lot_variants(name: str) -> list[str]:
    """Spoken forms of a lot name: 'Richmond Lot (north)' -> ['richmond lot north', 'richmond north']."""
    full = _norm(name)
    bare = _norm(re.sub(r"\bLot\b", "", name))
    return list(dict.fromkeys(v for v in (full, bare) if v))


def find_lot(text: str, lots: list[tuple[str, str]] | None = None) -> str | None:
    """Slug of the lot named in `text`. `lots` = [(slug, name)] for every UB lot. The longest match wins,
    so 'jarvis b' beats the legacy 'jarvis' alias and 'center for tomorrow' beats 'tomorrow'."""
    t = _norm(text)
    by_base: dict[str, list[str]] = {}
    for slug, name in lots or []:
        by_base.setdefault(_norm(name).split(" ")[0], []).append(slug)
    names: dict[str, str] = {}
    for slug, name in lots or []:
        for v in lot_variants(name):
            # "Hochstetter Lot" must not claim the bare word "hochstetter" while "Hochstetter B" exists.
            if v in by_base and len(by_base[v]) > 1:
                continue
            names[v] = slug
    # A bare base word ("slee") counts only when exactly one lot starts with it.
    for base, slugs in by_base.items():
        if len(slugs) == 1 and len(base) > 3:
            names.setdefault(base, slugs[0])
    for alias, slug in LOT_ALIASES.items():
        names.setdefault(alias, slug)
    for variant in sorted(names, key=len, reverse=True):
        if re.search(rf"\b{re.escape(variant)}\b", t):
            return names[variant]
    return None


def find_building(text: str, buildings: list[str]) -> str | None:
    t = _norm(text)
    for b in sorted(buildings, key=len, reverse=True):
        name = _norm(b)
        short = name.replace(" hall", "").replace(" library", "").replace(" complex", "").strip()
        if re.search(rf"\b{re.escape(name)}\b", t) or (len(short) > 3 and re.search(rf"\b{re.escape(short)}\b", t)):
            return b
    return None


def parse(text: str, buildings: list[str], lots: list[tuple[str, str]] | None = None, last_lot: str | None = None) -> Intent:
    """`last_lot` is the lot from the previous turn, for follow-ups like "is it full?"."""
    t = _norm(text)
    if not t:
        return Intent("help")
    if len(t.split()) <= 5 and _has(t, *END_PHRASES) and not _has(t, "park", "lot", "full", "leave", "where"):
        return Intent("end")
    lot = find_lot(t, lots)
    # Pronoun follow-ups are short ("is it full?", "when should I leave for it?"); in longer sentences
    # "it" is usually not about the previous lot ("is it worth driving in today?").
    if lot is None and last_lot and len(t.split()) <= 8 and _has(t, *PRONOUNS):
        lot = last_lot
    dest = find_building(t, buildings)
    if _has(t, "directions", "navigate", "navigation", "take me", "route me", "drive me", "get me to", "how do i get"):
        return Intent("directions", lot, dest)
    if lot and _has(t, *STATUS_WORDS):
        return Intent("lot_status", lot, dest)
    if _has(t, "when", "leave", "time", "late", "depart"):
        return Intent("leave_time", lot, dest)
    if _has(t, "ice season", "icy", "ice", "snow", "storm", "weather", "roads", "road", "satellite", "slippery"):
        if _has(t, "walkway", "walkways", "path", "paths", "sidewalk", "sidewalks", "ramp", "ramps", "hazard", "hazards"):
            return Intent("hazards", lot, dest)
        return Intent("conditions", lot, dest)
    if _has(t, "hazard", "hazards", "walkway", "walkways", "ramp", "ramps", "sidewalk", "sidewalks"):
        return Intent("hazards", lot, dest)
    if _has(t, "where", "park", "parking", "lot", "best", "recommend", "spot", "space") or dest:
        return Intent("best", lot, dest)
    if lot:
        return Intent("lot_status", lot, dest)
    return Intent("help", None, dest)


HELP_TEXT = ("You can ask: where should I park, is Hochstetter full, when should I leave, "
             "is it icy, or take me to Stadium Lot.")
END_TEXT = "Okay. Drive carefully, and tap the mic whenever you need me."


# Wake phrase for hands-free drive mode: "Hey Parky". Speech-to-text hears it many ways ("hey parkie", "hi parky",
# "hey park key", "a party", "hey parking", "okay perky", "hey paki"), sometimes after a filler word or a sound tag
# like "(engine noise)". In a busy room the clip also contains other people's talk, so "Hey Parky" can be anywhere:
#   - greeting + name ("hey parkie", "hi parky", "okay perky") counts anywhere; the question is what follows the LAST one
#   - the bare name counts only as the first word, and plain "parking" never counts on its own
_GREETING = r"(?:hey|hi|hay|hai|heyy|ok|okay|yo|hello)"
_NAME = r"(?:park[\s-]+(?:key|ee|e|y|ie|i)|parkie|parkey|parky|parki|parkee|perky|porky|barky|pakki|paki|parking|party)"
_WAKE_ANY = re.compile(rf"\b{_GREETING}[\s,.!-]*{_NAME}\b[\s,.!?-]*", re.IGNORECASE)
_WAKE_START = re.compile(rf"^\W*(?:{_NAME})\b[\s,.!?-]*", re.IGNORECASE)
_NOISE = re.compile(r"[\(\[][^\)\]]*[\)\]]")   # "(engine noise)", "[music]"


def split_wake(transcript: str) -> tuple[bool, str]:
    """(said the wake phrase?, the rest of the sentence after it). Pure; tested."""
    text = re.sub(r"\s+", " ", _NOISE.sub(" ", transcript or "")).strip()
    hits = list(_WAKE_ANY.finditer(text))
    if hits:
        return True, text[hits[-1].end():].strip()
    m = _WAKE_START.match(text)
    if m and not m.group(0).strip(" ,.!?-").lower().startswith(("parking", "party")):
        return True, text[m.end():].strip()
    return False, transcript or ""
