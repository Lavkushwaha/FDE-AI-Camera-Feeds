// Frame Sampler: pulls frames from MediaMTX at a configurable interval, calls the
// Inference Service, and publishes detection events (LLD section 2.1 + 3.1).
// POC: polling loop with a mock frame reference. Replace frame extraction with a
// real MediaMTX/ffmpeg snapshot grab once cameras are live.
import express from "express";

const app = express();
const PORT = process.env.PORT || 4003;
const INFERENCE_URL = process.env.INFERENCE_URL || "http://inference-service:5000";
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS || 5000);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "frame-sampler" }));

async function sampleTick() {
  try {
    // TODO: replace with a real snapshot grab from MediaMTX for each active camera.
    const mockPayload = {
      camera_id: "44444444-4444-4444-4444-444444444441",
      room_id: "33333333-3333-3333-3333-333333333331",
      timestamp: new Date().toISOString(),
      frame_url: "mock://frame.jpg",
    };
    const resp = await fetch(`${INFERENCE_URL}/infer/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mockPayload),
    });
    const result = await resp.json();
    console.log("sample tick result:", result);
    // TODO: publish result onto the event queue for erp-sync / presence-timeline to consume.
  } catch (err) {
    console.error("sample tick failed:", err);
  }
}

setInterval(sampleTick, SAMPLE_INTERVAL_MS);
app.listen(PORT, () => console.log(`frame-sampler listening on ${PORT}`));
