# Release verification

The local editor starter was exercised by a Windows user before this release.
That does not validate this release's new browser, Docker or YouTube paths.

| Pass | What was checked on the development machine |
| --- | --- |
| 1. Prior art | Revisited all seven reference repositories and the previously inspected Canwe live guide. Kept patterns, not third-party source. See [reference decisions](REFERENCES.md). |
| 2. Source and export regression | Real FFmpeg: fit/fill/split/picture-in-picture, H.264/AAC, high/compact sizes, range serving, persisted edit recipes and byte-identical originals. Drafts remain high quality regardless of the export selection. |
| 3. VOD and live pipeline | Mocked downloader with real FFmpeg: original VOD preservation, H.264 proxy fallback, published live segments, stopping cleanly, URL validation and optional closed-chunk analysis without a backlog. |
| 4. Analysis and captions | Real synthetic audio and motion analysis; mocked speech providers, consent, Roman Hindi conversion, WebVTT timing, reasoned candidates, local draft persistence and a restore-to-export flow. |
| 5. Editor and safety | Actual FFmpeg cut/layout transitions and caption burn-in, JS parse and markup checks, loopback/access and restrictive page headers, and explicit local/cloud separation. |
| 6. Packaging | Dependency pins checked against upstream; checked Compose configuration, local ignores, launcher line endings, and ran the aggregate automated suite on the staged source. |

## Still needs a real environment

- Chromium was blocked at startup by the development sandbox's Unix
  socket restriction, before the automated UI flow could run. Docker was not installed
  there, so the full Windows Docker build and browser pass on this version
  still need a run.
- No actual YouTube VOD or live stream was ingested here. The mock-timed
  recordings verify the editor and queue plumbing, not service compatibility.
  Confirm both with media you are permitted to capture. No real AssemblyAI
  request or Whisper model run was performed.
- Rankings are heuristic. On held-out gameplay, check that the spoken setup
  and the payoff are retained, and manually adjust poor picks. Hinglish
  transcription and romanization should be reviewed.
- Short intervals are rounded to the available video frames and audio packets.
  A small timing difference can accumulate over many very short cuts. This
  is not a frame-accurate nonlinear editor.

## Suggested first Windows check

1. Start Docker Desktop and run `runme.bat`. In the app, upload a short H.264
   MP4 with an audible moment and a recognizable facecam or a logo to frame.
2. Mark the facecam, save a draft, seek, then change the width of the browser.
   Mark the same region and verify the resulting crop matches. Try a split and
   a repositioned picture-in-picture.
3. Remove an inside range, save a timed layout change, restore the draft, and
   compare High and Compact exports. Check that both play, the original stays
   unchanged, and all artifacts remain after a restart.
4. Try Local audio, then Whisper if desired. Confirm that reasoned results and
   drafts are available. Inspect the subtitle text and timing before burning in.
5. Try one permitted short YouTube VOD and a public test livestream (start,
   wait until a chunk closes, then stop). Check Sources, captured files, and
   diagnostics before assuming either works on a longer recording.
