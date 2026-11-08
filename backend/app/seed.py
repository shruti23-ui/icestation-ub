"""Database initialisation, seeding and demo reset."""
from __future__ import annotations

from sqlalchemy.orm import Session

from datetime import timedelta

from .campus import DEMO_USERS, HAZARD_LOCATIONS, LOTS
from .config import get_settings
from .database import Base, SessionLocal, engine
from .models import HazardReport, ParkingLot, SystemState, User
from .timeutil import utcnow
from .services import weather


def create_all() -> None:
    Base.metadata.create_all(bind=engine)


def seed(db: Session) -> None:
    # Lot definitions are configuration (app/ub_lots.json via campus.py), not user data: insert lots an
    # existing DB doesn't have yet and keep every configured field in sync. Reports, scans and sessions
    # reference lots by id, which never changes for an existing slug.
    existing = {lot.slug: lot for lot in db.query(ParkingLot)}
    for cfg in LOTS:
        lot = existing.get(cfg["slug"])
        if lot is None:
            db.add(ParkingLot(**cfg))
            continue
        for key, value in cfg.items():
            if getattr(lot, key) != value:
                setattr(lot, key, value)
    if not db.query(User).filter(User.is_seed.is_(True)).count():
        for handle, pts, reports, verified in DEMO_USERS:
            db.add(User(handle=handle, is_anonymous=False, is_seed=True, points=pts,
                        reports_submitted=reports, hazards_verified=verified))
    if db.get(SystemState, 1) is None:
        db.add(SystemState(id=1))
    db.commit()
    ensure_demo_hazards(db)


DEMO_HAZARDS = [
    ("Jarvis A to Davis Hall walkway", "ice", 0.75, "Demo report: glazed ice on the walkway, example data for the demo."),
    ("Capen Hall ramp", "blocked_ramp", 0.8, "Demo report: plow pile blocking the curb ramp, example data for the demo."),
]


def ensure_demo_hazards(db: Session) -> None:
    """Two labelled example reports so the Reports tab is never empty in a demo (DEMO_HAZARDS)."""
    if not get_settings().demo_hazards:
        return
    now = utcnow()
    active = db.query(HazardReport).filter(HazardReport.is_demo.is_(True), HazardReport.status == "active",
                                          HazardReport.expires_at > now).count()
    if active:
        return
    spots = {h["name"]: h for h in HAZARD_LOCATIONS}
    for name, cat, conf, why in DEMO_HAZARDS:
        s = spots[name]
        db.add(HazardReport(user_id=None, location_name=name, lat=s["lat"], lng=s["lng"], category=cat, confidence=conf,
                            base_confidence=conf, classified_by="reporter", explanation=why, image_path="",
                            expires_at=now + timedelta(hours=12), is_demo=True))
    db.commit()


def reset(db: Session | None = None) -> None:
    """Drops every table, recreates and reseeds. Used by RESET DEMO and init_db --reset."""
    own = db is None
    db = db or SessionLocal()
    try:
        db.close()
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        seed(db)
        weather.clear_demo()
    finally:
        if own:
            db.close()


def init() -> None:
    create_all()
    with SessionLocal() as db:
        seed(db)
