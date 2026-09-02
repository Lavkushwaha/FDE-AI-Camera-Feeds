"""
Iteration 2 backend tests for VIC:
- User-defined anomaly rules CRUD + dry-run
- Ops Agent chat + history
- Subject Lock AI insights
- Frame timeline
- Factsheet with subject-locks
"""
import os
import time
from pathlib import Path

import pytest
import requests

BASE_URL = "http://localhost:8001"
try:
    r = requests.get(f"{BASE_URL}/api/health", timeout=3)
    assert r.status_code == 200
except Exception:
    BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

API = BASE_URL + "/api"
STATE: dict = {}


@pytest.fixture(scope="module")
def session():
    return requests.Session()


@pytest.fixture(scope="module", autouse=True)
def ensure_seed(session):
    session.post(f"{API}/seed_sample")


@pytest.fixture(scope="module")
def video_cam(session):
    # find or create a camera with ledger rows
    cams = session.get(f"{API}/cameras").json()
    # prefer one with frames_seen > 0
    cams.sort(key=lambda c: -c.get("frames_seen", 0))
    for c in cams:
        rows = session.get(f"{API}/ledger", params={"camera_id": c["id"], "limit": 1}).json()
        if rows:
            return c["id"]
    # otherwise upload a tiny video to first camera
    cid = cams[0]["id"]
    p = Path("/tmp/demo_it2.mp4")
    if not p.exists():
        os.system("ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=10:duration=4 -c:v libx264 -pix_fmt yuv420p /tmp/demo_it2.mp4 >/dev/null 2>&1")
    with open(p, "rb") as fh:
        files = {"file": (p.name, fh, "video/mp4")}
        r = session.post(f"{API}/cameras/{cid}/upload_video?sample_fps=1.5&max_frames=6", files=files, timeout=90)
    assert r.status_code == 200
    job = r.json()["job_id"]
    for _ in range(60):
        st = session.get(f"{API}/jobs/{job}").json()["status"]
        if st in ("done", "error"): break
        time.sleep(2)
    return cid


# ---------- Anomaly Rules CRUD ----------
class TestAnomalyRules:
    def test_defaults_seeded(self, session):
        r = session.get(f"{API}/anomaly-rules")
        assert r.status_code == 200
        rules = r.json()
        assert len(rules) >= 5
        defaults = [x for x in rules if x.get("system_default")]
        assert len(defaults) >= 5
        ids = [x["id"] for x in defaults]
        assert len(set(ids)) == len(ids)  # unique
        for x in defaults:
            assert x["enabled"] is True
            assert x["system_default"] is True
        STATE["initial_count"] = len(rules)

    def test_create_rule(self, session):
        payload = {
            "name": "TEST_Person Presence",
            "type": "class_threshold",
            "predicate": {"label": "person", "min_count": 5, "minutes": 10},
            "severity": "warning",
        }
        r = session.post(f"{API}/anomaly-rules", json=payload)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "id" in data
        assert data["name"] == "TEST_Person Presence"
        assert data.get("system_default") is False
        STATE["rule_id"] = data["id"]
        # count increased
        rules = session.get(f"{API}/anomaly-rules").json()
        assert len(rules) == STATE["initial_count"] + 1

    def test_toggle_rule(self, session):
        rid = STATE["rule_id"]
        r = session.post(f"{API}/anomaly-rules/{rid}/toggle")
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        # verify persistence
        rules = session.get(f"{API}/anomaly-rules").json()
        rule = next(x for x in rules if x["id"] == rid)
        assert rule["enabled"] == data["enabled"]
        # toggle back
        r2 = session.post(f"{API}/anomaly-rules/{rid}/toggle")
        assert r2.status_code == 200

    def test_update_rule(self, session):
        rid = STATE["rule_id"]
        payload = {
            "name": "TEST_Person Presence",
            "type": "class_threshold",
            "predicate": {"label": "person", "min_count": 5, "minutes": 10},
            "severity": "critical",
        }
        r = session.put(f"{API}/anomaly-rules/{rid}", json=payload)
        assert r.status_code == 200
        rules = session.get(f"{API}/anomaly-rules").json()
        rule = next(x for x in rules if x["id"] == rid)
        assert rule["severity"] == "critical"

    def test_dry_run(self, session, video_cam):
        rid = STATE["rule_id"]
        before = len(session.get(f"{API}/anomalies").json())
        r = session.post(f"{API}/anomaly-rules/{rid}/test", params={"camera_id": video_cam})
        assert r.status_code == 200, r.text
        data = r.json()
        assert "preview_count" in data
        assert "preview" in data
        after = len(session.get(f"{API}/anomalies").json())
        assert before == after, "dry-run must not persist anomalies"

    def test_scan_uses_active_rules(self, session, video_cam):
        r = session.post(f"{API}/anomalies/scan", params={"camera_id": video_cam, "minutes": 10})
        assert r.status_code == 200
        created = r.json()["anomalies"]
        # created may be empty depending on data; but if any anomaly exists, verify rule_id/rule_name presence on new ones
        for a in created:
            assert a.get("rule_id"), f"anomaly missing rule_id: {a}"
            assert a.get("rule_name"), f"anomaly missing rule_name: {a}"

    def test_delete_rule(self, session):
        rid = STATE["rule_id"]
        before = len(session.get(f"{API}/anomaly-rules").json())
        r = session.delete(f"{API}/anomaly-rules/{rid}")
        assert r.status_code == 200 and r.json()["deleted"] == 1
        after = len(session.get(f"{API}/anomaly-rules").json())
        assert after == before - 1


# ---------- Ops Agent Chat ----------
class TestChat:
    def test_chat_basic(self, session):
        r = session.post(f"{API}/chat", json={"message": "How many open anomalies right now?"}, timeout=120)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "final" in data and isinstance(data["final"], str)
        assert "session_id" in data and data["session_id"]
        assert "steps" in data and isinstance(data["steps"], list)
        # agent should have called at least one tool
        assert len(data["steps"]) >= 1, f"steps empty: {data}"
        tools_called = [s.get("tool") for s in data["steps"]]
        assert any(t in tools_called for t in ("metrics", "list_anomalies"))
        STATE["session_id"] = data["session_id"]

    def test_chat_resume_session(self, session):
        sid = STATE["session_id"]
        r = session.post(f"{API}/chat", json={"message": "And how many cameras online?", "session_id": sid}, timeout=120)
        assert r.status_code == 200
        assert r.json()["session_id"] == sid

    def test_chat_history(self, session):
        sid = STATE["session_id"]
        r = session.get(f"{API}/chat/{sid}")
        assert r.status_code == 200
        msgs = r.json()
        assert len(msgs) >= 2
        for m in msgs:
            assert m["session_id"] == sid
            assert "user" in m and "assistant" in m


# ---------- Frame timeline ----------
class TestFrames:
    def test_frames_ordered(self, session, video_cam):
        r = session.get(f"{API}/cameras/{video_cam}/frames", params={"limit": 200, "since_minutes": 24 * 60 * 30})
        assert r.status_code == 200
        data = r.json()
        assert data["camera_id"] == video_cam
        assert "frames" in data
        assert data["count"] == len(data["frames"])
        # ordered asc
        ts = [f["detected_at"] for f in data["frames"]]
        assert ts == sorted(ts)
        # ledger row count for camera
        rows = session.get(f"{API}/ledger", params={"camera_id": video_cam, "limit": 500}).json()
        # frames may be within 30d window (should include our uploaded ones)
        assert len(data["frames"]) > 0
        assert len(data["frames"]) <= len(rows)


# ---------- Subject Lock insights ----------
class TestLockInsights:
    def test_full_flow(self, session, video_cam):
        r = session.post(f"{API}/locks", json={"kind": "class", "target": "person", "label": "TEST_lock"})
        assert r.status_code == 200
        lid = r.json()["id"]
        STATE["lid"] = lid

        for mode in ("insight", "alert", "narrate"):
            resp = session.post(f"{API}/locks/{lid}/insights", json={"mode": mode, "window_minutes": 30 * 24 * 60}, timeout=120)
            assert resp.status_code == 200, f"{mode}: {resp.text}"
            d = resp.json()
            assert "insight" in d and isinstance(d["insight"], str) and len(d["insight"]) > 0
            assert "sweep_summary" in d
            assert "count" in d["sweep_summary"]

        rl = session.get(f"{API}/locks/{lid}/insights")
        assert rl.status_code == 200
        insights = rl.json()
        assert len(insights) >= 3

    def test_cleanup_lock(self, session):
        lid = STATE.get("lid")
        if lid:
            session.delete(f"{API}/locks/{lid}")


# ---------- Factsheet with locks ----------
class TestFactsheetWithLocks:
    def test_with_camera(self, session, video_cam):
        # ensure a lock for 'person' exists
        r = session.post(f"{API}/locks", json={"kind": "class", "target": "person", "label": "TEST_fs_lock"})
        lid = r.json()["id"]
        try:
            resp = session.get(f"{API}/ledger/factsheet_with_locks",
                               params={"camera_id": video_cam, "minutes": 30 * 24 * 60})
            assert resp.status_code == 200
            data = resp.json()
            assert "detections_per_class" in data
            assert "subject_locks" in data
            assert isinstance(data["subject_locks"], list)
            match = [x for x in data["subject_locks"] if x["lock_id"] == lid]
            assert match, "created lock not in subject_locks"
            # If ledger has person detections, hits_in_window should be > 0
            has_person = any(d.get("label") == "person" for d in data["detections_per_class"])
            if has_person:
                assert match[0]["hits_in_window"] > 0
        finally:
            session.delete(f"{API}/locks/{lid}")

    def test_without_camera(self, session):
        resp = session.get(f"{API}/ledger/factsheet_with_locks", params={"minutes": 30 * 24 * 60})
        assert resp.status_code == 200
        data = resp.json()
        assert "detections_per_class" in data
        assert "subject_locks" in data
