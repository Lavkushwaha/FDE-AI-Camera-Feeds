import React, { useEffect, useState } from "react";
import { vic } from "../api";
import { CheckCircle2, ScanLine, ShieldAlert } from "lucide-react";

export default function Anomalies() {
  const [rows, setRows] = useState([]);
  const [cams, setCams] = useState([]);
  const [cam, setCam] = useState("");
  const [status, setStatus] = useState("");

  const load = () => vic.anomalies({ camera_id: cam || undefined, status: status || undefined }).then(setRows);
  useEffect(() => { vic.cameras().then(setCams); }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [cam, status]);

  const scan = async () => {
    if (!cam) { alert("Select a camera to scan"); return; }
    await vic.scanAnomalies(cam, 10);
    load();
  };

  return (
    <div className="space-y-4" data-testid="anomalies-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Anomaly Feed</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">rules detect · operators triage</p>
        </div>
        <button className="btn btn-primary" onClick={scan} data-testid="scan-anomalies-btn"><ScanLine size={14}/> Scan now</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className="input max-w-xs" value={cam} onChange={e=>setCam(e.target.value)} data-testid="anomaly-filter-camera">
          <option value="">All cameras</option>
          {cams.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="input max-w-xs" value={status} onChange={e=>setStatus(e.target.value)} data-testid="anomaly-filter-status">
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="anomaly-list">
        {rows.map(a => (
          <div key={a.id} className={`card p-4 ${a.severity==="critical" ? "border-tcrimson/40" : a.severity==="warning" ? "border-tamber/40" : ""}`} data-testid={`anomaly-${a.id}`}>
            <div className="flex items-center gap-2">
              <ShieldAlert size={14} className={a.severity==="critical" ? "text-tcrimson" : a.severity==="warning" ? "text-tamber" : "text-tcyan"} />
              <span className={`badge ${a.severity==="critical" ? "border-tcrimson/40 text-tcrimson" : a.severity==="warning" ? "border-tamber/40 text-tamber" : "border-tcyan/40 text-tcyan"}`}>{a.type}</span>
              <span className={`badge ${a.status==="open" ? "border-tcyan/40 text-tcyan" : a.status==="acknowledged" ? "border-tamber/40 text-tamber" : "border-slate-600 text-slate-500"}`}>{a.status}</span>
              <span className="text-slate-500 font-mono text-[10px] ml-auto">{new Date(a.opened_at).toLocaleString()}</span>
            </div>
            <div className="mt-2 text-sm text-slate-200">{a.note}</div>
            <div className="mt-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest">
              cam {a.camera_id.slice(0,8)} · facts {Object.entries(a.facts||{}).map(([k,v])=>`${k}=${v}`).join(" · ")}
            </div>
            {a.status === "open" && (
              <div className="mt-3 flex gap-2">
                <button className="btn flex-1" onClick={async()=>{ await vic.ack(a.id); load(); }} data-testid={`anomaly-ack-${a.id}`}><CheckCircle2 size={12}/> Ack</button>
                <button className="btn btn-primary flex-1" onClick={async()=>{ await vic.resolve(a.id); load(); }} data-testid={`anomaly-resolve-${a.id}`}>Resolve</button>
              </div>
            )}
            {a.status === "acknowledged" && (
              <button className="btn btn-primary w-full mt-3" onClick={async()=>{ await vic.resolve(a.id); load(); }} data-testid={`anomaly-resolve-${a.id}`}>Resolve</button>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <div className="col-span-full panel p-8 text-center text-slate-500 font-mono uppercase tracking-widest text-xs">
            no anomalies — run a scan after uploading frames
          </div>
        )}
      </div>
    </div>
  );
}
