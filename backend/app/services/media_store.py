"""Where images live, and for how long.

Hackathon mode (default, CAPTURE_SAVE=true, MEDIA_RETENTION_HOURS=0):
  only frames the student captures with the Capture button are kept, in data/captures/<YYYY-MM-DD>/: one
  privacy-blurred, annotated JPEG plus a JSON sidecar each. Live preview frames are never saved. Nothing is deleted.
Production: CAPTURE_SAVE=false (captures stay in memory only) and MEDIA_RETENTION_HOURS=24 (or 1): an hourly
  sweep deletes anything older than that from data/captures/ and data/uploads/ (scan + hazard images).

Privacy rule kept in both modes: faces and plates are blurred before any image is written; raw frames never hit disk.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import cv2
import numpy as np

from ..config import DATA_DIR, get_settings

log = logging.getLogger(__name__)
CAPTURE_DIR = DATA_DIR / "captures"
SWEEP_DIRS = (CAPTURE_DIR, DATA_DIR / "uploads")


def save_capture(img: np.ndarray, objects: list[dict], provider: str, verdict: dict | None) -> str | None:
    """Save a privacy-blurred, annotated copy of a frame the student chose to capture (Capture button).
    Returns the path written, or None when CAPTURE_SAVE is off. Live frames are never saved on their own."""
    s = get_settings()
    if not s.capture_save:
        return None
    try:
        from .vision.base import Box
        from .vision.privacy import apply_privacy_blur
        h, w = img.shape[:2]

        def box(o: dict) -> Box:
            b = o["box"]
            return Box(int(b[0] * w), int(b[1] * h), int(b[2] * w), int(b[3] * h), o.get("label", ""), float(o.get("score") or 0.5))

        blurred, _, _ = apply_privacy_blur(img, [box(o) for o in objects if o["kind"] == "vehicle"],
                                           [box(o) for o in objects if o["kind"] == "person"])
        for o in objects:
            x1, y1, x2, y2 = (int(o["box"][0] * w), int(o["box"][1] * h), int(o["box"][2] * w), int(o["box"][3] * h))
            col = (93, 222, 74) if o["kind"] == "vehicle" else (74, 180, 245) if o["kind"] == "person" else \
                (107, 107, 255) if o["kind"] == "issue" else (235, 235, 235)
            cv2.rectangle(blurred, (x1, y1), (x2, y2), col, 2)
            label = f"{o['label']} {int(round((o.get('score') or 0) * 100))}%" if o.get("score") else o["label"]
            cv2.putText(blurred, label[:40], (x1 + 3, max(12, y1 + 13)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(blurred, label[:40], (x1 + 3, max(12, y1 + 13)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, col, 1, cv2.LINE_AA)
        local = datetime.now(ZoneInfo(s.campus_timezone))
        day = CAPTURE_DIR / local.strftime("%Y-%m-%d")
        day.mkdir(parents=True, exist_ok=True)
        stem = local.strftime("%H%M%S_%f")[:-3]
        path = day / f"{stem}.jpg"
        cv2.imwrite(str(path), blurred, [cv2.IMWRITE_JPEG_QUALITY, 80])
        (day / f"{stem}.json").write_text(json.dumps({
            "saved_at": local.isoformat(), "provider": provider, "verdict": verdict,
            "objects": [{k: o.get(k) for k in ("label", "kind", "issue", "score", "box")} for o in objects],
            "note": "Privacy-blurred live frame kept for hackathon review (CAPTURE_SAVE). Not a raw image.",
        }, indent=1), encoding="utf-8")
        return str(path)
    except Exception:  # noqa: BLE001 - saving is best-effort; never break live detection
        log.exception("capture save failed")
        return None


def sweep() -> int:
    """Delete images older than MEDIA_RETENTION_HOURS (0 = keep everything). Returns files removed."""
    hours = get_settings().media_retention_hours
    if hours <= 0:
        return 0
    cutoff = time.time() - hours * 3600
    removed = 0
    for root in SWEEP_DIRS:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.name != ".gitkeep" and p.stat().st_mtime < cutoff:
                try:
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
        for d in sorted((d for d in root.rglob("*") if d.is_dir()), reverse=True):
            try:
                d.rmdir()   # only succeeds when empty
            except OSError:
                pass
    if removed:
        log.info("media sweep: removed %d file(s) older than %s h", removed, hours)
    return removed


def stats() -> dict:
    out = {}
    for root in SWEEP_DIRS:
        files = [p for p in root.rglob("*") if p.is_file() and p.suffix == ".jpg"] if root.exists() else []
        out[root.name] = {"images": len(files), "megabytes": round(sum(p.stat().st_size for p in files) / 1e6, 1)}
    s = get_settings()
    return {**out, "capture_save": s.capture_save, "retention_hours": s.media_retention_hours}
