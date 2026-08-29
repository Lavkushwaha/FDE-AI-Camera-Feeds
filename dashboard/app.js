const API = window.VIC_API || "http://localhost:4000";

const state = {
  cameras: [],
  selectedId: null,
  hls: null,
  overlay: false,
  poll: null,
};

const $ = (id) => document.getElementById(id);

function bboxOf(det) {
  const raw = det.bbox;
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.bbox)) return raw.bbox;
  return null;
}

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const body = ct.includes("json") ? await res.json().catch(() => null) : null;
    throw new Error(body?.error || `${path} ${res.status}`);
  }
  if (ct.includes("json")) return res.json();
  return res;
}

async function loadCameras() {
  const cams = await api("/registry/cameras");
  state.cameras = cams;
  const row = $("health-row");
  row.innerHTML = "";
  cams.forEach((c) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `pill ${c.health}`;
    el.textContent = `${c.name} · ${c.health}`;
    el.onclick = () => selectCamera(c.id);
    row.appendChild(el);
  });
  if (state.selectedId && !cams.some((c) => c.id === state.selectedId)) {
    state.selectedId = null; // camera was decommissioned elsewhere
  }
  if (!state.selectedId && cams[0]) await selectCamera(cams[0].id);
  else if (state.selectedId) {
    const still = cams.find((c) => c.id === state.selectedId);
    if (still) $("cam-title").textContent = `${still.name} (${still.health})`;
  } else {
    $("cam-title").textContent = "Select a camera";
  }
}

function playHls(url) {
  const video = $("live");
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  if (window.Hls && Hls.isSupported()) {
    state.hls = new Hls({ liveDurationInfinity: true });
    state.hls.loadSource(url);
    state.hls.attachMedia(video);
  } else {
    video.src = url;
  }
}

async function selectCamera(id) {
  state.selectedId = id;
  const cam = state.cameras.find((c) => c.id === id);
  if (!cam) return;
  $("cam-title").textContent = `${cam.name} (${cam.health})`;
  $("remove-camera-btn").classList.remove("hidden");
  try {
    const tok = await api(`/stream/${id}/token`);
    playHls(tok.signed_url);
  } catch (err) {
    console.error(err);
  }
  await Promise.all([refreshOverlay(), refreshFacts(), refreshFrames(), refreshAnomalies()]);
}

async function refreshOverlay() {
  if (!state.selectedId) return;
  try {
    const data = await api(`/cameras/${state.selectedId}/detections/latest`);
    const img = $("still");
    const canvas = $("boxes");
    if (!data.frame_url) return;
    img.onload = () => {
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!state.overlay) return;
      ctx.strokeStyle = "#3d8bfd";
      ctx.fillStyle = "#3d8bfd";
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.font = `${Math.max(12, canvas.width / 50)}px sans-serif`;
      for (const det of data.detections || []) {
        const box = bboxOf(det);
        if (!box || box.length < 4) continue;
        const [x, y, w, h] = box.map(Number);
        ctx.strokeRect(x, y, w, h);
        const label = `${det.label || det.bbox?.class || "obj"} ${(Number(det.confidence) * 100).toFixed(0)}%`;
        ctx.fillText(label, x + 4, Math.max(14, y - 4));
      }
    };
    img.src = data.frame_url;
  } catch (err) {
    console.error(err);
  }
}

async function refreshFacts() {
  if (!state.selectedId) return;
  try {
    const sheet = await api(`/ledger/fact-sheet?camera_id=${state.selectedId}`);
    $("fact-json").textContent = JSON.stringify(sheet, null, 2);
    const spanSec = Math.round((new Date(sheet.window.to) - new Date(sheet.window.from)) / 1000);
    $("fact-window").textContent =
      `Last ${spanSec}s · ${sheet.frames_seen}/${sheet.frames_expected} frames sampled. ` +
      `"Detections" is summed across every frame in this window — see "Avg/frame" for what was actually in view at once.`;
    const rows = sheet.detections_per_class || [];
    const table = $("fact-table");
    const empty = $("fact-empty");
    if (!rows.length) {
      table.classList.add("hidden");
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    table.classList.remove("hidden");
    const body = $("fact-table-body");
    body.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.label}</td><td>${r.detections}</td><td>${r.avg_per_frame ?? "—"}</td><td>${r.avg_conf}</td>`;
      body.appendChild(tr);
    });
  } catch (err) {
    $("fact-json").textContent = String(err);
    $("fact-window").textContent = "";
    $("fact-table").classList.add("hidden");
    $("fact-empty").classList.add("hidden");
  }
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([label, n]) => `${label}: ${n}`)
    .join(", ");
}

async function refreshFrames() {
  if (!state.selectedId) return;
  try {
    const sheet = await api(`/ledger/frames?camera_id=${state.selectedId}`);
    const frames = sheet.frames || [];
    const table = $("frames-table");
    const empty = $("frames-empty");
    if (!frames.length) {
      table.classList.add("hidden");
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    table.classList.remove("hidden");
    const body = $("frames-table-body");
    body.innerHTML = "";
    // newest first — most useful for eyeballing what just happened
    [...frames].reverse().forEach((f) => {
      const tr = document.createElement("tr");
      const time = new Date(f.detected_at).toLocaleTimeString();
      tr.innerHTML = `<td>${f.frame_ref}</td><td>${time}</td><td>${formatCounts(f.counts)}</td>`;
      body.appendChild(tr);
    });
  } catch (err) {
    $("frames-table").classList.add("hidden");
    $("frames-empty").classList.remove("hidden");
    $("frames-empty").textContent = String(err);
  }
}

async function refreshAnomalies() {
  try {
    const rows = await api("/anomalies");
    const list = $("anomaly-list");
    if (!rows.length) {
      list.innerHTML = '<p class="empty">No anomalies yet. Run a scan after the cameras have been live for a minute.</p>';
      return;
    }
    list.innerHTML = "";
    rows.forEach((a) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <h3>${a.type} · ${a.status}</h3>
        <p>${a.camera_name} · ${new Date(a.opened_at).toLocaleString()}</p>
        <p>${JSON.stringify(a.payload)}</p>
        <div class="actions"></div>`;
      const actions = card.querySelector(".actions");
      if (a.status === "open") {
        const ack = document.createElement("button");
        ack.textContent = "Acknowledge";
        ack.onclick = async () => {
          await api(`/anomalies/${a.id}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          refreshAnomalies();
        };
        actions.appendChild(ack);
      }
      if (a.status !== "resolved") {
        const res = document.createElement("button");
        res.textContent = "Resolve";
        res.onclick = async () => {
          await api(`/anomalies/${a.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          refreshAnomalies();
        };
        actions.appendChild(res);
      }
      list.appendChild(card);
    });
  } catch (err) {
    $("anomaly-list").textContent = String(err);
  }
}

function download(path, filename) {
  const a = document.createElement("a");
  a.href = `${API}${path}`;
  a.download = filename;
  a.click();
}

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["anomalies", "facts", "summary"].forEach((name) => {
      $("tab-" + name).classList.toggle("hidden", btn.dataset.tab !== name);
    });
  };
});

$("overlay-toggle").onchange = (e) => {
  state.overlay = e.target.checked;
  refreshOverlay();
};

$("scan-btn").onclick = async () => {
  $("scan-btn").disabled = true;
  try {
    await api("/anomalies/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refreshAnomalies();
  } finally {
    $("scan-btn").disabled = false;
  }
};

$("export-json").onclick = () => {
  if (state.selectedId) download(`/export/facts?camera_id=${state.selectedId}&format=json`, "facts.json");
};
$("export-csv").onclick = () => {
  if (state.selectedId) download(`/export/facts?camera_id=${state.selectedId}&format=csv`, "facts.csv");
};
$("export-frames-json").onclick = () => {
  if (state.selectedId) download(`/export/frames?camera_id=${state.selectedId}&format=json`, "frames.json");
};
$("export-frames-csv").onclick = () => {
  if (state.selectedId) download(`/export/frames?camera_id=${state.selectedId}&format=csv`, "frames.csv");
};

function setCamFormForType(type) {
  const uri = $("cam-source-uri");
  if (type === "webcam") {
    uri.placeholder = "not needed — push your webcam to MediaMTX first (see hint below)";
    uri.disabled = true;
    uri.value = "";
  } else {
    uri.disabled = false;
    uri.placeholder = type === "file" ? "/videos/yourfile.mp4" : "rtsp://host:8554/path";
  }
}

$("add-camera-btn").onclick = () => {
  $("add-camera-panel").classList.toggle("hidden");
  $("cam-error").classList.add("hidden");
};
$("cam-cancel").onclick = () => $("add-camera-panel").classList.add("hidden");
$("cam-source-type").onchange = (e) => setCamFormForType(e.target.value);
setCamFormForType($("cam-source-type").value);

$("cam-submit").onclick = async () => {
  const name = $("cam-name").value.trim();
  const type = $("cam-source-type").value;
  const uri = $("cam-source-uri").value.trim();
  const fps = Number($("cam-fps").value) || 1;
  const errEl = $("cam-error");
  errEl.classList.add("hidden");
  if (!name) {
    errEl.textContent = "Camera name is required.";
    errEl.classList.remove("hidden");
    return;
  }
  if (type !== "webcam" && !uri) {
    errEl.textContent = "Source URI is required for file/rtsp cameras.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await api("/registry/cameras", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, source: { type, uri: uri || undefined }, fps }),
    });
    $("cam-name").value = "";
    $("cam-source-uri").value = "";
    $("add-camera-panel").classList.add("hidden");
    await loadCameras();
  } catch (err) {
    errEl.textContent = String(err);
    errEl.classList.remove("hidden");
  }
};

$("remove-camera-btn").onclick = async () => {
  if (!state.selectedId) return;
  const cam = state.cameras.find((c) => c.id === state.selectedId);
  if (!confirm(`Decommission "${cam ? cam.name : state.selectedId}"? Its worker stops; ledger history stays queryable.`)) return;
  try {
    await api(`/registry/cameras/${state.selectedId}`, { method: "DELETE" });
    state.selectedId = null;
    await loadCameras();
  } catch (err) {
    alert(`Could not remove camera: ${err}`);
  }
};

$("ask-summary").onclick = async () => {
  if (!state.selectedId) return;
  const window = $("summary-window").value;
  $("summary-out").textContent = "Generating…";
  try {
    const data = await api(`/summaries/${state.selectedId}?window=${window}`);
    $("summary-out").textContent = `${data.narrative || ""}\n\n${JSON.stringify(data.fact_sheet, null, 2)}`;
  } catch (err) {
    $("summary-out").textContent = String(err);
  }
};

async function boot() {
  try {
    await api("/health");
    $("api-status").textContent = "gateway ok";
    $("api-status").className = "pill online";
  } catch {
    $("api-status").textContent = "gateway down";
    $("api-status").className = "pill offline";
  }
  await loadCameras();
  state.poll = setInterval(() => {
    loadCameras().catch(() => {});
    refreshOverlay().catch(() => {});
    refreshFacts().catch(() => {});
    refreshFrames().catch(() => {});
  }, 2000);
}

boot();
