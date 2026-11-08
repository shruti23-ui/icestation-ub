"""Driver weather card: NWS reports -> temperature, wind, visibility and plain advice."""
from app.services.weather import driver_observation


def rep(**kw):
    base = {"textDescription": "Cloudy", "timestamp": "2026-11-08T09:50:00+00:00"}
    for k, v in kw.items():
        base[k] = {"value": v} if not isinstance(v, str) else v
    return base


def test_units_direction_and_calm_advice():
    o = driver_observation([rep(temperature=6, windChill=2.8, windSpeed=16.7, windDirection=270, visibility=16093, relativeHumidity=87)])
    assert o["temperature_f"] == 43 and o["feels_like_c"] == 2.8 and o["wind_mph"] == 10 and o["wind_dir"] == "W"
    assert o["visibility_mi"] == 10.0 and o["advice"] == ["No weather concerns for driving right now."]


def test_missing_temperature_taken_from_previous_report():
    o = driver_observation([rep(windSpeed=10), rep(temperature=-2, relativeHumidity=90)])
    assert o["temperature_c"] == -2 and any("black ice" in a for a in o["advice"])


def test_snow_low_visibility_and_gusts_warn_driver():
    o = driver_observation([rep(temperature=-4, textDescription="Light Snow", visibility=900, windSpeed=30, windGust=60)])
    text = " ".join(o["advice"])
    assert o["precipitation"] == "snow" and "Snow reported" in text and "Low visibility" in text and "Strong wind" in text
