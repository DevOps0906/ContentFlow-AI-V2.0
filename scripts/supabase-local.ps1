# Local Supabase (Docker stack) helper. Usage: scripts/supabase-local.ps1 <start|status|migrate|reset|test|stop> [-Confirm]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('start', 'status', 'migrate', 'reset', 'test', 'stop')]
  [string]$Action,
  [switch]$Confirm
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

switch ($Action) {
  'start'   { npx supabase start }
  'status'  { npx supabase status }
  'migrate' { npx supabase migration up --local }
  'reset' {
    if (-not $Confirm) { throw 'reset DROPS the local database. Re-run with -Confirm.' }
    npx supabase db reset --local
  }
  'test'    { & (Join-Path $PSScriptRoot '..\supabase\tests\run.ps1') }
  'stop'    { npx supabase stop }
}
if ($LASTEXITCODE -ne 0) { throw "supabase $Action failed (exit $LASTEXITCODE)" }
