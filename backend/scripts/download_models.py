"""Fetch the YOLOv4-tiny COCO model (about 24 MB) into data/models/ for the general object detector.

    python -m scripts.download_models

GitHub release downloads can time out on some networks; SourceForge's mirror of the official release is used as a
fallback. Files are checked by size. Model: AlexeyAB/darknet YOLOv4-tiny, pre-trained on COCO (80 classes).
"""
from pathlib import Path

import httpx

DEST = Path(__file__).resolve().parent.parent / "data" / "models"
FILES = {
    "yolov4-tiny.cfg": (["https://raw.githubusercontent.com/AlexeyAB/darknet/master/cfg/yolov4-tiny.cfg"], 3000),
    "coco.names": (["https://raw.githubusercontent.com/AlexeyAB/darknet/master/data/coco.names"], 600),
    "yolov4-tiny.weights": ([
        "https://github.com/AlexeyAB/darknet/releases/download/darknet_yolo_v4_pre/yolov4-tiny.weights",
        "https://sourceforge.net/projects/darknet-yolo.mirror/files/darknet_yolo_v4_pre/yolov4-tiny.weights/download",
    ], 24_000_000),
}


def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for name, (urls, min_size) in FILES.items():
        path = DEST / name
        if path.exists() and path.stat().st_size >= min_size:
            print(f"ok    {name}")
            continue
        for url in urls:
            try:
                with httpx.stream("GET", url, follow_redirects=True, timeout=600) as r:
                    r.raise_for_status()
                    with path.open("wb") as f:
                        for chunk in r.iter_bytes():
                            f.write(chunk)
                if path.stat().st_size >= min_size:
                    print(f"got   {name} ({path.stat().st_size} bytes)")
                    break
            except Exception as exc:  # noqa: BLE001
                print(f"retry {name}: {type(exc).__name__}")
        else:
            raise SystemExit(f"Could not download {name}")


if __name__ == "__main__":
    main()
