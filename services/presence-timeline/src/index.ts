// Presence Timeline: gap detection + facts-only narrative generation via local
// Ollama (LLD section 2.3, HLD Flow C).
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const PORT = process.env.PORT || 4004;

// One bad request or a slow/down Ollama must never take down the whole service —
// every async route is wrapped so a thrown/rejected error becomes a 500 response
// instead of an uncaught rejection that kills the Node process.
function ah(fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "presence-timeline" }));

app.get("/presence/:studentId/gaps", ah(async (req, res) => {
  if (!isUuid(req.params.studentId)) return res.status(400).json({ error: "invalid student id" });
  const { rows } = await pool.query(
    `SELECT g.*, ts.subject, ts.period_number, ts.start_time, ts.end_time
     FROM gaps g JOIN timetable_slots ts ON g.timetable_slot_id = ts.id
     WHERE g.student_id = $1`,
    [req.params.studentId]
  );
  res.json(rows);
}));

// Builds the facts-only prompt and calls the local model. See LLD 2.3 for the
// exact prompt shape — deliberately excludes anything not in the structured facts.
app.post("/presence/gap/:gapId/narrative", ah(async (req, res) => {
  if (!isUuid(req.params.gapId)) return res.status(400).json({ error: "invalid gap id" });
  const gapRes = await pool.query(`SELECT * FROM gaps WHERE id = $1`, [req.params.gapId]);
  if (gapRes.rows.length === 0) return res.status(404).json({ error: "gap not found" });
  const gap = gapRes.rows[0];

  const sightingsRes = await pool.query(`SELECT * FROM gap_sightings WHERE gap_id = $1`, [gap.id]);
  const sightings = sightingsRes.rows;

  const prompt = `You are given ONLY the following structured facts. Do not add, infer, or assume
anything not explicitly present. Write one short factual summary.

Expected: absent from expected location starting ${gap.gap_start}
Alternate sightings: ${JSON.stringify(sightings)}
Returned to expected location at: ${gap.gap_end ?? "not yet returned"}`;

  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3.1:8b", prompt, stream: false }),
  });
  const data = await resp.json();
  const narrative = data.response ?? "(no response from model)";

  await pool.query(`UPDATE gaps SET narrative_summary = $1 WHERE id = $2`, [narrative, gap.id]);
  res.json({ narrative, facts_used: { gap, sightings } });
}));

// FRAMEWORK.md §2.5 summary cadence — the actual selectable windows (GPU-aware
// defaults are the operator's choice, not enforced here).
const SUMMARY_WINDOWS: Record<string, number> = {
  "1m": 60,
  "10m": 600,
  "30m": 1800,
  "1h": 3600,
};

// Build the fact-sheet for one camera over a selectable window from detection_events,
// then ask the local LLM for a facts-only narrative — picks from data we already have,
// not a single fixed minute bucket.
app.get("/summary/:cameraId", ah(async (req, res) => {
  const { cameraId } = req.params;
  if (!isUuid(cameraId)) return res.status(400).json({ error: "invalid camera id" });

  const windowKey = req.query.window ? String(req.query.window) : "1m";
  const windowSec = SUMMARY_WINDOWS[windowKey];
  if (!windowSec) {
    return res.status(400).json({ error: `window must be one of ${Object.keys(SUMMARY_WINDOWS).join(", ")}` });
  }
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = new Date(to.getTime() - windowSec * 1000);

  const { rows } = await pool.query(
    `SELECT bbox->>'class' AS label,
            count(*) AS detections,
            round(avg(confidence)::numeric, 3) AS avg_conf,
            min(confidence) AS min_conf,
            max(confidence) AS max_conf
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     GROUP BY 1 ORDER BY 2 DESC`,
    [cameraId, from, to]
  );

  const { rows: frameRows } = await pool.query(
    `SELECT count(DISTINCT frame_ref) AS frames_seen FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3`,
    [cameraId, from, to]
  );
  const framesSeen = Number(frameRows[0].frames_seen);

  if (rows.length === 0) {
    return res.status(404).json({
      error: "no data for that camera/window",
      window: windowKey,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  const factSheet = {
    camera_id: cameraId,
    window: { label: windowKey, from: from.toISOString(), to: to.toISOString() },
    frames_seen: framesSeen,
    frames_expected: windowSec, // 1 FPS sampling assumption, matches the rest of core
    detections_per_class: rows,
  };

  const prompt = `You are given ONLY the following structured facts from a CCTV analytics
system, covering a ${windowKey} window. Do not add, infer, or assume anything not explicitly
present. Write 2-4 sentences describing what happened, noting any notable trend across the
window (e.g. a rise, fall, or steady pattern) if the facts support it. ${JSON.stringify(factSheet, null, 2)}`;

  const ollamaResp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3.1:8b", prompt, stream: false }),
  });
  const ollamaData = await ollamaResp.json();
  const narrative = ollamaData.response ?? "(no response from model)";

  res.json({ fact_sheet: factSheet, narrative });
}));

const Z_THRESHOLD = Number(process.env.ANOMALY_Z || 2.5);
const GAP_TOLERANCE = Number(process.env.CAPTURE_GAP_MIN_FRAMES || 45);
const BASELINE_MINUTES = 10;

const ENSURE_SQL = `
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
`;

async function openAnomaly(
  cameraId: string,
  type: string,
  payload: Record<string, unknown>,
  evidenceFrameRef: string | null
) {
  const { rows: existing } = await pool.query(
    `SELECT id FROM anomalies
     WHERE camera_id = $1 AND type = $2 AND status = 'open'
       AND payload->>'window_from' = $3`,
    [cameraId, type, payload.window_from]
  );
  if (existing.length > 0) return null;
  const { rows } = await pool.query(
    `INSERT INTO anomalies (camera_id, type, payload, evidence_frame_ref)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [cameraId, type, payload, evidenceFrameRef]
  );
  return rows[0];
}

async function scanCamera(cameraId: string, minuteStart: Date) {
  const minuteEnd = new Date(minuteStart.getTime() + 60_000);
  const window_from = minuteStart.toISOString();
  const opened: unknown[] = [];

  const { rows: frameRows } = await pool.query(
    `SELECT count(DISTINCT frame_ref)::int AS frames_seen
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3`,
    [cameraId, minuteStart, minuteEnd]
  );
  const framesSeen = frameRows[0]?.frames_seen ?? 0;

  const { rows: evidence } = await pool.query(
    `SELECT frame_ref FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     ORDER BY detected_at DESC LIMIT 1`,
    [cameraId, minuteStart, minuteEnd]
  );
  const evidenceRef = evidence[0]?.frame_ref ?? null;

  if (framesSeen < GAP_TOLERANCE) {
    const row = await openAnomaly(
      cameraId,
      "capture_gap",
      { window_from, frames_seen: framesSeen, frames_expected: 60, tolerance: GAP_TOLERANCE },
      evidenceRef
    );
    if (row) opened.push(row);
  }

  const { rows: current } = await pool.query(
    `SELECT bbox->>'class' AS label, count(*)::int AS n
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     GROUP BY 1`,
    [cameraId, minuteStart, minuteEnd]
  );

  const baselineFrom = new Date(minuteStart.getTime() - BASELINE_MINUTES * 60_000);
  const { rows: hist } = await pool.query(
    `SELECT bbox->>'class' AS label, count(*)::float AS n
     FROM detection_events
     WHERE camera_id = $1 AND detected_at >= $2 AND detected_at < $3
     GROUP BY bbox->>'class', date_trunc('minute', detected_at)`,
    [cameraId, baselineFrom, minuteStart]
  );
  const byLabel = new Map<string, number[]>();
  for (const r of hist) {
    const arr = byLabel.get(r.label) ?? [];
    arr.push(Number(r.n));
    byLabel.set(r.label, arr);
  }

  const { rows: ever } = await pool.query(
    `SELECT DISTINCT bbox->>'class' AS label FROM detection_events
     WHERE camera_id = $1 AND detected_at < $2`,
    [cameraId, minuteStart]
  );
  const known = new Set(ever.map((r) => r.label));

  function meanStd(vals: number[]) {
    if (vals.length === 0) return { mean: 0, std: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { mean, std: Math.sqrt(variance) };
  }

  for (const row of current) {
    if (!known.has(row.label)) {
      const created = await openAnomaly(
        cameraId,
        "new_class",
        { window_from, label: row.label, detections: row.n },
        evidenceRef
      );
      if (created) opened.push(created);
    }
    const stats = meanStd(byLabel.get(row.label) ?? []);
    if ((byLabel.get(row.label) ?? []).length < 3 || stats.std === 0) continue;
    const z = (Number(row.n) - stats.mean) / stats.std;
    if (z >= Z_THRESHOLD) {
      const created = await openAnomaly(
        cameraId,
        "spike",
        { window_from, label: row.label, detections: row.n, z: Number(z.toFixed(2)), mean: stats.mean },
        evidenceRef
      );
      if (created) opened.push(created);
    } else if (z <= -Z_THRESHOLD) {
      const created = await openAnomaly(
        cameraId,
        "drought",
        { window_from, label: row.label, detections: row.n, z: Number(z.toFixed(2)), mean: stats.mean },
        evidenceRef
      );
      if (created) opened.push(created);
    }
  }

  return { camera_id: cameraId, minute: window_from, frames_seen: framesSeen, opened };
}

app.post("/anomalies/scan", ah(async (req, res) => {
  if (req.body?.camera_id && !isUuid(String(req.body.camera_id))) {
    return res.status(400).json({ error: "invalid camera_id" });
  }
  const minute = req.body?.minute
    ? new Date(String(req.body.minute))
    : new Date(Date.now() - 60_000);
  minute.setUTCSeconds(0, 0);

  let cameraIds: string[] = [];
  if (req.body?.camera_id) {
    cameraIds = [req.body.camera_id];
  } else {
    const { rows } = await pool.query(`SELECT id FROM cameras`);
    cameraIds = rows.map((r) => r.id);
  }

  const results = [];
  for (const id of cameraIds) {
    results.push(await scanCamera(id, minute));
  }
  res.json({ minute: minute.toISOString(), results });
}));

// Last-resort net: anything that still throws synchronously, or reaches here via
// ah()'s next(err), gets a 500 instead of taking the whole process down.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("presence-timeline request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error", detail: String((err as Error)?.message ?? err) });
});

process.on("unhandledRejection", (err) => console.error("presence-timeline unhandled rejection:", err));
pool.on("error", (err) => console.error("presence-timeline pg pool error:", err));

// ALTER TABLE (even a no-op ADD COLUMN IF NOT EXISTS) briefly needs a catalog lock that
// can deadlock against frame-sampler's continuous INSERT INTO detection_events (which
// FK-references cameras) — a real outage we hit: a service crash-looped every restart
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
  app.listen(PORT, () => console.log(`presence-timeline listening on ${PORT}`));
}

main().catch((err) => {
  console.error("presence-timeline failed to start", err);
  process.exit(1);
});

