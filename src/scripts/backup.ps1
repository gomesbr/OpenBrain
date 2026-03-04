param(
  [string]$OutDir = ".\\backups",
  [string]$ServiceName = "openbrain-db",
  [string]$Database = "openbrain",
  [string]$User = "openbrain"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$file = Join-Path $OutDir "openbrain_$timestamp.sql"

Write-Host "Creating backup: $file"
docker exec $ServiceName pg_dump -U $User -d $Database --clean --if-exists --no-owner --no-privileges > $file
Write-Host "Backup complete"
