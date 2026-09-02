// Mapping Service: resolves camera/room -> active timetable slot + expected roster.
// This is the "context layer" referenced throughout the HLD (section 4b).
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 4001;

// One bad request must never take down the whole service — see gateway/index.ts
// for why (an unguarded UUID-typed query crashed it in practice).
function ah(fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "mapping-service" }));

// Resolve the timetable slot active for a room at a given timestamp.
app.get("/rooms/:roomId/current-slot", ah(async (req, res) => {
  const { roomId } = req.params;
  const ts = req.query.timestamp ? new Date(String(req.query.timestamp)) : new Date();
  const dayOfWeek = ts.getUTCDay();
  const time = ts.toISOString().substring(11, 16); // HH:MM

  const { rows } = await pool.query(
    `SELECT * FROM timetable_slots
     WHERE room_id = $1 AND day_of_week = $2
       AND start_time <= $3 AND end_time >= $3`,
    [roomId, dayOfWeek, time]
  );

  if (rows.length === 0) return res.status(404).json({ error: "no active slot" });
  res.json(rows[0]);
}));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("mapping-service request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error", detail: String((err as Error)?.message ?? err) });
});
process.on("unhandledRejection", (err) => console.error("mapping-service unhandled rejection:", err));
pool.on("error", (err) => console.error("mapping-service pg pool error:", err));

app.listen(PORT, () => console.log(`mapping-service listening on ${PORT}`));
