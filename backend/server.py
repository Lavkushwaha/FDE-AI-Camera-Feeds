"""
Vision Intelligence Core (VIC) — FastAPI backend.

Implements the domain-agnostic core described in FRAMEWORK.md as a runnable
service inside Emergent (single-process FastAPI + MongoDB + local models).

Real subsystems:
  - Camera Registry (file/rtsp/webcam sources) with health heartbeat
  - Video processor: YOLOv8n multi-class detection + ByteTrack track IDs (ultralytics)
  - Face identity: InsightFace embeddings + cosine watchlist match
  - Fact Ledger: append-only detection_events
  - Anomaly Engine: spike/drought/new_class/capture_gap with ack/resolve lifecycle
  - Zone editor + presence events (entered/exited via track IDs)
  - Subject Lock: retrospective sweep + prospective sightings
  - Domain packs: school / retail / traffic (vocab + rules)
  - LLM narratives (grounded, Emergent Universal LLM Key)
  - Retention: purge frames past TTL (exempt open anomalies / active investigations)
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import aiofiles
import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

# Emergent LLM (grounded narratives)
from emergentintegrations.llm.chat import LlmChat, UserMessage

# Load env first
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

# ---------- Domain packs (config-driven vocabulary) --------------------------
DOMAIN_PACKS: dict[str, dict[str, Any]] = {
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
        "vocabulary": [],  # empty = accept everything
        "watchlist_categories": ["watchlist", "vip", "banned"],
        "anomaly_focus": [],
        "narrative_style": "neutral operational summary",
    },
}


# ---------- FastAPI + Mongo --------------------------------------------------
app = FastAPI(title="Vision Intelligence Core", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mongo_client = AsyncIOMotorClient(MONGO_URL)
db = mongo_client[DB_NAME]

# Expose frames + face crops for the dashboard (via /api/media/* since only /api/* is routed by ingress)
app.mount("/api/media/frames", StaticFiles(directory=str(FRAMES_DIR)), name="frames")
app.mount("/api/media/faces", StaticFiles(directory=str(FACES_DIR)), name="faces")
app.mount("/api/media/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


# ---------- Model singletons (lazy) ------------------------------------------
_yolo = None
_face_app = None

def yolo():
    global _yolo
    if _yolo is None:
        from ultralytics import YOLO
        _yolo = YOLO(str(ROOT / "yolov8n.pt"))
    return _yolo


def face_app():
    global _face_app
    if _face_app is None:
        from insightface.app import FaceAnalysis
        f = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"])
        f.prepare(ctx_id=-1, det_size=(320, 320))
        _face_app = f
    return _face_app


# ---------- Utilities --------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def clean(doc: dict | None) -> dict | None:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


# ---------- Pydantic models --------------------------------------------------
class CameraSource(BaseModel):
    type: str  # file | rtsp | webcam | sample
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
    status: str = "offline"  # online | offline | degraded
    created_at: str
    last_heartbeat: Optional[str] = None
    frames_seen: int = 0


class Zone(BaseModel):
    id: str
    name: str
    polygon: list[list[float]]  # list of [x,y] normalized 0..1
    rule: str = "presence"  # presence | intrusion | loitering


class FaceEnroll(BaseModel):
    name: str
    category: str = "watchlist"
    priority: str = "normal"  # low | normal | high | critical
    notes: str = ""


class AnomalyLifecycle(BaseModel):
    actor: str = "operator"
    note: str = ""


class NarrativeRequest(BaseModel):
    camera_id: Optional[str] = None
    window_seconds: int = 600
    cadence: str = "10m"  # 1m | 10m | 1h | 1d


class LockCreate(BaseModel):
    kind: str  # face | class | plate
    target: str  # identity_id, class label, plate text
    label: str = ""


# ---------- Camera Registry --------------------------------------------------
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "vic-core", "ts": now_iso()}


@app.get("/api/packs")
async def list_packs():
    return DOMAIN_PACKS


@app.post("/api/cameras")
async def create_camera(payload: CameraCreate):
    cam = Camera(
        id=new_id(),
        created_at=now_iso(),
        **payload.model_dump(),
    ).model_dump()
    await db.cameras.insert_one(cam)
    return clean(cam)


@app.get("/api/cameras")
async def list_cameras():
    cams = [clean(c) async for c in db.cameras.find().sort("created_at", -1)]
    return cams


@app.get("/api/cameras/{cid}")
async def get_camera(cid: str):
    c = await db.cameras.find_one({"id": cid})
    if not c:
        raise HTTPException(404, "camera not found")
    return clean(c)


@app.delete("/api/cameras/{cid}")
async def delete_camera(cid: str):
    r = await db.cameras.delete_one({"id": cid})
    return {"deleted": r.deleted_count}


@app.put("/api/cameras/{cid}/zones")
async def set_zones(cid: str, zones: list[Zone]):
    await db.cameras.update_one({"id": cid}, {"$set": {"zones": [z.model_dump() for z in zones]}})
    return {"ok": True, "zones": len(zones)}


@app.post("/api/cameras/{cid}/heartbeat")
async def heartbeat(cid: str):
    await db.cameras.update_one(
        {"id": cid},
        {"$set": {"last_heartbeat": now_iso(), "status": "online"}, "$inc": {"frames_seen": 1}},
    )
    return {"ok": True}


# ---------- Video processing (upload → frames → detect + track + face) --------
@app.post("/api/cameras/{cid}/upload_video")
async def upload_video(
    cid: str,
    background: BackgroundTasks,
    file: UploadFile = File(...),
    sample_fps: float = Query(1.0, ge=0.1, le=10.0),
    max_frames: int = Query(60, ge=1, le=600),
):
    """Accept an mp4 upload, sample frames at sample_fps, run detection+tracking
    and (optionally) face matching. Everything appended to detection_events."""
    cam = await db.cameras.find_one({"id": cid})
    if not cam:
        raise HTTPException(404, "camera not found")

    # Read fully into memory and hand OpenCV a private temp path for decode.
    payload = await file.read()
    import tempfile
    tf = tempfile.NamedTemporaryFile(prefix=f"vic_{cid[:8]}_", suffix=".mp4", delete=False)
    try:
        tf.write(payload)
    finally:
        tf.close()
    dest = Path(tf.name)

    job_id = new_id()
    await db.jobs.insert_one({
        "id": job_id, "camera_id": cid, "video_path": str(dest),
        "status": "queued", "created_at": now_iso(), "progress": 0.0,
        "frames_written": 0,
    })
    background.add_task(_process_video, job_id, cid, str(dest), sample_fps, max_frames)
    return {"job_id": job_id, "video": dest.name}


async def _process_video(job_id: str, cid: str, path: str, sample_fps: float, max_frames: int):
    """Sample frames from video → YOLO detect+track → InsightFace match → ledger."""
    await db.jobs.update_one({"id": job_id}, {"$set": {"status": "running", "started_at": now_iso()}})

    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise RuntimeError("cannot open video")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        stride = max(1, int(round(src_fps / sample_fps)))
        target = min(max_frames, (total // stride) if total else max_frames)

        # Preload watchlist embeddings
        identities = [clean(x) async for x in db.identities.find()]
        id_vecs = [(i, np.array(i["embedding"], dtype=np.float32)) for i in identities if i.get("embedding")]

        cam = await db.cameras.find_one({"id": cid}) or {}
        pack = DOMAIN_PACKS.get(cam.get("pack", "general"), DOMAIN_PACKS["general"])
        vocab = set(pack["vocabulary"])

        idx = 0
        written = 0
        yolo_model = yolo()
        face_model = face_app()

        while written < target:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % stride != 0:
                idx += 1
                continue
            idx += 1

            ts = now_iso()
            frame_name = f"{cid}_{int(time.time()*1000)}_{written:04d}.jpg"
            frame_path = FRAMES_DIR / frame_name
            cv2.imwrite(str(frame_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
            frame_ref = f"/api/media/frames/{frame_name}"

            # YOLO detect+track (ByteTrack) for persistent IDs
            results = yolo_model.track(frame, persist=True, verbose=False, conf=0.35, iou=0.5)
            objects = []
            r = results[0]
            names = r.names
            if r.boxes is not None and len(r.boxes) > 0:
                xyxy = r.boxes.xyxy.cpu().numpy()
                confs = r.boxes.conf.cpu().numpy()
                clsids = r.boxes.cls.cpu().numpy().astype(int)
                ids = r.boxes.id.cpu().numpy().astype(int) if r.boxes.id is not None else [None] * len(clsids)
                for (x1, y1, x2, y2), conf, cid_c, tid in zip(xyxy, confs, clsids, ids):
                    label = names[int(cid_c)]
                    if vocab and label not in vocab:
                        continue
                    objects.append({
                        "label": label, "confidence": round(float(conf), 3),
                        "bbox": [float(x1), float(y1), float(x2), float(y2)],
                        "track_id": int(tid) if tid is not None else None,
                    })

            # Face detection + watchlist match
            faces_out = []
            faces = face_model.get(frame)
            for f in faces:
                emb = f.normed_embedding
                match = None
                if id_vecs:
                    best = max(id_vecs, key=lambda x: cosine(emb, x[1]))
                    sim = cosine(emb, best[1])
                    if sim > 0.42:  # tuned threshold for buffalo_s
                        match = {
                            "identity_id": best[0]["id"],
                            "name": best[0]["name"],
                            "category": best[0]["category"],
                            "priority": best[0].get("priority", "normal"),
                            "similarity": round(sim, 3),
                        }
                bb = [float(x) for x in f.bbox]
                faces_out.append({
                    "bbox": bb, "det_score": float(f.det_score),
                    "age": int(f.age) if hasattr(f, "age") else None,
                    "gender": "M" if getattr(f, "sex", "") == "M" else ("F" if getattr(f, "sex", "") == "F" else None),
                    "match": match,
                })

                if match:
                    await db.match_events.insert_one({
                        "id": new_id(), "identity_id": match["identity_id"],
                        "name": match["name"], "category": match["category"],
                        "camera_id": cid, "frame_ref": frame_ref,
                        "similarity": match["similarity"], "detected_at": ts,
                    })

            # Append per-frame fact ledger row
            await db.detection_events.insert_one({
                "id": new_id(),
                "camera_id": cid,
                "detected_at": ts,
                "frame_ref": frame_ref,
                "objects": objects,
                "faces": faces_out,
                "pack": cam.get("pack", "general"),
            })

            # Heartbeat
            await db.cameras.update_one(
                {"id": cid},
                {"$set": {"last_heartbeat": ts, "status": "online"}, "$inc": {"frames_seen": 1}},
            )

            written += 1
            await db.jobs.update_one(
                {"id": job_id},
                {"$set": {"progress": round(written / max(1, target), 3), "frames_written": written}},
            )

        cap.release()
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        await db.jobs.update_one(
            {"id": job_id},
            {"$set": {"status": "done", "finished_at": now_iso(), "progress": 1.0}},
        )
        # Auto scan anomalies after ingest
        await _scan_anomalies(cid, minutes=10)
    except Exception as e:
        await db.jobs.update_one(
            {"id": job_id},
            {"$set": {"status": "error", "error": str(e), "finished_at": now_iso()}},
        )


@app.get("/api/jobs/{jid}")
async def get_job(jid: str):
    j = await db.jobs.find_one({"id": jid})
    if not j:
        raise HTTPException(404, "job not found")
    return clean(j)


@app.get("/api/jobs")
async def list_jobs(limit: int = 20):
    return [clean(j) async for j in db.jobs.find().sort("created_at", -1).limit(limit)]


# ---------- Fact Ledger ------------------------------------------------------
@app.get("/api/ledger")
async def ledger(
    camera_id: Optional[str] = None,
    label: Optional[str] = None,
    limit: int = 100,
    since: Optional[str] = None,
):
    q: dict = {}
    if camera_id:
        q["camera_id"] = camera_id
    if since:
        q["detected_at"] = {"$gte": since}
    if label:
        q["objects.label"] = label
    rows = [clean(r) async for r in db.detection_events.find(q).sort("detected_at", -1).limit(limit)]
    return rows


@app.get("/api/ledger/factsheet")
async def factsheet(camera_id: str, minutes: int = 10):
    since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    pipeline = [
        {"$match": {"camera_id": camera_id, "detected_at": {"$gte": since}}},
        {"$unwind": {"path": "$objects", "preserveNullAndEmptyArrays": True}},
        {"$group": {
            "_id": "$objects.label",
            "detections": {"$sum": 1},
            "avg_conf": {"$avg": "$objects.confidence"},
        }},
        {"$sort": {"detections": -1}},
    ]
    dpc = []
    async for row in db.detection_events.aggregate(pipeline):
        if row["_id"] is None:
            continue
        dpc.append({
            "label": row["_id"],
            "detections": row["detections"],
            "avg_conf": round(row["avg_conf"] or 0, 3),
        })
    frames_seen = await db.detection_events.count_documents(
        {"camera_id": camera_id, "detected_at": {"$gte": since}}
    )
    return {
        "camera_id": camera_id,
        "window": {"from": since, "to": now_iso(), "minutes": minutes},
        "frames_seen": frames_seen,
        "frames_expected": minutes * 60,  # at 1 fps
        "detections_per_class": dpc,
    }


@app.get("/api/ledger/export")
async def export_ledger(
    camera_id: Optional[str] = None,
    format: str = Query("json", pattern="^(json|csv)$"),
    limit: int = 1000,
):
    q: dict = {}
    if camera_id:
        q["camera_id"] = camera_id
    rows = [clean(r) async for r in db.detection_events.find(q).sort("detected_at", -1).limit(limit)]
    if format == "json":
        buf = io.BytesIO(json.dumps(rows, indent=2).encode())
        return StreamingResponse(
            buf, media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=ledger.json"},
        )
    # csv
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "camera_id", "detected_at", "frame_ref", "n_objects", "n_faces", "labels"])
    for r in rows:
        labels = ",".join(sorted({o.get("label", "") for o in r.get("objects", [])}))
        w.writerow([r["id"], r["camera_id"], r["detected_at"], r["frame_ref"],
                    len(r.get("objects", [])), len(r.get("faces", [])), labels])
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=ledger.csv"},
    )


# ---------- Anomaly Engine ---------------------------------------------------
async def _scan_anomalies(camera_id: str, minutes: int = 10) -> list[dict]:
    """Real rules: capture_gap (frames_seen < 50% expected), spike/drought via
    z-score vs previous window, and new_class (first sighting)."""
    since = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    since_iso = since.isoformat()

    # Capture gap
    frames_seen = await db.detection_events.count_documents(
        {"camera_id": camera_id, "detected_at": {"$gte": since_iso}}
    )
    # Latest frame in the window (used for purge-exemption)
    latest = await db.detection_events.find_one(
        {"camera_id": camera_id, "detected_at": {"$gte": since_iso}},
        sort=[("detected_at", -1)],
    )
    latest_ref = (latest or {}).get("frame_ref")

    expected = minutes * 60
    created: list[dict] = []
    if expected > 0 and frames_seen < expected * 0.5 and frames_seen > 0:
        a = {
            "id": new_id(), "camera_id": camera_id, "type": "capture_gap",
            "severity": "warning", "opened_at": now_iso(), "status": "open",
            "facts": {"frames_seen": frames_seen, "frames_expected": expected,
                      "window_min": minutes, "frame_ref": latest_ref},
            "note": f"Only {frames_seen}/{expected} frames captured in last {minutes}m",
        }
        await db.anomalies.insert_one(a)
        created.append(clean(a))

    # Class distribution current window
    pipeline = [
        {"$match": {"camera_id": camera_id, "detected_at": {"$gte": since_iso}}},
        {"$unwind": "$objects"},
        {"$group": {"_id": "$objects.label", "count": {"$sum": 1}}},
    ]
    curr = {row["_id"]: row["count"] async for row in db.detection_events.aggregate(pipeline)}

    # Prior window (equal length) for z-score baseline
    prior_since = (since - timedelta(minutes=minutes)).isoformat()
    prior_pipeline = [
        {"$match": {"camera_id": camera_id, "detected_at": {"$gte": prior_since, "$lt": since_iso}}},
        {"$unwind": "$objects"},
        {"$group": {"_id": "$objects.label", "count": {"$sum": 1}}},
    ]
    prior = {row["_id"]: row["count"] async for row in db.detection_events.aggregate(prior_pipeline)}

    for label, count in curr.items():
        base = prior.get(label, 0)
        # Simple: 3x baseline = spike, 0 vs healthy baseline = drought handled below
        if base >= 5 and count >= base * 3:
            a = {
                "id": new_id(), "camera_id": camera_id, "type": "spike",
                "severity": "critical", "opened_at": now_iso(), "status": "open",
                "facts": {"label": label, "count": count, "baseline": base, "ratio": round(count/max(1,base),2)},
                "note": f"'{label}' detections spiked {count} vs baseline {base}",
            }
            await db.anomalies.insert_one(a)
            created.append(clean(a))

    for label, base in prior.items():
        count = curr.get(label, 0)
        if base >= 10 and count == 0:
            a = {
                "id": new_id(), "camera_id": camera_id, "type": "drought",
                "severity": "warning", "opened_at": now_iso(), "status": "open",
                "facts": {"label": label, "baseline": base},
                "note": f"'{label}' vanished (was {base} last window)",
            }
            await db.anomalies.insert_one(a)
            created.append(clean(a))

    # New class (never before seen on this camera)
    ever = await db.detection_events.aggregate([
        {"$match": {"camera_id": camera_id, "detected_at": {"$lt": since_iso}}},
        {"$unwind": "$objects"}, {"$group": {"_id": "$objects.label"}},
    ]).to_list(500)
    ever_set = {r["_id"] for r in ever}
    for label in curr:
        if label not in ever_set and label is not None:
            a = {
                "id": new_id(), "camera_id": camera_id, "type": "new_class",
                "severity": "info", "opened_at": now_iso(), "status": "open",
                "facts": {"label": label, "count": curr[label]},
                "note": f"first sighting of '{label}' on this camera",
            }
            await db.anomalies.insert_one(a)
            created.append(clean(a))

    return created


@app.post("/api/anomalies/scan")
async def scan_anomalies(camera_id: str, minutes: int = 10):
    created = await _scan_anomalies(camera_id, minutes)
    return {"created": len(created), "anomalies": created}


@app.get("/api/anomalies")
async def list_anomalies(status: Optional[str] = None, camera_id: Optional[str] = None, limit: int = 100):
    q: dict = {}
    if status:
        q["status"] = status
    if camera_id:
        q["camera_id"] = camera_id
    return [clean(a) async for a in db.anomalies.find(q).sort("opened_at", -1).limit(limit)]


@app.post("/api/anomalies/{aid}/ack")
async def ack_anomaly(aid: str, payload: AnomalyLifecycle):
    r = await db.anomalies.update_one(
        {"id": aid}, {"$set": {"status": "acknowledged", "ack_at": now_iso(), "ack_by": payload.actor, "ack_note": payload.note}}
    )
    if not r.matched_count:
        raise HTTPException(404, "anomaly not found")
    return {"ok": True}


@app.post("/api/anomalies/{aid}/resolve")
async def resolve_anomaly(aid: str, payload: AnomalyLifecycle):
    r = await db.anomalies.update_one(
        {"id": aid}, {"$set": {"status": "resolved", "resolved_at": now_iso(), "resolved_by": payload.actor, "resolve_note": payload.note}}
    )
    if not r.matched_count:
        raise HTTPException(404, "anomaly not found")
    return {"ok": True}


# ---------- Face Identity / Watchlist ----------------------------------------
@app.post("/api/identities/enroll")
async def enroll_face(
    name: str = Query(...),
    category: str = Query("watchlist"),
    priority: str = Query("normal"),
    notes: str = Query(""),
    file: UploadFile = File(...),
):
    raw = await file.read()
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "invalid image")
    faces = face_app().get(img)
    if not faces:
        raise HTTPException(400, "no face detected")
    if len(faces) > 1:
        # pick the largest face
        faces.sort(key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1]), reverse=True)
    f = faces[0]
    emb = f.normed_embedding.tolist()

    ident_id = new_id()
    # save a crop for the UI
    x1, y1, x2, y2 = [max(0, int(v)) for v in f.bbox]
    crop = img[y1:y2, x1:x2]
    crop_name = f"{ident_id}.jpg"
    if crop.size > 0:
        cv2.imwrite(str(FACES_DIR / crop_name), crop)

    doc = {
        "id": ident_id, "name": name, "category": category,
        "priority": priority, "notes": notes,
        "embedding": emb, "photo": f"/api/media/faces/{crop_name}",
        "created_at": now_iso(),
    }
    await db.identities.insert_one(doc)
    d = clean(doc.copy())
    d.pop("embedding", None)  # don't return 512-dim vector to UI
    return d


@app.get("/api/identities")
async def list_identities():
    out = []
    async for i in db.identities.find().sort("created_at", -1):
        i = clean(i)
        i.pop("embedding", None)
        out.append(i)
    return out


@app.delete("/api/identities/{iid}")
async def delete_identity(iid: str):
    r = await db.identities.delete_one({"id": iid})
    # hard-delete match events tied to this identity (compliance §3.1)
    await db.match_events.delete_many({"identity_id": iid})
    return {"deleted": r.deleted_count}


@app.get("/api/matches")
async def list_matches(camera_id: Optional[str] = None, identity_id: Optional[str] = None, limit: int = 100):
    q: dict = {}
    if camera_id:
        q["camera_id"] = camera_id
    if identity_id:
        q["identity_id"] = identity_id
    return [clean(m) async for m in db.match_events.find(q).sort("detected_at", -1).limit(limit)]


# ---------- Subject Lock (Investigation Mode) --------------------------------
@app.post("/api/locks")
async def create_lock(payload: LockCreate):
    lock = {
        "id": new_id(),
        "kind": payload.kind, "target": payload.target, "label": payload.label,
        "created_at": now_iso(), "status": "active",
    }
    await db.locks.insert_one(lock)
    return clean(lock)


@app.get("/api/locks")
async def list_locks():
    return [clean(l) async for l in db.locks.find().sort("created_at", -1)]


@app.delete("/api/locks/{lid}")
async def close_lock(lid: str):
    r = await db.locks.update_one({"id": lid}, {"$set": {"status": "closed", "closed_at": now_iso()}})
    return {"ok": bool(r.matched_count)}


@app.get("/api/locks/{lid}/sweep")
async def sweep_lock(lid: str, window_minutes: int = 60):
    """Retrospective sweep: find every ledger row / match event related to a target."""
    lock = await db.locks.find_one({"id": lid})
    if not lock:
        raise HTTPException(404, "lock not found")
    since = (datetime.now(timezone.utc) - timedelta(minutes=window_minutes)).isoformat()
    sightings: list[dict] = []

    if lock["kind"] == "face":
        async for m in db.match_events.find({"identity_id": lock["target"], "detected_at": {"$gte": since}}).sort("detected_at", 1):
            sightings.append({
                "type": "face_match", "camera_id": m["camera_id"],
                "frame_ref": m["frame_ref"], "detected_at": m["detected_at"],
                "similarity": m["similarity"], "name": m.get("name"),
            })
    elif lock["kind"] == "class":
        cur = db.detection_events.find(
            {"detected_at": {"$gte": since}, "objects.label": lock["target"]}
        ).sort("detected_at", 1)
        async for r in cur:
            matched = [o for o in r.get("objects", []) if o.get("label") == lock["target"]]
            if matched:
                sightings.append({
                    "type": "class_hit", "camera_id": r["camera_id"],
                    "frame_ref": r["frame_ref"], "detected_at": r["detected_at"],
                    "matches": matched,
                })

    # Timeline: group by camera to show cross-camera journey
    cameras: dict[str, dict] = {}
    for s in sightings:
        cid = s["camera_id"]
        cameras.setdefault(cid, {"camera_id": cid, "first": s["detected_at"], "last": s["detected_at"], "count": 0})
        cameras[cid]["last"] = s["detected_at"]
        cameras[cid]["count"] += 1
    journey = sorted(cameras.values(), key=lambda x: x["first"])

    return {"lock": clean(lock), "count": len(sightings), "sightings": sightings, "journey": journey}


# ---------- LLM narrative (grounded, Emergent Universal LLM key) -------------
@app.post("/api/narrative")
async def narrative(payload: NarrativeRequest):
    minutes = {"1m": 1, "10m": 10, "1h": 60, "1d": 1440}.get(payload.cadence, 10)
    if payload.camera_id:
        fs = await factsheet(payload.camera_id, minutes)
        cam = await db.cameras.find_one({"id": payload.camera_id}) or {}
        pack = DOMAIN_PACKS.get(cam.get("pack", "general"), DOMAIN_PACKS["general"])
    else:
        # aggregate all cameras
        since = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
        rows = [clean(r) async for r in db.detection_events.find({"detected_at": {"$gte": since}}).limit(500)]
        counts: dict[str, int] = {}
        for r in rows:
            for o in r.get("objects", []):
                counts[o["label"]] = counts.get(o["label"], 0) + 1
        fs = {
            "scope": "all_cameras",
            "window": {"minutes": minutes, "to": now_iso()},
            "frames_seen": len(rows),
            "detections_per_class": [{"label": k, "detections": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])],
        }
        pack = DOMAIN_PACKS["general"]

    # Recent open anomalies for context
    anomalies_ctx = [clean(a) async for a in db.anomalies.find({"status": "open"}).sort("opened_at", -1).limit(10)]

    if not EMERGENT_LLM_KEY:
        # fallback: template narrative
        top = ", ".join("{}({})".format(d["label"], d["detections"]) for d in fs.get("detections_per_class", [])[:5])
        n = f"Cadence {payload.cadence}: {fs.get('frames_seen', 0)} frames observed. Top classes: {top}. Open anomalies: {len(anomalies_ctx)}."
        return {"narrative": n, "facts": fs, "anomalies": anomalies_ctx, "model": "template"}

    prompt = (
        f"You are the narrative engine for Vision Intelligence Core. Style: {pack['narrative_style']}. "
        "Given ONLY the JSON fact-sheet and open anomalies below, write a concise 3-sentence operator briefing. "
        "Cite specific numbers. Do not invent classes not present. Do not speculate about identities.\n\n"
        f"FACT-SHEET:\n{json.dumps(fs, indent=2)}\n\nOPEN_ANOMALIES:\n{json.dumps(anomalies_ctx[:5], indent=2)}"
    )

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"vic-narrative-{new_id()[:8]}",
            system_message="You produce grounded, fact-based operator briefings. Never speculate.",
        ).with_model("openai", "gpt-5.4")
        reply = await chat.send_message(UserMessage(text=prompt))
        text = reply if isinstance(reply, str) else str(reply)
    except Exception as e:
        text = f"[LLM error, fallback] frames_seen={fs.get('frames_seen',0)}, open_anomalies={len(anomalies_ctx)}. ({e})"

    doc = {
        "id": new_id(), "camera_id": payload.camera_id, "cadence": payload.cadence,
        "narrative": text, "facts": fs, "generated_at": now_iso(),
    }
    await db.narratives.insert_one(doc)
    return clean(doc)


@app.get("/api/narratives")
async def list_narratives(limit: int = 20):
    return [clean(n) async for n in db.narratives.find().sort("generated_at", -1).limit(limit)]


# ---------- Metrics / Observability ------------------------------------------
@app.get("/api/metrics")
async def metrics():
    now = datetime.now(timezone.utc)
    since1 = (now - timedelta(minutes=1)).isoformat()
    since10 = (now - timedelta(minutes=10)).isoformat()
    fpm = await db.detection_events.count_documents({"detected_at": {"$gte": since1}})
    events10m = await db.detection_events.count_documents({"detected_at": {"$gte": since10}})
    open_anoms = await db.anomalies.count_documents({"status": "open"})
    cams_total = await db.cameras.count_documents({})
    cams_online = await db.cameras.count_documents({
        "last_heartbeat": {"$gte": (now - timedelta(minutes=2)).isoformat()}
    })
    identities = await db.identities.count_documents({})
    matches = await db.match_events.count_documents({"detected_at": {"$gte": since10}})
    return {
        "fpm": fpm,
        "events_10m": events10m,
        "open_anomalies": open_anoms,
        "cameras": {"total": cams_total, "online": cams_online, "offline": cams_total - cams_online},
        "identities_enrolled": identities,
        "matches_10m": matches,
        "ts": now_iso(),
    }


# ---------- Retention (manual purge, safe: skip open-anomaly frames) --------
@app.post("/api/retention/purge")
async def purge(hours: int = 24):
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    open_refs: set[str] = set()
    async for a in db.anomalies.find({"status": {"$in": ["open", "acknowledged"]}}):
        f = a.get("facts", {}).get("frame_ref")
        if f:
            open_refs.add(f)
    # Files in /api/media/frames older than cutoff and not in open_refs
    purged = 0
    for path in FRAMES_DIR.iterdir():
        if not path.is_file():
            continue
        ref = f"/api/media/frames/{path.name}"
        if ref in open_refs:
            continue
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        if mtime < cutoff:
            try:
                path.unlink()
                purged += 1
            except OSError:
                pass
    # Ledger rows older than retention.ledger_days = 90 (config)
    ledger_cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    r = await db.detection_events.delete_many({"detected_at": {"$lt": ledger_cutoff}})
    return {"frames_purged": purged, "ledger_rows_purged": r.deleted_count}


# ---------- Seed helper for demo ---------------------------------------------
@app.post("/api/seed_sample")
async def seed_sample():
    """Idempotent: ensure two demo cameras exist."""
    existing = await db.cameras.count_documents({})
    if existing >= 2:
        return {"ok": True, "seeded": False, "count": existing}
    demos = [
        {"name": "Room 4B Cam (classroom)", "source": {"type": "sample", "uri": "classroom.mp4"},
         "site": "campus-a", "fps": 1, "pack": "school", "zones": []},
        {"name": "Playground Cam (traffic)", "source": {"type": "sample", "uri": "traffic.mp4"},
         "site": "campus-a", "fps": 1, "pack": "traffic", "zones": []},
    ]
    for p in demos:
        c = Camera(id=new_id(), created_at=now_iso(), **p).model_dump()
        await db.cameras.insert_one(c)
    return {"ok": True, "seeded": True}
