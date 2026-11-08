def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_lots_and_detail(client):
    lots = client.get("/api/parking/lots").json()
    from app.campus import LOTS
    assert len(lots["lots"]) == len(LOTS) >= 30 and "not live UB Parking data" in lots["disclaimer"]
    lot = lots["lots"][0]
    assert lot["available"] == lot["snow_adjusted_capacity"] - lot["occupied"]
    assert client.get(f"/api/parking/lots/{lot['id']}").status_code == 200
    assert client.get("/api/parking/lots/999").status_code == 404


def test_scan_confirm_updates_lot(client):
    lot_id = client.get("/api/parking/lots").json()["lots"][0]["id"]
    scan = client.post("/api/parking/scan", data={"lot_id": lot_id, "sample_id": "jarvis_a_winter"}).json()
    assert scan["vehicles_detected"] > 0 and scan["space_method"] == "calibrated_regions"
    assert scan["estimated_open_spaces"] != scan["vehicles_detected"]
    me = client.post("/api/crew/me").json()
    rep = client.post("/api/parking/report", json={"lot_id": lot_id, "scan_id": scan["scan_id"], "user_id": me["id"]}).json()
    assert rep["lot"]["data_source"] == "crew_scan"
    assert rep["lot"]["snow_blocked_spaces"] > 0
    assert rep["points_awarded"] == 30
    again = client.post("/api/parking/report", json={"lot_id": lot_id, "scan_id": scan["scan_id"], "user_id": me["id"]})
    assert again.status_code == 409  # one scan, one report: no double points



def test_scan_correction(client):
    lot_id = client.get("/api/parking/lots").json()["lots"][1]["id"]
    scan = client.post("/api/parking/scan", data={"lot_id": lot_id, "sample_id": "hochstetter_b_busy"}).json()
    rep = client.post("/api/parking/report", json={"lot_id": lot_id, "scan_id": scan["scan_id"],
                                                   "occupied_spaces": 10, "open_spaces": 30, "snow_blocked_spaces": 0}).json()
    # 10 of 40 stalls in frame = 25 %, applied to the whole lot and rounded to whole cars
    cap = rep["lot"]["snow_adjusted_capacity"]
    assert rep["corrected"] and abs(rep["lot"]["occupancy_pct"] - 25.0) <= 100 / cap


def test_scan_rejects_bad_upload(client):
    r = client.post("/api/parking/scan", data={"lot_id": 1}, files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400


def test_recommendations(client):
    r = client.get("/api/parking/recommendations", params={"destination": "Davis Hall", "arrival": "10:00"})
    body = r.json()
    assert r.status_code == 200 and body["best"] and body["forecast"]["series"]
    assert client.get("/api/parking/recommendations", params={"destination": "Nowhere"}).status_code == 400


def test_demo_storm_triggers_ice_and_reduces_capacity(client):
    before = client.get("/api/parking/lots").json()["totals"]["snow_adjusted_capacity"]
    res = client.post("/api/satellite/demo-storm").json()
    assert res["is_simulated"] and res["track"]["band_detected"]
    assert res["track"]["moving_toward_buffalo"] and res["track"]["eta_minutes"] <= 60
    assert res["state"]["mode"] == "ice" and res["state"]["decision_source"] == "demo_storm_replay"
    after = client.get("/api/parking/lots").json()["totals"]["snow_adjusted_capacity"]
    assert after < before


def test_analyze_falls_back_to_labelled_simulation(client):
    res = client.post("/api/satellite/analyze").json()
    assert res["source"] == "simulated" and res["live_source_status"]
    assert res["state"]["mode"] == "standard"


def test_manual_override_is_distinguishable(client):
    s = client.post("/api/state/mode", json={"mode": "ice"}).json()
    assert s["mode"] == "ice" and s["decision_source"] == "manual_override"
    s = client.post("/api/state/mode", json={"mode": None}).json()
    assert s["mode"] == "standard"


def test_hazard_lifecycle(client):
    u1 = client.post("/api/crew/me").json()["id"]
    u2 = client.post("/api/crew/me").json()["id"]
    r = client.post("/api/hazards/report", data={"location_name": "Capen Hall ramp", "category": "auto",
                                                 "sample_id": "icy_walkway", "user_id": u1}).json()
    assert r["created"] and r["hazard"]["category"] == "ice" and 350 <= r["hazard"]["minutes_left"] <= 360
    hid = r["hazard"]["id"]
    v = client.post(f"/api/hazards/{hid}/vote", json={"user_id": u2, "vote": "confirm"}).json()
    assert v["hazard"]["confirmations"] == 2 and v["hazard"]["confidence"] > r["hazard"]["confidence"]
    assert client.post(f"/api/hazards/{hid}/vote", json={"user_id": u2, "vote": "confirm"}).status_code == 409
    u3 = client.post("/api/crew/me").json()["id"]
    c = client.post(f"/api/hazards/{hid}/clear", json={"user_id": u3}).json()
    assert c["cleared"]
    assert client.get("/api/hazards").json()["hazards"] == []


def test_clearing_override_restores_engine_reason(client):
    auto = client.post("/api/satellite/demo-storm").json()["state"]
    on = client.post("/api/state/mode", json={"mode": "standard"}).json()
    assert on["decision_source"] == "manual_override" and "Manual" in on["reason"]
    off = client.post("/api/state/mode", json={"mode": None}).json()
    assert off["decision_source"] == "demo_storm_replay" and "Manual" not in off["reason"]
    assert off["reason"] == auto["reason"]


def test_locate_endpoint(client):
    lot = client.get("/api/parking/lots").json()["lots"][0]
    r = client.get("/api/parking/locate", params={"lat": lot["lat"], "lng": lot["lng"], "accuracy_m": 8}).json()
    assert r["lot"]["id"] == lot["id"] and r["method"] == "inside_outline" and r["on_campus"]
    far = client.get("/api/parking/locate", params={"lat": 40.7128, "lng": -74.006}).json()
    assert far["lot"] is None and not far["on_campus"] and far["hazard_location"] is None
    assert client.get("/api/parking/locate", params={"lat": 999, "lng": 0}).status_code == 422


def test_reporter_can_mark_own_hazard_clear(client):
    u = client.post("/api/crew/me").json()["id"]
    hid = client.post("/api/hazards/report", data={"location_name": "Knox Hall plaza", "category": "ice",
                                                   "user_id": u}).json()["hazard"]["id"]
    pts_before = client.post(f"/api/crew/me?user_id={u}").json()["points"]
    c = client.post(f"/api/hazards/{hid}/clear", json={"user_id": u})
    assert c.status_code == 200 and c.json()["cleared"] and c.json()["points_awarded"] == 0
    assert client.post(f"/api/crew/me?user_id={u}").json()["points"] == pts_before


def test_blocked_ramp_is_hard_stop(client):
    u = client.post("/api/crew/me").json()["id"]
    client.post("/api/hazards/report", data={"location_name": "Jarvis A to Davis Hall walkway",
                                             "category": "blocked_ramp", "user_id": u})
    routes = client.get("/api/hazards/routes", params={"destination": "Davis Hall"}).json()["routes"]
    jarvis = next(x for x in routes if x["slug"] == "jarvis-a")
    assert jarvis["status"] == "blocked" and jarvis["wheelchair_hard_stop"]
    assert all(x["status"] != "safe" for x in routes)
    rec = client.get("/api/parking/recommendations", params={"destination": "Davis Hall", "accessible": True}).json()
    assert rec["best"]["slug"] != "jarvis-a"


def test_leave_and_assist_and_notifications(client):
    u = client.post("/api/crew/me").json()["id"]
    helper = client.post("/api/crew/me").json()["id"]
    assert client.post("/api/parking/leave", json={"lot_id": 1, "user_id": u}).json()["lot"]["pending_departures"] == 1
    a = client.post("/api/crew/assist", json={"user_id": u, "lot_id": 2}).json()
    assert a["crew_alerted"] >= 1
    resp = client.post("/api/crew/assist", json={"user_id": helper, "action": "respond", "request_id": a["request_id"]})
    assert resp.json()["points_awarded"] == 20
    dup = client.post("/api/crew/assist", json={"user_id": helper, "action": "respond", "request_id": a["request_id"]})
    assert dup.status_code == 409
    feed = client.get("/api/notifications").json()["notifications"]
    on_the_way = next(n for n in feed if n["kind"] == "assist" and n["id"] != a["request_id"])
    assert client.post("/api/crew/assist", json={"user_id": u, "action": "respond",
                                                 "request_id": on_the_way["id"]}).status_code == 404
    assert next(n for n in feed if n["id"] == a["request_id"])["user_id"] == u
    kinds = {n["kind"] for n in client.get("/api/notifications").json()["notifications"]}
    assert {"leaving", "assist"} <= kinds
    board = client.get("/api/crew/leaderboard").json()["leaderboard"]
    assert board[0]["points"] >= board[-1]["points"]


def test_report_expiry(client):
    from datetime import timedelta
    from app.database import SessionLocal
    from app.models import ParkingReport
    client.post("/api/parking/report", json={"lot_id": 1, "occupancy_pct": 99})
    assert client.get("/api/parking/lots/1").json()["data_source"] == "crew_manual"
    with SessionLocal() as db:
        for r in db.query(ParkingReport).all():
            r.expires_at = r.created_at - timedelta(minutes=1)
        db.commit()
    assert client.get("/api/parking/lots/1").json()["data_source"] == "seed_model"


def test_reset(client):
    client.post("/api/state/mode", json={"mode": "ice"})
    assert client.post("/api/demo/reset").json()["ok"]
    assert client.get("/api/state").json()["mode"] == "standard"


def test_expire_hazards_reports_changes(client):
    from datetime import timedelta
    from app.database import SessionLocal
    from app.models import HazardReport
    from app.services.hazards import expire_hazards
    client.post("/api/hazards/report", data={"location_name": "Jarvis A to Davis Hall walkway", "category": "ice"})
    with SessionLocal() as db:
        assert expire_hazards(db) == 0
        for h in db.query(HazardReport).all():
            h.expires_at = h.created_at - timedelta(minutes=1)
        db.commit()
        assert expire_hazards(db) == 1
        assert expire_hazards(db) == 0
    assert client.get("/api/hazards").json()["hazards"] == []


def test_hazard_report_from_dropped_pin_is_named_and_listed(client):
    from app.campus import BUILDINGS
    lat, lng = BUILDINGS["Capen Hall"]
    r = client.post("/api/hazards/report", data={"lat": lat + 0.0002, "lng": lng, "category": "ice"}).json()
    assert r["created"] and r["hazard"]["location_name"] == "Near Capen Hall"
    assert abs(r["hazard"]["lat"] - (lat + 0.0002)) < 1e-6        # the pin itself, not a snapped spot
    assert any(h["id"] == r["hazard"]["id"] for h in client.get("/api/hazards").json()["hazards"])
    assert client.post("/api/hazards/report", data={"category": "ice"}).status_code == 400   # no pin, no place


def test_demo_hazards_seeded_once_and_labelled(client, monkeypatch):
    from app.config import get_settings
    from app.database import SessionLocal
    from app.seed import ensure_demo_hazards
    monkeypatch.setattr(get_settings(), "demo_hazards", True)
    with SessionLocal() as db:
        ensure_demo_hazards(db)
        ensure_demo_hazards(db)          # idempotent while they're active
    demo = [h for h in client.get("/api/hazards").json()["hazards"] if h["is_demo"]]
    assert len(demo) == 2 and {h["category"] for h in demo} == {"ice", "blocked_ramp"}


def test_typed_hazard_description_sets_category_and_is_shown(client):
    from app.services.hazards import category_from_text
    assert category_from_text("Black ice by the stairs") == "ice"
    assert category_from_text("plow pile blocking the curb ramp") == "blocked_ramp"
    assert category_from_text("fallen branch on path") == "other"
    r = client.post("/api/hazards/report", data={"lat": 43.0009, "lng": -78.7893, "category": "auto",
                                                 "description": "Fallen branch across the path"}).json()
    assert r["created"] and r["hazard"]["category"] == "other" and r["hazard"]["category_label"] == "Other hazard"
    assert r["hazard"]["explanation"] == "Fallen branch across the path"
