"""Configurable geography for UB North Campus.

Parking lots come from OpenStreetMap (© OpenStreetMap contributors, ODbL) via
`python -m scripts.import_osm_lots`, which writes `app/ub_lots.json`: every named UB-operated lot on
North Campus with its real outline. Names were cross-checked against UB's Wayfinder map.
Capacities are ESTIMATES from outline area (calibrated ~33 m2 per stall on lots OSM tags) unless OSM
tags a number; hourly occupancy profiles are PROTOTYPE SEED curves by lot type. None of this is
official UB Parking data. `python -m scripts.init_db --reset` reloads it; startup syncs it into an existing DB.
"""
import json
from pathlib import Path

from .config import get_settings

_S = get_settings()


def _scaled_capacities(lots: list[dict]) -> dict[str, int]:
    """Map each lot's estimated size onto [min, max] by rank (percentile), rounded to `step`, so capacities
    are spread out (some 20, some 30, ... some 50) and a bigger lot never gets fewer spaces than a smaller one.
    With `lot_capacity_tiers` set (e.g. "56,116,300"), lots are split by size rank into that many equal groups
    (small / mid / big) and each group gets its tier's capacity."""
    tiers = sorted(int(t) for t in _S.lot_capacity_tiers.split(",") if t.strip())
    if tiers:
        ranked = sorted(lots, key=lambda l: (l["total_capacity"], l["slug"]))
        return {l["slug"]: tiers[min(len(tiers) - 1, i * len(tiers) // len(ranked))] for i, l in enumerate(ranked)}
    lo, hi, step = _S.lot_capacity_min, _S.lot_capacity_max, max(1, _S.lot_capacity_step)
    if hi <= 0:
        return {l["slug"]: l["total_capacity"] for l in lots}
    ranked = sorted(lots, key=lambda l: (l["total_capacity"], l["slug"]))
    n = max(1, len(ranked) - 1)
    out = {}
    for i, l in enumerate(ranked):
        raw = lo + (hi - lo) * i / n
        out[l["slug"]] = int(min(hi, max(lo, step * round(raw / step))))
    return out


# Typical weekday occupancy fraction by hour (0-23), by lot type.
_COMMUTER = [0.05, 0.04, 0.04, 0.04, 0.05, 0.08, 0.15, 0.35, 0.62, 0.84, 0.93, 0.95,
             0.92, 0.90, 0.88, 0.80, 0.66, 0.48, 0.32, 0.25, 0.18, 0.12, 0.08, 0.06]
_COMMUTER_HOT = [0.05, 0.04, 0.04, 0.04, 0.05, 0.10, 0.20, 0.45, 0.75, 0.95, 0.99, 0.99,
                 0.97, 0.95, 0.92, 0.85, 0.70, 0.50, 0.33, 0.25, 0.18, 0.12, 0.08, 0.06]
_PARK_RIDE = [0.03, 0.03, 0.03, 0.03, 0.04, 0.06, 0.10, 0.22, 0.40, 0.58, 0.68, 0.72,
              0.70, 0.68, 0.65, 0.58, 0.45, 0.32, 0.20, 0.14, 0.10, 0.07, 0.05, 0.04]
_STADIUM = [0.02, 0.02, 0.02, 0.02, 0.03, 0.05, 0.08, 0.16, 0.30, 0.44, 0.52, 0.56,
            0.55, 0.54, 0.52, 0.46, 0.36, 0.25, 0.16, 0.12, 0.08, 0.05, 0.04, 0.03]
# Residence-hall lots: full overnight, partly empty while residents drive to class/work.
_RESIDENCE = [0.88, 0.89, 0.90, 0.90, 0.90, 0.89, 0.86, 0.80, 0.72, 0.66, 0.63, 0.62,
              0.62, 0.63, 0.64, 0.66, 0.70, 0.75, 0.80, 0.83, 0.85, 0.86, 0.87, 0.88]
# Visitor (paid) lots: daytime appointments and events.
_VISITOR = [0.02, 0.02, 0.02, 0.02, 0.02, 0.03, 0.06, 0.15, 0.32, 0.48, 0.58, 0.62,
            0.62, 0.60, 0.56, 0.48, 0.36, 0.24, 0.16, 0.12, 0.08, 0.05, 0.03, 0.02]
_PROFILE = {"commuter": _COMMUTER, "residence": _RESIDENCE, "visitor": _VISITOR, "event": _STADIUM, "park_and_ride": _PARK_RIDE}
# The four original lots keep their hand-tuned curves and row counts (their DB ids 1-4 stay stable too).
_TUNED = {"jarvis-a": (_COMMUTER, 6), "hochstetter-b": (_COMMUTER_HOT, 5), "center-for-tomorrow": (_PARK_RIDE, 10), "stadium": (_STADIUM, 14)}
_ORDER = ["jarvis-a", "hochstetter-b", "center-for-tomorrow", "stadium"]
_KIND_TEXT = {"commuter": "Commuter lot", "residence": "Residence lot", "visitor": "Visitor lot (paid)",
              "event": "Event / overflow lot", "park_and_ride": "Park and ride, shuttle to the Spine"}

_DATA = json.loads((Path(__file__).with_name("ub_lots.json")).read_text(encoding="utf-8"))
OSM_ATTRIBUTION = _DATA["source"]

LOTS: list[dict] = []
# slug -> (lat, lng) where a mapped road enters the lot (scripts/import_lot_entrances.py). Directions go here,
# not to the lot's centre pin, which Google would snap to whatever road is nearest (often the wrong side).
ENTRANCES: dict[str, tuple[float, float]] = {}
OUTLINE_SOURCE: dict[str, str] = {}  # slug -> "osm:way/<id>"; exposed by /api/parking/locate so the UI can be honest
_CAPACITY = _scaled_capacities(_DATA["lots"])
for _l in sorted(_DATA["lots"], key=lambda l: (_ORDER.index(l["slug"]) if l["slug"] in _ORDER else len(_ORDER), l["name"])):
    _capacity = _CAPACITY[_l["slug"]]
    _capped = _capacity != _l["total_capacity"]
    _profile, _ = _TUNED.get(_l["slug"], (_PROFILE[_l["kind"]], 0))
    _rows = max(1, round(_capacity / 10))
    _cap_note = (f"{_capacity} spaces (project setting by lot size)" if _capped
                 else "capacity from OSM" if _l["capacity_source"] == "osm_tag" else "capacity estimated from lot area")
    _desc = " · ".join(x for x in (_KIND_TEXT[_l["kind"]], _l.get("permit") or "Permit rules not listed: check UB Parking", _cap_note) if x)
    LOTS.append({
        "slug": _l["slug"], "name": _l["name"], "kind": _l["kind"], "description": _desc[:200],
        "lat": _l["lat"], "lng": _l["lng"], "polygon": _l["polygon"], "total_capacity": _capacity,
        "total_rows": _rows, "hourly_profile": _profile, "capacity_is_seed_estimate": _capped or _l["capacity_source"] != "osm_tag",
    })
    if _l.get("entrance"):
        ENTRANCES[_l["slug"]] = (_l["entrance"][0], _l["entrance"][1])
    OUTLINE_SOURCE[_l["slug"]] = f"osm:{_l['osm']}"

BUILDINGS = {
    "Davis Hall": (43.0027, -78.7871),
    "Capen Hall": (43.0009, -78.7893),
    "Student Union": (43.0010, -78.7863),
    "Knox Hall": (43.0006, -78.7875),
    "Lockwood Library": (43.0003, -78.7864),
    "Natural Sciences Complex": (43.0007, -78.7882),
    "Furnas Hall": (43.0019, -78.7869),
    "Center for the Arts": (43.0011, -78.7836),
    "Alumni Arena": (43.0003, -78.7808),
}

# Named spots students pick when filing a walkway report. Hand-placed on the real routes between the
# OSM lot outlines and buildings (re-placed 2026-11-07 after Jarvis A / Center for Tomorrow were corrected).
HAZARD_LOCATIONS = [
    {"name": "Jarvis A to Davis Hall walkway", "lat": 43.00327, "lng": -78.78778},
    {"name": "Davis Hall north curb ramp", "lat": 43.0028, "lng": -78.7869},
    {"name": "Capen Hall ramp", "lat": 43.0008, "lng": -78.7889},
    {"name": "Academic Spine by Student Union", "lat": 43.0011, "lng": -78.7867},
    {"name": "Hochstetter B crosswalk", "lat": 42.9995, "lng": -78.7900},
    {"name": "Lockwood Library ramp", "lat": 43.0002, "lng": -78.7861},
    {"name": "Stadium Lot path to Alumni Arena", "lat": 42.99905, "lng": -78.78014},
    {"name": "Center for Tomorrow shuttle stop", "lat": 42.99340, "lng": -78.79280},
    {"name": "Knox Hall plaza", "lat": 43.0005, "lng": -78.7877},
]

DEMO_USERS = [
    ("Shruti", 1240, 31, 18),
    ("Shashank", 980, 24, 15),
    ("Roy", 760, 19, 9),
]
