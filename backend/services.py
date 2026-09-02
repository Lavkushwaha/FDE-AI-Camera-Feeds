"""ML model singletons + the video-processing worker.

`process_video` is what routers/cameras.py hands off to BackgroundTasks.
It also emits **zone presence events** using YOLO track IDs + polygons.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from state import ROOT, FRAMES_DIR
from db import db, new_id, now_iso, clean

# ---- Lazy singletons -------------------------------------------------------
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


# ---- Helpers ---------------------------------------------------------------
def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a); nb = np.linalg.norm(b)
    if na == 0 or nb == 0: return 0.0
    return float(np.dot(a, b) / (na * nb))


def _point_in_zone(nx: float, ny: float, polygon: list[list[float]]) -> bool:
    """Ray-cast; polygon points are normalised [0..1]."""
    poly = np.array(polygon, dtype=np.float32)
    if len(poly) < 3:
        return False
    return cv2.pointPolygonTest(poly, (float(nx), float(ny)), False) >= 0


async def _update_presence(camera_id: str, zones: list[dict], objects: list[dict],
                            frame_ref: str, ts: str, frame_w: int, frame_h: int) -> list[dict]:
    """Emit enter/exit for each (track_id, zone). Returns per-frame zone_hits."""
    if not zones or not objects:
        return []

    frame_hits: list[dict] = []
    currently_in: dict[str, set[str]] = {}  # track_key → set(zone_id)

    for o in objects:
        tid = o.get("track_id")
        if tid is None:
            continue
        x1, y1, x2, y2 = o["bbox"]
        # foot-point for people, centre for everything else
        if o.get("label") == "person":
            cx, cy = (x1 + x2) / 2 / frame_w, y2 / frame_h
        else:
            cx, cy = (x1 + x2) / 2 / frame_w, (y1 + y2) / 2 / frame_h

        track_key = f"{camera_id}:{int(tid)}"
        for z in zones:
            if _point_in_zone(cx, cy, z["polygon"]):
                currently_in.setdefault(track_key, set()).add(z["id"])
                frame_hits.append({
                    "zone_id": z["id"], "zone_name": z.get("name", ""),
                    "track_id": int(tid), "label": o.get("label"),
                })

    # Reconcile with open events in DB (exited_at is null)
    open_docs = [c async for c in db.presence_events.find(
        {"camera_id": camera_id, "exited_at": None}
    )]
    open_map: dict[tuple[str, str], dict] = {(d["track_key"], d["zone_id"]): d for d in open_docs}

    # Enters
    for track_key, zids in currently_in.items():
        for zid in zids:
            if (track_key, zid) not in open_map:
                zname = next((z.get("name", "") for z in zones if z["id"] == zid), "")
                await db.presence_events.insert_one({
                    "id": new_id(), "camera_id": camera_id,
                    "zone_id": zid, "zone_name": zname,
                    "track_key": track_key, "track_id": int(track_key.split(":")[-1]),
                    "entered_at": ts, "exited_at": None,
                    "enter_frame": frame_ref, "exit_frame": None,
                    "last_seen_at": ts, "hits": 1,
                })
            else:
                d = open_map[(track_key, zid)]
                await db.presence_events.update_one(
                    {"id": d["id"]},
                    {"$set": {"last_seen_at": ts}, "$inc": {"hits": 1}},
                )

    # Exits — anything open on this camera not currently in that zone
    for (tk, zid), d in open_map.items():
        # Only close events for tracks we saw this frame but which have left the zone
        if tk in currently_in and zid not in currently_in[tk]:
            await db.presence_events.update_one(
                {"id": d["id"]},
                {"$set": {"exited_at": ts, "exit_frame": frame_ref}},
            )

    return frame_hits


# ---- Main video processor --------------------------------------------------
async def process_video(job_id: str, cid: str, path: str, sample_fps: float, max_frames: int):
    from state import DOMAIN_PACKS
    await db.jobs.update_one({"id": job_id}, {"$set": {"status": "running", "started_at": now_iso()}})

    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise RuntimeError("cannot open video")
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        stride = max(1, int(round(src_fps / sample_fps)))
        target = min(max_frames, (total // stride) if total else max_frames)

        identities = [clean(x) async for x in db.identities.find()]
        id_vecs = [(i, np.array(i["embedding"], dtype=np.float32)) for i in identities if i.get("embedding")]

        cam = await db.cameras.find_one({"id": cid}) or {}
        pack = DOMAIN_PACKS.get(cam.get("pack", "general"), DOMAIN_PACKS["general"])
        vocab = set(pack["vocabulary"])
        zones = cam.get("zones", [])

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
            frame_h, frame_w = frame.shape[:2]
            frame_name = f"{cid}_{int(time.time() * 1000)}_{written:04d}.jpg"
            frame_path = FRAMES_DIR / frame_name  # emergent-lint-disable
            cv2.imwrite(str(frame_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
            frame_ref = f"/api/media/frames/{frame_name}"

            # YOLO detect+track
            results = yolo_model.track(frame, persist=True, verbose=False, conf=0.35, iou=0.5)
            objects: list[dict] = []
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

            # Zone presence — enter/exit events + per-frame zone_hits
            zone_hits = await _update_presence(cid, zones, objects, frame_ref, ts, frame_w, frame_h)

            # Faces
            faces_out: list[dict] = []
            faces = face_model.get(frame)
            for f in faces:
                emb = f.normed_embedding
                match = None
                if id_vecs:
                    best = max(id_vecs, key=lambda x: cosine(emb, x[1]))
                    sim = cosine(emb, best[1])
                    if sim > 0.42:
                        match = {
                            "identity_id": best[0]["id"], "name": best[0]["name"],
                            "category": best[0]["category"], "priority": best[0].get("priority", "normal"),
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

            await db.detection_events.insert_one({
                "id": new_id(),
                "camera_id": cid,
                "detected_at": ts,
                "frame_ref": frame_ref,
                "objects": objects,
                "faces": faces_out,
                "zone_hits": zone_hits,
                "pack": cam.get("pack", "general"),
                "frame_size": {"w": frame_w, "h": frame_h},
            })

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
        # Close any presence events still open when the video ends
        await db.presence_events.update_many(
            {"camera_id": cid, "exited_at": None, "last_seen_at": {"$lte": now_iso()}},
            {"$set": {"exited_at": now_iso()}},
        )
        try:
            Path(path).unlink(missing_ok=True)
        except Exception:
            pass
        await db.jobs.update_one(
            {"id": job_id},
            {"$set": {"status": "done", "finished_at": now_iso(), "progress": 1.0}},
        )
        from routers.anomalies import scan_camera
        await scan_camera(cid)
    except Exception as e:
        await db.jobs.update_one(
            {"id": job_id},
            {"$set": {"status": "error", "error": str(e), "finished_at": now_iso()}},
        )
