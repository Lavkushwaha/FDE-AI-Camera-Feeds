# PRD — Vision Intelligence Core (VIC) · Emergent Rebuild

## Original problem statement
> "Here check the code base read the md files, dashboard is pretty boring and milestone 0 is only done and not in ideal way, use the docs and proceed to completeing other milestone and end to end core engine, that can be applied to other use cases. and processing video is just basic so improve this so we can get more feature from it, face matching and all"

## User choices for this session
- **Runtime**: Refactor the Docker Compose microservices concepts into an Emergent-hosted stack (React + FastAPI + MongoDB) so it's runnable in the preview. The original Docker/Postgres/TypeScript microservices are left untouched.
- **Priorities (in order)**: rich dashboard rebuild → face matching/identity → better video processing → domain packs → anomaly lifecycle.
- **Face matching backend**: CPU embeddings (chose InsightFace `buffalo_s` via onnxruntime for reliability in the Emergent container — same class of CPU embedding as face_recognition/dlib, but doesn't require the heavy dlib compile).
- **Video source & LLM**: defaults — .mp4 uploads processed frame-by-frame; Emergent Universal LLM Key with gpt-5.4 for grounded narratives.

## Architecture
- **Backend** (`/app/backend/server.py`): FastAPI + Motor (MongoDB).
  - Model seams: YOLOv8n + ByteTrack (persistent track IDs) via ultralytics; InsightFace `buffalo_s` for face detection + 512-dim embeddings.
  - Static media via `/api/media/frames`, `/api/media/faces`, `/api/media/uploads` (routed through ingress).
  - LLM: `emergentintegrations` (`gpt-5.4`) with grounded fact-sheet prompt.
- **Frontend** (`/app/frontend`): React + Tailwind + Lucide. Dark tactical dashboard (Palantir/Verkada aesthetic, Barlow Condensed / Inter / JetBrains Mono).

## Implemented (Jan 2026)
### Core engine (domain-agnostic)
- Camera Registry (file / rtsp / webcam / sample source types), zones per camera, health heartbeat.
- Video ingest pipeline: upload → sample frames → YOLO detect + ByteTrack → InsightFace face detect + watchlist match → append-only `detection_events` ledger.
- **Fact Ledger**: `/api/ledger`, `/api/ledger/factsheet`, JSON + CSV export.
- **Anomaly Engine**: `capture_gap`, `spike` (3× baseline), `drought`, `new_class` — with `open → acknowledged → resolved` lifecycle. `frame_ref` captured for purge exemption.
- **Face Identity & Watchlist**: enroll (image upload), list, delete (hard-delete embeddings + match events), live match stream.
- **Subject Lock / Investigation Mode**: lock by face identity / COCO class / plate; retrospective sweep with cross-camera journey.
- **LLM Narrative** (Emergent Universal Key, gpt-5.4): grounded per-cadence briefings (1m/10m/1h/1d) with pack-aware style.
- **Domain Packs**: school, retail, traffic, general — vocabulary, watchlist categories, narrative style.
- **Retention**: manual purge with exemption for open anomalies.
- **Observability**: FPM, events, anomalies, cameras online/total, identities, matches (10m) tiles.

### Dashboard (7 modules, all wired to live backend)
1. Overview — 6 metric tiles + recent detections + camera health + open anomalies + AI Briefing.
2. Camera Grid — live cards with YOLO overlay (bboxes + labels + track IDs + face match badges), upload video modal, zone polygon editor (canvas), add/remove cameras.
3. Fact Ledger — filterable table, factsheet cards, JSON/CSV export links, pause/resume live append.
4. Anomalies — severity-badged feed, scan-now, ack/resolve actions.
5. Identities — enrolled grid + live match feed + enroll modal.
6. Subject Lock — target picker (face/class/plate), retrospective sweep, cross-camera journey ribbon, evidence timeline.
7. Narratives — cadence-aware LLM briefings + grounding facts.

## Verified
- 17/17 backend pytest cases passing; frontend smoke test on all 7 tabs green with zero console errors (see `/app/test_reports/iteration_1.json`).
- Real end-to-end: uploading a bus.jpg-derived mp4 → 6 frames → 18 person detections (YOLO) + 2 faces per frame (InsightFace) → capture_gap + new_class anomalies auto-created → LLM narrative citing exact numbers.

## Prioritized backlog
- **P1 · Live RTSP ingest worker** — currently `rtsp`/`webcam` cameras are registered but not auto-spawned; only file uploads run through the pipeline in-process.
- **P1 · Presence events** (entered/exited zones via track IDs) writing to `presence_events` — schema is defined but no worker yet.
- **P2 · Summary cadence scheduler** — currently on-demand only; needs cron per camera per cadence.
- **P2 · YOLO overlay for VIDEO (not just last frame)** — a real live-mode timeline scrubber over stored frames.
- **P2 · Domain pack rules** — actual per-pack rule dispatch (retail shelf-gap, traffic red-light violation) beyond vocabulary.
- **P3 · Vector index for identity** — switch Mongo embedding scan to Qdrant when identities > 5k.
- **P3 · Auth** — deferred by design (single-operator LAN assumption in v1).

## Notes for future sessions
- Sample .mp4 videos are not shipped. Users can generate one with `ffmpeg -f lavfi -i testsrc=size=640x360:rate=10:duration=6 -c:v libx264 /tmp/demo.mp4` or upload their own.
- Docker Compose microservices in `/app/services/*` and `/app/dashboard/` are untouched per user request.
