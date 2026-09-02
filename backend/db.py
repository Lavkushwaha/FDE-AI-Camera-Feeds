"""Mongo client + helpers. All routers import from here."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient
from state import MONGO_URL, DB_NAME

_client = AsyncIOMotorClient(MONGO_URL)
db = _client[DB_NAME]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def clean(doc):
    """Strip Mongo internals; safe to serialise. Mutates + returns."""
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc
