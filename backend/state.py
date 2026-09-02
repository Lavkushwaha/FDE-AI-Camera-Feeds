"""Shared env + paths + domain packs. Zero business logic."""
from __future__ import annotations
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

DATA_DIR = Path(os.environ.get("VIC_DATA_DIR", "/app/data"))
FRAMES_DIR = DATA_DIR / "frames"
UPLOADS_DIR = DATA_DIR / "uploads"
FACES_DIR = DATA_DIR / "faces"
for d in (FRAMES_DIR, UPLOADS_DIR, FACES_DIR):
    d.mkdir(parents=True, exist_ok=True)

DOMAIN_PACKS: dict[str, dict] = {
    "school": {
        "name": "School",
        "vocabulary": ["person", "backpack", "book", "laptop", "cell phone", "chair"],
        "watchlist_categories": ["student", "staff", "visitor", "restricted"],
        "anomaly_focus": ["person"],
        "narrative_style": "concise, focused on attendance and safety",
    },
    "retail": {
        "name": "Retail",
        "vocabulary": ["person", "handbag", "backpack", "bottle", "cup", "laptop", "cell phone", "book"],
        "watchlist_categories": ["customer", "staff", "vip", "blacklist"],
        "anomaly_focus": ["handbag", "backpack"],
        "narrative_style": "focus on foot traffic, dwell time, and merchandise movement",
    },
    "traffic": {
        "name": "Traffic",
        "vocabulary": ["car", "truck", "bus", "motorcycle", "bicycle", "person", "traffic light", "stop sign"],
        "watchlist_categories": ["registered", "stolen", "permit", "banned"],
        "anomaly_focus": ["car", "truck", "bus"],
        "narrative_style": "focus on vehicle counts, congestion, and violations",
    },
    "general": {
        "name": "General",
        "vocabulary": [],
        "watchlist_categories": ["watchlist", "vip", "banned"],
        "anomaly_focus": [],
        "narrative_style": "neutral operational summary",
    },
}
