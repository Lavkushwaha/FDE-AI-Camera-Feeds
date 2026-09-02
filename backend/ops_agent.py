"""
VIC Ops Agent — LangGraph-style tool-using harness on top of the Emergent LLM key.

The engine is data-first: the agent MUST call read/write tools to touch anything real.
It cannot invent facts. A single "step" is: LLM outputs a JSON action, the harness
dispatches it, appends the observation, and loops until the LLM returns
`{"final": "..."}` or a step budget is exhausted.

Public surface:
    run_agent(user_message, session_id, db, cadence, max_steps=6) -> {
        "final": str, "steps": [ {tool, args, observation} ... ], "session_id": str
    }

The tool schema is deliberately narrow: it's the smallest useful action set to
"process all the data from the engine" as the user asked — and the same list is
what powers the on-demand narration + subject-lock insights.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from emergentintegrations.llm.chat import LlmChat, UserMessage


# ---------- Tool implementations (all async, all read/write via db) ---------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _since(minutes: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _clean(doc):
    if isinstance(doc, dict):
        doc.pop("_id", None)
        doc.pop("embedding", None)
    return doc


async def tool_list_cameras(db, **_) -> list[dict]:
    return [_clean(c) async for c in db.cameras.find({}, {"embedding": 0}).limit(50)]


async def tool_metrics(db, **_) -> dict:
    now = datetime.now(timezone.utc)
    cams_online = await db.cameras.count_documents({
        "last_heartbeat": {"$gte": (now - timedelta(minutes=2)).isoformat()}
    })
    return {
        "fpm": await db.detection_events.count_documents({"detected_at": {"$gte": _since(1)}}),
        "events_10m": await db.detection_events.count_documents({"detected_at": {"$gte": _since(10)}}),
        "open_anomalies": await db.anomalies.count_documents({"status": "open"}),
        "cameras_total": await db.cameras.count_documents({}),
        "cameras_online": cams_online,
        "identities": await db.identities.count_documents({}),
        "matches_10m": await db.match_events.count_documents({"detected_at": {"$gte": _since(10)}}),
        "ts": _now_iso(),
    }


async def tool_query_ledger(db, camera_id: str | None = None, label: str | None = None,
                             minutes: int = 10, limit: int = 50, **_) -> list[dict]:
    q: dict = {"detected_at": {"$gte": _since(minutes)}}
    if camera_id: q["camera_id"] = camera_id
    if label: q["objects.label"] = label
    rows = [_clean(r) async for r in db.detection_events.find(q).sort("detected_at", -1).limit(limit)]
    # thin it down for token budget: drop faces embedding-adjacent fields
    for r in rows:
        r.pop("pack", None)
        for f in r.get("faces", []):
            f.pop("det_score", None)
    return rows


async def tool_factsheet(db, camera_id: str | None = None, minutes: int = 10, **_) -> dict:
    q: dict = {"detected_at": {"$gte": _since(minutes)}}
    if camera_id: q["camera_id"] = camera_id
    pipeline = [
        {"$match": q}, {"$unwind": {"path": "$objects", "preserveNullAndEmptyArrays": True}},
        {"$group": {"_id": "$objects.label", "detections": {"$sum": 1}, "avg_conf": {"$avg": "$objects.confidence"}}},
        {"$sort": {"detections": -1}},
    ]
    per_class = []
    async for r in db.detection_events.aggregate(pipeline):
        if r["_id"] is None: continue
        per_class.append({"label": r["_id"], "detections": r["detections"], "avg_conf": round(r["avg_conf"] or 0, 3)})
    frames = await db.detection_events.count_documents(q)
    return {"camera_id": camera_id, "minutes": minutes, "frames_seen": frames, "per_class": per_class}


async def tool_list_anomalies(db, status: str | None = None, camera_id: str | None = None, limit: int = 20, **_) -> list[dict]:
    q: dict = {}
    if status: q["status"] = status
    if camera_id: q["camera_id"] = camera_id
    return [_clean(a) async for a in db.anomalies.find(q).sort("opened_at", -1).limit(limit)]


async def tool_ack_anomaly(db, id: str, note: str = "", **_) -> dict:
    r = await db.anomalies.update_one({"id": id}, {"$set": {"status": "acknowledged", "ack_at": _now_iso(), "ack_by": "ops-agent", "ack_note": note}})
    return {"acknowledged": r.modified_count == 1, "id": id}


async def tool_resolve_anomaly(db, id: str, note: str = "", **_) -> dict:
    r = await db.anomalies.update_one({"id": id}, {"$set": {"status": "resolved", "resolved_at": _now_iso(), "resolved_by": "ops-agent", "resolve_note": note}})
    return {"resolved": r.modified_count == 1, "id": id}


async def tool_list_identities(db, **_) -> list[dict]:
    return [_clean(i) async for i in db.identities.find({}, {"embedding": 0}).sort("created_at", -1).limit(100)]


async def tool_list_matches(db, camera_id: str | None = None, identity_id: str | None = None, minutes: int = 60, limit: int = 30, **_) -> list[dict]:
    q: dict = {"detected_at": {"$gte": _since(minutes)}}
    if camera_id: q["camera_id"] = camera_id
    if identity_id: q["identity_id"] = identity_id
    return [_clean(m) async for m in db.match_events.find(q).sort("detected_at", -1).limit(limit)]


async def tool_create_lock(db, kind: str, target: str, label: str = "", **_) -> dict:
    lock = {"id": str(uuid.uuid4()), "kind": kind, "target": target, "label": label, "created_at": _now_iso(), "status": "active"}
    await db.locks.insert_one(dict(lock))
    return _clean(lock)


async def tool_sweep_lock(db, id: str, minutes: int = 1440, **_) -> dict:
    lock = await db.locks.find_one({"id": id})
    if not lock:
        return {"error": "lock not found"}
    since = _since(minutes)
    sightings: list[dict] = []
    if lock["kind"] == "face":
        async for m in db.match_events.find({"identity_id": lock["target"], "detected_at": {"$gte": since}}).sort("detected_at", 1).limit(200):
            sightings.append({"type": "face_match", "camera_id": m["camera_id"], "detected_at": m["detected_at"], "similarity": m["similarity"]})
    elif lock["kind"] == "class":
        async for r in db.detection_events.find({"detected_at": {"$gte": since}, "objects.label": lock["target"]}).sort("detected_at", 1).limit(200):
            sightings.append({"type": "class_hit", "camera_id": r["camera_id"], "detected_at": r["detected_at"]})
    cams: dict[str, dict] = {}
    for s in sightings:
        c = cams.setdefault(s["camera_id"], {"camera_id": s["camera_id"], "first": s["detected_at"], "last": s["detected_at"], "count": 0})
        c["last"] = s["detected_at"]; c["count"] += 1
    return {"lock": _clean(lock), "count": len(sightings), "journey": sorted(cams.values(), key=lambda x: x["first"])}


async def tool_list_rules(db, **_) -> list[dict]:
    return [_clean(r) async for r in db.anomaly_rules.find().sort("created_at", -1).limit(50)]


TOOLS = {
    "list_cameras":     tool_list_cameras,
    "metrics":          tool_metrics,
    "query_ledger":     tool_query_ledger,
    "factsheet":        tool_factsheet,
    "list_anomalies":   tool_list_anomalies,
    "ack_anomaly":      tool_ack_anomaly,
    "resolve_anomaly":  tool_resolve_anomaly,
    "list_identities":  tool_list_identities,
    "list_matches":     tool_list_matches,
    "create_lock":      tool_create_lock,
    "sweep_lock":       tool_sweep_lock,
    "list_rules":       tool_list_rules,
}


TOOL_SPEC = [
    {"name": "metrics", "args": {}, "when": "quick platform overview counters (fpm, events, anomalies, cameras)"},
    {"name": "list_cameras", "args": {}, "when": "know registered cameras"},
    {"name": "query_ledger", "args": {"camera_id?": "str", "label?": "str", "minutes?": "int", "limit?": "int"}, "when": "sample raw detection rows"},
    {"name": "factsheet", "args": {"camera_id?": "str", "minutes?": "int"}, "when": "aggregated detections per class"},
    {"name": "list_anomalies", "args": {"status?": "open|acknowledged|resolved", "camera_id?": "str", "limit?": "int"}, "when": "review anomaly feed"},
    {"name": "ack_anomaly", "args": {"id": "str", "note?": "str"}, "when": "operator confirmed anomaly is real"},
    {"name": "resolve_anomaly", "args": {"id": "str", "note?": "str"}, "when": "the cause is closed / handled"},
    {"name": "list_identities", "args": {}, "when": "list watchlist"},
    {"name": "list_matches", "args": {"camera_id?": "str", "identity_id?": "str", "minutes?": "int", "limit?": "int"}, "when": "recent face matches"},
    {"name": "create_lock", "args": {"kind": "face|class|plate", "target": "identity_id or class label", "label?": "str"}, "when": "begin investigation"},
    {"name": "sweep_lock", "args": {"id": "str", "minutes?": "int"}, "when": "retrospective search for a locked subject"},
    {"name": "list_rules", "args": {}, "when": "explain current anomaly rules"},
]


SYSTEM = (
    "You are VIC Ops Agent — a grounded, tool-using operator assistant for a "
    "vision-intelligence platform. You NEVER guess facts. Every claim must come "
    "from a tool call in this session. You may loop up to a set step budget.\n\n"
    "PROTOCOL — output a SINGLE JSON object, nothing else, matching one of:\n"
    "  {\"tool\": \"<name>\", \"args\": { ... }}   // to fetch data / take action\n"
    "  {\"final\": \"<short markdown answer for operator>\"}\n\n"
    "Rules:\n"
    "  1. Always start by calling `metrics` unless the user asked for something "
    "     that clearly needs another tool first.\n"
    "  2. If the user asks to `investigate X` — create_lock then sweep_lock.\n"
    "  3. If the user says `close/ack/resolve anomaly ...` — call the right lifecycle tool.\n"
    "  4. Cite numbers from observations verbatim. Do not invent identities/labels.\n"
    "  5. Keep `final` under 6 sentences unless asked to summarise long history.\n"
    f"AVAILABLE TOOLS: {json.dumps(TOOL_SPEC)}"
)


def _extract_json(text: str) -> dict | None:
    """Robust JSON extraction — model may wrap in ```json ...``` fences."""
    if not text: return None
    m = re.search(r"\{[\s\S]*\}", text)
    if not m: return None
    blob = m.group(0)
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        # try to trim trailing junk
        for i in range(len(blob), 0, -1):
            try:
                return json.loads(blob[:i])
            except Exception:
                continue
    return None


async def run_agent(user_message: str, session_id: str, db, api_key: str, max_steps: int = 6) -> dict:
    """Run the tool-use loop and return the assembled trace."""
    session_id = session_id or str(uuid.uuid4())
    chat = LlmChat(api_key=api_key, session_id=session_id, system_message=SYSTEM).with_model("openai", "gpt-5.4")
    steps: list[dict] = []
    prompt = f"OPERATOR: {user_message}\n\nBegin. Respond with a single JSON action."
    for _ in range(max_steps):
        reply = await chat.send_message(UserMessage(text=prompt))
        text = reply if isinstance(reply, str) else str(reply)
        action = _extract_json(text) or {"final": text.strip()[:1200]}
        if "final" in action:
            return {"final": action["final"], "steps": steps, "session_id": session_id}
        tool = action.get("tool")
        args = action.get("args") or {}
        if tool not in TOOLS:
            observation = {"error": f"unknown tool '{tool}' — valid: {list(TOOLS)}"}
        else:
            try:
                observation = await TOOLS[tool](db, **args)
            except Exception as e:
                observation = {"error": f"tool {tool} failed: {e}"}
        # trim observation size aggressively for token budget
        obs_json = json.dumps(observation, default=str)
        if len(obs_json) > 6000:
            obs_json = obs_json[:6000] + "…(truncated)"
        steps.append({"tool": tool, "args": args, "observation": json.loads(obs_json) if obs_json.startswith(("[", "{")) else obs_json})
        prompt = (f"OBSERVATION for {tool}: {obs_json}\n\n"
                  "Continue: another tool call OR the final answer JSON.")
    return {
        "final": "step budget exhausted — partial reasoning above",
        "steps": steps,
        "session_id": session_id,
    }
