# SyncNote — project context for Claude

SyncNote is a Toon Boom Harmony review-notes tool (Frame.io/SyncSketch-style):
dated text notes bound to drawing substitutions, stored in scene metadata,
edited through a Qt panel. Owner: Zack (makermatic), an animation instructor —
he's on Harmony 22 Premium; his students use 24/25, so everything must work on
both. He is not a scripting expert; explain concretely.

## Read this first

**`syncnote_kb.md` is the authoritative technical log.** Before touching
`SyncNote.js`, read §7.3.5 (Qt-binding gotchas — every entry was paid for with
a live failure) and skim the per-version implementation logs. When the KB and
your instincts disagree, the KB wins.

## Working agreement (established over many sessions)

- **Bump `SN_VERSION` on every change** — the panel title bar is the only proof
  of which build Zack is testing. Harmony loads scripts at startup: he must
  restart Harmony after every deploy.
- A PostToolUse hook auto-runs `install.ps1` whenever `SyncNote.js` is edited
  (copies script + icon to all Harmony script folders). Editing `install.ps1`
  alone does NOT fire it — run it manually then.
- Say **"deployed, please test"** — never "fixed" — until Zack confirms in-app.
  Verify APIs against the official docs AND working scripts on his machine
  (`%APPDATA%/Toon Boom Animation/**`, incl. openHarmony) before using them.
- **Plan before UI changes**; small rollback-friendly iterations, committed and
  pushed per version. Risky features go on a branch as a separate
  `SyncNoteBeta.js` (toolbar function `SyncNoteBeta`) for side-by-side testing,
  folded into `SyncNote.js` on approval.
- **Instrument before theorizing**: add Message Log traces and ask for the log
  line rather than stacking blind fixes. Failed experiments get retired with a
  written cause (see KB §33), not endless retries.
- The UI is heavily user-tuned. Do not redesign layout unasked.
- `_icon/` and `Icon.ai` are Zack's working art files — never touch or commit
  them (the exported `_icon/_exports/Icon.png` is tracked; that one is fine).

## Landmines (short list; details in KB §7.3.5)

- Layouts: only add widgets via the `addW()` helper (exact-arg binding hell).
- Never use `palette(...)` in stylesheets (Harmony themes via app qss → black).
- Never swap a button's label post-show (size glitches); scope stylesheets to
  the widget class or they cascade into tooltips.
- Pin every script-created QObject (filters, timers) in a keep-alive array or
  GC silently kills its overrides.
- `QTextDocument.textWidth` setter is unbound; rich QLabels under-report
  wrapped height (~3-4px/line) — UNFIXABLE, retired (KB §33). Don't reopen.
- Embedding large base64 strings in the script broke everything once (KB §32).
- The composite's LAST-connected port renders frontmost (docs say otherwise);
  verify with `compositionOrder.buildDefaultCompositionOrder()`, never ports.
- Window icon (`setWindowIcon`) doesn't render on Harmony 22 — retired; the
  guarded loader remains and traces to the Message Log if ever revisited.

## Releases & the self-updater (v0.30.0+)

- **`main` = development. `release` = teacher channel.** The script checks
  `https://raw.githubusercontent.com/makermatic/SyncNote/release/SyncNote.js`
  at every launch (repo must stay PUBLIC or every teacher's updater breaks).
- **Blessing flow:** Zack tests a build and blesses it → ASK HIM what version
  number the release should carry (main's current or his custom pick; must be
  incremental) → stamp if needed, merge/push to `release`. Never push to
  `release` without his explicit blessing.
- One version sequence across both branches — release simply lags main.
- First install = Zack's Slack zip; all later updates via the in-panel
  updater ("New Update Available" link in the status bar). First-ever launch
  on a machine force-updates once (preferences flag).
- Updater safety: downloads to a unique temp file, verifies content
  (`function SyncNote` + parseable version) before installing; `curl -f`
  writes nothing on HTTP errors. A failed check retries next launch.
- **After every push to `release`: verify the channel.** (1) Merging main
  over a re-stamped release can keep BOTH version lines — the updater
  parses the FIRST match, which silently masks the release. Check with
  `grep -c 'SN_VERSION    ='` (must be exactly 1). (2) The raw URL is
  CDN-cached ~5 min — verify via the commit-SHA raw URL immediately, or
  wait before live-testing.

## State / roadmap

Current: **v0.29.0**, all features confirmed except where the KB says retired.
Open items: student README + install guide (never started), teacher
save-confirmation prompt (designed, KB §25.1), bold/italic already shipped as
`**markers**`. Notes persist only when the scene saves (mitigated by
save-on-close — do not "fix" further; Zack's decision).
