import React, { useEffect, useMemo, useState } from "react";
import { Activity, Camera, ClipboardList, AlertTriangle, ScanFace, Target, Radar, Cpu, Layers, Home, Bot, SlidersHorizontal } from "lucide-react";
import { vic } from "./api";
import Overview from "./modules/Overview";
import Cameras from "./modules/Cameras";
import Ledger from "./modules/Ledger";
import Anomalies from "./modules/Anomalies";
import Rules from "./modules/Rules";
import Identities from "./modules/Identities";
import SubjectLock from "./modules/SubjectLock";
import Narratives from "./modules/Narratives";
import Assistant from "./modules/Assistant";

const NAV = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "cameras", label: "Camera Grid", icon: Camera },
  { id: "ledger", label: "Fact Ledger", icon: ClipboardList },
  { id: "anomalies", label: "Anomalies", icon: AlertTriangle },
  { id: "rules", label: "Anomaly Rules", icon: SlidersHorizontal },
  { id: "identities", label: "Identities", icon: ScanFace },
  { id: "lock", label: "Subject Lock", icon: Target },
  { id: "narratives", label: "Narratives", icon: Radar },
  { id: "assistant", label: "Ops Agent", icon: Bot },
];

export default function App() {
  const [tab, setTab] = useState("overview");
  const [metrics, setMetrics] = useState(null);
  const [pack, setPack] = useState("general");
  const [packs, setPacks] = useState({});
  const [cadence, setCadence] = useState("10m");

  useEffect(() => {
    vic.packs().then(setPacks).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => vic.metrics().then((m) => alive && setMetrics(m)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const shared = { pack, packs, cadence };

  return (
    <div className="min-h-screen font-body text-slate-100">
      <CommandBar
        pack={pack} setPack={setPack} packs={packs}
        cadence={cadence} setCadence={setCadence}
        metrics={metrics}
      />
      <div className="flex">
        <Sidebar tab={tab} setTab={setTab} />
        <main className="flex-1 p-4 sm:p-6 min-h-[calc(100vh-56px)]">
          {tab === "overview" && <Overview metrics={metrics} setTab={setTab} {...shared} />}
          {tab === "cameras" && <Cameras {...shared} />}
          {tab === "ledger" && <Ledger {...shared} />}
          {tab === "anomalies" && <Anomalies {...shared} />}
          {tab === "rules" && <Rules {...shared} />}
          {tab === "identities" && <Identities {...shared} />}
          {tab === "lock" && <SubjectLock {...shared} />}
          {tab === "narratives" && <Narratives {...shared} />}
          {tab === "assistant" && <Assistant {...shared} />}
        </main>
      </div>
    </div>
  );
}

function CommandBar({ pack, setPack, packs, cadence, setCadence, metrics }) {
  return (
    <header
      className="h-14 border-b border-subtle bg-panel/80 backdrop-blur-xl px-4 flex items-center gap-4 sticky top-0 z-30"
      data-testid="command-bar"
    >
      <div className="flex items-center gap-3">
        <div className="w-2.5 h-2.5 bg-tcyan rounded-full animate-pulseGlow" />
        <div>
          <div className="text-heading font-extrabold uppercase tracking-wide text-lg leading-none">
            V<span className="text-tcyan">I</span>C
          </div>
          <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">vision intelligence core</div>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-2 ml-4">
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Pack</span>
        <select
          value={pack}
          onChange={(e) => setPack(e.target.value)}
          className="bg-card border border-subtle text-xs font-mono text-slate-200 px-2 py-1.5 uppercase tracking-widest hover:border-tcyan/50 outline-none"
          data-testid="domain-pack-switcher"
        >
          {Object.entries(packs).map(([k, v]) => (
            <option key={k} value={k}>{v.name || k}</option>
          ))}
        </select>
      </div>
      <div className="hidden lg:flex items-center gap-1 ml-2">
        {["1m", "10m", "1h", "1d"].map((c) => (
          <button
            key={c}
            onClick={() => setCadence(c)}
            data-testid={`cadence-${c}`}
            className={`px-2 py-1 text-[10px] font-mono uppercase tracking-widest border ${
              cadence === c ? "border-tamber bg-tamber/10 text-tamber" : "border-subtle text-slate-400 hover:border-tcyan/50"
            }`}
          >{c}</button>
        ))}
      </div>
      <div className="flex-1" />
      <div className="hidden sm:flex items-center gap-3 text-[11px] font-mono text-slate-400">
        <Stat label="FPM" value={metrics?.fpm ?? "—"} color="text-tcyan" />
        <Stat label="ANOM" value={metrics?.open_anomalies ?? "—"} color="text-tcrimson" />
        <Stat label="CAM" value={`${metrics?.cameras?.online ?? 0}/${metrics?.cameras?.total ?? 0}`} color="text-temerald" />
        <Stat label="IDS" value={metrics?.identities_enrolled ?? "—"} color="text-tamber" />
      </div>
    </header>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 border border-subtle bg-card/60">
      <span className="text-slate-500 uppercase tracking-widest text-[9px]">{label}</span>
      <span className={`${color} font-bold`}>{value}</span>
    </div>
  );
}

function Sidebar({ tab, setTab }) {
  return (
    <aside className="w-14 md:w-56 border-r border-subtle bg-panel/70 min-h-[calc(100vh-56px)] py-4 sticky top-14 h-[calc(100vh-56px)]" data-testid="sidebar">
      <nav className="flex flex-col gap-1 px-2">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            data-testid={`nav-${id}`}
            className={`group flex items-center gap-3 px-3 py-2 text-xs font-mono uppercase tracking-widest border ${
              tab === id
                ? "border-tcyan/40 bg-tcyan/10 text-tcyan"
                : "border-transparent text-slate-400 hover:text-slate-100 hover:bg-card"
            }`}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span className="hidden md:inline">{label}</span>
          </button>
        ))}
        <div className="mt-8 hidden md:block px-3 text-[9px] font-mono uppercase text-slate-600 tracking-[0.25em]">
          Sys
        </div>
        <div className="hidden md:flex items-center gap-2 px-3 py-2 text-[10px] font-mono text-slate-500">
          <Cpu size={12} /> yolov8n · buffalo_s
        </div>
        <div className="hidden md:flex items-center gap-2 px-3 py-2 text-[10px] font-mono text-slate-500">
          <Layers size={12} /> CPU inference
        </div>
      </nav>
    </aside>
  );
}
