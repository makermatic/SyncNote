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
  (copies the script to all Harmony script folders). Editing `install.ps1`
  alone does NOT fire it — run it manually then.
- Say **"deployed, please test"** — never "fixed" — until Zack confirms in-app.
  Verify APIs against the official docs AND working scripts on his machine
  (`%APPDATA%/Toon Boom Animation/**`, incl. openHarmony) before using them.
- **Plan before UI changes**; small rollback-friendly iterations, committed and
  pushed per version. Risky features ship as a separate `SyncNoteBeta.js`
  (toolbar function `SyncNoteBeta`) for side-by-side testing, folded into
  `SyncNote.js` on approval. **No beta branches** (Zack's call, 2026-07-10) —
  the beta file lives on main. CONSEQUENCE: never bless/merge to `release`
  while `SyncNoteBeta.js` exists on main — fold it or delete it first, or the
  beta file ships to the public channel.
- **Instrument before theorizing**: add Message Log traces and ask for the log
  line rather than stacking blind fixes. Failed experiments get retired with a
  written cause (see KB §33), not endless retries.
- The UI is heavily user-tuned. Do not redesign layout unasked.
- **Any UI change applies to ALL THREE modes (Manual / Hybrid / Auto)
  unless Zack explicitly scopes it to one** (his rule, 2026-07-26).
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
- Window icon: `dlg.setWindowIcon` is UNBOUND in Harmony 22's Qt Script
  (live TypeError) — all icon code removed (v0.30.7). Don't reattempt
  unless a future Harmony binds the call.

## Releases & the self-updater (v0.30.0+)

- **`main` = development. `release` = teacher channel.** The script checks
  `https://raw.githubusercontent.com/makermatic/SyncNote/release/SyncNote.js`
  at every launch (repo must stay PUBLIC or every teacher's updater breaks).
- **Blessing flow:** Zack tests a build and blesses it → ASK HIM what version
  number the release should carry (main's current or his custom pick; must be
  incremental) → stamp if needed, merge/push to `release`. Never push to
  `release` without his explicit blessing.
- One version sequence across both branches — release simply lags main.
- First install = the `installer/` web installers (see next section); all
  later updates via the in-panel updater, which silently auto-installs any
  newer release at panel launch.
- Updater safety: downloads to a unique temp file, verifies content
  (`function SyncNote` + parseable version) before installing; `curl -f`
  writes nothing on HTTP errors. A failed check retries next launch.
- **After every push to `release`: verify the channel.** (1) Merging main
  over a re-stamped release can keep BOTH version lines — the updater
  parses the FIRST match, which silently masks the release. Check with
  `grep -c 'SN_VERSION    ='` (must be exactly 1). (2) The raw URL is
  CDN-cached ~5 min — verify via the commit-SHA raw URL immediately, or
  wait before live-testing.

## Installer (first install; v1.0.0, 2026-07-17)

- **`installer_kb.md` is required reading before touching anything in
  `installer/` or `README.md`.** It is the installer's own KB, separate from
  `syncnote_kb.md` on purpose.
- `installer/Install-SyncNote.bat` (Windows, double-click) and
  `installer/Install-SyncNote.command` (Mac; Terminal one-liner is the
  primary path) are **web installers**: they download the current `release`
  `SyncNote.js` at run time, so the installer files never go stale.
- All public links (README, Slack canvas) point at the **`release`** branch.
  Installer changes reach students only with the next blessing — never
  hot-push `release` outside the blessing ritual.
- Bump **`INST_VERSION`** in BOTH scripts on any installer change (it is
  independent of `SN_VERSION`); keep the two scripts functionally mirrored.
- The `.gitattributes` rules for `installer/` are load-bearing (the git blob
  is what students execute; the `.bat` must stay CRLF). Details in
  `installer_kb.md` §5.
- `install.ps1` stays a dev-only deploy tool — never link it to students.

## State / roadmap

Current: **v0.35.0**, blessed to `release` 2026-07-26 (seventh blessing) —
main and release aligned. v0.35.0 = perf pass + click fixes (KB §42): lazy
note editors, one timeline scan per rebuild, commits deferred out of the
text signal, Add buttons wired to `pressed` too (Harmony sometimes never
delivers a mouse RELEASE, so `clicked` alone lost saves), mid-span sub
reuse, persistent card selection, and one explicit prompt scroll policy.
A commit-path crash journal ships at `%TEMP%/syncnote_crashjournal.txt`
(survives a crash — read it FIRST when the open Enter crash recurs).
Earlier state: THREE note-adding modes (KB §40 — Manual / Hybrid
click-to-add / Auto playhead-following virtual prompt) plus the §41
aftershocks: scrub chars fixed via the textChanged path, DELETING THE NOTES
NODE NOW DELETES ITS NOTES (user decision; no undo once the panel runs),
and fresh layers stamp their note-bucket empty (Harmony recycles element
IDs — ghost-note fix). The §40/§41 engine facts are required reading: key
events never reach script filters, app-level event filters CRASH Harmony,
focus-stealing loses to the OS, element IDs get recycled. Perf:
full-rebuild-per-add is linear (~7 ms/group, baseline in §40); refresh
timing trace stays in until optimized. All features confirmed except where
the KB says retired.
First-install installer + student README shipped 2026-07-17 (installer v1.0.0,
awaiting Zack's real-machine tests; see installer_kb.md §8).
Open items: teacher
save-confirmation prompt (designed, KB §25.1), replies revival only if asked
(KB §37), eventual v1.0 for wider release. Notes persist only when the scene
saves (mitigated by save-on-close — do not "fix" further; Zack's decision).
