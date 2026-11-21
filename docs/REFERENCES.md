# Prior art and decisions

The implementation was written for this repository. The following sources informed design and comparison; no code, sample media, install scripts, or credentials were copied from them. Licenses refer to the reviewed upstream projects, not to this app.

| Source | Applied idea | Deliberately not imported |
| --- | --- | --- |
| [SupoClip](https://github.com/FujiwaraChoki/supoclip) | Timestamped transcripts, candidates before export, separate caption providers. | The entire web stack, compulsory hosted inference, or its custom-licensed code. |
| [OpenShorts](https://github.com/mutonby/openshorts) | Shortlist across a source, suppress overlapping candidates, retain editable recipes and independent masters. | Its commercial cloud layer or an LLM as a blocking prerequisite. |
| [AutoClip](https://github.com/artbyjazi/autoclip) | Local dashboard and durable job status. | Its specific service stack or full ML dependency footprint. |
| [Clipora](https://github.com/awilliamson10/clipora) | Helps distinguish retrieval/ranking experiments from an end-user clipper. | Its OpenCLIP LoRA training pipeline is not necessary for the local clipper. |
| [ViralCutter](https://github.com/RafaelGodoyEbert/ViralCutter) | Review the timeline and final render separately. | GPLv3 code, cookie handling, and external setup habits. |
| [video-use](https://github.com/browser-use/video-use) | Time-based edit decisions, rebase captions onto the kept ranges. | Agent-driven arbitrary tool execution or mandatory paid ASR. |
| [NeonClipping](https://github.com/iamajmeena/neonclipping) | Relative audio activity and named gameplay cues, live capture separate from ranking. | Model downloads as a default prerequisite; no unsupported visual/game-event claims. |
| [Canwe live guide](https://canwe-guides.vercel.app/live/) | Explicit start/stop, preserve media before analyzing, keep capture separate from suggestions. | Its script, hard-coded chat thresholds and assumptions about capture tools. |

Tooling references: [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [Deno images](https://github.com/denoland/deno_docker#using-your-own-base-image), [Docker Desktop WSL](https://docs.docker.com/desktop/features/wsl/), [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
