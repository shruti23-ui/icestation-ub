from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..campus import BUILDINGS, HAZARD_LOCATIONS
from ..config import DATA_DIR
from ..database import get_db
from ..models import HAZARD_CATEGORIES, CrewContribution, HazardReport, HazardVote, Notification, ParkingLot, User
from ..schemas import AssistIn, HazardClearIn, HazardVoteIn, ProfileIn
from ..services import hazards as hz
from ..services.auth import authorize_user
from ..services.crew import award, get_or_create_user, notify, serialize_notification, serialize_user
from ..services.lot_state import get_state, is_ice
from ..services.realtime import hub
from ..services.vision.pipeline import ImageError, classify_hazard_image
from ..timeutil import iso, utcnow

hazard_router = APIRouter(prefix="/api/hazards", tags=["hazards"])
crew_router = APIRouter(prefix="/api/crew", tags=["crew"])
notif_router = APIRouter(prefix="/api", tags=["notifications"])
SAMPLES_DIR = DATA_DIR / "samples"


@hazard_router.get("")
def list_hazards(db: Session = Depends(get_db)):
    return {"hazards": [hz.serialize(h) for h in hz.active_hazards(db)]}


@hazard_router.get("/routes")
def routes(destination: str = Query("Davis Hall"), db: Session = Depends(get_db)):
    """Route condition from every lot to a destination. Never reports a route as 'safe'."""
    if destination not in BUILDINGS:
        raise HTTPException(400, "Unknown destination")
    ice = is_ice(get_state(db))
    active = hz.active_hazards(db)
    dest = BUILDINGS[destination]
    return {"destination": destination, "routes": [
        {"lot": l.name, "slug": l.slug, **hz.route_status((l.lat, l.lng), dest, active, ice)}
        for l in db.scalars(select(ParkingLot).order_by(ParkingLot.id))]}


def _pin_name(lat: float, lng: float) -> str:
    """Readable name for a dropped pin: the nearest building, lot or named walkway within 250 m."""
    from ..campus import BUILDINGS, LOTS
    from ..services.geo import nearest_place
    places = ([{"name": n, "lat": la, "lng": ln} for n, (la, ln) in BUILDINGS.items()]
              + [{"name": l["name"], "lat": l["lat"], "lng": l["lng"]} for l in LOTS] + list(HAZARD_LOCATIONS))
    near = nearest_place(lat, lng, places, max_m=250)
    return f"Near {near['name']}" if near else f"Pinned spot ({lat:.5f}, {lng:.5f})"


@hazard_router.post("/report")
async def report_hazard(location_name: str | None = Form(None), category: str = Form("auto"), user_id: int | None = Form(None),
                        lat: float | None = Form(None), lng: float | None = Form(None),
                        file: UploadFile | None = File(None), sample_id: str | None = Form(None),
                        upload_id: str | None = Form(None), is_demo: bool = Form(False),
                        description: str | None = Form(None), db: Session = Depends(get_db)):
    # A dropped pin (lat/lng) is the source of truth; a listed spot name is the fallback.
    if lat is not None and lng is not None:
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HTTPException(400, "Invalid pin location.")
        location_name = (location_name or "").strip()[:120] or _pin_name(lat, lng)
    else:
        loc = next((l for l in HAZARD_LOCATIONS if l["name"] == location_name), None)
        if loc is None:
            raise HTTPException(400, "Drop a pin on the map (or pick a listed campus location).")
        lat, lng = loc["lat"], loc["lng"]
    if category != "auto" and category not in HAZARD_CATEGORIES:
        raise HTTPException(400, f"category must be 'auto' or one of {HAZARD_CATEGORIES}")

    data = None
    if sample_id:
        p = SAMPLES_DIR / f"{sample_id}.jpg"
        if not sample_id.replace("_", "").isalnum() or not p.exists():
            raise HTTPException(400, "Unknown sample image")
        data = p.read_bytes()
    elif file is not None:
        data = await file.read()
    elif upload_id:
        from ..services import uploads
        try:
            data = uploads.take(upload_id)
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, str(exc).strip("'\"")) from exc

    ai = None
    if data:
        try:
            ai = classify_hazard_image(data)
        except ImageError as exc:
            raise HTTPException(400, str(exc)) from exc
    description = (description or "").strip()[:200]
    if category == "auto" and description and not ai:
        category = hz.category_from_text(description)   # typed it instead of tapping a suggestion
    if category == "auto":
        if not ai:
            raise HTTPException(400, "Describe the hazard or pick a type.")
        if ai["category"] == "clear":
            return {"created": False, "ai": ai, "message": "The photo looks clear, so no hazard pin was created."}
        cat, conf, by, why = ai["category"], ai["confidence"], ai["classified_by"], ai["explanation"]
    else:
        cat, by = category, "reporter"
        conf = 0.7 if not ai else (min(0.9, 0.7 + 0.15 * ai["confidence"]) if ai["category"] == category else 0.6)
        why = (description or "Reported by a student.") + (f" (Photo check: {ai['category']}, {round(ai['confidence']*100)}%.)" if ai else "")

    user = db.get(User, user_id) if user_id else None
    h = HazardReport(user_id=user.id if user else None, location_name=location_name, lat=lat, lng=lng, category=cat,
                     confidence=round(conf, 2), base_confidence=round(conf, 2), classified_by=by, explanation=why,
                     image_path=(ai or {}).get("image_url", ""), expires_at=utcnow() + hz.ttl_for(cat), is_demo=is_demo)
    db.add(h)
    db.commit()
    if user:
        db.add(HazardVote(hazard_id=h.id, user_id=user.id, vote="confirm"))
        db.commit()
    pts = award(db, user, "hazard", h.id)
    extra = " Wheelchair users: treat this as a hard stop." if cat == "blocked_ramp" else ""
    notify(db, "hazard", f"{hz.CATEGORY_LABELS[cat]} at {location_name}", f"Reported by a student.{extra}", is_demo=is_demo,
           hazard_id=h.id)
    hub.publish("hazards")
    return {"created": True, "hazard": hz.serialize(h), "ai": ai, "points_awarded": pts}


def _hazard_or_404(db: Session, hid: int) -> HazardReport:
    h = db.get(HazardReport, hid)
    if not h or h.status != "active" or h.expires_at <= utcnow():
        raise HTTPException(404, "Hazard not found or no longer active")
    return h


def _vote(db: Session, h: HazardReport, user: User, vote: str) -> dict:
    existing = db.scalar(select(HazardVote).where(HazardVote.hazard_id == h.id, HazardVote.user_id == user.id))
    flipped = False
    if existing:
        # Conditions change: someone who confirmed (or reported) the ice may later see it melted.
        # Allow confirm -> clear once; repeating the same vote is still rejected.
        if existing.vote == vote or vote != "clear":
            raise HTTPException(409, "You've already voted on this report.")
        existing.vote = "clear"
        h.confirmations = max(0, h.confirmations - 1)
        flipped = True
    else:
        db.add(HazardVote(hazard_id=h.id, user_id=user.id, vote=vote))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "You've already voted on this report.")
    if vote == "confirm":
        h.confirmations += 1
        h.expires_at = utcnow() + hz.ttl_for(h.category)  # still there: restart the clock
    else:
        h.clear_votes += 1
    h.confidence = hz.vote_confidence(h.base_confidence, h.confirmations, h.clear_votes)
    cleared = vote == "clear" and hz.should_clear(h.confirmations, h.clear_votes)
    if cleared:
        h.status = "cleared"
    db.commit()
    pts = 0 if flipped else award(db, user, "verify" if vote == "confirm" else "clear", h.id)
    if cleared:
        notify(db, "hazard", f"Cleared: {h.location_name}", f"Students report the {hz.CATEGORY_LABELS[h.category].lower()} is gone.")
    hub.publish("hazards")
    return {"hazard": hz.serialize(h), "cleared": cleared, "points_awarded": pts}


@hazard_router.post("/{hazard_id}/vote")
def vote(hazard_id: int, body: HazardVoteIn, db: Session = Depends(get_db)):
    user = db.get(User, body.user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return _vote(db, _hazard_or_404(db, hazard_id), user, body.vote)


@hazard_router.post("/{hazard_id}/clear")
def clear(hazard_id: int, body: HazardClearIn, db: Session = Depends(get_db)):
    user = db.get(User, body.user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return _vote(db, _hazard_or_404(db, hazard_id), user, "clear")


# ------------------------------------------------------------------ crew

@crew_router.get("/leaderboard")
def leaderboard(limit: int = Query(10, ge=1, le=50), db: Session = Depends(get_db)):
    # Contributors only: anonymous profiles that haven't earned points yet would just pad the list.
    users = db.scalars(select(User).where(User.points > 0).order_by(User.points.desc(), User.id).limit(limit)).all()
    return {"leaderboard": [serialize_user(u, i + 1) for i, u in enumerate(users)]}


@crew_router.post("/me")
def me(request: Request, user_id: int | None = Query(None), body: ProfileIn | None = None, db: Session = Depends(get_db)):
    """Returns (creating if needed) the anonymous demo user, or the logged-in student's profile when a
    Bearer token is sent. Optional body updates preferences."""
    from ..services.auth import account_for_token, bearer
    acct = account_for_token(db, bearer(request))
    if acct:
        user_id = acct.user_id
    elif user_id is not None and body:
        authorize_user(request, db, user_id)
    u = get_or_create_user(db, user_id)
    if body:
        if body.needs_accessible_routes is not None:
            u.needs_accessible_routes = body.needs_accessible_routes
        if body.accepts_assist_requests is not None:
            u.accepts_assist_requests = body.accepts_assist_requests
        db.commit()
    rank = db.query(User).filter(User.points > u.points).count() + 1
    history = db.scalars(select(CrewContribution).where(CrewContribution.user_id == u.id)
                         .order_by(CrewContribution.created_at.desc()).limit(15)).all()
    return {**serialize_user(u, rank),
            "history": [{"action": c.action, "points": c.points, "at": iso(c.created_at)} for c in history]}


@crew_router.post("/assist")
def assist(body: AssistIn, db: Session = Depends(get_db)):
    user = db.get(User, body.user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if body.action == "respond":
        req = db.get(Notification, body.request_id) if body.request_id else None
        # Only open help requests carry a "responders" list; "X is on the way" replies are also kind=assist.
        if not req or req.kind != "assist" or "responders" not in (req.meta or {}):
            raise HTTPException(404, "Assist request not found")
        if req.expires_at is not None and req.expires_at <= utcnow():
            raise HTTPException(410, "This help request has expired.")
        if req.user_id == user.id:
            raise HTTPException(400, "You can't respond to your own request.")
        if user.handle in req.meta["responders"]:
            raise HTTPException(409, "You're already responding to this request.")
        req.meta = {**(req.meta or {}), "responders": [*(req.meta or {}).get("responders", []), user.handle]}
        db.commit()
        pts = award(db, user, "assist_help", req.id)
        notify(db, "assist", f"{user.handle} is on the way", f"Help is heading to: {req.body}", user_id=req.user_id)
        return {"ok": True, "points_awarded": pts}
    lot = db.get(ParkingLot, body.lot_id) if body.lot_id else None
    where = lot.name if lot else (body.location_note or "North Campus")
    detail = f"{where}{' · ' + body.location_note if lot and body.location_note else ''}"
    helpers = db.query(User).filter(User.accepts_assist_requests.is_(True), User.id != user.id).count()
    n = notify(db, "assist", f"{user.handle} is stuck and needs a push", detail, lot_id=lot.id if lot else None,
               user_id=user.id, ttl_min=60, responders=[])
    award(db, user, "assist_request", n.id)
    return {"ok": True, "request_id": n.id, "crew_alerted": helpers,
            "message": f"Request sent to {helpers} {'person' if helpers == 1 else 'people'} who opted in to help."}


@notif_router.get("/notifications")
def notifications(since_id: int = 0, limit: int = Query(30, ge=1, le=100), db: Session = Depends(get_db)):
    now = utcnow()
    rows = db.scalars(select(Notification).where(Notification.id > since_id).order_by(Notification.id.desc()).limit(limit)).all()
    rows = [n for n in rows if n.expires_at is None or n.expires_at > now or n.kind != "leaving"]
    return {"notifications": [serialize_notification(n) for n in rows]}
