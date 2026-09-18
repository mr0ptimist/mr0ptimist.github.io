# Registers the winfs:/cc:/cca: protocol handlers for the current user (HKCU, no admin).
#
# The registry stores no project path. All three schemes point at protocol-relay.ps1,
# installed to a machine-stable location outside the repo; the relay derives the project
# root from the URL payload when a link is clicked. Moving the project folder therefore
# requires no re-registration — just serve again (serve_启动预览.bat writes the new root
# into config/development/hugo.toml, which is what the page embeds in those URLs).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$relayDir = Join-Path $env:LOCALAPPDATA 'GithubIO\protocols'
New-Item -ItemType Directory -Force -Path $relayDir | Out-Null
$relay = Join-Path $relayDir 'protocol-relay.ps1'
Copy-Item (Join-Path $scriptDir 'protocol-relay.ps1') -Destination $relay -Force

$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$relay`" `"%1`""

foreach ($scheme in 'winfs', 'cc', 'cca') {
    $key = "HKCU:\Software\Classes\$scheme"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value "URL:GithubIO $scheme Protocol"
    New-ItemProperty -Path $key -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$key\shell\open\command" -Name "(Default)" -Value $cmd
    Write-Host "$scheme => $relay"
}
