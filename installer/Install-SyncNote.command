#!/bin/bash
# SyncNote first-install web installer (macOS). See installer_kb.md.
#
# Two ways to run (both use this same file):
#   1) Terminal one-liner (recommended, no security prompts):
#      bash <(curl -fsSL https://raw.githubusercontent.com/makermatic/SyncNote/release/installer/Install-SyncNote.command)
#   2) Download and double-click (needs chmod +x and a Gatekeeper approval).
#
# Downloads the current blessed release of SyncNote.js and installs it into
# every Harmony user-scripts folder on this Mac. The self-updater inside
# SyncNote handles all future updates. Bash 3.2 compatible (macOS default).

INST_VERSION="1.0.0"
SN_URL="https://raw.githubusercontent.com/makermatic/SyncNote/release/SyncNote.js"

# Pause before the window closes ONLY when double-clicked as a .command
# (in the one-liner case $0 is /dev/fd/NN, so we exit without a keypress).
finish() {
  case "$0" in
    *.command) echo ""; read -p "Press Return to close this window. " _ ;;
  esac
  exit "${1:-0}"
}

echo ""
echo "SyncNote Installer v$INST_VERSION (Mac)"
echo "Downloading the latest SyncNote..."

tmp="$(mktemp /tmp/syncnote_install.XXXXXX)" || { echo "Could not create a temporary file."; finish 1; }

if ! curl -f -L -s -o "$tmp" "$SN_URL"; then
  echo ""
  echo "Could not download SyncNote. Please check your internet connection and try again."
  rm -f "$tmp"
  finish 1
fi

if [ ! -s "$tmp" ] || ! grep -q "function SyncNote" "$tmp"; then
  echo ""
  echo "The downloaded file failed verification. Please try again in a few minutes."
  rm -f "$tmp"
  finish 1
fi

ver="$(sed -n 's/.*SN_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp" | head -1)"
if [ -z "$ver" ]; then
  echo ""
  echo "The downloaded file failed verification. Please try again in a few minutes."
  rm -f "$tmp"
  finish 1
fi

# Every Harmony edition/version scripts folder, e.g.
# ~/Library/Preferences/Toon Boom Animation/Toon Boom Harmony Premium/2200-scripts
# The quoted prefix ends mid-path so the spaces are safe and the * still globs;
# when nothing matches, the pattern stays literal and the -d test skips it.
count=0
for dir in "$HOME/Library/Preferences/Toon Boom Animation/Toon Boom Harmony "*/*-scripts; do
  [ -d "$dir" ] || continue
  if cp -f "$tmp" "$dir/SyncNote.js"; then
    echo "  Installed -> $dir"
    count=$((count+1))
  fi
done
rm -f "$tmp"

if [ "$count" -eq 0 ]; then
  echo ""
  echo "No Harmony folders were found on this Mac."
  echo "Install Toon Boom Harmony, open it once, close it, then run this installer again."
  finish 1
fi

echo ""
echo "Done! SyncNote v$ver installed to $count folder(s)."
echo "Next steps:"
echo "  1) Restart Harmony (quit it fully and open it again)."
echo "  2) Add SyncNote to the Scripting toolbar (see the install guide)."
finish 0
