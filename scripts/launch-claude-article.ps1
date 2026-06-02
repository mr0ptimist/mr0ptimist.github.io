param([string]$url)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $scriptDir "prompts.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# $url looks like: cca:D:/Projects/.../GithubIO/content/posts/文章名/index.md
$articleDir = $url -replace '^cca:', ''
$articleDir = [System.Uri]::UnescapeDataString($articleDir)
$articleDir = $articleDir -replace '/', '\' -replace '\\$', ''
$articleDir = $articleDir -replace '\\index\.md$', ''

# Project root = strip content/posts/...
$projectRoot = $articleDir -replace '\\content\\posts\\.*$', ''
# Relative path for the prompt
$articleRel = $articleDir -replace [regex]::Escape($projectRoot + '\'), ''
$articleRel = $articleRel -replace '\\', '/'

$prompt = $config.article.prompt -replace '\{article_rel\}', $articleRel
$command = "Set-Location '$projectRoot'; claude --model 'deepseek-v4-pro[1m]' --dangerously-skip-permissions '$prompt'"
$bytes = [System.Text.Encoding]::Unicode.GetBytes($command)
$encoded = [Convert]::ToBase64String($bytes)
Start-Process pwsh -ArgumentList '-NoExit', '-EncodedCommand', $encoded
