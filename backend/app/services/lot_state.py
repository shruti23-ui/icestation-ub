"""Turns stored lot config + live crew reports + operating mode into the numbers the UI shows."""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..campus import ENTRANCES
from ..config import get_settings
from ..models import Notification, ParkingLot, ParkingReport, SystemState
from ..timeutil import iso, utcnow
from .recommendation import LotSnapshot, profile_at, search_minutes
from .sessions import occupancy_adjustment

settings = get_settings()


def campus_now() -> tuple[datetime, bool]:
    """Local campus time (naive) and whether it is a simulated clock."""
    now = datetime.now(ZoneInfo(settings.campus_timezone)).replace(tzinfo=None)
    if settings.sim_clock:
        try:
            hh, mm = (int(x) for x in settings.sim_clock.split(":"))
            return now.replace(hour=hh, minute=mm, second=0, microsecond=0), True
        except ValueError:
            pass
    return now, False


def get_state(db: Session) -> SystemState:
    state = db.get(SystemState, 1)
    if state is None:
        state = SystemState(id=1)
        db.add(state)
        db.commit()
    return state


def is_ice(state: SystemState) -> bool:
    return state.mode == "ice"


def latest_report(db: Session, lot_id: int, now_utc: datetime) -> ParkingReport | None:
    return db.scalars(
        select(ParkingReport)
        .where(ParkingReport.lot_id == lot_id, ParkingReport.expires_at > now_utc)
        .order_by(ParkingReport.created_at.desc())
        .limit(1)
    ).first()


def pending_departures(db: Session, lot_id: int, now_utc: datetime) -> int:
    return len(db.scalars(
        select(Notification.id).where(
            Notification.kind == "leaving", Notification.lot_id == lot_id, Notification.expires_at > now_utc)
    ).all())


def demo_occupancy(slug: str) -> float:
    """Fixed, varied demo occupancy per lot (0.12-0.88), so lots differ from each other. Deterministic by slug."""
    import zlib
    return round(0.12 + 0.76 * (zlib.crc32(slug.encode()) % 1000) / 999, 3)


def lot_status(db: Session, lot: ParkingLot, state: SystemState) -> dict:
    now_utc = utcnow()
    local, simulated = campus_now()
    ice = is_ice(state)
    report = latest_report(db, lot.id, now_utc)
    ttl = settings.parking_report_ttl_min * 60

    if report:
        age = (now_utc - report.created_at).total_seconds()
        occ = report.occupancy_fraction
        snow = report.snow_blocked_fraction
        conf = report.confidence * max(0.4, 1 - 0.5 * age / ttl)
        source = "demo" if report.is_demo else report.source
        snow_source = "crew scan" if report.source == "crew_scan" else "crew report"
        last = report.created_at
        note = report.note
        expires = report.expires_at
    elif lot.slug in settings.demo_full_slugs:
        # Demo example of a full lot (DEMO_FULL_LOTS). Labelled "demo" everywhere; a real report replaces it.
        occ, snow, snow_source = 1.0, 0.0, "none"
        conf = 0.5
        source = "demo"
        last = None
        note = "Demo data: shown as full for the demo, not a real report"
        expires = None
    else:
        occ = profile_at(lot.hourly_profile, local.hour + local.minute / 60)
        snow, snow_source = 0.0, "none"
        conf = 0.45
        source = "seed_model"
        last = None
        note = "Seed occupancy model (no crew report in the last 30 min)"
        expires = None
        spread = demo_occupancy(lot.slug)
        if settings.demo_occupancy_spread and spread > occ:
            occ, source = spread, "demo"
            note = "Demo data: example occupancy for this lot, not a real report"

    if ice and snow == 0 and not (report and report.source == "crew_scan"):
        snow = settings.ice_capacity_reduction_default
        snow_source = "ice-season default"

    snow_cap = round(lot.total_capacity * (1 - snow))
    # Students who checked in / out since the last report move the estimate by one car each.
    adj, checked_in = occupancy_adjustment(db, lot.id, report.created_at if report else None, now_utc)
    occupied = max(0, min(snow_cap, round(occ * snow_cap) + adj))
    available = max(0, snow_cap - occupied)
    departures = pending_departures(db, lot.id, now_utc)

    return {
        "id": lot.id, "slug": lot.slug, "name": lot.name, "kind": lot.kind,
        "description": lot.description, "lat": lot.lat, "lng": lot.lng, "polygon": lot.polygon,
        # Where a road enters the lot (OSM); apps send driving directions here. Falls back to the pin.
        "entrance": list(ENTRANCES.get(lot.slug, (lot.lat, lot.lng))),
        "total_capacity": lot.total_capacity,
        "capacity_is_seed_estimate": lot.capacity_is_seed_estimate,
        "snow_adjusted_capacity": snow_cap,
        "snow_blocked_spaces": lot.total_capacity - snow_cap,
        "snow_blocked_fraction": round(snow, 3),
        "snow_source": snow_source,
        "occupied": occupied,
        "available": available,
        "occupancy_pct": round(100 * occupied / snow_cap, 1) if snow_cap else 100.0,
        "confidence": round(conf, 2),
        "data_source": source,
        "last_update": iso(last),
        "report_expires_at": iso(expires),
        "note": note,
        "plowed_rows": report.plowed_rows if report else None,
        "unplowed_rows": report.unplowed_rows if report else None,
        "total_rows": lot.total_rows,
        "pending_departures": departures,
        "checked_in": checked_in,
        "checkin_adjustment": adj,
        "search_minutes": round(search_minutes(occ, ice, settings.ice_search_time_multiplier), 1),
        "hourly_profile": lot.hourly_profile,
        "simulated_clock": simulated,
    }


def snapshot(db: Session, lot: ParkingLot, state: SystemState) -> LotSnapshot:
    s = lot_status(db, lot, state)
    occ_frac = s["occupied"] / s["snow_adjusted_capacity"] if s["snow_adjusted_capacity"] else 1.0
    return LotSnapshot(
        slug=lot.slug, name=lot.name, kind=lot.kind, lat=lot.lat, lng=lot.lng,
        total_capacity=lot.total_capacity, occupancy_fraction=occ_frac,
        snow_blocked_fraction=s["snow_blocked_fraction"], confidence=s["confidence"],
        # Demo lots hold their demo level, so the recommendation matches what the lot list shows.
        hourly_profile=[occ_frac] * 24 if s["data_source"] == "demo" else lot.hourly_profile,
        pending_departures=s["pending_departures"],
        data_source=s["data_source"],
    )


def report_expiry() -> datetime:
    return utcnow() + timedelta(minutes=settings.parking_report_ttl_min)
