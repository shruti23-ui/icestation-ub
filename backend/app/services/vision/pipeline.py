"""Orchestrates detection -> privacy blur -> space estimation -> (Gemini) -> annotation."""
from __future__ import annotations

import uuid

import cv2
import numpy as np

from ...config import DATA_DIR
from . import gemini
from .base import Box
from .detectors import get_detector, surface_masks
from .issues import detect_issues
from .privacy import apply_privacy_blur
from .spaces import estimate_by_area, estimate_with_regions, snow_cover_fraction

UPLOAD_DIR = DATA_DIR / "uploads"
MAX_SIDE = 1024
CYAN, ORANGE, WHITE = (242, 225, 93), (69, 154, 255), (245, 245, 245)


class ImageError(ValueError):
    pass


def decode_image(data: bytes) -> tuple[np.ndarray, float]:
    if not data:
        raise ImageError("Empty upload. Choose a JPG or PNG photo.")
    if len(data) > 15 * 1024 * 1024:
        raise ImageError("Photo is larger than 15 MB. Use a smaller image.")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ImageError("That file isn't a readable image. Upload a JPG or PNG.")
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img, scale


def _save(img: np.ndarray, suffix: str) -> str:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex[:12]}_{suffix}.jpg"
    cv2.imwrite(str(UPLOAD_DIR / name), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return f"/media/uploads/{name}"


def _annotate(img: np.ndarray, vehicles: list[Box], regions: list[dict], banner: str) -> np.ndarray:
    out = img.copy()
    overlay = out.copy()
    for r in regions:
        x1, y1, x2, y2 = r["box"]
        if r["state"] == "snow_blocked":
            cv2.rectangle(overlay, (x1, y1), (x2, y2), ORANGE, -1)
        elif r["state"] == "open":
            cv2.rectangle(overlay, (x1, y1), (x2, y2), (120, 220, 120), -1)
    out = cv2.addWeighted(overlay, 0.35, out, 0.65, 0)
    for r in regions:
        x1, y1, x2, y2 = r["box"]
        color = ORANGE if r["state"] == "snow_blocked" else (120, 220, 120) if r["state"] == "open" else (90, 90, 90)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 1)
    for i, v in enumerate(vehicles, 1):
        cv2.rectangle(out, (v.x1, v.y1), (v.x2, v.y2), CYAN, 2)
        cv2.putText(out, str(i), (v.x1 + 3, v.y1 + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, CYAN, 1, cv2.LINE_AA)
    cv2.rectangle(out, (0, 0), (out.shape[1], 24), (24, 11, 8), -1)
    cv2.putText(out, banner[:110], (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, WHITE, 1, cv2.LINE_AA)
    return out


def analyze_parking(data: bytes, lot_name: str, regions: dict | None = None) -> dict:
    img, scale = decode_image(data)
    detector = get_detector()
    det = detector.detect(img)
    # Local issue detector (cars, ice, water, cones, objects). With the classical detector, its extra
    # car finder (rectangle-shaped bodies, white cars with dark windows) fills in cars the blob detector missed.
    found = detect_issues(img)
    if True:   # always: the trained models don't know top-down/synthetic views; heuristics fill the gaps
        h, w = img.shape[:2]
        for i in found["issues"]:
            if i["kind"] != "vehicle":
                continue
            b = Box(int(i["box"][0] * w), int(i["box"][1] * h), int(i["box"][2] * w), int(i["box"][3] * h), "car", float(i["score"]))
            if not any(_iou(b, v) > 0.3 for v in det.vehicles):
                det.vehicles.append(b)

    # Privacy first: nothing unblurred is ever written.
    blurred, n_blur, blur_methods = apply_privacy_blur(img, det.vehicles, det.people)

    if regions:
        region_scale = img.shape[1] / regions.get("image_width", img.shape[1])
        space = estimate_with_regions(img, det.vehicles, regions, region_scale)
    else:
        space = estimate_by_area(img, det.vehicles)

    g = gemini.assess_parking(blurred) if gemini.available() else None
    if g and space.method != "calibrated_regions":
        try:
            space.method, space.method_label = "gemini_vision", "Gemini Vision assessment of visible stalls"
            space.visible_spaces = int(g.get("visible_parking_spaces", space.visible_spaces))
            space.occupied_spaces = int(g.get("occupied_spaces", len(det.vehicles)))
            space.open_spaces = int(g.get("open_spaces", space.open_spaces))
            space.snow_blocked_spaces = int(g.get("snow_blocked_spaces", space.snow_blocked_spaces))
            space.plowed_rows = g.get("plowed_rows")
            space.unplowed_rows = g.get("unplowed_rows")
            space.confidence = float(g.get("confidence", 0.6))
        except (TypeError, ValueError):
            pass

    snow_cover = snow_cover_fraction(img)
    weather = (g or {}).get("weather_condition") or ("Snow" if snow_cover > 0.18 else "Clear / unknown")
    usable = space.occupied_spaces + space.open_spaces
    stalls = usable + space.snow_blocked_spaces
    frame_occ = space.occupied_spaces / usable if usable else 1.0
    snow_frac = space.snow_blocked_spaces / stalls if stalls else 0.0

    confidence = round(min(0.97, 0.45 * det.base_confidence + 0.55 * space.confidence + (0.05 if g else 0)), 2)
    if frame_occ >= 0.92:
        rec = "Lot is effectively full. Head to a park-and-ride."
    elif frame_occ >= 0.75:
        rec = "Parking availability is moderate. Spaces are going fast."
    else:
        rec = "Parking availability is good."

    if g and g.get("explanation"):
        explanation, explanation_source = str(g["explanation"]), "Gemini Vision"
    else:
        bits = [f"Counted {len(det.vehicles)} vehicles with the {det.provider}."]
        bits.append(f"{space.method_label}: {space.open_spaces} open, {space.occupied_spaces} occupied"
                    + (f", {space.snow_blocked_spaces} blocked by snow." if space.snow_blocked_spaces else "."))
        if space.unplowed_rows:
            bits.append(f"{space.unplowed_rows} row(s) look unplowed.")
        if space.method == "area_heuristic":
            bits.append("No stall map exists for this view, so the open-space figure is a rough estimate. Correct it if it looks off.")
        explanation_source = ("Rule-based summary of the measurements (Gemini unavailable for this scan)" if gemini.available()
                              else "Rule-based summary of the measurements (Gemini not configured)")
        explanation = " ".join(bits)

    # Why spaces are unusable: drawn from the issue detector run above.
    banner = f"{lot_name} | {len(det.vehicles)} vehicles | {space.open_spaces} open est. | {det.provider}"
    annotated = _annotate(blurred, det.vehicles, space.regions, banner)
    _draw_issues(annotated, found["issues"])

    return {
        "lot_name": lot_name,
        "vehicles_detected": len(det.vehicles),
        "estimated_open_spaces": space.open_spaces,
        "snow_blocked_spaces": space.snow_blocked_spaces,
        "occupied_spaces": space.occupied_spaces,
        "visible_spaces": space.visible_spaces,
        "plowed_rows": space.plowed_rows,
        "unplowed_rows": space.unplowed_rows,
        "confidence": confidence,
        "weather_condition": weather,
        "recommendation": rec,
        "explanation": explanation,
        "explanation_source": explanation_source,
        "space_method": space.method,
        "space_method_label": space.method_label,
        "detector": det.provider,
        "detector_note": det.note,
        "gemini_used": bool(g),
        "snow_cover_fraction": round(snow_cover, 3),
        "frame_occupancy_fraction": round(frame_occ, 3),
        "frame_snow_blocked_fraction": round(snow_frac, 3),
        "boxes": [v.as_dict() for v in det.vehicles],
        "issues": [i for i in found["issues"] if i["kind"] != "vehicle"],
        "verdict": found["verdict"],
        "issues_method": found["method"],
        "privacy": {"regions_blurred": n_blur, "methods": blur_methods},
        "blurred_image_url": _save(blurred, "blurred"),
        "annotated_image_url": _save(annotated, "annotated"),
    }


def classify_hazard_image(data: bytes) -> dict:
    img, _ = decode_image(data)
    det = get_detector().detect(img)
    blurred, n_blur, methods = apply_privacy_blur(img, det.vehicles, det.people)
    g = gemini.classify_hazard(blurred) if gemini.available() else None
    if g and g.get("category"):
        cat = g["category"]
        if g.get("curb_ramp_blocked"):
            cat = "blocked_ramp"
        return {
            "category": cat, "confidence": float(g.get("confidence", 0.6)),
            "explanation": g.get("explanation", ""), "classified_by": "gemini_vision",
            "image_url": _save(blurred, "hazard"), "privacy": {"regions_blurred": n_blur, "methods": methods},
        }
    found = detect_issues(img)
    return {**heuristic_hazard(img), "image_url": _save(blurred, "hazard"),
            "privacy": {"regions_blurred": n_blur, "methods": methods},
            "issues": [i for i in found["issues"] if i["kind"] != "vehicle"], "verdict": found["verdict"]}


ISSUE_BGR = {"ice": (255, 200, 80), "water": (180, 120, 40), "cone": (0, 140, 255), "object": (60, 60, 230)}


def _draw_issues(img: np.ndarray, issues: list[dict]) -> None:
    """Outline each blocking issue on the annotated image with its label."""
    h, w = img.shape[:2]
    for i in issues:
        if i["kind"] == "vehicle":
            continue
        x1, y1, x2, y2 = (int(i["box"][0] * w), int(i["box"][1] * h), int(i["box"][2] * w), int(i["box"][3] * h))
        col = ISSUE_BGR.get(i["kind"], (60, 60, 230))
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), 4)
        cv2.rectangle(img, (x1, y1), (x2, y2), col, 2)
        cv2.putText(img, i["label"], (x1 + 3, max(14, y1 + 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, i["label"], (x1 + 3, max(14, y1 + 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)


def _iou(a: Box, b: Box) -> float:
    ix = max(0, min(a.x2, b.x2) - max(a.x1, b.x1)); iy = max(0, min(a.y2, b.y2) - max(a.y1, b.y1))
    inter = ix * iy
    union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
    return inter / union if union else 0.0


def heuristic_hazard(img: np.ndarray) -> dict:
    """Classical fallback using surface statistics of the lower 60% of the frame (the ground)."""
    h, w = img.shape[:2]
    ground = img[int(h * 0.45):, int(w * 0.3):int(w * 0.7)]  # walking surface in a typical path photo
    hsv = cv2.cvtColor(ground, cv2.COLOR_BGR2HSV)
    _, snow = surface_masks(ground)
    snow_frac = cv2.countNonZero(snow) / snow.size
    v, s = hsv[..., 2].astype(float), hsv[..., 1].astype(float)
    specular = float(np.mean((v > 235) & (s < 30)))
    gray = cv2.cvtColor(ground, cv2.COLOR_BGR2GRAY)
    texture = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    b, g_, r = (float(np.mean(ground[..., i])) for i in range(3))
    blue_tint = b - r

    if snow_frac > 0.7:
        cat, conf, why = "unplowed", 0.55, "Most of the walking surface is covered in untouched snow."
    elif snow_frac > 0.4:
        cat, conf, why = "snow", 0.5, "A large share of the path is snow-covered."
    elif specular > 0.01 and texture < 400 and blue_tint > 4:
        cat, conf, why = "ice", 0.5, "Smooth, glossy, bluish surface with bright reflections suggests glaze ice."
    elif 60 < float(np.mean(v)) < 170 and texture > 150 and snow_frac > 0.08:
        cat, conf, why = "slush", 0.45, "Mottled grey-brown wet surface with patchy snow suggests slush."
    else:
        cat, conf, why = "ice", 0.3, "No clear signature. Defaulting to the most dangerous plausible condition; please confirm or correct."
    return {"category": cat, "confidence": conf, "classified_by": "opencv_heuristic",
            "explanation": why + " (OpenCV heuristic; curb-ramp blockage needs Gemini or the reporter's choice.)",
            "features": {"snow_fraction": round(snow_frac, 3), "specular": round(specular, 4),
                         "texture": round(texture, 1), "blue_tint": round(blue_tint, 1)}}
