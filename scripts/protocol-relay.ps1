param([string]$url)

# Entry point for the winfs:/cc:/cca: registry handlers. The registry points at a
# machine-stable copy of this file (installed by setup_winfs_protocol.ps1) and stores
# no project path: the project root is derived from the URL payload at click time.
# The page builds that payload from site.Params.vscodeContentBase, which serve_启动预览.bat
# regenerates from the project's own location on every serve — so moving the project
# folder never invalidates the registry entries.
$ErrorActionPreference = 'Stop'

try {
    $handlers = @{
        'cca'   = 'scripts\launch-claude-article.ps1'  # Claude Code with the current article as context
        'cc'    = 'scripts\launch-claude.ps1'          # Claude Code at the project root
        'winfs' = 'scripts\open-explorer.ps1'          # reveal the file / folder in Explorer
    }

    $sep = $url.IndexOf(':')
    if ($sep -lt 1) { throw "Malformed URL: $url" }
    $scheme = $url.Substring(0, $sep).ToLowerInvariant()
    if (-not $handlers.ContainsKey($scheme)) { throw "Unknown scheme: $scheme" }

    $payload = [System.Uri]::UnescapeDataString($url.Substring($sep + 1)) -replace '/', '\'
    $dir = $payload.TrimEnd('\')
    while ($dir -and -not (Test-Path -LiteralPath (Join-Path $dir 'hugo.toml'))) {
        $parent = Split-Path $dir -Parent
        if (-not $parent -or $parent -eq $dir) { $dir = $null; break }  # walked past the drive root
        $dir = $parent
    }
    if (-not $dir) { throw "Project root not found (no hugo.toml above): $payload" }

    $handler = Join-Path $dir $handlers[$scheme]
    if (-not (Test-Path -LiteralPath $handler)) { throw "Handler script missing: $handler" }

    & $handler $url
} catch {
    Write-Host "===== ERROR =====" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Write-Host ""
    Read-Host "Press Enter to close"
}
