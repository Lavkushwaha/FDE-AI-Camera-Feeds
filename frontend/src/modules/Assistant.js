import React, { useEffect, useRef, useState } from "react";
import { vic } from "../api";
import { Send, Wrench, Bot, User, Terminal, Sparkles } from "lucide-react";

const SUGGESTIONS = [
  "Give me a situation report — what's happening right now?",
  "List every open anomaly and rank them by severity.",
  "How many people were seen across all cameras in the last hour?",
  "Investigate the person class — start a lock and sweep 24h.",
  "Acknowledge every info-level anomaly older than an hour.",
  "Show me the top 3 face matches in the last 60 minutes.",
];

export default function Assistant() {
  const [session, setSession] = useState(() => localStorage.getItem("vic-session") || "");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  useEffect(() => { if (session) localStorage.setItem("vic-session", session); }, [session]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages]);

  const send = async (text) => {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput("");
    setMessages(m => [...m, { role: "user", text: msg }]);
    setBusy(true);
    try {
      const r = await vic.chat(msg, session || null);
      setSession(r.session_id);
      setMessages(m => [...m, { role: "assistant", text: r.final, steps: r.steps }]);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `error: ${e.message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-6rem)]" data-testid="assistant-panel">
      <div className="lg:col-span-3 flex flex-col panel">
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
          <div>
            <div className="flex items-center gap-2 text-heading uppercase text-slate-100 font-semibold tracking-tight"><Bot size={16} className="text-tcyan"/> VIC Ops Agent</div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">tool-using · reads live engine data · takes actions</div>
          </div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">session {session.slice(0,8) || "—"}</div>
        </div>

        <div ref={scroller} className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="chat-scroll">
          {messages.length === 0 && (
            <div className="text-center text-slate-500 font-mono uppercase tracking-widest text-xs py-8">
              <Sparkles size={20} className="mx-auto text-slate-700 mb-2"/>
              ask about live cameras, anomalies, identities, or ask it to <span className="text-tamber">investigate</span>, <span className="text-tamber">acknowledge</span> or <span className="text-tamber">resolve</span>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && <div className="mt-1 w-6 h-6 flex items-center justify-center border border-tcyan/40 text-tcyan"><Bot size={12}/></div>}
              <div className={`max-w-[80%] ${m.role === "user" ? "bg-tamber/10 border border-tamber/40" : "card"} p-3`}>
                <div className="text-sm text-slate-100 whitespace-pre-wrap">{m.text}</div>
                {m.steps?.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[10px] font-mono uppercase tracking-widest text-slate-500 cursor-pointer">
                      <Terminal size={10} className="inline mr-1"/> {m.steps.length} tool call{m.steps.length>1?"s":""}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {m.steps.map((s, j) => (
                        <div key={j} className="border border-subtle bg-black/40 p-2 text-[10px] font-mono">
                          <div className="text-tcyan">▸ {s.tool}({JSON.stringify(s.args)})</div>
                          <pre className="text-slate-400 whitespace-pre-wrap mt-1 overflow-x-auto max-h-32">{JSON.stringify(s.observation, null, 1).slice(0, 800)}{JSON.stringify(s.observation).length > 800 ? "…" : ""}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              {m.role === "user" && <div className="mt-1 w-6 h-6 flex items-center justify-center border border-tamber/40 text-tamber"><User size={12}/></div>}
            </div>
          ))}
          {busy && (
            <div className="flex gap-2 items-center text-[11px] font-mono uppercase tracking-widest text-tcyan">
              <div className="w-6 h-6 flex items-center justify-center border border-tcyan/40"><Wrench size={12} className="animate-spin"/></div>
              agent thinking, calling tools…
            </div>
          )}
        </div>

        <form onSubmit={e => { e.preventDefault(); send(); }} className="border-t border-subtle p-3 flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="ask the ops agent…"
            className="input flex-1"
            disabled={busy}
            data-testid="chat-input"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()} data-testid="chat-send"><Send size={14}/> send</button>
        </form>
      </div>

      <div className="panel p-4 hidden lg:block">
        <div className="text-heading uppercase text-slate-200 font-semibold tracking-tight border-b border-subtle pb-2">Prompt library</div>
        <div className="mt-3 space-y-2">
          {SUGGESTIONS.map((s,i) => (
            <button key={i} onClick={()=>send(s)} disabled={busy}
              className="w-full text-left text-xs text-slate-300 border border-subtle bg-card p-2 hover:border-tcyan/50 hover:text-tcyan transition-colors"
              data-testid={`prompt-${i}`}
            >{s}</button>
          ))}
        </div>
        <div className="mt-6 text-[10px] font-mono uppercase tracking-widest text-slate-500">tool surface</div>
        <ul className="mt-2 text-[10px] font-mono text-slate-500 space-y-1">
          <li>metrics · list_cameras · query_ledger · factsheet</li>
          <li>list_anomalies · ack_anomaly · resolve_anomaly</li>
          <li>list_identities · list_matches</li>
          <li>create_lock · sweep_lock · list_rules</li>
        </ul>
        <button
          className="btn w-full mt-4"
          onClick={()=>{ setMessages([]); setSession(""); localStorage.removeItem("vic-session"); }}
          data-testid="reset-session"
        >New session</button>
      </div>
    </div>
  );
}
