# SheeshhClipper

A Windows-first, local studio for gameplay clips. Bring in your own footage, find possible moments, edit the cut and layout, then export when you're happy with it. Nothing is automatically posted or deleted.

## Start on Windows

1. Start Docker Desktop with the WSL 2 backend.
2. Double-click `runme.bat` from the checkout, or run `docker compose up -d --build --wait` and open http://localhost:7310/.
3. Import a local H.264 MP4, or paste a public YouTube video or live URL that you have permission to capture.

The first build installs FFmpeg and the other dependencies; that can take several minutes, particularly if Debian package downloads are slow. Changing app files doesn't normally invalidate the cached FFmpeg layer. To see build output in full, run `docker compose --progress plain build`. Stop the app without deleting files with `docker compose down`. If port 7310 is occupied, set `SHEESH_PORT` to a free port; the launcher opens the actual port. The app is single-user and binds to loopback. Do not expose it to a LAN or the internet.

## How to make a clip

| Step | What to do |
| --- | --- |
| Choose a source | Upload an MP4, download a finished public YouTube video, or start a public live capture. Live capture writes short playable segments; open a completed segment as a source. Stop saves already-closed segments and attempts to finish the current one. Optional audio-only suggestions start when a segment closes, if the analysis worker is free. |
| Find moments | Pick **Local audio** to find audio peaks, or **Local Whisper** or **AssemblyAI** to add transcript cues. Optionally include local frame-motion cues. The suggested timestamps include reasons and are heuristic, not guaranteed good clips. Silent footage gets a clearly labeled review window. Suggested drafts render locally by default. |
| Review | Apply a suggestion or pick a range yourself. Remove intervals inside the clip. Choose fit, fill, split or picture-in-picture; draw your facecam on the source, adjust gameplay/facecam focus, panel share and order, or overlay position and size, and capture layout changes at source timestamps. |
| Caption | Pick English or Hinglish. Hinglish is best-effort Roman Hindi mixed with English, not a translation or a guarantee of accuracy. Review or edit cues and burn them into your export, or download a subtitle track. |
| Export | Keep **1080p High** (same setting as the original editor), or choose **720p Compact** for a smaller file. File size depends on the source and duration. Draft quality is unchanged. Saved edits restore their controls from the gallery. |

## Privacy and providers

- Local MP4 editing and audio scoring need no credential or cloud provider. Whisper runs locally on CPU and fetches the model on first use. The model cache is local.
- Optional AssemblyAI: copy `.env.example` to `.env`, set `ASSEMBLYAI_API_KEY`, then restart with `docker compose up -d`. Select AssemblyAI and confirm on each run before sending the selected source's audio to that provider. It may incur charges on your account. Your video, tokens, and provider URLs are not included in the published code.
- YouTube ingest sends the public link to YouTube and uses yt-dlp, bundled EJS scripts and Deno. No browser cookies, login, or bypasses. YouTube may restrict a specific video, client, or IP; private, protected, upcoming, or unavailable sources are not supported.
- Live operates on closed chunks, not as a continuous Twitch/YouTube chat listener. Clips spanning multiple chunks, chat spike scoring, GPU-specific encoding and learning-based gameplay vision are not included. CPU is the default; a live transcode can overlap with one render or analysis.

## Keep your data

`./data` is bind-mounted, with no app-imposed storage quota, expiry, auto-delete, or GitHub upload. Finished downloads, proxies, live chunks, captions, drafts, exports and saved edit recipes remain under it. Originals are never overwritten by edits. A full disk can still interrupt writes. Docker's own image and build cache may be on another drive; deleting `data/` is not a remedy. See [the folder guide](data/README.md).

## Verify or troubleshoot

- `docker compose ps` shows the service status. `docker compose logs --tail 60 clipper` shows app logs.
- Open [local diagnostics](http://localhost:7310/api/diagnostics) for FFmpeg, yt-dlp, EJS, Deno, Whisper package and free-space information. Check the port if overridden. Don't share logs containing private source links or local paths.
- Local development: use Python 3.12, FFmpeg/FFprobe and Deno on PATH. Install `requirements.txt`, use a separate `SHEESH_DATA_DIR`, and run `python -m uvicorn app.main:app --host 127.0.0.1 --port 7310`.
- Install `httpx` for tests, then run `python -m unittest discover -s tests -v` and `node --check app/static/studio.js && node --check app/static/workflows.js`. The optional browser smoke script needs Playwright and Chromium.
- See [verification notes](docs/VERIFICATION.md) and [reference decisions](docs/REFERENCES.md).
