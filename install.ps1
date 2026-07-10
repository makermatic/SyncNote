# install.ps1 — copy SyncNote.js (+ its window icon) into every Toon Boom
# Harmony user-scripts folder.
#
# Run manually:   powershell -ExecutionPolicy Bypass -File install.ps1
# Also run automatically by a Claude Code hook whenever SyncNote.js is updated.
#
# Harmony user scripts live at:
#   %APPDATA%\Toon Boom Animation\Toon Boom Harmony <Edition>\<version>00-scripts\
# This script finds all of them (Premium/Advanced/Essentials, any version),
# so it works on Harmony 22, 24, 25… without hardcoding a path.

$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "SyncNote.js"
if (-not (Test-Path $source)) {
    Write-Error "SyncNote.js not found next to install.ps1 ($source)"
    exit 1
}

# All Harmony (not Storyboard Pro) script folders, e.g. ...\Toon Boom Harmony Premium\2200-scripts
$targets = Get-ChildItem "$env:APPDATA\Toon Boom Animation\Toon Boom Harmony*\*-scripts" -Directory -ErrorAction SilentlyContinue

if (-not $targets) {
    Write-Warning "No Harmony scripts folders found under $env:APPDATA\Toon Boom Animation\"
    exit 1
}

foreach ($dir in $targets) {
    Copy-Item $source -Destination $dir.FullName -Force
    Write-Output "Installed SyncNote.js -> $($dir.FullName)"
}
