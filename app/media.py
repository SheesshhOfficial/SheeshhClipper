"""Local media storage and deterministic FFmpeg rendering."""
import json
import math
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock
from uuid import uuid4

HEAVY_LOCK = Lock()
COMPACT = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)}
SIZES = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}

def root() -> Path:
    value = Path(os.environ.get("SHEESH_DATA_DIR", "data")).resolve()
    for name in ("originals", "projects", "drafts", "exports", "downloads", "live-chunks", "cache", "models", "transcripts", "logs"):
        (value / name).mkdir(parents=True, exist_ok=True)
    return value

def media_id() -> str:
    return uuid4().hex

def write_record(path: Path, data: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)

def probe(path: Path) -> dict:
    args = ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov",
            "-show_streams", "-show_format", "-of", "json", str(path)]
    data = json.loads(subprocess.run(args, check=True, capture_output=True, timeout=60).stdout)
    video = next(x for x in data["streams"] if x["codec_type"] == "video"
                 and not x.get("disposition", {}).get("attached_pic"))
    # Restrict to ISO MP4-family containers, rather than arbitrary data with an .mp4 suffix.
    if data["format"].get("tags", {}).get("major_brand", "").strip() not in {
        "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9",
        "mp41", "mp42", "avc1", "M4V", "dash", "cmfc", "cmfs", "MSNV", "F4V",
        "hvc1", "hevc", "hev1", "mmp4"
    }:
        raise ValueError("Not an MP4 container")
    width, height = int(video["width"]), int(video["height"])
    rotation = int(next((x["rotation"] for x in video.get("side_data_list", [])
                         if "rotation" in x), video.get("tags", {}).get("rotate", 0)))
    if rotation % 180 == 90:
        width, height = height, width
    duration = float(video.get("duration") or data["format"]["duration"])
    if min(width, height) < 2 or not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid video geometry or duration")
    return dict(duration=duration, width=width, height=height, stream=video["index"])

def zoom(w: int, h: int, x: float, y: float) -> str:
    return (f"scale={w}:{h}:force_original_aspect_ratio=increase:force_divisible_by=2,"
            f"crop={w}:{h}:(in_w-out_w)*{x:.9f}:(in_h-out_h)*{y:.9f},setsar=1")

def filter_graph(record: dict, request) -> str:
    compact = request.kind == "export" and request.export_profile == "compact"
    w, h = (COMPACT if compact else SIZES)[request.aspect]
    src = f"[0:{record['stream']}]"
    if request.layout == "fit":
        return (f"{src}scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[out]")
    if request.layout == "fill":
        return f"{src}{zoom(w,h,request.focus_x,request.focus_y)},format=yuv420p[out]"
    cam = request.facecam
    # Gameplay takes upper 2/3 in tall/square and left 2/3 in landscape.
    fw, fh = record["width"], record["height"]
    cx, cy = int(cam.x * fw) // 2 * 2, int(cam.y * fh) // 2 * 2
    cw, ch = int(cam.w * fw) // 2 * 2, int(cam.h * fh) // 2 * 2
    if min(cw, ch) < 2:
        raise ValueError("Facecam is smaller than two source pixels")
    if request.layout == "pip":
        ow = int(w * request.facecam_scale) // 2 * 2
        oh = max(2, (int(ow * 9 / 16) // 2) * 2)
        px, py = (int((w-ow) * request.facecam_pos_x) // 2 * 2,
                  int((h-oh) * request.facecam_pos_y) // 2 * 2)
        return (f"{src}split=2[game][face];"
                f"[game]{zoom(w,h,request.focus_x,request.focus_y)}[g];"
                f"[face]crop={cw}:{ch}:{cx}:{cy},{zoom(ow,oh,request.facecam_focus_x,request.facecam_focus_y)}[f];"
                f"[g][f]overlay={px}:{py}:shortest=1,format=yuv420p[out]")
    if request.aspect == "16:9":
        gw = (int(w * request.gameplay_share + 1e-8)) // 2 * 2
        gw, gh, cwout, chout, stack = gw, h, w-gw, h, "hstack"
    else:
        gh = (int(h * request.gameplay_share + 1e-8)) // 2 * 2
        gw, gh, cwout, chout, stack = w, gh, w, h-gh, "vstack"
    panels = "[f][g]" if request.facecam_first else "[g][f]"
    return (f"{src}split=2[game][face];"
            f"[game]{zoom(gw,gh,request.focus_x,request.focus_y)}[g];"
            f"[face]crop={cw}:{ch}:{cx}:{cy},{zoom(cwout,chout,request.facecam_focus_x,request.facecam_focus_y)}[f];"
            f"{panels}{stack}=inputs=2,format=yuv420p[out]")

def _timestamp(seconds: float) -> str:
    ms = round(seconds * 1000)
    return f"{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}"

def _captions(path: Path, rows, start: float, end: float) -> bool:
    chunks = []
    for row in rows:
        a, b = max(start, float(row["start"])), min(end, float(row["end"]))
        # Escape SRT/ASS styling and keep text as text. FFmpeg sees a fixed filename only.
        plain = str(row["text"]).replace("{", "(").replace("}", ")").replace("<", "‹").replace(">", "›")
        plain = " ".join(plain.replace(chr(92), "/").split())
        if plain and b-a >= .001:
            chunks.append(f"{len(chunks)+1}\n{_timestamp(a-start)} --> {_timestamp(b-start)}\n{plain}\n")
    if chunks:
        path.write_text("\n".join(chunks), encoding="utf-8")
    return bool(chunks)

# Fixed ASS presets: never interpolate arbitrary user text into this filter.
CAPTION_STYLES = {
    "clean": "FontName=DejaVu Sans,FontSize=20,Outline=2,MarginV=22",
    "bold": "FontName=DejaVu Sans,FontSize=25,PrimaryColour=&H004AD5FF,Bold=1,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=2,MarginV=22",
    "minimal": "FontName=DejaVu Sans,FontSize=15,PrimaryColour=&H00FFFFFF,Bold=0,OutlineColour=&H00000000,Outline=1,Shadow=0,Alignment=2,MarginV=16",
}


def _render_part(source, target, record, request, start, end, captions, scratch):
    graph = filter_graph(record, request)
    if captions and _captions(scratch / "captions.srt", captions, start, end):
        style = CAPTION_STYLES[getattr(request, "caption_style", "clean")]
        graph = graph.removesuffix("[out]") + f"[clean];[clean]subtitles=captions.srt:force_style='{style}'[out]"
    compact = request.kind == "export" and request.export_profile == "compact"
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
            "-protocol_whitelist", "file,pipe", "-f", "mov", "-ss", f"{start:.9f}",
            "-i", str(source.resolve()), "-t", f"{end-start:.9f}",
            "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[out]",
            "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
            "-c:v", "libx264", "-preset", "fast" if compact else "veryfast", "-crf", "27" if compact else "22",
            "-c:a", "aac", "-b:a", "112k" if compact else "160k", "-movflags", "+faststart", str(target.resolve())]
    subprocess.run(args, check=True, capture_output=True, cwd=scratch)

def render(source: Path, target: Path, record: dict, request, *, captions=()) -> None:
    with TemporaryDirectory(prefix="render-", dir=root() / "cache") as path:
        scratch = Path(path)
        if not request.cuts and not request.layout_changes:
            _render_part(source, target, record, request, request.start, request.end, captions, scratch)
            return
        segments = []
        cursor = request.start
        for cut in request.cuts:
            segments.append((cursor, cut.start))
            cursor = cut.end
        segments.append((cursor, request.end))
        pieces = []
        for start, end in segments:
            boundaries = [start, *(change.at for change in request.layout_changes if start < change.at < end), end]
            for a, b in zip(boundaries, boundaries[1:]):
                pieces.append((a, b))
        for i, (start, end) in enumerate(pieces):
            active = next((c for c in reversed(request.layout_changes) if c.at <= start), None)
            edited = request.model_copy(update={name: getattr(active, name) for name in type(active).model_fields if name != "at"}) if active else request
            _render_part(source, scratch / f"part-{i}.mp4", record, edited, start, end, captions, scratch)
        (scratch / "join.txt").write_text("".join(f"file part-{i}.mp4\n" for i in range(len(pieces))), encoding="ascii")
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
                        "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1",
                        "-i", "join.txt", "-c", "copy", "-movflags", "+faststart", str(target.resolve())],
                       check=True, capture_output=True, cwd=scratch)
