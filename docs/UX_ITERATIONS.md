# Dark workspace iteration log

The reference is [SupoClip’s app guide](https://github.com/FujiwaraChoki/supoclip/blob/main/docs/app-guide.md): separate creation, activity, review, and editing instead of one long form. SheeshhClipper keeps one local workspace, no accounts, and manual export. No reference code or assets were copied.

## Ten UX passes

| Pass | Focus | Result |
| --- | --- | --- |
| 1 | Information architecture | Split the single long page into Sources, Highlights, Editor, and Saved clips. |
| 2 | Dark theme | Introduced a charcoal palette, lavender actions, and text status labels across the four views. |
| 3 | Import | Split local file and YouTube into clear entry cards. The shared auto-highlight checkbox appears before both. |
| 4 | Activity and analysis | Separated import progress from import inputs, and analysis settings from its suggestions and captions. |
| 5 | Editing | Kept the existing preview and framing controls mounted; brought the active-source picker above all sections. |
| 6 | Library | Grouped existing drafts and exports using source IDs in saved edits, with an unlinked fallback. |
| 7 | Responsive layout | Added a four-item mobile nav, single-column editor and import layouts, and small-width control wrapping. Sticky preview applies only when the available height can accommodate it. |
| 8 | Accessibility | Used ordinary navigation links, a skip link, active view indicators, named controls, and hidden inactive content. |
| 9 | View history | Added deep links, Back/Forward support, focus handoffs, and automatic pause when leaving video previews. |
| 10 | Regression | Added navigation tests and an API assertion for saved clip grouping, updated the real browser smoke test, and re-ran API, FFmpeg and Node suites. Chromium was blocked before loading the app by the test environment’s Unix socket restrictions; visual and Windows Docker checks remain open. |

## Feature iterations

Each subsequent release will record its scope and verification here.

1. **Source projects.** Canonical YouTube IDs group repeat imports and completed live chunks. Local file uploads, even with the same name, stay separate. Older ingest records are recognized when available; no media moves or migrations. Verified with synthetic media, equivalent links, distinct video IDs, and focused library grouping tests.
2. **Saved clips search.** Search project names, YouTube IDs, or filenames. Search combines with the Drafts / Exports filter and reports the filtered count. Verified mixed-case and multiword matching plus type-filter composition in Node.
3. **Editor shortcuts.** The focused preview accepts Space for play/pause and the bracket keys for trim points. Input controls, intentionally modified keys, and hidden views retain normal behavior. Verified enabled-action routing and keyboard exclusion cases.
4. **Framing guides.** An optional dashed outline helps place facecams and text away from edges and leaves extra right/bottom space in vertical clips. Guides stay off during facecam drawing and never render into exports. Verified all three aspect ratios and canvas state restoration.
