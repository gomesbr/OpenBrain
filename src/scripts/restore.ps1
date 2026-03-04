param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [string]$ServiceName = "openbrain-db",
  [string]$Database = "openbrain",
  [string]$User = "openbrain"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) {
  throw "Backup file not found: $BackupFile"
}

Write-Host "Restoring from $BackupFile"
Get-Content $BackupFile | docker exec -i $ServiceName psql -U $User -d $Database
Write-Host "Restore complete"
