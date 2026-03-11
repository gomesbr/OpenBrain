param(
  [string]$ChatNamespace = "personal.main",
  [string[]]$Sources = @("grok", "chatgpt", "whatsapp"),
  [int]$Workers = 2,
  [int]$Claim = 4,
  [int]$Context = 10,
  [int]$RowRetries = 3,
  [int]$RetryBackoffMs = 1500,
  [int]$IdleSeconds = 45,
  [int]$OnlyMissing = 1,
  [int]$RetryFailed = 1,
  [int]$StopExistingWorkers = 1,
  [switch]$StopOnError,
  [string]$DbService = "openbrain-db",
  [string]$DbName = "openbrain",
  [string]$DbUser = "openbrain",
  [string]$LogPath = ".\.metadata_queue_sequence.log"
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$resolvedLog = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $LogPath))
$failures = New-Object System.Collections.Generic.List[string]

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] $Message"
  Write-Host $line
  Add-Content -Path $resolvedLog -Value $line
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

function Stop-MetadataWorkers {
  $procs = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match "metadata_queue_worker\.ts|metadata:queue:worker" -and
      $_.CommandLine -match "OpenBrain"
    }

  if (-not $procs) {
    Write-Log "No existing metadata queue workers found."
    return
  }

  foreach ($proc in $procs) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Log "Stopped metadata worker process PID=$($proc.ProcessId)."
    } catch {
      Write-Log "Could not stop PID=$($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Reset-ProcessingRows {
  param([string[]]$SourceList)
  if (-not $SourceList -or $SourceList.Count -eq 0) { return }

  $sqlList = ($SourceList | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ","
  $sql = "UPDATE metadata_enrichment_queue SET status='pending', locked_by=NULL, locked_at=NULL WHERE status='processing' AND source_system IN ($sqlList);"
  & docker exec $DbService psql -U $DbUser -d $DbName -c $sql 2>&1 | ForEach-Object {
    $line = [string]$_
    Write-Host $line
    Add-Content -Path $resolvedLog -Value $line
  }
}

Set-Location $repoRoot

Write-Log "Sequential metadata queue run started."
Write-Log "Config: chat=$ChatNamespace sources=$($Sources -join ',') workers=$Workers claim=$Claim context=$Context retries=$RowRetries"

if ($StopExistingWorkers -eq 1) {
  Stop-MetadataWorkers
}

Reset-ProcessingRows -SourceList $Sources

foreach ($source in $Sources) {
  Write-Log "===== Source start: $source ====="
  try {
    $fillArgs = @(
      "--chat=$ChatNamespace",
      "--source=$source"
    )
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
    Write-Log "===== Source done: $source ====="
  } catch {
    $msg = "Source $source failed: $($_.Exception.Message)"
    Write-Log $msg
    $failures.Add($msg) | Out-Null
    if ($StopOnError) {
      throw
    }
  }
}

Write-Log "Sequential metadata queue run finished."
Invoke-NpmScript -ScriptName "metadata:queue:progress" -ScriptArgs @("--chat=$ChatNamespace")

if ($failures.Count -gt 0) {
  Write-Log "Completed with failures ($($failures.Count)):"
  foreach ($f in $failures) {
    Write-Log " - $f"
  }
  exit 1
}

Write-Log "Completed successfully with no source failures."
exit 0

