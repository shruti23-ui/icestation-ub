"""Walkway hazard lifecycle + accessible-route checks."""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import HazardReport
from ..timeutil import iso, utcnow

settings = get_settings()
ROUTE_BUFFER_M = 45.0  # how close a report must be to the straight lot-to-building line
CATEGORY_LABELS = {"ice": "Ice", "slush": "Slush", "snow": "Snow accumulation",
                   "unplowed": "Unplowed path", "blocked_ramp": "Blocked curb ramp", "other": "Other hazard"}

# Typed description -> category, first match wins (ramp first: it's a hard stop for wheelchair users).
_KEYWORDS = [
    ("blocked_ramp", ("ramp", "wheelchair", "curb cut", "kerb")),
    ("slush", ("slush",)),
    ("unplowed", ("unplow", "not plowed", "unshovel", "not shoveled", "not shovelled", "deep snow")),
    ("ice", ("ice", "icy", "glaze", "slippery", "slick", "frozen")),
    ("snow", ("snow",)),
]


def category_from_text(text: str) -> str:
    """Pick a hazard category from a student's description; 'other' when nothing matches. Pure; tested."""
    t = (text or "").lower()
    for cat, words in _KEYWORDS:
        if any(w in t for w in words):
            return cat
    return "other"


def ttl_for(category: str) -> timedelta:
    if category == "ice":
        return timedelta(hours=settings.ice_hazard_ttl_hours)
    if category == "blocked_ramp":
        return timedelta(hours=settings.ramp_hazard_ttl_hours)
    return timedelta(hours=settings.other_hazard_ttl_hours)


def vote_confidence(base: float, confirmations: int, clears: int) -> float:
    """Each extra confirmation adds confidence, each clear vote removes more."""
    return round(min(0.99, max(0.05, base + 0.08 * (confirmations - 1) - 0.15 * clears)), 2)


def should_clear(confirmations: int, clears: int) -> bool:
    """A single 'it's clear' removes a fresh, unconfirmed pin immediately; a pin confirmed
    by several students needs clears from at least half as many."""
    return clears >= max(1, math.ceil(confirmations / 2))


def expire_hazards(db: Session, now: datetime | None = None) -> int:
    """Marks active pins past their expiry as expired. Returns how many changed."""
    now = now or utcnow()
    stale = db.scalars(select(HazardReport).where(HazardReport.status == "active",
                                                   HazardReport.expires_at <= now)).all()
    for h in stale:
        h.status = "expired"
    if stale:
        db.commit()
    return len(stale)


def active_hazards(db: Session, now: datetime | None = None) -> list[HazardReport]:
    now = now or utcnow()
    expire_hazards(db, now)
    return list(db.scalars(select(HazardReport).where(HazardReport.status == "active")
                           .order_by(HazardReport.created_at.desc())).all())


def serialize(h: HazardReport) -> dict:
    now = utcnow()
    return {
        "id": h.id, "location_name": h.location_name, "lat": h.lat, "lng": h.lng,
        "category": h.category, "category_label": CATEGORY_LABELS[h.category],
        "confidence": h.confidence, "classified_by": h.classified_by, "explanation": h.explanation,
        "image_url": h.image_path or None,
        "confirmations": h.confirmations, "clear_votes": h.clear_votes, "status": h.status,
        "created_at": iso(h.created_at), "expires_at": iso(h.expires_at),
        "minutes_left": max(0, round((h.expires_at - now).total_seconds() / 60)),
        "is_demo": h.is_demo, "hard_stop_for_wheelchairs": h.category == "blocked_ramp",
    }


def _dist_point_segment_m(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    lat0 = math.radians((a[0] + b[0]) / 2)
    def xy(q): return (math.radians(q[1]) * math.cos(lat0) * 6_371_000, math.radians(q[0]) * 6_371_000)
    (px, py), (ax, ay), (bx, by) = xy(p), xy(a), xy(b)
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def route_status(lot: tuple[float, float], dest: tuple[float, float], hazards: list[HazardReport], ice_season: bool) -> dict:
    near = [h for h in hazards if _dist_point_segment_m((h.lat, h.lng), lot, dest) <= ROUTE_BUFFER_M]
    ramps = [h for h in near if h.category == "blocked_ramp"]
    others = [h for h in near if h.category != "blocked_ramp"]
    if ramps:
        status, label = "blocked", "Blocked curb ramp reported. Not passable by wheelchair."
    elif others:
        cats = sorted({CATEGORY_LABELS[h.category].lower() for h in others})
        status, label = "hazard", f"Reported on this route: {', '.join(cats)}."
    else:
        status = "unverified"
        label = ("No reports on this route yet. Winter conditions likely; treat as unverified."
                 if ice_season else "No reports on this route. Conditions unverified.")
    return {"status": status, "label": label, "hazard_ids": [h.id for h in near],
            "wheelchair_hard_stop": bool(ramps)}
