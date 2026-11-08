"""General object detector: YOLOv4-tiny (pre-trained on COCO, 80 everyday classes) run through OpenCV's DNN module.

No PyTorch / ultralytics needed: OpenCV loads the Darknet weights directly (~60 ms per 416 px frame on a laptop CPU).
Weights live in data/models/ (not in git; fetch with `python -m scripts.download_models`). If they're missing,
`available()` is False and callers fall back to the classical OpenCV detectors.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

import cv2
import numpy as np

from ...config import DATA_DIR, get_settings

log = logging.getLogger(__name__)
MODEL_DIR = DATA_DIR / "models"
CFG, WEIGHTS, NAMES = MODEL_DIR / "yolov4-tiny.cfg", MODEL_DIR / "yolov4-tiny.weights", MODEL_DIR / "coco.names"
NAME = "YOLOv4-tiny (COCO, 80 classes) via OpenCV DNN"
VEHICLES = {"car", "truck", "bus", "motorbike", "motorcycle", "bicycle"}
INDOOR = {"bed", "couch", "sofa", "chair", "dining table", "diningtable", "tv", "tvmonitor", "laptop", "toilet", "sink",
          "refrigerator", "oven", "microwave", "book", "keyboard", "mouse", "remote", "pottedplant", "potted plant"}

_lock = threading.Lock()
_model = None
_names: list[str] = []
_failed = False
device = "cpu"   # set when the model loads: "gpu (<name>)" or "cpu"


def _use_gpu() -> tuple[bool, str]:
    pref = get_settings().vision_device.lower()
    if pref == "cpu":
        return False, ""
    try:
        if cv2.ocl.haveOpenCL():
            cv2.ocl.setUseOpenCL(True)
            name = cv2.ocl.Device.getDefault().name()
            if name and (pref == "gpu" or any(k in name.upper() for k in ("NVIDIA", "RTX", "GTX", "RADEON", "ARC"))):
                return True, name
    except Exception:  # noqa: BLE001
        pass
    return False, ""


def _load():
    global _model, _names, _failed
    if _model is not None or _failed:
        return _model
    with _lock:
        if _model is None and not _failed:
            try:
                if not (CFG.exists() and WEIGHTS.exists() and NAMES.exists()) or WEIGHTS.stat().st_size < 1_000_000:
                    raise FileNotFoundError(f"model files missing in {MODEL_DIR}")
                global device
                net = cv2.dnn.readNetFromDarknet(str(CFG), str(WEIGHTS))
                net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
                gpu, gpu_name = _use_gpu()
                net.setPreferableTarget(cv2.dnn.DNN_TARGET_OPENCL if gpu else cv2.dnn.DNN_TARGET_CPU)
                m = cv2.dnn_DetectionModel(net)
                m.setInputParams(size=(416, 416), scale=1 / 255.0, swapRB=True)
                try:   # warm-up: on GPU the first pass compiles OpenCL kernels (~6 s); do it now, not on a live frame
                    m.detect(np.zeros((416, 416, 3), np.uint8), confThreshold=0.5)
                except Exception as exc:  # noqa: BLE001 - GPU path failed: fall back to CPU
                    log.warning("GPU warm-up failed (%s); using CPU", exc)
                    net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
                    gpu = False
                device = f"gpu ({gpu_name})" if gpu else "cpu"
                log.info("COCO detector loaded on %s", device)
                _names = NAMES.read_text().strip().splitlines()
                _model = m
            except Exception as exc:  # noqa: BLE001 - optional component
                log.warning("COCO detector unavailable (%s); using classical OpenCV detectors", exc)
                _failed = True
    return _model


def available() -> bool:
    return _load() is not None


def detect(image: np.ndarray, conf: float = 0.3) -> list[dict]:
    """[{label, kind, score, box:[x1,y1,x2,y2] normalised 0-1}], highest score first. [] if unavailable."""
    m = _load()
    if m is None:
        return []
    h, w = image.shape[:2]
    with _lock:   # cv2.dnn nets aren't thread-safe; one frame at a time (~60 ms)
        classes, scores, boxes = m.detect(image, confThreshold=conf, nmsThreshold=0.45)
    out = []
    for c, s, (x, y, bw, bh) in zip(np.array(classes).flatten(), np.array(scores).flatten(), boxes):
        label = _names[int(c)] if int(c) < len(_names) else "object"
        kind = "vehicle" if label in VEHICLES else "person" if label == "person" else "other"
        x1, y1, x2, y2 = max(0, x), max(0, y), min(w, x + bw), min(h, y + bh)
        out.append({"label": label, "kind": kind, "score": round(float(s), 2),
                    "box": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)]})
    return sorted(out, key=lambda o: -o["score"])
