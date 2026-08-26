// Shared TS interfaces mirroring the API contracts in the LLD doc (section 2).
// Import these in every Node service so the contracts can't silently drift apart.

export interface InferFrameRequest {
  camera_id: string;
  room_id: string;
  timestamp: string; // ISO
  frame_url: string;
}

export interface FaceMatch {
  student_id: string | null;
  confidence: number;
  bbox: [number, number, number, number];
  qdrant_point_id?: string;
}

export interface ObjectDetection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface InferFrameResponse {
  faces: FaceMatch[];
  objects: ObjectDetection[];
  processed_at: string;
}

export interface DetectionEvent {
  camera_id: string;
  room_id: string;
  student_id: string | null;
  confidence: number;
  bbox: [number, number, number, number];
  frame_ref: string;
  detected_at: string;
}

export interface MarkAttendanceRequest {
  student_id: string;
  timetable_slot_id: string;
  date: string; // YYYY-MM-DD
  confidence: number;
  source_frame_ref: string;
}

export interface GapSighting {
  camera: string;
  room: string;
  seen_at: string;
  confidence: number;
}

export interface Gap {
  gap_id: string;
  timetable_slot: { subject: string; period: number; start: string; end: string };
  gap_start: string;
  gap_end: string | null;
  sightings: GapSighting[];
  narrative_summary: string | null;
}
