param(
  [string]$Version = '0.1',
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs\installer'),
  [switch]$LocalTest,
  [string]$NodeExecutable = '',
  [string]$InnoCompiler = ''
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
if ($Version -notmatch '^\d+\.[0-9]$') { throw 'Wersja wydania musi mieć format X.Y, a numer po kropce musi być cyfrą 0-9.' }
if (-not $NodeExecutable) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw 'Brak Node.js 24+. Podaj -NodeExecutable.'
}
$nodeVersion = [version]((& $NodeExecutable --version).TrimStart('v'))
if ($nodeVersion.Major -lt 24) { throw "Wymagany Node.js 24+. Znaleziono: $nodeVersion" }
if (-not $InnoCompiler) {
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path $programFilesX86 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
  )
  $InnoCompiler = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)[0]
}
if (-not $InnoCompiler) { throw 'Brak kompilatora Inno Setup 6. Podaj -InnoCompiler.' }

$buildId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$buildDir = Join-Path $OutputDirectory $buildId
$stage = Join-Path $buildDir 'stage'
$artifactDir = Join-Path $buildDir 'artifacts'
New-Item -ItemType Directory -Path $stage, $artifactDir -Force | Out-Null

# Explicit runtime allowlist: no private references, tests, work, or prior outputs.
foreach ($directory in @('app', 'data', 'src')) {
  $sourceDirectory = Join-Path $root $directory
  if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { throw "Brak katalogu: $directory" }
  foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse -Force) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Łącze symboliczne w paczce: $($file.FullName)"
    }
    $relative = $file.FullName.Substring($root.Length).TrimStart('\')
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -ErrorAction Stop
  }
}
$rootFiles = @(
  'Start-Game.ps1', 'Stop-Game.ps1', 'Start-Game.cmd', 'Stop-Game.cmd',
  'Reign_of_the_Warlock_GRAJ.cmd', 'package.json'
)
foreach ($relative in $rootFiles + @('scripts\serve.mjs')) {
  $source = Join-Path $root $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Brak pliku: $relative" }
  $destination = Join-Path $stage $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
}

$runtimeDir = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $runtimeDir 'node.exe')
$nodeHash = (Get-FileHash -LiteralPath (Join-Path $runtimeDir 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$sourcePackage = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
[ordered]@{
  product = 'reign-of-the-warlock-turn-based'
  productVersion = $Version
  sourceVersion = [string]$sourcePackage.version
  distribution = if ($LocalTest) { 'LOCAL_TEST_ONLY' } else { 'LOCAL_USER_BUILD' }
  publisher = 'Kris Labs PL'
  nodeVersion = $nodeVersion.ToString()
  nodeSha256 = $nodeHash
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'installed-build.json') -Encoding UTF8
@'
REIGN OF THE WARLOCK - INSTALATOR WINDOWS

Wydawca: Kris Labs PL
Wersja produktu: 0.1

Instalator pozwala wybrać folder gry i utworzyć skrót na pulpicie.
Na stronie „Przeniesienie zapisu” można wskazać wcześniejszy folder gry.
Zapis i jego kopia pozostają w oryginalnym folderze, a do nowej instalacji
trafia ich kopia. Nowe zapisy znajdują się w:
%LOCALAPPDATA%\Kris Labs PL\Reign of the Warlock\work

Odinstalowanie gry nie usuwa zapisów. Gra działa lokalnie z dołączonym
Node.js 24 i otwiera się w oknie Microsoft Edge, jeśli jest dostępny.

W metadanych instalatora podano wydawcę Kris Labs PL. Instalator nie jest
podpisany cyfrowo certyfikatem.

Instalator zawiera materiały z bieżącej kopii projektu. Przed publicznym
udostępnieniem sprawdź prawa do wszystkich grafik i pozostałych zasobów.
'@ | Set-Content -LiteralPath (Join-Path $stage 'INSTRUKCJA_INSTALACJI.txt') -Encoding UTF8

# Draw an original D2 monogram. It does not reuse the official game logo.
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(64, 64)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(15, 12, 12))
$gold = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(212, 177, 103))
$border = [Drawing.Pen]::new([Drawing.Color]::FromArgb(99, 70, 43), 3)
$font = [Drawing.Font]::new('Georgia', 34, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$font2 = [Drawing.Font]::new('Georgia', 24, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
try {
  $graphics.FillRectangle($background, 0, 0, 64, 64)
  $graphics.DrawRectangle($border, 2, 2, 59, 59)
  $graphics.DrawString('D', $font, $gold, 3, 7)
  $graphics.DrawString('2', $font2, $gold, 38, 28)
  $icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
  $stream = [IO.File]::Create((Join-Path $stage 'ReignOfTheWarlock.ico'))
  try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
} finally {
  $font2.Dispose(); $font.Dispose(); $border.Dispose(); $gold.Dispose(); $background.Dispose()
  $graphics.Dispose(); $bitmap.Dispose()
}

$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Brak kompilatora Windows .NET Framework.' }
& $csc /nologo /target:winexe /optimize+ "/out:$(Join-Path $stage 'ReignOfTheWarlock.exe')" "/win32icon:$(Join-Path $stage 'ReignOfTheWarlock.ico')" /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Nie udało się skompilować launchera gry.' }

$privateDirectories = @('reference_input', 'reference_snapshots', 'work', 'outputs', 'test')
$stagedPaths = @(Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
  $_.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/')
})
foreach ($path in $stagedPaths) {
  foreach ($private in $privateDirectories) {
    if ($path -eq $private -or $path.StartsWith("$private/")) { throw "Prywatny plik w paczce: $path" }
  }
}
$testSuffix = if ($LocalTest) { '-LOCAL-TEST' } else { '' }
$testBuildValue = if ($LocalTest) { '1' } else { '0' }
$outputName = "Diablo-Game-Reign-of-the-Warlock-Setup-$Version$testSuffix"
$iss = Join-Path $PSScriptRoot 'ReignOfTheWarlock.iss'
$compilerArguments = @(
  "/DStageDir=$stage",
  "/DOutDir=$artifactDir",
  "/DProductVersion=$Version",
  "/DOutputName=$outputName",
  "/DTestBuild=$testBuildValue",
  $iss
)
& $InnoCompiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "Kompilacja instalatora nie powiodła się: $LASTEXITCODE" }
$installer = Join-Path $artifactDir "$outputName.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Nie znaleziono pliku instalatora: $installer" }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "INSTALATOR: $installer"
Write-Output "SHA-256: $hash"
Write-Output "PLIKI W PACZCE: $($stagedPaths.Count)"
Write-Output "WERSJA ŹRÓDŁOWA: $($sourcePackage.version)"
Write-Output "STATUS: $(if ($LocalTest) { 'KOPIA TESTOWA' } else { 'LOKALNY INSTALATOR WYDANIA' })"
