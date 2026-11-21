"""Stable YouTube grouping without changing imported media or source IDs."""
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import ingest, media
from app.main import app


VIDEO_A = "AaBbCcDdEe1"
VIDEO_B = "aaBbCcDdEe1"


class ProjectGrouping(TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        fixture = Path(scratch.name) / "fixture.mp4"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
            "color=c=gray:s=160x90:d=0.5:r=8",
            "-c:v", "libx264", str(fixture),
        ], check=True)
        self.fixture = fixture
        self.info = media.probe(fixture)
        env = patch.dict(os.environ, SHEESH_DATA_DIR=str(fixture.parent / "data"))
        env.start()
        self.addCleanup(env.stop)
        self.root = media.root()
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def publish(self, number, url, kind, files):
        job = {"id": f"{number:032x}", "url": url, "kind": kind,
               "status": "completed", "message": "done", "outputs": []}
        folder = ingest.directory(self.root, job)
        folder.mkdir(parents=True)
        for filename in files:
            path = folder / filename
            shutil.copyfile(self.fixture, path)
            ingest.publish(self.root, job, path)
        return job

    def legacy(self, number, url, kind, outputs):
        job = {"id": f"{number:032x}", "url": url, "kind": kind,
               "status": "stopped", "message": "retained", "outputs": outputs}
        ingest.persist(self.root, job)
        return job

    def source_record(self, source_id, name):
        media_file = self.root / "originals" / f"{source_id}.mp4"
        shutil.copyfile(self.fixture, media_file)
        source_record = media_file.with_suffix(".json")
        media.write_record(source_record, {"id": source_id, "name": name,
                           "url": f"/api/sources/{source_id}/media", **self.info})
        return source_record

    def test_variants_reimports_live_chunks_and_local_files(self):
        imports = [
            self.publish(1, f"https://www.youtube.com/watch?v={VIDEO_A}&t=5", "vod", ["video.mp4"]),
            self.publish(2, f"https://youtu.be/{VIDEO_A}?si=test", "vod", ["video.mp4"]),
            self.publish(3, f"https://www.youtube.com/live/{VIDEO_A}", "live",
                         ["chunk-00000000.mp4", "chunk-00000001.mp4"]),
            self.publish(4, f"https://m.youtube.com/shorts/{VIDEO_B}", "vod", ["editing-proxy.mp4"]),
        ]
        local = []
        for _ in range(2):
            response = self.client.post("/api/sources", files={
                "file": (f"YouTube-{VIDEO_A}-00000001-video.mp4", self.fixture.read_bytes(), "video/mp4")})
            self.assertEqual(200, response.status_code, response.text)
            local.append(response.json())
        self.assertNotEqual(local[0]["project_key"], local[1]["project_key"])
        response = self.client.get("/api/sources")
        self.assertEqual(200, response.status_code, response.text)
        sources = {row["id"]: row for row in response.json()}
        grouped = [item["source_id"] for job in imports[:3] for item in job["outputs"]]
        self.assertEqual(4, len(set(grouped)))
        for source_id in grouped:
            row = sources[source_id]
            self.assertEqual(f"youtube:{VIDEO_A}", row["project_key"], row)
            self.assertEqual(VIDEO_A, row["youtube_video_id"])
            result = self.client.get(row["url"])
            self.assertEqual(200, result.status_code)
            self.assertEqual(self.fixture.read_bytes(), result.content)
        other = sources[imports[3]["outputs"][0]["source_id"]]
        self.assertEqual(f"youtube:{VIDEO_B}", other["project_key"])
        for row in local:
            self.assertEqual(row, sources[row["id"]])
            self.assertEqual(f"local:{row['id']}", row["project_key"])
            self.assertNotIn("youtube_video_id", row)

    def test_legacy_source_provenance_is_read_only_and_never_guessed_from_filename(self):
        explicit = "a" * 32
        legacy_live_id = f"{21:032x}"
        inferred = ingest.output_source_id(legacy_live_id, "chunk-00000002.mp4")
        unverified = "c" * 32
        self.legacy(20, f"https://www.youtube.com/watch?v={VIDEO_A}", "vod",
                    [{"name": "video.mp4", "source_id": explicit}])
        self.legacy(21, f"https://youtu.be/{VIDEO_A}", "live", [{"name": "chunk-00000002.mp4"}])
        self.legacy(22, f"https://www.youtube.com.evil.invalid/watch?v={VIDEO_A}", "vod",
                    [{"name": "video.mp4", "source_id": unverified}])
        (ingest.cache(self.root) / (f"{23:032x}.json")).write_text("{broken", encoding="utf-8")
        records = [
            self.source_record(explicit, "legacy VOD.mp4"),
            self.source_record(inferred, "legacy chunk.mp4"),
            self.source_record(unverified, f"YouTube-{VIDEO_A}-00000001-video.mp4"),
        ]
        before = [record.read_bytes() for record in records]
        response = self.client.get("/api/sources")
        self.assertEqual(200, response.status_code, response.text)
        rows = {row["id"]: row for row in response.json()}
        self.assertEqual(f"youtube:{VIDEO_A}", rows[explicit]["project_key"])
        self.assertEqual(rows[explicit]["project_key"], rows[inferred]["project_key"])
        self.assertEqual(f"local:{unverified}", rows[unverified]["project_key"])
        self.assertNotIn("youtube_video_id", rows[unverified])
        self.assertEqual(before, [record.read_bytes() for record in records])
