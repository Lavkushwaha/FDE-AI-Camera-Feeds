import express from "express";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 4003;
const INFERENCE_URL = process.env.INFERENCE_URL || "http://inference-service:5000";
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 1000);
const FRAMES_DIR = process.env.FRAMES_DIR || "/frames";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// POC: hardcoded camera registry (uuids from the DB seed).
// Production: fetch from mapping-service / cameras table.
const CAMERAS = [
  { camera_id: "44444444-4444-4444-4444-444444444441", room_id: "33333333-3333-3333-3333-333333333331", prefix: "cam1" },
  { camera_id: "44444444-4444-4444-4444-444444444442", room_id: "33333333-3333-3333-3333-333333333332", prefix: "cam2" },
];

// strftime names zero-pad => lexicographic sort == chronological. Fragile but free.
function newestFrame(prefix: string): string | null {
  const files = fs.readdirSync(FRAMES_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith(".jpg"))
    .sort();
  return files.length ? path.join(FRAMES_DIR, files[files.length - 1]) : null;
}

const lastProcessed = new Map<string, string>();

async function sampleCamera(cam: (typeof CAMERAS)[number]) {
  const framePath = newestFrame(cam.prefix);
  if (!framePath || framePath === lastProcessed.get(cam.prefix)) return; // nothing new
  lastProcessed.set(cam.prefix, framePath);
  try {
    const resp = await fetch(`${INFERENCE_URL}/infer/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        camera_id: cam.camera_id,
        room_id: cam.room_id,
        timestamp: new Date().toISOString(),
        frame_url: framePath,
      }),
    });
    if (!resp.ok) {
      console.error(`[${cam.prefix}] inference HTTP ${resp.status}: ${await resp.text()}`);
      return;
    }
    const result = await resp.json();
    console.log(`[${cam.prefix}] ${path.basename(framePath)} objects=${result.objects?.length ?? 0} faces=${result.faces?.length ?? 0}`);
    
    const inserted = await persistFacts(cam, path.basename(framePath), result);
    console.log(`[${cam.prefix}] ${path.basename(framePath)} objects=${result.objects?.length ?? 0} faces=${result.faces?.length ?? 0} persisted=${inserted}`);
  } catch (err) {
    console.error(`[${cam.prefix}] inference failed:`, err);
  }
}

async function sampleTick() {
  await Promise.all(CAMERAS.map(sampleCamera)); // cameras processed in parallel
}

async function persistFacts(
  cam: (typeof CAMERAS)[number],
  frameFilename: string,
  result: any
) {sampleCamera
  const detections = [
    ...result.faces.map((f: any) => ({ label: "person", confidence: f.confidence, bbox: f.bbox })),
    ...result.objects.map((o: any) => ({ label: o.cls, confidence: o.confidence, bbox: o.bbox })),
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const d of detections) {
      await client.query(
        `INSERT INTO detection_events (camera_id, confidence, bbox, frame_ref, detected_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [cam.camera_id, d.confidence, JSON.stringify({ class: d.label, bbox: d.bbox }), frameFilename, new Date()]
      );
    }
    await client.query("COMMIT");
    return detections.length;
  } finally {
    client.release();
  }
}

setInterval(sampleTick, SAMPLE_INTERVAL_MS);
app.get("/health", (_req, res) => res.json({ status: "ok", service: "frame-sampler" }));
app.listen(PORT, () => console.log(`frame-sampler listening on ${PORT}`));