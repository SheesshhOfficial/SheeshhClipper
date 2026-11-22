"""End-to-end local edit and draft tests; no network or real footage."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import ingest, media
from app.main import app, RENDER_LOCK


class Workflow(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        patch_env = patch.dict(os.environ, {"SHEESH_DATA_DIR": str(self.base / "data")})
        patch_env.start()
        self.addCleanup(patch_env.stop)
        self.root = media.root()
        self.fixture = self.base / "check.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=16",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4",
                        "-c:v", "libx264", "-c:a", "aac", str(self.fixture)], check=True)
        self.client = TestClient(app, base_url="http://localhost")
        self.addCleanup(self.client.close)
        response = self.client.post("/api/sources", files={"file": ("check.mp4", self.fixture.read_bytes())})
        self.assertEqual(response.status_code, 200, response.text)
        self.source = response.json()["id"]

    def wait_for_analysis(self, id):
        until = monotonic() + 30
        while monotonic() < until:
            job = self.client.get("/api/analysis/" + id).json()
            if job["status"] not in ("queued", "running"):
                until = monotonic() + 2
                while RENDER_LOCK.locked() and monotonic() < until:
                    sleep(.01)
                return job
            sleep(.05)
        self.fail("analysis did not finish")

    def test_analysis_saves_reviewable_draft_then_compact_edit(self):
        blocked = self.client.post("/api/analysis", headers={"Sec-Fetch-Site": "cross-site"},
                                   json={"source_id": self.source})
        self.assertEqual(blocked.status_code, 403)
        analysis = self.client.post("/api/analysis", json={
            "source_id": self.source, "language": "english", "provider": "audio", "count": 2,
        })
        self.assertEqual(analysis.status_code, 202, analysis.text)
        job = self.wait_for_analysis(analysis.json()["id"])
        self.assertEqual(job["status"], "completed", job)
        self.assertGreaterEqual(len(job["suggestions"]), 1)
        found = job["suggestions"][0]["draft"]
        restorable = self.client.get("/api/artifacts/" + found["id"]).json()["edit"]
        self.assertEqual(restorable["source_id"], self.source)
        self.assertTrue((self.root / "drafts" / (found["id"] + ".mp4")).exists())

        r = self.client.post("/api/render", json={
            **restorable, "kind": "export", "export_profile": "compact",
            "start": .25, "end": 3.75, "cuts": [{"start": 1.5, "end": 2.5}],
            "layout_changes": [{"at": 1.25, "layout": "split",
                                "facecam": {"x": .7, "y": .1, "w": .2, "h": .25}}],
            "captions_override": [{"start": .75, "end": 3.25, "text": "Bhai, watch this \u2014 <safe>."}],
        })
        self.assertEqual(r.status_code, 200, r.text)
        item = r.json()
        mp4 = self.root / "exports" / (item["id"] + ".mp4")
        info = media.probe(mp4)
        self.assertEqual((info["width"], info["height"]), (720, 1280))
        self.assertAlmostEqual(info["duration"], 2.5, delta=.17)
        stored = self.client.get("/api/artifacts/" + item["id"]).json()["edit"]
        self.assertEqual(stored["layout_changes"][0]["layout"], "split")
        self.assertEqual(len(stored["cuts"]), 1)
        self.assertIn("Bhai", stored["captions_override"][0]["text"])
        self.assertEqual(self.client.get(item["url"], headers={"Range": "bytes=0-31"}).status_code, 206)
        self.assertEqual((self.root / "originals" / f"{self.source}.mp4").read_bytes(),
                         self.fixture.read_bytes())

    def test_facecam_overlay_positions_and_safe_page_headers(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"])
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.client.get("/api/diagnostics").json()["binding"], "local-only")
        body = {"source_id": self.source, "kind": "export", "export_profile": "compact",
                "aspect": "16:9", "layout": "pip", "start": 0, "end": .75,
                "facecam_scale": .25, "facecam_pos_x": 1, "facecam_pos_y": 0,
                "facecam": {"x": .6, "y": .11, "w": .25, "h": .21}}
        r = self.client.post("/api/render", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        info = media.probe(self.root / "exports" / (r.json()["id"] + ".mp4"))
        self.assertEqual((info["width"], info["height"]), (1280, 720))
        r = self.client.post("/api/render", json={**body, "facecam": None})
        self.assertEqual(r.status_code, 422)

    def test_local_import_opt_in_waits_for_current_render(self):
        self.assertEqual(self.client.get("/api/analysis", params={"source_id": self.source}).json(), [])
        with RENDER_LOCK:
            response = self.client.post("/api/sources", data={"auto_analyze": "true"},
                                        files={"file": ("auto.mp4", self.fixture.read_bytes())})
            self.assertEqual(response.status_code, 200, response.text)
            source = response.json()
            self.assertEqual(self.client.get("/api/analysis/" + source["analysis_id"]).json()["status"], "queued")
        result = self.wait_for_analysis(source["analysis_id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["provider"], "audio")
        self.assertTrue(result["visual_motion"])
        self.assertEqual(result["source_id"], source["id"])
        self.assertTrue(result["suggestions"][0]["draft"]["id"])
        self.assertEqual(list((self.root / "exports").glob("*.mp4")), [])

    def test_ai_clipper_ranks_without_saving_until_manual_render(self):
        source = self.client.get("/api/sources").json()[0]
        result = self.client.post("/api/ai-clipper/rank", json={
            "source_id": self.source, "min_seconds": 5, "max_seconds": 15,
            "cues": [{"start": 0, "end": min(source["duration"], 10),
                      "text": "Watch this. We lost the police chase and finally made it out!"}],
        })
        self.assertEqual(200, result.status_code, result.text)
        pick = result.json()["candidates"][0]
        self.assertIn(pick["evidence"], "Watch this. We lost the police chase and finally made it out!")
        self.assertEqual([], self.client.get("/api/artifacts").json())
        saved = self.client.post("/api/render", json={
            "source_id": self.source, "start": pick["start"], "end": min(.9, pick["end"]),
            "kind": "export", "aspect": "9:16", "layout": "fit",
            "export_profile": "compact", "caption_style": "bold",
            "clip_title": "My edited title",
        })
        self.assertEqual(200, saved.status_code, saved.text)
        detail = self.client.get("/api/artifacts/" + saved.json()["id"]).json()
        self.assertEqual("My edited title", detail["edit"]["clip_title"])
        self.assertEqual("bold", detail["edit"]["caption_style"])

    def test_vod_import_submits_local_review_without_exporting(self):
        def download(root, job, folder):
            return [sys.executable, "-c", "import shutil,sys;shutil.copyfile(sys.argv[1],sys.argv[2])",
                    str(self.fixture), str(folder / "video.mp4")]
        with patch.object(ingest, "downloader", side_effect=download):
            response = self.client.post("/api/ingest", json={
                "kind": "vod", "url": "https://youtu.be/ABCDEFGHIJK", "auto_analyze": True})
            self.assertEqual(response.status_code, 202, response.text)
            job_url = "/api/ingest/" + response.json()["id"]
            until = monotonic() + 20
            while monotonic() < until:
                current = self.client.get(job_url).json()
                if current["status"] in ingest.TERMINAL:
                    break
                sleep(.05)
            self.assertEqual(current["status"], "completed", current)
            output = current["outputs"][0]
            result = self.wait_for_analysis(output["analysis_id"])
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["source_id"], output["source_id"])
            self.assertTrue(result["visual_motion"])
            self.assertTrue(result["suggestions"][0]["draft"]["id"])
            self.assertEqual(list((self.root / "exports").glob("*.mp4")), [])

    def test_live_closed_chunks_analysis_is_optional_and_never_backlogs(self):
        kind = "live"
        job = {"id": media.media_id(), "url": "https://www.youtube.com/watch?v=ABCDEFGHIJK",
               "kind": kind, "status": "running", "outputs": [], "auto_analyze": True}
        directory = ingest.directory(self.root, job)
        directory.mkdir(parents=True)
        chunk1 = directory / "chunk-00000000.mp4"
        chunk1.write_bytes(self.fixture.read_bytes())
        # First, no free analysis worker. Capture still registers the chunk.
        with RENDER_LOCK:
            ingest.publish(self.root, job, chunk1)
        self.assertIn("busy", job["outputs"][0]["analysis_note"])
        chunk2 = directory / "chunk-00000001.mp4"
        chunk2.write_bytes(self.fixture.read_bytes())
        ingest.publish(self.root, job, chunk2)
        result = self.wait_for_analysis(job["outputs"][1]["analysis_id"])
        self.assertEqual(result["provider"], "audio")
        self.assertEqual(result["source_id"], job["outputs"][1]["source_id"])
        self.assertEqual(result["status"], "completed")
        saved = json.loads((ingest.cache(self.root) / f"{job['id']}.json").read_text())
        self.assertEqual(len(saved["outputs"]), 2)
        self.assertEqual(len(list(directory.glob("*.mp4"))), 2)


if __name__ == "__main__":
    unittest.main()
