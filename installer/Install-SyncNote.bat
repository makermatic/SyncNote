<# : SyncNote first-install web installer (Windows). See installer_kb.md.
@echo off
title SyncNote Installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (Get-Content -Raw '%~f0')"
echo.
pause
exit /b
#>
# ---------------------------------------------------------------------------
# PowerShell payload. The block above is a cmd bootstrap that cmd executes
# and PowerShell ignores (it reads as a <# comment #>). Everything below runs
# in PowerShell 5.1+. Downloads the current blessed release of SyncNote.js
# and installs it into every Harmony user-scripts folder on this machine.
# The self-updater inside SyncNote handles all future updates.
# ---------------------------------------------------------------------------
$INST_VERSION = "1.0.0"
$SN_URL = "https://raw.githubusercontent.com/makermatic/SyncNote/release/SyncNote.js"

Write-Host ""
Write-Host "SyncNote Installer v$INST_VERSION (Windows)"

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "This installer needs Windows 10 or newer (curl.exe was not found)."
    exit 1
}

Write-Host "Downloading the latest SyncNote..."
$tmp = Join-Path $env:TEMP ("syncnote_install_" + [guid]::NewGuid().ToString("N") + ".js")
& curl.exe -f -L -s -o $tmp $SN_URL

$fail = $null
$ver  = $null
if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) {
    $fail = "Could not download SyncNote. Please check your internet connection and try again."
} else {
    $content = Get-Content -Raw $tmp
    if ($content -notlike "*function SyncNote*") {
        $fail = "The downloaded file failed verification. Please try again in a few minutes."
    } elseif ($content -match 'SN_VERSION\s*=\s*"([^"]+)"') {
        $ver = $Matches[1]
    } else {
        $fail = "The downloaded file failed verification. Please try again in a few minutes."
    }
}
if ($fail) {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    Write-Host ""
    Write-Host $fail
    exit 1
}

$targets = Get-ChildItem "$env:APPDATA\Toon Boom Animation\Toon Boom Harmony*\*-scripts" -Directory -ErrorAction SilentlyContinue
if (-not $targets) {
    Remove-Item $tmp -Force
    Write-Host ""
    Write-Host "No Harmony folders were found on this computer."
    Write-Host "Install Toon Boom Harmony, open it once, close it, then run this installer again."
    exit 1
}

$count = 0
foreach ($dir in $targets) {
    Copy-Item $tmp -Destination (Join-Path $dir.FullName "SyncNote.js") -Force
    Write-Host ("  Installed -> " + $dir.FullName)
    $count++
}
Remove-Item $tmp -Force

Write-Host ""
Write-Host "Done! SyncNote v$ver installed to $count folder(s)."
Write-Host "Next steps:"
Write-Host "  1) Restart Harmony (close it fully and open it again)."
Write-Host "  2) Add SyncNote to the Scripting toolbar (see the install guide)."
