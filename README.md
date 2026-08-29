# School Vision POC

Companion repo for the FDE portfolio brief. See the full design docs first:
- Problem brief, HLD, LLD, and Eval/Observability docs (shared separately in chat).

## What's real vs stubbed right now

See `MILESTONE.md` for the verified end-to-end pipeline and `FRAMEWORK.md` for the target
architecture and roadmap. Status snapshot:

| Piece | Status |
|---|---|
| Postgres schema + seed data | Real, runnable |
| MediaMTX + mock cameras (real .mp4 loops via ffmpeg) | Real, runnable |
| Gateway (registry, ledger export, anomalies, HLS proxy) | Real; `/auth/login` stays a stub (see §5 auth trigger in FRAMEWORK.md) |
| Dynamic camera registry (`POST`/`DELETE /registry/cameras`) | Real — worker-manager spawns/stops ffmpeg per camera row; see §2.1 |
| Mapping service (room+time -> timetable slot) | Real query logic |
| ERP sync (idempotent attendance write + conflict handling) | Real query logic |
| Frame sampler | Real — polls the DB-driven camera registry, runs inference, persists detections + heartbeats |
| Inference service | Real FastAPI + YOLOv8 (GPU when available); InsightFace face-matching is the next seam to plug in |
| Anomaly engine (spike/drought/new_class/capture_gap) | Real, with ack/resolve lifecycle |
| Presence timeline + Ollama narrative | Real query + prompt logic, on-demand only (no cadence scheduler yet) |
| Dashboard | Real — `docker compose up -d --build dashboard`, see dashboard/README.md |
| Retention / frame purge | Not implemented — frames accumulate until manually cleared |

## Run it

See **[GETTING_STARTED.md](./GETTING_STARTED.md)** for the full step-by-step bring-up guide (infra → cameras → services → verification per pipeline stage).

Quick start:
```bash
docker compose up --build
```

Then:
```bash
curl http://localhost:4000/health
curl http://localhost:4001/health
curl http://localhost:4002/health
curl http://localhost:5000/health
curl "http://localhost:4001/rooms/33333333-3333-3333-3333-333333333331/current-slot"
```

To pull the local narrative model once ollama is up:
```bash
docker compose exec ollama ollama pull llama3.1:8b
```

## Build order (see LLD section 6)

1. Postgres schema + seed data — done
2. MediaMTX + mock cameras — done
3. Gateway auth + streaming — stubbed, wire real JWT next
4. Inference service standalone (this is where your GPU work plugs in)
5. Frame sampler -> inference -> queue -> erp-sync (happy path)
6. Presence timeline: interval stitching + gap detection
7. Cross-camera gap resolution
8. Local Ollama narrative generation
9. Dashboard

## Next concrete step

Wire real InsightFace (buffalo_l) + YOLO into `services/inference-service/app/main.py`
on your GPU machine — that's the one seam everything else already expects.
