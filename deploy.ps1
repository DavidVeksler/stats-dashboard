[CmdletBinding()]
param(
  [switch]$Refresh,
  [switch]$Schema,
  [string]$GscKey,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
trap {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# Prefer Git Bash. The Windows `bash.exe` command points to WSL on this machine,
# whose Node runtime may be older than Wrangler supports.
$candidates = @(
  "C:\Program Files\Git\bin\bash.exe",
  "C:\Program Files\Git\usr\bin\bash.exe",
  "C:\Program Files (x86)\Git\bin\bash.exe"
)

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
  $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
  $candidates += (Join-Path $gitRoot "bin\bash.exe")
}

$bash = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $bash) {
  throw "Git Bash was not found. Install Git for Windows or run deploy.sh from a Bash environment with Node 22+."
}

$nodeVersion = (& $bash -c 'node -p "process.versions.node"').Trim()
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]"22.0.0") {
  throw "Git Bash resolves Node $nodeVersion; Wrangler requires Node 22 or newer."
}

$deployArgs = @("./deploy.sh")
if ($Refresh) { $deployArgs += "--refresh" }
if ($Schema) { $deployArgs += "--schema" }
if ($Yes) { $deployArgs += "--yes" }
if ($GscKey) {
  $keyPath = (Resolve-Path -LiteralPath $GscKey).Path -replace "\\", "/"
  $deployArgs += @("--gsc-key", $keyPath)
}

Push-Location $PSScriptRoot
try {
  Write-Host "Using Git Bash ($nodeVersion): $bash"
  & $bash @deployArgs
  if ($LASTEXITCODE -ne 0) {
    throw "deploy.sh failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
