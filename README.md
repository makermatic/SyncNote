# SyncNote

SyncNote is a review-notes panel for Toon Boom Harmony (22, 24, and 25).
It lets your instructor leave dated notes tied to specific frames of your
scene — like Frame.io or SyncSketch, but living right inside Harmony. Notes
are saved with the scene itself, so they travel with your project file.

> 📷 *Screenshot to add: the SyncNote panel open next to a scene.*

---

## Install on Windows

1. **Download the installer:** open
   [Install-SyncNote.bat](https://github.com/makermatic/SyncNote/blob/release/installer/Install-SyncNote.bat)
   and click the **Download raw file** button (the little download icon near
   the top-right of the file view).

   > 📷 *Screenshot to add: the Download raw file button on GitHub.*

2. Your browser may warn that this kind of file "can harm your computer" —
   that's a standard warning for any `.bat` file. Choose **Keep** /
   **Download anyway**.

   > 📷 *Screenshot to add: the Chrome download warning.*

3. **Double-click** the downloaded `Install-SyncNote.bat`. If Windows shows
   an "Open File – Security Warning", click **Run**.

4. A black window opens, downloads the latest SyncNote, and installs it.
   Success looks like this:

   ```
   SyncNote Installer v1.0.0 (Windows)
   Downloading the latest SyncNote...
     Installed -> C:\Users\you\AppData\Roaming\Toon Boom Animation\Toon Boom Harmony Premium\2400-scripts

   Done! SyncNote v0.33.0 installed to 1 folder(s).
   ```

## Install on Mac

**The easy way (recommended):**

1. Open **Terminal** (press `Cmd + Space`, type `Terminal`, press Return).
2. Copy this whole line, paste it into Terminal, and press Return:

   ```
   bash <(curl -fsSL https://raw.githubusercontent.com/makermatic/SyncNote/release/installer/Install-SyncNote.command)
   ```

3. You'll see the same "Done! SyncNote vX.Y.Z installed…" message as above.

   > 📷 *Screenshot to add: Terminal showing the success output.*

**Alternative (download + double-click):** you can instead download
[Install-SyncNote.command](https://github.com/makermatic/SyncNote/blob/release/installer/Install-SyncNote.command)
(Download raw file button), then in Terminal run
`chmod +x ~/Downloads/Install-SyncNote.command` (browsers remove the
run permission), and open it via **right-click → Open**. On the newest
macOS versions Apple will still block it once, and you'll need
**System Settings → Privacy & Security → Open Anyway**. Honestly: the
one-liner above is easier.

> If the installer says **"No Harmony folders were found"**, open Harmony
> once, close it, and run the installer again — Harmony creates its folders
> on first launch.

---

## Add SyncNote to your toolbar (both platforms)

1. **Restart Harmony** (close it fully and open it again — Harmony only
   loads scripts at startup).
2. Make sure the Scripting toolbar is visible: **Windows → Toolbars →
   Scripting** (yes, the menu is called "Windows" on Mac too).
3. On the Scripting toolbar, click **Manage Scripts** (the wrench icon).
4. In the left list, select **SyncNote.js**; in the middle list, select the
   **SyncNote** function; then click the **▶ (Add script to toolbar)**
   button and close the dialog.
5. Click the new SyncNote button on the Scripting toolbar — the panel opens.

> 📷 *Screenshots to add: Scripting toolbar menu, Manage Scripts dialog,
> the SyncNote button.*

## Updates

Automatic. Every time you open SyncNote it checks for a newer version and
installs it by itself. **You never need to run the installer again** — it's
only for the first install on a new machine.

## Troubleshooting

- **"No Harmony folders were found"** — open Harmony once, close it, re-run
  the installer.
- **Nothing happens when I double-click the installer (Windows)** — your
  antivirus may have blocked it; check its quarantine/notifications, or ask
  your instructor.
- **SyncNote.js doesn't appear in Manage Scripts** — make sure you fully
  restarted Harmony after installing; if it's still missing, re-run the
  installer.
- **Mac says the .command "can't be opened"** — use the Terminal one-liner
  from the Mac section instead; it skips all of that.

## Uninstall

Delete `SyncNote.js` from your Harmony scripts folder(s):

- **Windows:** `%APPDATA%\Toon Boom Animation\Toon Boom Harmony <Edition>\<version>00-scripts\`
- **Mac:** `~/Library/Preferences/Toon Boom Animation/Toon Boom Harmony <Edition>/<version>00-scripts/`
  (in Finder, hold **Option** and use **Go → Library** to reach the hidden
  Library folder)

Your notes are stored inside the scene files themselves, so uninstalling
the panel never deletes any notes.
