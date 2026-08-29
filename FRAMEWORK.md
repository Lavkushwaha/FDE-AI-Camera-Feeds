# Vision Intelligence Core (VIC) — "core + packs"

**Name:** Vision Intelligence Core (**VIC**)
**Thesis:** one domain-agnostic core that turns cameras into an append-only *fact ledger*, plus pluggable **domain packs** that supply identity registries, business rules, actions, and UI. A school, a hospital, a home, a highway, a retail store, and a drone patrol run the **same core** with different packs.

> Design rules frozen from the POC:
> 1. **Rules detect, the LLM explains. Never the reverse.**
> 2. **Packs read the fact ledger; they never write it.** Domain writes go through the Action Dispatcher — audit integrity survives every pack.
> 3. **The camera is a config entry, not a code change.**

---

## 1. The layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│ DOMAIN PACKS (config + optional code)                            │
│   school · hospital · home · traffic · retail · defense · …      │
│   supplies: vocabulary, rules/thresholds, actions, prompts, UI   │
├──────────────────────────────────────────────────────────────────┤
│ SHARED EXTENSIONS (used by many packs, not core-critical)        │
│   Identity & Watchlist · Subject Lock (Investigation Mode)       │
│   Zones & Object Presence · ERP/HIS connector · Notifications    │
├──────────────────────────────────────────────────────────────────┤
│ CORE (domain-agnostic, this repo today)                          │
│   Camera Registry · Ingestion (RTSP→HLS) · Frame Sampler         │
│   Inference Seam · Fact Ledger · Frame Store · Baseline/Anomaly  │
│   Engine · Narrative Engine · Action Dispatcher · Retention      │
│   Observability                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Core subsystems — contracts, not implementations

### 2.1 Camera Registry & Provisioning

**Design (target state):**
```
POST   /registry/cameras   { name, source: {type: rtsp|file|webcam, uri}, site_id, fps }
GET    /registry/cameras/:id/health
DELETE /registry/cameras/:id            → decommission: stop worker, keep ledger
```
- Health state machine: `unknown → online → offline/degraded` via heartbeat + worker liveness
- Add/remove = registry row + worker spawn; **zero core code changes**
- Source types: `rtsp` (real CCTV), `file` (any local video, looped — mock/test), `webcam` (host device)

**Status: 🚧 COMING SOON (major feature — dynamic add/remove UI + worker orchestration).**
**Interim provisioning (works today, config-only):** point the registry at whatever you have:
- *Any video on disk:* mount the path read-only, loop it — e.g. **5 cameras all fed by the same video** to stress-test the framework
- *Webcam:* run on the **host**, not in a container — Windows/WSL2 Docker cannot pass through USB cameras directly. One command pushes your webcam as an RTSP feed:
  ```powershell
  ffmpeg -f dshow -i video="Your Camera Name" -c:v libx264 -preset veryfast -tune zerolatency -f rtsp rtsp://localhost:8554/camwebcam
  ```
  (list device names with `ffmpeg -list_devices true -f dshow -i dummy`)
The core treats all three source types identically downstream — which is the point: **mock and real cameras are indistinguishable to the pipeline.**

### 2.2 Inference Seam (single swap point, proven in POC)
`POST /infer/frame` → `{faces[], objects[]}`. YOLO today; InsightFace (faces), ANPR (plates), PPE classifiers, or an ensemble tomorrow. Per-deployment **class filter is config**.
**Tracking mode (new requirement):** the seam must also support persistent track IDs (`model.track()` — ByteTrack ships with ultralytics). Track IDs are what make Zones, Subject Lock, and presence events possible — raw per-frame boxes cannot tell "same car still there" from "another car arrived".

### 2.3 Fact Ledger (the framework's public API — version it)
One row per detection, append-only, never overwritten:
```
detection_events(camera_id, frame_ref, detected_at, confidence, bbox, label|JSONB payload)
```
Plus event-class rows for stateful extensions: `presence_events(subject/track_id, zone, event: entered|exited|appeared|disappeared, camera_id, frame_ref)`.
**Fact-sheet v1:**
```json
{ "camera_id": "…", "window": {"from": "…", "to": "…"},
  "frames_seen": 60, "frames_expected": 60,
  "detections_per_class": [{"label": "car", "detections": 547, "avg_conf": 0.64}] }
```
**Export contract:** every fact-sheet and ledger slice must be exportable as **JSON or CSV** (dashboard button + `GET /export/...?format=`) — users can pull facts into external tools/models for their own analysis. The ledger is the product; exports are how it leaves the building.

### 2.4 Anomaly Engine (mechanism in core, policy in packs)
| Type | Signal | Policy knob (pack config) |
|---|---|---|
| `spike` / `drought` | z-score vs trailing baseline | per-class z threshold, baseline window |
| `new_class` | class never seen on this camera | which classes are violations where |
| `capture_gap` | frames_seen < expected | tolerance, severity |
| `presence_violation` | zone event (item left shelf, person entered zone) | zone config + schedule |
Lifecycle: `open → acknowledged → resolved` with actor + timestamps.

### 2.5 Narrative Engine
Facts-only prompts; templates pack-supplied; grounding enforced. LLM swappable (Ollama local → hosted).
**Summary cadence (user-configurable, GPU-aware):** per **1 min / 10 min / 1 h / 1 day** per camera (or site-wide). Default suggestion scales with hardware:
| GPU VRAM | Suggested default |
|---|---|
| ≤ 8 GB | 1h summaries (LLM + YOLO share budget) |
| 12 GB | 10 min |
| 24 GB+ | 1 min |
Cadence is a scheduler over the same fact-sheet → prompt pipeline already built; shorter cadence = more LLM calls = more VRAM contention with inference.

### 2.6 Action Dispatcher
Core emits events (`anomaly.opened`, `match.found`, `presence.violation`, `summary.ready`); packs subscribe with handlers (webhook, ERP write, notification). Core performs no domain actions.

### 2.7 Retention & Data Clearing (default policy, user-tweakable)
**Default: frames are purged at day end.** Everything is config, per deployment:
| Data | Default | Config key |
|---|---|---|
| Frame images | **24 h (purge at day end)** | `retention.frames_hours` |
| Fact ledger rows | 90 days | `retention.ledger_days` |
| Narratives / anomalies | 1 year | `retention.analytics_days` |
| Evidence exports | user-managed | — |
**Exemption rule (important):** frames referenced by an *open* anomaly or an *active* Subject-Lock investigation are **exempt from purge** — evidence must outlive its case. Purge is a cron: delete files past TTL whose `frame_ref` is not referenced by open cases, then ledger rows follow.

### 2.8 Observability
Metrics: frames/min/cam, inference latency (p50/p95), GPU utilization/VRAM, worker liveness, purge job success. The original brief's "camera reliability at scale" requirement, made measurable.

---

## 3. Shared extensions

### 3.1 Identity & Watchlist
Enroll / dereg / match against a registry — **modality is pluggable**:
| | Face (school/hospital/home/defense) | Vehicle (traffic) |
|---|---|---|
| Enroll | face → embedding (InsightFace/ArcFace) | plate → text (ANPR) + make/model/color |
| Watchlists | whitelist (family/staff), blacklist (intruders) | stolen list, permit list |
| Match | embedding → Qdrant similarity search | plate text → registry lookup |
| Output | **MatchEvent** {subject_id, confidence, frame_ref, camera_id} | same shape |
**Compliance:** enrollment requires consent capture; dereg requires *hard deletion* of embeddings everywhere (vector store + registry + caches). DPDP/GDPR apply to real deployments — POC uses synthetic/consenting faces only.

### 3.2 Subject Lock — Investigation Mode 🎯
*"Lock tracking on someone/something and follow it everywhere."*
- **Lock** a subject by: identity match (face embedding / plate), **or manual selection** (click a box in any frame → that track ID becomes the target)
- **Retrospective sweep:** search the ledger + frame store + vector index across **all cameras** in a time window → full movement timeline (which camera, when, doing what)
- **Prospective mode:** from lock time forward, every camera's detections are matched against the target in real time → live "where is it now" + alerts on every sighting
- Output: a **case** — timeline, evidence frames (purge-exempt per §2.7), narrative
- Example (your spec): stolen car → ANPR/vehicle match locks it → timeline reconstructs every camera it passed, every frame it appears in, end to end
- Depends on: Identity (3.1) for match keys, tracking IDs (2.2) for continuity, ledger for history

### 3.3 Zones & Object Presence Monitor 🛒
*"Mark what matters; get a record when it moves."* Retail example: mark grocery shelves; when an item leaves its zone, record it → later reconcile against invoices: **sold (bill exists) vs missing (potential theft)**.
- Config: zones (polygons) + expected object classes per zone + schedule
- Events via track IDs: `entered / exited / appeared / disappeared` → `presence_events` + optional `anomaly`
- **Honest capability note:** generic COCO classes ("bottle", "person") are free; *specific items* ("this brand of shampoo") need a custom-trained model — same inference seam, pack-supplied weights. Instance-level inventory tracking is a pack maturity item, not a core promise.

### 3.4 System-of-Record connector & Notifications
Same adapter pattern for ERP (school), HIS (hospital), citation system (traffic), invoice system (retail). Notifications: webhook/email/Telegram/Push — the entire "home security" UX surface lives mostly here.

## 4. Domain packs

| Pack | Identity | Rules (policy) | Actions | Extra models |
|---|---|---|---|---|
| **School** | face (students, staff) | timetable + roster = who should be where | attendance write-back, parent notify | InsightFace |
| **Hospital** | face | restricted zones (ICU/narcotics), wander detection | HIS connector, alerts | InsightFace |
| **Home** | face (whitelist/blacklist) | night + unknown person → alert; whitelist → suppress | push/siren/clip | InsightFace (small registry) |
| **Traffic** | plate (ANPR) | signal-state + stop-line crossing, speed delta, banned vehicles | **challan** evidence pack → citation system | ANPR + color/type classifiers |
| **Retail** | face (optional staff) | zones & presence (§3.3), shelf-gap, queue length | invoice reconciliation, restock alerts | custom item models |
| **Defense/Drone** | face vs records DB | geo-fence, route deviation, loitering | classified alerts | aerial models; moving-camera ingest is a heavy research item — flagged, not promised |

## 5. Dashboard (operator console)

| Panel | Data source | Notes |
|---|---|---|
| Live camera grid | HLS via gateway signed URLs | all cameras, multi-view |
| **YOLO overlay toggle** 🔁 | WebSocket publishing per-frame detections | user flips a layer to see *what the machine sees* — bboxes/labels/confidence over live video; per-camera toggle |
| Anomaly feed | anomalies table | ack/resolve buttons, inline evidence frame + facts |
| Summaries | narrative engine | cadence selector: 1m / 10m / 1h / 1d (§2.5 defaults) |
| **Fact-sheet viewer + export** | ledger aggregates | view JSON in-browser; **export JSON/CSV** for external analysis |
| Camera health | registry heartbeats | online/offline/degraded grid |
| Subject Lock UI | §3.2 | pick frame → click subject → lock → live timeline |
| Zone editor | §3.3 | draw polygons on a camera still |
| Identity admin | §3.1 | enroll/dereg faces or plates (pack-scoped) |

**Authentication: deferred by design (v1).** Single-operator, trusted-LAN assumption; gateway token stub remains. Triggers to add it: remote access, multi-user, or any pack writing to a system of record (attendance/challan). Insertion points are already documented (gateway login, stream signing, dashboard session) so it's an additive change, not a rework.

## 6. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — freeze** ✅ (`v0.1.0-poc`) | e2e pipeline | MILESTONE.md demo passes |
| **1 — mock-friendly core** | file/webcam camera sources (N cameras, any video incl. duplicates); retention default (day-end purge + exemptions); summary cadence scheduler (1m/10m/1h/1d); fact-sheet export API; anomaly lifecycle | run 5 mock cameras + webcam; auto-purge works; export a CSV |
| **2 — identity + tracking** | tracking IDs in seam; Identity & Watchlist subsystem (enroll/dereg/match, Qdrant); Subject Lock retrospective + prospective | lock a face → movement timeline across 2 cameras |
| **3 — operator console** | dashboard panels above incl. YOLO overlay toggle, zone editor | ack an anomaly + lock a subject from the UI |
| **4 — first packs: Traffic + Retail** | ANPR model, vehicle registry, signal-state; zones/presence + invoice reconciliation | challan evidence pack; shelf-gap event → report |
| **5 — School + Hospital** | face enrollment at scale, timetable mapping (exists), ERP/HIS connectors | e2e attendance with audit trail |
| **6 — Home + Defense** | notification layer, night rules, mobile ingest spike | alert latency < 5 s from event |

## 7. Non-goals (v1)
- Full video storage/search (frames + metadata only — cost discipline)
- Hard real-time (<1 s) alert guarantees — 1 FPS + scan cadence; documented, not pretended
- Auth/multi-tenant until a trigger in §5 fires
- On-prem K8s/HA story — single-node compose until a pack demands it
