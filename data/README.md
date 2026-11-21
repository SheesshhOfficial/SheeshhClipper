# Local project data

All SheeshhClipper app data belongs under `data/` **inside your local checkout**. Git tracks this guide and empty folder markers only. Media, machine-local state, and credentials must not be committed or shared to this public repository.

| Folder | Intended contents |
| --- | --- |
| `projects/` | Project settings, timeline edits, clip suggestions, job records, and local database |
| `originals/` | Source media imported from your PC |
| `downloads/` | Downloaded VODs, including downloader fragments and sidecar metadata |
| `live-chunks/` | Original captured livestream segments, time indexes, and available chat data |
| `cache/` | Proxies, waveforms, analysis, temporary render data, and reusable downloader cache |
| `models/` | Local model weights and model caches |
| `transcripts/` | Timestamped speech, subtitle files, and caption revisions |
| `drafts/` | Suggested clip previews before approval |
| `exports/` | Final renders |
| `logs/` | Local troubleshooting logs without credentials |

Use a project ID subfolder under each applicable directory. Keep originals and downloads separate from drafts and exports so edits never overwrite source media.

**Retention decisions:** No app-imposed storage cap, expiry timer, or automatic deletion of saved data. The actual drive still has finite capacity. If a write can't complete, report the error and preserve already saved files. Deletion is an explicit user action.

**Docker design:** When the app is implemented, bind-mount the checkout's `./data` into the containers so app files stay here instead of in Docker-managed volumes. Docker Engine's images and internal data are separate. The folder layout and ignore rules do not start Docker or implement capture.

Keep credentials in an ignored local `.env` at the repo root. Never store real keys in Git, logs, or example files. Do not force-add ignored files. Back up `data/` separately if you want a copy; cloning the repository restores the folder structure, not your local files.
