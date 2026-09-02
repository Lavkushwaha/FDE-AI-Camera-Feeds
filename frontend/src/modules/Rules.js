import React, { useEffect, useState } from "react";
import { vic } from "../api";
import { Plus, Trash2, Play, Power, PowerOff, Save, Sliders } from "lucide-react";
import { Modal } from "./Cameras";

const RULE_TYPES = [
  { value: "capture_gap",     label: "Capture Gap", hint: "Camera captured fewer frames than expected", fields: ["minutes", "min_frames_ratio"] },
  { value: "class_threshold", label: "Class Count Threshold", hint: "Fire when class count crosses a min/max", fields: ["label", "min_count", "max_count", "minutes"] },
  { value: "class_spike",     label: "Class Spike vs Baseline", hint: "Fire when curr >= baseline*ratio", fields: ["label", "spike_ratio", "spike_min_baseline", "minutes", "baseline_minutes"] },
  { value: "class_absence",   label: "Class Absence / Drought", hint: "Class present in baseline but gone now", fields: ["spike_min_baseline", "minutes", "baseline_minutes"] },
  { value: "class_new",       label: "New Class Sighting", hint: "Class never seen on this camera before", fields: ["minutes"] },
  { value: "face_match",      label: "Watchlist Face Match", hint: "Fire when a known identity is seen", fields: ["identity_id", "min_similarity", "minutes"] },
];

const FIELD_META = {
  label:              { type: "text",   help: "COCO class (person, car, backpack, bottle, ...)" },
  minutes:            { type: "number", default: 10, help: "current window (min)" },
  baseline_minutes:   { type: "number", default: 10, help: "prior baseline window (min)" },
  min_count:          { type: "number", help: "fire if >= this many detections" },
  max_count:          { type: "number", help: "fire if <= this many detections" },
  spike_ratio:        { type: "number", default: 3, help: "current >= baseline × ratio" },
  spike_min_baseline: { type: "number", default: 5, help: "min baseline to avoid noise" },
  min_frames_ratio:   { type: "number", default: 0.5, help: "fire when frames < expected × ratio" },
  identity_id:        { type: "text",   help: "identity UUID (blank = any)" },
  min_similarity:     { type: "number", default: 0.45, help: "0..1 (buffalo_s: ~0.42 is a match)" },
};

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [cams, setCams] = useState([]);
  const [editor, setEditor] = useState(null); // null | rule object

  const load = async () => setRules(await vic.rules());
  useEffect(() => { load(); vic.cameras().then(setCams); }, []);

  return (
    <div className="space-y-4" data-testid="rules-panel">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading text-2xl font-bold uppercase tracking-tight">Anomaly Rule Studio</h2>
          <p className="text-xs text-slate-500 font-mono uppercase tracking-widest">the core engine is domain-agnostic — YOU define what "anomaly" means for your system</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setEditor({new: true, type:"class_spike", severity:"critical", enabled:true, name:"", description:"", predicate:{minutes:10}, scope:{all:true}})} data-testid="new-rule-btn">
          <Plus size={14}/> New rule
        </button>
      </div>

      <div className="panel p-4">
        <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Rule library</div>
        {rules.length === 0 && <div className="text-slate-500 font-mono text-xs uppercase tracking-widest py-6">no rules yet</div>}
        <ul className="mt-3 divide-y divide-subtle" data-testid="rule-list">
          {rules.map(r => (
            <li key={r.id} className="py-3 flex items-center gap-3" data-testid={`rule-${r.id}`}>
              <button
                className={`w-8 h-8 flex items-center justify-center border ${r.enabled ? "border-temerald/40 text-temerald" : "border-subtle text-slate-500"}`}
                onClick={async()=>{ await vic.toggleRule(r.id); load(); }}
                data-testid={`rule-toggle-${r.id}`}
                title={r.enabled ? "Disable" : "Enable"}
              >
                {r.enabled ? <Power size={14}/> : <PowerOff size={14}/>}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-heading font-semibold text-slate-100">{r.name}</span>
                  <span className={`badge ${r.severity==="critical"?"border-tcrimson/40 text-tcrimson":r.severity==="warning"?"border-tamber/40 text-tamber":"border-tcyan/40 text-tcyan"}`}>{r.severity}</span>
                  <span className="badge border-subtle text-slate-400">{r.type}</span>
                  {r.system_default && <span className="badge border-subtle text-slate-500">default</span>}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-1">{r.description || "—"}</div>
                <div className="text-[10px] font-mono text-slate-600 mt-1">{JSON.stringify(r.predicate)}</div>
              </div>
              <button className="btn" onClick={()=>setEditor({...r})} data-testid={`rule-edit-${r.id}`}><Sliders size={12}/> Edit</button>
              <button className="btn btn-danger" onClick={async()=>{ if(window.confirm("Delete rule?")){ await vic.deleteRule(r.id); load(); }}} data-testid={`rule-delete-${r.id}`}><Trash2 size={12}/></button>
            </li>
          ))}
        </ul>
      </div>

      {editor && <RuleEditor rule={editor} cameras={cams} onClose={()=>setEditor(null)} onSaved={()=>{ setEditor(null); load(); }} />}
    </div>
  );
}

function RuleEditor({ rule, cameras, onClose, onSaved }) {
  const [r, setR] = useState({
    name: rule.name || "",
    description: rule.description || "",
    type: rule.type || "class_spike",
    severity: rule.severity || "warning",
    enabled: rule.enabled ?? true,
    predicate: rule.predicate || {},
    scope: rule.scope || { all: true },
  });
  const [previewCam, setPreviewCam] = useState(cameras[0]?.id || "");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const typeMeta = RULE_TYPES.find(t => t.value === r.type);

  const setPred = (k, v) => setR({...r, predicate: {...r.predicate, [k]: v}});

  const save = async () => {
    setBusy(true);
    try {
      if (rule.new) await vic.createRule(r);
      else await vic.updateRule(rule.id, r);
      onSaved();
    } finally { setBusy(false); }
  };

  const testDry = async () => {
    if (!previewCam) return;
    if (rule.new) { alert("Save the rule first, then dry-run it."); return; }
    setBusy(true);
    try { setPreview(await vic.testRule(rule.id, previewCam)); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} title={rule.new ? "New anomaly rule" : `Edit · ${rule.name}`} testid="rule-editor" wide>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">Name</label>
          <input className="input" value={r.name} onChange={e=>setR({...r, name: e.target.value})} data-testid="rule-name"/>

          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Description</label>
          <input className="input" value={r.description} onChange={e=>setR({...r, description: e.target.value})} data-testid="rule-desc"/>

          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Type</label>
          <select className="input" value={r.type} onChange={e=>setR({...r, type: e.target.value, predicate: {minutes: 10}})} data-testid="rule-type">
            {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <div className="text-[10px] font-mono text-slate-500 mt-1">{typeMeta?.hint}</div>

          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Severity</label>
          <select className="input" value={r.severity} onChange={e=>setR({...r, severity: e.target.value})} data-testid="rule-severity">
            <option>info</option><option>warning</option><option>critical</option>
          </select>

          <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1 mt-3">Scope</label>
          <select className="input" value={r.scope.all ? "all" : "specific"} onChange={e => setR({...r, scope: e.target.value === "all" ? {all: true} : {camera_ids: []}})}>
            <option value="all">All cameras</option>
            <option value="specific">Specific cameras</option>
          </select>
          {!r.scope.all && (
            <div className="mt-2 border border-subtle bg-card p-2 max-h-40 overflow-y-auto">
              {cameras.map(c => (
                <label key={c.id} className="flex items-center gap-2 text-xs text-slate-300 font-mono py-1">
                  <input type="checkbox" checked={(r.scope.camera_ids||[]).includes(c.id)}
                    onChange={e => {
                      const set = new Set(r.scope.camera_ids || []);
                      if (e.target.checked) set.add(c.id); else set.delete(c.id);
                      setR({...r, scope: {camera_ids: [...set]}});
                    }} />
                  {c.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Predicate</div>
          <div className="grid grid-cols-2 gap-3 mt-3" data-testid="rule-predicate">
            {(typeMeta?.fields || []).map(f => (
              <div key={f}>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1">{f}</label>
                <input
                  className="input"
                  type={FIELD_META[f]?.type || "text"}
                  step={FIELD_META[f]?.type === "number" ? "any" : undefined}
                  value={r.predicate[f] ?? ""}
                  onChange={e => setPred(f, FIELD_META[f]?.type === "number" ? (e.target.value === "" ? undefined : parseFloat(e.target.value)) : e.target.value)}
                  data-testid={`predicate-${f}`}
                />
                <div className="text-[9px] font-mono text-slate-600 mt-1">{FIELD_META[f]?.help}</div>
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-subtle pt-3">
            <div className="flex items-center gap-2">
              <select className="input flex-1" value={previewCam} onChange={e=>setPreviewCam(e.target.value)} data-testid="rule-preview-camera">
                <option value="">Pick camera for dry-run…</option>
                {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn" onClick={testDry} disabled={busy || !previewCam || rule.new} data-testid="rule-dry-run"><Play size={12}/> Dry run</button>
            </div>
            {preview && (
              <div className="mt-3 border border-subtle bg-card p-2 text-[11px] font-mono">
                <div className="text-slate-300">Would create <span className="text-tamber">{preview.preview_count}</span> anomaly(ies) (not persisted).</div>
                {preview.preview?.slice(0,3).map((a,i) => <div key={i} className="text-slate-500 mt-1">→ {a.note}</div>)}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t border-subtle pt-4">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !r.name} data-testid="rule-save-btn"><Save size={12}/> {busy ? "…" : (rule.new ? "Create rule" : "Save changes")}</button>
      </div>
    </Modal>
  );
}
