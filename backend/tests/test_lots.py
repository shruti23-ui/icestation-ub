from app.campus import LOTS, OSM_ATTRIBUTION


def test_all_ub_lots_from_osm():
    names = {l["name"] for l in LOTS}
    assert len(LOTS) >= 30
    assert {"Jarvis A", "Jarvis B", "Governors A", "Governors C", "Ketter Lot", "Fronczak A", "Center for Tomorrow"} <= names
    # nearby non-UB properties are excluded (no operator=University at Buffalo in OSM)
    assert not names & {"Beane Lot", "Crofts Lot", "Helm Lot", "Kenefic Place"}
    assert "OpenStreetMap" in OSM_ATTRIBUTION
    # the original four keep their slugs and come first, so their DB ids (1-4) never change
    assert [l["slug"] for l in LOTS[:4]] == ["jarvis-a", "hochstetter-b", "center-for-tomorrow", "stadium"]
    assert len({l["slug"] for l in LOTS}) == len(LOTS)


def test_capacities_tiered_small_mid_big_by_lot_size():
    import json
    from collections import Counter
    from pathlib import Path
    caps = {l["slug"]: l["total_capacity"] for l in LOTS}
    counts = Counter(caps.values())
    assert set(counts) == {56, 116, 300}                                      # project setting: small / mid / big
    assert max(counts.values()) - min(counts.values()) <= 1                   # equal thirds by size rank
    raw = {l["slug"]: l["total_capacity"] for l in json.loads(Path("app/ub_lots.json").read_text())["lots"]}
    for a in raw:                                                             # a bigger lot never gets fewer spaces
        for b in raw:
            if raw[a] > raw[b]:
                assert caps[a] >= caps[b], (a, b)
    assert all(l["capacity_is_seed_estimate"] for l in LOTS)                  # nothing here is official UB data
    assert all(l["total_rows"] >= 1 for l in LOTS)


def test_sync_adds_new_lots_to_an_existing_db_without_renumbering(client):
    from app.database import SessionLocal
    from app.models import ParkingLot
    from app.seed import seed
    with SessionLocal() as db:
        # simulate a pre-import database: only the original four lots, with old seed capacities
        for lot in db.query(ParkingLot).filter(ParkingLot.id > 4):
            db.delete(lot)
        db.get(ParkingLot, 1).total_capacity = 220
        db.commit()
        seed(db)
        lots = db.query(ParkingLot).order_by(ParkingLot.id).all()
        assert len(lots) == len(LOTS)
        assert [l.slug for l in lots[:4]] == ["jarvis-a", "hochstetter-b", "center-for-tomorrow", "stadium"]
        assert lots[0].total_capacity == LOTS[0]["total_capacity"]  # config wins over stale DB values
    assert client.get("/api/parking/lots").json()["totals"]["total_capacity"] == sum(l["total_capacity"] for l in LOTS)


def test_nearest_lot_detection_uses_real_outlines(client):
    # Standing in the real Governors A lot (south of White Rd), per UB's Wayfinder map
    gov_a = next(l for l in LOTS if l["name"] == "Governors A")
    r = client.get("/api/parking/locate", params={"lat": gov_a["lat"], "lng": gov_a["lng"], "accuracy_m": 15}).json()
    assert r["lot"]["name"] == "Governors A" and r["method"] == "inside_outline"


def test_demo_full_lots_are_full_and_labelled(client, monkeypatch):
    from app.services import lot_state
    monkeypatch.setattr(lot_state.settings, "demo_full_lots", "jarvis-a,ketter-lot")
    lots = {l["slug"]: l for l in client.get("/api/parking/lots").json()["lots"]}
    for slug in ("jarvis-a", "ketter-lot"):
        assert lots[slug]["available"] == 0 and lots[slug]["data_source"] == "demo" and "Demo data" in lots[slug]["note"]
    assert lots["hochstetter-b"]["data_source"] == "seed_model"
    # the recommendation avoids a full lot
    rec = client.get("/api/parking/recommendations", params={"destination": "Davis Hall"}).json()
    assert rec["best"]["slug"] not in ("jarvis-a", "ketter-lot")
    # a real student report replaces the demo state
    client.post("/api/parking/report", json={"lot_id": 1, "occupancy_pct": 40})
    assert client.get("/api/parking/lots/1").json()["data_source"] == "crew_manual"


def test_every_lot_has_a_road_entrance_on_its_outline(client):
    """Directions go to where a mapped road enters the lot, not the centre pin."""
    from app.campus import ENTRANCES
    from app.services.geo import distance_to_polygon_m, haversine_m
    assert len(ENTRANCES) == len(LOTS)
    for lot in client.get("/api/parking/lots").json()["lots"]:
        e = lot["entrance"]
        assert distance_to_polygon_m(e[0], e[1], lot["polygon"]) < 2, lot["name"]        # on the outline
        assert haversine_m((e[0], e[1]), (lot["lat"], lot["lng"])) < 400, lot["name"]   # and at this lot


def test_demo_occupancy_spread_varies_lots_and_is_labelled(client, monkeypatch):
    from app.services import lot_state
    monkeypatch.setattr(lot_state.settings, "demo_occupancy_spread", True)
    lots = client.get("/api/parking/lots").json()["lots"]
    pcts = {round(l["occupancy_pct"]) for l in lots}
    assert len(pcts) >= 10                                   # lots differ from each other
    for l in lots:
        if l["data_source"] == "demo":
            assert "Demo data" in l["note"] and 12 <= l["occupancy_pct"] <= 100
    assert lot_state.demo_occupancy("jarvis-b") == lot_state.demo_occupancy("jarvis-b")  # stable per lot


def test_recommendation_matches_demo_lot_numbers(client, monkeypatch):
    from app.services import lot_state
    monkeypatch.setattr(lot_state.settings, "demo_occupancy_spread", True)
    lots = {l["slug"]: l for l in client.get("/api/parking/lots").json()["lots"]}
    rec = client.get("/api/parking/recommendations", params={"destination": "Davis Hall"}).json()
    for e in rec["all"]:
        lot = lots[e["slug"]]
        if lot["data_source"] == "demo":
            assert abs(e["expected_open_spaces"] - lot["available"]) <= 3, e["name"]
