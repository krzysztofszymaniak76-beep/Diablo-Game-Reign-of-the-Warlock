# Zasoby sceny v0.5.18

v0.5.18 wykorzystuje ten sam obraz `camp-rogue-encampment-v0517.png` oraz te
same sprite'y NPC. Nie wygenerowano nowych bitmap obozu, postaci ani
przedmiotów. Nowe ramy okien, łuna waypointu i kształty hotspotów powstają
podczas renderowania przez CSS; nie są osobnymi plikami obrazu.

# Obozowisko, NPC i jednostki v0.5.17

Poniższe jedenaście PNG wygenerowano lokalnym ImageGen na podstawie wymagań
użytkownika oraz referencji stylistycznych D2/D2R. Są to własne zasoby robocze
tego projektu — nie są oficjalnymi assetami Blizzarda ani plikami wyciętymi z
gry. Oryginały robocze użyte podczas przygotowania obrazów pozostają poza
paczką wydania.

| Plik w `app/assets/` | Zastosowanie |
|---|---|
| `unit-barbarian-v0517.png` | portret i sylwetka startowego Barbarzyńcy |
| `unit-assassin-v0517.png` | portret i sylwetka startowej Zabójczyni |
| `unit-druid-v0517.png` | portret i sylwetka startowego Druida |
| `unit-warlock-v0517.png` | portret i sylwetka startowego Czarnoksiężnika |
| `npc-akara-v0517.png` | hotspot Akary w Obozowisku Łotrzyc |
| `npc-cain-v0517.png` | kontrolowany, domyślnie ukryty hotspot Deckarda Caina |
| `npc-charsi-v0517.png` | hotspot Charsi w Obozowisku Łotrzyc |
| `npc-gheed-v0517.png` | hotspot Gheeda w Obozowisku Łotrzyc |
| `npc-kashya-v0517.png` | hotspot Kashyi w Obozowisku Łotrzyc |
| `npc-warriv-v0517.png` | hotspot Warriva w Obozowisku Łotrzyc |
| `camp-rogue-encampment-v0517.png` | panoramiczne tło sceny Obozowiska Łotrzyc |

Pozostałe cztery postacie startowe używają zachowanych zasobów v1: Amazonka,
Paladyn, Nekromanta i Czarodziejka. Cain nie jest zwykłą aktywną usługą obozu;
jego grafika pozostaje w paczce dla kontrolowanego stanu uratowania.

# Rodzina ramek v0.5.13

Nowe oryginalne PNG w `app/assets/exploration/`, wbudowany imagegen:
- `map-sentinel-v0513.png` — narożna płaskorzeźba, prawdziwa przezroczystość;
- `map-crest-v0513.png` — centralny demoniczny ornament, przezroczystość;
- `map-caveframe-v0513.png` — podziemny wariant własnej ramy v0.5.12.

Nie są to postacie gry ani kopie oficjalnych assetów. Nie wypalono tekstów.
Prompty i sposób użycia: `docs/MAP_FRAME_SYSTEM_v0.5.13.md`.
Wszystkie dotychczasowe assety pozostają bez zmian.

# Oprawa mapy v0.5.12

Nowe własne zasoby wyłącznie UI w `app/assets/exploration/`:

- `map-ironstone-v0512.png`: generowana tekstura tła UI — czernione żelazo/kamień.
- `map-ironframe-v0512.png`: generowana rama dzielona na dziewięć części przez CSS.
- `map-seal-v0512.svg`: własny wektorowy surowy znak / płaskorzeźba UI.

PNG utworzono wbudowanym imagegen; bez kopiowania grafik Blizzarda.
Prompty, referencja i ograniczenia: `docs/MAP_IRON_UI_v0.5.12.md`.
Wszystkie wcześniejsze assety zachowano bajtowo. Nowe tekstury nie są używane
na podłożu mapy ani w walce. Historyczna oprawa v0.5.10 pozostaje w paczce,
a nowy, ograniczony do mapy CSS zastępuje jej wygląd.

# Oprawa mapy v0.5.10

Zachowano wszystkie cztery PNG krajobrazu v0.5.9 bez zmiany zawartości.
Nie używano ponownie generatora obrazów i nie tworzono postaci.

Nowe własne zasoby wektorowe w `app/assets/exploration/`:

- `map-stoneframe-v0510.svg`: dzielona kamienna listwa, ziarnista faktura i narożne rozety;
- `map-relief-v0510.svg`: rzeźbiony gotycki ornament wnęki;
- `map-flourish-v0510.svg`: ornament nagłówka.

To kod SVG/CSS opracowany w projekcie po obejrzeniu referencji UI D2R,
nie grafiki wycięte z oryginalnej gry. Używany font pozostaje lokalny.
Źródła i ograniczenia: `docs/MAP_PRESENTATION_REPORT_v0.5.10.md`.

# Zachowane zasoby eksploracji v0.5.9

Własne PNG stworzone wbudowanym imagegen po obejrzeniu referencji D2R.
Nie są to skopiowane zasoby Blizzarda. Nie zmieniono sprite'ów postaci.

| Plik w `app/assets/exploration/` | Zastosowanie |
|---|---|
| `blood-moor-ground-v059.png` | ciągłe podłoże oliwkowej trawy i ziemi |
| `den-earth-v059.png` | podłoże i teksturowane obrzeża jaskini |
| `den-entrance-v059.png` | wejście z głazów i dwie pochodnie, PNG alpha |
| `moor-oak-v059.png` | poskręcane drzewo/roślinność, PNG alpha |

Dokładne prompty: `docs/EXPLORATION_ASSET_PROMPTS_v0.5.9.md`.
Obejrzane referencje i ograniczenia: `docs/FIRST_LOCATION_VISUAL_REPORT_v0.5.9.md`.

# Historyczny Asset Manifest v0.5.0

| Zasób | Plik/obszar | Status | Pochodzenie i użycie |
|---|---|---|---|
| Zewnętrzne pole Krwawego Wrzosowiska | `app/assets/battlefield-blood-moor-v1.png` | ORYGINALNY ZASÓB ROBOCZY — AKTYWNY | wygenerowany dla projektu jako szerokie, izometryczne wrzosowisko bez postaci, siatki, logotypów, tekstu i elementów interfejsu; główne tło sceny v0.5.0 |
| Pole bitwy w gotyckich ruinach | `app/assets/battlefield-gothic-v1.png` | ORYGINALNY ZASÓB ROBOCZY — NIEAKTYWNY W SCENIE v0.5.0 | wcześniejsze tło v0.2; pozostaje w repozytorium, ale nie odpowiada zewnętrznej lokacji bieżącego wycinka |
| Sylwetki Amazonki, Nekromanty, Paladyna i Czarodziejki | `app/assets/unit-*-v1.png` | ORYGINALNE ZASOBY ROBOCZE | wygenerowane dla projektu na przezroczystym tle; nie są modelami D2R |
| Model czerwonego demona | `app/assets/unit-demon-red-v1.png` | ORYGINALNY ZASÓB ROBOCZY | wygenerowany dla projektu na przezroczystym tle; nie jest modelem D2R |
| Sylwetka Warlocka | `app/main.js` | JAWNY FALLBACK CANVAS/MONOGRAM | repozytorium nie zawiera osobnego sprite'a Warlocka; bieżąca postać używa własnego awaryjnego rysunku Canvas z monogramem, a nie zasobu D2R |
| Awaryjne sylwetki jednostek | `app/main.js` | REKONSTRUKCJA/PLACEHOLDER | własne figury Canvas używane, gdy obraz nie ma prawidłowej przezroczystości lub nie może zostać użyty |
| Heksowa nakładka taktyczna, ścieżka i pierścienie | `app/main.js` | REKONSTRUKCJA — AKTYWNA | własne prymitywy Canvas powiązane z logicznymi współrzędnymi `q/r`; v0.5.0 pokazuje stale 96 pełnych heksów |
| Zielona strefa rozstawienia | `app/main.js`, `app/styles.css` | REKONSTRUKCJA — AKTYWNA | własna półprzezroczysta prezentacja 24 heksów w trzech kolumnach `q < 3`; nie jest teksturą ani efektem D2R |
| Markery summonów | `app/main.js` | REKONSTRUKCJA/PLACEHOLDER — AKTYWNA | proste własne sylwetki Canvas dla przywołań Nekromanty; nie są osobnymi sprite'ami ani animowanymi modelami |
| Aktywny pocisk i ślad lotu | `app/main.js` | REKONSTRUKCJA/PLACEHOLDER | własny marker i linia Canvas związane z serializowaną pozycją pocisku; brak produkcyjnego sprite'a, animacji, telegraphu i reakcji trafienia |
| Portal Miejski | `app/main.js`, `app/styles.css` | REKONSTRUKCJA/PLACEHOLDER | własna prezentacja Canvas/CSS mechaniki portalu; nie używa efektu ani tekstury Blizzarda |
| Krótki miecz i ikony przedmiotów | `app/main.js`, `app/index.html` | PLACEHOLDER | własne figury/znaki prezentacyjne; nie reprezentują pełnej biblioteki przedmiotów |
| Aura testowa | `app/main.js` | PLACEHOLDER | własna elipsa Canvas i opis HUD; nie jest rekonstrukcją konkretnego efektu D2R |
| Karty klasowe `1 + 3` | `app/index.html`, `app/styles.css`, `app/main.js` | REKONSTRUKCJA — AKTYWNA | własne karty HTML/CSS i glify tekstowe dla Barbarzyńcy, Paladyna i Nekromanty; profil Druida jest tylko rezerwowy |
| Panele na żądanie i HUD | `app/index.html`, `app/styles.css` | REKONSTRUKCJA | własny HTML/CSS i znaki Unicode, bez ikon Blizzarda; test v0.5.0 używa Edge headless. Starszych kontroli rozdzielczości nie przedstawia się jako świeżej weryfikacji tej wersji |
| Fonty | systemowe | ZASÓB SYSTEMOWY | Georgia/system-ui |
| Dźwięk i muzyka | brak | BRAKUJĄCE | nie użyto żadnych plików |
| Ikony, tekstury, modele i animacje D2R | brak | BRAKUJĄCE | nie skopiowano ani nie pobrano |

Projekt nie zawiera oryginalnych modeli, tekstur, ikon, animacji, dialogów, nagrań ani muzyki Blizzarda. Nazwa lokacji opisuje docelowy kontekst adaptacji; sam obraz `battlefield-blood-moor-v1.png` jest nowym zasobem roboczym projektu. Obecne placeholdery są wymienne i nie są przedstawiane jako zasoby D2R ani jako ukończona warstwa produkcyjna.
# Towary handlarzy: oryginalne ikony D2R v0.5.18

Wybrane ikony broni, pancerzy, zwojów, tomów i mikstur w
`app/assets/items/` są wyeksportowanymi bezstratnie plikami PNG RGBA z lokalnej
instalacji Diablo II: Resurrected. Dla nowego zestawu Akary/Charsi/Gheeda
źródłowe wirtualne ścieżki, wymiary oraz SHA-256 zapisano w
`data/d2r-vendor-item-art.v0518.json`; dla broni pozostaje
`data/d2r-control-weapon-art.v0518.json`. Nie rysowano zastępczych kształtów.

Zapas Akary ma działające stosy identyfikacji, zakupu, sprzedaży oraz
przechowywania. Mikstury i zwoje można kupić i przenieść przez inventory; ich
efekt użycia z plecaka nie jest jeszcze częścią tej poprawki. Ceny tych
zapasów są stałymi wartościami adaptacji projektu, a nie deklaracją dokładnych
cen oryginalnej gry.
