from __future__ import annotations

import json
from datetime import timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..campus import BUILDINGS, HAZARD_LOCATIONS, OUTLINE_SOURCE
from ..config import DATA_DIR, get_settings
from ..database import get_db
from ..models import ParkingLot, ParkingRecommendation, ParkingReport, User, VehicleDetection
from ..schemas import CheckInIn, CheckOutIn, LeaveIn, LotOut, LotsOut, ReportIn, ScanOut
from ..services import geo
from ..services import sessions
from ..services.auth import authorize_user
from ..services import hazards as hz
from ..services.crew import award, notify
from ..services.lot_state import campus_now, get_state, is_ice, lot_status, report_expiry, snapshot
from ..services.realtime import hub
from ..services.recommendation import RecParams, predict_occupancy, recommend, resolve_arrival
from ..services.vision.pipeline import ImageError, analyze_parking

router = APIRouter(prefix="/api/parking", tags=["parking"])
settings = get_settings()
SAMPLES_DIR = DATA_DIR / "samples"
DISCLAIMER = ("Capacities are configurable prototype estimates and occupancy comes from student reports or a seed model. "
              "This is not live UB Parking data.")


def _lot_or_404(db: Session, lot_id: int) -> ParkingLot:
    lot = db.get(ParkingLot, lot_id)
    if not lot:
        raise HTTPException(404, f"Lot {lot_id} not found")
    return lot


@router.get("/lots", response_model=LotsOut)
def list_lots(db: Session = Depends(get_db)):
    state = get_state(db)
    lots = [lot_status(db, l, state) for l in db.scalars(select(ParkingLot).order_by(ParkingLot.id))]
    cap = sum(l["snow_adjusted_capacity"] for l in lots)
    occ = sum(l["occupied"] for l in lots)
    totals = {
        "total_capacity": sum(l["total_capacity"] for l in lots),
        "snow_adjusted_capacity": cap,
        "available": sum(l["available"] for l in lots),
        "occupied": occ,
        "occupancy_pct": round(100 * occ / cap, 1) if cap else 0,
        "snow_blocked_spaces": sum(l["snow_blocked_spaces"] for l in lots),
        "crew_reported_lots": sum(1 for l in lots if l["data_source"] not in ("seed_model",)),
    }
    return {"lots": lots, "totals": totals, "mode": state.mode, "disclaimer": DISCLAIMER}


@router.get("/lots/{lot_id}", response_model=LotOut)
def get_lot(lot_id: int, db: Session = Depends(get_db)):
    return lot_status(db, _lot_or_404(db, lot_id), get_state(db))


@router.get("/locate")
def locate(lat: float = Query(..., ge=-90, le=90), lng: float = Query(..., ge=-180, le=180),
           accuracy_m: float | None = Query(None, ge=0, le=5000), db: Session = Depends(get_db)):
    """Match a phone GPS fix to a lot outline (and the nearest named walkway spot for hazard reports).
    The client should always let the student override the match."""
    lots = list(db.scalars(select(ParkingLot).order_by(ParkingLot.id)))
    by_slug = {l.slug: l for l in lots}
    m = geo.locate_lot(lat, lng, [geo.Outline(l.slug, l.name, l.polygon) for l in lots], accuracy_m)
    lot = by_slug.get(m["key"]) if m["key"] else None
    on_campus = any(geo.haversine_m((lat, lng), (l.lat, l.lng)) < 2500 for l in lots)
    return {
        "lot": {"id": lot.id, "slug": lot.slug, "name": lot.name} if lot else None,
        "method": m["method"], "distance_m": m["distance_m"], "confidence": m["confidence"],
        "search_radius_m": m["radius_m"], "accuracy_m": accuracy_m,
        "outline_source": OUTLINE_SOURCE.get(lot.slug, "approximate_box") if lot else None,
        "candidates": [{**c, "id": by_slug[c["key"]].id} for c in m["candidates"]],
        "hazard_location": geo.nearest_place(lat, lng, HAZARD_LOCATIONS),
        "on_campus": on_campus,
    }


@router.get("/samples")
def list_samples():
    out = []
    for meta_path in sorted(SAMPLES_DIR.glob("*.json")):
        meta = json.loads(meta_path.read_text())
        out.append({"id": meta_path.stem, "title": meta["title"], "synthetic": meta.get("synthetic", True),
                    "image_url": f"/media/samples/{meta_path.stem}.jpg", "has_stall_map": True})
    if (SAMPLES_DIR / "icy_walkway.jpg").exists():
        out.append({"id": "icy_walkway", "title": "Icy walkway", "synthetic": True,
                    "image_url": "/media/samples/icy_walkway.jpg", "has_stall_map": False, "kind": "hazard"})
    return {"samples": out}


@router.post("/scan", response_model=ScanOut)
async def scan(lot_id: int = Form(...), file: UploadFile | None = File(None), sample_id: str | None = Form(None),
               upload_id: str | None = Form(None), db: Session = Depends(get_db)):
    lot = _lot_or_404(db, lot_id)
    regions = None
    if sample_id:
        if not sample_id.replace("_", "").isalnum() or not (SAMPLES_DIR / f"{sample_id}.jpg").exists():
            raise HTTPException(400, "Unknown sample image")
        data = (SAMPLES_DIR / f"{sample_id}.jpg").read_bytes()
        meta_path = SAMPLES_DIR / f"{sample_id}.json"
        regions = json.loads(meta_path.read_text()) if meta_path.exists() else None
    elif file is not None:
        data = await file.read()
    elif upload_id:
        data = _take_upload(upload_id)
    else:
        raise HTTPException(400, "Attach a photo or choose a sample image.")
    try:
        result = analyze_parking(data, lot.name, regions)
    except ImageError as exc:
        raise HTTPException(400, str(exc)) from exc

    det = VehicleDetection(
        lot_id=lot.id, provider=result["detector"], vehicles_detected=result["vehicles_detected"],
        estimated_open_spaces=result["estimated_open_spaces"], snow_blocked_spaces=result["snow_blocked_spaces"],
        plowed_rows=result["plowed_rows"], unplowed_rows=result["unplowed_rows"], confidence=result["confidence"],
        space_method=result["space_method"], boxes=result["boxes"], explanation=result["explanation"],
        raw={k: v for k, v in result.items() if k not in ("boxes",)},
        blurred_image_path=result["blurred_image_url"], annotated_image_path=result["annotated_image_url"],
        privacy_regions_blurred=result["privacy"]["regions_blurred"],
    )
    db.add(det)
    db.commit()
    return {**result, "scan_id": det.id, "lot_id": lot.id, "sample_id": sample_id,
            "sample_is_synthetic": bool(sample_id)}


@router.post("/report")
def report(body: ReportIn, db: Session = Depends(get_db)):
    lot = _lot_or_404(db, body.lot_id)
    user = db.get(User, body.user_id) if body.user_id else None
    det = None
    if body.scan_id is not None:
        det = db.get(VehicleDetection, body.scan_id)
        if not det or det.lot_id != lot.id:
            raise HTTPException(404, "Scan not found for this lot")
        if det.confirmed:
            raise HTTPException(409, "This scan has already been submitted.")
        raw = det.raw
        occ = body.occupied_spaces if body.occupied_spaces is not None else raw.get("occupied_spaces", det.vehicles_detected)
        open_ = body.open_spaces if body.open_spaces is not None else det.estimated_open_spaces
        blocked = body.snow_blocked_spaces if body.snow_blocked_spaces is not None else det.snow_blocked_spaces
        usable, stalls = occ + open_, occ + open_ + blocked
        if stalls == 0:
            raise HTTPException(400, "A report needs at least one space counted.")
        corrected = (occ, open_, blocked) != (raw.get("occupied_spaces"), det.estimated_open_spaces, det.snow_blocked_spaces)
        occ_frac = occ / usable if usable else 1.0
        snow_frac = blocked / stalls
        conf = max(det.confidence, 0.78) if corrected else det.confidence
        plowed = body.plowed_rows if body.plowed_rows is not None else det.plowed_rows
        unplowed = body.unplowed_rows if body.unplowed_rows is not None else det.unplowed_rows
        source = "crew_scan"
        note = body.note or (f"{'Corrected scan' if corrected else 'Scan'}: {occ} occupied, {open_} open"
                             + (f", {blocked} snow-blocked" if blocked else "") + " in frame")
    elif body.occupancy_pct is not None:
        occ_frac, corrected = body.occupancy_pct / 100, False
        snow_frac = min(0.9, (body.snow_blocked_spaces or 0) / lot.total_capacity)
        conf, plowed, unplowed, source = 0.55, body.plowed_rows, body.unplowed_rows, "crew_manual"
        note = body.note or f"Crew estimate: about {round(body.occupancy_pct)}% full"
    else:
        raise HTTPException(400, "Send scan_id (to confirm a scan) or occupancy_pct (manual report).")

    rep = ParkingReport(
        lot_id=lot.id, user_id=user.id if user else None, source=source, occupancy_fraction=round(min(1, occ_frac), 3),
        snow_blocked_fraction=round(min(0.95, snow_frac), 3), plowed_rows=plowed, unplowed_rows=unplowed,
        confidence=round(min(0.97, conf), 2), note=note[:200], user_corrected=corrected,
        expires_at=report_expiry(), is_demo=body.is_demo,
    )
    db.add(rep)
    db.commit()
    if det:
        det.report_id, det.confirmed = rep.id, True
        db.commit()
    pts = award(db, user, "scan" if det else "report", rep.id)
    status = lot_status(db, lot, get_state(db))
    notify(db, "scan", f"{lot.name} updated from a student report",
           f"~{status['available']} spaces estimated open ({status['occupancy_pct']}% full). Expires in {settings.parking_report_ttl_min} min.",
           lot_id=lot.id, is_demo=body.is_demo)
    hub.publish("lots")
    return {"report_id": rep.id, "lot": status, "points_awarded": pts, "corrected": corrected,
            "expires_in_minutes": settings.parking_report_ttl_min}


@router.get("/recommendations")
def recommendations(destination: str = Query("Davis Hall"), arrival: str | None = Query(None, description="HH:MM 24h"),
                    accessible: bool = False, drive_minutes: int | None = Query(None, ge=0, le=180),
                    user_id: int | None = None, db: Session = Depends(get_db)):
    result = compute_recommendation(db, destination, arrival, accessible, drive_minutes)
    db.add(ParkingRecommendation(user_id=user_id, destination=destination, arrival_time=result["arrival_time"],
                                 mode=result["mode"], best_lot_slug=(result["best"] or {}).get("slug"),
                                 backup_lot_slug=(result["backup"] or {}).get("slug"),
                                 result={k: result[k] for k in ("best", "backup", "explanation")}))
    db.commit()
    return result


def compute_recommendation(db: Session, destination: str, arrival: str | None, accessible: bool = False,
                           drive_minutes: int | None = None) -> dict:
    """Best/backup lot, per-lot ranking with route status, and a fill forecast for the best lot."""
    if destination not in BUILDINGS:
        raise HTTPException(400, f"Unknown destination. Choose one of: {', '.join(BUILDINGS)}")
    state = get_state(db)
    ice = is_ice(state)
    now, simulated = campus_now()
    arrival = arrival or (now + timedelta(minutes=30)).strftime("%H:%M")
    lots = list(db.scalars(select(ParkingLot).order_by(ParkingLot.id)))
    dest = BUILDINGS[destination]
    active = hz.active_hazards(db)
    routes = {l.slug: hz.route_status((l.lat, l.lng), dest, active, ice) for l in lots}
    params = RecParams(
        ice_season=ice, walk_speed_m_per_min=settings.walk_speed_m_per_min,
        ice_walk_speed_m_per_min=settings.ice_walk_speed_m_per_min, detour_factor=settings.walk_detour_factor,
        search_multiplier_ice=settings.ice_search_time_multiplier, ice_departure_buffer_min=settings.ice_departure_buffer_min,
        drive_minutes=drive_minutes if drive_minutes is not None else settings.default_drive_minutes,
        accessible=accessible, blocked_for_accessible={s for s, r in routes.items() if r["wheelchair_hard_stop"]},
    )
    snaps = [snapshot(db, l, state) for l in lots]
    try:
        result = recommend(snaps, destination, dest, arrival, now, params)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    for e in result["all"]:
        e["route"] = routes[e["slug"]]
    if result["best"]:
        result["best"]["route"] = routes[result["best"]["slug"]]
        arr = resolve_arrival(now, arrival)
        snap = next(s for s in snaps if s.slug == result["best"]["slug"])
        series = []
        for k in range(-6, 7):
            t = arr + timedelta(minutes=15 * k)
            series.append({"time": t.strftime("%H:%M"), "occupancy": round(predict_occupancy(snap, now, t) * 100, 1),
                           "is_arrival": k == 0})
        result["forecast"] = {"lot": snap.name, "series": series}
    if result["backup"]:
        result["backup"]["route"] = routes[result["backup"]["slug"]]
    result["simulated_clock"] = simulated
    result["now"] = now.strftime("%H:%M")
    return result


@router.post("/leave")
def leaving(body: LeaveIn, db: Session = Depends(get_db)):
    lot = _lot_or_404(db, body.lot_id)
    user = db.get(User, body.user_id) if body.user_id else None
    who = user.handle if user else "Someone"
    n = notify(db, "leaving", f"Space opening at {lot.name}", f"{who} is leaving now. A space may open in the next few minutes.",
               lot_id=lot.id, user_id=user.id if user else None, ttl_min=settings.leaving_notice_ttl_min)
    pts = award(db, user, "leaving", n.id)
    hub.publish("lots")
    return {"notification_id": n.id, "points_awarded": pts, "lot": lot_status(db, lot, get_state(db))}


# ------------------------------------------------------------------ parked / not parked

def _user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return user


@router.get("/session")
def get_session(user_id: int, request: Request, db: Session = Depends(get_db)):
    """The student's current parking session (null when not parked)."""
    authorize_user(request, db, user_id)
    s = sessions.active_session(db, _user_or_404(db, user_id).id)
    return {"session": sessions.serialize(s, db.get(ParkingLot, s.lot_id) if s else None)}


@router.post("/checkin")
def checkin(body: CheckInIn, request: Request, db: Session = Depends(get_db)):
    """Mark the student parked in a lot ("I'm parked" button or GPS auto-detect). Takes one space."""
    authorize_user(request, db, body.user_id)
    user, lot = _user_or_404(db, body.user_id), _lot_or_404(db, body.lot_id)
    s = sessions.check_in(db, user, lot, body.source, body.lat, body.lng)
    hub.publish("lots")
    return {"session": sessions.serialize(s, lot), "lot": lot_status(db, lot, get_state(db))}


@router.post("/checkout")
def checkout(body: CheckOutIn, request: Request, db: Session = Depends(get_db)):
    """Mark the student as leaving: frees the space and tells drivers heading there."""
    authorize_user(request, db, body.user_id)
    user = _user_or_404(db, body.user_id)
    s = sessions.active_session(db, user.id)
    if not s:
        raise HTTPException(409, "You're not checked in to a lot.")
    sessions.check_out(db, s, body.source)
    lot = db.get(ParkingLot, s.lot_id)
    n = notify(db, "leaving", f"Space opening at {lot.name}",
               f"{user.handle} just left{' (auto-detected)' if body.source == 'auto' else ''}. A space may be free now.",
               lot_id=lot.id, user_id=user.id, ttl_min=settings.leaving_notice_ttl_min)
    pts = award(db, user, "leaving", n.id)
    hub.publish("lots")
    return {"session": sessions.serialize(s, lot), "lot": lot_status(db, lot, get_state(db)), "points_awarded": pts}


def _take_upload(upload_id: str) -> bytes:
    from ..services import uploads
    try:
        return uploads.take(upload_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc).strip("'\"")) from exc


@router.post("/upload-chunk")
def upload_chunk(body: dict):
    """One ~48 KB base64 piece of a photo (fallback for networks that drop large uploads). Memory only."""
    from ..services import uploads
    try:
        index = int(body.get("index", 0))
        uid = uploads.add_chunk(body.get("upload_id"), index, str(body.get("data", "")))
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc).strip("'\"")) from exc
    return {"upload_id": uid, "received": index}


@router.post("/client-log")
def client_log(body: dict):
    """The app reports upload failures here so they show up in the server log (debugging phones on campus Wi-Fi)."""
    import logging
    logging.getLogger("weparkit.client").warning("client: %s", str(body.get("message", ""))[:500])
    return {"ok": True}


@router.post("/live-detect")
async def live_detect(file: UploadFile | None = File(None), upload_id: str | None = Form(None), save: bool = Form(False)):
    """Live camera frame -> labelled object boxes (0-1 coords) and whether it's a parking scene.
    The frame is analysed in memory only; nothing is stored."""
    from fastapi.concurrency import run_in_threadpool
    from ..services.vision.live import detect_live
    if file is None and not upload_id:
        raise HTTPException(400, "Send a frame.")
    data = await file.read(6 * 1024 * 1024 + 1) if file is not None else _take_upload(upload_id)
    if len(data) > 6 * 1024 * 1024:
        raise HTTPException(413, "Frame too large; send a smaller preview image.")
    try:
        return await run_in_threadpool(detect_live, data, save)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
