<#
    serve.ps1: minimal loopback file server for build verification.

    Uses a raw TcpListener rather than HttpListener so it needs no URL ACL
    registration and no elevation. It answers one request per connection and
    speaks just enough HTTP/1.1 for a browser to load the debug bundle and its
    data/ snapshots.

    Usage:  .\tools\serve.ps1                       # dist/, debug bundle at /
            .\tools\serve.ps1 -Root docs -Port 8788 # the release page as published
#>
[CmdletBinding()]
param(
    [string]$Root = "dist",
    [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$rootPath = [System.IO.Path]::GetFullPath((Join-Path $here $Root))
if (-not (Test-Path $rootPath)) { throw "root not found: $rootPath" }
$defaultDoc = if (Test-Path (Join-Path $rootPath 'multimeter.debug.html')) { '/multimeter.debug.html' } else { '/index.html' }

$types = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.webmanifest' = 'application/manifest+json'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Output "serving $rootPath on http://127.0.0.1:$Port/ (ctrl-c to stop)"

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 2000

            # Read the request line only; headers are not needed.
            $buffer = New-Object byte[] 4096
            $read = $stream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) { continue }
            $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            $requestLine = ($request -split "`r`n")[0]
            $parts = $requestLine -split ' '
            $target = if ($parts.Count -ge 2) { $parts[1] } else { '/' }
            $target = ($target -split '\?')[0]
            if ($target -eq '/') { $target = $defaultDoc }

            $relative = [System.Uri]::UnescapeDataString($target.TrimStart('/')) -replace '/', '\'
            $full = [System.IO.Path]::GetFullPath((Join-Path $rootPath $relative))

            $status = '200 OK'
            $bodyBytes = $null
            $contentType = 'application/octet-stream'

            if (-not $full.StartsWith($rootPath)) {
                $status = '403 Forbidden'
                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes('forbidden')
                $contentType = 'text/plain; charset=utf-8'
            }
            elseif (Test-Path $full -PathType Leaf) {
                $bodyBytes = [System.IO.File]::ReadAllBytes($full)
                $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                if ($types.ContainsKey($ext)) { $contentType = $types[$ext] }
            }
            else {
                $status = '404 Not Found'
                $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes("not found: $target")
                $contentType = 'text/plain; charset=utf-8'
            }

            $header = "HTTP/1.1 $status`r`n" +
                      "Content-Type: $contentType`r`n" +
                      "Content-Length: $($bodyBytes.Length)`r`n" +
                      "Cache-Control: no-store`r`n" +
                      "Connection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
            $stream.Flush()
            Write-Output "$status  $target  ($($bodyBytes.Length) bytes)"
        }
        catch {
            Write-Output "error: $($_.Exception.Message)"
        }
        finally {
            $client.Close()
        }
    }
}
finally {
    $listener.Stop()
}
