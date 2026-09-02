import React, { useEffect, useState } from "react";
import { vic, MEDIA } from "../api";
import { Activity, Play, Zap, TrendingUp, Users, Camera as CameraIcon } from "lucide-react";

export default function Overview({ metrics, setTab, cadence }) {
  const [recent, setRecent] = useState([]);
  const [cams, setCams] = useState([]);
  const [anoms, setAnoms] = useState([]);
  const [narrative, setNarrative] = useState(null);
  const [narrLoading, setNarrLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [l, c, a] = await Promise.all([
        vic.ledger({ limit: 6 }).catch(() => []),
        vic.cameras().catch(() => []),
        vic.anomalies({ status: "open", limit: 5 }).catch(() => []),
      ]);
      setRecent(l); setCams(c); setAnoms(a);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const genNarrative = async () => {
    setNarrLoading(true);
    try { setNarrative(await vic.narrative({ cadence })); }
    finally { setNarrLoading(false); }
  };

  return (
    <div className="space-y-6" data-testid="overview-panel">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Command Overview</h2>
          <p className="text-slate-500 text-xs font-mono uppercase tracking-widest">operator situational awareness · window: {cadence}</p>
        </div>
        <button className="btn btn-primary" onClick={genNarrative} disabled={narrLoading} data-testid="generate-narrative-btn">
          <Zap size={14} /> {narrLoading ? "Generating…" : "AI Briefing"}
        </button>
      </div>

      <div className="panel p-4 hud-corners" data-testid="core-engine-banner">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 border border-tcyan/40 bg-tcyan/10 flex items-center justify-center text-tcyan">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2 L2 7 L12 12 L22 7 Z"/><path d="M2 17 L12 22 L22 17"/><path d="M2 12 L12 17 L22 12"/></svg>
          </div>
          <div className="flex-1">
            <div className="text-heading uppercase text-slate-100 font-semibold tracking-tight">VIC · domain-agnostic vision core engine</div>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Everything downstream is <span className="text-tcyan">config-driven</span>: define your own anomaly rules, plug any vocabulary, activate a Subject Lock, and let the Ops Agent read the ledger + take actions on your behalf. The LLM only processes data you ask it to — never on its own.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="badge border-subtle text-slate-400">YOLOv8n + ByteTrack</span>
              <span className="badge border-subtle text-slate-400">InsightFace</span>
              <span className="badge border-subtle text-slate-400">Rule Studio</span>
              <span className="badge border-subtle text-slate-400">Subject Lock</span>
              <span className="badge border-subtle text-slate-400">Tool-using Ops Agent</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Tile label="Frames / min" value={metrics?.fpm} icon={Activity} accent="text-tcyan" />
        <Tile label="Events 10m" value={metrics?.events_10m} icon={TrendingUp} accent="text-tcyan" />
        <Tile label="Open anomalies" value={metrics?.open_anomalies} icon={Zap} accent="text-tcrimson" />
        <Tile label="Cameras online" value={`${metrics?.cameras?.online ?? 0}/${metrics?.cameras?.total ?? 0}`} icon={CameraIcon} accent="text-temerald" />
        <Tile label="Identities" value={metrics?.identities_enrolled} icon={Users} accent="text-tamber" />
        <Tile label="Matches 10m" value={metrics?.matches_10m} icon={Play} accent="text-tamber" />
      </div>

      {narrative && (
        <div className="panel hud-corners p-5" data-testid="ai-briefing">
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-tcyan mb-2">
            <Radar /> AI Briefing · {narrative.cadence || cadence} · <span className="text-slate-500">{new Date(narrative.generated_at || Date.now()).toLocaleTimeString()}</span>
          </div>
          <p className="text-sm text-slate-200 leading-relaxed">{narrative.narrative}</p>
          <div className="mt-3 text-[10px] font-mono text-slate-500">
            grounded on {narrative.facts?.frames_seen ?? 0} frames · {narrative.facts?.detections_per_class?.length ?? 0} classes
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="panel p-4">
          <SectionHeader title="Recent detections" onClick={() => setTab("ledger")} action="Ledger →" />
          <ul className="space-y-2 mt-3">
            {recent.length === 0 && <Empty label="no events yet — upload a video on a camera" />}
            {recent.map((r) => (
              <li key={r.id} className="flex items-center gap-3 text-xs">
                {r.frame_ref ? <img src={MEDIA(r.frame_ref)} className="w-16 h-10 object-cover border border-subtle" alt="" /> : <div className="w-16 h-10 bg-black/40" />}
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-slate-300 truncate">{r.objects?.map(o => o.label).slice(0,4).join(", ") || "—"}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{new Date(r.detected_at).toLocaleTimeString()}</div>
                </div>
                {r.faces?.some(f => f.match) && <span className="badge border-tamber/40 text-tamber">Match</span>}
              </li>
            ))}
          </ul>
        </div>

        <div className="panel p-4">
          <SectionHeader title="Camera health" onClick={() => setTab("cameras")} action="Grid →" />
          <ul className="space-y-1.5 mt-3">
            {cams.length === 0 && <Empty label="no cameras yet — add or seed sample" />}
            {cams.slice(0,6).map(c => (
              <li key={c.id} className="flex items-center gap-2 text-xs font-mono">
                <span className={`w-1.5 h-1.5 rounded-full ${c.status === "online" ? "bg-temerald" : "bg-slate-600"}`} />
                <span className="flex-1 truncate text-slate-300">{c.name}</span>
                <span className="text-slate-500">{c.frames_seen} f</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel p-4">
          <SectionHeader title="Open anomalies" onClick={() => setTab("anomalies")} action="Triage →" />
          <ul className="space-y-2 mt-3">
            {anoms.length === 0 && <Empty label="no open anomalies — nominal" />}
            {anoms.map(a => (
              <li key={a.id} className="border border-subtle bg-card p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`badge ${a.severity === "critical" ? "border-tcrimson/40 text-tcrimson" : a.severity === "warning" ? "border-tamber/40 text-tamber" : "border-tcyan/40 text-tcyan"}`}>{a.type}</span>
                  <span className="text-slate-500 font-mono text-[10px]">{new Date(a.opened_at).toLocaleTimeString()}</span>
                </div>
                <div className="text-slate-300 mt-1">{a.note}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, icon: Icon, accent }) {
  return (
    <div className="card p-3 hud-corners">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-slate-500">
        <Icon size={12} /> {label}
      </div>
      <div className={`mt-1 text-heading text-2xl font-bold ${accent}`}>{value ?? "—"}</div>
    </div>
  );
}

function SectionHeader({ title, onClick, action }) {
  return (
    <div className="flex items-center justify-between border-b border-subtle pb-2">
      <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight">{title}</div>
      <button className="text-[10px] font-mono uppercase tracking-widest text-tcyan hover:text-cyan-300" onClick={onClick}>{action}</button>
    </div>
  );
}

function Empty({ label }) {
  return <li className="text-[11px] font-mono text-slate-600 uppercase tracking-widest py-2">— {label}</li>;
}

function Radar() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 12 L22 12"/><path d="M12 12 L12 2"/></svg>;
}
