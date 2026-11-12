# ContentFlow AI desktop build (Windows, NSIS, unsigned dev installer).
# 1) apps/web standalone build  2) copy web + pinned Node runtime + Node LICENSE into resources
# 3) tauri build (NSIS)  4) report installer size.
# Usage: pwsh scripts/desktop-build.ps1 [-NodeVersion 24.13.0] [-SkipWebBuild]
param(
  [string]$NodeVersion = "24.13.0",
  [switch]$SkipWebBuild
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$desktop = Join-Path $root "apps/desktop"
$res = Join-Path $desktop "src-tauri/resources"
$web = Join-Path $root "apps/web"

function Run($exe, $argList, $dir) {
  Push-Location $dir
  try { & $exe @argList; if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" } } finally { Pop-Location }
}

# --- 1) web build
if (-not $SkipWebBuild) { Run "npm" @("run", "build", "--workspace", "apps/web") $root }
$standalone = Join-Path $web ".next/standalone"
if (-not (Test-Path (Join-Path $standalone "apps/web/server.js"))) { throw "standalone server.js not found: $standalone" }

# --- 2) resources
Get-ChildItem $res -Force | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Recurse -Force
$webOut = Join-Path $res "web"
Copy-Item $standalone $webOut -Recurse
# Local env files must never ship.
Get-ChildItem $webOut -Recurse -Force -Include ".env*" | Remove-Item -Force
Copy-Item (Join-Path $web ".next/static") (Join-Path $webOut "apps/web/.next/static") -Recurse
if (Test-Path (Join-Path $web "public")) { Copy-Item (Join-Path $web "public") (Join-Path $webOut "apps/web/public") -Recurse }

# Pinned official Node runtime (zip carries node.exe + LICENSE). The SHA256 is fixed here
# (checked against https://nodejs.org/dist/v24.13.0/SHASUMS256.txt on 2026-11-12); bump both together.
$NodeZipSha256 = "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88"
if ($NodeVersion -ne "24.13.0") { throw "Node $NodeVersion has no pinned SHA256; update `$NodeZipSha256 first." }
function Get-Sha256($path) {
  ([System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes($path))) -replace "-", "").ToLower()
}
$cache = Join-Path $root ".cache/node"
New-Item -ItemType Directory -Force $cache | Out-Null
$name = "node-v$NodeVersion-win-x64"
$zip = Join-Path $cache "$name.zip"
$unz = Join-Path $cache $name
if ((Test-Path $zip) -and ((Get-Sha256 $zip) -ne $NodeZipSha256)) { Remove-Item $zip -Force }
if (-not (Test-Path $zip)) { Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/$name.zip" -OutFile $zip }
if ((Get-Sha256 $zip) -ne $NodeZipSha256) { Remove-Item $zip -Force; throw "Node zip SHA256 mismatch" }
# Always re-extract from the verified zip so a tampered cache folder is never used.
if (Test-Path $unz) { Remove-Item $unz -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $cache)
$nodeOut = Join-Path $res "node"
New-Item -ItemType Directory -Force $nodeOut | Out-Null
Copy-Item (Join-Path $unz "node.exe") $nodeOut
Copy-Item (Join-Path $unz "LICENSE") (Join-Path $nodeOut "LICENSE")

# --- 3) NSIS
Run "npm" @("run", "tauri", "--", "build", "--bundles", "nsis") $desktop

# --- 4) report
$setup = Get-ChildItem (Join-Path $desktop "src-tauri/target/release/bundle/nsis/*-setup.exe") | Select-Object -First 1
if (-not $setup) { throw "NSIS installer not found" }
$resMb = [math]::Round(((Get-ChildItem $res -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ("Installer: {0} ({1} MB), unpacked resources: {2} MB (limit 200 MB)" -f $setup.FullName, [math]::Round($setup.Length / 1MB, 1), $resMb)
