import axios from "axios";

const BASE = process.env.REACT_APP_BACKEND_URL;
export const API = `${BASE}/api`;
export const MEDIA = (p) => (p?.startsWith("http") ? p : `${BASE}${p}`);

const http = axios.create({ baseURL: API });

export const vic = {
  packs: () => http.get("/packs").then(r => r.data),
  metrics: () => http.get("/metrics").then(r => r.data),

  cameras: () => http.get("/cameras").then(r => r.data),
  createCamera: (payload) => http.post("/cameras", payload).then(r => r.data),
  deleteCamera: (id) => http.delete(`/cameras/${id}`).then(r => r.data),
  setZones: (id, zones) => http.put(`/cameras/${id}/zones`, zones).then(r => r.data),
  seedSample: () => http.post("/seed_sample").then(r => r.data),

  uploadVideo: (id, file, sample_fps=1.0, max_frames=60, onProgress) => {
    const fd = new FormData();
    fd.append("file", file);
    return http.post(`/cameras/${id}/upload_video`, fd, {
      params: { sample_fps, max_frames },
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: onProgress,
    }).then(r => r.data);
  },
  job: (jid) => http.get(`/jobs/${jid}`).then(r => r.data),
  jobs: () => http.get("/jobs").then(r => r.data),

  ledger: (params) => http.get("/ledger", { params }).then(r => r.data),
  factsheet: (camera_id, minutes=10) => http.get("/ledger/factsheet", { params: { camera_id, minutes } }).then(r => r.data),
  exportLedgerURL: (params) => {
    const q = new URLSearchParams(params).toString();
    return `${API}/ledger/export?${q}`;
  },

  scanAnomalies: (camera_id, minutes=10) => http.post(`/anomalies/scan`, null, { params: { camera_id, minutes } }).then(r => r.data),
  anomalies: (params) => http.get("/anomalies", { params }).then(r => r.data),
  ack: (id, note="") => http.post(`/anomalies/${id}/ack`, { actor: "operator", note }).then(r => r.data),
  resolve: (id, note="") => http.post(`/anomalies/${id}/resolve`, { actor: "operator", note }).then(r => r.data),

  identities: () => http.get("/identities").then(r => r.data),
  enrollFace: (file, name, category, priority, notes) => {
    const fd = new FormData();
    fd.append("file", file);
    return http.post("/identities/enroll", fd, {
      params: { name, category, priority, notes },
      headers: { "Content-Type": "multipart/form-data" },
    }).then(r => r.data);
  },
  deleteIdentity: (id) => http.delete(`/identities/${id}`).then(r => r.data),
  matches: (params) => http.get("/matches", { params }).then(r => r.data),

  locks: () => http.get("/locks").then(r => r.data),
  createLock: (payload) => http.post("/locks", payload).then(r => r.data),
  closeLock: (id) => http.delete(`/locks/${id}`).then(r => r.data),
  sweep: (id, window_minutes=1440) => http.get(`/locks/${id}/sweep`, { params: { window_minutes } }).then(r => r.data),

  narrative: (payload) => http.post("/narrative", payload).then(r => r.data),
  narratives: () => http.get("/narratives").then(r => r.data),

  purge: (hours=24) => http.post(`/retention/purge`, null, { params: { hours } }).then(r => r.data),
};
