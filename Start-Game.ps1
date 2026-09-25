param(
    [switch]$NoBrowser
)

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
$workDirectory = Join-Path $dataRoot 'work'
$serverStatePath = Join-Path $workDirectory 'rotw-server.json'
$launcherLog = Join-Path $workDirectory 'launcher.log'
$saveFilePath = Join-Path $workDirectory 'player-save-v3.json'
$candidatePorts = 4173..4183
$requiredSaveApiVersion = 1
$mutex = $null
$mutexOwned = $false

function Write-LauncherLog([string]$Message) {
  $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -LiteralPath $launcherLog -Value "[$timestamp] $Message" -Encoding UTF8
}

function Get-GameServer([int]$Port) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/__rotw_health" -TimeoutSec 1
    $health = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -eq 200 -and
        $health.app -eq 'reign-of-the-warlock-turn-based' -and
        [string]::Equals([string]$health.projectRoot, $projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      return $health
    }
  } catch { }
  return $null
}

function Test-PortInUse([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    return $attempt.AsyncWaitHandle.WaitOne(150) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Resolve-NodeExecutable {
  $fromPath = Get-Command node -ErrorAction SilentlyContinue
  $candidates = @(
    (Join-Path $projectRoot 'runtime\node.exe')
    if ($null -ne $fromPath) { $fromPath.Source },
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
  return @($candidates | Select-Object -First 1)
}

function Test-RunningProcess([object]$Id) {
  if ($null -eq $Id) { return $false }
  return $null -ne (Get-Process -Id ([int]$Id) -ErrorAction SilentlyContinue)
}

function Stop-OutdatedGameServer([object]$Health, [object]$LauncherState) {
  # Never stop a process merely because it occupies the game's port. The
  # launcher state, health response and process command line must all agree.
  if ($null -eq $LauncherState -or
      [int]$LauncherState.pid -ne [int]$Health.pid -or
      [int]$LauncherState.port -ne [int]$Health.port) {
    throw 'Uruchomiony serwer gry jest starszy, ale nie można bezpiecznie potwierdzić jego procesu. Zamknij grę i uruchom ją ponownie.'
  }
  $pidToStop = [int]$Health.pid
  $freshHealth = Get-GameServer ([int]$Health.port)
  $process = Get-Process -Id $pidToStop -ErrorAction SilentlyContinue
  if ($null -eq $freshHealth -or [int]$freshHealth.pid -ne $pidToStop -or
      $null -eq $process -or $process.ProcessName -ne 'node') {
    throw 'Nie można bezpiecznie potwierdzić starszego procesu serwera gry. Zamknij grę i uruchom ją ponownie.'
  }
  Stop-Process -Id $pidToStop -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 20 -and (Test-PortInUse ([int]$Health.port)); $attempt++) {
    Start-Sleep -Milliseconds 100
  }
  if (Test-PortInUse ([int]$Health.port)) {
    throw 'Starszy serwer gry nie zwolnił portu. Zamknij grę i uruchom ją ponownie.'
  }
  Write-LauncherLog "Zatrzymano tylko starszy serwer tej kopii gry (PID $pidToStop); zostanie uruchomiona aktualna wersja."
}

function Read-LauncherState {
  if (-not (Test-Path -LiteralPath $serverStatePath)) { return $null }
  try {
    $candidate = Get-Content -LiteralPath $serverStatePath -Raw | ConvertFrom-Json
    if ($candidate.app -ne 'reign-of-the-warlock-turn-based' -or
        -not [string]::Equals([string]$candidate.projectRoot, $projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Write-LauncherLog 'Pominieto techniczny stan launchera nalezacy do innej kopii gry.'
      return $null
    }
    return $candidate
  } catch {
    Write-LauncherLog 'Pominieto uszkodzony techniczny stan launchera; zostanie odtworzony po potwierdzeniu serwera.'
    return $null
  }
}

function Find-GameWindowProcess {
  # Edge may hand the app window to another process. Only an actual game window
  # counts; a lingering --app process is not proof that the game is visible.
  return Get-Process -Name 'msedge' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'Reign of the Warlock*' } |
    Select-Object -First 1
}

function Show-GameWindow([object]$GameProcess) {
  try {
    if (-not ('RotwLauncherWindow' -as [type])) {
      $source = @(
        'using System;'
        'using System.Runtime.InteropServices;'
        'public static class RotwLauncherWindow {'
        '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);'
        '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);'
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);'
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
        '}'
      ) -join [Environment]::NewLine
      Add-Type -TypeDefinition $source
    }
    $window = Get-Process -Id ([int]$GameProcess.Id) -ErrorAction Stop
    $handle = $window.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return $false }
    if ([RotwLauncherWindow]::IsIconic($handle)) {
      [RotwLauncherWindow]::ShowWindowAsync($handle, 9) | Out-Null
    }
    [RotwLauncherWindow]::ShowWindowAsync($handle, 3) | Out-Null
    [RotwLauncherWindow]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 150
    return [RotwLauncherWindow]::GetForegroundWindow() -eq $handle
  } catch {
    Write-LauncherLog "Nie udalo sie aktywowac istniejacego okna gry: $($_.Exception.Message)"
    return $false
  }
}

function Refresh-GameWindow([object]$GameProcess) {
  try {
    if (-not (Show-GameWindow $GameProcess)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    if (-not $shell.AppActivate([int]$GameProcess.Id)) { return $false }
    Start-Sleep -Milliseconds 200
    $window = Get-Process -Id ([int]$GameProcess.Id) -ErrorAction Stop
    if ([RotwLauncherWindow]::GetForegroundWindow() -ne $window.MainWindowHandle) { return $false }
    $shell.SendKeys('{F5}')
    Start-Sleep -Milliseconds 750
    return $true
  } catch {
    Write-LauncherLog "Nie udalo sie odswiezyc okna gry: $($_.Exception.Message)"
    return $false
  }
}

function Save-LauncherState([object]$Health, [object]$BrowserProcess, [bool]$BrowserLaunched) {
  [ordered]@{
    app = 'reign-of-the-warlock-turn-based'
    projectRoot = $projectRoot
    pid = [int]$Health.pid
    port = [int]$Health.port
    browserPid = if ($null -ne $BrowserProcess) { [int]$BrowserProcess.Id } else { $null }
    browserLaunched = $BrowserLaunched
    startedUtc = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $serverStatePath -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null
  Set-Content -LiteralPath $launcherLog -Value "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] Uruchamianie launchera." -Encoding UTF8
  if ($installedMode) {
    # The installed game must never write saves inside its removable app folder.
    # A prior portable save accidentally left in this folder is copied once.
    $legacySave = Join-Path $projectRoot 'work\player-save-v3.json'
    if (-not (Test-Path -LiteralPath $saveFilePath) -and
        -not (Test-Path -LiteralPath "$saveFilePath.bak") -and
        (Test-Path -LiteralPath $legacySave -PathType Leaf)) {
      Copy-Item -LiteralPath $legacySave -Destination $saveFilePath -ErrorAction Stop
      if (Test-Path -LiteralPath "$legacySave.bak" -PathType Leaf) {
        Copy-Item -LiteralPath "$legacySave.bak" -Destination "$saveFilePath.bak" -ErrorAction Stop
      }
      Write-LauncherLog 'Przeniesiono kopie starego zapisu z folderu gry do profilu uzytkownika; oryginal pozostawiono.'
    }
    $env:ROTW_SAVE_FILE = $saveFilePath
    $env:ROTW_INSTALLED_MODE = '1'
  } else {
    $env:ROTW_INSTALLED_MODE = '0'
  }
  $mutex = [Threading.Mutex]::new($false, 'Local\ReignOfTheWarlockLauncher')
  $mutexOwned = $mutex.WaitOne(0)
  if (-not $mutexOwned) {
    Write-Host 'Gra jest juz uruchamiana w innym oknie. Poczekaj chwile i uzyj istniejacego okna gry.'
    exit 0
  }

  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'app\index.html'))) { throw 'Brakuje pliku app\index.html.' }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'scripts\serve.mjs'))) { throw 'Brakuje pliku scripts\serve.mjs.' }
  $nodeExecutable = @(Resolve-NodeExecutable)
  if ($nodeExecutable.Count -eq 0) { throw 'Nie znaleziono Node.js 24 lub nowszego. Zainstaluj Node.js albo uruchom gre z Codexa.' }
  $nodeExecutable = [string]$nodeExecutable[0]
  $nodeVersionText = (& $nodeExecutable --version 2>&1 | Select-Object -First 1).ToString().Trim()
  $nodeVersion = [version]($nodeVersionText.TrimStart('v'))
  if ($nodeVersion.Major -lt 24) { throw "Wymagany jest Node.js 24 lub nowszy. Wykryto: $nodeVersionText." }
  Write-LauncherLog "Node.js: $nodeVersionText"

  $savedState = Read-LauncherState
  $preferredPort = $null
  if ($null -ne $savedState) {
    try {
      $savedPort = [int]$savedState.port
      if ($candidatePorts -contains $savedPort) { $preferredPort = $savedPort }
    } catch { }
  }
  $portsInPreferredOrder = if ($null -ne $preferredPort) {
    @($preferredPort) + @($candidatePorts | Where-Object { $_ -ne $preferredPort })
  } else {
    @($candidatePorts)
  }

  $selectedPort = $null
  $serverHealth = $null
  $reusedServer = $false
  foreach ($port in $portsInPreferredOrder) {
    $candidate = Get-GameServer $port
    if ($null -ne $candidate) {
      $selectedPort = $port
      $serverHealth = $candidate
      $reusedServer = $true
      break
    }
  }

  if ($null -ne $serverHealth -and [int]$serverHealth.saveApiVersion -lt $requiredSaveApiVersion) {
    if ($null -ne (Find-GameWindowProcess)) {
      throw 'Gra jest otwarta na starszym serwerze. Użyj w grze „Zapisz i wyjdź”, zamknij jej okno, a następnie kliknij GRAJ ponownie. Nie odświeżono ani nie zamknięto bieżącej sesji.'
    }
    Stop-OutdatedGameServer $serverHealth $savedState
    $selectedPort = $null
    $serverHealth = $null
    $reusedServer = $false
  }

  # Browser localStorage is isolated by origin, including the port. When this
  # copy has a known port, silently falling back to a different port could make
  # an existing player save appear to vanish. A foreign service is therefore a
  # visible blocker instead of a reason to move this game elsewhere.
  if ($null -eq $selectedPort -and $null -ne $preferredPort -and (Test-PortInUse $preferredPort)) {
    throw "Port zapisu $preferredPort jest zajety przez inna usluge. Nie uruchomiono gry pod innym adresem, aby nie odciac Cie od istniejacego zapisu. Zamknij usluge na tym porcie i uruchom ponownie."
  }

  if ($null -eq $selectedPort) {
    Write-Host 'Uruchamianie lokalnego serwera gry...'
    foreach ($port in $portsInPreferredOrder) {
      if (Test-PortInUse $port) {
        Write-LauncherLog "Port $port jest zajety przez inna usluge; pominieto."
        continue
      }
      $serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('scripts/serve.mjs', '--port', "$port") -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
      for ($attempt = 0; $attempt -lt 24; $attempt++) {
        Start-Sleep -Milliseconds 250
        $candidate = Get-GameServer $port
        if ($null -ne $candidate) {
          $selectedPort = $port
          $serverHealth = $candidate
          break
        }
      }
      if ($null -ne $selectedPort) { break }
      if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
      Write-LauncherLog "Serwer na porcie $port nie przeszedl kontroli gotowosci."
    }
  }

  if ($null -eq $selectedPort) { throw 'Nie udalo sie uruchomic serwera gry na portach 4173-4183.' }
  $gameUrl = "http://127.0.0.1:$selectedPort/"

  if ($NoBrowser) {
    Save-LauncherState $serverHealth $null $false
    Write-LauncherLog "Gotowosc potwierdzona bez otwierania lub odswiezania przegladarki: $gameUrl"
    Write-Host "Serwer gry jest gotowy: $gameUrl"
    exit 0
  }

  $runningGameWindow = Find-GameWindowProcess

  if ($reusedServer -and $null -ne $runningGameWindow) {
    if (Refresh-GameWindow $runningGameWindow) {
      Save-LauncherState $serverHealth $runningGameWindow $true
      Write-LauncherLog "Odswiezono istniejace okno gry z aktualnych plikow na $gameUrl; nie utworzono drugiej sesji."
      Write-Host 'Gra byla juz uruchomiona. Odswiezono ja do aktualnej wersji i przywrocono jej okno.'
      exit 0
    }
    throw 'Znaleziono otwarte okno gry, ale nie mozna go bezpiecznie odswiezyc. Uaktywnij okno gry i nacisnij F5.'
  }

  $edgeCandidates = @(@(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if ($edgeCandidates.Count -gt 0) {
    $browserProcess = Start-Process -FilePath $edgeCandidates[0] -ArgumentList @("--app=$gameUrl", '--new-window', '--start-maximized') -PassThru
  } else {
    $browserProcess = Start-Process -FilePath $gameUrl -PassThru
  }
  $openedGameWindow = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $openedGameWindow = Find-GameWindowProcess
    if ($null -ne $openedGameWindow) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($null -eq $openedGameWindow) { throw "Serwer gry jest gotowy, ale nie pojawilo sie okno przegladarki dla $gameUrl." }
  if (-not (Show-GameWindow $openedGameWindow)) {
    Write-LauncherLog 'Okno gry zostalo otwarte, lecz Windows nie pozwolil przeniesc go na wierzch.'
  }
  Save-LauncherState $serverHealth $openedGameWindow $true
  Write-LauncherLog "Gotowosc potwierdzona. Otwarto gre: $gameUrl; PID okna: $($openedGameWindow.Id)"
  Write-Host 'Gra jest gotowa i zostala otwarta w osobnym oknie.'
}
catch {
  $message = $_.Exception.Message
  if (Test-Path -LiteralPath $workDirectory) { Write-LauncherLog "BLAD: $message | $($_.ScriptStackTrace)" }
  Write-Host "BLAD URUCHAMIANIA: $message" -ForegroundColor Red
  Write-Host "Szczegoly zapisano w: $launcherLog" -ForegroundColor Yellow
  exit 1
}
finally {
  if ($null -ne $mutex) {
    if ($mutexOwned) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
  }
}
