# Maintenance backlog — v0.5.6

Data audytu: 2026-09-18. Dokument jest wynikiem sześciu przebiegów
utrzymaniowych i końcowego red-team. Wersja pozostaje **0.5.6**.

## SAFE_NOW

**Pusta po wykonaniu.** Wszystkie bezpieczne, lokalne poprawki znalezione w
tym cyklu zostały wykonane i zweryfikowane:

- unieważnianie starego `primaryHoverPlan` po zmianie przypisania LPM/PPM;
- ścisła walidacja identyfikatora i flagi `hardcore` w `createCharacter()`;
- odrzucanie nieznanych `heroId`/`skillId` w snapshotach myszy, aur i ataku;
- testy modalnego focusu, `aria-*`, overflowu HUD i granic many;
- testy zapisu/migracji z uszkodzonym primary/backup oraz odtworzeniem oczekującego ataku;
- testy podwójnego kliknięcia, powtórzonych eventów i atomowego rollbacku.

## NEEDS_STRONGER_MODEL

- Pełne targetowanie zwłok i cykl corpse-based (Raise Skeleton/Corpse
  Explosion) z trwałym zapisem i walidacją.
- Kompletne drzewo skilli, level-up, wymagania poziomu i respec.
- Pełne formuły aur/buffów oraz kompletna implementacja AI summonów.
- Uzupełnienie niezaimportowanych tabel referencyjnych (item bases, affixes,
  unique/set/runeword/rune/gem/jewel/charm/recipe/monster/NPC/endgame).

## FUTURE_MAJOR

- Rozbudowa kampanii, questów, NPC, hirelingów i endgame jako spójnego modelu
  domenowego, zamiast kolejnego lokalnego patcha.
- Zmiany dużej architektury schedulera, battlefieldu, geometrii/kamery lub
  systemu treści wymagają osobnego etapu projektowego i silniejszego modelu.
- Pełna biblioteka wizualnych assetów i produkcyjny pipeline danych źródłowych.

## Ślad wykonania SAFE_NOW

| Obszar | Problem | Wykonanie | Dowód |
|---|---|---|---|
| LPM/PPM | stary podgląd ataku pozostawał po zmianie aktywnego skilla | `app/main.js` zeruje plan i hover po zmianie bindingu | UI regresja: podgląd przed zmianą i brak stale planu po zmianie |
| Tożsamość | fabryka przyjmowała pusty id i nie-boolean `hardcore` | walidacja + trim w `src/core/characters.js` | test core |
| Zapis | brakowało trzech konkretnych nieznanych identyfikatorów | testy snapshotów myszy/aur/pending attack | testy save/mouse |
| HUD | niepełne kontrole modal/focus/many | kontrole headless Edge dla 1280/1536/1920 i stanów many | raport UI |
