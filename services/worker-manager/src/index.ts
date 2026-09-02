// Worker manager: turns a `cameras` row into running ffmpeg processes.
// Only manages cameras added dynamically via POST /registry/cameras (source_uri IS NOT NULL) —
// the two seeded demo cameras stay owned by their static mock-camera-*/frame-grabber-* compose services.
// This is the "camera is a config entry, not a code change" piece of FRAMEWORK.md §2.1.
import express from "express";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

const app = express();
const PORT = process.env.PORT || 4005;
const FRAMES_DIR = process.env.FRAMES_DIR || "/frames";
const MEDIAMTX_RTSP = process.env.MEDIAMTX_RTSP || "rtsp://mediamtx:8554";
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 5000);
// Bind-mounted directories on this host don't tolerate ffmpeg's seek-heavy reopen
// on -stream_loop restarts (Docker Desktop file-sharing quirk) — a single-file bind
// mount doesn't have this problem, so we copy each source onto local disk once and
// loop from there instead of looping directly off the shared /videos mount.
const LOCAL_SOURCES_DIR = "/tmp/sources";
fs.mkdirSync(LOCAL_SOURCES_DIR, { recursive: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ENSURE_SQL = `
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS source_uri TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS fps INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
`;

type ManagedCamera = {
  id: string;
  stream_key: string;
  source_type: "rtsp" | "file" | "webcam";
  source_uri: string | null;
  fps: number;
};

type Worker = {
  cam: ManagedCamera;
  publish: ChildProcess | null;
  grab: ChildProcess | null;
  grabRetryTimer: NodeJS.Timeout | null;
};

const workers = new Map<string, Worker>();
const GRAB_RETRY_MS = 3000;
// give `publish` time to finish its RTSP handshake with MediaMTX before the first
// `grab` attempt — otherwise grab's first read fails fast, every single time.
const GRAB_FIRST_ATTEMPT_MS = 3000;

function log(streamKey: string, msg: string) {
  console.log(`[worker-manager:${streamKey}] ${msg}`);
}

function spawnFfmpeg(streamKey: string, label: string, args: string[]): ChildProcess {
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "warning", ...args]);
  proc.stderr?.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) log(streamKey, `${label}: ${line}`);
  });
  return proc;
}

function scheduleGrab(streamKey: string, delayMs: number) {
  const w = workers.get(streamKey);
  if (!w) return; // torn down — nothing to (re)start
  if (w.grabRetryTimer) clearTimeout(w.grabRetryTimer);
  w.grabRetryTimer = setTimeout(() => startGrab(streamKey), delayMs);
}

function startGrab(streamKey: string) {
  const w = workers.get(streamKey);
  if (!w) return; // torn down while we were waiting
  w.grabRetryTimer = null;
  const target = `${MEDIAMTX_RTSP}/${streamKey}`;
  const grab = spawnFfmpeg(streamKey, "grab", [
    "-rtsp_transport", "tcp",
    "-i", target,
    "-r", String(w.cam.fps || 1),
    "-q:v", "2",
    "-strftime", "1",
    `${FRAMES_DIR}/${streamKey}_%Y%m%d_%H%M%S.jpg`,
  ]);
  w.grab = grab;
  grab.on("exit", (code, signal) => {
    log(streamKey, `grab exited (code=${code} signal=${signal})`);
    const current = workers.get(streamKey);
    if (!current || current.grab !== grab) return; // deliberately stopped or already replaced
    current.grab = null;
    scheduleGrab(streamKey, GRAB_RETRY_MS); // publish keeps running; just retry the reader
  });
}

async function startWorker(cam: ManagedCamera) {
  const target = `${MEDIAMTX_RTSP}/${cam.stream_key}`;
  const worker: Worker = { cam, publish: null, grab: null, grabRetryTimer: null };
  workers.set(cam.stream_key, worker);

  if (cam.source_type === "file") {
    const localPath = path.join(LOCAL_SOURCES_DIR, `${cam.stream_key}${path.extname(cam.source_uri!) || ".mp4"}`);
    if (!fs.existsSync(localPath)) {
      log(cam.stream_key, `copying ${cam.source_uri} to local disk before looping`);
      await fs.promises.copyFile(cam.source_uri!, localPath);
    }
    // mirrors mock-cameras/stream.sh: -c copy is what's proven to survive -stream_loop
    // on real mp4 files here. Requires h264/aac source; re-encoding is a pack-level concern,
    // not core's job.
    worker.publish = spawnFfmpeg(cam.stream_key, "publish", [
      "-re", "-stream_loop", "-1", "-fflags", "+genpts",
      "-i", localPath,
      "-c", "copy",
      "-f", "rtsp", target,
    ]);
  } else if (cam.source_type === "rtsp") {
    worker.publish = spawnFfmpeg(cam.stream_key, "publish", [
      "-rtsp_transport", "tcp",
      "-i", cam.source_uri!,
      "-c", "copy",
      "-f", "rtsp", target,
    ]);
  }
  // webcam: operator's host process publishes directly to MediaMTX under this stream_key
  // (see FRAMEWORK.md §2.1 interim provisioning) — nothing for us to spawn.

  if (worker.publish) {
    const publishProc = worker.publish;
    publishProc.on("exit", (code, signal) => {
      log(cam.stream_key, `publish exited (code=${code} signal=${signal})`);
      const current = workers.get(cam.stream_key);
      if (!current || current.publish !== publishProc) return; // deliberately stopped/replaced
      workers.delete(cam.stream_key); // no source anymore — full teardown, reconcile restarts both halves
      if (current.grabRetryTimer) clearTimeout(current.grabRetryTimer);
      current.grab?.removeAllListeners("exit");
      current.grab?.kill("SIGTERM");
    });
  }

  log(cam.stream_key, `started (source_type=${cam.source_type})`);
  scheduleGrab(cam.stream_key, cam.source_type === "webcam" ? 0 : GRAB_FIRST_ATTEMPT_MS);
}

function stopWorker(streamKey: string) {
  const w = workers.get(streamKey);
  if (!w) return;
  workers.delete(streamKey); // first, so any in-flight exit handlers see a torn-down worker
  if (w.grabRetryTimer) clearTimeout(w.grabRetryTimer);
  w.publish?.removeAllListeners("exit");
  w.grab?.removeAllListeners("exit");
  w.publish?.kill("SIGTERM");
  w.grab?.kill("SIGTERM");
  log(streamKey, "stopped");
}

const starting = new Set<string>();

async function reconcile() {
  const { rows } = await pool.query<ManagedCamera>(
    `SELECT id, stream_key, source_type, source_uri, fps
     FROM cameras
     WHERE active AND stream_key IS NOT NULL
       AND (source_uri IS NOT NULL OR source_type = 'webcam')`
  );
  const desired = new Map(rows.map((r) => [r.stream_key, r]));

  for (const streamKey of [...workers.keys()]) {
    if (!desired.has(streamKey)) stopWorker(streamKey);
  }
  for (const [streamKey, cam] of desired) {
    if (workers.has(streamKey) || starting.has(streamKey)) continue;
    starting.add(streamKey);
    startWorker(cam)
      .catch((err) => log(streamKey, `start failed: ${err}`))
      .finally(() => starting.delete(streamKey));
  }
}

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "worker-manager", managed: [...workers.keys()] })
);
app.get("/workers", (_req, res) =>
  res.json(
    [...workers.values()].map((w) => ({
      camera_id: w.cam.id,
      stream_key: w.cam.stream_key,
      source_type: w.cam.source_type,
      fps: w.cam.fps,
    }))
  )
);

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
  await reconcile();
  setInterval(() => {
    reconcile().catch((err) => console.error("reconcile failed", err));
  }, RECONCILE_INTERVAL_MS);
  app.listen(PORT, () => console.log(`worker-manager listening on ${PORT}`));
}

main().catch((err) => {
  console.error("worker-manager failed to start", err);
  process.exit(1);
});
