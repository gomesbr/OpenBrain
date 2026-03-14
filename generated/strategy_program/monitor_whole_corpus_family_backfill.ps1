$ErrorActionPreference = "Stop"

$root = "c:\Users\Fabio\Cursor AI projects\Projects\OpenBrain"
$runnerRel = "generated/strategy_program/whole_corpus_family_backfill_runner.ts"
$runnerPath = Join-Path $root $runnerRel
$runnerPattern = "*whole_corpus_family_backfill_runner.ts*"
$monitorLog = Join-Path $root "generated\strategy_program\whole_corpus_family_backfill_monitor.log"
$runnerStdout = Join-Path $root "generated\strategy_program\whole_corpus_family_backfill_runner.stdout.log"
$runnerStderr = Join-Path $root "generated\strategy_program\whole_corpus_family_backfill_runner.stderr.log"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$tsxCli = Join-Path $root "node_modules\tsx\dist\cli.mjs"
$batchTarget = 1
$runnerTimeoutSeconds = 300
$loopSleepSeconds = 5
$maxFamiliesWithoutAcceptance = 45
$runtimeWithoutAcceptanceMs = 180000
$runtimeBeforeFlushMs = 30000
$flushTarget = 1
$maxFamilyRuntimeMs = 45000
$cursorPath = Join-Path $root "generated\strategy_program\whole_corpus_family_backfill_cursor.json"
$stopOnWrap = $true

function Write-MonitorLog {
  param([string]$Message)
  $line = "[monitor] $(Get-Date -Format o) $Message"
  Add-Content -Path $monitorLog -Value $line -Encoding UTF8
  Write-Host $line
}

function Get-CursorState {
  if (-not (Test-Path $cursorPath)) {
    return $null
  }
  try {
    return Get-Content $cursorPath -Raw | ConvertFrom-Json
  } catch {
    Write-MonitorLog "cursor read failed: $($_.Exception.Message)"
    return $null
  }
}

function Get-Counts {
  $sql = @"
select 'active_cases', count(*)
from experiment_cases
where experiment_id='53761995-3341-4ca2-9af1-b63b9bace516' and is_stale=false;

select 'calibration_pending', count(*)
from experiment_judge_calibration_items i
join experiment_cases c on c.id=i.case_id
where i.experiment_id='53761995-3341-4ca2-9af1-b63b9bace516' and c.is_stale=false and i.status='pending';
"@
  $rows = docker exec openbrain-db psql -U openbrain -d openbrain -At -F "`t" -c $sql
  $map = @{}
  foreach ($row in $rows) {
    if (-not $row) { continue }
    $parts = $row -split "`t"
    if ($parts.Length -ge 2) {
      $map[$parts[0]] = [int]$parts[1]
    }
  }
  return $map
}

function Stop-RunnerProcesses {
  $procs = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -like $runnerPattern
  }
  foreach ($proc in $procs) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-MonitorLog "stopped pid=$($proc.ProcessId) name=$($proc.Name)"
    } catch {
      Write-MonitorLog "stop failed pid=$($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Start-Runner {
  $prev = @{
    OB_BACKFILL_TARGET_COUNT = $env:OB_BACKFILL_TARGET_COUNT
    OB_BACKFILL_MAX_FAMILIES_WITHOUT_ACCEPTANCE = $env:OB_BACKFILL_MAX_FAMILIES_WITHOUT_ACCEPTANCE
    OB_BACKFILL_RUNTIME_WITHOUT_ACCEPTANCE_MS = $env:OB_BACKFILL_RUNTIME_WITHOUT_ACCEPTANCE_MS
    OB_BACKFILL_RUNTIME_BEFORE_FLUSH_MS = $env:OB_BACKFILL_RUNTIME_BEFORE_FLUSH_MS
    OB_BACKFILL_FLUSH_TARGET = $env:OB_BACKFILL_FLUSH_TARGET
    OB_BACKFILL_MAX_FAMILY_RUNTIME_MS = $env:OB_BACKFILL_MAX_FAMILY_RUNTIME_MS
  }
  $env:OB_BACKFILL_TARGET_COUNT = "$batchTarget"
  $env:OB_BACKFILL_MAX_FAMILIES_WITHOUT_ACCEPTANCE = "$maxFamiliesWithoutAcceptance"
  $env:OB_BACKFILL_RUNTIME_WITHOUT_ACCEPTANCE_MS = "$runtimeWithoutAcceptanceMs"
  $env:OB_BACKFILL_RUNTIME_BEFORE_FLUSH_MS = "$runtimeBeforeFlushMs"
  $env:OB_BACKFILL_FLUSH_TARGET = "$flushTarget"
  $env:OB_BACKFILL_MAX_FAMILY_RUNTIME_MS = "$maxFamilyRuntimeMs"
  try {
    Remove-Item $runnerStdout, $runnerStderr -ErrorAction SilentlyContinue
    $argumentLine = ('"{0}" "{1}"' -f $tsxCli, $runnerPath)
    return Start-Process -FilePath $nodeExe -ArgumentList $argumentLine -WorkingDirectory $root -PassThru -RedirectStandardOutput $runnerStdout -RedirectStandardError $runnerStderr
  } finally {
    foreach ($key in $prev.Keys) {
      if ($null -eq $prev[$key]) {
        Remove-Item "Env:$key" -ErrorAction SilentlyContinue
      } else {
        Set-Item "Env:$key" -Value $prev[$key]
      }
    }
  }
}

if (-not (Test-Path $monitorLog)) {
  New-Item -ItemType File -Path $monitorLog -Force | Out-Null
}

Write-MonitorLog "monitor started"

while ($true) {
  $cursor = Get-CursorState
  if ($stopOnWrap -and $cursor -and $cursor.completedFullPass -eq $true) {
    Write-MonitorLog "stop_on_wrap triggered startOffset=$($cursor.startFamilyOffset) nextOffset=$($cursor.nextFamilyOffset) familySeedCount=$($cursor.familySeedCount)"
    break
  }
  $before = Get-Counts
  Write-MonitorLog "starting batch targetCount=$batchTarget active_cases=$($before['active_cases']) calibration_pending=$($before['calibration_pending'])"
  $runner = Start-Runner
  if (-not $runner.WaitForExit($runnerTimeoutSeconds * 1000)) {
    Write-MonitorLog "runner timed out after ${runnerTimeoutSeconds}s; killing pid=$($runner.Id)"
    Stop-RunnerProcesses
  } else {
    Write-MonitorLog "runner exited pid=$($runner.Id) code=$($runner.ExitCode)"
    if ($runner.ExitCode -ne 0 -and (Test-Path $runnerStderr)) {
      $stderrTail = (Get-Content $runnerStderr -Tail 20) -join " | "
      if ($stderrTail) {
        Write-MonitorLog "runner stderr: $stderrTail"
      }
    }
  }

  $after = Get-Counts
  $deltaCases = [int]$after['active_cases'] - [int]$before['active_cases']
  $deltaPending = [int]$after['calibration_pending'] - [int]$before['calibration_pending']
  if ($deltaCases -gt 0 -or $deltaPending -gt 0) {
    Write-MonitorLog "progress_detected active_cases_delta=$deltaCases calibration_pending_delta=$deltaPending"
  } else {
    Write-MonitorLog "no_progress active_cases=$($after['active_cases']) calibration_pending=$($after['calibration_pending'])"
  }
  $cursorAfter = Get-CursorState
  if ($stopOnWrap -and $cursorAfter -and $cursorAfter.completedFullPass -eq $true) {
    Write-MonitorLog "stop_on_wrap triggered after batch startOffset=$($cursorAfter.startFamilyOffset) nextOffset=$($cursorAfter.nextFamilyOffset) familySeedCount=$($cursorAfter.familySeedCount)"
    break
  }
  Start-Sleep -Seconds $loopSleepSeconds
}

Write-MonitorLog "monitor stopped"
