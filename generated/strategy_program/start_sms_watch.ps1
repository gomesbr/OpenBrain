param(
  [string]$ExperimentId = "b922379a-73be-44a8-891e-d635c9ed1ab0",
  [int]$Poll = 15,
  [string]$To = "3219549283"
)

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runnerLog = Join-Path $PSScriptRoot "sms_watch_runner.log"

function Write-RunnerLog {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts | $Message" | Out-File -FilePath $runnerLog -Append -Encoding utf8
}

Set-Location $repoRoot
Write-RunnerLog "runner_started repo=$repoRoot id=$ExperimentId poll=$Poll to=$To"

while ($true) {
  try {
    Write-RunnerLog "watcher_start"
    & npm run v2:strategy:sms-watch -- --id=$ExperimentId --poll=$Poll --to=$To 2>&1 |
      Out-File -FilePath $runnerLog -Append -Encoding utf8
    Write-RunnerLog "watcher_exit"
  } catch {
    Write-RunnerLog "watcher_error error=$($_.Exception.Message)"
  }
  Start-Sleep -Seconds 5
}

