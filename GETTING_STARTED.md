# Getting Started — School Vision POC

Step-by-step guide to run this project from zero. Prerequisites first, then bring-up
order, then what to verify at each stage (each verification maps to a build-order
step in the LLD, section 6).

---

## 0. Prerequisites

| Tool | Version needed | Why |
|---|---|---|
| Docker Desktop | 4.x+ (Compose v2) | Runs the entire stack |
| Node.js | 20.x | Only needed if you run services outside Docker |
| Git | any | Clone/pull |

Optional (only for wiring real ML later):
- NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) (Windows: WSL2 backend required)
- curl or Postman for hitting the APIs

Check Docker works:
```bash
docker --version
docker compose version
```

---

## 1. Start the core infrastructure first

Postgres, Redis, Qdrant, Ollama, MediaMTX:

```bash
docker compose up -d postgres redis qdrant ollama mediamtx
```

Verify each is alive:

```bash
# Postgres (schema + seed data loaded from infra/postgres/init.sql)
docker compose exec postgres psql -U postgres -d school_poc -c "\dt"
# Expect 10 tables: schools, classes, students, rooms, timetable_slots,
# cameras, face_embeddings, detection_events, presence_intervals,
# gaps, gap_sightings, attendance_records

# Qdrant dashboard
curl http://localhost:6333/collections

# Ollama (API up, no model pulled yet)
curl http://localhost:11434/api/tags

# MediaMTX HLS endpoint (empty until cameras start)
curl  
```

Seed data note — these fixed UUIDs are baked into `infra/postgres/init.sql`
and used by the demo:

```
school   : 11111111-1111-1111-1111-111111111111
class    : 22222222-2222-2222-2222-222222222222   (Grade 8-B)
room 4B  : 33333333-3333-3333-3333-333333333331
playground: 33333333-3333-3333-3333-333333333332
cam1     : 44444444-4444-4444-4444-444444444441   (Room 4B Cam)
cam2     : 44444444-4444-4444-4444-444444444442   (Ground Cam 1)
student  : 55555555-5555-5555-5555-555555555551   (Demo Student)
timetable: one slot — Maths, Period 2, Room 4B, 12:15–13:00, day_of_week=1 (Mon)
```

⚠️ Timetable caveat: the only seeded slot is **Monday period 2 (12:15–13:00 UTC)**.
The mapping service resolves against UTC day/time (`getUTCDay()`), so asking
"current slot" outside Monday 12:15–13:00 UTC returns 404 by design.

---

## 2. Pull the local LLM (one-time)

```bash
docker compose exec ollama ollama pull llama3.1:8b
```

Verify:
```bash
curl http://localhost:11434/api/tags
# model "llama3.1:8b" should be listed (~4.7 GB download, one-time)
```

Skip this if you only want to test streaming/mapping/attendance — it's needed
for the presence-timeline narrative endpoint.

---

## 3. Start the mock cameras

```bash
docker compose up -d mock-camera-1 mock-camera-2
```

Verify the streams are live:
```bash
curl http://localhost:8888/cam1/index.m3u8   # HLS manifest should render
curl http://localhost:8888/cam2/index.m3u8
```

Watch in VLC / browser if you like:
- VLC → Media → Open Network Stream → `rtsp://localhost:8554/cam1`
- HLS directly: `http://localhost:8888/cam1/index.m3u8`

The feeds are FFmpeg `testsrc` synthetic patterns (see
`mock-cameras/stream.sh`). To use real footage instead, drop `.mp4` files in
and switch the lavfi input to `-re -stream_loop -1 -i /videos/sample.mp4`
(commented in the script).

---

## 4. Start the application services

```bash
docker compose up -d inference-service gateway mapping-service erp-sync frame-sampler presence-timeline worker-manager dashboard
```

Or everything at once after the first time through manually:
```bash
docker compose up -d --build
```

Verify health of every service:

```bash
curl http://localhost:4000/health   # gateway
curl http://localhost:4001/health   # mapping-service
curl http://localhost:4002/health   # erp-sync
curl http://localhost:4003/health   # frame-sampler
curl http://localhost:4004/health   # presence-timeline
curl http://localhost:4005/health   # worker-manager (dynamic camera workers)
curl http://localhost:5000/health   # inference-service
curl -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # dashboard (static, no /health)
```

Each returns `{"status":"ok","service":"..."}`.

---

## 5. Verify each pipeline piece manually

### 5.1 Mapping service — resolve current timetable slot

```bash
curl "http://localhost:4001/rooms/33333333-3333-3333-3333-333333333331/current-slot"
```

- During Mon 12:15–13:00 UTC → the Maths Period 2 slot JSON
- Any other time → `{"error":"no active slot"}` (expected)

To force a match regardless of wall-clock time:
```bash
curl "http://localhost:4001/rooms/33333333-3333-3333-3333-333333333331/current-slot?timestamp=2026-08-24T12:30:00Z"
# 2026-08-24 is a Monday
```

### 5.2 Gateway — login + stream token

```bash
curl -X POST http://localhost:4000/auth/login
# -> { "token": "dev-token-replace-me" }   (POC stub)

curl http://localhost:4000/stream/44444444-4444-4444-4444-444444444441/token
# -> signed_url pointing at the cam1 HLS manifest + expires_at
```

Open `signed_url` from the response in a browser/VLC — you're watching the live mock camera.

### 5.3 Frame sampler → inference loop

```bash
docker compose logs -f frame-sampler
```

Every 5 s you'll see `sample tick result:` — the sampler posts a mock frame to
the inference service, which currently returns an empty detection (`faces` with
`student_id: null`). This proves flow B steps 1–5 plumbing up to the ML seam.

Tune interval:
```yaml
# in docker-compose.yml, frame-sampler environment:
SAMPLE_INTERVAL_MS: 2000
```

### 5.4 ERP sync — manual attendance mark (validates the write path)

```bash
curl -X POST http://localhost:4002/internal/attendance/mark \
  -H "Content-Type: application/json" \
  -d '{
    "student_id": "55555555-5555-5555-5555-555555555551",
    "timetable_slot_id": "<slot_uuid_from_step_5.1>",
    "date": "2026-08-24",
    "confidence": 0.94,
    "source_frame_ref": "manual-test"
  }'
# -> 201 created

# Re-run same command ->
# 200 { "status": "already_marked" }       (idempotency guard works)
```

Inspect in DB:
```bash
docker compose exec postgres psql -U postgres -d school_poc \
  -c "SELECT student_id, date, status, marked_by, confidence FROM attendance_records;"
```

Note: nothing calls this endpoint automatically yet (queue wiring is open work,
see README status table). Manual POST is the sanctioned way to exercise it today.

### 5.5 Presence timeline + Ollama narrative

The `gaps` table starts empty (no stitching worker running yet). To test the
narrative end-to-end, seed one gap manually:

```bash
docker compose exec postgres psql -U postgres -d school_poc \
  -c "INSERT INTO gaps (student_id, timetable_slot_id, gap_start) VALUES
      ('55555555-5555-5555-5555-555555555551', '<slot_uuid>', now() - interval '1 hour')
      RETURNING id;"

curl -X POST http://localhost:4004/presence/gap/<returned_gap_id>/narrative
# -> { "narrative": "...", "facts_used": {...} }   (llama3.1:8b responds locally)
```

Read back gaps for a student:
```bash
curl http://localhost:4004/presence/55555555-5555-5555-5555-555555555551/gaps
```

First narrative call takes ~10–60 s depending on your hardware (model load +
generation).

---

## 6. Dashboard

Static operator console (nginx + vanilla JS), talks to the gateway. It's a regular
compose service:

```bash
docker compose up -d --build dashboard gateway presence-timeline
```

Open http://localhost:3000 — live HLS per camera, YOLO overlay toggle, fact-sheet
JSON/CSV export, anomaly ack/resolve, on-demand Ollama narrative, and an "+ Add
camera" panel that calls `POST /registry/cameras` (see §7 below). Panels and the
APIs they consume are listed in `dashboard/README.md`.

## 7. Add a camera dynamically (no compose edit, no restart)

```bash
# drop a video into ./data/videos first, e.g. cp somefile.mp4 data/videos/
curl -X POST http://localhost:4000/registry/cameras -H "Content-Type: application/json" \
  -d '{"name": "New Cam", "source": {"type": "file", "uri": "/videos/somefile.mp4"}, "fps": 1}'
```

`worker-manager` polls the `cameras` table every 5s and spawns/stops the ffmpeg
publish+grab pair for you — see `services/worker-manager/README` comment at the
top of `src/index.ts`. `source.type` is one of:
- `file` — a video on disk under `./data/videos`, looped
- `rtsp` — an external RTSP camera URL, relayed into MediaMTX
- `webcam` — you push your own host webcam first (§0 prerequisites has the ffmpeg
  command), worker-manager only runs the frame-grabber half

Decommission with `curl -X DELETE http://localhost:4000/registry/cameras/<id>` —
this stops the worker but keeps all ledger history queryable by camera_id.

---

## 8. Shut down / reset

```bash
docker compose down                # stop everything, keep volumes
docker compose down -v             # also wipe Postgres/Qdrant/Ollama data (full reset)
```

After a full reset, repeat steps 1–4 (LLM pull only once; volume persists unless `-v`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `current-slot` always 404 | You're outside Mon 12:15–13:00 UTC — pass `?timestamp=` query param (step 5.1) |
| Services crash-loop right after `up` | Postgres wasn't ready yet; `docker compose restart <service>`, or add healthchecks (known gap, see README) |
| Narrative endpoint hangs/times out | Model not pulled (step 2), or first-load latency — retry once |
| Stream URL black screen in browser | Use VLC for RTSP; browsers need HLS via `<video>`/hls.js — the m3u8 alone won't play raw |
| Port already in use (5432/8888 common) | Stop local Postgres/other services or remap ports in `docker-compose.yml` |
| Fresh clone → tables missing | init.sql only runs on **first** volume creation — `docker compose down -v && docker compose up -d postgres` |

---

## Current known gaps (tracked in README)

Before relying on automation beyond what's above, know what's still open:
event-queue wiring (redis unused), auto-invocation of attendance marking,
presence stitching worker, retention/frame purge, summary cadence scheduler,
real auth. See the README "What's real vs stubbed" table.
