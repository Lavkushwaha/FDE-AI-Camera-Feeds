"""
Inference Service (LLD section 2.1).

POC stub: returns a mock detection so the rest of the pipeline (frame-sampler ->
erp-sync -> presence-timeline) can be built and tested end-to-end before real
models are wired in.

On your GPU machine, replace `run_inference()` with:
  1. RetinaFace (via InsightFace) face detection on the frame
  2. ArcFace embedding generation per detected face
  3. Qdrant similarity search against enrolled student embeddings -> student_id + confidence
  4. YOLOv8/v10 object detection pass for the `objects` field
This function is the single seam to swap — nothing else in the pipeline needs to change.
"""
from fastapi import FastAPI
from pydantic import BaseModel
from datetime import datetime, timezone

app = FastAPI()


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
    return {"status": "ok", "service": "inference-service", "gpu_wired": False}


def run_inference(req: InferFrameRequest) -> InferFrameResponse:
    # TODO (GPU machine): real InsightFace + YOLO + Qdrant pipeline goes here.
    return InferFrameResponse(
        faces=[FaceMatch(student_id=None, confidence=0.0, bbox=[0, 0, 0, 0])],
        objects=[],
        processed_at=datetime.now(timezone.utc).isoformat(),
    )


@app.post("/infer/frame", response_model=InferFrameResponse)
def infer_frame(req: InferFrameRequest):
    return run_inference(req)
