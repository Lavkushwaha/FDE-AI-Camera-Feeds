// Presence Timeline: gap detection + facts-only narrative generation via local
// Ollama (LLD section 2.3, HLD Flow C).
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";
const PORT = process.env.PORT || 4004;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "presence-timeline" }));

app.get("/presence/:studentId/gaps", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.*, ts.subject, ts.period_number, ts.start_time, ts.end_time
     FROM gaps g JOIN timetable_slots ts ON g.timetable_slot_id = ts.id
     WHERE g.student_id = $1`,
    [req.params.studentId]
  );
  res.json(rows);
});

// Builds the facts-only prompt and calls the local model. See LLD 2.3 for the
// exact prompt shape — deliberately excludes anything not in the structured facts.
app.post("/presence/gap/:gapId/narrative", async (req, res) => {
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
});

// Build the per-minute fact-sheet for one camera from detection_events,
// then ask the local LLM for a facts-only narrative.
app.get("/summary/:cameraId", async (req, res) => {
  const { cameraId } = req.params;
  const minute = req.query.minute
    ? String(req.query.minute)                                   // e.g. 2026-08-29 11:53
    : new Date(Date.now() - 60000).toISOString().slice(0, 16);   // default: previous minute (UTC)

  const { rows } = await pool.query(
    `SELECT bbox->>'class' AS label,
            count(*) AS detections,
            round(avg(confidence)::numeric, 3) AS avg_conf,
            min(confidence) AS min_conf,
            max(confidence) AS max_conf
     FROM detection_events
     WHERE camera_id = $1 AND date_trunc('minute', detected_at) = $2::timestamptz
     GROUP BY 1 ORDER BY 2 DESC`,
    [cameraId, minute]
  );

  const { rows: frameRows } = await pool.query(
    `SELECT count(DISTINCT frame_ref) AS frames_seen FROM detection_events
     WHERE camera_id = $1 AND date_trunc('minute', detected_at) = $2::timestamptz`,
    [cameraId, minute]
  );
  const framesSeen = Number(frameRows[0].frames_seen);

  if (rows.length === 0) {
    return res.status(404).json({ error: "no data for that camera/minute", minute });
  }

  const factSheet = {
    camera_id: cameraId,
    minute,
    frames_seen: framesSeen,
    frames_expected: 60,   // 1 FPS sampling
    detections_per_class: rows,
  };

  const prompt = `You are given ONLY the following structured facts from a CCTV analytics
system. Do not add, infer, or assume anything not explicitly present.
Write 2-3 sentences describing what happened. ${JSON.stringify(factSheet, null, 2)}`;

  const ollamaResp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3.1:8b", prompt, stream: false }),
  });
  const ollamaData = await ollamaResp.json();
  const narrative = ollamaData.response ?? "(no response from model)";

  res.json({ fact_sheet: factSheet, narrative });
});

app.listen(PORT, () => console.log(`presence-timeline listening on ${PORT}`));
