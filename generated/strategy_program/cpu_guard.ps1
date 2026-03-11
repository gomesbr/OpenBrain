param(
  [double]$HighThreshold = 99,
  [int]$WindowSamples = 6,
  [int]$IntervalSec = 10,
  [double]$DbCpuCap = 1.0,
  [double]$ApiCpuCap = 0.5,
  [double]$MinDbCpuCap = 0.4,
  [double]$MinApiCpuCap = 0.2
)

$ErrorActionPreference = "Continue"
$logPath = Join-Path (Split-Path -Parent $PSCommandPath) "cpu_guard.log"
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$envFilePath = Join-Path $repoRoot ".env"

function Write-GuardLog {
  param([string]$Message)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts | $Message" | Out-File -FilePath $logPath -Append -Encoding utf8
}

function Load-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  try {
    foreach ($raw in (Get-Content $Path)) {
      $line = $raw.Trim()
      if (-not $line) { continue }
      if ($line.StartsWith("#")) { continue }
      $eq = $line.IndexOf("=")
      if ($eq -le 0) { continue }
      $key = $line.Substring(0, $eq).Trim()
      if (-not $key) { continue }
      $current = (Get-Item "Env:$key" -ErrorAction SilentlyContinue).Value
      if (-not [string]::IsNullOrWhiteSpace($current)) { continue }
      $value = $line.Substring($eq + 1).Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        if ($value.Length -ge 2) {
          $value = $value.Substring(1, $value.Length - 2)
        }
      }
      [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
    Write-GuardLog "dotenv=loaded path=$Path"
  } catch {
    Write-GuardLog "dotenv=failed path=$Path error=$($_.Exception.Message)"
  }
}

function Stop-StrategyLoop {
  $targets = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match "v2_strategy_loop|v2:strategy:loop") }
  $stopped = @()
  foreach ($t in $targets) {
    try {
      Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
      $stopped += $t.ProcessId
    } catch {
      # ignore
    }
  }
  if ($stopped.Count -gt 0) {
    Write-GuardLog "action=stop_loop pids=$($stopped -join ',')"
  } else {
    Write-GuardLog "action=stop_loop pids=none_found"
  }
}

$script:SmsSentOnHighCpu = $false

Load-DotEnv -Path $envFilePath

function Send-SmsTwilio {
  param([string]$Body)
  $sid = "$env:TWILIO_ACCOUNT_SID".Trim()
  $token = "$env:TWILIO_AUTH_TOKEN".Trim()
  $from = "$env:TWILIO_FROM_NUMBER".Trim()
  $to = "$env:OPENBRAIN_SMS_TO".Trim()
  if (-not $sid -or -not $token -or -not $from -or -not $to) {
    Write-GuardLog "sms=skipped reason=missing_twilio_env"
    return
  }
  try {
    $uri = "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json"
    $pair = "$sid`:$token"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($pair)
    $auth = [Convert]::ToBase64String($bytes)
    $headers = @{ Authorization = "Basic $auth" }
    $payload = @{
      To   = $to
      From = $from
      Body = $Body
    }
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $payload | Out-Null
    Write-GuardLog "sms=sent body=$Body"
  } catch {
    Write-GuardLog "sms=failed error=$($_.Exception.Message)"
  }
}

$currentDbCap = [math]::Round($DbCpuCap, 2)
$currentApiCap = [math]::Round($ApiCpuCap, 2)
$highCount = 0

Write-GuardLog "started threshold=$HighThreshold window=$WindowSamples interval=$IntervalSec dbCap=$currentDbCap apiCap=$currentApiCap"

while ($true) {
  $cpu = 0.0
  try {
    $cpu = [double](Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples[0].CookedValue
  } catch {
    $cpu = [double]((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
  }

  if ($cpu -ge $HighThreshold) {
    $highCount += 1
  } else {
    $highCount = 0
  }

  Write-GuardLog ("sample cpu={0:N2} highCount={1}/{2} dbCap={3} apiCap={4}" -f $cpu, $highCount, $WindowSamples, $currentDbCap, $currentApiCap)

  if ($highCount -ge $WindowSamples) {
    if ($currentDbCap -gt $MinDbCpuCap -or $currentApiCap -gt $MinApiCpuCap) {
      $nextDb = [math]::Round([math]::Max($MinDbCpuCap, $currentDbCap - 0.2), 2)
      $nextApi = [math]::Round([math]::Max($MinApiCpuCap, $currentApiCap - 0.1), 2)
      try {
        docker update --cpus $nextDb openbrain-db | Out-Null
      } catch {
        Write-GuardLog "warning=docker_update_failed target=openbrain-db nextCap=$nextDb error=$($_.Exception.Message)"
      }
      try {
        docker update --cpus $nextApi openbrain-api | Out-Null
      } catch {
        Write-GuardLog "warning=docker_update_failed target=openbrain-api nextCap=$nextApi error=$($_.Exception.Message)"
      }
      Write-GuardLog "action=throttle dbCap:$currentDbCap->$nextDb apiCap:$currentApiCap->$nextApi"
      $currentDbCap = $nextDb
      $currentApiCap = $nextApi
      $highCount = 0
    } else {
      Write-GuardLog "action=critical_high_cpu cpu=$cpu at_min_caps=true"
      Stop-StrategyLoop
      if (-not $script:SmsSentOnHighCpu) {
        Send-SmsTwilio -Body "Process stopped due to high CPU utilization"
        $script:SmsSentOnHighCpu = $true
      }
      $highCount = 0
    }
  }

  Start-Sleep -Seconds $IntervalSec
}
