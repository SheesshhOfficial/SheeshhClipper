"""Local media storage and deterministic FFmpeg rendering."""
import json
import math
import os
from pathlib import Path
import subprocess
from uuid import uuid4

COMPACT = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (720, 720)}
SIZES = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}

def root() -> Path:
    value = Path(os.environ.get("SHEESH_DATA_DIR", "data")).resolve()
    for name in ("originals", "projects", "drafts", "exports"):
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
    w, h = (COMPACT if request.kind == "export" and request.export_profile == "compact" else SIZES)[request.aspect]
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
    if request.aspect == "16:9":
        gw = (w * 2 // 3) // 2 * 2
        gw, gh, cwout, chout, stack = gw, h, w-gw, h, "hstack"
    else:
        gh = (h * 2 // 3) // 2 * 2
        gw, gh, cwout, chout, stack = w, gh, w, h-gh, "vstack"
    return (f"{src}split=2[game][face];"
            f"[game]{zoom(gw,gh,request.focus_x,request.focus_y)}[g];"
            f"[face]crop={cw}:{ch}:{cx}:{cy},{zoom(cwout,chout,.5,.5)}[f];"
            f"[g][f]{stack}=inputs=2,format=yuv420p[out]")

def render(source: Path, target: Path, record: dict, request) -> None:
    graph = filter_graph(record, request)
    compact = request.kind == "export" and request.export_profile == "compact"
    # Explicitly use MP4 demuxing and do not permit network protocols or shell expansion.
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
            "-protocol_whitelist", "file,pipe", "-f", "mov", "-ss", f"{request.start:.9f}",
            "-i", str(source), "-t", f"{request.end-request.start:.9f}",
            "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[out]",
            "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
            "-c:v", "libx264", "-preset", "fast" if compact else "veryfast", "-crf", "27" if compact else "22",
            "-c:a", "aac", "-b:a", "112k" if compact else "160k", "-movflags", "+faststart", str(target)]
    subprocess.run(args, check=True, capture_output=True)
