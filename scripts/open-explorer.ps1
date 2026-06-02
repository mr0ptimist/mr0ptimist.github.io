param([string]$url)

# $url looks like: winfs:D:/Projects/.../index.md
$path = $url -replace '^winfs:', ''
# Browser encodes non-ASCII, so decode
$path = [System.Uri]::UnescapeDataString($path)
# Convert to Windows backslash, strip trailing slash
$path = $path -replace '/', '\' -replace '\\$', ''
# PowerShell passes $path auto-quoted when it contains spaces
& explorer.exe /select,$path
