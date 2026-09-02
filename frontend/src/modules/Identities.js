import React, { useEffect, useRef, useState } from "react";
import { vic, MEDIA } from "../api";
import { UserPlus, Trash2, ScanFace } from "lucide-react";
import { Modal } from "./Cameras";

export default function Identities() {
  const [rows, setRows] = useState([]);
  const [matches, setMatches] = useState([]);
  const [show, setShow] = useState(false);

  const load = async () => {
    setRows(await vic.identities());
    setMatches(await vic.matches({ limit: 30 }));
  };
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, []);

  return (
    <div className="space-y-4" data-testid="identities-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Face Identity & Watchlist</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">{rows.length} enrolled · {matches.length} match events</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setShow(true)} data-testid="enroll-face-btn"><UserPlus size={14}/> Enroll face</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 panel p-4">
          <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Registered identities</div>
          {rows.length === 0 ? (
            <div className="text-slate-500 font-mono uppercase tracking-widest text-xs mt-4">no identities yet — enroll to enable face matching</div>
          ) : (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="identity-list">
              {rows.map(i => (
                <div key={i.id} className="card p-3 hud-corners" data-testid={`identity-${i.id}`}>
                  <div className="aspect-square bg-black border border-subtle overflow-hidden">
                    {i.photo && <img src={MEDIA(i.photo)} className="w-full h-full object-cover" alt=""/>}
                  </div>
                  <div className="mt-2 text-heading font-semibold text-slate-100 truncate">{i.name}</div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{i.category} · {i.priority}</div>
                  <button className="btn btn-danger w-full mt-2" onClick={async()=>{ await vic.deleteIdentity(i.id); load(); }} data-testid={`delete-identity-${i.id}`}>
                    <Trash2 size={12}/> Deregister
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel p-4">
          <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2 flex items-center gap-2">
            <ScanFace size={14}/> Live match feed
          </div>
          <ul className="mt-3 space-y-2 max-h-[70vh] overflow-y-auto pr-1" data-testid="match-feed">
            {matches.length === 0 && <li className="text-[11px] font-mono uppercase tracking-widest text-slate-600">no matches yet</li>}
            {matches.map(m => (
              <li key={m.id} className="flex items-center gap-3 border border-subtle bg-card p-2">
                {m.frame_ref && <img src={MEDIA(m.frame_ref)} className="w-16 h-10 object-cover border border-subtle" alt=""/>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-100 font-mono truncate">{m.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{new Date(m.detected_at).toLocaleTimeString()} · sim {Math.round(m.similarity*100)}%</div>
                </div>
                <span className="badge border-tamber/40 text-tamber">{m.category}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {show && <EnrollModal onClose={()=>setShow(false)} onDone={()=>{ setShow(false); load(); }} />}
    </div>
  );
}

function EnrollModal({ onClose, onDone }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("watchlist");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const onFile = (f) => {
    setFile(f);
    if (f) setPreview(URL.createObjectURL(f));
  };

  const submit = async () => {
    if (!file || !name) return;
    setBusy(true); setErr(null);
    try { await vic.enrollFace(file, name, category, priority, notes); onDone(); }
    catch (e) { setErr(e.response?.data?.detail || e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title="Enroll face" testid="enroll-modal">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Photo</label>
          <input type="file" accept="image/*" onChange={e=>onFile(e.target.files?.[0])} className="input" data-testid="enroll-file"/>
          {preview && <img src={preview} className="mt-2 w-full aspect-square object-cover border border-subtle" alt=""/>}
        </div>
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Name</label>
          <input className="input" value={name} onChange={e=>setName(e.target.value)} data-testid="enroll-name"/>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Category</label>
          <select className="input" value={category} onChange={e=>setCategory(e.target.value)} data-testid="enroll-category">
            {["watchlist","staff","student","customer","vip","blacklist","banned","stolen","permit"].map(c=><option key={c}>{c}</option>)}
          </select>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Priority</label>
          <select className="input" value={priority} onChange={e=>setPriority(e.target.value)} data-testid="enroll-priority">
            {["low","normal","high","critical"].map(c=><option key={c}>{c}</option>)}
          </select>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Notes</label>
          <input className="input" value={notes} onChange={e=>setNotes(e.target.value)} data-testid="enroll-notes"/>
        </div>
      </div>
      {err && <div className="text-tcrimson text-xs mt-3">{err}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !file || !name} data-testid="enroll-face-submit-button">{busy ? "…" : "Enroll"}</button>
      </div>
    </Modal>
  );
}
