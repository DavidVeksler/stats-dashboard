$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Push-Location (Join-Path $PSScriptRoot "..")
try {
  & node scripts/refresh-stats.mjs @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
