param(
  [int]$Canonical = 10000,
  [int]$Candidates = 250000,
  [string]$BaseUrl = "http://127.0.0.1:4301",
  [string]$EnvPath = ".\.env",
  [string]$LogPath = ".\generated\v2_bootstrap_then_rebuild.log",
  [string]$ChatNamespace = "personal.main",
  [int]$Days = 3650
)

$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $Message"
  Write-Host $line
  Add-Content -Path $script:ResolvedLogPath -Value $line
}

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Key
  )
  if (-not (Test-Path $Path)) { return "" }
  $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
  if (-not $line) { return "" }
  $value = ($line -split "=", 2)[1]
  if ($null -eq $value) { return "" }
  return $value.Trim()
}

function Login-OpenBrain {
  param(
    [string]$Url,
    [string]$Password
  )
  $body = @{ password = $Password } | ConvertTo-Json
  $res = Invoke-RestMethod -Method POST -Uri "$Url/v1/auth/login" -ContentType "application/json" -Body $body
  $token = [string]$res.token
  if (-not $token) { throw "Login failed: no token returned." }
  return $token
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $repoRoot
try {
  $script:ResolvedLogPath = [System.IO.Path]::GetFullPath($LogPath)
  $logDir = Split-Path -Parent $script:ResolvedLogPath
  if ($logDir -and -not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  if (-not (Test-Path $script:ResolvedLogPath)) {
    New-Item -ItemType File -Path $script:ResolvedLogPath -Force | Out-Null
  }

  Write-Log "Starting V2 bootstrap (canonical=$Canonical, candidates=$Candidates)."
  & npm run v2:quality:bootstrap -- --canonical=$Canonical --candidates=$Candidates *>> $script:ResolvedLogPath
  if ($LASTEXITCODE -ne 0) {
    throw "v2:quality:bootstrap failed with exit code $LASTEXITCODE"
  }
  Write-Log "V2 bootstrap completed."

  $appPassword = Get-EnvValue -Path $EnvPath -Key "OPENBRAIN_APP_PASSWORD"
  if (-not $appPassword) {
    throw "OPENBRAIN_APP_PASSWORD not found in $EnvPath"
  }

  $token = Login-OpenBrain -Url $BaseUrl -Password $appPassword
  Write-Log "Authenticated to OpenBrain."

  $jobs = Invoke-RestMethod -Method GET -Uri "$BaseUrl/v1/brain/jobs?limit=20" -Headers @{ Authorization = "Bearer $token" }
  $runningRebuild = @($jobs.jobs) | Where-Object { $_.jobType -eq "rebuild" -and $_.status -eq "running" } | Select-Object -First 1
  if ($runningRebuild) {
    Write-Log "Rebuild already running. id=$($runningRebuild.id)"
    exit 0
  }

  $rebuildBody = @{
    chatNamespace = $ChatNamespace
    days = $Days
  } | ConvertTo-Json

  $started = Invoke-RestMethod -Method POST -Uri "$BaseUrl/v1/brain/jobs/rebuild" `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType "application/json" `
    -Body $rebuildBody

  if ($started.ok -ne $true) {
    throw "Rebuild trigger returned ok=false"
  }

  Write-Log "Rebuild triggered. jobId=$($started.jobId) queued=$($started.queued)"
  exit 0
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  throw
} finally {
  Pop-Location
}
