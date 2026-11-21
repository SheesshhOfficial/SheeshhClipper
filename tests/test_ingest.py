"""Ingest contract tests; no network access or YouTube calls."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import ingest


class IngestTests(unittest.TestCase):
    def test_canonicalizes_and_rejects_untrusted_urls(self):
        good = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        for url in (good, "https://youtu.be/dQw4w9WgXcQ?si=x",
                    "https://m.youtube.com/live/dQw4w9WgXcQ",
                    "https://youtube.com/shorts/dQw4w9WgXcQ"):
            self.assertEqual(ingest.canonical_youtube(url), good)
        for url in ("http://youtube.com/watch?v=dQw4w9WgXcQ",
                    "https://youtube.com.evil/watch?v=dQw4w9WgXcQ",
                    "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
                    "https://evil.test@youtube.com/watch?v=dQw4w9WgXcQ",
                    "https://127.0.0.1/", "https://youtube.com:443/watch?v=dQw4w9WgXcQ",
                    "https://youtube.com/playlist?list=x",
                    good + "&v=11111111111"):
            with self.assertRaises(ValueError):
                ingest.canonical_youtube(url)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Requires FFmpeg")
    def test_vod_and_live(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"SHEESH_DATA_DIR": tmp}):
            root = Path(tmp)
            clip, stream = root / "mock.mp4", root / "mock.ts"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc2=s=96x64:r=10", "-t", "4", "-c:v", "libx264",
                            "-g", "10", str(clip)], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-c", "copy",
                            "-f", "mpegts", str(stream)], check=True)
            alternate = root / "alternate.webm"
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip),
                            "-f", "lavfi", "-i", "sine=frequency=440",
                            "-t", "1", "-c:v", "libvpx-vp9", "-c:a", "libopus",
                            str(alternate)], check=True)
            ff = ingest.segmenter
            app = FastAPI()
            app.include_router(ingest.router)
            client = TestClient(app, base_url="http://localhost")
            url = "https://youtu.be/dQw4w9WgXcQ"

            def mock_download(data, job, folder):
                if job["kind"] == "vod":
                    selected = alternate if job["url"].endswith("11111111111") else clip
                    return [sys.executable, "-c", "import shutil,sys;shutil.copyfile(sys.argv[1],sys.argv[2])",
                            str(selected), str(folder / ("video" + selected.suffix))]
                return [sys.executable, "-c",
                        "import pathlib,sys,time;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes());sys.stdout.buffer.flush();time.sleep(30)",
                        str(stream)]

            def wait_for(id, predicate):
                until = time.monotonic() + 15
                while time.monotonic() < until:
                    job = client.get("/api/ingest/" + id).json()
                    if predicate(job):
                        return job
                    time.sleep(.1)
                self.fail(f"Timed out: {job}")

            with patch.object(ingest, "downloader", side_effect=mock_download), patch.object(ingest, "segmenter", side_effect=lambda folder: ff(folder, 1)):
                r = client.post("/api/ingest", json={"url": url, "kind": "vod"})
                self.assertEqual(r.status_code, 202)
                job = wait_for(r.json()["id"], lambda j: j["status"] in ingest.TERMINAL)
                self.assertEqual(job["status"], "completed")
                part = job["outputs"][0]
                self.assertTrue((root / "originals" / (part["source_id"] + ".mp4")).exists())
                self.assertEqual(client.get(part["url"], headers={"Range": "bytes=0-15"}).status_code, 206)
                r = client.post("/api/ingest", json={"url": "https://youtu.be/11111111111", "kind": "vod"})
                fallback = wait_for(r.json()["id"], lambda j: j["status"] in ingest.TERMINAL)
                self.assertEqual(fallback["status"], "completed")
                folder = root / "downloads" / fallback["id"]
                self.assertEqual((folder / "video.webm").read_bytes(), alternate.read_bytes())
                self.assertEqual(fallback["outputs"][0]["name"], "editing-proxy.mp4")
                self.assertTrue(ingest.editing_compatible(folder / "editing-proxy.mp4"))
                self.assertEqual((root / "originals" / (fallback["outputs"][0]["source_id"] + ".mp4")).read_bytes(),
                                 (folder / "editing-proxy.mp4").read_bytes())
                r = client.post("/api/ingest", json={"url": url, "kind": "live"})
                self.assertEqual(r.status_code, 202)
                id = r.json()["id"]
                self.assertEqual(client.post("/api/ingest", json={"url": url, "kind": "vod"}).status_code, 409)
                wait_for(id, lambda j: j["status"] == "running")
                time.sleep(.8)
                self.assertEqual(client.post(f"/api/ingest/{id}/stop").status_code, 200)
                job = wait_for(id, lambda j: j["status"] in ingest.TERMINAL)
                self.assertEqual(job["status"], "stopped")
                self.assertGreaterEqual(len(job["outputs"]), 3)
                self.assertEqual(len(client.get("/api/ingest").json()), 3)
                for part in job["outputs"]:
                    self.assertTrue((root / "live-chunks" / id / part["name"]).exists())
                    self.assertTrue((root / "originals" / (part["source_id"] + ".json")).exists())
