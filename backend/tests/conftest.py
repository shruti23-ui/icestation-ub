import os
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_tmp) / 'test.db'}"
os.environ["SATELLITE_LIVE_ENABLED"] = "false"
os.environ["WEATHER_LIVE_ENABLED"] = "false"
os.environ["GEMINI_API_KEY"] = ""
os.environ["ELEVENLABS_API_KEY"] = ""
os.environ["DEMO_FULL_LOTS"] = ""  # tests opt in explicitly
os.environ["DEMO_OCCUPANCY_SPREAD"] = "false"
os.environ["CAPTURE_SAVE"] = "false"   # tests opt in to writing capture files
os.environ["DEMO_HAZARDS"] = "false"   # tests count hazards they create
os.environ["VISION_PROVIDER"] = "opencv"
os.environ["SIM_CLOCK"] = "09:30"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture()
def client():
    from app.main import app
    from app.seed import reset
    with TestClient(app) as c:
        reset()
        yield c
