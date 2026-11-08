"""Vehicle detectors.

YoloV8Detector     real object detection (ultralytics). Used when the package and weights load.
OpenCVBlobDetector classical fallback: segments pavement/snow by colour, keeps car-shaped blobs.
                   Works well on high, near-overhead views; it is a heuristic and labelled as such.
"""
from __future__ import annotations

import logging

import cv2
import numpy as np

from ...config import get_settings
from .base import Box, Detections

log = logging.getLogger(__name__)
settings = get_settings()

COCO_VEHICLES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
COCO_PERSON = 0


class YoloV8Detector:
    name = "yolov8"

    def __init__(self, weights: str | None = None):
        self.weights = weights or settings.yolo_weights
        self._model = None
        self._failed = False

    def _load(self):
        if self._model is None and not self._failed:
            try:
                from ultralytics import YOLO  # optional heavy dependency
                self._model = YOLO(self.weights)
            except Exception as exc:  # pragma: no cover - depends on local install
                log.warning("YOLOv8 unavailable (%s); falling back to OpenCV detector", exc)
                self._failed = True
        return self._model

    def available(self) -> bool:
        return self._load() is not None

    def detect(self, image: np.ndarray) -> Detections:  # pragma: no cover - needs weights
        model = self._load()
        if model is None:
            raise RuntimeError("YOLOv8 model not loaded")
        res = model.predict(image, conf=settings.yolo_confidence, verbose=False)[0]
        vehicles, people = [], []
        for xyxy, cls, conf in zip(res.boxes.xyxy.tolist(), res.boxes.cls.tolist(), res.boxes.conf.tolist()):
            cls = int(cls)
            b = Box(*[int(v) for v in xyxy], score=float(conf))
            if cls in COCO_VEHICLES:
                b.label = COCO_VEHICLES[cls]
                vehicles.append(b)
            elif cls == COCO_PERSON:
                b.label = "person"
                people.append(b)
        mean = float(np.mean([v.score for v in vehicles])) if vehicles else 0.6
        return Detections(vehicles, people, provider=f"YOLOv8 ({self.weights})",
                          base_confidence=min(0.95, 0.55 + 0.4 * mean), note="COCO-pretrained YOLOv8")


def surface_masks(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Returns (asphalt_mask, snow_mask) using HSV thresholds."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    s, v = hsv[..., 1], hsv[..., 2]
    low_sat = s < 48
    asphalt = (low_sat & (v >= 45) & (v <= 165)).astype(np.uint8) * 255
    snow = ((s < 40) & (v > 180)).astype(np.uint8) * 255
    return asphalt, snow


class OpenCVBlobDetector:
    name = "opencv_heuristic"

    def available(self) -> bool:
        return True

    def detect(self, image: np.ndarray) -> Detections:
        h, w = image.shape[:2]
        asphalt, snow = surface_masks(image)
        surface = cv2.bitwise_or(asphalt, snow)
        candidate = cv2.bitwise_not(surface)
        # remove thin paint lines, then merge car parts (body, glass, outline)
        candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))

        # Known limitation: white/silver cars on snow blend into the snow mask and can be
        # missed. The EDIT RESULTS step in the UI exists for exactly this.
        contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        area = h * w
        boxes: list[Box] = []
        for c in contours:
            a = cv2.contourArea(c)
            if not (0.0012 * area <= a <= 0.04 * area):
                continue
            (_, _), (rw, rh), _ = cv2.minAreaRect(c)
            if min(rw, rh) == 0:
                continue
            aspect = max(rw, rh) / min(rw, rh)
            x, y, bw, bh = cv2.boundingRect(c)
            solidity = a / max(1.0, bw * bh)
            if 1.2 <= aspect <= 3.6 and solidity >= 0.45:
                score = float(min(0.85, 0.45 + 0.25 * solidity + 0.05 * (aspect < 2.8)))
                boxes.append(Box(x, y, x + bw, y + bh, "car", score))
        return Detections(boxes, [], provider="OpenCV heuristic blob detector",
                          base_confidence=0.55,
                          note="Classical colour-segmentation detector (no ML weights). Install YOLOv8 for robust detection.")


class CocoDarknetDetector:
    """YOLOv4-tiny (COCO) through OpenCV DNN: real vehicle + person boxes without PyTorch."""
    name = "yolov4-tiny"

    def available(self) -> bool:
        from . import coco
        return coco.available()

    def detect(self, image: np.ndarray) -> Detections:
        from . import coco
        h, w = image.shape[:2]
        vehicles, people = [], []
        for o in coco.detect(image, conf=0.25):
            x1, y1, x2, y2 = (int(o["box"][0] * w), int(o["box"][1] * h), int(o["box"][2] * w), int(o["box"][3] * h))
            if o["kind"] == "vehicle" and o["label"] not in ("bicycle",):
                vehicles.append(Box(x1, y1, x2, y2, o["label"], o["score"]))
            elif o["kind"] == "person":
                people.append(Box(x1, y1, x2, y2, "person", o["score"]))
        mean = float(np.mean([v.score for v in vehicles])) if vehicles else 0.6
        return Detections(vehicles, people, provider=coco.NAME, base_confidence=min(0.9, 0.5 + 0.4 * mean),
                          note="COCO-pretrained YOLOv4-tiny; classical car finders fill in what it misses")


_yolo = YoloV8Detector()
_darknet = CocoDarknetDetector()
_opencv = OpenCVBlobDetector()


def get_detector() -> object:
    choice = settings.vision_provider.lower()
    if choice in ("auto", "yolo") and _yolo.available():
        return _yolo
    if choice in ("auto", "yolo") and _darknet.available():
        return _darknet
    return _opencv
