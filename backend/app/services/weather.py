"""National Weather Service integration (api.weather.gov, no key required, needs a User-Agent).

Live alerts for the UB North Campus point + latest observation from KBUF (Buffalo airport).
Cached for 5 minutes. When NWS is unreachable the status says so plainly and no alert is
assumed. During a demo storm replay a clearly-marked DEMO alert is injected.
"""
from __future__ import annotations

from datetime import timedelta

import httpx

from ..config import get_settings
from ..timeutil import iso, utcnow
from .swr import SWRCache

settings = get_settings()
WINTER_WORDS = ("snow", "winter", "blizzard", "ice", "freez", "sleet", "squall", "wind chill", "cold")

_demo: dict = {"alert": None, "until": None, "observation": None}


def is_winter_event(event: str) -> bool:
    e = event.lower()
    return any(w in e for w in WINTER_WORDS)


def _fetch_live() -> dict:
    headers = {"User-Agent": settings.nws_user_agent, "Accept": "application/geo+json"}
    t = settings.external_timeout_s
    alerts, obs, errors = [], None, []
    try:
        r = httpx.get("https://api.weather.gov/alerts/active",
                      params={"point": f"{settings.nws_point_lat},{settings.nws_point_lon}"}, headers=headers, timeout=t)
        r.raise_for_status()
        for f in r.json().get("features", []):
            p = f.get("properties", {})
            alerts.append({
                "id": p.get("id"), "event": p.get("event", "Alert"), "headline": p.get("headline") or p.get("event"),
                "severity": p.get("severity"), "onset": p.get("onset"), "ends": p.get("ends") or p.get("expires"),
                "winter": is_winter_event(p.get("event", "")), "demo": False, "source": "NWS",
            })
    except Exception as exc:
        errors.append(f"alerts: {type(exc).__name__}")
    try:
        # The last few hourly reports: the newest one sometimes lacks a field (e.g. temperature), so each field
        # is taken from the most recent report that has it.
        r = httpx.get(f"https://api.weather.gov/stations/{settings.nws_station}/observations",
                      params={"limit": 4}, headers=headers, timeout=t)
        r.raise_for_status()
        reports = [f.get("properties", {}) for f in r.json().get("features", [])]
        if reports:
            obs = driver_observation(reports)
    except Exception as exc:
        errors.append(f"observation: {type(exc).__name__}")
    live_ok = not errors or (obs is not None or alerts)
    return {"alerts": alerts, "observation": obs, "errors": errors,
            "source": "nws_live" if live_ok and len(errors) < 2 else "unavailable"}


_COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def driver_observation(reports: list[dict]) -> dict:
    """NWS station reports (newest first) -> what a driver cares about, plus plain advice. Pure; unit-tested."""
    def val(key: str):
        for p in reports:
            v = (p.get(key) or {}).get("value")
            if v is not None:
                return v
        return None
    newest = reports[0]
    temp, chill, heat = val("temperature"), val("windChill"), val("heatIndex")
    wind, gust, wdir, vis, hum = val("windSpeed"), val("windGust"), val("windDirection"), val("visibility"), val("relativeHumidity")
    cond = newest.get("textDescription") or next((p.get("textDescription") for p in reports if p.get("textDescription")), "") or "Unknown"
    feels = chill if chill is not None else heat if heat is not None else temp
    c = cond.lower()
    precip = next((w for w in ("freezing rain", "sleet", "snow", "rain", "drizzle", "fog") if w in c), None)
    advice = []
    if temp is not None and temp <= 1 and (precip or (hum or 0) >= 85):
        advice.append("Near or below freezing with moisture: watch for black ice, especially on ramps and lot entrances.")
    elif temp is not None and temp <= 1:
        advice.append("Near or below freezing: bridges and shaded lots can be icy.")
    if precip in ("snow", "sleet", "freezing rain"):
        advice.append(f"{precip.capitalize()} reported: leave extra time and braking distance.")
    elif precip in ("rain", "drizzle"):
        advice.append("Wet roads: allow extra braking distance.")
    if vis is not None and vis < 1600:
        advice.append(f"Low visibility ({vis / 1000:.1f} km): use headlights and slow down.")
    elif precip == "fog":
        advice.append("Fog reported: use low beams.")
    if (gust or 0) >= 50 or (wind or 0) >= 40:
        advice.append("Strong wind: expect gusts on open stretches like the Stadium and Center for Tomorrow lots.")
    if not advice:
        advice.append("No weather concerns for driving right now.")
    f = lambda c_: round(c_ * 9 / 5 + 32) if c_ is not None else None
    return {
        "temperature_c": round(temp, 1) if temp is not None else None, "temperature_f": f(temp),
        "feels_like_c": round(feels, 1) if feels is not None else None, "feels_like_f": f(feels),
        "condition": cond, "precipitation": precip,
        "wind_kph": round(wind) if wind is not None else None, "wind_mph": round(wind / 1.609) if wind is not None else None,
        "gust_kph": round(gust) if gust is not None else None, "gust_mph": round(gust / 1.609) if gust is not None else None,
        "wind_dir": _COMPASS[int((wdir % 360) / 45 + 0.5) % 8] if wdir is not None else None,
        "visibility_km": round(vis / 1000, 1) if vis is not None else None,
        "visibility_mi": round(vis / 1609.34, 1) if vis is not None else None,
        "humidity_pct": round(hum) if hum is not None else None,
        "advice": advice, "observed_at": newest.get("timestamp"), "station": settings.nws_station,
    }


def current(force: bool = False) -> dict:
    if not settings.weather_live_enabled:
        data = {"alerts": [], "observation": None, "errors": ["Live weather disabled (WEATHER_LIVE_ENABLED=false)"], "source": "unavailable"}
    else:
        # Stale-while-revalidate: never block a request on api.weather.gov once warm.
        data = nws_cache.get(force=force) or {"alerts": [], "observation": None,
                                              "errors": ["Weather not loaded yet"], "source": "unavailable"}

    alerts = list(data["alerts"])
    observation = data["observation"]
    demo_active = bool(_demo["alert"] and _demo["until"] and _demo["until"] > utcnow())
    if demo_active:
        alerts = [_demo["alert"], *alerts]
        observation = _demo["observation"]

    status_label = {
        "nws_live": "National Weather Service: live",
        "unavailable": "National Weather Service unreachable: no alert data, none assumed",
    }[data["source"]]
    if demo_active:
        status_label += " + DEMO storm alert injected"
    return {
        "source": data["source"],
        "source_label": status_label,
        "errors": data["errors"],
        "observation": observation,
        "observation_is_demo": demo_active,
        "alerts": alerts,
        "winter_alert_active": any(a["winter"] for a in alerts),
        "demo_active": demo_active,
        "fetched_at": iso(utcnow()),
    }


nws_cache = SWRCache("nws", lambda: _fetch_live(), ttl_s=300)


def inject_demo_storm(hours: float = 3.0) -> None:
    now = utcnow()
    _demo["alert"] = {
        "id": "demo-lake-effect", "event": "Lake Effect Snow Warning (DEMO)",
        "headline": "DEMONSTRATION ONLY: simulated Lake Effect Snow Warning for Erie County. Not an NWS product.",
        "severity": "Moderate", "onset": iso(now), "ends": iso(now + timedelta(hours=hours)),
        "winter": True, "demo": True, "source": "WeParkit demo",
    }
    _demo["observation"] = {**driver_observation([{
        "temperature": {"value": -6.0}, "windChill": {"value": -13.0}, "windSpeed": {"value": 32.0}, "windGust": {"value": 52.0},
        "windDirection": {"value": 250}, "visibility": {"value": 1200}, "relativeHumidity": {"value": 92},
        "textDescription": "Light snow (DEMO)", "timestamp": iso(now)}]), "station": "DEMO"}
    _demo["until"] = now + timedelta(hours=hours)


def clear_demo() -> None:
    _demo.update(alert=None, until=None, observation=None)
