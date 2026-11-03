#Requires -RunAsAdministrator
<#
  Установка агента турникета ADI на Windows.

  Запуск — PowerShell от имени администратора, из папки агента:
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

  Что делает:
    - проверяет Node.js 22+;
    - копирует агент в "C:\Program Files\ADI Gate Agent", добавляет команду adi-gate в PATH;
    - закрывает папку настроек C:\ProgramData\ADI\gate-agent (только администраторы и SYSTEM);
    - регистрирует задачу «ADI Gate Agent»: запуск при старте Windows от SYSTEM,
      перезапуск при сбое;
    - если терминал уже настроен — запускает агент.

  -PushFromIp 192.168.0.90 — открыть порт 7660 в брандмауэре только для терминала
  (нужно лишь в режиме событий push).
#>
param(
  [string]$InstallDir = "$env:ProgramFiles\ADI Gate Agent",
  [string]$PushFromIp = ""
)
$ErrorActionPreference = "Stop"
$TaskName = "ADI Gate Agent"
$RuleName = "ADI Gate Agent (события терминала)"
$Source = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:ProgramData "ADI\gate-agent"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Не найден Node.js. Установите Node.js 22 LTS с https://nodejs.org и запустите установку снова." }
$nodeVersion = (& $node.Source -v).Trim()
if ([int]($nodeVersion.TrimStart("v").Split(".")[0]) -lt 22) { throw "Нужен Node.js 22 или новее, установлен $nodeVersion." }
Write-Host "Node.js $nodeVersion — ок"

# Агент уже работает — останавливаем, чтобы заменить файлы.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $Source "src") $InstallDir
Copy-Item -Force (Join-Path $Source "package.json") $InstallDir
Copy-Item -Force (Join-Path $Source "README.md") $InstallDir
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "scripts") | Out-Null
Copy-Item -Force (Join-Path $Source "scripts\*.ps1") (Join-Path $InstallDir "scripts")

$cmd = "@echo off`r`n`"$($node.Source)`" `"%~dp0src\index.js`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $InstallDir "adi-gate.cmd"), $cmd)

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if (($machinePath -split ";") -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", "$machinePath;$InstallDir", "Machine")
}
Write-Host "Агент скопирован: $InstallDir"

# Папка настроек: пароль терминала и токен ADI — только администраторам и SYSTEM.
# SID вместо имён групп — на русской Windows группа называется «Администраторы».
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
& icacls $DataDir /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
Write-Host "Папка настроек: $DataDir"

$action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$InstallDir\src\index.js`" run" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Задача «$TaskName» зарегистрирована: старт вместе с Windows"

if ($PushFromIp) {
  Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort 7660 -RemoteAddress $PushFromIp -Action Allow | Out-Null
  Write-Host "Брандмауэр: порт 7660 открыт только для $PushFromIp"
}

if (Test-Path (Join-Path $DataDir "config.json")) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Агент запущен. Журнал: $DataDir\logs"
} else {
  Write-Host ""
  Write-Host "Дальше (в этом же окне администратора):"
  Write-Host "  & `"$InstallDir\adi-gate.cmd`" setup"
  Write-Host "  & `"$InstallDir\adi-gate.cmd`" check"
  Write-Host "  Start-ScheduledTask -TaskName `"$TaskName`""
}
Write-Host ""
Write-Host "Совет: отключите сон компьютера — во сне агент не работает: powercfg /change standby-timeout-ac 0"
