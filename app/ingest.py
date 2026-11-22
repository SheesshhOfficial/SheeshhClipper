"""Public YouTube ingest. No cookies, authentication, or arbitrary URL inputs."""
import csv
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
from typing import Literal
import unicodedata
from urllib.parse import parse_qs, urlsplit
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from . import media

router = APIRouter(prefix="/api/ingest")
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
JOB_ID = re.compile(r"[0-9a-f]{32}")
CHUNK = re.compile(r"chunk-\d{8,}\.mp4")
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
TERMINAL = {"completed", "stopped", "failed"}
LOCK = threading.RLock()
ACTIVE = {}
TITLE_LOOKUP_LOCK = threading.Lock()
TITLE_SIDECAR = "youtube-title.jsonl"
TITLE_LIMIT = 8192
SEGMENT_SECONDS = 60
# Prefer capped renditions, then accept another HLS size; the segmenter
# still caps the editable output. Every branch requires picture and sound.
LIVE_FORMAT = (
    "b[protocol*=m3u8][height<=720]/"
    "bv[protocol*=m3u8][height<=720]+ba[protocol*=m3u8]/"
    "b[protocol*=m3u8]/bv[protocol*=m3u8]+ba[protocol*=m3u8]"
)
submit_auto_analysis = None


def canonical_youtube(value: str) -> str:
    if len(value) > 2048 or not value.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        raise ValueError("Enter a public HTTPS YouTube video URL")
    u = urlsplit(value)
    host = (u.hostname or "").lower()
    if u.scheme != "https" or host not in HOSTS or u.netloc.lower() != host or "\\" in value:
        raise ValueError("Only public HTTPS YouTube video URLs are supported")
    if host == "youtu.be":
        candidate = u.path.removeprefix("/")
    elif u.path == "/watch":
        ids = parse_qs(u.query, max_num_fields=32).get("v", [])
        candidate = ids[0] if len(ids) == 1 else ""
    else:
        m = re.fullmatch(r"/(?:live|shorts)/([A-Za-z0-9_-]{11})/?", u.path)
        candidate = m[1] if m else ""
    if not VIDEO_ID.fullmatch(candidate):
        raise ValueError("Enter a single YouTube video or livestream URL, not a channel or playlist")
    return f"https://www.youtube.com/watch?v={candidate}"


def youtube_video_id(url: str) -> str:
    """Use the same validated, case-sensitive identity as the downloader."""
    return canonical_youtube(url).partition("?v=")[2]


def output_source_id(job_id: str, filename: str) -> str:
    return uuid5(NAMESPACE_URL, f"sheeshhclipper/{job_id}/{filename}").hex


def legacy_source_video_ids(root: Path, source_ids: set[str]) -> dict[str, str]:
    """Link older source records to app-owned ingest metadata without rewriting it."""
    if not source_ids:
        return {}
    found = {}
    conflicts = set()
    for path in (root / "cache" / "ingest").glob("*.json"):
        if not JOB_ID.fullmatch(path.stem):
            continue
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(job, dict) or job.get("id") != path.stem or job.get("kind") not in ("vod", "live"):
                continue
            url = job.get("url")
            if not isinstance(url, str):
                continue
            video_id = youtube_video_id(url)
        except (OSError, ValueError):
            continue
        outputs = job.get("outputs")
        if not isinstance(outputs, list):
            continue
        for output in outputs:
            if not isinstance(output, dict):
                continue
            source_id = output.get("source_id")
            if source_id is None:
                filename = output.get("name")
                if isinstance(filename, str) and (CHUNK.fullmatch(filename) or
                                                   filename in {"video.mp4", "editing-proxy.mp4"}):
                    source_id = output_source_id(path.stem, filename)
            if isinstance(source_id, str) and source_id in source_ids:
                if source_id in found and found[source_id] != video_id:
                    conflicts.add(source_id)
                found[source_id] = video_id
    return {source_id: video_id for source_id, video_id in found.items() if source_id not in conflicts}


class Ingest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    kind: Literal["vod", "live"]
    auto_analyze: bool = False


def cache(root):
    folder = root / "cache" / "ingest"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def safe_youtube_title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    # Keep international title text and emoji, but remove control characters
    # and hidden directional overrides before displaying it.
    text = "".join(
        char if char in "\u200c\u200d" or unicodedata.category(char) not in {"Cc", "Cf", "Cs"}
        else (" " if char.isspace() else "") for char in value
    )
    return " ".join(text.split())[:200].strip() or None


def parse_youtube_title(data: bytes) -> str | None:
    if len(data) > TITLE_LIMIT:
        return None
    for line in data.splitlines():
        try:
            title = safe_youtube_title(json.loads(line))
        except (ValueError, UnicodeError):
            continue
        if title:
            return title
    return None


def title_path(root: Path, video_id: str) -> Path:
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Not a YouTube video ID")
    # Windows bind mounts may fold filename case; encoding the original
    # ASCII bytes preserves distinct case-sensitive YouTube IDs.
    return root / "cache" / "youtube-titles" / f"{video_id.encode('ascii').hex()}.json"


def cached_youtube_title(root: Path, video_id: str) -> str | None:
    try:
        record = json.loads(title_path(root, video_id).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    return safe_youtube_title(record.get("youtube_title")) if isinstance(record, dict) else None


def cache_youtube_title(root: Path, video_id: str, title: str) -> None:
    path = title_path(root, video_id)
    with LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        media.write_record(path, {"youtube_title": title})


def collect_download_title(root, job, folder):
    """Consume a title emitted by the same downloader, without inspecting its logs."""
    if job.get("youtube_title"):
        return
    try:
        with (folder / TITLE_SIDECAR).open("rb") as file:
            title = parse_youtube_title(file.read(TITLE_LIMIT + 1))
    except OSError:
        return
    if title:
        with LOCK:
            job["youtube_title"] = title
            try:
                cache_youtube_title(root, youtube_video_id(job["url"]), title)
                persist(root, job)
            except OSError:
                # Metadata is optional: a failed cache write must not stop video.
                pass


def directory(root, job):
    return root / ("downloads" if job["kind"] == "vod" else "live-chunks") / job["id"]


def persist(root, job):
    media.write_record(cache(root) / (job["id"] + ".json"), job)


def load(root, id):
    if not JOB_ID.fullmatch(id):
        raise HTTPException(404, "Ingest job not found")
    try:
        job = json.loads((cache(root) / (id + ".json")).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(404, "Ingest job not found") from exc
    if job["status"] not in TERMINAL and (root, id) not in ACTIVE:
        job.update(status="stopped", message="Interrupted when the app closed. Saved outputs are retained.")
    return job


def downloader_base(root):
    return ["yt-dlp", "--ignore-config", "--no-plugin-dirs", "--no-playlist",
            "--no-remote-components", "--no-js-runtimes", "--js-runtimes", "deno",
            "--cache-dir", str(cache(root) / "yt-dlp")]


def downloader(root, job, folder):
    base = downloader_base(root) + [
        "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2", "--no-progress",
        "--no-simulate", "--print-to-file", "before_dl:%(title)j",
        str(folder / TITLE_SIDECAR).replace("%", "%%"),
    ]
    if job["kind"] == "vod":
        base += ["--match-filter", "!is_live & !is_upcoming",
                 "-f", "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv+ba/b",
                 "--merge-output-format", "mp4/mkv", "-o", str(folder / "video.%(ext)s")]
    else:
        base += ["--match-filter", "is_live", "-f", LIVE_FORMAT, "-S", "res:720",
                 "--downloader", "ffmpeg", "--downloader-args", "ffmpeg_o:-f mpegts",
                 "-o", "-"]
    return [*base, "--", job["url"]]


def title_lookup_command(root: Path, video_id: str) -> list[str]:
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Not a YouTube video ID")
    return downloader_base(root) + [
        "--socket-timeout", "7", "--retries", "0", "--extractor-retries", "0",
        "--simulate", "--skip-download", "--quiet", "--no-warnings", "--print", "%(title)j",
        "--", f"https://www.youtube.com/watch?v={video_id}",
    ]


def refresh_youtube_title(root: Path, video_id: str) -> str:
    if not TITLE_LOOKUP_LOCK.acquire(blocking=False):
        raise HTTPException(409, "Another title lookup is running. Try again after it finishes.")
    try:
        try:
            process = spawn(title_lookup_command(root, video_id), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                result, _ = process.communicate(timeout=25)
            except subprocess.TimeoutExpired:
                terminate(process, kill=True)
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                raise HTTPException(504, "YouTube did not respond in time. Try finding the title again.") from None
        except FileNotFoundError:
            raise HTTPException(502, "YouTube title lookup needs yt-dlp in the local installation.") from None
        except (OSError, subprocess.SubprocessError):
            raise HTTPException(502, "Could not look up the YouTube title. Try again later.") from None
        title = parse_youtube_title(result) if process.returncode == 0 else None
        if not title:
            raise HTTPException(502, "Could not read this YouTube title. Check that the public video is still available.")
        try:
            cache_youtube_title(root, video_id, title)
        except OSError:
            raise HTTPException(507, "Could not save the YouTube title to the local data folder.") from None
        return title
    finally:
        TITLE_LOOKUP_LOCK.release()


def editing_compatible(path):
    # MP4 alone is insufficient: an AV1, VP9, or HEVC source may not play in
    # the user's browser. Keep the original file regardless of this decision.
    if path.suffix.lower() != ".mp4":
        return False
    try:
        info = media.probe(path)
        raw = subprocess.run(
            ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
             "-f", "mov", "-show_streams", "-of", "json", str(path)],
            capture_output=True, check=True, timeout=60,
        )
        streams = json.loads(raw.stdout)["streams"]
        video = next(s for s in streams if s["index"] == info["stream"])
        audio = next((s for s in streams if s["codec_type"] == "audio"), None)
        return (video["codec_name"] == "h264" and video.get("pix_fmt") == "yuv420p"
                and (audio is None or audio["codec_name"] == "aac"))
    except (ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        return False


def proxy_command(source, target):
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
            "-protocol_whitelist", "file,pipe", "-i", str(source),
            "-map", "0:V:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", "-threads", "2",
            "-preset", "veryfast", "-crf", "22", "-c:a", "aac",
            "-movflags", "+faststart", str(target)]


def segmenter(folder, seconds=SEGMENT_SECONDS):
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0",
            "-map", "0:a:0?", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "22",
            "-pix_fmt", "yuv420p", "-vf", "fps=30,scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-force_key_frames", f"expr:gte(t,n_forced*{seconds})",
            "-c:a", "aac", "-f", "segment", "-segment_time", str(seconds),
            "-reset_timestamps", "1", "-segment_list_type", "csv", "-segment_list",
            str(folder / "segments.csv"), str(folder / "chunk-%08d.mp4")]


def spawn(args, **kwargs):
    # Optional provider secrets do not belong in downloader/encoder children.
    private_keys = {"ASSEMBLYAI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "YOUTUBE_API_KEY"}
    env = {key: value for key, value in os.environ.items() if key not in private_keys}
    return subprocess.Popen(args, shell=False, start_new_session=(os.name == "posix"), env=env, **kwargs)


def terminate(process, *, kill=False):
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL if kill else signal.SIGTERM)
        elif kill:
            process.kill()
        else:
            process.terminate()
    except ProcessLookupError:
        pass


def wait_cancel(process, stop, *, on_poll=None):
    while process.poll() is None:
        if stop.wait(.25) or (on_poll is not None and on_poll() is False):
            terminate(process)
            try:
                return process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate(process, kill=True)
                return process.wait(timeout=5)
    return process.returncode


def request_auto_analysis(source_id: str, *, live: bool = False) -> dict:
    """Bridge an opt-in import to the local analysis worker without impairing ingest."""
    if submit_auto_analysis is None:
        return {"analysis_note": "Automatic analysis is unavailable. You can still edit this source."}
    try:
        job = submit_auto_analysis(source_id, clip_length=20 if live else 30, count=2 if live else 3,
                                   visual_motion=not live, queue_if_busy=not live)
        return {"analysis_id": job["id"]}
    except HTTPException as exc:
        if live and exc.status_code == 409:
            return {"analysis_note": "Analysis busy; open this source and analyze it manually."}
        if exc.status_code in (409, 429):
            return {"analysis_note": "Analysis queue is full; open this source and analyze it manually."}
    except Exception:
        pass
    return {"analysis_note": "Automatic analysis could not start. Your source was saved."}


def publish(root, job, path):
    if any(row["name"] == path.name for row in job["outputs"]):
        return
    try:
        info = media.probe(path)
    except (ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        return
    video_id = youtube_video_id(job["url"])
    name = f"YouTube-{video_id}-{job['id'][:8]}-{path.name}"
    id = output_source_id(job["id"], path.name)
    target = root / "originals" / (id + ".mp4")
    if not target.exists():
        temp = target.with_suffix(".ingest")
        try:
            try:
                os.link(path, temp)
            except OSError:
                shutil.copyfile(path, temp)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
    source = {"id": id, "name": name, "url": f"/api/sources/{id}/media", "youtube_video_id": video_id, **info}
    title = safe_youtube_title(job.get("youtube_title")) or cached_youtube_title(root, video_id)
    if title:
        source["youtube_title"] = title
    media.write_record(target.with_suffix(".json"), source)
    output = {"name": path.name, "source_id": id, "url": f"/api/ingest/{job['id']}/files/{path.name}"}
    if job.get("auto_analyze"):
        output.update(request_auto_analysis(id, live=job["kind"] == "live"))
    with LOCK:
        active_stop = ACTIVE.get((root, job["id"]))
        if active_stop and active_stop.is_set():
            job.update(status="stopping", message="Stopping capture/download")
        job["outputs"].append(output)
        persist(root, job)


def publish_live(root, job, folder, offset=0):
    # FFmpeg emits a row only after its MP4 trailer is closed. Read appended
    # rows incrementally to avoid rescanning the full history of a long live.
    try:
        with (folder / "segments.csv").open("rb") as f:
            f.seek(offset)
            while line := f.readline():
                if not line.endswith(b"\n"):
                    break
                row = next(csv.reader([line.decode("utf-8")]))
                name = (row[0] or "").split("/")[-1] if len(row) == 3 else ""
                if CHUNK.fullmatch(name):
                    publish(root, job, folder / name)
                offset = f.tell()
    except FileNotFoundError:
        pass
    return offset


def run(root, job, stop):
    processes = []
    code = -1
    message = "Could not ingest public YouTube media. Check the URL, video availability, and local tools."
    try:
        with LOCK:
            if not stop.is_set():
                job.update(status="running", message="Downloading video" if job["kind"] == "vod" else "Capturing live chunks")
                persist(root, job)
        if not stop.is_set():
            folder = directory(root, job)
            folder.mkdir(parents=True, exist_ok=True)
            with (folder / "ingest.log").open("ab") as logs:
                if job["kind"] == "vod":
                    p = spawn(downloader(root, job, folder), stdin=subprocess.DEVNULL,
                              stdout=logs, stderr=logs)
                    processes.append(p)
                    code = wait_cancel(p, stop, on_poll=lambda: collect_download_title(root, job, folder))
                    collect_download_title(root, job, folder)
                    if code == 0 and not stop.is_set():
                        origin = next((folder / f"video.{ext}" for ext in
                                       ("mp4", "mkv", "webm", "mov", "ts")
                                       if (folder / f"video.{ext}").is_file()), None)
                        if origin is not None:
                            if editing_compatible(origin):
                                publish(root, job, origin)
                            else:
                                with LOCK:
                                    if not stop.is_set():
                                        job.update(message="Original saved; building H.264 editing copy")
                                        persist(root, job)
                                proxy = folder / "editing-proxy.mp4"
                                if not stop.is_set():
                                    conv = spawn(proxy_command(origin, proxy), stdin=subprocess.DEVNULL,
                                                 stdout=logs, stderr=logs)
                                    processes.append(conv)
                                    code = wait_cancel(conv, stop)
                                    if code == 0 and proxy.is_file():
                                        publish(root, job, proxy)
                                    elif not stop.is_set():
                                        message = "The original download was retained, but its editing copy could not be created."
                else:
                    p = spawn(downloader(root, job, folder), stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=logs)
                    processes.append(p)
                    try:
                        encoder = spawn(segmenter(folder), stdin=p.stdout, stdout=logs, stderr=logs)
                        processes.append(encoder)
                    finally:
                        p.stdout.close()
                    offset = 0
                    def tick():
                        nonlocal offset
                        collect_download_title(root, job, folder)
                        offset = publish_live(root, job, folder, offset)
                        # A failed segmenter must not leave an indefinite downloader.
                        return encoder.poll() is None
                    code = wait_cancel(p, stop, on_poll=tick)
                    try:
                        enc_code = encoder.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        terminate(encoder)
                        try:
                            enc_code = encoder.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            terminate(encoder, kill=True)
                            enc_code = encoder.wait(timeout=5)
                    finally:
                        # Even after a timeout, already-finalized segments remain editable.
                        collect_download_title(root, job, folder)
                        publish_live(root, job, folder, offset)
                    if enc_code:
                        code = enc_code
                    if code and not job["outputs"] and not stop.is_set():
                        try:
                            with (folder / "ingest.log").open("rb") as detail:
                                detail.seek(max(0, os.fstat(detail.fileno()).st_size - 16384))
                                no_format = b"requested format is not available" in detail.read().lower()
                        except OSError:
                            no_format = False
                        if no_format:
                            message = ("YouTube did not expose a compatible public live HLS stream with video and audio. "
                                       "Try another active stream, or import a local MP4.")
    except FileNotFoundError:
        message = "Ingest requires yt-dlp/Deno and FFmpeg in the local installation."
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        for p in reversed(processes):
            terminate(p, kill=True)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        with LOCK:
            if stop.is_set():
                job.update(status="stopped", message="Stopped. Any saved outputs are retained.")
            elif code == 0 and job["outputs"]:
                job.update(status="completed", message="Ingest complete")
            else:
                job.update(status="failed", message=message)
            try:
                persist(root, job)
            finally:
                ACTIVE.pop((root, job["id"]), None)


@router.post("", status_code=202)
def start(request: Ingest):
    try:
        url = canonical_youtube(request.url)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    root = media.root()
    id = media.media_id()
    job = {"id": id, "url": url, "youtube_video_id": youtube_video_id(url), "kind": request.kind,
           "auto_analyze": request.auto_analyze, "status": "queued", "message": "Queued", "outputs": []}
    stop = threading.Event()
    with LOCK:
        if any(key[0] == root for key in ACTIVE):
            raise HTTPException(409, "Another ingest is in progress")
        persist(root, job)
        ACTIVE[root, id] = stop
        threading.Thread(target=run, args=(root, job, stop), daemon=True).start()
        return dict(job)


@router.get("")
def jobs():
    root = media.root()
    with LOCK:
        rows = [load(root, p.stem) for p in sorted(cache(root).glob("*.json"),
                                                   key=lambda f: f.stat().st_mtime, reverse=True)]
    titles = {}
    for row in rows:
        expose_job_title(root, row, titles)
    return rows


def expose_job_title(root, job, titles):
    """Decorate persisted jobs with cached same-video metadata, never a fetch."""
    try:
        video_id = youtube_video_id(job["url"])
    except (KeyError, TypeError, ValueError):
        return job
    if video_id not in titles:
        titles[video_id] = cached_youtube_title(root, video_id)
    title = titles[video_id] or safe_youtube_title(job.get("youtube_title"))
    if title:
        job["youtube_title"] = title
    else:
        job.pop("youtube_title", None)
    return job


@router.get("/{id}")
def status(id: str):
    root = media.root()
    with LOCK:
        job = load(root, id)
    return expose_job_title(root, job, {})


@router.post("/{id}/stop")
def stop_job(id: str):
    root = media.root()
    with LOCK:
        job = load(root, id)
        event = ACTIVE.get((root, id))
        if event and job["status"] not in TERMINAL:
            job.update(status="stopping", message="Stopping capture/download")
            persist(root, job)
            event.set()
        return job


@router.get("/{id}/files/{name}")
def output(id: str, name: str):
    root = media.root()
    with LOCK:
        job = load(root, id)
    if name not in {x["name"] for x in job["outputs"]}:
        raise HTTPException(404, "Output not found")
    return FileResponse(directory(root, job) / name, media_type="video/mp4")
