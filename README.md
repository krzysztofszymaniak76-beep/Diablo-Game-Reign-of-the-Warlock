# Diablo Game — Reign of the Warlock

Prywatny projekt fanowski Kris Labs PL, udostępniany publicznie bez opłat. Pierwsze publiczne wydanie gry to **0.1** (25 września 2026). Rok „Kris Labs PL 2026” oznacza rok powstania gry i nie zmienia się w kolejnych wydaniach.

## Instalacja w Windows

Pobierz najnowszy instalator z sekcji Releases: `Diablo-Game-Reign-of-the-Warlock-Setup-0.3.exe`. Uruchom go, wybierz miejsce instalacji i zaznacz utworzenie skrótu na pulpicie, jeśli chcesz. Instalator jest niepodpisany cyfrowo. Wydawca „Kris Labs PL” w jego metadanych jest nazwą autora, a nie potwierdzeniem podpisu certyfikatem.

Gra zapisuje dane w `%LOCALAPPDATA%\Kris Labs PL\Reign of the Warlock\work`. Odinstalowanie nie usuwa zapisów. Podczas instalacji można wskazać poprzedni folder, z którego zapis ma zostać skopiowany.

W menu głównym mały kafelek „Aktualizacja” sprawdza publiczne wydania tego repozytorium. Aktualizacja jest pobierana tylko z wydania GitHub z pasującą nazwą instalatora, sumą SHA-256 i rozmiarem pliku. Repozytorium musi mieć opublikowane wydanie, aby kontrola aktualizacji znalazła nowszą wersję.

## Uruchamianie ze źródeł i testy

Wymagany jest Node.js 24 lub nowszy. Instalacja pakietów nie jest potrzebna.

- `npm test` uruchamia testy, których wymagane pliki znajdują się w tym publicznym repozytorium.
- `npm run serve` uruchamia lokalną grę pod adresem `http://127.0.0.1:4173/`.
- Instalator dla Windows można zbudować skryptem `installer/Build-Installer.ps1`; wymagane są Inno Setup 6 i kompilator Windows .NET Framework.

Z prywatnej kopii roboczej pominięto katalogi ze zrzutami ekranu, zapisami użytkownika oraz nieposiadający potwierdzonej licencji snapshot referencyjnych tabel. Pominięto również testy źródłowe wymagające tych prywatnych albo zewnętrznych danych; pozostałe testy uruchamiają się normalnie. Wykaz zasobów i ich pochodzenia opisuje `ASSET_MANIFEST.md`. Szczegóły o niepublikowanym snapshotcie zawiera `THIRD_PARTY_REFERENCE_NOTICE.md`.

## Zasoby i prawa

Autor projektu potwierdził prawo do publicznej redystrybucji dołączonych grafik. Muzyka została przygotowana przez autora przy użyciu Suno; autor potwierdził, że oba utwory powstały podczas aktywnej subskrypcji Pro/Premier. Poza zakresem tych oświadczeń nie udziela się licencji na cudze znaki towarowe ani materiały osób trzecich. Do projektu nie dołączono licencji otwartego oprogramowania — publiczny dostęp do repozytorium sam w sobie nie oznacza zgody na ponowne użycie zawartości.

## Wydania

Wersja gry jest numerowana według ciągu `0.1 … 0.9 → 1.0 → 1.1 …`; pełna historia zmian jest widoczna w menu gry. Wydanie 0.3 naprawia aktualizowanie kopii uruchamianej dotychczasowym plikiem GRAJ, kierując instalator do tego samego folderu. Pełna lista zmian znajduje się w `app/release-history.json`.
