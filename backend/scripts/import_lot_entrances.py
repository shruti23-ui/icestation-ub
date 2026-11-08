"""Finds each UB lot's driveway entrance from OpenStreetMap roads, for turn-by-turn directions.

A lot's map pin sits inside the lot, so Google Maps snaps it to whichever road is nearest, which is often
the wrong side of the lot (no way in). This script finds where a drivable road (a driveway, parking aisle
or street) actually crosses the lot outline and stores that point as `entrance` in app/ub_lots.json.
Directions then route to the real way in.

    python -m scripts.import_lot_entrances            # fetch roads from Overpass (snapshot saved)
    python -m scripts.import_lot_entrances --offline  # reuse the saved snapshot

Road data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import sys
from pathlib import Path

import httpx

from scripts.import_osm_lots import BBOX, MIRRORS

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "data" / "osm" / "overpass_roads.json"
LOTS = ROOT / "app" / "ub_lots.json"
# Drivable ways. Footways, paths, cycleways and steps are excluded.
DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|motorway_link|primary_link|secondary_link|tertiary_link"
PUBLIC = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "road",
          "motorway_link", "primary_link", "secondary_link", "tertiary_link"}

Pt = tuple[float, float]  # (lat, lng)


def fetch() -> dict:
    s, w, n, e = BBOX
    q = f'[out:json][timeout:60];way["highway"~"^({DRIVABLE})$"]({s},{w},{n},{e});out tags geom;'
    last = None
    for url in MIRRORS:
        try:
            r = httpx.post(url, data={"data": q}, headers={"User-Agent": "WeParkit-hackathon/1.0"}, timeout=90)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # try the next mirror
            last = exc
    raise SystemExit(f"Overpass unavailable: {last}")


def _xy(p: Pt, lat0: float) -> tuple[float, float]:
    """Local metres (equirectangular; fine at campus scale)."""
    return p[1] * 111_320 * math.cos(math.radians(lat0)), p[0] * 110_574


def _seg_intersection(a: Pt, b: Pt, c: Pt, d: Pt, lat0: float) -> Pt | None:
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = (_xy(p, lat0) for p in (a, b, c, d))
    den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if abs(den) < 1e-12:
        return None
    t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den
    u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return None


def _closest_on_seg(p: Pt, a: Pt, b: Pt, lat0: float) -> tuple[Pt, float]:
    (px, py), (ax, ay), (bx, by) = (_xy(q, lat0) for q in (p, a, b))
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    q = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    qx, qy = _xy(q, lat0)
    return q, math.hypot(px - qx, py - qy)


def _dist_to_ways(p: Pt, ways: list[list[Pt]], lat0: float) -> float:
    return min((_closest_on_seg(p, w[i], w[i + 1], lat0)[1] for w in ways for i in range(len(w) - 1)), default=math.inf)


def entrance(polygon: list[Pt], roads: list[tuple[str, list[Pt]]]) -> tuple[Pt, str]:
    """Where a car gets into the lot. Prefers a road crossing the outline that's closest to a public street."""
    lat0 = sum(p[0] for p in polygon) / len(polygon)
    ring = polygon if polygon[0] == polygon[-1] else polygon + [polygon[0]]
    public = [g for kind, g in roads if kind in PUBLIC]
    crossings: list[Pt] = []
    for _, g in roads:
        for i in range(len(g) - 1):
            for j in range(len(ring) - 1):
                x = _seg_intersection(g[i], g[i + 1], ring[j], ring[j + 1], lat0)
                if x:
                    crossings.append(x)
    if crossings:
        best = min(crossings, key=lambda x: _dist_to_ways(x, public, lat0))
        return (round(best[0], 6), round(best[1], 6)), "osm_road_crossing"
    # No mapped driveway crosses the outline: use the point of the outline nearest any drivable road.
    best_pt, best_d = ring[0], math.inf
    for _, g in roads:
        for i in range(len(g) - 1):
            for j in range(len(ring) - 1):
                for p in (ring[j], g[i]):
                    q, d = _closest_on_seg(p, *((ring[j], ring[j + 1]) if p is g[i] else (g[i], g[i + 1])), lat0)
                    if d < best_d:
                        best_d, best_pt = d, (q if p is g[i] else ring[j])
    return (round(best_pt[0], 6), round(best_pt[1], 6)), "nearest_road"


def main() -> None:
    if "--offline" in sys.argv:
        raw = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    else:
        raw = fetch()
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(json.dumps(raw), encoding="utf-8")
    roads = [(el["tags"].get("highway", ""), [(p["lat"], p["lon"]) for p in el.get("geometry", [])])
             for el in raw["elements"] if el.get("type") == "way" and len(el.get("geometry", [])) >= 2]
    data = json.loads(LOTS.read_text(encoding="utf-8"))
    for lot in data["lots"]:
        pt, how = entrance([tuple(p) for p in lot["polygon"]], roads)
        lot["entrance"], lot["entrance_source"] = list(pt), how
        print(f"{lot['name']:<24} {pt[0]:.6f},{pt[1]:.6f}  {how}")
    LOTS.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(roads)} drivable ways · entrances written to {LOTS.name}")


if __name__ == "__main__":
    main()
