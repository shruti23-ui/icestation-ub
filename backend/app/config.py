"""Central configuration. Every value can be overridden via environment variables (.env)."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(BASE_DIR / ".env"), extra="ignore")

    app_name: str = "WeParkit"
    database_url: str = f"sqlite:///{(DATA_DIR / 'weparkit.db').as_posix()}"
    cors_origins: str = "http://localhost:8081,http://127.0.0.1:8081"  # Expo web; native apps ignore CORS
    # Expo web opened from another device on the LAN (e.g. http://192.168.1.20:8081). Private ranges only.
    cors_origin_regex: str = (r"^https?://(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+"
                              r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$")

    # --- Vision -------------------------------------------------------------
    # auto = YOLOv8 if ultralytics + weights load, else OpenCV heuristic detector.
    # Gemini (if a key is set) is layered on top for snow/plowing/space judgement.
    # Options: auto | yolo | opencv
    vision_provider: str = "auto"
    yolo_weights: str = "yolov8n.pt"
    yolo_confidence: float = 0.25
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash"
    # Gemini 3 "thinking" effort. "low" keeps a scan around 3 s; empty omits it (needed for 2.x models).
    gemini_thinking_level: str = "low"
    # Live camera boxes on the Capture tab: "opencv" = local issue detector (fast, ~50 ms, no AI),
    # "gemini" = Gemini object detection (~4 s per frame, richer labels; falls back to opencv).
    live_vision_provider: str = "opencv"
    # Where the general object detector runs: "gpu" (OpenCL, e.g. the laptop's NVIDIA RTX), "cpu", or "auto"
    # (GPU when OpenCV sees an OpenCL GPU, else CPU). The GPU is warmed up at startup (first run compiles kernels).
    vision_device: str = "auto"
    # Image storage (services/media_store.py). Hackathon: keep privacy-blurred live frames in data/captures/ and never
    # auto-delete. Production: CAPTURE_SAVE=false and MEDIA_RETENTION_HOURS=24 (or 1) for short-term caching only.
    capture_save: bool = True   # frames are saved only when the student taps Capture
    media_retention_hours: float = 0.0

    # --- Satellite / weather ------------------------------------------------
    satellite_live_enabled: bool = True
    goes_sector_url: str = "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/SECTOR/ne/13/"
    goes_image_size: str = "600x600"
    # Pixel position of UB North Campus in the GOES sector image + approximate scale.
    # Defaults are rough guesses for the 600x600 Northeast sector: calibrate before trusting ETAs.
    buffalo_px_x: int = 230
    buffalo_px_y: int = 330
    km_per_px: float = 2.0
    nws_user_agent: str = "WeParkit/1.0 (hackathon prototype; contact@example.com)"
    nws_point_lat: float = 43.0008
    nws_point_lon: float = -78.7890
    nws_station: str = "KBUF"
    weather_live_enabled: bool = True
    external_timeout_s: float = 4.0

    # --- Voice (ElevenLabs) ---------------------------------------------------
    # Server-side only: the key never ships in the mobile bundle. Empty = voice briefings disabled.
    elevenlabs_api_key: str = ""
    # Default: "Sarah", a soft, gentle female voice. Any ElevenLabs voice id works.
    elevenlabs_voice_id: str = "EXAVITQu4vr4xnSDxMaL"
    # Calm, steady delivery for spoken instructions (higher stability = gentler, less dramatic).
    elevenlabs_stability: float = 0.7
    elevenlabs_similarity: float = 0.8
    elevenlabs_speed: float = 1.1   # 0.7-1.2; 1.0 is the voice's natural pace
    elevenlabs_model: str = "eleven_flash_v2_5"
    elevenlabs_stt_model: str = "scribe_v1"   # speech-to-text for the voice co-pilot

    # --- Accounts (email + password login) ----------------------------------
    # Comma-separated domains allowed to sign up. Default: UB and Gmail accounts.
    auth_email_domains: str = "buffalo.edu,gmail.com"
    # Email verification codes. Off = simple signup (email + password -> signed in immediately).
    auth_verify_email: bool = False
    # Google sign-in: comma-separated OAuth client IDs (web / Android / iOS) whose ID tokens we accept.
    # Empty = the "Continue with Google" button is hidden. Client IDs are public; no secret is needed.
    google_client_ids: str = ""
    auth_token_days: int = 30
    # When true, endpoints that act for a student (check-in/out, profile) require a login token.
    # Off by default so the demo and existing clients keep working; the app itself always logs in.
    auth_required: bool = False
    # Verification codes are emailed when SMTP is configured. Without SMTP, dev mode returns the code
    # in the API response (and the app labels it DEMO) so signup still works at a hackathon table.
    auth_dev_codes: bool = True
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "WeParkit <no-reply@weparkit.local>"

    # --- Lots ---------------------------------------------------------------
    # Project setting: lot capacities are scaled into this range by relative lot size (the biggest lots get
    # the max, the smallest the min), rounded to `step`. The OSM area estimate is kept in app/ub_lots.json.
    # Set lot_capacity_max=0 to use the raw estimates instead.
    lot_capacity_min: int = 15
    lot_capacity_max: int = 30
    lot_capacity_step: int = 5
    # Demo examples: these lots show as FULL (labelled "demo") until a real student report replaces them.
    # Comma-separated slugs; empty = none.
    demo_full_lots: str = "jarvis-a,ketter-lot,governors-c"
    # Demo: give every lot its own occupancy level (12-88%, fixed per lot) when the time-of-day model would show
    # them all nearly empty (nights, weekends). Labelled "Demo data"; a real student report replaces it.
    demo_occupancy_spread: bool = True
    # Demo: two example hazard reports on the Reports tab (labelled "Demo"), re-created at startup when none are
    # active. A real report or "It's clear" votes work on them like any other.
    demo_hazards: bool = True

    # --- Decision thresholds -----------------------------------------------
    ice_arrival_threshold_min: int = 60
    ice_capacity_reduction_default: float = 0.18   # used when a lot has no snow scan data
    ice_departure_buffer_min: int = 12
    ice_search_time_multiplier: float = 1.5

    # --- Expiry -------------------------------------------------------------
    parking_report_ttl_min: int = 30
    ice_hazard_ttl_hours: float = 6.0
    other_hazard_ttl_hours: float = 4.0
    ramp_hazard_ttl_hours: float = 12.0
    leaving_notice_ttl_min: int = 10

    # --- Recommendation -----------------------------------------------------
    walk_speed_m_per_min: float = 80.0
    ice_walk_speed_m_per_min: float = 60.0
    walk_detour_factor: float = 1.3
    default_drive_minutes: int = 15
    campus_timezone: str = "America/New_York"
    # Optional HH:MM. When set, the occupancy model and recommendations run as if it were
    # this time of day (handy for demos at 2 AM). Shown in the UI as SIMULATED CLOCK.
    sim_clock: str = ""

    @property
    def demo_full_slugs(self) -> set[str]:
        return {s.strip() for s in self.demo_full_lots.split(",") if s.strip()}

    @property
    def email_domains(self) -> list[str]:
        return [d.strip().lower() for d in self.auth_email_domains.split(",") if d.strip()]

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
