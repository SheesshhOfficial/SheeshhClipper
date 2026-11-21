"""Offline tests of highlights, background analysis and caption providers."""
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import analysis_engine as analysis, media


class AnalysisTest(unittest.TestCase):
    def setUp(self):
        self.scratch = TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        overrides = patch.dict(os.environ, SHEESH_DATA_DIR=self.scratch.name, ASSEMBLYAI_API_KEY="")
        overrides.start()
        self.addCleanup(overrides.stop)
        self.source_id = "a" * 32
        self.root = media.root()
        self.file = self.root / "originals" / (self.source_id + ".mp4")
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=8",
            "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=8000",
            "-af", "volume=0.015+0.985*between(t\\,5\\,8)+0.985*between(t\\,18\\,21):eval=frame",
            "-t", "27", "-c:v", "libx264", "-c:a", "aac", str(self.file),
        ], check=True)
        media.write_record(self.file.with_suffix(".json"), media.probe(self.file))
        self.lock = Lock()
        self.drafts = []
        app = FastAPI()
        self.router = analysis.make_router(self.lock, self.draft_callback)
        app.include_router(self.router)
        with_test_client = TestClient(app)
        self.client = with_test_client.__enter__()
        self.addCleanup(with_test_client.__exit__, None, None, None)

    def draft_callback(self, source_id, suggestion):
        self.assertEqual(self.source_id, source_id)
        self.assertTrue(self.lock.locked())
        self.drafts.append(suggestion["start"])
        return {"id": "b" * 32, "kind": "draft"}

    def ready(self, job_id):
        for _ in range(120):
            body = self.client.get("/api/analysis/" + job_id).json()
            if body["status"] in {"completed", "failed", "interrupted"}:
                return body
            time.sleep(.025)
        self.fail("Analysis did not reach a terminal state")

    def test_local_audio_picks_both_bursts_and_saves_draft_references(self):
        spectrum = analysis.audio_activity(self.file, 27)
        self.assertEqual(27, len(spectrum))
        self.assertGreater(spectrum[6], spectrum[0] + 20)
        self.assertGreater(spectrum[19], spectrum[12] + 20)
        response = self.client.post("/api/analysis", json={
            "source_id": self.source_id, "clip_length": 7, "count": 3})
        self.assertEqual(202, response.status_code)
        job = self.ready(response.json()["id"])
        self.assertEqual("completed", job["status"], job)
        self.assertEqual(2, len(job["suggestions"]))
        self.assertEqual(2, len(self.drafts))
        for timepoint in (6, 19):
            self.assertTrue(any(s["start"] < timepoint < s["end"] for s in job["suggestions"]))
        for suggestion in job["suggestions"]:
            self.assertIn("audio", suggestion["reason"].lower())
            self.assertEqual("draft", suggestion["draft"]["kind"])
        self.assertTrue((analysis.analysis_dir() / (job["id"] + ".json")).is_file())
        self.assertEqual([job["id"]], [item["id"] for item in self.client.get(
            f"/api/analysis?source_id={self.source_id}").json()])

    def test_cloud_consent_busy_and_captions_scope(self):
        with patch.dict(os.environ, ASSEMBLYAI_API_KEY="not-a-real-key"):
            self.assertTrue(self.client.get("/api/analysis/providers").json()["assemblyai"]["available"])
            spec = {"source_id": self.source_id, "provider": "assemblyai", "language": "hinglish"}
            with patch.object(analysis, "assembly_captions", return_value=[
                {"start": 4, "end": 7, "text": "भाई kya chase"}, {"start": 8, "end": 10, "text": "Look <here>"}]) as cloud:
                self.assertEqual(400, self.client.post("/api/analysis", json=spec).status_code)
                cloud.assert_not_called()
                with self.lock:
                    self.assertEqual(409, self.client.post(
                        "/api/analysis", json={**spec, "allow_cloud": True}).status_code)
                cloud.assert_not_called()
                response = self.client.post("/api/analysis", json={**spec, "allow_cloud": True})
                self.assertEqual(202, response.status_code)
                data = self.ready(response.json()["id"])
                self.assertEqual("completed", data["status"], data)
                cloud.assert_called_once()
            self.assertEqual("bhai kya chase", data["captions"][0]["text"])
            self.assertTrue((analysis.analysis_dir() / (data["id"] + ".vtt")).is_file())
            self.assertNotIn("not-a-real-key", str(data))
            self.assertEqual(data["captions"], analysis.captions_for(self.source_id, data["id"]))
            with self.assertRaises(HTTPException):
                analysis.captions_for("c" * 32, data["id"])
            track = self.client.get(data["captions_url"] + "?start=5&end=9")
            self.assertEqual(200, track.status_code, track.text)
            self.assertIn("00:00:00.000 --> 00:00:02.000", track.text)
            self.assertIn("00:00:03.000 --> 00:00:04.000", track.text)
            self.assertIn("&lt;here&gt;", track.text)
            self.assertEqual(422, self.client.get(data["captions_url"] + "?end=99").status_code)

    def test_assembly_model_and_word_joining_with_fake_responses(self):
        with patch.object(analysis, "_assembly_request", side_effect=[
            {"upload_url": "https://cdn.example.invalid/recording.flac"},
            {"status": "completed", "id": "remote-transcript-123", "words": [
                 {"start": 100, "end": 200, "text": "Look"},
                 {"start": 250, "end": 330, "text": "भाई"},
                 {"start": 1400, "end": 1900, "text": "chase!"}]}]) as api:
            cues = analysis.assembly_captions(Path("unused.flac"), "hinglish", "not-a-real-key")
            self.assertEqual(2, len(cues))
            self.assertEqual("Look भाई", cues[0]["text"])
            self.assertEqual(.1, cues[0]["start"])
            payload = api.call_args_list[1].kwargs["payload"]
            self.assertEqual(["assemblyai-stt-3-7"], payload["speech_models"])
            self.assertTrue(payload["language_detection"])

    def test_trusted_local_submit_never_queues_or_calls_cloud(self):
        with self.lock, self.assertRaises(HTTPException) as busy:
            self.router.submit_local_analysis(self.source_id)
        self.assertEqual(409, busy.exception.status_code)
        with patch.object(analysis, "assembly_captions") as cloud:
            job = self.router.submit_local_analysis(self.source_id, clip_length=7)
            data = self.ready(job["id"])
            self.assertEqual("completed", data["status"], data)
            self.assertEqual("audio", data["provider"])
            self.assertFalse(data["visual_motion"])
            cloud.assert_not_called()

    def test_opted_finite_analysis_waits_fifo_and_is_bounded(self):
        sources = [self.source_id]
        for i in range(1, analysis.MAX_PENDING_LOCAL):
            source_id = f"{i:032x}"
            source_file = self.file.with_name(source_id + ".mp4")
            source_file.write_bytes(self.file.read_bytes())
            media.write_record(source_file.with_suffix(".json"), media.probe(source_file))
            sources.append(source_id)

        executed = []

        def observed_audio(source, duration):
            self.assertTrue(self.lock.locked())
            executed.append(source.stem)
            return []

        with patch.object(analysis, "audio_activity", side_effect=observed_audio), \
                patch.object(analysis, "motion_activity", return_value=[]) as motion, \
                patch.object(analysis, "assembly_captions") as cloud:
            with self.lock:
                jobs = [self.router.submit_local_analysis(source_id, queue_if_busy=True,
                                                         visual_motion=(idx == 0))
                        for idx, source_id in enumerate(sources)]
                self.assertEqual([], executed)
                for job in jobs:
                    got = self.client.get("/api/analysis/" + job["id"]).json()
                    self.assertEqual("queued", got["status"])
                    self.assertIn("Waiting", got["message"])
                    self.assertEqual("audio", got["provider"])
                with self.assertRaises(HTTPException) as full:
                    self.router.submit_local_analysis(self.source_id, queue_if_busy=True)
                self.assertEqual(409, full.exception.status_code)
                self.assertIn("full", full.exception.detail)
                with self.assertRaises(HTTPException) as busy:
                    self.router.submit_local_analysis(self.source_id)
                self.assertEqual(409, busy.exception.status_code)
                self.assertEqual(409, self.client.post("/api/analysis", json={
                    "source_id": self.source_id, "provider": "audio"}).status_code)

                # A fresh router has no in-memory queue and never silently
                # restarts an automation from the persisted job record.
                restart = FastAPI()
                restart.include_router(analysis.make_router(Lock()))
                with TestClient(restart) as after_restart:
                    stale = after_restart.get("/api/analysis/" + jobs[0]["id"]).json()
                    self.assertEqual("interrupted", stale["status"])
                    self.assertEqual([], executed)
            for job in jobs:
                result = self.ready(job["id"])
                self.assertEqual("completed", result["status"], result)
            self.assertEqual(sources, executed)
            motion.assert_called_once()
            cloud.assert_not_called()

    def test_visual_motion_detects_moving_region_but_not_flash_or_cut(self):
        sample = self.file.with_name("motion_fixture.mp4")
        inputs = [
            "color=c=gray:s=160x90:r=8:d=6",
            "testsrc2=s=160x90:r=8:d=6",
            "color=c=gray:s=160x90:r=8:d=6",
            "color=c=white:s=160x90:r=8:d=0.5",
            "color=c=gray:s=160x90:r=8:d=4",
            "color=c=black:s=160x90:r=8:d=4",
        ]
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error",
                        *(opt for source in inputs for opt in ("-f", "lavfi", "-i", source)),
                        "-filter_complex", "concat=n=6:v=1:a=0",
                        "-c:v", "libx264", str(sample)], check=True)
        sample.replace(self.file)
        info = media.probe(self.file)
        media.write_record(self.file.with_suffix(".json"), info)
        evidence = analysis.motion_activity(self.file, info["duration"])
        self.assertTrue(all(v >= .3 for v in evidence[7:11]))
        self.assertEqual(0, max(evidence[:5] + evidence[13:]))
        response = self.client.post("/api/analysis", json={
            "source_id": self.source_id, "clip_length": 5, "count": 5, "visual_motion": True})
        self.assertEqual(202, response.status_code)
        data = self.ready(response.json()["id"])
        self.assertTrue(data["visual_motion"])
        clip, = data["suggestions"]
        self.assertLess(clip["start"], 9)
        self.assertGreater(clip["end"], 9)
        self.assertIn("Sustained visual change", clip["reason"])
        self.assertNotIn("chase", clip["reason"])
        self.assertGreater(clip["score"], 0)

    def test_visual_false_peaks_and_uniform_busy_footage_do_not_rank(self):
        for differences in ([0] * 10 + [99, 99] + [0] * 20,
                            [9] * 60,
                            [0, 9] * 25):
            duration = len(differences) / analysis.MOTION_FPS
            evidence = analysis.sustained_motion(differences, duration)
            self.assertEqual(0, max(evidence))
            clip, = analysis.suggestions_for([], [], duration, 5, 5, evidence)
            self.assertEqual(0, clip["score"])
            self.assertIn("visual", clip["reason"])

    def test_missing_audio_and_empty_inputs_are_not_invented(self):
        no_audio = self.root / "noaudio.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.file),
                        "-t", "1", "-map", "0:v:0", "-c", "copy", str(no_audio)], check=True)
        self.assertEqual([], analysis.audio_activity(no_audio, 1))
        result = analysis.suggestions_for([], [], 1, 20, 5)
        self.assertEqual(0, result[0]["score"])
        self.assertIn("no strong", result[0]["reason"])


if __name__ == "__main__":
    unittest.main()
