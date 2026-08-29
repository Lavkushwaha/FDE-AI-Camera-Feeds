# MILESTONE — v0.1.0-poc "The Ledger Works"

**Date:** 2026-08-29
**Tag:** `v0.1.0-poc`
**What this milestone claims:** a complete, working end-to-end pipeline — live RTSP video → frame sampling → real GPU object detection → append-only fact ledger → SQL fact-sheets → grounded LLM narratives → rule-based anomaly detection. Every link verified with real data on a single machine.

---

## 1. What works end-to-end (all verified)

```
[mp4 videos as CCTV]                    classroom.mp4 → cam1, traffic.mp4 → cam2
      │ RTSP push (ffmpeg -c copy, persistent connection)
      ▼
[MediaMTX] ── HLS :8888 ──► [Gateway :4000]  (stream tokens, stub auth)
      │
      ▼
[frame-grabbers]   1 FPS, -strftime wallclock filenames, shared volume ./data/frames
      │
      ▼
[frame-sampler :4003]  newest-file polling + dedup guard
      │ POST /infer/frame (shared-volume frame_url)
      ▼
[inference-service :5000]  YOLOv8n on CUDA (RTX 4070, 12 GB), ~200 ms/frame
      │ faces + objects JSON (LLD §2.1 contract)
      ▼
[frame-sampler persist]  per-DETECTION rows, transactional
      ▼
[Postgres :5432]  detection_events (append-only audit ledger)
      │
      ├── SQL aggregation ──► [presence-timeline :4004] GET /summary/:cameraId
      │                             │ facts-only prompt
      │                             ▼
      │                       Ollama (llama3.1:8b, GPU) → grounded narrative
      │
      └── POST /anomalies/scan ──► z-score spike/drought, new_class,
                                    capture_gap → anomalies table
```

## 2. Verified numbers (this machine)

| Metric | Value |
|---|---|
| Inference latency (steady state) | ~200 ms/frame (yolov8n, 720p, RTX 4070 SUPER) |
| Frame budget at 1 FPS × 2 cameras | 1000 ms → ~60% headroom |
| Detections/min (traffic cam) | ~500 cars, ~30 buses, ~25 trucks |
| Frame capture reliability | 60/60 frames seen per minute (tested) |
| Narrative grounding | 100% of claims traced to fact-sheet (manual fact-check) |
| Disk cost | ~50 KB/frame ≈ 8 GB/day at 2 cams × 1 FPS |

## 3. What is deliberately stubbed (known gaps)

| Piece | Status | Blocked by |
|---|---|---|
| Camera registry | Hardcoded in frame-sampler | Phase 1 generalization |
| Identity (face reg/dereg/match) | Absent — `student_id` always null | InsightFace + Qdrant wiring |
| Queue (Redis) | Running, unused | Phase 1: sampler→queue→consumers |
| Attendance auto-marking | Manual endpoint only | Identity + queue |
| Presence stitching / gaps | Read APIs only, no worker | Detection volume + queue |
| Anomaly lifecycle | Table has no ack/resolve states | Phase 1 |
| Retention | None — frames accumulate forever | Phase 1 cron |
| Dashboard | Placeholder | Phase 3 |
| Auth | Fake token in gateway | Phase 3 |
| Multi-tenant | `school_id` in schema, unenforced | Phase 4 |

## 4. Demo script (from clean clone)

```bash
docker compose up -d --build          # full stack
docker compose exec ollama ollama pull llama3.1:8b   # one-time, ~4.7 GB
# wait ~60s, then:
curl http://localhost:4000/health     # and 4001..4004, 5000
curl http://localhost:8888/cam1       # live HLS in browser
# let it run 2+ minutes, then:
curl "http://localhost:4004/summary/44444444-4444-4444-4444-444444444442"
curl -X POST http://localhost:4004/anomalies/scan -H "Content-Type: application/json" \
  -d '{"camera_id": "44444444-4444-4444-4444-444444444442"}'
```

Anomaly proof test: `docker compose stop frame-grabber-2` for 2 minutes → scan → expect `capture_gap` anomaly with `frames_seen ≈ 0`.

## 5. Seed data (fixed UUIDs, in `infra/postgres/init.sql`)

school `11111111-…-111111111111` · class `22222222-…-22` · Room 4B `…331` · Playground `…332` · cam1 `…441` (Room 4B) · cam2 `…442` (Playground) · student `…551` · one timetable slot (Mon 12:15–13:00 UTC, Maths, Room 4B)

## 6. Environment that ran this

Windows 11 + Docker Desktop (WSL2) · RTX 4070 SUPER 12 GB, NVIDIA container toolkit via WSL2 · Compose v5 · no host Python/ffmpeg required (all containerized).

## 7. Next milestone

See `FRAMEWORK.md` § Roadmap — Phase 1: core generalization (camera registry, config-driven vocabulary, action dispatcher, anomaly lifecycle, retention).
