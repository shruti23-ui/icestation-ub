"""Chunked photo uploads, in memory only (raw photos never touch disk).

Some networks (campus Wi-Fi) drop large phone-to-laptop uploads while small requests get through. The app
then sends the photo as base64 pieces of ~48 KB; the server reassembles them here and the photo is consumed
once by /api/parking/scan, /api/hazards/report or /api/parking/live-detect (field `upload_id`).
"""
from __future__ import annotations

import base64
import threading
import time
import uuid

MAX_BYTES = 15 * 1024 * 1024
TTL_S = 300
_lock = threading.Lock()
_store: dict[str, tuple[float, dict[int, bytes]]] = {}


def _sweep(now: float) -> None:
    for k in [k for k, (t, _) in _store.items() if now - t > TTL_S]:
        _store.pop(k, None)


def add_chunk(upload_id: str | None, index: int, data_b64: str) -> str:
    try:
        piece = base64.b64decode(data_b64, validate=True)
    except Exception as exc:
        raise ValueError("chunk is not valid base64") from exc
    now = time.time()
    with _lock:
        _sweep(now)
        if upload_id is None:
            upload_id = uuid.uuid4().hex
            _store[upload_id] = (now, {})
        if upload_id not in _store:
            raise KeyError("Upload expired or unknown. Try again.")
        _, parts = _store[upload_id]
        parts[index] = piece
        if sum(len(p) for p in parts.values()) > MAX_BYTES:
            _store.pop(upload_id, None)
            raise ValueError("Photo is larger than 15 MB.")
        _store[upload_id] = (now, parts)
    return upload_id


def take(upload_id: str) -> bytes:
    """Reassemble and forget an upload (one use)."""
    with _lock:
        item = _store.pop(upload_id, None)
    if item is None:
        raise KeyError("Upload expired or unknown. Try again.")
    parts = item[1]
    if sorted(parts) != list(range(len(parts))):
        raise ValueError("Upload is missing pieces. Try again.")
    return b"".join(parts[i] for i in range(len(parts)))
