"""Local OpenCV issue detector: what in a photo makes a parking space (or walkway) unusable.

Runs entirely on the server with classical computer vision (no ML weights, no network), in ~20-60 ms on a
640 px frame, so it can drive the live camera and explain every scan. Each finding has a box, a plain-English
reason and a rough confidence. It is a heuristic and is labelled as one everywhere it's shown.

What it looks for (in priority order for the verdict):
  vehicle       car-shaped blob on pavement/snow (re-uses detectors.OpenCVBlobDetector)  -> space is taken
  ice           smooth, glossy, bluish-grey regions with specular highlights              -> slippery / unsafe
  water         dark, smooth, unsaturated patches (standing water or black ice)          -> unsafe
  cone          saturated orange/red/yellow blobs (traffic cones, barriers, tape)        -> space closed
  object        high-edge-density blob that isn't any of the above (debris, cart, sign)   -> something in the way
"""
from __future__ import annotations

import cv2
import numpy as np

from .detectors import OpenCVBlobDetector, surface_masks

METHOD = "OpenCV colour + texture heuristics (local, no AI)"
WORK_SIDE = 640
_cars = OpenCVBlobDetector()

LABELS = {
    "vehicle": "Parked car", "ice": "Ice / glaze", "water": "Standing water or black ice",
    "cone": "Cone or barrier", "object": "Object in the way",
}
REASONS = {
    "vehicle": "a car is already parked there",
    "ice": "glossy ice or slush covers {pct}% of the frame",
    "water": "standing water or black ice covers {pct}% of the frame",
    "cone": "a cone or barrier closes it off",
    "object": "something is in the way (debris, cart or sign)",
}
BLOCKING = {"ice": 0.05, "water": 0.05}   # minimum frame share before it makes a space unusable


def _components(mask: np.ndarray, min_frac: float, max_frac: float = 1.0) -> list[tuple[int, int, int, int, float]]:
    h, w = mask.shape
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        f = area / (h * w)
        if min_frac <= f <= max_frac:
            out.append((int(x), int(y), int(x + bw), int(y + bh), float(f)))
    return sorted(out, key=lambda b: -b[4])


def _overlap(a: tuple, b: tuple) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max(1, (a[2] - a[0]) * (a[3] - a[1]))
    return ix * iy / area


def detect_issues(image: np.ndarray) -> dict:
    """image: BGR. Returns {issues: [...], verdict: {...}, method, measurements}. Boxes are normalised 0-1."""
    h0, w0 = image.shape[:2]
    s_ = min(1.0, WORK_SIDE / max(h0, w0))
    img = cv2.resize(image, (int(w0 * s_), int(h0 * s_)), interpolation=cv2.INTER_AREA) if s_ < 1 else image
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # local texture: blurred |Laplacian| (low = smooth surface)
    tex = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray, cv2.CV_32F)), (15, 15), 0)
    smooth = tex < 6
    k5 = np.ones((5, 5), np.uint8)

    def clean(m: np.ndarray, k: int = 7) -> np.ndarray:
        m = cv2.morphologyEx(m.astype(np.uint8) * 255, cv2.MORPH_OPEN, k5)
        return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))

    # Snow: open with a big kernel first so 2-4 px painted lines and thin banners drop out.
    snow = cv2.morphologyEx(((S < 40) & (V > 185)).astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    snow = cv2.morphologyEx(snow, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    glossy = (V > 235) & (S < 30)
    ice = clean((S < 70) & (V > 120) & (V <= 215) & smooth & (H >= 85) & (H <= 130), 9)
    water = clean((V < 80) & (S < 60) & smooth, 9)
    orange = ((H <= 22) | (H >= 170)) & (S > 140) & (V > 110)
    yellow = (H > 22) & (H <= 34) & (S > 130) & (V > 150)
    cone = clean(orange | yellow, 5)

    found: list[dict] = []

    def add(kind: str, box: tuple, score: float, extra: str = "") -> None:
        x1, y1, x2, y2 = box[:4]
        found.append({"kind": kind, "label": LABELS[kind], "score": round(score, 2),
                      "box": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
                      "detail": extra})

    # Cones / barriers first: upright, saturated orange/red/yellow and tapered (triangle fill ~0.5;
    # car bodies are boxes ~0.9), so an orange car is never called a cone and a cone is never called a car.
    cone_boxes = []
    for b in _components(cone, 0.002, 0.08)[:6]:
        bw, bh = b[2] - b[0], b[3] - b[1]
        if bh >= 0.6 * bw and b[4] * h * w / max(1, bw * bh) < 0.8:
            cone_boxes.append(b)
    cars = [(b.x1, b.y1, b.x2, b.y2, b.score) for b in _cars.detect(img).vehicles
            if not any(_overlap((b.x1, b.y1, b.x2, b.y2), cb) > 0.3 for cb in cone_boxes)]
    # Second car finder: compact, rectangle-like blobs that aren't road or snow (car bodies seen from above or
    # behind), plus bright blobs with dark windows inside (white cars, which the snow mask would otherwise take).
    asphalt_m, _ = surface_masks(img)
    body = cv2.morphologyEx(((asphalt_m == 0) & ~((S < 40) & (V > 185)) & (cone == 0)).astype(np.uint8) * 255, cv2.MORPH_OPEN, k5)
    contours, _ = cv2.findContours(body, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        a = cv2.contourArea(cnt)
        if not (0.002 * h * w <= a <= 0.05 * h * w):
            continue
        (_, _), (rw, rh), _ = cv2.minAreaRect(cnt)
        if min(rw, rh) == 0:
            continue
        aspect, fill = max(rw, rh) / min(rw, rh), a / (rw * rh)
        x, y, bw, bh = cv2.boundingRect(cnt)
        if 1.25 <= aspect <= 3.2 and fill >= 0.78 and not any(_overlap((x, y, x + bw, y + bh), c) > 0.4 for c in cars):
            cars.append((x, y, x + bw, y + bh, round(min(0.8, 0.45 + 0.3 * fill), 2)))
    # Third finder: grey/silver cars match asphalt in colour, so find them by shape instead: a closed,
    # car-sized, rectangle-like outline with dark windows inside.
    sizes = sorted((c[2] - c[0]) * (c[3] - c[1]) for c in cars)
    typical = sizes[len(sizes) // 2] if len(sizes) >= 3 else None    # median car box in this photo
    outline = cv2.morphologyEx(cv2.Canny(gray, 40, 120), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    filled = np.zeros_like(outline)
    cnts, _ = cv2.findContours(outline, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(filled, cnts, -1, 255, -1)
    filled = cv2.morphologyEx(filled, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))   # drop painted lines
    cnts, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in cnts:
        a = cv2.contourArea(cnt)
        if not (0.003 * h * w <= a <= 0.05 * h * w):
            continue
        (_, _), (rw, rh), _ = cv2.minAreaRect(cnt)
        if min(rw, rh) == 0:
            continue
        aspect, fill = max(rw, rh) / min(rw, rh), a / (rw * rh)
        x, y, bw, bh = cv2.boundingRect(cnt)
        if not (1.25 <= aspect <= 3.2 and fill >= 0.75):
            continue
        if typical and not (0.5 * typical <= bw * bh <= 1.6 * typical):
            continue          # merged neighbours (or a fragment), not one car
        ix, iy = int(bw * 0.15), int(bh * 0.15)
        inner = V[y + iy:y + bh - iy, x + ix:x + bw - ix]
        if inner.size and float(np.mean(inner < 70)) > 0.06 and not any(_overlap((x, y, x + bw, y + bh), c) > 0.4 for c in cars):
            cars.append((x, y, x + bw, y + bh, 0.5))
    for x1, y1, x2, y2, sc in cars:
        add("vehicle", (x1, y1, x2, y2), sc)
    vehicle_boxes = [(int(f["box"][0] * w), int(f["box"][1] * h), int(f["box"][2] * w), int(f["box"][3] * h)) for f in found]
    # Snow inside a car box is the car's paint/roof, not snow.
    for vb in vehicle_boxes:
        snow[vb[1]:vb[3], vb[0]:vb[2]] = 0

    for b in _components(snow, 0.004):
        x1, y1, x2, y2, f = b
        bw, bh = x2 - x1, y2 - y1
        if max(bw, bh) > 8 * max(1, min(bw, bh)):
            snow[y1:y2, x1:x2] = 0          # long thin strip: a caption bar or painted line, not snow
            continue
        ix, iy = int(bw * 0.2), int(bh * 0.2)          # windows sit inside the body, not at the edges
        inner = V[y1 + iy:y2 - iy, x1 + ix:x2 - ix]
        if f < 0.04 and inner.size and float(np.mean(inner < 70)) > 0.06:
            snow[y1:y2, x1:x2] = 0          # white blob with dark windows inside: a white car
            add("vehicle", (x1, y1, x2, y2), 0.55)
            vehicle_boxes.append((x1, y1, x2, y2))
    # Bright, colourless areas are only used internally (white-car check, not "objects"); snow is not reported.
    snow_frac = float(np.count_nonzero(snow)) / (h * w)
    ice_frac = float(np.count_nonzero(ice)) / (h * w)
    gloss = float(np.count_nonzero(glossy)) / (h * w)
    for b in _components(ice, 0.02)[:3]:
        add("ice", b, min(0.75, 0.35 + b[4] * 2 + (0.15 if gloss > 0.005 else 0)), f"{round(b[4] * 100)}% of frame")
    water_frac = float(np.count_nonzero(water)) / (h * w)
    for b in _components(water, 0.02)[:3]:
        if not any(_overlap(b, v) > 0.5 for v in vehicle_boxes):   # a dark car isn't a puddle
            add("water", b, min(0.7, 0.35 + b[4] * 2), f"{round(b[4] * 100)}% of frame")
    for b in cone_boxes[:5]:
        add("cone", b, 0.6)

    # Anything else with lots of edges that isn't road, snow, a car or a cone: an object in the way.
    edges = cv2.dilate(cv2.Canny(gray, 80, 160), k5, iterations=2)
    known = (snow > 0) | (cone > 0)
    for vb in vehicle_boxes:
        known[vb[1]:vb[3], vb[0]:vb[2]] = True
    busy = cv2.morphologyEx(((edges > 0) & ~known).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    for b in _components(busy, 0.01, 0.2)[:3]:
        x1, y1, x2, y2, f = b
        bw, bh = x2 - x1, y2 - y1
        if min(bw, bh) < 0.08 * min(w, h) or max(bw, bh) > 4 * min(bw, bh):
            continue   # thin and long = painted stall line or curb edge, not an obstacle
        fill = float(np.count_nonzero(edges[y1:y2, x1:x2])) / max(1, bw * bh)
        # Debris, carts, bins and signs are mostly grey/brown; brightly coloured blobs here are cars we missed.
        if float(np.mean(S[y1:y2, x1:x2] > 90)) > 0.12:
            continue
        if fill > 0.35 and not any(_overlap(b, (int(i["box"][0] * w), int(i["box"][1] * h), int(i["box"][2] * w), int(i["box"][3] * h))) > 0.3 for i in found):
            add("object", b, 0.4)

    fracs = {"ice": ice_frac, "water": water_frac}
    reasons = []
    for kind in ("vehicle", "ice", "water", "cone", "object"):
        present = any(f["kind"] == kind for f in found)
        if kind in BLOCKING:
            present = present and fracs[kind] >= BLOCKING[kind]
        if present:
            reasons.append({"kind": kind, "text": REASONS[kind].format(pct=round(fracs.get(kind, 0) * 100))})
    blocking = [r for r in reasons if r["kind"] != "vehicle"]
    if blocking:
        headline = "Unusable: " + "; ".join(r["text"] for r in blocking[:2])
    elif reasons:
        headline = "Taken: " + reasons[0]["text"]
    else:
        headline = "No blocking issue found: looks usable"
    return {
        "issues": found,
        "verdict": {"usable": not reasons, "blocked": bool(blocking), "headline": headline[0].upper() + headline[1:],
                    "reasons": [r["text"] for r in reasons]},
        "method": METHOD,
        "measurements": {"bright_fraction": round(snow_frac, 3), "ice_fraction": round(ice_frac, 3),
                         "water_fraction": round(water_frac, 3), "specular_fraction": round(gloss, 4)},
    }
