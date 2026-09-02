import React, { useEffect, useState } from "react";
import { vic, MEDIA } from "../api";
import { Filter, Pause, Play, FileJson, FileSpreadsheet } from "lucide-react";

export default function Ledger() {
  const [rows, setRows] = useState([]);
  const [cams, setCams] = useState([]);
  const [cam, setCam] = useState("");
  const [label, setLabel] = useState("");
  const [paused, setPaused] = useState(false);
  const [fs, setFs] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    const r = await vic.ledger({ camera_id: cam || undefined, label: label || undefined, limit: 60 });
    setRows(r);
    // fact-sheet always includes Subject Lock hits (per user ask)
    setFs(await vic.factsheetWithLocks(cam || null, 10));
  };

  useEffect(() => { vic.cameras().then(setCams); }, []);
  useEffect(() => {
    load();
    if (paused) return;
    const t = setInterval(load, 3500);
    return () => clearInterval(t);
  }, [cam, label, paused]);

  const params = { limit: 500 };
  if (cam) params.camera_id = cam;

  return (
    <div className="space-y-4" data-testid="ledger-panel">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Fact Ledger</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">append-only · {rows.length} rows in view</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={()=>setPaused(!paused)} className="btn" data-testid="ledger-pause">
            {paused ? <Play size={12}/> : <Pause size={12}/>} {paused ? "Resume" : "Pause"}
          </button>
          <a className="btn" href={vic.exportLedgerURL({ ...params, format: "json" })} data-testid="fact-ledger-export-json"><FileJson size={12}/> JSON</a>
          <a className="btn" href={vic.exportLedgerURL({ ...params, format: "csv" })} data-testid="fact-ledger-export-csv"><FileSpreadsheet size={12}/> CSV</a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Filter size={14} className="text-slate-500"/>
        <select className="input max-w-xs" value={cam} onChange={e=>setCam(e.target.value)} data-testid="ledger-filter-camera">
          <option value="">All cameras</option>
          {cams.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="input max-w-xs" placeholder="filter by class (e.g. person)" value={label} onChange={e=>setLabel(e.target.value)} data-testid="ledger-filter-label" />
      </div>

      {fs && (
        <div className="panel p-4 hud-corners" data-testid="factsheet-panel">
          <div className="flex items-center justify-between">
            <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight">Fact-sheet · last 10m</div>
            <div className="text-xs font-mono text-slate-500">{fs.frames_seen}/{fs.frames_expected || (fs.window?.minutes||10)*60} frames</div>
          </div>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {(fs.detections_per_class || []).map(d => (
              <div key={d.label} className="card p-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{d.label}</div>
                <div className="text-heading text-xl font-bold text-tcyan">{d.detections}</div>
                <div className="text-[10px] font-mono text-slate-500">avg conf {Math.round((d.avg_conf||0)*100)}%</div>
              </div>
            ))}
            {(fs.detections_per_class || []).length === 0 && <div className="text-slate-600 text-xs col-span-full font-mono uppercase tracking-widest">no detections in window</div>}
          </div>

          {fs.subject_locks?.length > 0 && (
            <div className="mt-4 border-t border-subtle pt-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-2">active subject locks · hits in window</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" data-testid="factsheet-locks">
                {fs.subject_locks.map(l => (
                  <div key={l.lock_id} className={`card p-2 border ${l.hits_in_window > 0 ? "border-tamber/40" : "border-subtle"}`}>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{l.kind}</div>
                    <div className="text-sm font-mono text-slate-100 truncate">{l.label || l.target}</div>
                    <div className={`text-heading text-lg font-bold ${l.hits_in_window > 0 ? "text-tamber" : "text-slate-600"}`}>{l.hits_in_window} hits</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <table className="w-full text-xs" data-testid="ledger-table">
          <thead className="text-[10px] font-mono uppercase tracking-widest text-slate-500 border-b border-subtle">
            <tr>
              <th className="text-left p-2">Time</th>
              <th className="text-left p-2">Camera</th>
              <th className="text-left p-2">Frame</th>
              <th className="text-left p-2">Detections</th>
              <th className="text-left p-2">Faces</th>
              <th className="text-left p-2"></th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map(r => (
              <React.Fragment key={r.id}>
                <tr className="border-b border-subtle hover:bg-card" data-testid={`ledger-row-${r.id}`}>
                  <td className="p-2 text-slate-300 whitespace-nowrap">{new Date(r.detected_at).toLocaleTimeString()}</td>
                  <td className="p-2 text-slate-400">{cams.find(c=>c.id===r.camera_id)?.name || r.camera_id.slice(0,8)}</td>
                  <td className="p-2">{r.frame_ref ? <img src={MEDIA(r.frame_ref)} className="w-16 h-10 object-cover border border-subtle" alt=""/> : "—"}</td>
                  <td className="p-2 text-slate-300">
                    {(r.objects || []).slice(0,4).map((o,i) => (
                      <span key={i} className="badge border-tcyan/30 text-cyan-300 mr-1">{o.label} {Math.round(o.confidence*100)}%</span>
                    ))}
                    {(r.objects||[]).length > 4 && <span className="text-slate-500">+{r.objects.length-4}</span>}
                  </td>
                  <td className="p-2 text-slate-300">
                    {(r.faces || []).map((f,i) => (
                      <span key={i} className={`badge mr-1 ${f.match ? "border-tamber/40 text-tamber" : "border-tcrimson/40 text-tcrimson"}`}>
                        {f.match ? `${f.match.name}` : "unknown"}
                      </span>
                    ))}
                  </td>
                  <td className="p-2 text-right">
                    <button className="text-tcyan text-[10px] uppercase tracking-widest" onClick={()=>setExpanded(expanded===r.id?null:r.id)}>{expanded===r.id ? "collapse" : "raw"}</button>
                  </td>
                </tr>
                {expanded===r.id && (
                  <tr>
                    <td colSpan={6} className="bg-black/40 p-2">
                      <pre className="text-[10px] text-slate-400 overflow-x-auto">{JSON.stringify(r, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-600 font-mono uppercase tracking-widest text-xs">no rows · upload a video on a camera</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
