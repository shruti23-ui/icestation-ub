# WeParkit 

**Parking that knows it's winter in Buffalo.** UB Hacking 2026 · Theme: Deep Space

Crowd-sourced parking and walkway safety for UB North Campus. Students scan lots, AI estimates the
open spaces, and a NOAA GOES-19 weather satellite switches the whole app into ice season before
the snow arrives.

```
weparkit/
├── backend/          Python FastAPI + SQLAlchemy + SQLite + OpenCV   (complete, 120 tests passing)
│   ├── app/
│   │   ├── main.py             app, WebSocket /ws, media, expiry loop
│   │   ├── models.py           11 tables + SystemState
│   │   ├── campus.py           lots, buildings, hazard spots (seed config, editable)
│   │   ├── routers/            parking · orbital (satellite/weather/system) · community (hazards/crew/notifications) · voice
│   │   └── services/
│   │       ├── vision/         detectors (YOLOv8 | OpenCV), stall-region analysis, Gemini, privacy blur
│   │       ├── satellite.py    GOES-19 fetch, band detection, optical flow, simulated feed
│   │       ├── weather.py      NWS alerts + KBUF observation
│   │       ├── voice.py        ElevenLabs spoken briefings (key stays server-side)
│   │       ├── ice_season.py   decision engine (pure, tested)
│   │       └── recommendation.py  docking engine (pure, tested)
│   ├── scripts/        init_db.py, generate_samples.py
│   ├── data/samples/   bundled SYNTHETIC lot + walkway photos with stall maps
│   └── tests/
├── mobile/           Expo SDK 58 · React Native · expo-router · TypeScript
│   ├── app/(tabs)/     index (Overview) · dock (Plan) · scan · ice (Walkways) · orbit (Satellite) · crew (Profile, via header)
│   ├── app/demo.tsx    guided demo runner
│   └── src/            api client, store (polling + WebSocket), theme, components
├── CLAUDE.md         handoff notes for Claude Code
└── .env.example
```

## Run it

You need Python 3.11+, Node 20+, and the **Expo Go** app on your phone (same Wi-Fi as your laptop).

### 1. Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                 # optional, everything works without keys
python -m scripts.init_db
python -m scripts.serve      # supervised: auto-restarts on crash/hang (or: uvicorn app.main:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75)
```
`--host 0.0.0.0` matters: your phone has to reach the laptop. API docs: http://localhost:8000/docs

### 2. Mobile app
```bash
cd mobile
npm install
npx expo install --fix               # aligns native package versions with your Expo CLI
npx expo start
```
Scan the QR code with Expo Go (Android) or the Camera app (iOS).
The app finds the backend automatically at `http://<your-laptop-IP>:8000`.
If it can't (campus Wi-Fi often isolates devices), set `EXPO_PUBLIC_API_URL` in `mobile/.env`
or run `npx expo start --tunnel` and expose the backend with a tunnel too.

In VS Code: **Terminal → Run Task → "Backend: install"**, then **"Run everything"**.

### Tests
```bash
cd backend && python -m pytest -q        # 120 tests: recommendation, ice season, GPS lots, auth, voice co-pilot, resilience, API flows
cd mobile && npx tsc --noEmit
```

## What works vs. demo mode

| Feature | Status |
|---|---|
| Parking dashboard, snow-adjusted capacity, confidence, live updates (WebSocket + polling) | Works |
| Photo scan → vehicle detection → stall-level open/snow-blocked estimate → confirm/correct → broadcast | Works (OpenCV detector by default) |
| Privacy blur before storage | Works (detector people, Haar face/plate on OpenCV 4.x, plate zones, skin-tone fallback) |
| YOLOv8 detection | Code path written, **not tested here**: `pip install -r requirements-ml.txt` |
| Gemini Vision (snow, plowing, spaces, hazard labels) | Works when `GEMINI_API_KEY` is set; falls back to OpenCV |
| GOES-19 band detection + optical flow + ETA | Works; live feed needs internet and **pixel calibration** of UB (`BUFFALO_PX_X/Y`) |
| NWS alerts + observation | Live when reachable; status shown honestly when not |
| Ice-season decision engine (auto, demo replay, manual override, all labelled) | Works |
| Docking recommendations, leave-by time, fill forecast, accessible routing | Works |
| Hazard reports, AI classification, 6 h expiry, confirm/clear voting, wheelchair hard stops | Works |
| Points, leaderboard, Leaving now, Request help | Works |
| Parking map with open-space counts; tap a lot → Google Maps driving directions | Works (Google Maps tiles on Android; Apple Maps tiles in iOS Expo Go; schematic on web) |
| Spoken briefings (ElevenLabs): recommendation and per-lot summary | Works when `ELEVENLABS_API_KEY` is set; buttons hidden otherwise |
| Drive mode: gesture pad (tap / swipe / long-press / shake), voice questions via ElevenLabs speech-to-text, proactive ice-season and lot-full alerts | Works; device-voice fallback without a key |
| Accounts: email + password (UB or Gmail), signed in on signup; optional Google sign-in | Works; Google needs `GOOGLE_CLIENT_IDS` and doesn't work inside Expo Go |
| "Yes, I'm parked" / "I left" with GPS lot detection (nearest lot within 400 m) and live count updates | Works; auto-detect only while the app is open |
| Conversational voice co-pilot (follow-ups, "thanks" ends it, free-form via Gemini) | Works with ElevenLabs + Gemini keys |
| Supervised API (`python -m scripts.serve`): restarts on crash or hang; errors return JSON, never crash the process | Works |
| GPS lot identification (point-in-outline, accuracy-aware radius, manual override) | Works (`/api/parking/locate`); lot-sign OCR backup not built |
| Lot outlines | All 34 UB North Campus lots from OpenStreetMap (© OpenStreetMap contributors, ODbL), names checked against maps.buffalo.edu; capacities are area-based estimates except Center for Tomorrow (400, OSM-tagged) |
| Demo storm replay | **Demo**: simulated frames (or real frames in `backend/data/storm_frames/`) + DEMO NWS alert |
| Sample photos | **Demo**: synthetic, watermarked |
| Lot capacities, hourly occupancy | **Seed estimates**, not UB data |

## Optional keys
- `GEMINI_API_KEY`: better scans and hazard labels (Google AI Studio).
- `ELEVENLABS_API_KEY`: spoken parking briefings ("Listen" buttons). Optional `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`.
  The key lives only in `backend/.env`; the app streams MP3 from `/api/voice/briefing` and `/api/voice/lot/{id}`.
- NOAA GOES-19 and NWS need **no key**, just internet.

## Judge demo script (90 seconds)
1. **Overview.** "Four North Campus lots, snow-adjusted capacity, confidence on every number." Tap a lot on the map → **Directions**.
2. Tap **Demo → Start.** Narrate as steps tick:
   - "A student scans Jarvis A. Cars counted, stalls classified: open, occupied, buried in snow. People and plates are blurred before anything is stored."
   - "Submitted. Every phone at this table just updated."
   - "Now the deep-space part: GOES-19 frames, labelled simulated for the demo. OpenCV finds a lake-effect band, optical flow tracks it toward Buffalo, ETA under 60 minutes. With the NWS warning, the satellite engine flips ice season on by itself."
   - "Capacity drops, leave-by times pad, and an ice pin appears between Jarvis A and Davis Hall."
3. Close the demo: **the accent turns amber** for ice season. Open **Plan**: new best lot and leave-by time; tap **Listen** for the spoken briefing.
4. Open **Walkways**: toggle a route check; "blocked ramps are hard stops, and we never call a route safe without data."
5. Hand a judge a phone: **Scan → Camera** on anything, or **Leaving now**.
6. **Reset data** for the next judge.

Honesty notes for judges: WeParkit predicts and informs; it never reserves a space.
Occupancy is from student reports or a seed model, not live UB Parking data.
