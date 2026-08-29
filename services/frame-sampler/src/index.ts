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

type Camera = { camera_id: string; room_id: string; prefix: string };

let cameras: Camera[] = [];

async function loadCameras() {
  const { rows } = await pool.query(
    `SELECT id AS camera_id, room_id, stream_key AS prefix FROM cameras WHERE stream_key IS NOT NULL AND active`
  );
  cameras = rows.map((r) => ({
    camera_id: r.camera_id,
    room_id: r.room_id,
    prefix: r.prefix,
  }));
  if (cameras.length === 0) {
    cameras = [
      { camera_id: "44444444-4444-4444-4444-444444444441", room_id: "33333333-3333-3333-3333-333333333331", prefix: "cam1" },
      { camera_id: "44444444-4444-4444-4444-444444444442", room_id: "33333333-3333-3333-3333-333333333332", prefix: "cam2" },
    ];
  }
}

function newestFrame(prefix: string): string | null {
  const files = fs.readdirSync(FRAMES_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"))
    .sort();
  return files.length ? path.join(FRAMES_DIR, files[files.length - 1]) : null;
}

const lastProcessed = new Map<string, string>();

async function sampleCamera(cam: Camera) {
  const framePath = newestFrame(cam.prefix);
  if (!framePath || framePath === lastProcessed.get(cam.prefix)) return;
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
    const inserted = await persistFacts(cam, path.basename(framePath), result);
    await pool.query(
      `UPDATE cameras SET status = 'online', last_heartbeat = now() WHERE id = $1`,
      [cam.camera_id]
    );
    console.log(
      `[${cam.prefix}] ${path.basename(framePath)} objects=${result.objects?.length ?? 0} faces=${result.faces?.length ?? 0} persisted=${inserted}`
    );
  } catch (err) {
    console.error(`[${cam.prefix}] inference failed:`, err);
  }
}

async function sampleTick() {
  await Promise.all(cameras.map(sampleCamera));
}

async function persistFacts(cam: Camera, frameFilename: string, result: { faces?: unknown[]; objects?: unknown[] }) {
  const faces = (result.faces ?? []) as Array<{ confidence: number; bbox: unknown }>;
  const objects = (result.objects ?? []) as Array<{ cls: string; class?: string; confidence: number; bbox: unknown }>;
  const detections = [
    ...faces.map((f) => ({ label: "person", confidence: f.confidence, bbox: f.bbox })),
    ...objects.map((o) => ({ label: o.cls ?? o.class, confidence: o.confidence, bbox: o.bbox })),
  ];
  const detectedAt = new Date(); // one timestamp for every detection in this frame —
  // computing it per-row inside the loop below gave each row its own millisecond,
  // which silently splits a single frame's detections across multiple timestamps
  // in any query that groups by (frame_ref, detected_at).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const d of detections) {
      await client.query(
        `INSERT INTO detection_events (camera_id, confidence, bbox, frame_ref, detected_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [cam.camera_id, d.confidence, JSON.stringify({ class: d.label, bbox: d.bbox }), frameFilename, detectedAt]
      );
    }
    await client.query("COMMIT");
    return detections.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "frame-sampler", cameras: cameras.length }));

async function main() {
  await loadCameras();
  setInterval(() => {
    loadCameras().catch((err) => console.error("reload cameras failed", err));
  }, 30_000);
  setInterval(sampleTick, SAMPLE_INTERVAL_MS);
  app.listen(PORT, () => console.log(`frame-sampler listening on ${PORT} cameras=${cameras.length}`));
}

main().catch((err) => {
  console.error("frame-sampler failed to start", err);
  process.exit(1);
});
