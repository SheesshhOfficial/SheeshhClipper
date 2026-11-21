import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app, RENDER_LOCK
from app.media import probe

class LocalMediaSmoke(unittest.TestCase):
    def test_upload_render_and_keep_all_artifacts(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {"SHEESH_DATA_DIR": td}):
            root = Path(td)
            sample = root / "sample.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc2=s=320x180:r=12", "-f", "lavfi", "-i",
                            "sine=frequency=440", "-t", "2", "-c:v", "libx264",
                            "-c:a", "aac", str(sample)], check=True)
            client = TestClient(app, base_url="http://localhost")
            self.assertEqual(client.get("/api/health").status_code, 200)
            self.assertEqual(client.get("/api/health", headers={"Host": "example.invalid"}).status_code, 400)
            self.assertEqual(client.get("/api/sources", headers={"Origin": "https://example.invalid"}).status_code, 403)
            response = client.post("/api/sources", files={"file": ("bad.mp4", b"no video")})
            self.assertEqual(response.status_code, 422)
            response = client.post("/api/sources", files={"file": ("sample.mp4", sample.read_bytes(), "video/mp4")})
            self.assertEqual(response.status_code, 200, response.text)
            source = response.json()
            self.assertEqual((source["width"], source["height"]), (320, 180))
            self.assertEqual(client.get("/api/sources").json(), [source])
            r = client.get(source["url"], headers={"Range": "bytes=0-31"})
            self.assertEqual((r.status_code, len(r.content)), (206, 32))
            base = {"source_id": source["id"], "start": .1, "end": .65, "focus_x": .2, "focus_y": .8}
            ids = set()
            for aspect, layout, kind, size in (
                ("9:16", "fit", "draft", (1080, 1920)),
                ("1:1", "fill", "export", (1080, 1080)),
                ("16:9", "split", "draft", (1920, 1080)),
                ("9:16", "split", "export", (1080, 1920)),
            ):
                body = {**base, "aspect": aspect, "layout": layout, "kind": kind}
                if layout == "split":
                    body["facecam"] = {"x": .45, "y": .12, "w": .4, "h": .42}
                r = client.post("/api/render", json=body)
                self.assertEqual(r.status_code, 200, r.text)
                current = r.json()
                self.assertNotIn(current["id"], ids)
                ids.add(current["id"])
                path = root / ("drafts" if kind == "draft" else "exports") / (current["id"] + ".mp4")
                self.assertEqual(client.get("/api/artifacts/" + current["id"]).json()["edit"]["aspect"], aspect)
                meta = probe(path)
                self.assertEqual((meta["width"], meta["height"]), size)
                self.assertAlmostEqual(meta["duration"], .55, delta=.09)
                self.assertEqual((current["width"], current["height"]), size)
                self.assertEqual(current["bytes"], path.stat().st_size)
                self.assertEqual(current["duration"], meta["duration"])
                self.assertEqual(client.get(current["url"], headers={"Range": "bytes=0-7"}).status_code, 206)
            self.assertEqual(set(x["id"] for x in client.get("/api/artifacts").json()), ids)
            self.assertEqual((root / "originals" / (source["id"] + ".mp4")).read_bytes(), sample.read_bytes())
            self.assertEqual(len(list((root / "projects").glob("*.json"))), 4)
            saved = client.get("/api/artifacts").json()
            self.assertTrue(all(item["source_id"] == source["id"] for item in saved))
            self.assertTrue(all(item["bytes"] > 0 and item["duration"] > 0 for item in saved))
            legacy = saved[0]
            recipe = root / "projects" / (legacy["id"] + ".json")
            record = json.loads(recipe.read_text(encoding="utf-8"))
            for key in ("width", "height", "bytes", "duration"):
                del record[key]
            recipe.write_text(json.dumps(record), encoding="utf-8")
            listed = next(item for item in client.get("/api/artifacts").json() if item["id"] == legacy["id"])
            self.assertNotIn("bytes", listed)
            self.assertEqual(client.get(legacy["url"]).status_code, 200)
            self.assertIn("edit", client.get("/api/artifacts/" + legacy["id"]).json())
            r = client.post("/api/render", json={**base, "aspect":"9:16", "layout":"split", "kind":"draft"})
            self.assertEqual(r.status_code, 422)
            with RENDER_LOCK:
                r = client.post("/api/render", json={**base, "aspect":"9:16", "layout":"fill", "kind":"draft"})
                self.assertEqual(r.status_code, 409)

if __name__ == "__main__":
    unittest.main()
