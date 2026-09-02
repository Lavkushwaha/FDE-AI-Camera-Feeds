// Gateway: operator BFF — registry, ledger, anomalies, HLS proxy, stub auth.
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// One bad request must never take down the whole gateway — every async route
// below is wrapped with this so a thrown/rejected error becomes a 500 response
// instead of an uncaught rejection that kills the Node process.
function ah(fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const PORT = process.env.PORT || 4000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PRESENCE_URL = process.env.PRESENCE_URL || "http://presence-timeline:4004";
const MEDIAMTX_HLS = process.env.MEDIAMTX_HLS || "http://mediamtx:8888";
const MEDIAMTX_RTSP = process.env.MEDIAMTX_RTSP || "rtsp://mediamtx:8554";
const FRAMES_DIR = process.env.FRAMES_DIR || "/frames";
const PUBLIC_BASE = process.env.PUBLIC_BASE || "http://localhost:4000";

const ENSURE_SQL = `
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS stream_key TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'rtsp';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS source_uri TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS fps INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
UPDATE cameras SET stream_key = 'cam1'
  WHERE id = '44444444-4444-4444-4444-444444444441' AND (stream_key IS NULL OR stream_key = '');
UPDATE cameras SET stream_key = 'cam2'
  WHERE id = '44444444-4444-4444-4444-444444444442' AND (stream_key IS NULL OR stream_key = '');
CREATE TABLE IF NOT EXISTS anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES cameras(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_frame_ref TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS detection_events_camera_time_idx ON detection_events (camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS anomalies_camera_status_idx ON anomalies (camera_id, status);
`;

function healthFromHeartbeat(last: Date | null): "unknown" | "online" | "degraded" | "offline" {
  if (!last) return "unknown";
  const ageMs = Date.now() - last.getTime();
  if (ageMs <= 15_000) return "online";
  if (ageMs <= 60_000) return "degraded";
  return "offline";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function windowFromQuery(q: express.Request["query"]) {
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 60_000);
  return { from, to };
}

async function factSheet(cameraId: string, from: Date, to: Date) {
  const { rows } = await pool.query(
    `SELECT bbox->>'class' AS label,
            count(*)::int AS detections,
            round(avg(confidence)::numeric, 3) AS avg_conf,
            min(confidence) AS min_conf,
            max(confidence) AS max_conf
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     GROUP BY 1 ORDER BY 2 DESC`,
    [cameraId, from, to]
  );
  const { rows: frameRows } = await pool.query(
    `SELECT count(DISTINCT frame_ref)::int AS frames_seen
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3`,
    [cameraId, from, to]
  );
  const spanSec = Math.max(1, Math.round((to.getTime() - from.getTime()) / 1000));
  const framesSeen = frameRows[0]?.frames_seen ?? 0;
  // "detections" is a sum across every sampled frame in the window, not a count of
  // distinct objects (the ledger is append-only, one row per detection per frame —
  // see FRAMEWORK.md §2.3). avg_per_frame is what answers "how many were in view".
  const withAverages = rows.map((r) => ({
    ...r,
    avg_per_frame: framesSeen > 0 ? Number((r.detections / framesSeen).toFixed(1)) : 0,
  }));
  return {
    camera_id: cameraId,
    window: { from: from.toISOString(), to: to.toISOString() },
    frames_seen: framesSeen,
    frames_expected: spanSec,
    detections_per_class: withAverages,
  };
}

// Exact detections per individual frame — the ledger's raw grain, not summed/averaged
// across the window. Each row is one sampled frame with its own per-class counts.
async function perFrameSheet(cameraId: string, from: Date, to: Date) {
  // Group by (frame_ref, label) only — NOT detected_at. Rows for the same frame can
  // carry slightly different timestamps (e.g. a producer that stamps each row
  // separately instead of once per frame), and grouping on the exact timestamp would
  // silently split one frame's detections into several undercounted rows.
  const { rows } = await pool.query(
    `SELECT frame_ref, min(detected_at) AS detected_at, bbox->>'class' AS label,
            count(*)::int AS detections,
            round(avg(confidence)::numeric, 3) AS avg_conf
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     GROUP BY frame_ref, label
     ORDER BY min(detected_at) ASC, label ASC`,
    [cameraId, from, to]
  );
  const byFrame = new Map<string, { frame_ref: string; detected_at: string; counts: Record<string, number> }>();
  for (const r of rows) {
    const key = r.frame_ref;
    if (!byFrame.has(key)) {
      byFrame.set(key, { frame_ref: r.frame_ref, detected_at: r.detected_at, counts: {} });
    }
    const entry = byFrame.get(key)!;
    // sum defensively: even with the GROUP BY above, this guarantees a duplicate
    // (frame_ref, label) row from any source can never silently overwrite a count.
    entry.counts[r.label] = (entry.counts[r.label] ?? 0) + r.detections;
  }
  return {
    camera_id: cameraId,
    window: { from: from.toISOString(), to: to.toISOString() },
    frames: [...byFrame.values()],
  };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

app.post("/auth/login", (_req, res) => {
  res.json({ token: "dev-token-replace-me" });
});

app.get("/registry/cameras", ah(async (req, res) => {
  const includeInactive = String(req.query.all || "") === "true";
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.rtsp_url, c.stream_key, c.source_type, c.source_uri, c.fps,
            c.active, c.status, c.last_heartbeat, c.room_id, r.name AS room_name
     FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id
     WHERE $1::boolean OR c.active
     ORDER BY c.name`,
    [includeInactive]
  );
  res.json(
    rows.map((c) => {
      const last = c.last_heartbeat ? new Date(c.last_heartbeat) : null;
      return {
        ...c,
        health: healthFromHeartbeat(last),
        hls_url: c.stream_key ? `${PUBLIC_BASE}/hls/${c.stream_key}/index.m3u8` : null,
      };
    })
  );
}));

const SOURCE_TYPES = new Set(["rtsp", "file", "webcam"]);

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "cam"
  );
}

app.post("/registry/cameras", ah(async (req, res) => {
  const { name, room_id, source, fps } = req.body ?? {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
  const sourceType = source?.type;
  if (!SOURCE_TYPES.has(sourceType)) {
    return res.status(400).json({ error: `source.type must be one of ${[...SOURCE_TYPES].join(", ")}` });
  }
  const sourceUri = source?.uri ? String(source.uri) : null;
  if (sourceType !== "webcam" && !sourceUri) {
    return res.status(400).json({ error: "source.uri required for rtsp/file cameras" });
  }
  const streamKey = `${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
  const rtspUrl = `${MEDIAMTX_RTSP}/${streamKey}`;
  const { rows } = await pool.query(
    `INSERT INTO cameras (room_id, name, rtsp_url, stream_key, source_type, source_uri, fps, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
    [room_id ?? null, name, rtspUrl, streamKey, sourceType, sourceUri, Number(fps) > 0 ? Number(fps) : 1]
  );
  const row = rows[0];
  res.status(201).json({
    ...row,
    health: healthFromHeartbeat(null),
    hls_url: `${PUBLIC_BASE}/hls/${row.stream_key}/index.m3u8`,
  });
}));

app.delete("/registry/cameras/:id", ah(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid camera id" });
  const { rows } = await pool.query(
    `UPDATE cameras SET active = false WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "camera not found" });
  res.json({ ...rows[0], decommissioned: true });
}));

app.get("/registry/cameras/:id/health", ah(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid camera id" });
  const { rows } = await pool.query(`SELECT id, name, status, last_heartbeat FROM cameras WHERE id = $1`, [
    req.params.id,
  ]);
  if (rows.length === 0) return res.status(404).json({ error: "camera not found" });
  const last = rows[0].last_heartbeat ? new Date(rows[0].last_heartbeat) : null;
  res.json({ ...rows[0], health: healthFromHeartbeat(last) });
}));

app.get("/stream/:cameraId/token", ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, stream_key FROM cameras WHERE id::text = $1 OR stream_key = $1`, [
    req.params.cameraId,
  ]);
  if (rows.length === 0) return res.status(404).json({ error: "camera not found" });
  const streamKey = rows[0].stream_key;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  res.json({
    signed_url: `${PUBLIC_BASE}/hls/${streamKey}/index.m3u8`,
    expires_at: expiresAt,
    camera_id: rows[0].id,
    stream_key: streamKey,
  });
}));

app.get(/^\/hls\/([^/]+)\/(.*)$/, async (req, res) => {
  const match = req.path.match(/^\/hls\/([^/]+)\/(.*)$/);
  if (!match) return res.status(400).end();
  const [, streamKey, rest] = match;
  // req.path drops the query string (Express splits it into req.query) — MediaMTX's
  // HLS muxer requires the ?session=... param on every sub-playlist/segment request
  // after the first, so it must be forwarded or every request past the top-level
  // manifest gets rejected as unauthenticated.
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const target = `${MEDIAMTX_HLS}/${streamKey}/${rest}${qs}`;
  try {
    const upstream = await fetch(target);
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (contentType.includes("mpegurl") || rest.endsWith(".m3u8")) {
      const rewritten = buf
        .toString("utf8")
        .replace(/https?:\/\/[^/\s]+/g, `${PUBLIC_BASE}/hls/${streamKey}`);
      return res.send(rewritten);
    }
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: "hls_upstream_failed", detail: String(err) });
  }
});

app.get("/ledger/fact-sheet", ah(async (req, res) => {
  const cameraId = String(req.query.camera_id || "");
  if (!isUuid(cameraId)) return res.status(400).json({ error: "camera_id required" });
  const { from, to } = windowFromQuery(req.query);
  res.json(await factSheet(cameraId, from, to));
}));

app.get("/export/facts", ah(async (req, res) => {
  const cameraId = String(req.query.camera_id || "");
  if (!isUuid(cameraId)) return res.status(400).json({ error: "camera_id required" });
  const format = String(req.query.format || "json");
  const { from, to } = windowFromQuery(req.query);
  const sheet = await factSheet(cameraId, from, to);
  if (format === "csv") {
    const header = "label,detections,avg_per_frame,avg_conf,min_conf,max_conf";
    const lines = (sheet.detections_per_class as Array<Record<string, unknown>>).map(
      (r) => `${r.label},${r.detections},${r.avg_per_frame},${r.avg_conf},${r.min_conf},${r.max_conf}`
    );
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="facts-${cameraId}.csv"`);
    return res.send([header, ...lines].join("\n"));
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="facts-${cameraId}.json"`);
  res.json(sheet);
}));

app.get("/ledger/frames", ah(async (req, res) => {
  const cameraId = String(req.query.camera_id || "");
  if (!isUuid(cameraId)) return res.status(400).json({ error: "camera_id required" });
  const { from, to } = windowFromQuery(req.query);
  res.json(await perFrameSheet(cameraId, from, to));
}));

app.get("/export/frames", ah(async (req, res) => {
  const cameraId = String(req.query.camera_id || "");
  if (!isUuid(cameraId)) return res.status(400).json({ error: "camera_id required" });
  const format = String(req.query.format || "json");
  const { from, to } = windowFromQuery(req.query);
  const sheet = await perFrameSheet(cameraId, from, to);
  if (format === "csv") {
    // long format (one row per frame+label) so the column set never depends on
    // which classes happened to appear in this particular window
    const header = "frame_ref,detected_at,label,count";
    const lines: string[] = [];
    for (const f of sheet.frames) {
      const detectedAt = new Date(f.detected_at).toISOString();
      for (const [label, count] of Object.entries(f.counts)) {
        lines.push(`${f.frame_ref},${detectedAt},${label},${count}`);
      }
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="frames-${cameraId}.csv"`);
    return res.send([header, ...lines].join("\n"));
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="frames-${cameraId}.json"`);
  res.json(sheet);
}));

app.get("/cameras/:id/detections/latest", ah(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid camera id" });
  const { rows: frame } = await pool.query(
    `SELECT frame_ref, max(detected_at) AS detected_at
     FROM detection_events WHERE camera_id = $1
     GROUP BY frame_ref ORDER BY max(detected_at) DESC LIMIT 1`,
    [req.params.id]
  );
  if (frame.length === 0) return res.json({ frame_ref: null, detections: [] });
  const { rows } = await pool.query(
    `SELECT bbox->>'class' AS label, confidence, bbox, frame_ref, detected_at
     FROM detection_events WHERE camera_id = $1 AND frame_ref = $2`,
    [req.params.id, frame[0].frame_ref]
  );
  res.json({
    frame_ref: frame[0].frame_ref,
    detected_at: frame[0].detected_at,
    frame_url: `${PUBLIC_BASE}/frames/${encodeURIComponent(frame[0].frame_ref)}`,
    detections: rows,
  });
}));

app.get("/frames/:name", (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(FRAMES_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "frame not found" });
  res.sendFile(file);
});

app.get("/anomalies", ah(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const rawCameraId = req.query.camera_id ? String(req.query.camera_id) : null;
  if (rawCameraId && !isUuid(rawCameraId)) return res.status(400).json({ error: "invalid camera_id" });
  const { rows } = await pool.query(
    `SELECT a.*, c.name AS camera_name
     FROM anomalies a JOIN cameras c ON c.id = a.camera_id
     WHERE ($1::text IS NULL OR a.status = $1)
       AND ($2::uuid IS NULL OR a.camera_id = $2)
     ORDER BY a.opened_at DESC
     LIMIT 100`,
    [status, rawCameraId]
  );
  res.json(rows);
}));

app.post("/anomalies/scan", async (req, res) => {
  try {
    const upstream = await fetch(`${PRESENCE_URL}/anomalies/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "scan_upstream_failed", detail: String(err) });
  }
});

app.post("/anomalies/:id/acknowledge", ah(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid anomaly id" });
  const actor = req.body?.actor || "operator";
  const { rows } = await pool.query(
    `UPDATE anomalies SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
     WHERE id = $1 AND status = 'open' RETURNING *`,
    [req.params.id, actor]
  );
  if (rows.length === 0) return res.status(409).json({ error: "not open or not found" });
  res.json(rows[0]);
}));

app.post("/anomalies/:id/resolve", ah(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: "invalid anomaly id" });
  const actor = req.body?.actor || "operator";
  const { rows } = await pool.query(
    `UPDATE anomalies SET status = 'resolved', resolved_at = now(), resolved_by = $2
     WHERE id = $1 AND status IN ('open', 'acknowledged') RETURNING *`,
    [req.params.id, actor]
  );
  if (rows.length === 0) return res.status(409).json({ error: "not found or already resolved" });
  res.json(rows[0]);
}));

app.get("/summaries/:cameraId", async (req, res) => {
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  try {
    const upstream = await fetch(`${PRESENCE_URL}/summary/${req.params.cameraId}${qs ? `?${qs}` : ""}`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "summary_upstream_failed", detail: String(err) });
  }
});

// Last-resort net: anything that still throws synchronously, or reaches here via
// ah()'s next(err), gets a 500 instead of taking the whole process down.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("gateway request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error", detail: String((err as Error)?.message ?? err) });
});

// Defense in depth: ah() catches everything inside route handlers, but a stray
// rejection anywhere else (e.g. the pg pool's own 'error' event) must not be
// allowed to crash the process either.
process.on("unhandledRejection", (err) => console.error("gateway unhandled rejection:", err));
pool.on("error", (err) => console.error("gateway pg pool error:", err));

// ALTER TABLE (even a no-op ADD COLUMN IF NOT EXISTS) briefly needs a catalog lock that
// can deadlock against frame-sampler's continuous INSERT INTO detection_events (which
// FK-references cameras) — a real outage we hit: gateway crash-looped every restart
// because it kept racing that concurrent writer. Retry with backoff instead of taking
// the whole service down over a startup-timing collision.
async function ensureSchema() {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await pool.query(ENSURE_SQL);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const retryable = code === "40P01" || code === "55P03"; // deadlock_detected / lock_not_available
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      const delayMs = 500 * attempt;
      console.error(`schema migration attempt ${attempt} hit ${code}, retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await ensureSchema();
  app.listen(PORT, () => console.log(`gateway listening on ${PORT}`));
}

main().catch((err) => {
  console.error("gateway failed to start", err);
  process.exit(1);
});
