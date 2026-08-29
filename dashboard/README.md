# Operator console

Static dashboard served on port 3000. It talks to the gateway (`http://localhost:4000`).

```bash
docker compose up -d --build dashboard gateway presence-timeline
```

Open http://localhost:3000

- Live HLS per camera (proxied through the gateway)
- YOLO overlay on the last inferred frame
- Fact-sheet view + JSON/CSV export
- Anomaly scan / acknowledge / resolve
- Optional Ollama narrative (Summary tab)
- Add/decommission cameras (file/rtsp/webcam source) without a compose edit or restart —
  "+ Add camera" panel calls the gateway's dynamic registry endpoints; `worker-manager`
  spawns/stops the actual ffmpeg processes (see GETTING_STARTED.md §7)
