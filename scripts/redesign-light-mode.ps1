param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\src'
$root = (Resolve-Path $root).Path

$files = Get-ChildItem -Path $root -Recurse -Include *.tsx,*.ts -File |
  Where-Object {
    $_.FullName -notmatch '\\(node_modules|\.next)\\' -and
    $_.Name -ne 'providers.tsx'
  }

$darkLeading  = ' +dark:[A-Za-z0-9_:./\-\[\]\(\)#%]+'
$darkBare     = 'dark:[A-Za-z0-9_:./\-\[\]\(\)#%]+ ?'
$zincToSlate  = 'zinc-(\d{2,4})'

$changed = 0
foreach ($f in $files) {
  $orig = Get-Content -Path $f.FullName -Raw -Encoding UTF8
  if ($null -eq $orig -or $orig.Length -eq 0) { continue }

  $new = $orig
  $new = [regex]::Replace($new, $darkLeading, '')
  $new = [regex]::Replace($new, $darkBare,    '')
  $new = [regex]::Replace($new, $zincToSlate, 'slate-$1')

  if ($new -ne $orig) {
    $changed++
    if (-not $DryRun) {
      Set-Content -Path $f.FullName -Value $new -NoNewline -Encoding UTF8
    }
    Write-Output "[$(if ($DryRun) {'dry'} else {'write'})] $($f.FullName)"
  }
}

Write-Output ""
Write-Output "Files changed: $changed"
