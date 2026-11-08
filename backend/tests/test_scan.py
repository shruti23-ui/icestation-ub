

def test_live_detect_flags_a_non_parking_frame(client, monkeypatch):
    import cv2
    import numpy as np
    from app.services.vision import gemini
    monkeypatch.setattr(gemini, "available", lambda: False)      # offline: local detector path
    sky = np.full((240, 320, 3), (235, 180, 90), np.uint8)       # plain blue frame, no cars, no pavement
    ok, buf = cv2.imencode(".jpg", sky)
    r = client.post("/api/parking/live-detect", files={"file": ("f.jpg", buf.tobytes(), "image/jpeg")}).json()
    assert r["is_parking_scene"] is False and r["cars"] == 0 and "parking" in r["message"]
    assert client.post("/api/parking/live-detect", files={"file": ("f.jpg", b"nope", "image/jpeg")}).status_code == 400


def test_live_detect_parses_gemini_boxes(monkeypatch):
    import numpy as np
    from app.config import get_settings
    from app.services.vision import gemini, live
    monkeypatch.setattr(get_settings(), "live_vision_provider", "gemini")   # opt in; local OpenCV is the default
    monkeypatch.setattr(gemini, "available", lambda: True)
    monkeypatch.setattr(gemini, "_call", lambda img, prompt, **kw: {"objects": [
        {"label": "car", "box_2d": [100, 200, 400, 600]}, {"label": "empty parking space", "box_2d": [500, 100, 900, 300]},
        {"label": "tree", "box_2d": [0, 0, 50, 50]}, {"label": "bad", "box_2d": [10, 10, 5, 5]}], "is_parking_scene": True, "scene": "parking lot"})
    import cv2
    ok, buf = cv2.imencode(".jpg", np.zeros((100, 100, 3), np.uint8))
    r = live.detect_live(buf.tobytes())
    assert r["cars"] == 1 and r["spaces"] == 1 and r["is_parking_scene"] and r["message"] is None
    assert r["objects"][0]["box"] == [0.2, 0.1, 0.6, 0.4] and len(r["objects"]) == 3


def test_chunked_upload_then_scan(client):
    import base64
    from pathlib import Path
    data = Path("data/samples/jarvis_a_winter.jpg").read_bytes()
    b64 = base64.b64encode(data).decode()
    size = 48 * 1024
    pieces = [b64[i:i + size] for i in range(0, len(b64), size)]
    # base64 pieces must decode independently: split on 4-char boundaries
    assert size % 4 == 0
    uid = None
    for i, p in enumerate(pieces):
        uid = client.post("/api/parking/upload-chunk", json={"upload_id": uid, "index": i, "data": p}).json()["upload_id"]
    r = client.post("/api/parking/scan", data={"lot_id": 1, "upload_id": uid})
    assert r.status_code == 200 and r.json()["vehicles_detected"] > 0
    # one use only
    assert client.post("/api/parking/scan", data={"lot_id": 1, "upload_id": uid}).status_code == 400
    assert client.post("/api/parking/client-log", json={"message": "test"}).json()["ok"]
