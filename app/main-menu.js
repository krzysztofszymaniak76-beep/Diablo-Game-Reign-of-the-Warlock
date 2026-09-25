import { createMenuAtmosphere } from './main-menu-atmosphere.js';
import { createMenuUpdates } from './menu-updates.js';

const EFFECTS_VOLUME_KEY = "rotw.effects.volume.v1";

function storedEffectsVolume(storage) {
  try {
    const raw = storage?.getItem(EFFECTS_VOLUME_KEY);
    if (raw !== null && raw !== undefined && raw !== "") {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
    }
  } catch { /* Browser storage is optional. */ }
  return 70;
}

export function createMainMenu({ gameShell, music, onNewGame, onContinue, onCheckContinue, onSaveAndExit, onSettingsChanged, onVisibilityChange }) {
  const root = document.querySelector("#main-menu");
  const content = root.querySelector(".main-menu-content");
  const actions = document.querySelector("#main-menu-actions");
  const settings = document.querySelector("#main-menu-settings");
  const status = document.querySelector("#main-menu-status");
  const musicSlider = document.querySelector("#menu-music-volume");
  const musicValue = document.querySelector("#menu-music-value");
  const effectsSlider = document.querySelector("#menu-effects-volume");
  const effectsValue = document.querySelector("#menu-effects-value");
  const fullscreenButton = document.querySelector("#menu-fullscreen");
  const newGameButton = document.querySelector('#menu-new-game');
  const continueButton = document.querySelector('#menu-continue');
  const saveExitButton = document.querySelector('#menu-save-exit');
  const atmosphere = createMenuAtmosphere(root);
  const updates = createMenuUpdates({ root, content });
  const storage = (() => { try { return localStorage; } catch { return null; } })();
  let previousShellState = null;
  let focusBeforeMenu = null;
  let resumeGame = false;
  let continueState = { available: false, hasExisting: false, message: '' };
  let continueProbe = 0;
  let busy = false;
  const newGameConfirm = document.createElement('section');
  newGameConfirm.id = 'main-menu-new-game-confirm';
  newGameConfirm.className = 'main-menu-exit-confirm';
  newGameConfirm.hidden = true;
  newGameConfirm.setAttribute('role', 'alertdialog');
  newGameConfirm.setAttribute('aria-modal', 'true');
  newGameConfirm.setAttribute('aria-labelledby', 'main-menu-new-game-question');
  newGameConfirm.innerHTML = `<div class="main-menu-exit-frame">
    <h2 id="main-menu-new-game-question">Rozpocząć nową grę?</h2>
    <p>Obecna kontynuacja zostanie zastąpiona dopiero po utworzeniu postaci. Wcześniejszy zapis trafi do kopii zapasowej.</p>
    <div class="main-menu-exit-actions">
      <button id="menu-new-game-back" class="main-menu-button" type="button">Wróć</button>
      <button id="menu-new-game-confirm" class="main-menu-button" type="button">Nowa gra</button>
    </div>
  </div>`;
  root.append(newGameConfirm);
  const exitConfirm = document.createElement("section");
  exitConfirm.id = "main-menu-exit-confirm";
  exitConfirm.className = "main-menu-exit-confirm";
  exitConfirm.hidden = true;
  exitConfirm.setAttribute("role", "alertdialog");
  exitConfirm.setAttribute("aria-modal", "true");
  exitConfirm.setAttribute("aria-labelledby", "main-menu-exit-question");
  exitConfirm.innerHTML = `<div class="main-menu-exit-frame">
    <h2 id="main-menu-exit-question">Wyjść z gry?</h2>
    <div class="main-menu-exit-actions">
      <button id="menu-exit-back" class="main-menu-button" type="button">Wróć</button>
      <button id="menu-exit-confirm" class="main-menu-button" type="button">Wyjdź</button>
    </div>
  </div>`;
  root.append(exitConfirm);

  function closeNewGameConfirm() {
    if (newGameConfirm.hidden) return;
    newGameConfirm.hidden = true;
    content.inert = false;
    content.removeAttribute('aria-hidden');
    updates.setBlocked(false);
    newGameButton.focus({ preventScroll: true });
  }

  function openNewGameConfirm() {
    updates.setBlocked(true);
    content.inert = true;
    content.setAttribute('aria-hidden', 'true');
    newGameConfirm.hidden = false;
    document.querySelector('#menu-new-game-back').focus({ preventScroll: true });
  }

  async function refreshContinue() {
    const version = ++continueProbe;
    continueButton.disabled = true;
    try {
      const found = await onCheckContinue();
      if (version !== continueProbe) return;
      continueState = found;
      newGameButton.disabled = found.storageUnavailable === true;
      continueButton.disabled = !found.available;
      if (found.message && !resumeGame) status.textContent = found.message;
    } catch (error) {
      if (version !== continueProbe) return;
      continueState = { available: false, hasExisting: true, message: error.message, storageUnavailable: true };
      newGameButton.disabled = true;
      continueButton.disabled = true;
      status.textContent = `Nie można sprawdzić zapisu: ${error.message}`;
    }
  }

  function closeExitConfirm({ restoreFocus = true } = {}) {
    if (exitConfirm.hidden) return;
    exitConfirm.hidden = true;
    content.inert = false;
    content.removeAttribute("aria-hidden");
    updates.setBlocked(false);
    if (restoreFocus) document.querySelector("#menu-new-game").focus({ preventScroll: true });
  }

  function openExitConfirm() {
    updates.setBlocked(true);
    content.inert = true;
    content.setAttribute("aria-hidden", "true");
    exitConfirm.hidden = false;
    document.querySelector("#menu-exit-back").focus({ preventScroll: true });
  }

  function updateFullscreenLabel() {
    fullscreenButton.textContent = document.fullscreenElement ? "Tryb okienkowy" : "Pełny ekran";
  }

  function syncSettings() {
    musicSlider.value = String(Math.round(music.getVolume() * 100));
    musicValue.value = `${musicSlider.value}%`;
    effectsSlider.value = String(storedEffectsVolume(storage));
    effectsValue.value = `${effectsSlider.value}%`;
  }

  function showSettings() {
    status.textContent = "";
    actions.hidden = true;
    settings.hidden = false;
    musicSlider.focus({ preventScroll: true });
  }

  function showActions() {
    status.textContent = "";
    settings.hidden = true;
    actions.hidden = false;
    newGameButton.focus({ preventScroll: true });
  }

  function show({ resumeGame: mayResume = false } = {}) {
    updates.close({ restoreFocus: false });
    closeExitConfirm({ restoreFocus: false });
    closeNewGameConfirm();
    resumeGame = mayResume;
    root.dataset.context = resumeGame ? "game" : "title";
    status.textContent = "";
    settings.hidden = true;
    actions.hidden = false;
    if (root.hidden) {
      focusBeforeMenu = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      previousShellState = { inert: gameShell.inert, ariaHidden: gameShell.getAttribute("aria-hidden") };
    } else if (!previousShellState) {
      previousShellState = { inert: gameShell.inert, ariaHidden: gameShell.getAttribute("aria-hidden") };
    }
    gameShell.inert = true;
    gameShell.setAttribute("aria-hidden", "true");
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    atmosphere.setActive(true);
    onVisibilityChange?.(true);
    void refreshContinue();
    document.querySelector("#menu-open-settings").focus({ preventScroll: true });
  }

  function hide() {
    updates.close({ restoreFocus: false });
    closeExitConfirm({ restoreFocus: false });
    closeNewGameConfirm();
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    atmosphere.setActive(false);
    if (previousShellState) {
      gameShell.inert = previousShellState.inert;
      if (previousShellState.ariaHidden === null) gameShell.removeAttribute("aria-hidden");
      else gameShell.setAttribute("aria-hidden", previousShellState.ariaHidden);
    }
    previousShellState = null;
    onVisibilityChange?.(false);
    const restoreTarget = focusBeforeMenu?.isConnected && !focusBeforeMenu.disabled
      && focusBeforeMenu.tabIndex >= 0 && focusBeforeMenu.getClientRects().length > 0
      ? focusBeforeMenu
      : gameShell.querySelector('#camp-layer[aria-hidden="false"] #camp-open-map') ?? gameShell.querySelector('#scene');
    focusBeforeMenu = null;
    restoreTarget?.focus({ preventScroll: true });
  }

  syncSettings();
  updateFullscreenLabel();

  musicSlider.addEventListener("input", () => {
    musicValue.value = `${musicSlider.value}%`;
    music.setVolume(Number(musicSlider.value) / 100);
  });
  effectsSlider.addEventListener("input", () => {
    effectsValue.value = `${effectsSlider.value}%`;
    try { storage?.setItem(EFFECTS_VOLUME_KEY, effectsSlider.value); } catch { /* Optional preference. */ }
  });
  const commitSettings = () => {
    if (!resumeGame || !onSettingsChanged) return;
    try {
      Promise.resolve(onSettingsChanged({
        musicVolume: Number(musicSlider.value) / 100,
        effectsVolume: Number(effectsSlider.value),
      })).catch(error => { status.textContent = `Nie udało się zapisać ustawień: ${error.message}`; });
    } catch (error) {
      status.textContent = `Nie udało się zapisać ustawień: ${error.message}`;
    }
  };
  // Persist a completed slider change once, not on every animation/input tick.
  musicSlider.addEventListener('change', commitSettings);
  effectsSlider.addEventListener('change', commitSettings);

  document.querySelector("#menu-open-settings").addEventListener("click", showSettings);
  document.querySelector("#menu-settings-back").addEventListener("click", showActions);
  function startNewGame() {
    closeNewGameConfirm();
    hide();
    try {
      if (onNewGame() === false) {
        show();
        status.textContent = "Nie udało się rozpocząć gry.";
      }
    } catch (error) {
      show();
      status.textContent = `Nie udało się rozpocząć gry: ${error.message}`;
    }
  }
  newGameButton.addEventListener('click', async () => {
    if (busy || newGameButton.disabled) return;
    busy = true;
    try {
      continueState = await onCheckContinue();
      if (continueState.storageUnavailable) {
        status.textContent = continueState.message || 'Nie można sprawdzić istniejącego zapisu.';
        return;
      }
    } catch (error) {
      status.textContent = `Nie można sprawdzić istniejącego zapisu: ${error.message}`;
      return;
    } finally { busy = false; }
    if (continueState.hasExisting) openNewGameConfirm();
    else startNewGame();
  });
  document.querySelector('#menu-new-game-back').addEventListener('click', closeNewGameConfirm);
  document.querySelector('#menu-new-game-confirm').addEventListener('click', startNewGame);
  continueButton.addEventListener('click', async () => {
    if (busy || continueButton.disabled) return;
    busy = true;
    continueButton.disabled = true;
    status.textContent = 'Wczytywanie zapisu…';
    try {
      if (await onContinue() === false) {
        status.textContent = 'Nie udało się wczytać zapisu. Dane pozostawiono bez zmian.';
        return;
      }
      hide();
    } catch (error) {
      status.textContent = `Nie udało się wczytać zapisu: ${error.message}`;
    } finally {
      busy = false;
      if (!root.hidden) void refreshContinue();
    }
  });
  saveExitButton.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    saveExitButton.disabled = true;
    try {
      if (await onSaveAndExit({ resumeGame }) === false) {
        status.textContent = "Nie udało się zapisać gry. Pozostajesz w menu gry.";
        return;
      }
    } catch (error) {
      status.textContent = `Nie udało się zapisać gry: ${error.message}`;
      return;
    } finally {
      busy = false;
      saveExitButton.disabled = false;
    }
    if (resumeGame) {
      resumeGame = false;
      root.dataset.context = "title";
      status.textContent = "Gra zapisana. Wrócono do menu głównego.";
      void refreshContinue();
      return;
    }
    status.textContent = "Przed rozpoczęciem gry nie było zmian do zapisania. Wcześniejszy zapis pozostał nietknięty. Jeśli okno nie zamknie się automatycznie, zamknij je ręcznie.";
    window.close();
  });
  document.querySelector("#menu-exit-back").addEventListener("click", () => closeExitConfirm());
  document.querySelector("#menu-exit-confirm").addEventListener("click", () => {
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        closeExitConfirm();
        status.textContent = "Przeglądarka nie pozwoliła zamknąć okna. Możesz je zamknąć ręcznie.";
      }
    }, 150);
  });
  fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      status.textContent = "";
    } catch {
      status.textContent = "Ta przeglądarka nie pozwoliła zmienić trybu ekranu.";
    }
    updateFullscreenLabel();
  });
  document.addEventListener("fullscreenchange", updateFullscreenLabel);

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (updates.isOpen()) updates.close();
      else if (!exitConfirm.hidden) closeExitConfirm();
      else if (!newGameConfirm.hidden) closeNewGameConfirm();
      else if (resumeGame) hide();
      else if (!settings.hidden) showActions();
      else openExitConfirm();
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab") {
      const currentSection = updates.isOpen() ? updates.dialog : !exitConfirm.hidden ? exitConfirm : !newGameConfirm.hidden ? newGameConfirm : settings.hidden ? actions : settings;
      const controls = [...currentSection.querySelectorAll("button:not([disabled]), input:not([disabled])")]
        .filter(control => !control.hidden && control.getClientRects().length > 0);
      if (currentSection === actions || currentSection === settings) {
        controls.push(document.querySelector('#menu-release-open'));
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    // The underlying game's global hotkeys must not run while the title menu is open.
    event.stopPropagation();
  });

  show();
  return { show, hide, syncSettings, refreshContinue, isVisible: () => !root.hidden };
}
