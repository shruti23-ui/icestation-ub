"""Local OpenCV issue detector: finds what makes a space unusable, on synthetic scenes."""
import cv2
import numpy as np

from app.services.vision.issues import detect_issues


def asphalt(w=640, h=480):
    rng = np.random.default_rng(1)
    img = np.full((h, w, 3), 95, np.uint8)
    img = cv2.add(img, rng.integers(0, 25, (h, w, 3), dtype=np.uint8))   # rough asphalt texture
    for x in range(60, w, 120):                                          # white stall lines
        cv2.line(img, (x, 40), (x, h - 40), (235, 235, 235), 3)
    return img


def kinds(r):
    return {i["kind"] for i in r["issues"]}


def test_clear_asphalt_is_usable():
    r = detect_issues(asphalt())
    assert r["verdict"]["usable"] and "usable" in r["verdict"]["headline"].lower()
    assert not kinds(r) & {"snow", "ice", "water", "cone"}


def test_snow_is_not_reported():
    """Snow detection was removed: a bright white patch is not an issue."""
    img = asphalt()
    cv2.ellipse(img, (320, 300), (150, 90), 0, 0, 360, (245, 248, 250), -1)
    r = detect_issues(img)
    assert "snow" not in kinds(r) and "snow" not in r["verdict"]["headline"].lower()


def test_cone_closes_space():
    img = asphalt()
    pts = np.array([[300, 380], [340, 380], [320, 250]], np.int32)
    cv2.fillPoly(img, [pts], (0, 110, 255))             # orange cone (BGR)
    r = detect_issues(img)
    assert "cone" in kinds(r) and any("cone" in t for t in r["verdict"]["reasons"])


def test_puddle_flagged_as_water_or_black_ice():
    img = asphalt()
    cv2.ellipse(img, (200, 330), (120, 60), 0, 0, 360, (38, 36, 34), -1)
    r = detect_issues(img)
    assert "water" in kinds(r) and r["verdict"]["blocked"]


def test_live_endpoint_uses_local_detector_and_returns_verdict(client):
    img = asphalt()
    pts = np.array([[300, 380], [340, 380], [320, 250]], np.int32)
    cv2.fillPoly(img, [pts], (0, 110, 255))
    ok, buf = cv2.imencode(".jpg", img)
    r = client.post("/api/parking/live-detect", files={"file": ("f.jpg", buf.tobytes(), "image/jpeg")}).json()
    assert "OpenCV" in r["provider"] and r["verdict"]["blocked"] and r["latency_ms"] < 2000
    assert any(o["kind"] == "issue" and o["issue"] == "cone" for o in r["objects"])


def test_cluttered_object_flagged_as_in_the_way():
    img = asphalt()
    x0, y0 = 250, 230
    cv2.rectangle(img, (x0, y0), (x0 + 140, y0 + 120), (150, 150, 150), -1)
    for k in range(0, 140, 10):                       # wire-basket / debris texture: dense edges
        cv2.line(img, (x0 + k, y0), (x0 + k, y0 + 120), (30, 30, 30), 2)
    for k in range(0, 120, 10):
        cv2.line(img, (x0, y0 + k), (x0 + 140, y0 + k), (30, 30, 30), 2)
    r = detect_issues(img)
    assert "object" in kinds(r) and r["verdict"]["blocked"]


def test_indoor_scene_gets_object_names_not_parking_issues(monkeypatch):
    """A bed with grey sheets must be labelled 'bed', not snow / water / cone."""
    from app.services.vision import coco, live
    monkeypatch.setattr(coco, "available", lambda: True)
    monkeypatch.setattr(coco, "detect", lambda img, conf=0.3: [
        {"label": "bed", "kind": "other", "score": 0.86, "box": [0.05, 0.2, 0.95, 0.9]}])
    img = asphalt()
    cv2.ellipse(img, (320, 300), (150, 90), 0, 0, 360, (245, 248, 250), -1)   # would be "snow" in a lot
    ok, buf = cv2.imencode(".jpg", img)
    r = live.detect_live(buf.tobytes())
    assert [o["label"] for o in r["objects"]] == ["bed"] and r["is_parking_scene"] is False and r["verdict"] is None


def test_parking_scene_with_model_car_adds_issue_boxes(monkeypatch):
    from app.services.vision import coco, live
    monkeypatch.setattr(coco, "available", lambda: True)
    monkeypatch.setattr(coco, "detect", lambda img, conf=0.3: [
        {"label": "car", "kind": "vehicle", "score": 0.91, "box": [0.1, 0.1, 0.3, 0.3]}])
    img = asphalt()
    pts = np.array([[300, 380], [340, 380], [320, 250]], np.int32)
    cv2.fillPoly(img, [pts], (0, 110, 255))
    ok, buf = cv2.imencode(".jpg", img)
    r = live.detect_live(buf.tobytes())
    labels = [o["label"] for o in r["objects"]]
    assert labels[0] == "car" and any(l.startswith("Cone") for l in labels) and r["verdict"]["blocked"]
    assert sum(o["kind"] == "vehicle" for o in r["objects"]) == 1     # no heuristic duplicate of the car
