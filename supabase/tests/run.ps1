# Runs supabase/tests/rls.sql in a throwaway Postgres container. Requires Docker.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'cf-rls-test'
docker rm -f $name 2>$null | Out-Null
docker run -d --name $name -e POSTGRES_PASSWORD=pw postgres:16-alpine | Out-Null
try {
  for ($i = 0; $i -lt 30; $i++) {
    docker exec $name pg_isready -U postgres 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Seconds 2
  docker cp $root "${name}:/work"
  docker exec -w /work/tests $name psql -U postgres -v ON_ERROR_STOP=1 -f rls.sql
  if ($LASTEXITCODE -ne 0) { throw 'RLS tests failed' }
} finally {
  docker rm -f $name | Out-Null
}
