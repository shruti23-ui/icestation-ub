"""Hackathon capture folder + production retention sweep."""
import json
import os
import time

import cv2
import numpy as np

from app.config import get_settings
from app.services import media_store


def test_capture_saved_blurred_with_sidecar(tmp_path, monkeypatch):
    monkeypatch.setattr(media_store, "CAPTURE_DIR", tmp_path / "captures")
    monkeypatch.setattr(get_settings(), "capture_save", True)
    img = np.full((240, 320, 3), 120, np.uint8)
    objs = [{"label": "car", "kind": "vehicle", "score": 0.9, "box": [0.1, 0.1, 0.5, 0.5]}]
    p = media_store.save_capture(img, objs, "test", None)
    assert p and os.path.exists(p) and cv2.imread(p) is not None
    meta = json.loads(open(p[:-4] + ".json", encoding="utf-8").read())
    assert meta["objects"][0]["label"] == "car" and "Privacy-blurred" in meta["note"]


def test_live_frames_saved_only_on_capture(client, tmp_path, monkeypatch):
    monkeypatch.setattr(media_store, "CAPTURE_DIR", tmp_path / "captures")
    monkeypatch.setattr(get_settings(), "capture_save", True)
    ok, buf = cv2.imencode(".jpg", np.full((240, 320, 3), 120, np.uint8))
    f = lambda: {"file": ("f.jpg", buf.tobytes(), "image/jpeg")}
    assert client.post("/api/parking/live-detect", files=f()).json()["saved"] is False       # preview frame
    assert not (tmp_path / "captures").exists()
    assert client.post("/api/parking/live-detect", files=f(), data={"save": "true"}).json()["saved"] is True
    assert len(list((tmp_path / "captures").rglob("*.jpg"))) == 1


def test_capture_off_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(media_store, "CAPTURE_DIR", tmp_path / "captures")
    monkeypatch.setattr(get_settings(), "capture_save", False)
    assert media_store.save_capture(np.zeros((10, 10, 3), np.uint8), [], "t", None) is None
    assert not (tmp_path / "captures").exists()


def test_sweep_removes_only_old_files_when_retention_set(tmp_path, monkeypatch):
    s = get_settings()
    old, new = tmp_path / "uploads" / "old.jpg", tmp_path / "captures" / "d" / "new.jpg"
    for f in (old, new):
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b"x")
    t = time.time() - 3 * 3600
    os.utime(old, (t, t))
    monkeypatch.setattr(media_store, "SWEEP_DIRS", (tmp_path / "captures", tmp_path / "uploads"))
    monkeypatch.setattr(s, "media_retention_hours", 0)
    assert media_store.sweep() == 0 and old.exists()               # hackathon: keep everything
    monkeypatch.setattr(s, "media_retention_hours", 1)
    assert media_store.sweep() == 1 and not old.exists() and new.exists()
