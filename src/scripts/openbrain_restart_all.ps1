param(
  [switch]$StartStrategyLoop = $false,
  [string]$ExperimentId = "",
  [int]$SmsPollSeconds = 15,
  [string]$SmsTo = "",
  [bool]$AutoResumeActiveLoop = $true
)

$ErrorActionPreference = "Stop"

function Write-Log {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "$ts | $Message"
}

function Stop-OpenBrainProcesses {
  param([string]$RepoRoot)

  $patterns = @(
    "v2_strategy_loop",
    "v2:strategy:loop",
    "v2_strategy_sms_watch",
    "v2:strategy:sms-watch",
    "cpu_guard.ps1",
    "start_sms_watch.ps1",
    "metadata_queue_worker",
    "metadata_queue_progress"
  )

  $targets = Get-CimInstance Win32_Process | Where-Object {
    $cmd = $_.CommandLine
    if (-not $cmd) { return $false }
    if ($_.ProcessId -eq $PID) { return $false }
    if ($cmd -notlike "*$RepoRoot*") { return $false }
    foreach ($p in $patterns) {
      if ($cmd -like "*$p*") { return $true }
    }
    return $false
  }

  if (-not $targets) {
    Write-Log "no matching OpenBrain helper processes found"
    return
  }

  foreach ($t in $targets) {
    try {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
      Write-Log "stopped pid=$($t.ProcessId)"
    } catch {
      Write-Log "failed_to_stop pid=$($t.ProcessId) err=$($_.Exception.Message)"
    }
  }
}

function Get-LatestActiveExperimentId {
  param([string]$RepoRoot)

  $script = @'
const { Client } = require("pg");
const fs = require("fs");
function loadEnv(path) {
  const out = {};
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
(async () => {
  const env = loadEnv(".env");
  const client = new Client({
    host: "127.0.0.1",
    port: Number(env.POSTGRES_PORT || 54329),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB
  });
  await client.connect();
  const r = await client.query(
    `SELECT id::text
       FROM experiment_runs
      WHERE status IN ('queued','running')
   ORDER BY created_at DESC
      LIMIT 1`
  );
  await client.end();
  process.stdout.write(String(r.rows[0]?.id ?? ""));
})().catch(() => process.stdout.write(""));
'@

  $id = ""
  try {
    $id = ($script | node -) 2>$null
  } catch {
    $id = ""
  }
  return "$id".Trim()
}

function Get-LatestRunningExperimentId {
  param([string]$RepoRoot)

  $script = @'
const { Client } = require("pg");
const fs = require("fs");
function loadEnv(path) {
  const out = {};
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
(async () => {
  const env = loadEnv(".env");
  const client = new Client({
    host: "127.0.0.1",
    port: Number(env.POSTGRES_PORT || 54329),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB
  });
  await client.connect();
  const r = await client.query(
    `SELECT id::text
       FROM experiment_runs
      WHERE status = 'running'
   ORDER BY created_at DESC
      LIMIT 1`
  );
  await client.end();
  process.stdout.write(String(r.rows[0]?.id ?? ""));
})().catch(() => process.stdout.write(""));
'@

  $id = ""
  try {
    $id = ($script | node -) 2>$null
  } catch {
    $id = ""
  }
  return "$id".Trim()
}

function Wait-Health {
  param([string]$BaseUrl, [int]$TimeoutSec = 600)

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $attempt = 0
  $lastError = ""
  while ((Get-Date) -lt $deadline) {
    $attempt += 1
    try {
      $resp = Invoke-RestMethod -Method GET -Uri "$BaseUrl/v1/health" -TimeoutSec 5
      if ($resp.ok -eq $true) {
        return $true
      }
      $lastError = "health replied without ok=true"
    } catch {
      $lastError = $_.Exception.Message
      try {
        $raw = & curl.exe -s -S "$BaseUrl/v1/health" 2>$null
        if ($raw -and ($raw -match '"ok"\s*:\s*true')) {
          return $true
        }
        if ($raw) {
          $lastError = "curl reply did not contain ok=true"
        }
      } catch {
        $lastError = $_.Exception.Message
      }
    }
    if (($attempt % 15) -eq 0) {
      Write-Log "waiting_for_health attempt=$attempt last_error=$lastError"
    }
    Start-Sleep -Seconds 2
  }
  Write-Log "health_timeout attempts=$attempt last_error=$lastError"
  return $false
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$guardScript = Join-Path $repoRoot "generated\strategy_program\cpu_guard.ps1"
$smsWatcherLog = Join-Path $repoRoot "generated\strategy_program\sms_watch_runner.log"
$baseUrl = "http://127.0.0.1:4301"

Set-Location $repoRoot
Write-Log "repo=$repoRoot"

Write-Log "stopping helper processes"
Stop-OpenBrainProcesses -RepoRoot $repoRoot

Write-Log "docker compose down"
docker compose down --remove-orphans | Out-Null

Write-Log "docker compose build openbrain-api"
docker compose build openbrain-api | Out-Null

Write-Log "docker compose up db+api"
docker compose up -d openbrain-db openbrain-api | Out-Null

Write-Log "waiting for API health"
$healthy = Wait-Health -BaseUrl $baseUrl -TimeoutSec 600
if (-not $healthy) {
  throw "API health check failed after restart"
}

Write-Log "running schema ensure"
@'
import { ensureExtendedSchema } from "./src/schema.js";
await ensureExtendedSchema();
console.log("SCHEMA_OK");
'@ | npx tsx - | Out-Null

if (Test-Path $guardScript) {
  Write-Log "starting cpu_guard"
  Start-Process powershell -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$guardScript`""
  ) -WindowStyle Hidden | Out-Null
} else {
  Write-Log "cpu_guard_missing path=$guardScript"
}

if ($StartStrategyLoop -or $AutoResumeActiveLoop) {
  $loopExperimentId = ""
  if ($StartStrategyLoop) {
    if ($ExperimentId) {
      $loopExperimentId = "$ExperimentId".Trim()
    } else {
      $loopExperimentId = Get-LatestActiveExperimentId -RepoRoot $repoRoot
    }
  } elseif ($AutoResumeActiveLoop) {
    $loopExperimentId = Get-LatestRunningExperimentId -RepoRoot $repoRoot
  }

  if ($loopExperimentId) {
    Write-Log "starting strategy loop id=$loopExperimentId"
    Start-Process powershell -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", "Set-Location '$repoRoot'; npm run v2:strategy:loop -- --id=$loopExperimentId --case-set=all"
    ) -WindowStyle Hidden | Out-Null

    $smsArg = ""
    if ($SmsTo) {
      $smsArg = "--to=$SmsTo"
    }
    Write-Log "starting sms watcher id=$loopExperimentId"
    Start-Process powershell -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", "Set-Location '$repoRoot'; npm run v2:strategy:sms-watch -- --id=$loopExperimentId --poll=$SmsPollSeconds $smsArg >> `"$smsWatcherLog`" 2>&1"
    ) -WindowStyle Hidden | Out-Null
  } else {
    Write-Log "no active experiment found; skipped loop/watcher startup"
  }
} else {
  Write-Log "loop/watcher startup skipped by flags"
}

Write-Log "docker status"
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | Out-Host

Write-Log "helper process status"
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -like "*$repoRoot*" -and
  ($_.CommandLine -like "*cpu_guard.ps1*" -or $_.CommandLine -like "*v2:strategy:loop*" -or $_.CommandLine -like "*v2:strategy:sms-watch*")
} | Select-Object ProcessId, Name, CommandLine | Format-Table -Wrap -AutoSize | Out-Host

Write-Log "done"
