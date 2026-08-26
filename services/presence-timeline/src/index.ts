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

app.listen(PORT, () => console.log(`presence-timeline listening on ${PORT}`));
