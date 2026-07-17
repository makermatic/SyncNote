# SyncNote Installer — Knowledge Base

Authoritative log for everything under `installer/` plus `README.md`.
Separate from `syncnote_kb.md` on purpose: the installer is independent of
the SyncNote script itself. Read this before touching any installer file.

## 1. Purpose & scope

- The installer handles **FIRST install only**. After that, the self-updater
  inside `SyncNote.js` (syncnote_kb.md §36) owns every update — it polls the
  `release` branch at each panel launch and installs newer versions itself.
- Both installers are **web installers**: at run time they download the
  current blessed `SyncNote.js` from the `release` branch and install that.
  The installer file itself therefore never goes stale — a copy a student
  downloaded months ago still installs the newest release.
- Prior first-install flow (Zack's Slack zip, unpacked by hand) is retired
  as of v1.0.0 of the installer (2026-07-17).

## 2. File map

| File | Role |
|---|---|
| `installer/Install-SyncNote.bat` | Windows web installer. Batch/PowerShell polyglot; double-clicked by students. CRLF, never normalized (§5). |
| `installer/Install-SyncNote.command` | Mac web installer. One bash file serving BOTH the Terminal one-liner and the double-click path. LF. |
| `README.md` | Student-facing install guide (repo landing page). Public links live here; Zack posts them to his Slack canvas. |
| `install.ps1` | **NOT part of the installer.** Zack's dev deploy tool, auto-run by a Claude Code hook when `SyncNote.js` is edited. Never link it to students. |

Each installer carries its own `INST_VERSION` constant (independent of
`SN_VERSION`), printed in the banner line — a student screenshot immediately
identifies which installer build ran. **Bump `INST_VERSION` in BOTH files on
any installer change; keep the two scripts functionally mirrored.**

Current: **INST_VERSION 1.0.0** (both platforms), created 2026-07-17.

## 3. Verified Harmony user-scripts paths

Both verified 2026-07-17 against docs.toonboom.com (Harmony 22 Premium,
"Importing Scripts": https://docs.toonboom.com/help/harmony-22/premium/scripting/import-script.html)
and, on Windows, against the working `install.ps1` glob.

- **Windows:** `%APPDATA%\Toon Boom Animation\Toon Boom Harmony <Edition>\<ver>00-scripts\`
  (e.g. `...\Toon Boom Harmony Premium\2200-scripts`)
- **macOS:** `~/Library/Preferences/Toon Boom Animation/Toon Boom Harmony <Edition>/<ver>00-scripts/`
  — identical structure, different root. The Library folder is hidden in
  Finder (Option + Go menu).

Both installers glob `Toon Boom Harmony*/*-scripts` under the per-OS root
and copy into **every** match (all editions, all versions — 22/24/25 without
hardcoding), exactly like `install.ps1`. Storyboard Pro is excluded by the
`Toon Boom Harmony` prefix. If no folder matches, the installer tells the
student to open Harmony once (Harmony creates the folders on first launch)
and re-run.

## 4. Design decisions

- **D1 — .bat is a batch/PowerShell polyglot.** First 8 lines are a cmd
  bootstrap inside `<# : ... #>` (PowerShell reads that as a block comment;
  cmd executes it — the `<# :` first line parses as a label in cmd and is
  skipped). The bootstrap runs
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (Get-Content -Raw '%~f0')"`,
  then `pause`. Rationale: pure cmd globbing/quoting with spaces in
  `%APPDATA%` is fragile; PowerShell 5.1 is guaranteed on Win 10/11.
  **Designated fallback** if a school AV blocks the `iex` pattern: collapse
  the logic into one long `-Command "..."` string (single-quotes inside).
- **D2 — One Mac file, two delivery modes.** The `.command` pauses
  (`read -p`) only when `$0` ends in `.command` (double-click case). Via the
  one-liner `bash <(curl -fsSL ...)`, `$0` is `/dev/fd/NN`, so it exits
  cleanly with no keypress. Process substitution (not `curl | bash`) keeps
  stdin a tty. Works from macOS's default zsh.
- **D3 — All public links point at `release`.** One public channel,
  consistent with `SN_UPDATE_URL`. Consequence: installer fixes reach
  students only with the next blessing (or an explicit off-cycle release
  push — Zack's call, full ritual required). Pre-bless testing substitutes
  `main` in the raw URLs.
- **D4 — Guide is the repo-root `README.md`** (GitHub renders it on the
  public landing page; no separate INSTALL.md to drift).
- **D5 — Zero-decision UX.** No confirm prompts; the script prints each
  folder as it installs. Failure messages are student-friendly and the
  window always stays open long enough to read them (cmd `pause` lives in
  the bootstrap, so it fires even if the PowerShell payload dies).
- **D6 — Verification mirrors the self-updater:** `curl -f -L -s -o` to a
  unique temp file; require non-empty + contains `function SyncNote` +
  parseable `SN_VERSION\s*=\s*"..."`. `-f` means HTTP errors write nothing.

## 5. Line-ending policy (load-bearing)

Students execute the **git blob** byte-for-byte (raw.githubusercontent.com /
GitHub's "Download raw file"). The repo-wide `* text=auto` stores LF, and an
LF-only `.bat` has documented cmd parsing flakiness. Hence `.gitattributes`:

```
installer/*.bat      -text
installer/*.command  text eol=lf
```

- **Never let `* text=auto` reclaim these files.** The rules landed in the
  same commit as the files; attribute changes do NOT rewrite existing blobs
  (a renormalization commit would be needed).
- Verify after any change: `git ls-files --eol installer/` → the `.bat`
  must show `-text`, the `.command` `i/lf`. After a push, byte-check the raw
  URL: `curl -s <raw .bat url> | od -c | head` must show `\r \n`.
- The `.command` has the executable bit set in the index
  (`git update-index --chmod=+x`) — helps git clones; browser downloads
  strip it regardless (§6).

## 6. OS / browser security behaviors (documented in README)

- **Raw URLs render, they don't download.** raw.githubusercontent.com serves
  text/plain — a student clicking a raw `.bat` link sees a wall of text.
  README links go to the GitHub **blob page** + "Download raw file" button.
  The Mac one-liner is immune (curl fetches the raw URL directly).
- **Chrome warns on .bat downloads** ("can harm your computer") → Keep.
- **Windows** may show "Open File – Security Warning" → Run. SmartScreen
  mostly targets .exe; a .bat usually passes with just that prompt.
- **Mac downloads lose the execute bit** (browsers strip it), so the
  double-click path needs `chmod +x` BEFORE Gatekeeper is even involved.
  Then: right-click → Open (older macOS) or System Settings → Privacy &
  Security → Open Anyway (Sequoia+). This is why the one-liner is the
  primary path — it has zero prompts on every macOS version.

## 7. Gotchas ledger (paid for in design/testing)

- **`curl` is an alias in PowerShell 5.1** (→ Invoke-WebRequest, different
  flags). The .bat must call **`curl.exe`** explicitly.
- **`'%~f0'` quoting** in the bootstrap breaks if the Windows account name
  contains an apostrophe (rare; symptom: PS parse error, banner never
  prints). Accepted risk.
- **Mac glob with spaces:** written as
  `"$HOME/.../Toon Boom Harmony "*/*-scripts` — the quoted prefix ends
  mid-path so spaces are safe and both `*` components still glob. An
  unmatched glob stays literal in bash 3.2 (no nullglob), handled by
  `[ -d "$dir" ] || continue`.
- **`mktemp /tmp/syncnote_install.XXXXXX`** — template form works on both
  BSD (macOS) and GNU mktemp.
- **Bash 3.2 ceiling** on macOS (Apple ships no newer bash) — no bash-4
  features (no `readarray`, no `globstar`, etc.).
- **Copy must RENAME temp → `SyncNote.js`** (explicit destination filename).
  Copying the temp file under its random name would "succeed" while
  installing nothing Harmony can load.
- **No `set -e`** in the .command: we want friendly messages, not silent
  death.

## 8. Testing log

- **2026-07-17 (build 1.0.0, local simulation, Windows dev machine):**
  PowerShell payload run with `$env:APPDATA` pointed at a fake tree
  containing `Toon Boom Harmony Premium\2200-scripts` +
  `Toon Boom Harmony Advanced\2400-scripts` → downloaded release v0.33.0,
  verified, installed to both, correct summary. cmd bootstrap exercised
  end-to-end via `cmd /c`. `.command` run under Git Bash with `$HOME`
  pointed at a fake tree → same results; no-folders path and pause-detection
  both verified. NOT yet run on a real Mac or via real double-click —
  see below.
- **PENDING:** Zack real-machine Windows test (browser download + double
  click); real-Mac test of the one-liner and the .command alternative;
  post-blessing raw-URL byte checks on the `release` `.bat`.
