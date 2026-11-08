"""Gemini Vision assessor (optional). Called only with the privacy-blurred image.

Uses the public REST endpoint so no extra SDK is required. Returns None on any failure so
the pipeline falls back to OpenCV analysis instead of failing the scan.
"""
from __future__ import annotations

import base64
import json
import logging
import time

import cv2
import httpx
import numpy as np

from ...config import get_settings

log = logging.getLogger(__name__)
settings = get_settings()
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
RETRIES = 2
RETRY_STATUS = {429, 500, 503}

PARKING_PROMPT = """You are analysing a photo of a university parking lot in Buffalo, NY, possibly in winter.
Return ONLY a JSON object with these keys:
  visible_parking_spaces (int, stalls visible in frame, including occupied),
  occupied_spaces (int), open_spaces (int, empty AND usable),
  snow_blocked_spaces (int, stalls unusable due to snow piles or unplowed snow),
  plowed_rows (int), unplowed_rows (int),
  snow_accumulation ("none"|"light"|"moderate"|"heavy"),
  plowing_condition (short phrase), weather_condition ("Clear"|"Cloudy"|"Snow"|"Rain"|"Unknown"),
  lot_sign_text (string or null), confidence (0-1), explanation (one or two plain sentences).
Count conservatively; if unsure, lower confidence."""

HAZARD_PROMPT = """You are classifying a photo of a campus walkway in winter.
Return ONLY a JSON object with keys:
  category ("clear"|"ice"|"slush"|"snow"|"unplowed"|"blocked_ramp"),
  curb_ramp_visible (bool), curb_ramp_blocked (bool),
  confidence (0-1), explanation (one plain sentence for students, mention wheelchair users if a ramp is blocked)."""


def available() -> bool:
    return bool(settings.gemini_api_key)


def _call(image: np.ndarray, prompt: str, thinking: str | None = None, quality: int = 85) -> dict | None:
    if not available():
        return None
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        return None
    body = {
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(buf.tobytes()).decode()}},
        ]}],
        "generationConfig": {"response_mime_type": "application/json", "temperature": 0.1,
                             **({"thinkingConfig": {"thinkingLevel": thinking or settings.gemini_thinking_level}}
                                if (thinking or settings.gemini_thinking_level) else {})},
    }
    # Key goes in a header, not the query string, so it never lands in httpx/uvicorn logs.
    headers = {"x-goog-api-key": settings.gemini_api_key.strip()}
    url = ENDPOINT.format(model=settings.gemini_model)
    for attempt in range(RETRIES + 1):
        try:
            r = httpx.post(url, headers=headers, json=body, timeout=25)
            if r.status_code in RETRY_STATUS and attempt < RETRIES:
                time.sleep(1.5 * (attempt + 1))  # transient overload / rate limit
                continue
            r.raise_for_status()
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            text = text.strip().removeprefix("```json").removesuffix("```").strip()
            return json.loads(text)
        except httpx.HTTPStatusError as exc:
            log.warning("Gemini call failed: HTTP %s from %s", exc.response.status_code, settings.gemini_model)
            return None
        except Exception as exc:
            log.warning("Gemini call failed: %s", type(exc).__name__)
            return None
    return None


def assess_parking(image: np.ndarray) -> dict | None:
    return _call(image, PARKING_PROMPT)


def classify_hazard(image: np.ndarray) -> dict | None:
    return _call(image, HAZARD_PROMPT)
