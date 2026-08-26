// Gateway: auth + signed stream URL issuance (LLD section 2.4).
// POC-grade: in-memory JWT stub. Swap for real auth before this touches real cameras.
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;

app.get("/health", (_req, res) => res.json({ status: "ok", service: "gateway" }));

// POC stub — issues a fake token. Replace with real JWT signing + user store.
app.post("/auth/login", (req, res) => {
  res.json({ token: "dev-token-replace-me" });
});

// POC stub — issues a short-lived "signed" URL pointing at MediaMTX's HLS output.
// Real version: verify JWT, check camera permission, sign with expiry, never leak
// the raw MediaMTX/RTSP address to the client.
app.get("/stream/:cameraId/token", (req, res) => {
  const { cameraId } = req.params;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  res.json({
    signed_url: `http://localhost:8888/${cameraId}/index.m3u8`,
    expires_at: expiresAt,
  });
});

app.listen(PORT, () => console.log(`gateway listening on ${PORT}`));
