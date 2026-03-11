param(
  [string]$ChatNamespace = "personal.main",
  [string]$WaitSource = "grok",
  [string[]]$NextSources = @("chatgpt", "whatsapp"),
  [int]$Workers = 5,
  [int]$Claim = 10,
  [int]$Context = 10,
  [int]$RowRetries = 3,
  [int]$RetryBackoffMs = 1500,
  [int]$IdleSeconds = 45,
  [int]$OnlyMissing = 1,
  [int]$RetryFailed = 1,
  [int]$PollSeconds = 20,
  [string]$DbService = "openbrain-db",
  [string]$DbName = "openbrain",
  [string]$DbUser = "openbrain",
  [string]$LogPath = ".\\.metadata_queue_autoswitch.log"
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$resolvedLog = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $LogPath))

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $Message"
  Write-Host $line
  Add-Content -Path $resolvedLog -Value $line
}

function Get-QueueCounts {
  param([string]$Source)
  $sql = @"
SELECT
  COUNT(*) FILTER (WHERE status='pending') AS pending,
  COUNT(*) FILTER (WHERE status='processing') AS processing,
  COUNT(*) FILTER (WHERE status='done') AS done,
  COUNT(*) FILTER (WHERE status='failed') AS failed
FROM metadata_enrichment_queue
WHERE chat_namespace = '$ChatNamespace'
  AND source_system = '$Source';
"@

  $raw = docker exec $DbService psql -U $DbUser -d $DbName -t -A -F "," -c $sql 2>$null
  $line = ($raw | Select-Object -First 1).Trim()
  if (-not $line) {
    return [pscustomobject]@{ pending = 0; processing = 0; done = 0; failed = 0 }
  }

  $parts = $line.Split(",")
  if ($parts.Count -lt 4) {
    return [pscustomobject]@{ pending = 0; processing = 0; done = 0; failed = 0 }
  }
  return [pscustomobject]@{
    pending = [int]$parts[0]
    processing = [int]$parts[1]
    done = [int]$parts[2]
    failed = [int]$parts[3]
  }
}

function Stop-MetadataWorkers {
  $procs = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match "metadata_queue_worker\.ts|metadata:queue:worker" -and
      $_.CommandLine -match "OpenBrain"
    }

  foreach ($proc in $procs) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Log "Stopped worker PID=$($proc.ProcessId)"
    } catch {
      Write-Log "Could not stop PID=$($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

function ReleaseProcessingForSource {
  param([string]$Source)
  $sql = "UPDATE metadata_enrichment_queue SET status='pending', locked_by=NULL, locked_at=NULL WHERE chat_namespace='$ChatNamespace' AND source_system='$Source' AND status='processing';"
  docker exec $DbService psql -U $DbUser -d $DbName -c $sql | Out-Null
}

function Invoke-NpmScript {
  param(
    [string]$ScriptName,
    [string[]]$ScriptArgs
  )

  Write-Log "Running: npm run $ScriptName -- $($ScriptArgs -join ' ')"
  & npm run $ScriptName -- @ScriptArgs 2>&1 | ForEach-Object {
    $line = [string]$_
    Write-Host $line
    Add-Content -Path $resolvedLog -Value $line
  }
  if ($LASTEXITCODE -ne 0) {
    throw "npm run $ScriptName failed with exit code $LASTEXITCODE."
  }
}

Set-Location $repoRoot
Write-Log "Autoswitch started. Waiting for source '$WaitSource' to complete."

while ($true) {
  $c = Get-QueueCounts -Source $WaitSource
  Write-Log "Wait source $WaitSource => pending=$($c.pending) processing=$($c.processing) done=$($c.done) failed=$($c.failed)"

  if ($c.pending -eq 0 -and $c.processing -eq 0) {
    Write-Log "Source '$WaitSource' reached completion state."
    break
  }
  Start-Sleep -Seconds ([math]::Max(10, $PollSeconds))
}

foreach ($source in $NextSources) {
  Write-Log "===== Start source: $source ====="
  Stop-MetadataWorkers
  ReleaseProcessingForSource -Source $source

  $fillArgs = @("--chat=$ChatNamespace", "--source=$source")
  if ($OnlyMissing -eq 1) { $fillArgs += "--only-missing=1" }
  if ($RetryFailed -eq 1) { $fillArgs += "--retry-failed=1" }
  Invoke-NpmScript -ScriptName "metadata:queue:fill" -ScriptArgs $fillArgs

  $workerArgs = @(
    "--chat=$ChatNamespace",
    "--source=$source",
    "--workers=$Workers",
    "--claim=$Claim",
    "--context=$Context",
    "--strict-errors=1",
    "--row-retries=$RowRetries",
    "--retry-backoff-ms=$RetryBackoffMs",
    "--idle-seconds=$IdleSeconds"
  )
  Invoke-NpmScript -ScriptName "metadata:queue:worker" -ScriptArgs $workerArgs
  Invoke-NpmScript -ScriptName "metadata:queue:progress" -ScriptArgs @("--chat=$ChatNamespace", "--source=$source")
  Write-Log "===== Done source: $source ====="
}

Write-Log "Autoswitch completed."
exit 0

