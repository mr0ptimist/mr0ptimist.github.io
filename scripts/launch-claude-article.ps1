param([string]$url)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $scriptDir "prompts.json") -Raw -Encoding UTF8 | ConvertFrom-Json

try {
    # $url looks like one of:
    #   cca:D:/Projects/.../GithubIO/content/posts/文章名/index.md    (Page Bundle)
    #   cca:D:/Projects/.../GithubIO/content/local/文件名.md           (single file)
    $articlePath = $url -replace '^cca:', ''
    $articlePath = [System.Uri]::UnescapeDataString($articlePath)
    $articlePath = $articlePath -replace '/', '\' -replace '\\$', ''

    # Detect Page Bundle (ends with \index.md) vs single .md file
    $isPageBundle = $articlePath -match '\\index\.md$'
    if (-not $isPageBundle) {
        # Convert single .md file into a Page Bundle directory
        $mdFile = $articlePath
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($mdFile)
        $parentDir = [System.IO.Path]::GetDirectoryName($mdFile)
        $bundleDir = Join-Path $parentDir $baseName
        $indexFile = Join-Path $bundleDir 'index.md'

        # Already converted? (file already inside the bundle dir)
        if (Test-Path $indexFile) {
            Write-Host "===== Already a Page Bundle =====" -ForegroundColor Cyan
            Write-Host "  $indexFile" -ForegroundColor Green
        } elseif (Test-Path $mdFile) {
            Write-Host "===== Converting to Page Bundle =====" -ForegroundColor Cyan
            Write-Host "  Source: $mdFile"
            Write-Host "  Target: $bundleDir"

            if (-not (Test-Path $bundleDir)) {
                New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
                Write-Host "  Created directory" -ForegroundColor Green
            }

            Move-Item -Path $mdFile -Destination $indexFile -Force
            Write-Host "  Moved: $(Split-Path $mdFile -Leaf) -> index.md" -ForegroundColor Green
        } else {
            throw "Source file not found: $mdFile`nThe file may have been moved or deleted outside this script."
        }

        $contextFile = Join-Path $bundleDir 'context.json'
        if (-not (Test-Path $contextFile)) {
            $ctx = [ordered]@{
                rdc_files = @()
                code_refs = @()
                notes     = ''
            }
            $ctx | ConvertTo-Json -Depth 3 | Out-File -FilePath $contextFile -Encoding UTF8 -NoNewline
            Add-Content -Path $contextFile -Value "`n" -Encoding UTF8
            Write-Host "  Created: context.json" -ForegroundColor Green
        }

        Write-Host "===== Done =====" -ForegroundColor Cyan
        $articleDir = $bundleDir
    } else {
        $articleDir = $articlePath -replace '\\index\.md$', ''
    }

    # Project root = strip content/{posts,local}/... from the path
    $projectRoot = $articleDir -replace '\\content\\(posts|local)\\.*$', ''
    if ($projectRoot -eq $articleDir) {
        $projectRoot = $articlePath -replace '\\content\\(posts|local)\\.*$', ''
    }

    # Relative path for the prompt
    $articleRel = $articleDir -replace [regex]::Escape($projectRoot + '\'), ''
    $articleRel = $articleRel -replace '\\', '/'

    # Start Claude in the article directory, prompt references local files
    $prompt = $config.article.prompt
    Set-Location $articleDir
    claude --model 'deepseek-v4-flash[1m]' --dangerously-skip-permissions $prompt
} catch {
    Write-Host "===== ERROR =====" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Write-Host ""
    Read-Host "Press Enter to close"
}
