# Editor and AI Clipper decisions

The user supplied a MrBitBlox workflow guide and a GTA clipping workflow guide. We used them as references, not as executable install instructions.

- **Adopted:** separate defaults from per-edit controls; caption looks; number/length of picks; optional source time range; title, timestamp, evidence and reason before an explicit editor handoff.
- **Kept:** local Whisper and FFmpeg, project folders, the existing live and audio/motion highlight path, and manual export. AI Clipper reads saved or pasted transcripts without needing to download the source again. A local model, if deliberately configured, can rerank bounded candidates without inventing timestamps. No key is required for transcript rules.
- **Not included:** account automation, extra installers, cloud AI in this view, GPU dependency switches, automatic edits, or posting. Extra libraries, face tracking and word-level animation would need separate tests on actual footage rather than replacing a working pipeline by default.

To review a pick, check the opening, payoff and caption timing in Preview, then choose Save draft or Export. A quote supports why a clip was nominated; it does not validate on-screen action or guarantee clip quality.
