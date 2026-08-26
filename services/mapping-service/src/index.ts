// Mapping Service: resolves camera/room -> active timetable slot + expected roster.
// This is the "context layer" referenced throughout the HLD (section 4b).
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 4001;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "mapping-service" }));

// Resolve the timetable slot active for a room at a given timestamp.
app.get("/rooms/:roomId/current-slot", async (req, res) => {
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
});

app.listen(PORT, () => console.log(`mapping-service listening on ${PORT}`));
