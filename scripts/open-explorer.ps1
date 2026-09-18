param([string]$url)

# $url looks like: winfs:<绝对路径>
$path = $url -replace '^winfs:', ''
# Browser encodes non-ASCII, so decode
$path = [System.Uri]::UnescapeDataString($path)
# Convert to Windows backslash, strip trailing slash
$path = $path -replace '/', '\' -replace '\\$', ''
# PowerShell passes $path auto-quoted when it contains spaces
& explorer.exe /select,$path
