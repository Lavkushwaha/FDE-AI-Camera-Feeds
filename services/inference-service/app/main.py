"""Inference Service — real YOLO detection on GPU (LLD section 2.1).
Face recognition (InsightFace) plugs into run_inference() later — same seam."""
from fastapi import FastAPI, UploadFile, File
from pydantic import BaseModel
from datetime import datetime, timezone
import httpx

import cv2
import numpy as np
import torch
from ultralytics import YOLO

import os

app = FastAPI()

# ---- model: loaded ONCE at startup ----
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL = YOLO("yolov8n.pt")  # auto-downloads weights (~6 MB) on first run
MODEL.to(DEVICE)

# ---- tweak knobs ----
KEEP_CLASSES = {0: "person", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 9: "traffic light"}
CONF_THRESHOLD = 0.35


class InferFrameRequest(BaseModel):
    camera_id: str
    room_id: str
    timestamp: str
    frame_url: str


class FaceMatch(BaseModel):
    student_id: str | None
    confidence: float
    bbox: list[float]


class ObjectDetection(BaseModel):
    cls: str
    confidence: float
    bbox: list[float]


class InferFrameResponse(BaseModel):
    faces: list[FaceMatch]
    objects: list[ObjectDetection]
    processed_at: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "inference-service", "gpu_wired": torch.cuda.is_available()}


def run_inference(img_bytes: bytes) -> InferFrameResponse:
    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        # frame file was still being written when we read it (partial JPEG)
        return InferFrameResponse(faces=[], objects=[], processed_at=datetime.now(timezone.utc).isoformat())
    result = MODEL.predict(img, conf=CONF_THRESHOLD, verbose=False)[0]

    faces, objects = [], []
    for box in result.boxes:
        cls_id, conf = int(box.cls[0]), float(box.conf[0])
        x1, y1, x2, y2 = map(float, box.xyxy[0])
        det_bbox = [x1, y1, x2 - x1, y2 - y1]  # xyxy -> x,y,w,h (LLD contract)
        if cls_id == 0:
            faces.append(FaceMatch(student_id=None, confidence=conf, bbox=det_bbox))
        if cls_id in KEEP_CLASSES:
            objects.append(ObjectDetection(cls=KEEP_CLASSES[cls_id], confidence=conf, bbox=det_bbox))
    return InferFrameResponse(faces=faces, objects=objects, processed_at=datetime.now(timezone.utc).isoformat())




FRAMES_DIR = os.getenv("FRAMES_DIR", "/frames")

@app.post("/infer/frame", response_model=InferFrameResponse)
async def infer_frame(req: InferFrameRequest):
    if req.frame_url.startswith("http"):
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(req.frame_url)
            resp.raise_for_status()
        return run_inference(resp.content)
    # local shared-volume path: normalize to basename, join with our mount
    frame_path = os.path.join(FRAMES_DIR, os.path.basename(req.frame_url))
    with open(frame_path, "rb") as f:
        return run_inference(f.read())


@app.post("/infer/upload", response_model=InferFrameResponse)
async def infer_upload(file: UploadFile = File(...)):
    return run_inference(await file.read())