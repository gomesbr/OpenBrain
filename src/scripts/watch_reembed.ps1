param(
  [int]$IntervalSec = 30,
  [string]$CheckpointPath = ".\.reembed_checkpoint.json",
  [string]$LogPath = ".\.reembed.log",
  [string]$DbService = "openbrain-db",
  [string]$DbName = "openbrain",
  [string]$DbUser = "openbrain",
  [switch]$Once
)

$ErrorActionPreference = "Stop"

function Get-TrimmedText {
  param([string]$Text)
  if ($null -eq $Text) { return "" }
  return $Text.Trim()
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
  if (-not (Test-Path $Path)) { return $null }
  return Get-Content $Path -Raw | ConvertFrom-Json
}

function Get-LastLogLine {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  $line = Get-Content $Path -Tail 1 -ErrorAction SilentlyContinue
  return Get-TrimmedText -Text $line
}

function Get-RateFromLogLine {
  param([string]$Line)
  $rate = 0.0
  if ($Line -match "rate=([0-9]+(\.[0-9]+)?)") {
    [double]::TryParse($matches[1], [ref]$rate) | Out-Null
  }
  return $rate
}

function Format-Eta {
  param(
    [int]$Remaining,
    [double]$RatePerSec
  )
  if ($RatePerSec -le 0 -or $Remaining -le 0) { return "n/a" }
  $seconds = [int][math]::Round($Remaining / $RatePerSec)
  $ts = [timespan]::FromSeconds($seconds)
  return "{0:00}:{1:00}:{2:00}" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds
}

function Get-SourceBreakdown {
  param(
    [string]$Service,
    [string]$Database,
    [string]$User,
    [object]$Checkpoint
  )

  $lastTsLiteral = "NULL::timestamptz"
  $lastIdLiteral = "NULL::uuid"

  if ($Checkpoint -and $Checkpoint.lastCreatedAt -and $Checkpoint.lastId) {
    $safeTs = [string]$Checkpoint.lastCreatedAt
    $safeId = [string]$Checkpoint.lastId
    $lastTsLiteral = "'$safeTs'::timestamptz"
    $lastIdLiteral = "'$safeId'::uuid"
  }

  $sql = @"
WITH c AS (
  SELECT $lastTsLiteral AS last_ts, $lastIdLiteral AS last_id
)
, per_source AS (
  SELECT m.source_system,
         COUNT(*) AS total_rows,
         COUNT(*) FILTER (
           WHERE c.last_ts IS NOT NULL
             AND (m.created_at, m.id) <= (c.last_ts, c.last_id)
         ) AS done_rows,
         COUNT(*) FILTER (
           WHERE c.last_ts IS NULL
              OR (m.created_at, m.id) > (c.last_ts, c.last_id)
         ) AS pending_rows
  FROM memory_items m
  CROSS JOIN c
  GROUP BY m.source_system
)
SELECT source_system,
       total_rows,
       done_rows,
       pending_rows,
       ROUND(
         CASE
           WHEN total_rows > 0 THEN (done_rows::numeric / total_rows::numeric) * 100
           ELSE 100
         END,
         2
       ) AS pct_done
FROM per_source
ORDER BY total_rows DESC;
"@

  return docker exec $Service psql -U $User -d $Database -c $sql
}

function Get-RunningIngestionJobs {
  param(
    [string]$Service,
    [string]$Database,
    [string]$User
  )
  $sql = @"
SELECT source_system, status, COUNT(*) AS jobs
FROM ingestion_jobs
WHERE status = 'running'
GROUP BY source_system, status
ORDER BY source_system;
"@
  return docker exec $Service psql -U $User -d $Database -c $sql
}

function Get-ReembedProcessSummary {
  $procs = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match "reembed_all\.ts|reembed:all" } |
    Select-Object ProcessId, Name, CommandLine

  if (-not $procs) {
    return "none"
  }

  $ids = ($procs | Select-Object -ExpandProperty ProcessId) -join ", "
  return "running (pid: $ids)"
}

while ($true) {
  try {
    $total = Get-TotalRows -Service $DbService -Database $DbName -User $DbUser
    $checkpoint = Get-Checkpoint -Path $CheckpointPath
    $lastLog = Get-LastLogLine -Path $LogPath
    $rate = Get-RateFromLogLine -Line $lastLog

    $processed = 0
    $failed = 0
    $updatedAt = ""
    if ($checkpoint) {
      $processed = [int]$checkpoint.processed
      $failed = [int]$checkpoint.failed
      $updatedAt = [string]$checkpoint.updatedAt
    }

    $remaining = [math]::Max(0, $total - $processed)
    $pct = if ($total -gt 0) { [math]::Round(($processed / [double]$total) * 100, 2) } else { 100.0 }
    $eta = Format-Eta -Remaining $remaining -RatePerSec $rate
    $procSummary = Get-ReembedProcessSummary

    Write-Host ""
    Write-Host ("[{0}] Re-embed monitor" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
    Write-Host ("Progress: {0}% ({1}/{2}) | remaining={3} | failed={4}" -f $pct, $processed, $total, $remaining, $failed)
    Write-Host ("Rate: {0}/s | ETA: {1}" -f ([math]::Round($rate, 2)), $eta)
    Write-Host ("Checkpoint updated: {0}" -f ($(if ($updatedAt) { $updatedAt } else { "n/a" })))
    Write-Host ("Worker process: {0}" -f $procSummary)
    if ($lastLog) {
      Write-Host ("Last log line: {0}" -f $lastLog)
    }

    Write-Host ""
    Write-Host "Per-source breakdown:"
    Get-SourceBreakdown -Service $DbService -Database $DbName -User $DbUser -Checkpoint $checkpoint

    Write-Host ""
    Write-Host "Running ingestion jobs:"
    Get-RunningIngestionJobs -Service $DbService -Database $DbName -User $DbUser
  } catch {
    Write-Host ("Monitor error: {0}" -f $_.Exception.Message)
  }

  if ($Once) { break }
  Start-Sleep -Seconds ([math]::Max(5, $IntervalSec))
}
