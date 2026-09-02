"""Pydantic request/response models. Imported by routers."""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


class CameraSource(BaseModel):
    type: str
    uri: str


class CameraCreate(BaseModel):
    name: str
    source: CameraSource
    site: str = "default"
    fps: int = 1
    pack: str = "general"
    zones: list[dict] = Field(default_factory=list)


class Camera(CameraCreate):
    id: str
    status: str = "offline"
    created_at: str
    last_heartbeat: Optional[str] = None
    frames_seen: int = 0


class Zone(BaseModel):
    id: str
    name: str
    polygon: list[list[float]]  # normalised [x, y] pairs, 0..1
    rule: str = "presence"  # presence | intrusion | loitering | line_cross


class AnomalyLifecycle(BaseModel):
    actor: str = "operator"
    note: str = ""


class NarrativeRequest(BaseModel):
    camera_id: Optional[str] = None
    window_seconds: int = 600
    cadence: str = "10m"


class LockCreate(BaseModel):
    kind: str
    target: str
    label: str = ""


class LockInsightRequest(BaseModel):
    mode: str = "insight"
    window_minutes: int = 1440


class AnomalyRule(BaseModel):
    name: str
    type: str
    description: str = ""
    predicate: dict = Field(default_factory=dict)
    scope: dict = Field(default_factory=lambda: {"all": True})
    severity: str = "warning"
    enabled: bool = True


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    max_steps: int = 6
