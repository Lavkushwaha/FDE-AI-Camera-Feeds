# Dashboard (placeholder — build order step 9)

Not scaffolded yet on purpose: per the LLD build order, everything else should be
working and demoable via curl/Postman first. Scaffold this as a Next.js app once
gateway, erp-sync, and presence-timeline are returning real data — build the UI
against real responses, not mocked ones.

Planned pages:
- Live camera view (consumes GET /stream/:cameraId/token from gateway)
- Attendance grid (consumes GET /attendance from erp-sync)
- Student timeline with narrative (consumes GET /students/:id/timeline)
