# Publikowanie gry i wydania 0.1

Publiczne repozytorium: `krzysztofszymaniak76-beep/Diablo-Game-Reign-of-the-Warlock`.
Lokalna kopia robocza znajduje się w folderze `Diablo-Game`; jej pełna
ścieżka zależy od komputera.

## Wysłanie kodu

Repozytorium zostało utworzone jako puste, bez dodatkowego README,
`.gitignore` i licencji. Lokalna gałąź `main` zawiera przygotowane pliki gry,
a `origin` wskazuje na powyższy adres. Przy pierwszym wysłaniu uruchom
`git push -u origin main` albo użyj **Publish repository** / **Push origin**
w GitHub Desktop. Nie dodawaj drugiego README, `.gitignore` ani licencji przez
formularz GitHub — pliki projektu są już w lokalnym repozytorium, a licencja
ponownego użycia zawartości nie została ustalona.

## Wydanie 0.1

Po wysłaniu kodu utwórz w GitHub nowe wydanie z tagiem `v0.1`, tytułem `Reign of the Warlock 0.1` i opisem z pliku `GITHUB_RELEASE_0.1.md`. Dołącz z Pobranych dokładnie plik `Diablo-Game-Reign-of-the-Warlock-Setup-0.1.exe` i opublikuj wydanie jako stabilne, nie jako wersję roboczą ani prerelease. Plik nie może być zmieniony ani przepakowany — updater weryfikuje rozmiar i SHA-256 przez GitHub Releases API.

## Kolejne wydania i updater

Numeracja: `0.2` do `0.9`, potem `1.0`, `1.1` do `1.9`, `2.0` itd. Dla przykładu wydanie `0.2` powinno mieć tag `v0.2`, stabilny status oraz asset nazwany `Diablo-Game-Reign-of-the-Warlock-Setup-0.2.exe`. Do opisu dodaj konkretne punkty zmian. Po opublikowaniu sprawdź w menu gry kafelek aktualizacji; przed pierwszym wydaniem odpowiedź „Wydanie gry nie jest jeszcze dostępne na GitHubie” jest prawidłowa.
