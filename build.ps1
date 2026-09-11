<#
    build.ps1: bundles src/ into the single-file page GitHub Pages serves.

    The page is one HTML document with its CSS and JS inlined, so the source
    tree is concatenated in dependency order and injected into the template's
    two markers.

    Outputs:
      docs/index.html               the published page (committed; Pages serves docs/)
      dist/multimeter.debug.html    page + data-job logic + tests + synthetic render
      dist/data/                    copy of docs/data so the debug page has snapshots

    Usage:
      .\build.ps1                   both
      .\build.ps1 -ReleaseOnly      docs/index.html only
#>
[CmdletBinding()]
param(
    [switch]$ReleaseOnly
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Dependency order: stats -> format -> store -> geom -> sources -> session -> router -> meter -> live -> spotlight -> app.
# meter.js and live.js read MP.app / MP.spotlight only at call time, so they may load before them.
$libOrder = @(
    'src/lib/stats.js',
    'src/lib/format.js',
    'src/lib/store.js',
    'src/lib/geom.js',
    'src/lib/sources.js',
    'src/lib/session.js',
    'src/lib/concepts.js',
    'src/lib/context.js',
    'src/lib/track.js',
    'src/lib/router.js',
    'src/lib/funcs.js',
    'src/lib/alerts.js',
    'src/lib/meter.js',
    'src/lib/live.js',
    'src/lib/share.js',
    'src/lib/watch.js',
    'src/lib/spotlight.js',
    'src/lib/app.js'
)
# The write-up page: the same stylesheet, a smaller kit, and its own filler.
$findingsOrder = @(
    'src/lib/stats.js',
    'src/lib/format.js',
    'src/lib/geom.js',
    'src/lib/sources.js',
    'src/lib/findings.js',
    'src/lib/findings-page.js'
)
# The data job's logic ships only in the debug bundle, where the tests drive it.
$debugOrder = @(
    'src/lib/findings.js',
    'src/lib/note.js',
    'src/lib/universe.js',
    'src/lib/pipeline.js',
    'test/stats.test.js',
    'test/data.test.js',
    'src/lib/debug.js'
)

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$relative) {
    $path = Join-Path $here $relative
    if (-not (Test-Path $path)) { throw "missing source file: $relative" }
    return [System.IO.File]::ReadAllText($path)
}

function Join-Sources([string[]]$files) {
    $parts = foreach ($f in $files) {
        "/* ==== $f " + ('=' * [Math]::Max(1, 68 - $f.Length)) + " */`r`n" + (Read-Text $f)
    }
    return ($parts -join "`r`n`r`n")
}

function Write-Text([string]$relative, [string]$text) {
    $path = Join-Path $here $relative
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
    return [Math]::Round((Get-Item $path).Length / 1KB, 1)
}

$template = Read-Text 'src/index.template.html'
$findingsTemplate = Read-Text 'src/findings.template.html'
$css = Read-Text 'src/styles.css'

$cssMarker = '/* @inject styles.css */'
$libMarker = '/* @inject lib */'

foreach ($t in @(@('index', $template), @('findings', $findingsTemplate))) {
    if ($t[1].IndexOf($cssMarker) -lt 0) { throw "$($t[0]) template is missing the CSS marker" }
    if ($t[1].IndexOf($libMarker) -lt 0) { throw "$($t[0]) template is missing the lib marker" }
}

# ---- release ---------------------------------------------------------------
$release = $template.Replace($cssMarker, $css).Replace($libMarker, (Join-Sources $libOrder))
$releaseKb = Write-Text 'docs/index.html' $release
Write-Output "release  docs/index.html              $releaseKb KB  ($($libOrder.Count) modules)"

$findingsPage = $findingsTemplate.Replace($cssMarker, $css).Replace($libMarker, (Join-Sources $findingsOrder))
$findingsKb = Write-Text 'docs/findings.html' $findingsPage
Write-Output "findings docs/findings.html           $findingsKb KB  ($($findingsOrder.Count) modules)"

# ---- installable shell -----------------------------------------------------
# The service worker's cache name carries a hash of everything it serves, so
# a new build purges the old cache on activation.
$swTemplate = Read-Text 'src/sw.template.js'
$manifest = Read-Text 'src/manifest.webmanifest'
$sha = [System.Security.Cryptography.SHA256]::Create()
$digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($release + $findingsPage + $swTemplate + $manifest))
$version = (($digest | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
$sw = $swTemplate.Replace('/* @version */', $version)
Write-Text 'docs/sw.js' $sw | Out-Null
Write-Text 'docs/manifest.webmanifest' $manifest | Out-Null
Write-Output "sw       docs/sw.js                   version $version"

# ---- debug -----------------------------------------------------------------
if (-not $ReleaseOnly) {
    $debug = $template.Replace($cssMarker, $css).Replace($libMarker, (Join-Sources ($libOrder + $debugOrder)))
    $debugKb = Write-Text 'dist/multimeter.debug.html' $debug
    Write-Output "debug    dist/multimeter.debug.html   $debugKb KB  (+ data job, tests, synthetic render)"
    Write-Text 'dist/findings.html' $findingsPage | Out-Null

    $distData = Join-Path $here 'dist/data'
    if (-not (Test-Path $distData)) { New-Item -ItemType Directory -Path $distData | Out-Null }
    Copy-Item (Join-Path $here 'docs/data/*.json') $distData -Force
    # The Nasdaq-100 members' closes, one file each, once the job has written them.
    $stocksSrc = Join-Path $here 'docs/data/stocks'
    if (Test-Path $stocksSrc) {
        $stocksDst = Join-Path $distData 'stocks'
        if (-not (Test-Path $stocksDst)) { New-Item -ItemType Directory -Path $stocksDst | Out-Null }
        Copy-Item (Join-Path $stocksSrc '*.json') $stocksDst -Force -ErrorAction SilentlyContinue
    }
    Write-Text 'dist/sw.js' $sw | Out-Null
    Write-Text 'dist/manifest.webmanifest' $manifest | Out-Null
    $distIcons = Join-Path $here 'dist/icons'
    if (-not (Test-Path $distIcons)) { New-Item -ItemType Directory -Path $distIcons | Out-Null }
    if (Test-Path (Join-Path $here 'docs/icons')) { Copy-Item (Join-Path $here 'docs/icons/*') $distIcons -Force }
    Write-Output "data     dist/data/                   snapshots copied from docs/data (+ sw, manifest, icons)"
}

# ---- sanity checks ---------------------------------------------------------
$problems = @()
$bundles = @{ 'release' = $release; 'findings' = $findingsPage }
foreach ($name in $bundles.Keys) {
    $b = $bundles[$name]
    if ($b.IndexOf('@inject') -ge 0) { $problems += "an inject marker survived into the $name bundle" }
    foreach ($leak in @('MP.debug', 'MP.test', 'MP.dataTest', 'MP.pipeline', 'MP.note', 'MP.universe')) {
        if ($b.IndexOf($leak) -ge 0) { $problems += "$leak leaked into the $name bundle" }
    }
    if (-not $b.StartsWith('<!doctype html>')) { $problems += "$name bundle must start with <!doctype html>" }
    # A key, or even a key parameter or header name, in a public page is a leak waiting to happen.
    if ($b.IndexOf('apikey=') -ge 0) { $problems += "$name bundle contains an apikey= parameter" }
    if ($b.IndexOf('x-api-key') -ge 0) { $problems += "$name bundle mentions the x-api-key header" }
}

# The installable shell must be complete: a stamped worker, a manifest that
# parses with the icon sizes installability needs, and icons that exist.
if ($sw.IndexOf('@version') -ge 0) { $problems += 'service worker still carries the @version marker' }
try {
    $m = $manifest | ConvertFrom-Json
    $sizes = @($m.icons | ForEach-Object { $_.sizes })
    if ($sizes -notcontains '192x192') { $problems += 'manifest lacks a 192x192 icon' }
    if ($sizes -notcontains '512x512') { $problems += 'manifest lacks a 512x512 icon' }
    foreach ($icon in $m.icons) {
        if (-not (Test-Path (Join-Path $here ('docs/' + $icon.src)))) { $problems += "manifest icon missing: $($icon.src) (run .\tools\icons.ps1)" }
    }
} catch {
    $problems += "manifest does not parse: $($_.Exception.Message)"
}

# The link preview the head tags promise: a 1200x630 docs/og.png. Retake it
# with headless Edge when the look changes (see README, "Link preview").
$og = Join-Path $here 'docs/og.png'
if (-not (Test-Path $og)) {
    $problems += 'docs/og.png is missing (the link preview image)'
} else {
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($og)
    try {
        if ($img.Width -ne 1200 -or $img.Height -ne 630) { $problems += "docs/og.png is $($img.Width)x$($img.Height), not 1200x630" }
    } finally { $img.Dispose() }
}

# Every var(--token) must resolve. A renamed palette silently paints shapes an
# invalid colour -- an SVG stroke of var(--gone) just disappears -- so the
# build refuses to ship a dangling reference.
$declared = [System.Collections.Generic.HashSet[string]]::new()
foreach ($m in [regex]::Matches($css, '(--[a-zA-Z0-9-]+)\s*:')) {
    [void]$declared.Add($m.Groups[1].Value)
}
# Set per-element, not on :root, so it never appears as a declaration in the stylesheet.
[void]$declared.Add('--series')

$dangling = [System.Collections.Generic.HashSet[string]]::new()
foreach ($m in [regex]::Matches(($release + $findingsPage), 'var\(\s*(--[a-zA-Z0-9-]+)')) {
    $name = $m.Groups[1].Value
    if (-not $declared.Contains($name)) { [void]$dangling.Add($name) }
}
foreach ($name in $dangling) { $problems += "dangling custom property reference: var($name)" }
$refCount = [regex]::Matches(($release + $findingsPage), 'var\(\s*--').Count
Write-Output "tokens   $($declared.Count) declared, $refCount references, $($dangling.Count) dangling"

if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-Output "FAIL     $_" }
    throw "build produced $($problems.Count) problem(s)"
}
Write-Output "checks   ok"
