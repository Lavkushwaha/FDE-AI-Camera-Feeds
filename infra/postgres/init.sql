-- School Vision POC schema (see LLD doc section 1)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id),
  name TEXT NOT NULL,
  section TEXT
);

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id),
  class_id UUID REFERENCES classes(id),
  name TEXT NOT NULL,
  roll_no TEXT
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id UUID REFERENCES schools(id),
  name TEXT NOT NULL,
  building TEXT
);

CREATE TABLE timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID REFERENCES classes(id),
  room_id UUID REFERENCES rooms(id),
  day_of_week SMALLINT NOT NULL,
  period_number SMALLINT NOT NULL,
  subject TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL
);

CREATE TABLE cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms(id),
  name TEXT NOT NULL,
  rtsp_url TEXT NOT NULL,
  stream_key TEXT,
  source_type TEXT DEFAULT 'rtsp',
  source_uri TEXT,
  fps INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  status TEXT DEFAULT 'unknown',
  last_heartbeat TIMESTAMPTZ
);

CREATE TABLE face_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id),
  qdrant_point_id UUID NOT NULL,
  enrolled_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE detection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES cameras(id),
  student_id UUID REFERENCES students(id),
  confidence NUMERIC(4,3) NOT NULL,
  bbox JSONB,
  frame_ref TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE presence_intervals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id),
  room_id UUID REFERENCES rooms(id),
  camera_id UUID REFERENCES cameras(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'open'
);

CREATE TABLE gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id),
  timetable_slot_id UUID REFERENCES timetable_slots(id),
  gap_start TIMESTAMPTZ NOT NULL,
  gap_end TIMESTAMPTZ,
  status TEXT DEFAULT 'open',
  narrative_summary TEXT,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE gap_sightings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gap_id UUID REFERENCES gaps(id),
  camera_id UUID REFERENCES cameras(id),
  room_id UUID REFERENCES rooms(id),
  seen_at TIMESTAMPTZ NOT NULL,
  confidence NUMERIC(4,3),
  frame_ref TEXT
);

CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id),
  timetable_slot_id UUID REFERENCES timetable_slots(id),
  date DATE NOT NULL,
  status TEXT NOT NULL,
  marked_by TEXT NOT NULL,
  confidence NUMERIC(4,3),
  source_frame_ref TEXT,
  overridden_by_manual BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (student_id, timetable_slot_id, date)
);

CREATE TABLE anomalies (
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

CREATE INDEX detection_events_camera_time_idx ON detection_events (camera_id, detected_at DESC);
CREATE INDEX anomalies_camera_status_idx ON anomalies (camera_id, status);

-- Seed data: one mock school so docker-compose up gives you something to query immediately
INSERT INTO schools (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Demo Public School');

INSERT INTO classes (id, school_id, name, section)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Grade 8', 'B');

INSERT INTO rooms (id, school_id, name, building) VALUES
  ('33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111', 'Room 4B', 'Main Block'),
  ('33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111', 'Playground', 'Ground');

INSERT INTO cameras (id, room_id, name, rtsp_url, stream_key, source_type) VALUES
  ('44444444-4444-4444-4444-444444444441', '33333333-3333-3333-3333-333333333331', 'Room 4B Cam', 'rtsp://mediamtx:8554/cam1', 'cam1', 'file'),
  ('44444444-4444-4444-4444-444444444442', '33333333-3333-3333-3333-333333333332', 'Ground Cam 1', 'rtsp://mediamtx:8554/cam2', 'cam2', 'file');

INSERT INTO students (id, school_id, class_id, name, roll_no) VALUES
  ('55555555-5555-5555-5555-555555555551', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'Demo Student', '08');

INSERT INTO timetable_slots (class_id, room_id, day_of_week, period_number, subject, start_time, end_time) VALUES
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333331', 1, 2, 'Maths', '12:15', '13:00');
