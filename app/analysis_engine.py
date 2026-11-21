"""Local highlight analysis and opt-in speech transcription."""
from __future__ import annotations

from collections import Counter
from html import escape
from importlib.util import find_spec
import json
import math
import os
from pathlib import Path
import re
from statistics import median
import subprocess
from threading import Lock, Thread
from time import monotonic, sleep, time
from typing import Callable, Literal
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from . import media

IDENTIFIER = re.compile(r"[0-9a-f]{32}")
ASSEMBLY_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
ASSEMBLY_API = "https://api.assemblyai.com"
LANGUAGE = Literal["english", "hinglish"]
PROVIDER = Literal["audio", "whisper", "assemblyai"]


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    provider: PROVIDER = "audio"
    language: LANGUAGE = "english"
    allow_cloud: StrictBool = False
    visual_motion: StrictBool = False
    clip_length: float = Field(default=30, ge=5, le=120)
    count: int = Field(default=5, ge=1, le=12)


def analysis_dir() -> Path:
    path = media.root() / "transcripts" / "analysis"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_job(job_id: str) -> dict:
    if not IDENTIFIER.fullmatch(job_id):
        raise HTTPException(404, "Analysis not found")
    try:
        return json.loads((analysis_dir() / f"{job_id}.json").read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(404, "Analysis not found") from exc


def captions_for(source_id: str, job_id: str) -> list[dict]:
    """Return completed captions in source-time coordinates after source match."""
    item = _read_job(job_id)
    if item["source_id"] != source_id:
        raise HTTPException(404, "Analysis not found for this source")
    if item["status"] != "completed":
        raise HTTPException(409, "Caption analysis is not complete")
    return item["captions"]


def vtt_time(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def make_vtt(captions: list[dict], start: float, end: float) -> str:
    entries = ["WEBVTT", ""]
    for cue in captions:
        a, b = max(start, cue["start"]), min(end, cue["end"])
        if round((b - start) * 1000) <= round((a - start) * 1000):
            continue
        safe = escape(" ".join(cue["text"].split()), quote=False)
        if safe:
            entries += [f"{vtt_time(a-start)} --> {vtt_time(b-start)}", safe, ""]
    return "\n".join(entries) + "\n"


def _input(source: Path, extra: tuple[str, ...] = ()) -> list[str]:
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-protocol_whitelist", "file,pipe", "-f", "mov", *extra, "-i", str(source)]


def audio_activity(source: Path, duration: float) -> list[float]:
    """One RMS level per source second; silence is represented as -95 dBFS."""
    # Use a fixed sample rate/frame length so this remains compact for long recordings.
    key = "lavfi.astats.Overall.RMS_level"
    afilter = ("aresample=8000,asetnsamples=n=8000:p=0,"
               "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,"
               f"ametadata=mode=print:key={key}:file=-")
    output = subprocess.run(
        [*_input(source), "-map", "0:a:0", "-vn", "-af", afilter, "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    if output.returncode != 0:
        if "does not contain any stream" in output.stderr or "matches no streams" in output.stderr:
            return []
        raise ValueError("FFmpeg could not analyze the source audio")
    result = [-95.0] * max(1, math.ceil(duration))
    # PTS is already the source-relative presentation timeline, even when audio
    # starts after video. Some demuxers can report a very small negative preroll.
    pattern = re.compile(r"pts_time:(-?[0-9.]+)\s*\n" + re.escape(key) + r"=([^\s]+)")
    for match in pattern.finditer(output.stdout):
        timestamp, value = map(float, match.groups())
        if math.isfinite(timestamp) and math.isfinite(value):
            index = round(timestamp)
            if 0 <= index < len(result):
                result[index] = max(-95.0, min(0.0, value))
    return result


MOTION_FPS = 2


def motion_activity(source: Path, duration: float) -> list[float]:
    """Low-cost luma differences, normalized to one bounded motion cue per second."""
    prefix = "lavfi.signalstats."
    vf = (f"fps={MOTION_FPS},scale=96:54:flags=area,format=yuv420p,signalstats,"
          f"metadata=mode=print:key={prefix}YDIF:file=-:direct=1,"
          f"metadata=mode=print:key={prefix}YAVG:file=-:direct=1")
    output = subprocess.run(
        [*_input(source, ("-threads", "2", "-filter_threads", "1")),
         "-map", "0:V:0", "-an", "-sn", "-dn", "-vf", vf, "-f", "null", "-"],
        capture_output=True, text=True, check=True, timeout=7200,
    )
    samples: dict[int, dict[str, float]] = {}
    pattern = re.compile(r"pts_time:(-?[0-9.]+)\s*\n" + re.escape(prefix) + r"(YDIF|YAVG)=([^\s]+)")
    for timestamp, name, raw in pattern.findall(output.stdout):
        t, value = float(timestamp), float(raw)
        if math.isfinite(t) and math.isfinite(value) and 0 <= t <= duration:
            samples.setdefault(round(t * MOTION_FPS), {})[name] = value
    if not samples:
        return [0.0] * max(1, math.ceil(duration))

    adjusted = [0.0] * (max(samples) + 1)
    for half_second, item in samples.items():
        previous = samples.get(half_second - 1, {})
        diff, mean, old_mean = item.get("YDIF"), item.get("YAVG"), previous.get("YAVG")
        if diff is not None and mean is not None and old_mean is not None:
            # A uniform flash/fade mostly changes global luminance. Discount
            # that component before scoring spatial change.
            adjusted[half_second] = max(0.0, diff - abs(mean - old_mean) * .9)

    return sustained_motion(adjusted, duration)


def sustained_motion(differences: list[float], duration: float) -> list[float]:
    """Ignore isolated peaks and compensate for naturally busy footage."""
    result = [0.0] * max(1, math.ceil(duration))
    if not differences:
        return result
    baseline = median(differences)
    threshold = max(2.0, baseline * 1.20 + .8)
    scale = max(7.0, baseline * 1.10)
    # Require three consecutive half-second differences. A solitary cut or an
    # on/off flash can change up to two samples, but should not rank on motion.
    for i in range(1, len(differences) - 1):
        sustained = min(differences[i - 1:i + 2])
        strength = min(1.0, max(0.0, (sustained - threshold) / scale))
        second = min(len(result) - 1, i // MOTION_FPS)
        result[second] = max(result[second], strength)
    return result


KEYWORDS = (
    ("chase", r"\b(?:chase|chasing|pursuit|escape|escaped|run away|bhago|pakad\w*)\b"),
    ("combat", r"\b(?:shoot\w*|shot|kill\w*|sniper|gunfight|explod\w*|explosion|dhama\w*|maar\w*|goli)\b"),
    ("high stakes", r"\b(?:heist|clutch|mission (?:complete|failed)|one hp|wanted level|five stars?)\b"),
    ("reaction", r"\b(?:what the hell|oh my god|no way|bro what|holy shit|arey|arre|bhai kya|kya baat)\b"),
)


def suggestions_for(levels: list[float], captions: list[dict], duration: float,
                    clip_length: float, count: int, motion: list[float] | None = None) -> list[dict]:
    """Pick separated windows using audio, timestamped speech and optional motion."""
    bins = max(1, math.ceil(duration))
    loud = [value for value in levels if value > -65]
    baseline = max(-75.0, median(loud) if loud else -75.0)
    audio = [0.0] * bins
    rises = [0.0] * bins
    for idx, current in enumerate(levels[:bins]):
        # An isolated yell, crash or gunshot can matter even if most of the
        # recording is silent. Never claim semantic context from loudness alone.
        if current <= -65:
            continue
        audio[idx] = min(1.0, max(0.0, (current - baseline + 2) / 20))
        previous = levels[idx - 1] if idx else baseline
        rises[idx] = min(1.0, max(0.0, (current - max(previous, -72) - 5) / 24))
    signals = [0.0] * bins
    tags: dict[int, Counter] = {}
    speech = [False] * bins
    for cue in captions:
        a = min(bins - 1, max(0, int(cue["start"])))
        b = min(bins, max(a + 1, math.ceil(cue["end"])))
        for idx in range(a, b):
            speech[idx] = True
        match = [label for label, pattern in KEYWORDS if re.search(pattern, cue["text"], re.I)]
        if match:
            target = min(bins - 1, max(a, int((cue["start"] + cue["end"]) / 2)))
            signals[target] = min(1.0, signals[target] + 0.55 + .12 * (len(match) - 1))
            tags.setdefault(target, Counter()).update(match)
    visual = [v if v >= .30 else 0.0 for v in (motion or [])[:bins]]
    visual.extend([0.0] * (bins - len(visual)))
    nonvisual = [.42 * a + .30 * r + .50 * t for a, r, t in zip(audio, rises, signals)]
    scores = [v + .28 * m for v, m in zip(nonvisual, visual)]
    size = min(duration, clip_length)
    last_start = max(0.0, duration - size)

    # One motion-only anchor per short continuous burst. Long sustained events
    # can nominate distinct sections at roughly the requested clip interval.
    anchors = set()
    left = 0
    while left < bins:
        if not visual[left]:
            left += 1
            continue
        right = left + 1
        while right < bins and visual[right]:
            right += 1
        step = max(6, math.ceil(size * 1.5))
        for first in range(left, right, step):
            limit = min(right, first + step)
            center = (first + limit - 1) / 2
            anchors.add(max(range(first, limit), key=lambda i: (scores[i], -abs(i - center), -i)))
        left = right
    ranked = sorted((i for i, score in enumerate(scores)
                     if score > .08 and (nonvisual[i] > .08 or i in anchors)),
                    key=lambda idx: (-scores[idx], idx))
    selected: list[dict] = []
    for idx in ranked:
        start = max(0.0, min(last_start, idx + .5 - size * .38))
        end = start + size
        if any(min(end, clip["end"]) - max(start, clip["start"]) > .20 * size
               for clip in selected):
            continue
        left = max(0, int(start))
        right = min(bins, max(left + 1, math.ceil(end)))
        indices = range(left, right)
        reasons = []
        if max(rises[left:right], default=0) > .30:
            reasons.append("Sharp audio rise")
        elif max(audio[left:right], default=0) > .16:
            reasons.append("Above-baseline audio activity")
        matches: Counter = Counter()
        for i in indices:
            matches.update(tags.get(i, {}))
        if matches:
            reasons.append("Transcript mentions " + ", ".join(label for label, _ in matches.most_common(2)))
        elif any(speech[left:right]):
            reasons.append("Contains transcribed dialogue")
        if max(visual[left:right], default=0) >= .30:
            reasons.append("Sustained visual change above this video's baseline")
        if not reasons:
            reasons.append("Audio activity near this time")
        # Heuristic ranking, not a probability or guarantee of clip quality.
        score = min(100.0, 100 * min(1, scores[idx] +
                                      .14 * sum(scores[left:right]) / max(1, right - left)))
        selected.append({"start": round(start, 3), "end": min(duration, round(end, 3)),
                         "score": round(score, 1), "reason": "; ".join(reasons)})
        if len(selected) >= count:
            break
    if not selected:
        # Don't fabricate highlights for quiet/silent/flat footage. Preserve
        # a reviewable starter window and explain the absence of a signal.
        signals_checked = "audio, transcript or visual" if motion is not None else "audio or transcript"
        selected.append({"start": 0, "end": size, "score": 0,
                         "reason": f"Manual review window; no strong {signals_checked} cue found"})
    return selected


_VOWELS = dict(zip("अआइईउऊऋएऐओऔऑ", ("a","aa","i","ee","u","oo","ri","e","ai","o","au","o")))
_MATRAS = dict(zip("ािीुूृेैोौॉ", ("aa","i","ee","u","oo","ri","e","ai","o","au","o")))
_CONSONANTS = dict(zip("कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसहळक़ख़ग़ज़ड़ढ़फ़",
    ("k","kh","g","gh","ng","ch","chh","j","jh","ny","t","th","d","dh","n","t","th","d","dh","n",
     "p","ph","b","bh","m","y","r","l","v","sh","sh","s","h","l","q","kh","gh","z","r","rh","f")))
_NUKTA = dict(zip("कखगजडढफय", ("q", "kh", "gh", "z", "r", "rh", "f", "y")))
_COMMON = {"मैं":"main","हूं":"hoon","हूँ":"hoon","है":"hai","हैं":"hain","में":"mein",
           "नहीं":"nahin","हां":"haan","हाँ":"haan","भाई":"bhai","क्या":"kya","गया":"gaya",
           "कर":"kar","करना":"karna","गाड़ी":"gaadi","गाडी":"gaadi","इसलिए":"isliye",
           "अच्छा":"achha","अरे":"arre","चलो":"chalo","करो":"karo","तुम":"tum","और":"aur"}


def roman_hindi(text: str) -> str:
    """Best-effort Roman Hindi; preserves original English words as spoken."""
    def convert(match):
        word = match.group()
        if word in _COMMON:
            return _COMMON[word]
        pieces = []
        i = 0
        while i < len(word):
            char = word[i]
            i += 1
            if char in _CONSONANTS:
                onset = _CONSONANTS[char]
                if i < len(word) and word[i] == "़":
                    onset = _NUKTA.get(char, onset)
                    i += 1
                following = word[i] if i < len(word) else ""
                if following in _MATRAS:
                    onset += _MATRAS[following]
                    i += 1
                elif following == "्":
                    i += 1
                elif following:
                    onset += "a"
                pieces.append(onset)
            elif char in _VOWELS:
                pieces.append(_VOWELS[char])
            elif char in "ंँ":
                pieces.append("n")
            elif char == "ः":
                pieces.append("h")
            elif char in "।॥":
                pieces.append(".")
            elif "०" <= char <= "९":
                pieces.append(str(ord(char) - ord("०")))
            else:
                pieces.append(char)
        return "".join(pieces)
    return re.sub(r"[\u0900-\u097f]+", convert, text)


def _captions(candidates: list[dict], duration: float, language: LANGUAGE) -> list[dict]:
    cues = []
    for item in candidates:
        try:
            start, end = float(item["start"]), float(item["end"])
            text = " ".join(str(item["text"]).split())
        except (TypeError, KeyError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)) or not text:
            continue
        if language == "hinglish":
            text = roman_hindi(text)
        start, end = max(0, start), min(end, duration)
        if end - start >= .02 and text.strip():
            cues.append({"start": round(start, 3), "end": min(duration, round(end, 3)),
                         "text": text[:1000]})
    return sorted(cues, key=lambda cue: (cue["start"], cue["end"]))


def _word_cues(words) -> list[dict]:
    """Avoid long subtitles by chunking at punctuation, pauses and ~42 characters."""
    result, phrases = [], []
    start = end = 0.0
    chars = 0
    for a, b, token in words:
        token = token.strip()
        if not token or not math.isfinite(a) or not math.isfinite(b) or b <= a:
            continue
        if phrases and (a - end >= .7 or b - start > 4 or chars + len(token) + 1 > 44):
            result.append({"start": start, "end": end, "text": " ".join(phrases)})
            phrases, chars = [], 0
        if not phrases:
            start = a
        end = b
        phrases.append(token)
        chars += len(token) + 1
        if token.endswith((".", "?", "!", "।")) and len(phrases) >= 3:
            result.append({"start": start, "end": end, "text": " ".join(phrases)})
            phrases, chars = [], 0
    if phrases:
        result.append({"start": start, "end": end, "text": " ".join(phrases)})
    return result


def whisper_captions(source: Path, language: LANGUAGE) -> list[dict]:
    from faster_whisper import WhisperModel

    model_dir = media.root() / "models" / "whisper"
    model_dir.mkdir(parents=True, exist_ok=True)
    local_audio = source if source.suffix == ".flac" else None
    if local_audio is None:
        raise ValueError("Whisper requires locally decoded audio")
    model = WhisperModel("base", device="cpu", compute_type="int8", download_root=str(model_dir),
                         cpu_threads=min(6, os.cpu_count() or 1))
    # Transcribe as spoken; never use translate. Auto/multilingual decoding can
    # miss a switch within an utterance, so the UI should not promise exact text.
    options = {"language": "en"} if language == "english" else {"multilingual": True}
    segments, _ = model.transcribe(str(local_audio), task="transcribe", vad_filter=True,
                                   word_timestamps=True, **options)
    result = []
    for segment in segments:
        if segment.words:
            result.extend(_word_cues((w.start, w.end, w.word) for w in segment.words))
        else:
            result.append({"start": segment.start, "end": segment.end, "text": segment.text})
    return result


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _assembly_request(path: str, key: str, *, payload: dict | None = None,
                      upload: Path | None = None) -> dict:
    """Fixed HTTPS service endpoint; never forwards credentials to redirects."""
    request_args = {"headers": {"Authorization": key, "Accept": "application/json"}}
    if payload is not None:
        request_args["data"] = json.dumps(payload).encode()
        request_args["headers"]["Content-Type"] = "application/json"
    client = build_opener(_NoRedirect())
    try:
        if upload:
            request_args["headers"].update({"Content-Type": "application/octet-stream",
                                             "Content-Length": str(upload.stat().st_size)})
            with upload.open("rb") as handle:
                with client.open(Request(ASSEMBLY_API + path, data=handle, **request_args),
                                 timeout=120) as response:
                    return json.load(response)
        with client.open(Request(ASSEMBLY_API + path, **request_args), timeout=30) as response:
            return json.load(response)
    except HTTPError as exc:
        raise ValueError(f"AssemblyAI returned HTTP {exc.code}") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError("Could not read a response from AssemblyAI") from None


def assembly_captions(audio: Path, language: LANGUAGE, key: str) -> list[dict]:
    upload = _assembly_request("/v2/upload", key, upload=audio)
    audio_url = upload.get("upload_url")
    if not isinstance(audio_url, str) or not audio_url.startswith("https://"):
        raise ValueError("AssemblyAI did not return an upload reference")
    model = {"speech_models": ["universal-2"], "language_code": "en"} if language == "english" else {
        "speech_models": ["assemblyai-stt-3-7"], "language_detection": True}
    transcript = _assembly_request("/v2/transcript", key, payload={"audio_url": audio_url, **model})
    transcript_id = transcript.get("id")
    if not isinstance(transcript_id, str) or not ASSEMBLY_ID.fullmatch(transcript_id):
        raise ValueError("AssemblyAI did not return a transcript ID")
    deadline = monotonic() + 7200
    while transcript.get("status") in {"queued", "processing"} and monotonic() < deadline:
        sleep(5)
        transcript = _assembly_request("/v2/transcript/" + transcript_id, key)
    if transcript.get("status") != "completed":
        raise ValueError("AssemblyAI transcription did not complete")
    def words():
        for w in transcript.get("words") or []:
            try:
                yield float(w["start"]) / 1000, float(w["end"]) / 1000, str(w["text"])
            except (KeyError, ValueError, TypeError):
                continue
    return _word_cues(words())


def _decoded_audio(source: Path, folder: Path, source_id: str, job_id: str) -> Path:
    destination = folder / f"{source_id}-{job_id}.flac"
    subprocess.run([*_input(source), "-n", "-map", "0:a:0", "-af", "aresample=16000:async=1:first_pts=0", "-ac", "1",
                    "-c:a", "flac", str(destination)], capture_output=True, check=True)
    return destination


def providers() -> dict:
    return {
        "audio": {"available": True},
        "whisper": {"available": find_spec("faster_whisper") is not None},
        "assemblyai": {"available": bool(os.environ.get("ASSEMBLYAI_API_KEY", "").strip())},
    }


def make_router(heavy_lock: Lock, draft_callback: Callable[[str, dict], dict] | None = None):
    router = APIRouter(prefix="/api/analysis")
    active = set()
    guard = Lock()

    def save(job: dict, folder: Path):
        job["updated_at"] = time()
        media.write_record(folder / (job["id"] + ".json"), job)

    def public(job: dict) -> dict:
        with guard:
            if job["status"] in {"queued", "running"} and job["id"] not in active:
                return {**job, "status": "interrupted", "message": "The app restarted during this analysis. Start another analysis to try again."}
        return job

    def execute(job: dict, spec: AnalysisRequest, folder: Path, source: Path, duration: float):
        try:
            job.update(status="running", message="Measuring source audio activity")
            save(job, folder)
            warnings = []
            try:
                levels = audio_activity(source, duration)
            except (OSError, subprocess.SubprocessError, ValueError):
                levels = []
                warnings.append("Could not measure audio activity.")
            motion = None
            if spec.visual_motion:
                job["message"] = "Measuring local visual motion"
                save(job, folder)
                try:
                    motion = motion_activity(source, duration)
                except (OSError, subprocess.SubprocessError, ValueError):
                    warnings.append("Could not measure visual motion; analysis continued without it.")
            if spec.provider != "audio":
                if not levels:
                    warnings.append("No usable audio stream detected; no transcription was sent or run.")
                else:
                    job["message"] = "Transcribing locally" if spec.provider == "whisper" else "Transcribing audio with AssemblyAI"
                    save(job, folder)
                    try:
                        audio = _decoded_audio(source, folder, spec.source_id, job["id"])
                        if spec.provider == "whisper":
                            raw = whisper_captions(audio, spec.language)
                        else:
                            key = os.environ.get("ASSEMBLYAI_API_KEY", "").strip()
                            if not key or not spec.allow_cloud:
                                raise ValueError("AssemblyAI was not authorized for this analysis")
                            raw = assembly_captions(audio, spec.language, key)
                        job["captions"] = _captions(raw, duration, spec.language)
                        if not job["captions"]:
                            warnings.append("No clear speech captions were returned.")
                    except Exception:
                        # Third-party/native errors can print tokens, private
                        # paths or audio URLs; return only a clean explanation.
                        provider = "Local Whisper" if spec.provider == "whisper" else "AssemblyAI"
                        warnings.append(f"{provider} could not transcribe this source; suggestions use local signals only.")
            job["suggestions"] = suggestions_for(levels, job["captions"], duration, spec.clip_length, spec.count, motion)
            if job["captions"]:
                (folder / (job["id"] + ".vtt")).write_text(make_vtt(job["captions"], 0, duration), encoding="utf-8")
            if draft_callback:
                job["message"] = "Saving local draft previews"
                save(job, folder)
                failures = 0
                for suggestion in job["suggestions"]:
                    try:
                        suggestion["draft"] = draft_callback(spec.source_id, suggestion)
                    except Exception:
                        failures += 1
                    save(job, folder)
                if failures:
                    warnings.append(f"{failures} draft preview(s) could not be saved; the suggested time ranges remain editable.")
            job.update(status="completed", message="Analysis ready for review. " + " ".join(warnings),
                       warnings=warnings)
            save(job, folder)
        except Exception:
            job.update(status="failed", message="Could not finish analysis or save results in the local data folder.")
            try:
                save(job, folder)
            except OSError:
                pass
        finally:
            with guard:
                active.discard(job["id"])
            heavy_lock.release()

    @router.get("/providers")
    def available_providers():
        return providers()

    @router.post("", status_code=202)
    def start_analysis(spec: AnalysisRequest):
        if spec.provider == "assemblyai" and not spec.allow_cloud:
            raise HTTPException(400, "Confirm sending this source audio to AssemblyAI for this run")
        if not providers()[spec.provider]["available"]:
            raise HTTPException(503, "The selected transcription provider is not configured")
        originals = media.root() / "originals"
        source = originals / (spec.source_id + ".mp4")
        try:
            data = json.loads((originals / (spec.source_id + ".json")).read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise HTTPException(404, "Source not found") from exc
        if not source.is_file():
            raise HTTPException(404, "Source media not found")
        duration = float(data["duration"])
        if not math.isfinite(duration) or duration <= 0:
            raise HTTPException(422, "Invalid source duration")
        if not heavy_lock.acquire(blocking=False):
            raise HTTPException(409, "A render or analysis is already running")
        job_id = media.media_id()
        job = {"id": job_id, "source_id": spec.source_id, "provider": spec.provider,
               "language": spec.language, "visual_motion": spec.visual_motion,
               "status": "queued", "message": "Analysis queued",
               "duration": duration, "created_at": time(), "suggestions": [], "captions": [],
               "captions_url": f"/api/analysis/{job_id}/captions.vtt", "warnings": []}
        try:
            folder = analysis_dir()
            save(job, folder)
            response = dict(job)
            with guard:
                active.add(job_id)
            Thread(target=execute, args=(job, spec, folder, source, duration),
                   name=f"analysis-{job_id[:6]}", daemon=True).start()
            return response
        except Exception as exc:
            with guard:
                active.discard(job_id)
            heavy_lock.release()
            raise HTTPException(507, "Could not start or save the analysis job") from exc

    @router.get("")
    def list_analysis(source_id: str | None = Query(default=None, pattern=r"^[0-9a-f]{32}$")):
        paths = sorted(analysis_dir().glob("*.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        jobs = [public(_read_job(path.stem)) for path in paths if IDENTIFIER.fullmatch(path.stem)]
        return [job for job in jobs if source_id is None or job["source_id"] == source_id]

    @router.get("/{job_id}")
    def get_analysis(job_id: str):
        return public(_read_job(job_id))

    @router.get("/{job_id}/captions.vtt")
    def caption_track(job_id: str, start: float = Query(default=0, ge=0), end: float | None = Query(default=None, gt=0)):
        job = public(_read_job(job_id))
        if job["status"] != "completed":
            raise HTTPException(409, "Analysis is not complete")
        end = job["duration"] if end is None else end
        if not (math.isfinite(start) and math.isfinite(end) and start < end <= job["duration"] + 1e-6):
            raise HTTPException(422, "Caption range must be inside the source duration")
        return Response(make_vtt(job["captions"], start, end), media_type="text/vtt",
                        headers={"Content-Disposition": 'inline; filename="captions.vtt"'})

    def submit_local_analysis(source_id: str, *, clip_length: float = 30, count: int = 3) -> dict:
        """Attempt a bounded keyless job from trusted app code; never queues beyond one job."""
        return start_analysis(AnalysisRequest(source_id=source_id, provider="audio",
                                              clip_length=clip_length, count=count))

    router.submit_local_analysis = submit_local_analysis
    return router
