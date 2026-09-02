# PRD — Vision Intelligence Core (VIC) · Emergent Rebuild

## Original problem statement
> "Here check the code base read the md files, dashboard is pretty boring and milestone 0 is only done and not in ideal way, use the docs and proceed to completing other milestone and end to end core engine, that can be applied to other use cases. and processing video is just basic so improve this so we can get more feature from it, face matching and all"

## Follow-up asks (iteration 2)
> "anomalies should be a new class cause for every system anomalies can be different so need to define anomaly first and user can define anomaly on its own based on system requirement.
> also here we have directly used model, but we can have used harness and langgraph here so that not just briefing but it can also take action and more conversational.
> this should be presented as core engine, which can be adapted to any system.
> Subject lock can also trigger AI narration or alert or insights.
> LLM will process all the data from engine if user wants to, not on its own.
> also in live feeds if i want to show yolo layer add that also. and if i can't process frame images add this functionality as well.  fact sheet should include subject lock as well.
> Live Track Scrubber: Let operators scrub a stored video timeline and watch bboxes replay frame by frame across cameras."

## User choices
- Emergent stack (React + FastAPI + MongoDB) so it's demoable here. Docker microservices untouched.
- Face embeddings via InsightFace `buffalo_s` (CPU, onnxruntime).
- Emergent Universal LLM key with `gpt-5.4` for both grounded narratives and the tool-using Ops Agent.

## Architecture
- **Backend** (`/app/backend`):
  - `server.py` — FastAPI + Motor. Camera registry, ingest pipeline, ledger, anomaly rules, identities, locks, insights, chat, narratives, retention.
  - `ops_agent.py` — **LangGraph-style** tool-using harness (12 tools) over the Emergent LLM key. Loop: LLM → JSON action → dispatch → observation → LLM, until `{"final": ...}`. All actions are grounded on real DB reads/writes.
- **Frontend** (`/app/frontend`): React + Tailwind, 9-tab dark tactical console.

## Implemented (Jan 2026)

### Core engine (domain-agnostic)
- Camera Registry (file / rtsp / webcam / sample), per-camera zones, health heartbeat.
- Video ingest: upload → sample frames → YOLOv8n + ByteTrack (persistent track IDs) → InsightFace face detect + watchlist match → append-only `detection_events` ledger.
- **Anomaly Rule Studio (NEW)**: `anomaly_rules` collection + CRUD + toggle + dry-run test. Supported types: `capture_gap`, `class_threshold`, `class_spike`, `class_absence`, `class_new`, `face_match`. Scope: all or specific cameras. 5 defaults seeded; user can add unlimited custom rules. `/api/anomalies/scan` iterates enabled rules and stamps `rule_id + rule_name` on each created anomaly.
- **Face Identity & Watchlist**: enroll → 512-dim embedding + cosine match. Hard-delete embedding + match events per identity.
- **Subject Lock / Investigation Mode**: lock by face / class / plate; retrospective sweep with cross-camera journey; three **AI action modes** — `insight`, `alert` (severity-tagged), `narrate` (cinematic).
- **Ops Agent (NEW)**: `/api/chat` — tool-using LangGraph-style loop. Tools: `metrics`, `list_cameras`, `query_ledger`, `factsheet`, `list_anomalies`, `ack_anomaly`, `resolve_anomaly`, `list_identities`, `list_matches`, `create_lock`, `sweep_lock`, `list_rules`. Session memory persisted in `chat_messages`.
- **Grounded LLM narratives**: on-demand per-cadence briefings (1m/10m/1h/1d) — the LLM only touches engine data **when the operator asks**.
- **Domain Packs**: school / retail / traffic / general — vocabulary + watchlist categories + narrative style.
- **Retention**: manual purge with open-anomaly exemption.

### Dashboard (9 modules)
1. **Overview** — 6 metric tiles, core-engine banner, recent detections thumbnails, camera health, open anomalies, AI Briefing.
2. **Camera Grid** — live card + **YOLO overlay toggle per card**, upload video modal, **Track Scrubber modal** (slider + play/pause + speed + overlay toggle), **Frame Browser modal** (thumbnails → full-size w/ overlay), zone polygon editor, add/remove.
3. **Fact Ledger** — filterable table, factsheet now includes **subject-lock hits in window**, JSON/CSV export.
4. **Anomalies** — severity-badged feed, scan-now, ack/resolve.
5. **Anomaly Rules (NEW)** — Rule Studio: create/edit/toggle/delete/dry-run, per-camera scope, all rule types.
6. **Identities** — enrolled grid + live match feed + enroll modal.
7. **Subject Lock** — retrospective sweep + cross-camera journey ribbon + evidence timeline + **AI Insight / Alert / Narration** actions.
8. **Narratives** — on-demand LLM briefings.
9. **Ops Agent (NEW)** — chat UI, tool-call transcripts, prompt library, session persistence.

## Verified
- **Iter 1**: 17/17 backend + 7/7 frontend tabs.
- **Iter 2**: 15/15 backend + all 4 new-module smoke flows (Rules studio, Ops Agent chat, Track Scrubber, Lock Insights) — see `/app/test_reports/iteration_2.json`.

## Known follow-ups (surfaced by testing agent code review)
- `server.py` is 1.3k lines — split into routers/ before iter 3.
- `PUT /api/anomaly-rules/{id}` full-replace vs PATCH (system_default/created_at could be preserved server-side).
- `plate` sweep_lock type is not implemented (Ops Agent advertises it but it returns 0 sightings).
- `/api/cameras/{id}/frames` has no cursor pagination (hard cap 200) — fine for demo, not for hours of footage.
- `lock_insights` unbounded storage — add TTL when running long sessions.

## Prioritized backlog
- P1 · Live RTSP ingest worker (register-only today; only file uploads process).
- P1 · Presence events (zone entered/exited via track IDs) → `presence_events` collection.
- P2 · Router split (`/app/backend/routers/*.py`).
- P2 · Real webcam capture in browser → POST processed frames to `/api/frames`.
- P3 · Qdrant vector index for identities > 5k.
