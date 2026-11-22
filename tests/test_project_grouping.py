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

    def test_title_refresh_is_explicit_and_updates_the_same_video_group(self):
        legacy_source = "a" * 32
        self.legacy(20, f"https://youtu.be/{VIDEO_A}", "vod",
                    [{"name": "video.mp4", "source_id": legacy_source}])
        old_record = self.source_record(legacy_source, "legacy VOD.mp4")
        new_job = self.publish(21, f"https://www.youtube.com/live/{VIDEO_A}", "live", ["chunk-00000000.mp4"])
        latest_source = new_job["outputs"][0]["source_id"]
        other = self.publish(22, f"https://www.youtube.com/watch?v={VIDEO_B}", "vod", ["video.mp4"])
        local_source = "c" * 32
        self.source_record(local_source, f"YouTube-{VIDEO_A}-name-is-not-proof.mp4")
        before = old_record.read_bytes()
        with patch.object(ingest, "spawn") as spawn:
            self.assertTrue(all("youtube_title" not in row for row in self.client.get("/api/sources").json()))
            self.assertEqual(422, self.client.post(f"/api/sources/{local_source}/youtube-title").status_code)
            self.assertEqual(404, self.client.post(f"/api/sources/{'f' * 32}/youtube-title").status_code)
            spawn.assert_not_called()
            spawn.return_value.returncode = 0
            spawn.return_value.communicate.return_value = (b'"  My\\nvideo \\u202e title \\ud83c\\udfae "\n', None)
            response = self.client.post(f"/api/sources/{legacy_source}/youtube-title")
            self.assertEqual(200, response.status_code, response.text)
            self.assertEqual({"source_id": legacy_source, "youtube_video_id": VIDEO_A,
                              "youtube_title": "My video title 🎮"}, response.json())
            command = spawn.call_args.args[0]
            self.assertEqual(f"https://www.youtube.com/watch?v={VIDEO_A}", command[-1])
            self.assertIn("--skip-download", command)
            self.assertIs(subprocess.DEVNULL, spawn.call_args.kwargs["stderr"])
            self.assertEqual(25, spawn.return_value.communicate.call_args.kwargs["timeout"])
            rows = {row["id"]: row for row in self.client.get("/api/sources").json()}
            self.assertEqual("My video title 🎮", rows[legacy_source]["youtube_title"])
            self.assertEqual("My video title 🎮", rows[latest_source]["youtube_title"])
            self.assertNotIn("youtube_title", rows[other["outputs"][0]["source_id"]])
            self.assertNotIn("youtube_title", rows[local_source])
            self.assertEqual("My video title 🎮", self.client.get(f"/api/ingest/{new_job['id']}").json()["youtube_title"])
            spawn.assert_called_once()
        self.assertEqual(before, old_record.read_bytes())
        self.assertEqual(self.fixture.read_bytes(), (self.root / "originals" / (legacy_source + ".mp4")).read_bytes())

    def test_title_refresh_timeout_and_failure_do_not_persist_or_echo_process_output(self):
        job = self.publish(21, f"https://youtu.be/{VIDEO_A}", "vod", ["video.mp4"])
        source_id = job["outputs"][0]["source_id"]
        path = f"/api/sources/{source_id}/youtube-title"
        with patch.object(ingest, "spawn") as spawn, patch.object(ingest, "terminate") as terminate:
            process = spawn.return_value
            process.communicate.side_effect = [subprocess.TimeoutExpired("private worker trace", 25), (b"", None)]
            response = self.client.post(path)
            self.assertEqual(504, response.status_code)
            self.assertNotIn("private worker trace", response.text)
            terminate.assert_called_once_with(process, kill=True)
            process.communicate.side_effect = None
            process.returncode = 1
            process.communicate.return_value = (b"private error details", None)
            failed = self.client.post(path)
            self.assertEqual(502, failed.status_code)
            self.assertNotIn("private error details", failed.text)
            with ingest.TITLE_LOOKUP_LOCK:
                self.assertEqual(409, self.client.post(path).status_code)
            self.assertEqual(2, spawn.call_count)
        self.assertIsNone(ingest.cached_youtube_title(self.root, VIDEO_A))
        self.assertNotIn("youtube_title", self.client.get("/api/sources").json()[0])

    def test_title_cache_keeps_case_distinct_ids_on_windows_filenames(self):
        self.assertEqual(VIDEO_A.casefold(), VIDEO_B.casefold())
        one = ingest.title_path(self.root, VIDEO_A)
        two = ingest.title_path(self.root, VIDEO_B)
        self.assertNotEqual(one.name.casefold(), two.name.casefold())
        ingest.cache_youtube_title(self.root, VIDEO_A, "Uppercase ID")
        ingest.cache_youtube_title(self.root, VIDEO_B, "Lowercase ID")
        self.assertEqual("Uppercase ID", ingest.cached_youtube_title(self.root, VIDEO_A))
        self.assertEqual("Lowercase ID", ingest.cached_youtube_title(self.root, VIDEO_B))
