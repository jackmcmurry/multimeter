<#
    icons.ps1: renders the app icons into docs/icons with System.Drawing.

    The art is the wordmark's mark: the rising M, mint on the instrument's
    dark screen colour. Four strokes, two peaks, the second higher than the
    first and the right foot higher than the left, so the letter reads as an
    M and as a price line at the same time. It must match src/icon.svg.

    Run once, commit the PNGs, rerun only when the art changes. The GitHub
    Action never needs this file.

    Usage:  .\tools\icons.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $here 'docs/icons'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$ground = [System.Drawing.ColorTranslator]::FromHtml('#0a1216')
$mint = [System.Drawing.ColorTranslator]::FromHtml('#2ee59d')

# The mark's five points in the 64-unit box, the same as src/icon.svg.
$markPoints = @(
    @(12.0, 49.0), @(22.0, 20.0), @(32.0, 36.0), @(42.0, 15.0), @(52.0, 38.0)
)
$markWidth = 6.5

function Rounded([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Draws the 64-unit art scaled to `art` pixels, centred on a `size` canvas.
# maskable: the whole canvas is the ground and the art sits inside the safe zone.
function Draw-Icon([int]$size, [bool]$maskable, [string]$name) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($maskable) {
        $g.FillRectangle((New-Object System.Drawing.SolidBrush $ground), 0, 0, $size, $size)
        $art = $size * 0.72
    } else {
        $art = $size
    }
    $off = ($size - $art) / 2
    $s = $art / 64.0

    if (-not $maskable) {
        $g.FillPath((New-Object System.Drawing.SolidBrush $ground), (Rounded $off $off $art $art (12 * $s)))
    }

    $pen = New-Object System.Drawing.Pen($mint, ($markWidth * $s))
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
    $pen.MiterLimit = 6
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
    $pts = foreach ($p in $markPoints) {
        New-Object System.Drawing.PointF(([float]($off + $p[0] * $s)), ([float]($off + $p[1] * $s)))
    }
    $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
    $pen.Dispose()

    $path = Join-Path $out $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output ("icon     {0,-24} {1}x{1}" -f $name, $size)
}

Draw-Icon 180 $false 'icon-180.png'
Draw-Icon 192 $false 'icon-192.png'
Draw-Icon 512 $false 'icon-512.png'
Draw-Icon 512 $true  'icon-512-maskable.png'
Copy-Item (Join-Path $here 'src/icon.svg') (Join-Path $out 'icon.svg') -Force
Write-Output "icon     icon.svg                 copied"
