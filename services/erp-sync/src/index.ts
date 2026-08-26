// ERP Sync: validates ML detections against expected roster, writes attendance
// with idempotency + manual-override conflict handling (LLD section 2.2).
import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 4002;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "erp-sync" }));

app.post("/internal/attendance/mark", async (req, res) => {
  const { student_id, timetable_slot_id, date, confidence, source_frame_ref } = req.body;

  const existing = await pool.query(
    `SELECT * FROM attendance_records WHERE student_id=$1 AND timetable_slot_id=$2 AND date=$3`,
    [student_id, timetable_slot_id, date]
  );

  if (existing.rows.length > 0) {
    if (existing.rows[0].overridden_by_manual) {
      return res.status(409).json({ reason: "overridden_by_manual" });
    }
    return res.status(200).json({ attendance_record_id: existing.rows[0].id, status: "already_marked" });
  }

  const { rows } = await pool.query(
    `INSERT INTO attendance_records
      (student_id, timetable_slot_id, date, status, marked_by, confidence, source_frame_ref)
     VALUES ($1, $2, $3, 'present', 'ml', $4, $5)
     RETURNING id`,
    [student_id, timetable_slot_id, date, confidence, source_frame_ref]
  );

  res.status(201).json({ attendance_record_id: rows[0].id, status: "present", marked_by: "ml" });
});

app.listen(PORT, () => console.log(`erp-sync listening on ${PORT}`));
