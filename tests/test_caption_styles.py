"""Caption preset schema and actual FFmpeg burn-in coverage."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import Render, app


def edit(source_id="0" * 32):
    return {"source_id": source_id, "start": 0, "end": .8, "aspect": "16:9",
            "layout": "fit", "kind": "export", "export_profile": "compact",
            "captions_override": [{"start": 0, "end": .8, "text": "CAPTION STYLE"}]}


class CaptionStyles(unittest.TestCase):
    def test_validation_and_legacy_default(self):
        self.assertEqual(Render(**edit()).caption_style, "clean")
        self.assertEqual(Render(**edit(), caption_style="bold").model_dump()["caption_style"], "bold")
        with self.assertRaises(ValidationError):
            Render(**edit(), caption_style="FontSize=900")
        with self.assertRaises(ValidationError):
            Render(**edit(), clip_title="x" * 101)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Requires FFmpeg")
    def test_render_distinct_styles_and_persist_recipe(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"SHEESH_DATA_DIR": tmp}):
            root = Path(tmp)
            source_path = root / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "color=black:s=320x180:r=10:d=1", "-c:v", "libx264",
                            str(source_path)], check=True)
            client = TestClient(app, base_url="http://localhost")
            response = client.post("/api/sources", files={"file": ("source.mp4", source_path.read_bytes(), "video/mp4")})
            self.assertEqual(response.status_code, 200, response.text)
            frames = {}
            for style in (None, "clean", "bold", "minimal"):
                payload = edit(response.json()["id"])
                if style is not None:
                    payload["caption_style"] = style
                if style == "bold":
                    payload["clip_title"] = "  Hero moment  "
                result = client.post("/api/render", json=payload)
                self.assertEqual(result.status_code, 200, result.text)
                artifact_id = result.json()["id"]
                details = client.get("/api/artifacts/" + artifact_id)
                self.assertEqual(details.json()["edit"]["caption_style"], style or "clean")
                if style == "bold":
                    self.assertEqual(result.json()["clip_title"], "Hero moment")
                    self.assertEqual(details.json()["edit"]["clip_title"], "Hero moment")
                    self.assertIn("source-export-", result.json()["name"])
                    item = next(x for x in client.get("/api/artifacts").json() if x["id"] == artifact_id)
                    self.assertEqual(item["clip_title"], "Hero moment")
                clip = root / "exports" / (artifact_id + ".mp4")
                frame = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", "0.30", "-i", str(clip),
                                                 "-frames:v", "1", "-vf", "scale=320:180", "-pix_fmt",
                                                 "rgb24", "-f", "rawvideo", "-"])
                self.assertEqual(len(frame), 320 * 180 * 3)
                frames[style] = frame
            self.assertEqual(frames[None], frames["clean"])
            self.assertEqual(len(set(frames.values())), 3)
            white = lambda rgb: sum(r > 170 and g > 170 and b > 170
                                    for r, g, b in zip(rgb[::3], rgb[1::3], rgb[2::3]))
            yellow = lambda rgb: sum(r > 160 and g > 130 and b < 120
                                     for r, g, b in zip(rgb[::3], rgb[1::3], rgb[2::3]))
            self.assertGreater(white(frames["clean"]), white(frames["minimal"]))
            self.assertGreater(white(frames["minimal"]), 0)
            self.assertGreater(yellow(frames["bold"]), 50)
            self.assertEqual(yellow(frames["clean"]), 0)
