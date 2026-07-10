/*
 * SyncNoteUpdaterProbe.js — throwaway diagnostic for the auto-updater.
 *
 * Tests every unproven API the updater needs, without touching SyncNote.js:
 *   1. platform detection (about.isWindowsArch / isMacArch)
 *   2. preferences round-trip (the "first-ever-open" flag storage)
 *   3. a temp folder we can write to
 *   4. Process2 launching curl to download a file over HTTPS
 *   5. verifying the downloaded file (existence, size, content sniff)
 *
 * HOW TO RUN: restart Harmony, open the Script Editor, run
 * SyncNoteUpdaterProbe(). Wait ~10 seconds (a popup will confirm), then
 * copy every "PROBE:" line from the Message Log and paste it to Claude.
 */

var g_probeKeepAlive = []; // pin timers or GC kills them (KB §7.3.5 #10)

function SyncNoteUpdaterProbe() {
  function say(m) {
    try { MessageLog.trace("PROBE: " + m); } catch (e) {}
  }
  say("=== SyncNote updater probe start ===");

  // ---- 1. platform detection ----
  var isWin = false;
  var isMac = false;
  try { isWin = about.isWindowsArch(); }
  catch (e) { say("about.isWindowsArch FAILED: " + e); }
  try { isMac = about.isMacArch(); }
  catch (e) { say("about.isMacArch FAILED: " + e); }
  say("platform: windows=" + isWin + " mac=" + isMac);

  // ---- 2. preferences round-trip ----
  try {
    preferences.setString("SYNCNOTE_PROBE_TEST", "hello_" + new Date().getTime());
    var back = "";
    try { back = String(preferences.getString("SYNCNOTE_PROBE_TEST", "")); }
    catch (e0) { say("preferences.getString FAILED: " + e0); }
    say("preferences round-trip: " +
        (back.indexOf("hello_") === 0 ? "OK (" + back + ")" : "MISMATCH ('" + back + "')"));
  } catch (e) { say("preferences.setString FAILED: " + e); }

  // ---- 3. temp folder ----
  var tmp = "";
  try { tmp = String(specialFolders.temp); } catch (e) { say("specialFolders.temp FAILED: " + e); }
  if (!tmp) { try { tmp = String(specialFolders.userScripts); } catch (e) {} }
  say("temp folder: " + (tmp || "NONE — probe cannot continue"));
  if (!tmp) { say("=== probe aborted ==="); return; }
  var outFile = tmp + "/syncnote_probe_download.js";

  // Clear any previous probe download so this run can't read stale results.
  try {
    if (new QFileInfo(outFile).exists()) {
      try { new File(outFile).remove(); say("removed stale download"); }
      catch (e1) { say("could not remove stale download (" + e1 + ") — results may be stale!"); }
    }
  } catch (e) {}

  // ---- 4. Process2 + curl download ----
  // curl ships with Windows 10+ AND macOS — if this works on both, one
  // identical command serves every teacher.
  var url = "https://raw.githubusercontent.com/makermatic/SyncNote/main/SyncNote.js";
  var cmd = 'curl -L -s -o "' + outFile + '" "' + url + '"';
  say("command: " + cmd);

  var launched = "";
  try {
    var p = new Process2(cmd);
    // Try the synchronous form first (best for us: immediate exit code)...
    try {
      var code = p.execute();
      launched = "execute() returned " + code;
    } catch (eExec) {
      // ...fall back to fire-and-forget.
      try {
        p.launch();
        launched = "launch() fired (no exit code available)";
      } catch (eLaunch) {
        launched = "BOTH execute() and launch() FAILED: " + eExec + " / " + eLaunch;
      }
    }
  } catch (eCtor) {
    launched = "new Process2(...) FAILED: " + eCtor;
  }
  say("Process2: " + launched);

  // ---- 5. verify the download (after letting curl finish) ----
  function verify(label) {
    try {
      var info = new QFileInfo(outFile);
      if (!info.exists()) { say(label + ": file does NOT exist"); return; }
      var size = Number(info.size());
      say(label + ": file exists, " + size + " bytes");
      try {
        var f = new File(outFile);
        f.open(1); // 1 = read mode (FileAccess constants)
        var head = String(f.read());
        f.close();
        var looksRight = head.indexOf("function SyncNote") >= 0;
        var verMatch = head.match(/SN_VERSION\s*=\s*"([^"]+)"/);
        say(label + ": contains 'function SyncNote': " + looksRight +
            "; parsed version: " + (verMatch ? verMatch[1] : "NONE"));
      } catch (eRead) {
        say(label + ": File read FAILED (" + eRead + ") — need another read API");
      }
    } catch (e) { say(label + ": verify FAILED: " + e); }
  }

  verify("immediate check");

  // Re-check after 8s in case the download ran detached.
  try {
    var t = new QTimer();
    g_probeKeepAlive.push(t);
    t.singleShot = true;
    t.timeout.connect(function () {
      verify("8s check");
      say("=== probe done — paste all PROBE lines to Claude ===");
      try {
        MessageBox.information("Probe finished — see the Message Log " +
                               "(Windows > Message Log) and copy the PROBE lines.");
      } catch (e) {}
    });
    t.start(8000);
    say("waiting 8s for a second check…");
  } catch (e) {
    say("QTimer failed (" + e + ") — rely on the immediate check above");
    say("=== probe done — paste all PROBE lines to Claude ===");
  }
}
