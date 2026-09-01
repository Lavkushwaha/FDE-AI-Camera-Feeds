import React, { useEffect, useState } from "react";
import { vic, MEDIA } from "../api";
import { Target, X, ScanSearch } from "lucide-react";

export default function SubjectLock() {
  const [locks, setLocks] = useState([]);
  const [identities, setIdentities] = useState([]);
  const [kind, setKind] = useState("face");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [active, setActive] = useState(null);
  const [sweep, setSweep] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLocks(await vic.locks());
    setIdentities(await vic.identities());
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const l = await vic.createLock({ kind, target, label });
      setActive(l);
      const s = await vic.sweep(l.id, 1440);
      setSweep(s);
      load();
    } finally { setBusy(false); }
  };

  const openLock = async (l) => {
    setActive(l);
    setBusy(true);
    try { setSweep(await vic.sweep(l.id, 1440)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="subject-lock-panel">
      <div>
        <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Subject Lock · Investigation Mode</h2>
        <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">lock a target · sweep the ledger · follow it everywhere</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4 space-y-4">
          <div className="panel p-4 hud-corners">
            <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Lock target</div>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Kind</label>
            <select className="input" value={kind} onChange={e=>{setKind(e.target.value); setTarget("");}} data-testid="lock-kind">
              <option value="face">Face identity</option>
              <option value="class">Object class</option>
              <option value="plate">Plate text (traffic)</option>
            </select>
            {kind === "face" ? (
              <>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Identity</label>
                <select className="input" value={target} onChange={e=>setTarget(e.target.value)} data-testid="lock-target-identity">
                  <option value="">Select…</option>
                  {identities.map(i => <option key={i.id} value={i.id}>{i.name} · {i.category}</option>)}
                </select>
              </>
            ) : (
              <>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">
                  {kind === "class" ? "COCO class label (e.g. car)" : "Plate text"}
                </label>
                <input className="input" value={target} onChange={e=>setTarget(e.target.value)} data-testid="lock-target-text"/>
              </>
            )}
            <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Label (optional)</label>
            <input className="input" value={label} onChange={e=>setLabel(e.target.value)}/>
            <button className="btn btn-primary w-full mt-4" onClick={create} disabled={busy || !target} data-testid="subject-lock-trigger">
              <Target size={14}/> {busy ? "Sweeping…" : "Lock & Sweep"}
            </button>
          </div>

          <div className="panel p-4">
            <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Active locks</div>
            <ul className="mt-3 space-y-2">
              {locks.length === 0 && <li className="text-[11px] font-mono uppercase tracking-widest text-slate-600">no locks</li>}
              {locks.map(l => (
                <li key={l.id} className="flex items-center gap-2 border border-subtle p-2 bg-card">
                  <button className="flex-1 text-left" onClick={()=>openLock(l)} data-testid={`open-lock-${l.id}`}>
                    <div className="text-xs font-mono text-slate-200">{l.label || l.target}</div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{l.kind} · {l.status}</div>
                  </button>
                  <button className="btn btn-danger" onClick={async()=>{ await vic.closeLock(l.id); load(); if(active?.id===l.id){setActive(null); setSweep(null);}}} data-testid={`close-lock-${l.id}`}><X size={12}/></button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-8">
          {!active ? (
            <div className="panel p-10 text-center text-slate-500 font-mono uppercase tracking-widest text-xs h-full flex items-center justify-center">
              <div>
                <ScanSearch size={28} className="mx-auto text-slate-700"/>
                lock a subject to reconstruct its cross-camera journey
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="panel p-4 hud-corners">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-heading uppercase text-slate-100 font-semibold tracking-tight">{active.label || active.target}</div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{active.kind} · locked {new Date(active.created_at).toLocaleTimeString()}</div>
                  </div>
                  <span className="badge border-tamber/40 text-tamber animate-pulseGlow">Locked</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <StatBig label="Sightings" value={sweep?.count ?? 0}/>
                  <StatBig label="Cameras" value={sweep?.journey?.length ?? 0}/>
                  <StatBig label="Window" value="24h"/>
                </div>
              </div>

              {sweep?.journey?.length > 0 && (
                <div className="panel p-4">
                  <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Cross-camera journey</div>
                  <div className="mt-4 relative overflow-x-auto">
                    <div className="flex items-center gap-3 min-w-max">
                      {sweep.journey.map((j, i) => (
                        <React.Fragment key={j.camera_id}>
                          <div className="card p-3 min-w-[180px]">
                            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">cam {i+1}</div>
                            <div className="text-heading text-sm text-slate-100 truncate">{j.camera_id.slice(0,12)}…</div>
                            <div className="text-[10px] font-mono text-slate-500">{new Date(j.first).toLocaleTimeString()} → {new Date(j.last).toLocaleTimeString()}</div>
                            <div className="text-[10px] font-mono text-tamber mt-1">{j.count} sightings</div>
                          </div>
                          {i < sweep.journey.length - 1 && <div className="text-tcyan text-xl">→</div>}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {sweep?.sightings?.length > 0 && (
                <div className="panel p-4">
                  <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Evidence timeline</div>
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2" data-testid="sweep-evidence">
                    {sweep.sightings.slice(0,20).map((s,i) => (
                      <div key={i} className="border border-subtle bg-card">
                        {s.frame_ref && <img src={MEDIA(s.frame_ref)} className="w-full aspect-video object-cover" alt=""/>}
                        <div className="p-1.5">
                          <div className="text-[10px] font-mono text-slate-400">{new Date(s.detected_at).toLocaleTimeString()}</div>
                          <div className="text-[10px] font-mono text-tamber">{s.type} {s.similarity && `${Math.round(s.similarity*100)}%`}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sweep && sweep.count === 0 && (
                <div className="panel p-8 text-center text-slate-500 text-xs font-mono uppercase tracking-widest">
                  no sightings in the ledger — process video/matches first
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatBig({ label, value }) {
  return (
    <div className="card p-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-heading text-2xl font-bold text-tcyan">{value}</div>
    </div>
  );
}
