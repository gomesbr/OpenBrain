param(
  [string]$CheckpointPath = ".\.reembed_checkpoint.json",
  [string]$EnvPath = ".\.env",
  [string]$BaseUrl = "http://127.0.0.1:4301",
  [string]$DbService = "openbrain-db",
  [string]$DbName = "openbrain",
  [string]$DbUser = "openbrain",
  [int]$PollSeconds = 45,
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$script:ResolvedLogPath = ""

if ($LogPath) {
  try {
    $script:ResolvedLogPath = [System.IO.Path]::GetFullPath($LogPath)
  } catch {
    $script:ResolvedLogPath = ""
  }
}

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $Message"
  Write-Host $line
  if ($script:ResolvedLogPath) {
    try {
      Add-Content -Path $script:ResolvedLogPath -Value $line
    } catch {
      # Ignore log file write errors.
    }
  }
}

function Get-TrimmedText {
  param([string]$Text)
  if ($null -eq $Text) { return "" }
  return $Text.Trim()
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

function Get-TotalRows {
  param(
    [string]$Service,
    [string]$Database,
    [string]$User
  )
  $raw = docker exec $Service psql -U $User -d $Database -t -A -c "SELECT COUNT(*) FROM memory_items;" 2>$null
  $text = Get-TrimmedText -Text ($raw -join "`n")
  $total = 0
  if (-not [int]::TryParse($text, [ref]$total)) {
    throw "Unable to read total row count from Postgres."
  }
  return $total
}

function Get-Checkpoint {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return [pscustomobject]@{
      processed = 0
      failed = 0
      updatedAt = $null
      lastCreatedAt = $null
      lastId = $null
    }
  }
  return Get-Content $Path -Raw | ConvertFrom-Json
}

function Get-ReembedRunning {
  $procs = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match "reembed_all\.ts|reembed:all" }
  return ($null -ne $procs -and $procs.Count -gt 0)
}

function To-IntOrZero {
  param([object]$Value)
  if ($null -eq $Value) { return 0 }
  $out = 0
  if ([int]::TryParse([string]$Value, [ref]$out)) {
    return $out
  }
  return 0
}

function Login-OpenBrain {
  param(
    [string]$Url,
    [string]$Password
  )
  $body = @{ password = $Password } | ConvertTo-Json
  $res = Invoke-RestMethod -Method POST -Uri "$Url/v1/auth/login" -ContentType "application/json" -Body $body
  $token = Get-TrimmedText -Text ([string]$res.token)
  if (-not $token) {
    throw "Login succeeded without token."
  }
  return $token
}

function Get-BrainJobs {
  param(
    [string]$Url,
    [string]$Token
  )
  return Invoke-RestMethod -Method GET -Uri "$Url/v1/brain/jobs?limit=20" -Headers @{ Authorization = "Bearer $Token" }
}

function Start-Rebuild {
  param(
    [string]$Url,
    [string]$Token
  )
  $body = @{
    chatNamespace = "personal.main"
    days = 3650
  } | ConvertTo-Json

  return Invoke-RestMethod -Method POST -Uri "$Url/v1/brain/jobs/rebuild" `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType "application/json" `
    -Body $body
}

Write-Log "Watcher started. Waiting for re-embed completion."

$total = Get-TotalRows -Service $DbService -Database $DbName -User $DbUser
Write-Log "Total rows in memory_items: $total"

while ($true) {
  $checkpoint = Get-Checkpoint -Path $CheckpointPath
  $processed = To-IntOrZero -Value $checkpoint.processed
  $failed = To-IntOrZero -Value $checkpoint.failed
  $attempted = $processed + $failed
  $running = Get-ReembedRunning
  $pct = if ($total -gt 0) { [math]::Round(($attempted / [double]$total) * 100, 2) } else { 100.0 }

  Write-Log "Re-embed state: running=$running processed=$processed failed=$failed attempted=$attempted/$total ($pct%)"

  if ($attempted -ge $total -and $total -gt 0) {
    Write-Log "Checkpoint indicates completion (including failed rows)."
    break
  }

  if (-not $running -and $processed -lt $total) {
    Write-Log "Re-embed process is not running and checkpoint is incomplete. Not triggering rebuild."
    exit 1
  }

  Start-Sleep -Seconds ([math]::Max(15, $PollSeconds))
}

$appPassword = Get-EnvValue -Path $EnvPath -Key "OPENBRAIN_APP_PASSWORD"
if (-not $appPassword) {
  throw "OPENBRAIN_APP_PASSWORD not found in $EnvPath"
}

$token = Login-OpenBrain -Url $BaseUrl -Password $appPassword
Write-Log "Authenticated to OpenBrain."

$jobsPayload = Get-BrainJobs -Url $BaseUrl -Token $token
$jobs = @()
if ($jobsPayload -and $jobsPayload.jobs) {
  $jobs = @($jobsPayload.jobs)
}

$runningRebuild = $jobs | Where-Object {
  $_.jobType -eq "rebuild" -and $_.status -eq "running"
} | Select-Object -First 1

if ($runningRebuild) {
  Write-Log "A rebuild job is already running (id: $($runningRebuild.id)). Skipping new trigger."
  exit 0
}

$started = Start-Rebuild -Url $BaseUrl -Token $token
Write-Log "Rebuild triggered successfully. jobId=$($started.jobId) queued=$($started.queued)"
exit 0
