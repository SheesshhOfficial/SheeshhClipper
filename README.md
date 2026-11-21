# SheeshhClipper

A Windows-first, local video clipping workbench. This first build is the local editor foundation, not the finished all-in-one clipper.

## Start on Windows

1. Start Docker Desktop with the WSL 2 backend.
2. Double-click `runme.bat` from this directory, or run `docker compose up -d --build --wait` and open http://localhost:7310/.
3. Import your own H.264 MP4 for the most compatible preview. Preview a source, set start/end, choose a fit, fill, or manual facecam split layout, then save a draft or make an export. Keep `data/` if updating or replacing app files.

Final export lets you choose the existing 1080p High default or 720p Compact. Draft quality is unchanged. File size depends on the video.

No API key or account is required. Docker needs internet for first-time base image and dependency downloads. App traffic binds to your machine only. To stop without deleting any data, run `docker compose down`. If port 7310 is in use, set `SHEESH_PORT` to a free local port before starting.

## Local storage

`./data` is bind-mounted into the app, so sources, local state, drafts and exports remain in the checkout after Docker stops. Originals and renders are stored under their own categories with unique IDs. The gallery uses their saved names and edit settings. There is no app-imposed quota, expiry, auto-delete, or uploading to GitHub. Back up ignored data separately. A full drive can still prevent writes. See [data/README.md](data/README.md).

## Scope

Working toward a single editor for local files, yt-dlp YouTube VOD and live capture. This milestone focuses on importing local files, trimming, framing gameplay/facecam, and retaining drafts and exports. Automatic highlight selection, inner-cut editing, captions (local Whisper and opt-in AssemblyAI), multi-layout keyframes, VOD/live ingest and hosted ranking are planned, not implied by this build. No social account integration or publishing.

## Development without Docker

Requires Python 3.12 and FFmpeg/FFprobe on PATH. From this directory:

```sh
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 7310
```

Use a temporary `SHEESH_DATA_DIR` for test jobs rather than the real library. Do not expose this local unauthenticated app to other devices.

## Smoke test

Install the optional test dependency `httpx`, then run `python -m unittest discover -s tests -v`. The integration test uses synthetic video and a temporary data directory. An optional browser smoke script uses Playwright and its installed Chromium (or set `SHEESH_CHROMIUM` to an executable).

## Public YouTube ingest

Use **Bring in a video** for public YouTube videos or live streams you own or have permission to use. No account, cookies or API key are used. VOD originals remain under `data/downloads`; when needed, an H.264/AAC editing copy is created beside the original. Live currently requires a public, multiplexed HLS stream at 720p or lower. Press **Stop** to finish the capture. Completed MP4 chunks are saved under `data/live-chunks` and appear in Sources. Hard shutdown may leave the active chunk incomplete; finalized chunks are retained. No automatic retention limit. Docker includes Deno and local yt-dlp EJS. Live-provider compatibility was not verified against a real YouTube stream in this checkpoint.
