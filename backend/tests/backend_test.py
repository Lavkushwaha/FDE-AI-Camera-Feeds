"""
Backend tests for Vision Intelligence Core (VIC).
Covers all endpoints referenced in the review request.
"""
import io
import os
import time
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
# Prefer local for speed if reachable, else external
try:
    r = requests.get("http://localhost:8001/api/health", timeout=3)
    if r.status_code == 200:
        BASE_URL = "http://localhost:8001"
except Exception:
    pass

API = BASE_URL + "/api"

# Shared state across tests within the module
STATE: dict = {}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    return s


@pytest.fixture(scope="module")
def test_video():
    p = Path("/tmp/bus.mp4")
    if not p.exists():
        p = Path("/tmp/demo1.mp4")
    if not p.exists():
        # generate
        os.system("ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=10:duration=4 -c:v libx264 -pix_fmt yuv420p /tmp/demo.mp4 >/dev/null 2>&1")
        p = Path("/tmp/demo.mp4")
    return p


@pytest.fixture(scope="module")
def test_face():
    p = Path("/tmp/zidane.jpg")
    if not p.exists():
        os.system("curl -sSL https://ultralytics.com/images/zidane.jpg -o /tmp/zidane.jpg")
    return p


# ---------- Health / Packs ----------
class TestHealthAndPacks:
    def test_health(self, session):
        r = session.get(f"{API}/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_packs(self, session):
        r = session.get(f"{API}/packs")
        assert r.status_code == 200
        data = r.json()
        for key in ("school", "retail", "traffic", "general"):
            assert key in data
            assert "vocabulary" in data[key]


# ---------- Seed & Cameras ----------
class TestCameras:
    def test_seed_first(self, session):
        r = session.post(f"{API}/seed_sample")
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_seed_idempotent(self, session):
        r = session.post(f"{API}/seed_sample")
        assert r.status_code == 200
        data = r.json()
        # second call must not seed again
        assert data.get("seeded") is False or data.get("count", 0) >= 2

    def test_list_cameras(self, session):
        r = session.get(f"{API}/cameras")
        assert r.status_code == 200
        cams = r.json()
        assert isinstance(cams, list) and len(cams) >= 2

    def test_create_and_delete_camera(self, session):
        payload = {
            "name": "TEST_cam",
            "source": {"type": "file", "uri": "test.mp4"},
            "pack": "general",
        }
        r = session.post(f"{API}/cameras", json=payload)
        assert r.status_code == 200
        cam = r.json()
        assert cam["name"] == "TEST_cam"
        cid = cam["id"]

        # get
        rg = session.get(f"{API}/cameras/{cid}")
        assert rg.status_code == 200 and rg.json()["id"] == cid

        # heartbeat
        rh = session.post(f"{API}/cameras/{cid}/heartbeat")
        assert rh.status_code == 200
        rg2 = session.get(f"{API}/cameras/{cid}").json()
        assert rg2["status"] == "online"
        assert rg2["frames_seen"] >= 1
        assert rg2.get("last_heartbeat")

        # zones
        zones = [{"id": "z1", "name": "gate", "polygon": [[0, 0], [1, 0], [1, 1]], "rule": "presence"}]
        rz = session.put(f"{API}/cameras/{cid}/zones", json=zones)
        assert rz.status_code == 200 and rz.json()["zones"] == 1
        rg3 = session.get(f"{API}/cameras/{cid}").json()
        assert len(rg3["zones"]) == 1

        # delete
        rd = session.delete(f"{API}/cameras/{cid}")
        assert rd.status_code == 200 and rd.json()["deleted"] == 1


# ---------- Video processing + Ledger ----------
class TestVideoAndLedger:
    def test_upload_and_process(self, session, test_video):
        # create dedicated camera
        payload = {"name": "TEST_video_cam", "source": {"type": "file", "uri": "x.mp4"}, "pack": "general"}
        cam = session.post(f"{API}/cameras", json=payload).json()
        cid = cam["id"]
        STATE["cid"] = cid

        with open(test_video, "rb") as fh:
            files = {"file": (test_video.name, fh, "video/mp4")}
            r = session.post(
                f"{API}/cameras/{cid}/upload_video?sample_fps=1.5&max_frames=6",
                files=files,
                timeout=60,
            )
        assert r.status_code == 200, r.text
        job_id = r.json()["job_id"]
        STATE["job_id"] = job_id

        # poll job
        status = None
        for _ in range(60):
            j = session.get(f"{API}/jobs/{job_id}").json()
            status = j["status"]
            if status in ("done", "error"):
                break
            time.sleep(2)
        assert status == "done", f"job did not finish, got {status}: {j}"
        assert j["frames_written"] > 0

    def test_ledger_rows_and_frame_url(self, session):
        cid = STATE["cid"]
        r = session.get(f"{API}/ledger", params={"camera_id": cid, "limit": 50})
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) > 0
        row = rows[0]
        assert "objects" in row
        assert row["frame_ref"].startswith("/api/media/frames/")
        # Frame should be accessible
        rf = requests.get(BASE_URL + row["frame_ref"], timeout=10)
        assert rf.status_code == 200
        assert len(rf.content) > 100

    def test_factsheet(self, session):
        cid = STATE["cid"]
        r = session.get(f"{API}/ledger/factsheet", params={"camera_id": cid, "minutes": 10})
        assert r.status_code == 200
        fs = r.json()
        assert "detections_per_class" in fs
        assert fs["frames_seen"] > 0

    def test_export_json(self, session):
        r = session.get(f"{API}/ledger/export", params={"format": "json"})
        assert r.status_code == 200
        assert "attachment" in r.headers.get("content-disposition", "").lower()
        assert r.headers["content-type"].startswith("application/json")

    def test_export_csv(self, session):
        r = session.get(f"{API}/ledger/export", params={"format": "csv"})
        assert r.status_code == 200
        assert "csv" in r.headers["content-type"]
        assert "camera_id" in r.text.splitlines()[0]


# ---------- Anomalies ----------
class TestAnomalies:
    def test_scan_and_lifecycle(self, session):
        cid = STATE["cid"]
        r = session.post(f"{API}/anomalies/scan", params={"camera_id": cid, "minutes": 10})
        assert r.status_code == 200
        created = r.json()["anomalies"]
        # We processed few frames vs 600 expected → capture_gap expected
        assert len(created) >= 1
        types = [a["type"] for a in created]
        assert "capture_gap" in types

        # list
        rl = session.get(f"{API}/anomalies", params={"camera_id": cid})
        assert rl.status_code == 200
        anoms = rl.json()
        assert any(a["type"] == "capture_gap" for a in anoms)
        aid = anoms[0]["id"]

        # ack
        ra = session.post(f"{API}/anomalies/{aid}/ack", json={"actor": "tester", "note": "ok"})
        assert ra.status_code == 200

        # resolve
        rr = session.post(f"{API}/anomalies/{aid}/resolve", json={"actor": "tester", "note": "fixed"})
        assert rr.status_code == 200


# ---------- Identities ----------
class TestIdentities:
    def test_enroll_list_delete(self, session, test_face):
        assert test_face.exists(), "portrait image missing"
        with open(test_face, "rb") as fh:
            files = {"file": (test_face.name, fh, "image/jpeg")}
            r = session.post(
                f"{API}/identities/enroll",
                params={"name": "TEST_Zidane", "category": "watchlist"},
                files=files,
                timeout=60,
            )
        assert r.status_code == 200, r.text
        ident = r.json()
        assert ident["name"] == "TEST_Zidane"
        assert ident["photo"].startswith("/api/media/faces/")
        # photo accessible
        rf = requests.get(BASE_URL + ident["photo"], timeout=10)
        assert rf.status_code == 200
        iid = ident["id"]
        STATE["iid"] = iid

        rl = session.get(f"{API}/identities")
        assert rl.status_code == 200
        assert any(x["id"] == iid for x in rl.json())

    def test_delete_identity(self, session):
        iid = STATE.get("iid")
        if not iid:
            pytest.skip("no identity")
        r = session.delete(f"{API}/identities/{iid}")
        assert r.status_code == 200 and r.json()["deleted"] == 1


# ---------- Locks ----------
class TestLocks:
    def test_lock_flow(self, session):
        r = session.post(f"{API}/locks", json={"kind": "class", "target": "person", "label": "test"})
        assert r.status_code == 200
        lock = r.json()
        lid = lock["id"]
        assert lock["kind"] == "class"

        rs = session.get(f"{API}/locks/{lid}/sweep", params={"window_minutes": 1440})
        assert rs.status_code == 200
        data = rs.json()
        assert "sightings" in data and "journey" in data

        rd = session.delete(f"{API}/locks/{lid}")
        assert rd.status_code == 200


# ---------- Narrative ----------
class TestNarrative:
    def test_narrative(self, session):
        r = session.post(f"{API}/narrative", json={"cadence": "10m"})
        assert r.status_code == 200
        data = r.json()
        assert "narrative" in data
        assert isinstance(data["narrative"], str) and len(data["narrative"]) > 0


# ---------- Metrics ----------
class TestMetrics:
    def test_metrics(self, session):
        r = session.get(f"{API}/metrics")
        assert r.status_code == 200
        m = r.json()
        for k in ("fpm", "events_10m", "open_anomalies", "cameras", "identities_enrolled", "matches_10m"):
            assert k in m
        assert set(("total", "online", "offline")).issubset(m["cameras"].keys())
