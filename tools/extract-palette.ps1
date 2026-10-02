<#
Theme palette extractor: reads a design mockup / screenshot and prints the
dominant colors plus a 3x3 sample grid, so the values can be copied into
src/renderer/css/tokens.css.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\extract-palette.ps1 -Path "C:\path\theme.png"
Optional:
  -Top 16   number of dominant colors to print (default 12)
  -Step 2   sampling stride in pixels (default 2; larger = faster/coarser)

Output is ASCII only on purpose: Windows PowerShell 5.1 reads script files
without a BOM as ANSI, which corrupts non-ASCII string literals.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Top = 12,
  [int]$Step = 2
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "File not found: $Path"
  exit 1
}

$full = (Resolve-Path -LiteralPath $Path).Path
$source = [System.Drawing.Image]::FromFile($full)
$bitmap = New-Object System.Drawing.Bitmap $source

Write-Output "File : $full"
Write-Output "Size : $($bitmap.Width) x $($bitmap.Height)"

$buckets = @{}
for ($y = 0; $y -lt $bitmap.Height; $y += $Step) {
  for ($x = 0; $x -lt $bitmap.Width; $x += $Step) {
    $pixel = $bitmap.GetPixel($x, $y)
    if ($pixel.A -lt 16) { continue }
    $r = [int]([math]::Floor($pixel.R / 8) * 8)
    $g = [int]([math]::Floor($pixel.G / 8) * 8)
    $b = [int]([math]::Floor($pixel.B / 8) * 8)
    $key = '{0:X2}{1:X2}{2:X2}' -f $r, $g, $b
    if ($buckets.ContainsKey($key)) { $buckets[$key]++ } else { $buckets[$key] = 1 }
  }
}

$total = ($buckets.Values | Measure-Object -Sum).Sum
Write-Output ""
Write-Output "=== dominant colors (share of pixels) ==="
$buckets.GetEnumerator() |
  Sort-Object -Property Value -Descending |
  Select-Object -First $Top |
  ForEach-Object {
    $share = [math]::Round($_.Value / $total * 100, 2)
    $r = [Convert]::ToInt32($_.Key.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($_.Key.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($_.Key.Substring(4, 2), 16)
    '{0}  {1,6}%  RGB({2},{3},{4})' -f ('#' + $_.Key), $share, $r, $g, $b
  }

Write-Output ""
Write-Output "=== 3x3 center samples (RGBA) ==="
for ($row = 0; $row -lt 3; $row++) {
  $line = @()
  for ($col = 0; $col -lt 3; $col++) {
    $x = [int]($bitmap.Width * (($col + 0.5) / 3))
    $y = [int]($bitmap.Height * (($row + 0.5) / 3))
    if ($x -ge $bitmap.Width) { $x = $bitmap.Width - 1 }
    if ($y -ge $bitmap.Height) { $y = $bitmap.Height - 1 }
    $p = $bitmap.GetPixel($x, $y)
    $line += ('#{0:X2}{1:X2}{2:X2} A{3}' -f $p.R, $p.G, $p.B, $p.A)
  }
  Write-Output ($line -join '   ')
}

$bitmap.Dispose()
$source.Dispose()
