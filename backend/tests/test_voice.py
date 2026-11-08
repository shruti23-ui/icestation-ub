import httpx
import pytest

from app.services import voice


def _rec(**best):
    b = {"name": "Jarvis A", "expected_open_spaces": 42, "recommended_departure": "09:40", "ice_buffer_minutes": 0,
         "data_source": "seed_model", "route": {"status": "unverified"}}
    b.update(best)
    return {"destination": "Davis Hall", "arrival_time": "10:10", "best": b, "backup": {"name": "Stadium Lot"}, "explanation": ""}


def test_briefing_text_is_honest_and_specific():
    t = voice.briefing_text(_rec())
    assert "Jarvis A" in t and "42" in t and "10:10 AM" in t and "Leave by" not in t
    assert "Stadium Lot" in t
    assert "estimate" in t  # seed-model numbers are never presented as live data
    assert "reserved" not in t.lower() and "safe" not in t.lower()


def test_briefing_text_mentions_ice_and_hazards():
    t = voice.briefing_text(_rec(ice_buffer_minutes=12, data_source="crew_scan", route={"status": "blocked"}))
    assert "12 extra minutes" in t and "curb ramp" in t and "estimate" not in t


def test_briefing_text_without_a_lot():
    assert "couldn't find" in voice.briefing_text({"destination": "Davis Hall", "best": None, "backup": None, "explanation": ""})


def test_voice_disabled_without_key(client):
    assert client.get("/api/voice/status").json()["enabled"] is False
    assert client.get("/api/health").json()["voice_enabled"] is False
    r = client.get("/api/voice/briefing")
    assert r.status_code == 503 and "ELEVENLABS_API_KEY" in r.json()["detail"]


def test_text_only_scripts_work_without_key(client):
    assert "Davis Hall" in client.get("/api/voice/briefing", params={"text_only": True}).json()["text"]
    assert "spaces open" in client.get("/api/voice/lot/1", params={"text_only": True}).json()["text"]
    assert client.get("/api/voice/lot/999").status_code == 404


def test_synthesize_calls_elevenlabs_and_caches(client, monkeypatch):
    calls = []

    def fake_post(url, **kw):
        calls.append((url, kw))
        return httpx.Response(200, content=b"ID3fake-mp3", request=httpx.Request("POST", url))

    monkeypatch.setattr(voice.settings, "elevenlabs_api_key", "test-key")
    monkeypatch.setattr(voice.httpx, "post", fake_post)
    voice._cache.clear()
    r = client.get("/api/voice/lot/1")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3fake-mp3"
    assert calls[0][1]["headers"]["xi-api-key"] == "test-key"
    assert voice.settings.elevenlabs_voice_id in calls[0][0]
    client.get("/api/voice/lot/1")
    assert len(calls) == 1  # identical text served from cache


def test_synthesize_reports_bad_key(monkeypatch):
    monkeypatch.setattr(voice.settings, "elevenlabs_api_key", "bad")
    monkeypatch.setattr(voice.httpx, "post", lambda url, **kw: httpx.Response(401, request=httpx.Request("POST", url)))
    voice._cache.clear()
    with pytest.raises(voice.VoiceError) as e:
        voice.synthesize("hello")
    assert e.value.status == 502 and "API key" in str(e.value)


def test_drive_intro_greets_then_briefs_then_lists_options(client):
    t = client.get("/api/voice/briefing", params={"text_only": True, "intro": True}).json()["text"]
    assert t.startswith("Hey, I'm Parky.") and "Davis Hall" in t and t.rstrip().endswith("Swipe down to ask me a question.") and "Long-press" not in t
    assert t.index("Davis Hall") < t.index("Tap to hear it again")
    assert "Parky" not in client.get("/api/voice/briefing", params={"text_only": True}).json()["text"]


def test_demo_numbers_are_called_demo_when_spoken():
    t = voice.briefing_text(_rec(data_source="demo"))
    assert "demo numbers" in t and "student report" not in t


def test_drive_mode_lines_are_short_and_have_no_data_footnotes(client):
    t = voice.drive_briefing_text(_rec(data_source="demo"))
    assert t.startswith("For Davis Hall, park at Jarvis A. About 42 spaces open.") and "Stadium Lot" in t
    assert "demo" not in t.lower() and "estimate" not in t.lower() and "reserved" not in t.lower()
    intro = client.get("/api/voice/briefing", params={"text_only": True, "intro": True}).json()["text"]
    assert intro.startswith("Hey, I'm Parky.") and "demo" not in intro.lower() and "estimate" not in intro.lower()
    lot = client.get("/api/voice/lot/1", params={"text_only": True, "drive": True}).json()["text"]
    assert "spaces open" in lot or lot.endswith("is full.")
    ans = client.post("/api/voice/ask", data={"text": "where should I park", "drive": "true"}).json()["answer"]
    assert "estimate" not in ans.lower() and "demo" not in ans.lower()


def test_wake_phrase_matching():
    from app.services.copilot import split_wake
    assert split_wake("Hey Parky, where should I park?") == (True, "where should I park?")
    assert split_wake("hi parkie is jarvis b full") == (True, "is jarvis b full")
    assert split_wake("Hey parking.") == (True, "")
    assert split_wake("so I told him to park at Jarvis")[0] is False
    assert split_wake("")[0] is False
    assert split_wake("(engine noise) Um, hey Parky, is Jarvis A full?") == (True, "is Jarvis A full?")
    assert split_wake("Hey park key where do I park")[0] is True
    assert split_wake("Okay, Perky.") == (True, "")
    assert split_wake("the parking lot was full again today")[0] is False     # plain "parking" never wakes it


def test_ask_with_wake_ignores_background_and_answers_wake(client):
    r = client.post("/api/voice/ask", data={"text": "turn up the radio", "wake": "true"}).json()
    assert r["ignored"] is True and r["speech_path"] is None
    r = client.post("/api/voice/ask", data={"text": "Hey Parky", "wake": "true"}).json()
    assert r["listen_again"] is True and r["answer"].startswith("Yes")
    r = client.post("/api/voice/ask", data={"text": "Hey Parky where should I park", "wake": "true", "drive": "true"}).json()
    assert not r["ignored"] and r["intent"] == "best" and r["speech_path"]


def test_wake_phrase_found_mid_conversation():
    from app.services.copilot import split_wake
    assert split_wake("Later, but yeah, speak in first. Hey, Parkie. Hey, Parkie") == (True, "")
    assert split_wake("we were talking and then hey parky is jarvis b full") == (True, "is jarvis b full")
    assert split_wake("I hate the party at the parking garage")[0] is False
