param([string]$url)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $scriptDir "prompts.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# $url looks like: cc:D:/Projects/.../GithubIO
$path = $url -replace '^cc:', ''
$path = [System.Uri]::UnescapeDataString($path)
$path = $path -replace '/', '\' -replace '\\$', ''

$prompt = $config.project.prompt
$command = "Set-Location '$path'; claude --model 'deepseek-v4-pro[1m]' --dangerously-skip-permissions '$prompt'"
$bytes = [System.Text.Encoding]::Unicode.GetBytes($command)
$encoded = [Convert]::ToBase64String($bytes)
Start-Process pwsh -ArgumentList '-NoExit', '-EncodedCommand', $encoded
