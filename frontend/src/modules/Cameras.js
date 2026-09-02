import React, { useEffect, useRef, useState } from "react";
import { vic, MEDIA } from "../api";
import { Plus, Upload, Trash2, Play, Pause, Pencil, X, RefreshCw, Eye, EyeOff, Film, Images, ChevronLeft, ChevronRight } from "lucide-react";

export default function Cameras({ pack }) {
  const [cams, setCams] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [zoneEditor, setZoneEditor] = useState(null); // camera
  const [uploadTarget, setUploadTarget] = useState(null);
  const [scrubTarget, setScrubTarget] = useState(null);
  const [frameTarget, setFrameTarget] = useState(null);
  const [overlayState, setOverlayState] = useState(() => JSON.parse(localStorage.getItem("vic-overlays") || "{}"));

  const setOverlay = (cid, v) => {
    const next = { ...overlayState, [cid]: v };
    setOverlayState(next);
    localStorage.setItem("vic-overlays", JSON.stringify(next));
  };

  const load = () => vic.cameras().then(setCams);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const seed = async () => { await vic.seedSample(); await load(); };

  return (
    <div className="space-y-4" data-testid="cameras-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Camera Grid</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">{cams.length} cameras · pack: {pack} · YOLO overlay per-camera</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={seed} data-testid="seed-sample-btn"><RefreshCw size={14} /> Seed sample</button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)} data-testid="add-camera-button"><Plus size={14} /> Add camera</button>
        </div>
      </div>

      {cams.length === 0 ? (
        <div className="panel p-10 text-center">
          <div className="text-slate-400 font-mono text-xs uppercase tracking-widest">no cameras registered</div>
          <button className="btn btn-primary mt-4" onClick={seed}><Plus size={14}/> Seed 2 demo cameras</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-testid="camera-grid">
          {cams.map(c => (
            <CameraCard key={c.id} cam={c}
              overlay={overlayState[c.id] !== false}
              onToggleOverlay={() => setOverlay(c.id, !(overlayState[c.id] !== false))}
              onDelete={async () => { await vic.deleteCamera(c.id); load(); }}
              onZones={() => setZoneEditor(c)}
              onUpload={() => setUploadTarget(c)}
              onScrub={() => setScrubTarget(c)}
              onFrames={() => setFrameTarget(c)}
            />
          ))}
        </div>
      )}

      {showAdd && <AddCameraModal pack={pack} onClose={() => setShowAdd(false)} onCreated={() => { setShowAdd(false); load(); }} />}
      {zoneEditor && <ZoneEditorModal camera={zoneEditor} onClose={() => setZoneEditor(null)} onSaved={load} />}
      {uploadTarget && <UploadVideoModal camera={uploadTarget} onClose={() => setUploadTarget(null)} onDone={load} />}
      {scrubTarget && <TrackScrubberModal camera={scrubTarget} onClose={() => setScrubTarget(null)} />}
      {frameTarget && <FrameBrowserModal camera={frameTarget} onClose={() => setFrameTarget(null)} />}
    </div>
  );
}

function CameraCard({ cam, overlay, onToggleOverlay, onDelete, onZones, onUpload, onScrub, onFrames }) {
  const [latest, setLatest] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => vic.ledger({ camera_id: cam.id, limit: 1 }).then(r => alive && setLatest(r[0])).catch(()=>{});
    load(); const t = setInterval(load, 4000); return () => { alive = false; clearInterval(t); };
  }, [cam.id]);

  const online = cam.status === "online";
  return (
    <div className="card p-3 hud-corners relative" data-testid={`camera-card-${cam.id}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-temerald" : "bg-slate-600"}`} />
        <div className="flex-1 min-w-0">
          <div className="text-heading font-semibold text-slate-100 truncate">{cam.name}</div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{cam.source?.type} · {cam.pack}</div>
        </div>
        <span className="badge border-subtle text-slate-400">{cam.frames_seen ?? 0}f</span>
      </div>

      <div className="relative aspect-video bg-black border border-subtle overflow-hidden hud-scanlines">
        {latest?.frame_ref ? (
          <>
            <img src={MEDIA(latest.frame_ref)} className="absolute inset-0 w-full h-full object-cover" alt="latest frame" />
            {overlay && <YoloOverlay objects={latest.objects} faces={latest.faces} />}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-xs font-mono uppercase tracking-widest">no frames · upload video</div>
        )}
        <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 text-[9px] font-mono text-tcyan uppercase tracking-widest">{cam.id.slice(0,8)}</div>
        {latest && (
          <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-black/60 text-[9px] font-mono text-tamber uppercase tracking-widest">
            {latest.objects?.length || 0} obj · {latest.faces?.length || 0} face
          </div>
        )}
        <button
          onClick={onToggleOverlay}
          data-testid={`overlay-toggle-${cam.id}`}
          title={overlay ? "hide YOLO overlay" : "show YOLO overlay"}
          className={`absolute bottom-1 left-1 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest border ${overlay ? "border-tcyan/60 bg-tcyan/10 text-tcyan" : "border-slate-600/50 bg-black/60 text-slate-400"}`}
        >
          {overlay ? <><Eye size={10} className="inline mr-1"/>YOLO</> : <><EyeOff size={10} className="inline mr-1"/>YOLO</>}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-1">
        <button className="btn flex-1" onClick={onUpload} data-testid={`upload-video-${cam.id}`}><Upload size={12}/> Upload</button>
        <button className="btn" onClick={onScrub} data-testid={`scrub-${cam.id}`} title="Live Track Scrubber"><Film size={12}/></button>
        <button className="btn" onClick={onFrames} data-testid={`frames-${cam.id}`} title="Browse frames"><Images size={12}/></button>
        <button className="btn" onClick={onZones} data-testid={`zones-${cam.id}`} title="Zones"><Pencil size={12}/></button>
        <button className="btn btn-danger" onClick={onDelete} data-testid={`delete-camera-${cam.id}`}><Trash2 size={12}/></button>
      </div>
    </div>
  );
}

function YoloOverlay({ objects = [], faces = [] }) {
  // frames served are raw; we approximate w/h from first bbox via natural size but simpler: percentage-based
  // use ref to compute actual scale after image loads
  const ref = useRef(null);
  const [scale, setScale] = useState({ w: 1, h: 1 });
  useEffect(() => {
    const el = ref.current?.parentElement?.querySelector("img");
    if (!el) return;
    const onLoad = () => setScale({ w: el.naturalWidth, h: el.naturalHeight });
    if (el.complete) onLoad(); else el.addEventListener("load", onLoad);
    return () => el.removeEventListener("load", onLoad);
  }, [objects]);
  return (
    <svg ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${scale.w} ${scale.h}`} preserveAspectRatio="none">
      {objects.map((o, i) => (
        <g key={`o${i}`}>
          <rect x={o.bbox[0]} y={o.bbox[1]} width={o.bbox[2]-o.bbox[0]} height={o.bbox[3]-o.bbox[1]}
            fill="rgba(6,182,212,0.08)" stroke="#06B6D4" strokeWidth={2} />
          <text x={o.bbox[0]+4} y={o.bbox[1]+14} fontSize="12" fill="#67E8F9" fontFamily="JetBrains Mono">
            {o.label} {Math.round(o.confidence*100)}%{o.track_id!=null ? ` #${o.track_id}` : ""}
          </text>
        </g>
      ))}
      {faces.map((f, i) => {
        const [x1,y1,x2,y2] = f.bbox;
        const clr = f.match ? "#F59E0B" : "#EF4444";
        return (
          <g key={`f${i}`}>
            <rect x={x1} y={y1} width={x2-x1} height={y2-y1}
              fill="rgba(245,158,11,0.05)" stroke={clr} strokeWidth={2} strokeDasharray={f.match ? "0" : "5 3"} />
            <text x={x1+4} y={y2-6} fontSize="11" fill={clr} fontFamily="JetBrains Mono">
              {f.match ? `${f.match.name} · ${Math.round(f.match.similarity*100)}%` : "unknown"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function TrackScrubberModal({ camera, onClose }) {
  const [frames, setFrames] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(500); // ms/frame
  const [overlay, setOverlay] = useState(true);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setBusy(true);
    vic.frames(camera.id, 400, 1440).then(r => {
      setFrames(r.frames || []);
      setBusy(false);
    });
  }, [camera.id]);

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const t = setInterval(() => setIdx(i => (i + 1 >= frames.length ? 0 : i + 1)), speed);
    return () => clearInterval(t);
  }, [playing, frames.length, speed]);

  const cur = frames[idx];

  return (
    <Modal onClose={onClose} title={`Live Track Scrubber · ${camera.name}`} testid="track-scrubber-modal" wide>
      <div className="relative aspect-video bg-black border border-subtle overflow-hidden hud-scanlines">
        {cur?.frame_ref ? (
          <>
            <img src={MEDIA(cur.frame_ref)} className="absolute inset-0 w-full h-full object-contain" alt={`frame ${idx}`}/>
            {overlay && <YoloOverlay objects={cur.objects} faces={cur.faces} />}
            <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/70 text-[10px] font-mono text-tcyan uppercase tracking-widest">frame {idx+1}/{frames.length}</div>
            <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/70 text-[10px] font-mono text-tamber uppercase tracking-widest">{new Date(cur.detected_at).toLocaleTimeString()}</div>
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs font-mono uppercase tracking-widest">
            {busy ? "loading frames…" : "no frames on this camera yet"}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button className="btn" onClick={()=>setIdx(i => Math.max(0, i-1))} disabled={idx===0} data-testid="scrub-prev"><ChevronLeft size={12}/></button>
        <button className="btn btn-primary" onClick={()=>setPlaying(p=>!p)} disabled={frames.length===0} data-testid="scrub-play">
          {playing ? <><Pause size={12}/> Pause</> : <><Play size={12}/> Play</>}
        </button>
        <button className="btn" onClick={()=>setIdx(i => Math.min(frames.length-1, i+1))} disabled={idx>=frames.length-1} data-testid="scrub-next"><ChevronRight size={12}/></button>
        <input
          type="range" min={0} max={Math.max(0, frames.length - 1)} value={idx}
          onChange={e=>setIdx(parseInt(e.target.value))} className="flex-1 accent-cyan-500"
          data-testid="scrub-slider"
        />
        <select value={speed} onChange={e=>setSpeed(parseInt(e.target.value))} className="input w-24 text-xs" data-testid="scrub-speed">
          <option value={1000}>1×</option>
          <option value={500}>2×</option>
          <option value={250}>4×</option>
          <option value={125}>8×</option>
        </select>
        <label className="text-[10px] font-mono uppercase tracking-widest text-slate-400 flex items-center gap-1">
          <input type="checkbox" checked={overlay} onChange={e=>setOverlay(e.target.checked)} data-testid="scrub-overlay-toggle"/> YOLO
        </label>
      </div>

      {cur && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
          <div className="card p-2"><div className="text-slate-500 uppercase tracking-widest">objects</div><div className="text-tcyan text-lg">{cur.objects?.length || 0}</div></div>
          <div className="card p-2"><div className="text-slate-500 uppercase tracking-widest">faces</div><div className="text-tamber text-lg">{cur.faces?.length || 0}</div></div>
          <div className="card p-2"><div className="text-slate-500 uppercase tracking-widest">track ids</div><div className="text-tcyan text-lg">{new Set((cur.objects||[]).map(o=>o.track_id).filter(x=>x!=null)).size}</div></div>
          <div className="card p-2"><div className="text-slate-500 uppercase tracking-widest">matches</div><div className="text-tamber text-lg">{(cur.faces||[]).filter(f=>f.match).length}</div></div>
        </div>
      )}
    </Modal>
  );
}

function FrameBrowserModal({ camera, onClose }) {
  const [frames, setFrames] = useState([]);
  const [sel, setSel] = useState(null);
  const [overlay, setOverlay] = useState(true);
  useEffect(() => { vic.frames(camera.id, 240, 1440).then(r => setFrames((r.frames || []).slice().reverse())); }, [camera.id]);

  return (
    <Modal onClose={onClose} title={`Frame Browser · ${camera.name}`} testid="frame-browser-modal" wide>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 relative aspect-video bg-black border border-subtle overflow-hidden">
          {sel ? (
            <>
              <img src={MEDIA(sel.frame_ref)} className="absolute inset-0 w-full h-full object-contain" alt="selected frame"/>
              {overlay && <YoloOverlay objects={sel.objects} faces={sel.faces} />}
            </>
          ) : <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs font-mono uppercase tracking-widest">select a thumbnail</div>}
        </div>
        <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
          <label className="text-[10px] font-mono uppercase tracking-widest text-slate-400 flex items-center gap-1">
            <input type="checkbox" checked={overlay} onChange={e=>setOverlay(e.target.checked)}/> YOLO overlay
          </label>
          {frames.length === 0 && <div className="text-slate-600 text-xs font-mono uppercase tracking-widest">no frames yet</div>}
          {frames.map(f => (
            <button key={f.id} className={`w-full text-left border ${sel?.id===f.id ? "border-tcyan" : "border-subtle"} bg-card hover:border-tcyan/50`} onClick={()=>setSel(f)} data-testid={`frame-thumb-${f.id}`}>
              <img src={MEDIA(f.frame_ref)} className="w-full aspect-video object-cover" alt="frame"/>
              <div className="px-1.5 py-1 text-[10px] font-mono text-slate-400">
                {new Date(f.detected_at).toLocaleTimeString()} · {f.objects?.length || 0} obj · {f.faces?.length || 0} face
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function AddCameraModal({ pack, onClose, onCreated }) {
  const [name, setName] = useState("New Camera");
  const [type, setType] = useState("file");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await vic.createCamera({ name, source: { type, uri }, pack });
      onCreated();
    } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} title="Register camera" testid="add-camera-modal">
      <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Name</label>
      <input className="input" value={name} onChange={e=>setName(e.target.value)} data-testid="new-camera-name" />
      <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Source type</label>
      <select className="input" value={type} onChange={e=>setType(e.target.value)} data-testid="new-camera-type">
        <option value="file">Uploaded file / mp4</option>
        <option value="rtsp">RTSP URL</option>
        <option value="webcam">Webcam device</option>
        <option value="sample">Sample loop</option>
      </select>
      <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">URI (optional)</label>
      <input className="input" placeholder={type === "rtsp" ? "rtsp://…" : "path or leave blank"} value={uri} onChange={e=>setUri(e.target.value)} data-testid="new-camera-uri" />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={create} disabled={busy} data-testid="submit-new-camera">{busy ? "…" : "Register"}</button>
      </div>
    </Modal>
  );
}

function UploadVideoModal({ camera, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [fps, setFps] = useState(1);
  const [maxFrames, setMaxFrames] = useState(40);
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState(null);

  const start = async () => {
    if (!file) return;
    setErr(null);
    try {
      const res = await vic.uploadVideo(camera.id, file, fps, maxFrames, (e) => {
        if (e.total) setProgress(Math.round((e.loaded/e.total)*100));
      });
      const jid = res.job_id;
      const poll = async () => {
        const j = await vic.job(jid);
        setJob(j);
        if (j.status === "done" || j.status === "error") { onDone(); return; }
        setTimeout(poll, 1200);
      };
      poll();
    } catch (e) { setErr(e.message); }
  };

  return (
    <Modal onClose={onClose} title={`Process video · ${camera.name}`} testid="upload-video-modal">
      <input type="file" accept="video/*" onChange={e=>setFile(e.target.files?.[0] || null)} className="input" data-testid="video-file-input" />
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Sample FPS</label>
          <input type="number" min={0.1} max={10} step={0.5} className="input" value={fps} onChange={e=>setFps(parseFloat(e.target.value)||1)} data-testid="sample-fps" />
        </div>
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Max frames</label>
          <input type="number" min={1} max={600} className="input" value={maxFrames} onChange={e=>setMaxFrames(parseInt(e.target.value)||40)} data-testid="max-frames" />
        </div>
      </div>
      {progress > 0 && progress < 100 && <div className="mt-3 text-xs font-mono text-slate-400">Uploading… {progress}%</div>}
      {job && (
        <div className="mt-3 border border-subtle bg-card/60 p-3 text-xs font-mono">
          <div className="flex justify-between text-slate-400"><span>Job</span><span className="text-tcyan">{job.status}</span></div>
          <div className="mt-2 w-full h-1 bg-black/40"><div className="h-1 bg-tcyan" style={{ width: `${(job.progress||0)*100}%` }} /></div>
          <div className="mt-1 text-slate-500">{job.frames_written || 0} frames processed</div>
          {job.error && <div className="text-tcrimson mt-1">{job.error}</div>}
        </div>
      )}
      {err && <div className="text-tcrimson text-xs mt-2">{err}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={start} disabled={!file} data-testid="start-processing-btn"><Play size={12}/> Start</button>
      </div>
    </Modal>
  );
}

function ZoneEditorModal({ camera, onClose, onSaved }) {
  const [poly, setPoly] = useState([]);
  const [zoneName, setZoneName] = useState("Zone 1");
  const [rule, setRule] = useState("presence");
  const [frame, setFrame] = useState(null);

  useEffect(() => {
    vic.ledger({ camera_id: camera.id, limit: 1 }).then(r => setFrame(r[0]?.frame_ref));
  }, [camera.id]);

  const onClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPoly([...poly, [x, y]]);
  };

  const save = async () => {
    const zones = [...(camera.zones || []), { id: Math.random().toString(36).slice(2), name: zoneName, polygon: poly, rule }];
    await vic.setZones(camera.id, zones);
    onSaved();
    onClose();
  };

  return (
    <Modal onClose={onClose} title={`Zone editor · ${camera.name}`} testid="zone-editor-modal" wide>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 relative bg-black border border-subtle aspect-video" onClick={onClick} data-testid="zone-editor-canvas">
          {frame ? <img src={MEDIA(frame)} className="absolute inset-0 w-full h-full object-contain" alt="" /> :
            <div className="absolute inset-0 grid-lines" />}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none">
            {(camera.zones || []).map((z, i) => (
              <polygon key={i} points={z.polygon.map(p => p.join(",")).join(" ")} fill="rgba(239,68,68,0.12)" stroke="#EF4444" strokeWidth={0.003} strokeDasharray="0.01 0.006" />
            ))}
            {poly.length > 0 && (
              <>
                <polygon points={poly.map(p => p.join(",")).join(" ")} fill="rgba(6,182,212,0.15)" stroke="#06B6D4" strokeWidth={0.003} strokeDasharray="0.01 0.006" />
                {poly.map(([x,y], i) => <circle key={i} cx={x} cy={y} r={0.008} fill="#06B6D4"/>)}
              </>
            )}
          </svg>
        </div>
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Zone name</label>
          <input className="input" value={zoneName} onChange={e=>setZoneName(e.target.value)} data-testid="zone-name" />
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Rule</label>
          <select className="input" value={rule} onChange={e=>setRule(e.target.value)} data-testid="zone-rule">
            <option value="presence">Presence</option>
            <option value="intrusion">Intrusion</option>
            <option value="loitering">Loitering</option>
            <option value="line_cross">Line crossing</option>
          </select>
          <div className="mt-4 text-[10px] font-mono uppercase tracking-widest text-slate-500">click canvas to place vertices ({poly.length})</div>
          <div className="mt-4 flex flex-col gap-2">
            <button className="btn" onClick={()=>setPoly([])} data-testid="clear-poly">Clear</button>
            <button className="btn btn-primary" onClick={save} disabled={poly.length < 3} data-testid="save-zone-btn">Save zone</button>
          </div>
          {(camera.zones || []).length > 0 && (
            <div className="mt-4 border-t border-subtle pt-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">saved zones</div>
              {(camera.zones || []).map((z,i) => (
                <div key={i} className="text-xs font-mono text-slate-300 flex justify-between">
                  <span>{z.name}</span><span className="text-slate-500">{z.rule} · {z.polygon.length} pts</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Modal({ children, onClose, title, testid, wide }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className={`panel ${wide ? "max-w-5xl" : "max-w-md"} w-full p-5 hud-corners`} onClick={e=>e.stopPropagation()} data-testid={testid}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-heading uppercase text-slate-100 font-semibold tracking-tight">{title}</div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200" data-testid="modal-close"><X size={16}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}
