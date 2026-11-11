# Cloud Supabase (supabase.com) helper. Usage: scripts/supabase-cloud.ps1 <link|diff|push|status> [-ProjectRef <ref>] [-Yes]
# Secrets come from the environment only and are never printed:
#   SUPABASE_ACCESS_TOKEN  CLI token (or run `npx supabase login` once)
#   SUPABASE_DB_PASSWORD   remote database password (link/diff/push)
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('link', 'diff', 'push', 'status')]
  [string]$Action,
  [string]$ProjectRef,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$refFile = Join-Path $root 'supabase\.temp\project-ref'

function Assert-Linked {
  if (-not (Test-Path $refFile)) { throw 'Not linked. Run: link -ProjectRef <ref>' }
  Write-Host 'Target project ref:' ((Get-Content $refFile -Raw).Trim())
}
function Assert-Env([string]$name) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Environment variable $name is not set." }
}
function Assert-Ok { if ($LASTEXITCODE -ne 0) { throw "supabase $Action failed (exit $LASTEXITCODE)" } }

switch ($Action) {
  'link' {
    if (-not $ProjectRef) { throw 'link requires -ProjectRef <ref>.' }
    Assert-Env 'SUPABASE_DB_PASSWORD'
    npx supabase link --project-ref $ProjectRef
    Assert-Ok
  }
  'diff' {
    Assert-Linked
    Assert-Env 'SUPABASE_DB_PASSWORD'
    npx supabase db push --remote --dry-run
    Assert-Ok
  }
  'push' {
    Assert-Linked
    Assert-Env 'SUPABASE_DB_PASSWORD'
    npx supabase db push --remote --dry-run
    Assert-Ok
    if (-not $Yes) {
      Write-Host 'Dry-run only. Review the list above, then re-run with -Yes to apply to the CLOUD database.'
      exit 0
    }
    npx supabase db push --remote
    Assert-Ok
  }
  'status' {
    if (Test-Path $refFile) {
      Write-Host 'Linked project ref:' (Get-Content $refFile)
      npx supabase migration list --remote
      Assert-Ok
    } else { Write-Host 'Not linked.' }
  }
}
