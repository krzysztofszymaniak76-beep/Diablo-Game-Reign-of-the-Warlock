$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$installedMode = Test-Path -LiteralPath (Join-Path $projectRoot 'installed-build.json') -PathType Leaf
$dataRoot = if ($installedMode) {
  if (-not [string]::IsNullOrWhiteSpace($env:ROTW_DATA_DIR)) {
    [IO.Path]::GetFullPath($env:ROTW_DATA_DIR)
  } else {
    Join-Path $env:LOCALAPPDATA 'Kris Labs PL\Reign of the Warlock'
  }
} else {
  $projectRoot
}
$serverStatePath = Join-Path $dataRoot 'work\rotw-server.json'

if (-not (Test-Path -LiteralPath $serverStatePath)) {
  Write-Host 'Serwer tej kopii gry nie jest uruchomiony.'
  exit 0
}

try {
  $saved = Get-Content -LiteralPath $serverStatePath -Raw | ConvertFrom-Json
  if ($saved.app -ne 'reign-of-the-warlock-turn-based' -or
      -not [string]::Equals([string]$saved.projectRoot, $projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Plik sterujacy nalezy do innej kopii gry.'
  }
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($saved.port)/__rotw_health" -TimeoutSec 1
  $health = $response.Content | ConvertFrom-Json
  if ($health.app -ne $saved.app -or
      [int]$health.pid -ne [int]$saved.pid -or
      -not [string]::Equals([string]$health.projectRoot, $projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Uruchomiony proces nie odpowiada zapisanej kopii gry.'
  }
  Stop-Process -Id ([int]$saved.pid) -Force
  Remove-Item -LiteralPath $serverStatePath -Force
  Write-Host 'Lokalny serwer gry zostal zatrzymany. Mozesz zamknac okno gry.'
} catch {
  Write-Warning "Nie zatrzymano zadnego procesu: $($_.Exception.Message)"
  exit 1
}
