"""WeParkit API.

Run (recommended, auto-restarts on crash or hang):   python -m scripts.serve
Run directly:  uvicorn app.main:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 2 --timeout-keep-alive 75
Docs: /docs

Resilience rules for this file: no request may take the process down, every failure becomes a JSON
error with a request id (and a logged traceback), startup never aborts on non-critical work, and
/api/health always answers (reporting "degraded" components instead of failing).
"""
from __future__ import annotations

import asyncio
import threading
import logging
import time
import uuid
from contextlib import asynccontextmanager

import anyio
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from .config import DATA_DIR, get_settings
from .database import SessionLocal, get_db
from .models import ParkingReport
from .routers import auth as auth_routes
from .routers import community, orbital, parking, voice as voice_routes
from .schemas import HealthOut
from .seed import init
from .services import gemini_status, satellite as sat, voice, weather
from .services.lot_state import campus_now, get_state
from .services.realtime import hub
from .services.vision.detectors import get_detector
from .timeutil import utcnow

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("weparkit")
settings = get_settings()

MAX_BODY_BYTES = 20 * 1024 * 1024   # photo uploads are capped at 15 MB in the pipeline; leave headroom for form fields
THREAD_LIMIT = 100                  # sync endpoints that wait on ElevenLabs/Gemini must not starve /api/health
STARTED_AT = time.time()


async def expiry_loop() -> None:
    """Every 30 s: expire hazards and tell clients when crew parking reports age out. Never dies."""
    from .services.hazards import expire_hazards
    last_live = None
    last_sweep = 0.0
    while True:
        try:
            def tick() -> tuple[int, int]:
                with SessionLocal() as db:
                    expired = expire_hazards(db)
                    live = db.scalar(select(func.count(ParkingReport.id)).where(ParkingReport.expires_at > utcnow())) or 0
                    return expired, live
            expired, live = await anyio.to_thread.run_sync(tick)  # keep DB work off the event loop
            if expired:
                hub.publish("hazards")
            if last_live is not None and live < last_live:
                hub.publish("lots")
            last_live = live
            if time.time() - last_sweep > 3600:   # hourly: delete images past MEDIA_RETENTION_HOURS (0 = keep)
                last_sweep = time.time()
                from .services.media_store import sweep
                await anyio.to_thread.run_sync(sweep)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("expiry loop tick failed (will retry)")
        await asyncio.sleep(30)


def _safe(step: str, fn) -> None:
    """Run a non-critical startup step; log and continue on failure."""
    try:
        fn()
    except Exception:
        log.exception("startup step failed (continuing): %s", step)


@asynccontextmanager
async def lifespan(_: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_LIMIT
    # The database is critical: retry briefly (another process may hold a lock), then fail loudly.
    for attempt in range(5):
        try:
            init()
            break
        except OperationalError:
            if attempt == 4:
                raise
            log.warning("database busy during startup, retrying (%d/5)", attempt + 1)
            await asyncio.sleep(1 + attempt)

    def samples() -> None:
        for sub in ("uploads", "satellite", "samples"):
            (DATA_DIR / sub).mkdir(parents=True, exist_ok=True)
        if not any((DATA_DIR / "samples").glob("*.jpg")):
            from scripts.generate_samples import SAMPLES, make_lot, make_walkway
            for args in SAMPLES:
                make_lot(*args)
            make_walkway()
    _safe("sample images", samples)
    # Warm the external-API caches in the background so the first phone request is instant.
    if settings.satellite_live_enabled:
        _safe("warm GOES listing", sat.listing_cache.warm)
    if settings.weather_live_enabled:
        _safe("warm NWS weather", weather.nws_cache.warm)
    task = asyncio.create_task(expiry_loop())
    # Load the object detector (and warm the GPU) in the background so the first camera frame is fast.
    def _warm_detector() -> None:
        try:
            from .services.vision import coco
            coco.available()
        except Exception:  # noqa: BLE001 - optional component; never block startup
            log.exception("detector warm-up failed")
    threading.Thread(target=_warm_detector, daemon=True).start()
    log.info("WeParkit API ready")
    yield
    task.cancel()


app = FastAPI(title="WeParkit API", version="1.1.0", lifespan=lifespan,
              description="Parking availability and winter walkway safety for UB North Campus. Hackathon prototype.")


# ------------------------------------------------------------------ middleware

@app.middleware("http")
async def guard(request: Request, call_next):
    """Request id, timing, body-size limit, and a last-resort catch so nothing escapes as a dropped connection."""
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = rid
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Upload too large (max 20 MB).", "request_id": rid},
                            headers={"x-request-id": rid})
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("unhandled error rid=%s %s %s", rid, request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Please try again.",
                                                      "request_id": rid}, headers={"x-request-id": rid})
    ms = (time.perf_counter() - t0) * 1000
    if ms > 3000:
        log.warning("slow request rid=%s %s %s %.0f ms", rid, request.method, request.url.path, ms)
    response.headers["x-request-id"] = rid
    return response


app.add_middleware(CORSMiddleware, allow_origins=settings.cors_list, allow_origin_regex=settings.cors_origin_regex or None,
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

for r in (auth_routes.router, parking.router, orbital.weather_router, orbital.satellite_router, orbital.system_router,
          community.hazard_router, community.crew_router, community.notif_router, voice_routes.router):
    app.include_router(r)

for sub in ("uploads", "satellite", "samples"):
    (DATA_DIR / sub).mkdir(parents=True, exist_ok=True)
    app.mount(f"/media/{sub}", StaticFiles(directory=DATA_DIR / sub), name=f"media-{sub}")


# ------------------------------------------------------------------ error handlers

def _rid(request: Request) -> str:
    return getattr(request.state, "request_id", "-")


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "request_id": _rid(request)},
                        headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": exc.errors(), "request_id": _rid(request)})


@app.exception_handler(ValueError)
async def value_error(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc), "request_id": _rid(request)})


@app.exception_handler(IntegrityError)
async def integrity_error(request: Request, exc: IntegrityError):
    log.warning("integrity error rid=%s: %s", _rid(request), exc.orig)
    return JSONResponse(status_code=409, content={"detail": "That conflicts with existing data. Refresh and try again.",
                                                  "request_id": _rid(request)})


@app.exception_handler(OperationalError)
async def db_busy(request: Request, exc: OperationalError):
    log.warning("database operational error rid=%s: %s", _rid(request), exc.orig)
    return JSONResponse(status_code=503, content={"detail": "The database is busy. Please retry in a moment.",
                                                  "request_id": _rid(request)}, headers={"Retry-After": "2"})


@app.exception_handler(SQLAlchemyError)
async def db_error(request: Request, exc: SQLAlchemyError):
    log.exception("database error rid=%s", _rid(request))
    return JSONResponse(status_code=500, content={"detail": "Database error. Please try again.", "request_id": _rid(request)})


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("unhandled error rid=%s %s %s", _rid(request), request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Please try again.",
                                                  "request_id": _rid(request)})


# ------------------------------------------------------------------ system

@app.get("/api/media", tags=["system"])
def media_stats():
    """How many images are kept, and the storage policy (CAPTURE_SAVE, MEDIA_RETENTION_HOURS)."""
    from .services.media_store import stats
    return stats()


@app.get("/api/health", response_model=HealthOut, tags=["system"])
def health(db: Session = Depends(get_db)):
    """Always answers. Components that fail are reported, never raised."""
    degraded: list[str] = []

    def probe(name: str, fn, default):
        try:
            return fn()
        except Exception:
            log.exception("health probe failed: %s", name)
            degraded.append(name)
            return default

    probe("database", lambda: db.execute(text("SELECT 1")).scalar(), None)
    listing, _ = probe("satellite", sat.live_listing, (None, None))
    wx = probe("weather", weather.current, {"source": "unavailable"})
    now, simulated = probe("clock", campus_now, (None, False))
    return {
        "status": "degraded" if degraded else "ok", "degraded": degraded, "app": settings.app_name,
        "mode": probe("state", lambda: get_state(db).mode, "standard"),
        "vision_detector": probe("vision", lambda: getattr(get_detector(), "name", "unknown"), "unknown"),
        "gemini_configured": gemini_status(),
        "satellite_source": "goes19_live" if listing else "simulated",
        "weather_source": wx.get("source", "unavailable"), "simulated_clock": simulated,
        "time_campus": now.strftime("%H:%M") if now else "--:--",
        "voice_enabled": voice.configured(), "uptime_s": round(time.time() - STARTED_AT),
    }


@app.get("/api/live", tags=["system"], include_in_schema=False)
def live():
    """Liveness for the supervisor: no DB, no external calls."""
    return {"ok": True}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("websocket closed with error", exc_info=True)
    finally:
        hub.disconnect(websocket)


# Re-export for tests / tooling that import the exception type from here.
__all__ = ["app", "HTTPException"]
