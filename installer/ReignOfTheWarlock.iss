#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutDir
  #error OutDir is required
#endif
#ifndef ProductVersion
  #error ProductVersion is required
#endif
#ifndef OutputName
  #error OutputName is required
#endif

#define AppName "Reign of the Warlock"
#define Publisher "Kris Labs PL"
#if TestBuild == "1"
#define TestSuffix " (kopia testowa)"
#else
#define TestSuffix ""
#endif

[Setup]
AppId={{AD94379A-CF65-445C-8F45-9E8BB5692E06}
AppName={#AppName}{#TestSuffix}
AppVersion={#ProductVersion}
AppVerName={#AppName} {#ProductVersion}{#TestSuffix}
AppPublisher={#Publisher}
DefaultDirName={localappdata}\Programs\Kris Labs PL\Reign of the Warlock
DefaultGroupName=Kris Labs PL\Reign of the Warlock
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousAppDir=yes
OutputDir={#OutDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#StageDir}\ReignOfTheWarlock.ico
UninstallDisplayIcon={app}\ReignOfTheWarlock.ico
VersionInfoCompany={#Publisher}
VersionInfoDescription=Instalator gry {#AppName}{#TestSuffix}
VersionInfoProductName={#AppName}
VersionInfoVersion={#ProductVersion}.0.0
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
InfoAfterFile={#StageDir}\INSTRUKCJA_INSTALACJI.txt

[Languages]
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"

[Tasks]
Name: "desktopicon"; Description: "Utwórz skrót na pulpicie"; GroupDescription: "Skróty:"; Flags: unchecked

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\data\*"; DestDir: "{app}\data"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\scripts\serve.mjs"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#StageDir}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#StageDir}\Start-Game.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Stop-Game.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Start-Game.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Stop-Game.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Reign_of_the_Warlock_GRAJ.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\installed-build.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\ReignOfTheWarlock.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\ReignOfTheWarlock.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\INSTRUKCJA_INSTALACJI.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\GRAJ - Reign of the Warlock{#TestSuffix}"; Filename: "{app}\ReignOfTheWarlock.exe"; WorkingDir: "{app}"
Name: "{group}\Odinstaluj Reign of the Warlock{#TestSuffix}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\GRAJ - Reign of the Warlock{#TestSuffix}"; Filename: "{app}\ReignOfTheWarlock.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\ReignOfTheWarlock.exe"; Description: "Uruchom grę"; Flags: nowait postinstall skipifsilent

[Code]
var
  MigrationPage: TWizardPage;
  MigrationEdit: TNewEdit;
  MigrationBrowse: TNewButton;

function SaveFolder(const Selected: String): String;
var
  Candidate: String;
begin
  Result := Selected;
  if FileExists(AddBackslash(Result) + 'player-save-v3.json') or
     FileExists(AddBackslash(Result) + 'player-save-v3.json.bak') then Exit;
  Candidate := AddBackslash(Result) + 'work';
  if FileExists(AddBackslash(Candidate) + 'player-save-v3.json') or
     FileExists(AddBackslash(Candidate) + 'player-save-v3.json.bak') then
    Result := Candidate;
end;

function GameDataFolder: String;
begin
  Result := Trim(GetEnv('ROTW_DATA_DIR'));
  if Result = '' then
    Result := ExpandConstant('{localappdata}\Kris Labs PL\Reign of the Warlock');
end;

procedure BrowseMigration(Sender: TObject);
var
  Selected: String;
begin
  Selected := MigrationEdit.Text;
  if BrowseForFolder('Wskaż folder wcześniejszej kopii gry:', Selected, False) then
    MigrationEdit.Text := Selected;
end;

procedure InitializeWizard;
var
  Description: TNewStaticText;
begin
  MigrationPage := CreateCustomPage(wpSelectDir, 'Przeniesienie zapisu',
    'Możesz wskazać folder wcześniejszej, przenośnej kopii gry.');
  Description := TNewStaticText.Create(MigrationPage);
  Description.Parent := MigrationPage.Surface;
  Description.Caption := 'Zapis zostanie tylko skopiowany. Pozostaw to pole puste, aby pominąć przeniesienie.';
  Description.AutoSize := True;
  Description.Top := 8;
  Description.Left := 0;

  MigrationEdit := TNewEdit.Create(MigrationPage);
  MigrationEdit.Parent := MigrationPage.Surface;
  MigrationEdit.Top := Description.Top + Description.Height + 20;
  MigrationEdit.Left := 0;
  MigrationEdit.Width := MigrationPage.SurfaceWidth - ScaleX(92);
  MigrationEdit.Text := '';
  #if TestBuild == "1"
  MigrationEdit.Text := GetEnv('ROTW_MIGRATE_SAVE_FROM');
  #endif

  MigrationBrowse := TNewButton.Create(MigrationPage);
  MigrationBrowse.Parent := MigrationPage.Surface;
  MigrationBrowse.Caption := 'Wybierz...';
  MigrationBrowse.Left := MigrationEdit.Left + MigrationEdit.Width + ScaleX(8);
  MigrationBrowse.Top := MigrationEdit.Top - ScaleY(1);
  MigrationBrowse.Width := ScaleX(84);
  MigrationBrowse.OnClick := @BrowseMigration;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = MigrationPage.ID) and (Trim(MigrationEdit.Text) <> '') then begin
    if not FileExists(AddBackslash(SaveFolder(Trim(MigrationEdit.Text))) +
      'player-save-v3.json') and
      not FileExists(AddBackslash(SaveFolder(Trim(MigrationEdit.Text))) +
      'player-save-v3.json.bak') then begin
      MsgBox('Nie znaleziono zapisu w wybranym folderze. Wskaż folder gry albo pozostaw pole puste.',
        mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SourceFolder, DestinationFolder, SourceSave, DestinationSave: String;
begin
  if (CurStep <> ssPostInstall) or (Trim(MigrationEdit.Text) = '') then Exit;
  SourceFolder := SaveFolder(Trim(MigrationEdit.Text));
  SourceSave := AddBackslash(SourceFolder) + 'player-save-v3.json';
  if not FileExists(SourceSave) then SourceSave := SourceSave + '.bak';
  DestinationFolder := AddBackslash(GameDataFolder) + 'work';
  DestinationSave := AddBackslash(DestinationFolder) + 'player-save-v3.json';
  if FileExists(DestinationSave) or FileExists(DestinationSave + '.bak') then begin
    Log('Zapis w profilu użytkownika już istnieje; pozostawiono go bez zmian.');
    Exit;
  end;
  if not ForceDirectories(DestinationFolder) then begin
    MsgBox('Nie udało się przygotować folderu zapisu. Oryginał pozostaje w starym folderze.',
      mbError, MB_OK);
    Exit;
  end;
  if not CopyFile(SourceSave, DestinationSave, False) then begin
    MsgBox('Nie udało się skopiować zapisu. Oryginał pozostaje w starym folderze.',
      mbError, MB_OK);
    Exit;
  end;
  if FileExists(AddBackslash(SourceFolder) + 'player-save-v3.json.bak') then begin
    if not CopyFile(AddBackslash(SourceFolder) + 'player-save-v3.json.bak', DestinationSave + '.bak', False) then
      Log('Nie udało się skopiować kopii zapasowej; główny zapis został skopiowany.');
  end;
  Log('Skopiowano zapis z poprzedniej kopii gry bez usuwania oryginału.');
end;
