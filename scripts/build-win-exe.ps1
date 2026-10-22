$ErrorActionPreference='Stop'
$entry=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'plugin-installer/scripts/pack.ps1'
if (-not (Test-Path -LiteralPath $entry)) {throw 'Shared plugin-installer checkout required'}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $entry database
exit $LASTEXITCODE
