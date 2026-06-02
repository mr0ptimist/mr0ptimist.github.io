$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- winfs: protocol (Open in Explorer) ---
$winfsHandler = Join-Path $scriptDir "open-explorer.ps1"
$winfsCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$winfsHandler`" `"%1`""

New-Item -Path "HKCU:\Software\Classes\winfs" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\winfs" -Name "(Default)" -Value "URL:WinFS Protocol"
New-ItemProperty -Path "HKCU:\Software\Classes\winfs" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\winfs\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\winfs\shell\open\command" -Name "(Default)" -Value $winfsCmd
Write-Host "winfs: protocol registered"

# --- cc: protocol (Launch Claude Code) ---
$claudeHandler = Join-Path $scriptDir "launch-claude.ps1"
$claudeCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$claudeHandler`" `"%1`""

New-Item -Path "HKCU:\Software\Classes\cc" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\cc" -Name "(Default)" -Value "URL:Claude Code Protocol"
New-ItemProperty -Path "HKCU:\Software\Classes\cc" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\cc\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\cc\shell\open\command" -Name "(Default)" -Value $claudeCmd
Write-Host "cc: protocol registered"

# --- cca: protocol (Launch Claude Code for current article) ---
$claudeArticleHandler = Join-Path $scriptDir "launch-claude-article.ps1"
$claudeArticleCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$claudeArticleHandler`" `"%1`""

New-Item -Path "HKCU:\Software\Classes\cca" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\cca" -Name "(Default)" -Value "URL:Claude Code Article Protocol"
New-ItemProperty -Path "HKCU:\Software\Classes\cca" -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\cca\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\cca\shell\open\command" -Name "(Default)" -Value $claudeArticleCmd
Write-Host "cca: protocol registered"
