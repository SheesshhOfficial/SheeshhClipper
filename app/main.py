"""SheeshhClipper local single-user HTTP API."""
import json
from pathlib import Path
import re
import subprocess
from threading import Lock
from urllib.parse import urlsplit
from typing import Literal
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import media

app = FastAPI(title="SheeshhClipper")
# Defense in depth against DNS rebinding for the loopback-scoped service.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])
ID = re.compile(r"[0-9a-f]{32}")
STATIC = Path(__file__).with_name("static")
RENDER_LOCK = Lock()

class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

class Facecam(Model):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def bounds(self):
        if self.x + self.w > 1 + 1e-9 or self.y + self.h > 1 + 1e-9:
            raise ValueError("Facecam must be inside the source")
        return self

class Render(Model):
    source_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    aspect: Literal["9:16", "16:9", "1:1"]
    layout: Literal["fit", "fill", "split"]
    focus_x: float = Field(default=.5, ge=0, le=1)
    focus_y: float = Field(default=.5, ge=0, le=1)
    facecam: Facecam | None = None
    kind: Literal["draft", "export"]
    export_profile: Literal["high", "compact"] = "high"

    @model_validator(mode="after")
    def valid_edit(self):
        if self.end <= self.start:
            raise ValueError("End must be later than start")
        if self.layout == "split" and self.facecam is None:
            raise ValueError("Split requires a facecam region")
        if self.kind == "draft":
            self.export_profile = "high"
        return self

@app.middleware("http")
async def reject_browser_cross_origin(request, call_next):
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        site = request.headers.get("sec-fetch-site")
        if site == "cross-site" or (origin and urlsplit(origin).netloc != request.headers.get("host")):
            return JSONResponse({"detail": "Cross-origin API access is disabled"}, status_code=403)
    return await call_next(request)

def record(folder: Path, id: str, kind: str) -> dict:
    if not ID.fullmatch(id):
        raise HTTPException(404, f"{kind} not found")
    try:
        return json.loads((folder / (id + ".json")).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(404, f"{kind} not found") from exc

def listed(folder: Path) -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in
            sorted(folder.glob("*.json"), key=lambda path: path.stat().st_mtime_ns, reverse=True)]

def source_public(source: dict) -> dict:
    return {key: source[key] for key in ("id", "name", "duration", "width", "height", "url")}

def artifact_public(artifact: dict) -> dict:
    return {key: artifact[key] for key in ("id", "name", "url", "kind")}

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/sources")
def upload(file: UploadFile = File(...)):
    name = (file.filename or "").replace("\\", "/").split("/")[-1].strip()
    if not name.lower().endswith(".mp4"):
        raise HTTPException(415, "Upload a local MP4 file")
    root = media.root()
    id = media.media_id()
    folder = root / "originals"
    temporary = folder / (id + ".upload")
    target = folder / (id + ".mp4")
    try:
        with temporary.open("xb") as out:
            while chunk := file.file.read(1024 * 1024):
                out.write(chunk)
        info = media.probe(temporary)
        temporary.replace(target)
        data = {"id": id, "name": name, "url": f"/api/sources/{id}/media", **info}
        media.write_record(folder / (id + ".json"), data)
        return source_public(data)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, KeyError, ValueError, StopIteration) as exc:
        raise HTTPException(422, "Could not read a playable MP4 video") from exc
    except OSError as exc:
        raise HTTPException(507, "Could not save original to the local data directory") from exc
    finally:
        temporary.unlink(missing_ok=True)
        file.file.close()

@app.get("/api/sources")
def sources():
    return [source_public(item) for item in listed(media.root() / "originals")]

@app.get("/api/sources/{id}/media")
def source_file(id: str):
    folder = media.root() / "originals"
    record(folder, id, "Source")
    return FileResponse(folder / (id + ".mp4"), media_type="video/mp4")

@app.post("/api/render")
def render(request: Render):
    root = media.root()
    item = record(root / "originals", request.source_id, "Source")
    if request.end > item["duration"] + 1e-6:
        raise HTTPException(422, "End exceeds source duration")
    id = media.media_id()
    folder = root / ("drafts" if request.kind == "draft" else "exports")
    temporary = folder / (id + ".working.mp4")
    target = folder / (id + ".mp4")
    if not RENDER_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A render is already running. Try again after it finishes.")
    try:
        media.render(root / "originals" / (request.source_id + ".mp4"), temporary, item, request)
        if not temporary.exists() or temporary.stat().st_size == 0:
            raise ValueError("Empty render")
        media.probe(temporary)
        temporary.replace(target)
        data = {"id": id, "name": f"{Path(item['name']).stem}-{request.kind}-{id[:8]}.mp4",
                "url": f"/api/artifacts/{id}/media", "kind": request.kind}
        media.write_record(root / "projects" / (id + ".json"), {**data, "edit": request.model_dump()})
        return data
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, KeyError, StopIteration) as exc:
        raise HTTPException(500, "FFmpeg could not complete a playable render") from exc
    except OSError as exc:
        raise HTTPException(507, "Could not save render to the local data directory") from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            RENDER_LOCK.release()

@app.get("/api/artifacts")
def artifacts():
    return [artifact_public(item) for item in listed(media.root() / "projects")]

@app.get("/api/artifacts/{id}")
def artifact_details(id: str):
    return record(media.root() / "projects", id, "Artifact")

@app.get("/api/artifacts/{id}/media")
def artifact_file(id: str):
    root = media.root()
    item = record(root / "projects", id, "Artifact")
    folder = "drafts" if item["kind"] == "draft" else "exports"
    return FileResponse(root / folder / (id + ".mp4"), media_type="video/mp4",
                        filename=item["name"], content_disposition_type="inline")

app.mount("/static", StaticFiles(directory=STATIC, check_dir=False), name="static")
app.mount("/", StaticFiles(directory=STATIC, html=True, check_dir=False), name="frontend")
