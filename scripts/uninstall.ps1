#Requires -RunAsAdministrator
<#
  Удаление агента турникета ADI.
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1         — настройки и журнал остаются
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Purge  — удалить и их
#>
param(
  [string]$InstallDir = "$env:ProgramFiles\ADI Gate Agent",
  [switch]$Purge
)
$ErrorActionPreference = "Stop"
$TaskName = "ADI Gate Agent"
$RuleName = "ADI Gate Agent (события терминала)"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
# Процессы агента, если задача их не остановила.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*ADI Gate Agent*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$rest = ($machinePath -split ";") | Where-Object { $_ -and $_ -ne $InstallDir }
[Environment]::SetEnvironmentVariable("Path", ($rest -join ";"), "Machine")

Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
if ($Purge) { Remove-Item -Recurse -Force (Join-Path $env:ProgramData "ADI\gate-agent") -ErrorAction SilentlyContinue }
Write-Host "Агент удалён$(if ($Purge) { ' вместе с настройками' } else { '. Настройки остались в C:\ProgramData\ADI\gate-agent' })."
