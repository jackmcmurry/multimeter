<#
    icons.ps1: renders the app icons into docs/icons with System.Drawing.

    The art is the favicon's: a yellow rounded square, a dark screen, a knob
    with a yellow mark. Run once, commit the PNGs, rerun only when the art
    changes. The GitHub Action never needs this file.

    Usage:  .\tools\icons.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $here 'docs/icons'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

$yellow = [System.Drawing.ColorTranslator]::FromHtml('#f6b71f')
$screen = [System.Drawing.ColorTranslator]::FromHtml('#0a1216')
$knob = [System.Drawing.ColorTranslator]::FromHtml('#14171c')

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
# maskable: the whole canvas is yellow and the art sits inside the safe zone.
function Draw-Icon([int]$size, [bool]$maskable, [string]$name) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($maskable) {
        $g.FillRectangle((New-Object System.Drawing.SolidBrush $yellow), 0, 0, $size, $size)
        $art = $size * 0.72
    } else {
        $art = $size
    }
    $off = ($size - $art) / 2
    $s = $art / 64.0

    if (-not $maskable) {
        $g.FillPath((New-Object System.Drawing.SolidBrush $yellow), (Rounded $off $off $art $art (14 * $s)))
    }
    $g.FillPath((New-Object System.Drawing.SolidBrush $screen), (Rounded ($off + 10 * $s) ($off + 10 * $s) (44 * $s) (20 * $s) (3 * $s)))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $knob), ($off + 21 * $s), ($off + 35 * $s), (22 * $s), (22 * $s))
    $g.FillPath((New-Object System.Drawing.SolidBrush $yellow), (Rounded ($off + 30.5 * $s) ($off + 36 * $s) (3 * $s) (9 * $s) (1 * $s)))

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
