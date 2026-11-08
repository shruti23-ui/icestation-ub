"""Live camera detection for the Scan tab: labelled boxes for what's in frame, plus "is this a parking scene?".

Frames are analysed in memory and never written to disk (privacy rule: raw images never touch disk).
Providers, best first:
  gemini  object detection with normalised boxes (needs GEMINI_API_KEY)
  yolo    COCO object detection (needs ultralytics + weights)
  opencv  classical fallback: car-shaped blobs + how much of the frame is pavement/snow (heuristic, labelled)
"""
from __future__ import annotations

import time

import cv2
import numpy as np

from . import gemini
from ...config import get_settings
from .detectors import surface_masks
from . import coco
from .issues import METHOD as ISSUES_METHOD, detect_issues

LIVE_SIDE = 640  # frames are downscaled before detection: faster, and plenty for boxes
VEHICLES = {"car", "truck", "suv", "van", "bus", "motorcycle", "pickup truck", "vehicle", "jeep", "minivan"}
SPACE_WORDS = ("parking space", "parking spot", "empty space", "empty stall", "parking stall", "stall")
PARKING_WORDS = ("parking", "lot", "stall", "garage")

LIVE_PROMPT = """You are the live camera of a campus parking app. Detect the main objects in this frame.
Return ONLY JSON:
{"objects": [{"label": "<short noun, e.g. car, truck, empty parking space, person, tree, building, sign>",
              "box_2d": [ymin, xmin, ymax, xmax]}],
 "is_parking_scene": <true if the frame shows a parking lot, parked cars, or parking spaces>,
 "scene": "<3-6 word description of the scene>"}
box_2d values are integers 0-1000 normalised to the image. At most 15 objects, most important first.
Label empty, usable parking stalls as "empty parking space"."""


def _kind(label: str) -> str:
    l = label.lower()
    if l in VEHICLES or any(v in l for v in ("car", "truck", "vehicle", "van", "suv")):
        return "vehicle"
    if any(w in l for w in SPACE_WORDS):
        return "space"
    if "person" in l or "people" in l or "pedestrian" in l:
        return "person"
    return "other"


def decode_frame(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if data else None
    if img is None:
        raise ValueError("That frame isn't a readable image.")
    h, w = img.shape[:2]
    s = min(1.0, LIVE_SIDE / max(h, w))
    return cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img


def _result(objects: list[dict], is_parking: bool, scene: str, provider: str, started: float) -> dict:
    cars = sum(o["kind"] == "vehicle" for o in objects)
    spaces = sum(o["kind"] == "space" for o in objects)
    ok = is_parking or cars > 0 or spaces > 0
    return {
        "objects": objects, "cars": cars, "spaces": spaces, "is_parking_scene": ok, "scene": scene,
        "message": None if ok else "This doesn't look like a car or a parking space. Point the camera at a parking lot.",
        "provider": provider, "latency_ms": int((time.perf_counter() - started) * 1000),
    }


def _gemini(img: np.ndarray, started: float) -> dict | None:
    # Live preview: minimal thinking + lighter JPEG takes a frame from ~6 s to ~4 s.
    out = gemini._call(img, LIVE_PROMPT, thinking="minimal", quality=70)
    if not isinstance(out, dict) or not isinstance(out.get("objects"), list):
        return None
    objs = []
    for o in out["objects"][:15]:
        try:
            y1, x1, y2, x2 = (max(0.0, min(1.0, float(v) / 1000)) for v in o["box_2d"])
        except Exception:
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        label = str(o.get("label", "object"))[:40]
        objs.append({"label": label, "kind": _kind(label), "box": [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)], "score": None})
    scene = str(out.get("scene", ""))[:60]
    parking = bool(out.get("is_parking_scene")) or any(w in scene.lower() for w in PARKING_WORDS)
    return _result(objs, parking, scene, "Gemini object detection", started)


def _local(img: np.ndarray, started: float) -> dict:
    """Local path. 1) A pre-trained general detector (YOLOv4-tiny, COCO) names everyday objects: "car 91%",
    "person 78%", "bed 85%". 2) Only when the frame looks like a parking scene do the OpenCV issue heuristics add
    snow / ice / water / cone / object boxes, so a bedsheet is a "bed", not "snow"."""
    h, w = img.shape[:2]
    objs = [{**o, "label": o["label"]} for o in coco.detect(img)]
    general = coco.available()
    asphalt, snow = surface_masks(img)
    pavement = float(np.count_nonzero(asphalt | snow)) / (h * w)
    vehicles = any(o["kind"] == "vehicle" for o in objs)
    indoor = any(o["label"] in coco.INDOOR for o in objs)
    # Parking scene: the model sees a vehicle, or (with no indoor objects) the frame is mostly pavement/snow.
    parking = vehicles or (not indoor and pavement > (0.6 if general else 0.35))
    verdict = None
    if parking:
        r = detect_issues(img)
        verdict = r["verdict"]
        for i in r["issues"]:
            if i["kind"] == "vehicle" and general:
                continue   # the trained model already boxes cars; skip the heuristic duplicates
            objs.append({"label": f"{i['label']}{' · ' + i['detail'] if i['detail'] else ''}",
                         "kind": "vehicle" if i["kind"] == "vehicle" else "issue", "issue": i["kind"], "box": i["box"], "score": i["score"]})
    name = (f"{coco.NAME} on {coco.device}" + (" + OpenCV issue checks" if parking else "")) if general else ISSUES_METHOD
    out = _result(objs, parking, (verdict or {}).get("headline", ""), name, started)
    out["verdict"] = verdict
    return out


def detect_live(data: bytes, save: bool = False) -> dict:
    """save=True only when the student taps Capture: keeps a privacy-blurred, annotated copy (CAPTURE_SAVE)."""
    started = time.perf_counter()
    img = decode_frame(data)
    r = None
    if get_settings().live_vision_provider.lower() == "gemini" and gemini.available():
        r = _gemini(img, started)
    if r is None:
        r = _local(img, started)
    r["saved"] = False
    if save:
        from ..media_store import save_capture
        r["saved"] = save_capture(img, r["objects"], r["provider"], r.get("verdict")) is not None
    return r
