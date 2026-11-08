# CLAUDE.md: WeParkit

Hackathon prototype (UB Hacking 2026, theme Deep Space). Satellite-triggered winter parking and
walkway-safety app for UB North Campus. Read README.md for the product pitch and run steps.

## Layout
- `backend/`: FastAPI + SQLAlchemy 2 + SQLite + OpenCV. Python 3.11+. **Complete, 120 tests pass.**
- `mobile/`: Expo SDK 58, React Native 0.88, React 19.3, expo-router (file routes in `app/`), TypeScript strict.
  **Type-checks clean and bundles for Android (`npx expo export --platform android`). Not yet run on a device.**
- The original spec asked for a React web frontend; the team switched to Expo to match the pitch deck. There is no web frontend.

## Added 2026-11-07 (WeParkit)
- **Run the API with `python -m scripts.serve`** (backend/): supervisor that restarts uvicorn on crash, and on hang
  (watchdog on `/api/live`). Uses `--timeout-keep-alive 75`. Avoid `--reload` on Windows (orphaned workers keep the port).
- Resilience (`app/main.py`): global handlers turn every error into JSON with `request_id`; SQLite `OperationalError` ->
  503 + Retry-After; 20 MB body cap; thread pool 100; startup retries DB and never aborts on samples/cache warm-up;
  `/api/health` reports `degraded` components instead of failing. SQLite runs in WAL with busy_timeout (`database.py`).
  External APIs (NOAA, NWS) are behind a stale-while-revalidate cache (`services/swr.py`): requests never wait on them.
- **Auth** (`routers/auth.py`, `services/auth.py`): email + password for `AUTH_EMAIL_DOMAINS` (default
  buffalo.edu, gmail.com); signup signs you straight in. scrypt passwords, SHA-256-stored Bearer tokens (30 d),
  5-failure login lockout. Optional email codes (`AUTH_VERIFY_EMAIL=true`; SMTP_* to send, else `dev_code` in dev).
  Google sign-in: `POST /api/auth/google` verifies the ID token with Google (aud = `GOOGLE_CLIENT_IDS`); button hidden
  until configured, and it can't work in Expo Go (Google rejects exp:// redirects). `AUTH_REQUIRED=true` makes
  check-in/out/profile require a token. App: `src/auth.tsx` + `AuthScreen` gate everything; token in
  expo-secure-store (localStorage on web).
- **Parked / not parked** (`services/sessions.py`, `src/parking.tsx`, `ParkingStatus.tsx`): check-in/out move the lot's
  occupied count by one car; "Yes, I'm parked" uses the lot you're in or the nearest within 400 m; foreground
  auto-detect (driving -> still in an outline = check in; driving away = check out) in `src/parkDetect.ts`.
- **All UB lots**: `python -m scripts.import_osm_lots` builds `app/ub_lots.json` (34 named UB-operated lots, real OSM
  outlines, capacities estimated at ~32.7 m2/stall calibrated on OSM-tagged lots; CFT 400 is tagged). Names cross-checked
  with maps.buffalo.edu. Fixed: Jarvis A outline was Jarvis B; Center for Tomorrow is on Service Center Rd (south).
  Original 4 lots keep slugs/ids 1-4; startup sync inserts new lots and updates config fields.
- **General object detector** (`services/vision/coco.py`): YOLOv4-tiny pre-trained on COCO (80 classes) via
  `cv2.dnn` (no PyTorch), on the NVIDIA GPU via OpenCL when `VISION_DEVICE=auto|gpu` (RTX 2050: ~30 ms vs ~38 ms CPU;
  warmed at startup since the first GPU pass compiles kernels ~6 s). Weights in `backend/data/models/` (gitignored; `python -m scripts.download_models`). Live
  frames: model names objects; issue heuristics run only for parking scenes (model sees a vehicle, or mostly
  pavement with no indoor objects). Scans: `get_detector()` = YOLOv8 > YOLOv4-tiny > OpenCV blobs, heuristics fill gaps.
- **Issue detector** (`services/vision/issues.py`, tested in `tests/test_issues.py`): local OpenCV, no AI, ~40-70 ms.
  Boxes + verdict for what makes a space unusable: car (3 finders: blob, rectangle body, outline + dark windows for
  silver/white cars), ice/slush (snow detection removed 2026-11-08), standing water/black ice, cone/barrier (tapered, never on a car), grey
  object in the way. Drives the live camera (`POST /api/parking/live-detect`, `LIVE_VISION_PROVIDER=opencv|gemini`),
  adds `issues`/`verdict` to scans and hazard reports, and draws issue boxes on the annotated image.
- Voice co-pilot is conversational: `conversation_id` memory, follow-ups, "thanks" ends, free-form -> Gemini
  (`services/llm.py`) with live data. App `src/copilot.ts`: VAD on recorder metering (adaptive noise floor).

## Commands
```bash
# backend (from backend/, venv active)
python -m scripts.serve                    # supervised API (restarts on crash/hang), port 8000
python -m pytest -q
python -m scripts.init_db --reset          # wipe + reseed
python -m scripts.generate_samples         # rebuild synthetic sample photos

# mobile (from mobile/)
npx expo start                              # Expo Go
npx tsc --noEmit
npx expo install --fix                      # if Expo warns about versions
```

## Architecture rules (keep these)
- **Honesty labels are a product requirement.** Anything simulated is labelled in data *and* UI:
  `is_demo` flags, `source` = `simulated` / `goes19_live` / `archived_frames`, DEMO tags, "SIMULATED SATELLITE FEED".
  Never present seed occupancy as live UB data. Never say a spot is reserved. Never call a route "safe".
  **Exception (owner's decision, 2026-11-08): Drive mode** speaks/shows short driver lines with no data-source
  footnotes (`drive_briefing_text`, `drive_lot_text`, `?drive=true`, `drive` on /ask) to avoid distraction.
  Everywhere else keeps the labels.
- **Vehicle count ≠ open spaces.** Open spaces come from `services/vision/spaces.py`
  (calibrated stall regions → area heuristic → Gemini). Keep it that way.
- **Privacy first:** `vision/privacy.py` runs before any image is written. Raw uploads never touch disk.
- **Image storage** (`services/media_store.py`, `GET /api/media`): hackathon default `CAPTURE_SAVE=true` keeps
  privacy-blurred, annotated photos + JSON in `backend/data/captures/<date>/` ONLY when the student taps Capture in the live camera (preview frames are never saved; gitignored) and
  `MEDIA_RETENTION_HOURS=0` (never delete). Production: `CAPTURE_SAVE=false`, `MEDIA_RETENTION_HOURS=24` (hourly
  sweep of captures/ and uploads/).
- **Pure logic is unit-tested:** `services/ice_season.py` and `services/recommendation.py` take no DB.
  Add tests in `backend/tests/` when changing them.
- **Manual override ≠ automatic decision.** `SystemState.decision_source` is one of
  `satellite_engine | demo_storm_replay | manual_override`; the UI shows which.
- Expiry is enforced on read (`expires_at > now`) plus a 30 s loop in `main.py` that pushes WebSocket events.
- Realtime: `services/realtime.py` `hub.publish(event)` with events
  `lots | state | hazards | notifications | crew | satellite`; the mobile store refetches that resource.
  Polling every 15 s is the fallback.
- Web (`npx expo start --web`) works: `CampusMap.web.tsx` is a DOM-SVG schematic because react-native-maps (and react-native-svg pressable groups) crash in the browser.
- Mobile design system: neutral dark, system font, one accent. `useStore().c` is the palette (`src/theme.ts`);
  `c.accent` flips blue → amber in ice season. Use the primitives in `mobile/src/components/ui.tsx`
  (Screen, Section, Card, List/ListRow, T, Button, Badge, DemoTag, Banner, Metrics, Field, Toggle...). Plain,
  sentence-case copy: no space role-play wording (mission control, cadet, beam, orbit) in UI or API strings.
- All displayed times are New York time via `mobile/src/campusTime.ts` (live clock; never the device timezone).
- Tabs: Overview · Capture (route `scan`) · Reports (route `ice`) · Weather (route `orbit`) (renamed 2026-11-08; Plan tab removed; top-3 recommendation lives on Overview via `components/Choice.tsx`). Satellite tab auto-analyzes each new live GOES-19 frame (on open + every 5 min) and hides simulated runs. Profile (`crew.tsx`) opens from the header, not the tab bar.
- Voice: ElevenLabs key is **server-only** (`ELEVENLABS_API_KEY`). `services/voice.py` builds the spoken text itself
  (no open TTS proxy) and caches audio; mobile `src/voice.ts` streams `/api/voice/*` via expo-audio and falls back
  to the device voice (expo-speech) reading the same server script when ElevenLabs is off or unreachable.
- Directions: `directionsUrl()` in `src/api.ts` opens Google Maps driving directions; `LotSheet` on both maps.
- Drive mode (`app/drive.tsx`): full-screen gesture pad (tap / swipe ←→↑↓; long-press and shake removed 2026-11-08), keep-awake, haptics.
  Swipe down listens with VAD (live waveform; stops after a ~1.3 s pause) → `/api/voice/ask`. Questions are
  swipe-down only ("Hey Parky" background listening was removed 2026-11-08; `wake=true` on /ask is unused). Intents are parsed by `services/copilot.py` (pure, tested, keyword
  rules, not an LLM); answers are server-written. Proactive alerts on ice-season flips and when the best lot fills.
  `src/voice.ts` falls back to expo-speech (device voice) reading the server script if ElevenLabs is off/unreachable.
- API base URL: `mobile/src/config.ts` (EXPO_PUBLIC_API_URL → Metro host IP:8000 → emulator fallbacks).

## Key endpoints
`GET /api/health` · `GET /api/parking/lots` · `POST /api/parking/scan` (multipart: lot_id + file | sample_id) ·
`POST /api/parking/report` (confirm/correct a scan, or manual occupancy_pct) · `GET /api/parking/locate?lat&lng&accuracy_m` (GPS → lot) · `GET /api/parking/recommendations` ·
`POST /api/parking/leave` · `GET /api/weather/current` · `GET /api/satellite/status` · `POST /api/satellite/analyze` ·
`POST /api/satellite/demo-storm` · `POST /api/state/mode` (manual override, null clears) · `POST /api/demo/reset` ·
`GET /api/hazards` · `GET /api/hazards/routes` · `POST /api/hazards/report` · `POST /api/hazards/{id}/vote|clear` ·
`POST /api/crew/me` · `GET /api/crew/leaderboard` · `POST /api/crew/assist` · `GET /api/notifications` ·
`GET /api/voice/status|briefing|lot/{id}|alert?kind=ice_on|ice_off|lot_full` (audio/mpeg; `text_only=true` for the script) ·
`POST /api/voice/ask` (audio → ElevenLabs Scribe STT, or `text`) → `GET /api/voice/say/{token}` · `WS /ws`.
Full docs at `/docs`.

## Not done yet / next tasks (in priority order)
1. **Run on a real phone in Expo Go** and fix any runtime issues (layout on small screens, map rendering,
   image picker upload via RN FormData, WebSocket on device). Verify the bottom tab bar doesn't cover content.
2. **Calibrate live GOES-19:** confirm `GOES_SECTOR_URL` listing format, then set `BUFFALO_PX_X/Y` and
   `KM_PER_PX` for the 600x600 Northeast sector. Drop real lake-effect frames into `backend/data/storm_frames/`
   (named `YYYYDDDHHMM_*.jpg`) so the replay uses archived real imagery.
3. **Test YOLOv8 path:** `pip install -r requirements-ml.txt`, set `VISION_PROVIDER=yolo`, run a real lot photo.
4. **Lot identification (pitch slide 4):** GPS part DONE: `services/geo.py` (pure, tested) + `/api/parking/locate`
   + `mobile/src/location.ts` (`useLotLocator`) on Scan and Dock; a manual pick always overrides GPS.
   All 34 lots use real OSM outlines (`app/ub_lots.json` via `scripts/import_osm_lots.py`, ODbL attribution).
   Remaining backups: lot-sign OCR via Gemini, ORB reference-photo matching. Capacities are still area estimates.
5. **Class-schedule fill model (pitch slide 5):** replace `hourly_profile` seed curves with 15-minute predictions
   from UB's public class schedule near each lot.
6. Push notifications (expo-notifications) for Leaving now / Stuck in orbit / ice season.
7. Optional: Firestore with TTL (pitch slide 8) instead of SQLite; the models use portable types.
8. Pin the Python dependency versions after a clean install (`pip freeze`).

## Gotchas
- `seed.init()` re-syncs lot lat/lng/polygon from `campus.py` into an existing DB on startup (geometry is config).
- Hazard votes: one per user, except confirm → clear may flip once (conditions change); flips award no points.
- Windows: venv python is `backend\.venv\Scripts\python.exe`. Windows Firewall blocks phones on Public networks:
  allow inbound TCP 8000 and 8081 (admin PowerShell) or use a hotspot / tunnel.
- `expo start --tunnel` only tunnels Metro; set `EXPO_PUBLIC_API_URL` to a public backend URL in that case.
- Keep `--timeout-keep-alive 75` (> the app's 15 s poll). With uvicorn's 5 s default, phones reuse pooled connections the
  server already closed; on eduroam the RST is dropped and requests hang until timeout ("Can't reach the backend").
  The app also retries GETs once on a fresh connection (`src/api.ts`).
- Phones can't reach `localhost`; run uvicorn with `--host 0.0.0.0`. Keep `--timeout-graceful-shutdown 2`: without it `--reload` hangs while phones hold the /ws socket open.
- Expo web from another device: `config.ts` uses `window.location.hostname:8000`; CORS allows private LAN origins via `CORS_ORIGIN_REGEX`.
- Campus Wi-Fi may block device-to-device traffic; use a hotspot or tunnels.
- Photo uploads (`upload()` in `mobile/src/api.ts`): native Expo `uploadAsync` multipart (photo shrunk to 1600 px) ->
  on failure, base64 pieces of 48 KB to `POST /api/parking/upload-chunk` (memory only, `services/uploads.py`) and the
  endpoint gets `upload_id`. eduroam passed small requests but dropped phone photo uploads. Client failures are
  logged to the server via `POST /api/parking/client-log` (look for `weparkit.client` in the API log).
- OpenCV 5 removed `CascadeClassifier`; `requirements.txt` installs 4.x so Haar face/plate blur works.
  The privacy module degrades gracefully either way.
- `SIM_CLOCK=09:40` in `backend/.env` makes the seed model behave like a weekday morning for night-time demos.
- Expo SDK 58 tab bars use `navigateToTab(route.key)` (see `app/(tabs)/_layout.tsx`), not `navigation.navigate`.
- `react-native-maps` prop is `showsPointsOfInterests` (plural) in this version.
