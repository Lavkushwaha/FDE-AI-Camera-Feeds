import React, { useEffect, useState } from "react";
import { vic } from "../api";
import { Sparkles, RefreshCw } from "lucide-react";

export default function Narratives({ cadence }) {
  const [rows, setRows] = useState([]);
  const [cams, setCams] = useState([]);
  const [cam, setCam] = useState("");
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(null);

  const load = () => vic.narratives().then(setRows);
  useEffect(() => { vic.cameras().then(setCams); load(); }, []);

  const gen = async () => {
    setBusy(true);
    try {
      const n = await vic.narrative({ camera_id: cam || null, cadence });
      setCurrent(n);
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="narratives-panel">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Grounded LLM Briefings</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">facts-only prompts · gpt-5.4 via emergent</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input max-w-xs" value={cam} onChange={e=>setCam(e.target.value)} data-testid="narrative-camera">
            <option value="">Site-wide (all cameras)</option>
            {cams.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="flex items-center gap-1 px-2 py-1 border border-subtle bg-card">
            <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Window</span>
            <span className="text-xs font-mono text-tamber">{cadence}</span>
          </div>
          <button className="btn btn-primary" onClick={gen} disabled={busy} data-testid="generate-briefing-btn">
            <Sparkles size={14}/> {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>

      {current && <NarrativeCard n={current} highlighted />}

      <div className="panel p-4">
        <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Recent briefings</div>
        <div className="mt-3 space-y-3" data-testid="narratives-history">
          {rows.length === 0 && <div className="text-slate-500 font-mono uppercase tracking-widest text-xs">no briefings yet</div>}
          {rows.map(n => <NarrativeCard key={n.id} n={n}/>)}
        </div>
      </div>
    </div>
  );
}

function NarrativeCard({ n, highlighted }) {
  return (
    <div className={`card p-4 ${highlighted ? "border-tamber/40 animate-pulseGlow" : ""}`} data-testid={`narrative-${n.id}`}>
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-tcyan">
        <Sparkles size={12}/> {n.cadence} briefing · <span className="text-slate-500">{new Date(n.generated_at).toLocaleString()}</span>
        {n.model && <span className="ml-auto text-slate-500">{n.model}</span>}
      </div>
      <p className="mt-2 text-sm text-slate-100 leading-relaxed">{n.narrative}</p>
      <details className="mt-3 text-[10px] font-mono">
        <summary className="text-slate-500 cursor-pointer uppercase tracking-widest">grounding facts</summary>
        <pre className="mt-2 text-slate-400 overflow-x-auto">{JSON.stringify(n.facts, null, 2)}</pre>
      </details>
    </div>
  );
}
