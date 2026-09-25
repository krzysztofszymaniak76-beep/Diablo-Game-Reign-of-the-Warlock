// Isolated 1920x1080 title-menu smoke test. Run from the D2 project root.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const BASE_URL = process.env.ROTW_MENU_URL ?? 'http://127.0.0.1:4419/';
const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const OUTPUT = path.resolve(PROJECT_ROOT, 'work');
const WIDTH = 1920;
const HEIGHT = 1080;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const runtimeExceptions = [];
const consoleErrors = [];
const network = [];
const media = [];
const pending = new Map();
let browser;
let socket;
let nextId = 0;
let fullscreen = 'untested';

installGlobalCleanupHandlers();

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function send(method, params = {}) {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function until(check, name, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check().catch(() => null);
    if (result) return result;
    await delay(80);
  }
  throw new Error(`Timeout: ${name}`);
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { found: false };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return { found: true, x, y, width: rect.width, height: rect.height,
      disabled: element.disabled, visible: rect.width > 0 && rect.height > 0
        && getComputedStyle(element).visibility !== 'hidden',
      hit: element === document.elementFromPoint(x, y)
        || element.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert(point.found && point.visible && !point.disabled && point.hit
    && point.x >= 0 && point.x < WIDTH && point.y >= 0 && point.y < HEIGHT,
  `Klikalny element ${selector}`, point);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1 });
}

async function key(key, code, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}

async function screenshot(name) {
  await evaluate(`(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  await delay(900);
  const image = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const output = path.join(OUTPUT, name);
  await writeFile(output, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${output}`);
}

async function audioState() {
  return evaluate(`(() => ({
    marker: window.__menuMusicProbe?.marker ?? 0,
    tracks: (window.__menuMusicProbe?.tracks ?? []).map(item => ({
      src: item.element.currentSrc || item.element.src,
      paused: item.element.paused,
      readyState: item.element.readyState,
      networkState: item.element.networkState,
      currentTime: item.element.currentTime,
      mediaError: item.element.error?.message ?? null,
      plays: item.plays,
      errors: item.errors,
    })),
  }))()`);
}

async function markAudio() {
  await evaluate('window.__menuMusicProbe.marker = Date.now()');
}

async function assertPlaying(trackName) {
  const pathname = `/${trackName}.mp3`;
  const result = await until(async () => {
    const state = await audioState();
    const track = state.tracks.find(item => new URL(item.src).pathname.endsWith(pathname));
    return track?.plays.some(play => play.status === 'resolved')
      && !track.paused && !track.mediaError ? { track, marker: state.marker } : null;
  }, `odtwarzanie ${trackName}`, 8_000);
  assert(result.track.plays.every(play => play.at < result.marker || play.status !== 'rejected'),
    `${trackName}: bez odrzuconego odtwarzania po kliknięciu`, result.track.plays);
  assert(result.track.errors.length === 0 && result.track.readyState >= 2,
    `${trackName}: dane audio gotowe bez błędów`, result.track);
  checks.push(`${trackName}: gra po aktywacji użytkownika`);
  console.log(`PASS ${trackName}: gra po aktywacji użytkownika`);
  return result.track;
}

const probeSource = `(() => {
  const originalPlay = HTMLMediaElement.prototype.play;
  const probe = { tracks: [], marker: 0 };
  Object.defineProperty(window, '__menuMusicProbe', { value: probe });
  HTMLMediaElement.prototype.play = function (...args) {
    let record = probe.tracks.find(item => item.element === this);
    if (!record) {
      record = { element: this, plays: [], errors: [] };
      probe.tracks.push(record);
      this.addEventListener('error', () => {
        record.errors.push(this.error?.message || 'media error');
      });
    }
    const attempt = { at: Date.now(), status: 'pending', error: null };
    record.plays.push(attempt);
    try {
      const result = originalPlay.apply(this, args);
      Promise.resolve(result).then(
        () => { attempt.status = 'resolved'; },
        error => { attempt.status = 'rejected'; attempt.error = String(error); },
      );
      return result;
    } catch (error) {
      attempt.status = 'rejected';
      attempt.error = String(error);
      throw error;
    }
  };
})()`;

try {
  await mkdir(OUTPUT, { recursive: true });
  const appUrl = new URL(BASE_URL);
  const health = await (await fetch(new URL('/__rotw_health', appUrl))).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === PROJECT_ROOT.toLowerCase(),
    'Serwer wskazuje bieżący projekt D2', health);

  browser = await launchTrackedBrowser({
    appUrl: 'about:blank', windowSize: `${WIDTH},${HEIGHT}`,
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  if (!target) throw new Error('Brak karty testowej Edge');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled'
      && ['error', 'assert'].includes(message.params.type)) {
      consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    } else if (message.method === 'Network.responseReceived'
      && message.params.response.url.includes('/app/assets/music/')) {
      network.push({ url: message.params.response.url,
        status: message.params.response.status,
        mimeType: message.params.response.mimeType,
        type: message.params.type });
    } else if (message.method.startsWith('Media.')) {
      media.push({ method: message.method, params: message.params });
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Media.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  // Isolated test profile only: never raise the user's real game volume.
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `try { localStorage.setItem('rotw.music.volume.v1', '0.05'); } catch {}\n${probeSource}` });
  await send('Page.navigate', { url: appUrl.href });
  await until(() => evaluate("document.readyState === 'complete' && Boolean(window.__rotwDebug?.snapshot)"),
    'uruchomienie menu');

  const initial = await evaluate(`(() => {
    const menu = document.querySelector('#main-menu');
    const actions = document.querySelector('#main-menu-actions');
    const rect = menu.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      visible: !menu.hidden && menu.getAttribute('aria-hidden') === 'false',
      actionsVisible: !actions.hidden,
      settingsHidden: document.querySelector('#main-menu-settings').hidden,
      shellInert: document.querySelector('#app')?.inert,
      buttons: [...actions.querySelectorAll('button')].map(button => button.textContent.trim()),
      title: document.querySelector('#main-menu-title').textContent.trim(),
      headingText: document.querySelector('.main-menu-heading').textContent.trim(),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      background: getComputedStyle(menu, '::before').backgroundImage,
    };
  })()`);
  assert(initial.viewport[0] === WIDTH && initial.viewport[1] === HEIGHT,
    'Viewport 1920×1080', initial.viewport);
  assert(initial.visible && initial.actionsVisible && initial.settingsHidden,
    'Menu startowe widoczne', initial);
  assert(initial.shellInert, 'Gra pod menu jest nieaktywna', initial);
  assert(JSON.stringify(initial.buttons) === JSON.stringify(['Nowa gra', 'Kontynuuj', 'Ustawienia', 'Zapisz i wyjdź']),
    'Dokładne przyciski menu', initial.buttons);
  assert(initial.title === 'DIABLO' && initial.headingText === 'DIABLO',
    'Jedynym tytułem na ekranie jest DIABLO', initial);
  assert(initial.background.includes('main-menu-user-reference-v1.png'),
    'Tło menu podłączone', initial.background);
  await screenshot('main-menu-user-reference-1920x1080.png');

  const mp3Paths = [
    '/app/assets/music/diablo-intro.mp3',
    '/app/assets/music/diablo-walka.mp3',
  ];
  const mp3Responses = await evaluate(`(async () => Promise.all(${JSON.stringify(mp3Paths)}.map(async path => {
    const response = await fetch(path, { method: 'HEAD' });
    return { path, status: response.status, contentType: response.headers.get('content-type') };
  })))()`);
  assert(mp3Responses.every(item => item.status === 200 && item.contentType?.startsWith('audio/mpeg')),
    'Oba MP3 odpowiadają 200 audio/mpeg w przeglądarce', mp3Responses);

  await markAudio();
  await click('#menu-open-settings');
  await until(() => evaluate("!document.querySelector('#main-menu-settings').hidden"), 'ustawienia');
  const settings = await evaluate(`(() => ({
    actionsHidden: document.querySelector('#main-menu-actions').hidden,
    title: document.querySelector('#menu-settings-title').textContent.trim(),
    note: document.querySelector('.main-menu-setting-note').textContent.trim(),
    music: document.querySelector('#menu-music-volume').value,
    effects: document.querySelector('#menu-effects-volume').value,
    fullscreen: document.querySelector('#menu-fullscreen').textContent.trim(),
    back: document.querySelector('#menu-settings-back').textContent.trim(),
  }))()`);
  assert(settings.actionsHidden && settings.title === 'Ustawienia'
    && settings.music === '5'
    && settings.fullscreen === 'Pełny ekran' && settings.back === 'Powrót do menu',
  'Ustawienia otwierają się z właściwymi kontrolkami', settings);
  assert(settings.note.includes('nie są jeszcze odtwarzane'),
    'Ustawienia jasno opisują brak efektów dźwiękowych', settings.note);
  await screenshot('main-menu-settings-user-reference-1920x1080.png');
  const calmMenu = await assertPlaying('diablo-intro');

  await click('#menu-music-volume');
  await key('Home', 'Home', 36);
  const musicZero = await evaluate(`({ slider: document.querySelector('#menu-music-volume').value,
    output: document.querySelector('#menu-music-value').value,
    storage: localStorage.getItem('rotw.music.volume.v1') })`);
  assert(musicZero.slider === '0' && musicZero.output === '0%' && Number(musicZero.storage) === 0,
    'Suwak muzyki zapisuje 0%', musicZero);
  const safeTestVolume = await evaluate(`(() => {
    const slider = document.querySelector('#menu-music-volume');
    slider.value = '5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { slider: slider.value, storage: localStorage.getItem('rotw.music.volume.v1') };
  })()`);
  assert(safeTestVolume.slider === '5' && Number(safeTestVolume.storage) === .05,
    'Suwak zapisuje testowe 5% bez podgłaśniania gry', safeTestVolume);

  await click('#menu-effects-volume');
  await key('Home', 'Home', 36);
  const effectsZero = await evaluate(`({ slider: document.querySelector('#menu-effects-volume').value,
    output: document.querySelector('#menu-effects-value').value,
    storage: localStorage.getItem('rotw.effects.volume.v1') })`);
  assert(effectsZero.slider === '0' && effectsZero.output === '0%'
    && effectsZero.storage === '0', 'Suwak efektów zapisuje 0%', effectsZero);

  await click('#menu-fullscreen');
  const fullscreenAfter = await until(async () => {
    const state = await evaluate(`({ active: Boolean(document.fullscreenElement),
    status: document.querySelector('#main-menu-status').textContent.trim(),
    label: document.querySelector('#menu-fullscreen').textContent.trim() })`);
    return state.active || state.status ? state : null;
  }, 'reakcja przycisku pełnego ekranu', 2_000).catch(() => ({
    active: false, status: '', label: 'Pełny ekran',
  }));
  if (fullscreenAfter.active) {
    assert(fullscreenAfter.label === 'Tryb okienkowy', 'Pełny ekran włącza się', fullscreenAfter);
    fullscreen = 'supported';
    await click('#menu-fullscreen');
    await until(() => evaluate('!document.fullscreenElement'), 'wyłączenie pełnego ekranu');
    assert(await evaluate("document.querySelector('#menu-fullscreen').textContent.trim() === 'Pełny ekran'"),
      'Powrót do trybu okienkowego');
  } else {
    fullscreen = `headless blocked: ${fullscreenAfter.status || 'no browser status'}`;
    console.log(`INFO ${fullscreen}`);
  }

  await click('#menu-settings-back');
  assert(await evaluate("document.querySelector('#main-menu-settings').hidden && !document.querySelector('#main-menu-actions').hidden"),
    'Powrót z ustawień do menu');
  await until(() => evaluate("!document.querySelector('#menu-new-game').disabled"), 'sprawdzenie zapisu przed nową grą');
  assert(await evaluate("document.querySelector('#menu-continue').disabled"),
    'Test wyboru postaci wymaga izolowanego serwera bez istniejącej kontynuacji');
  await click('#menu-new-game');
  await until(() => evaluate("document.querySelector('#character-creation')?.getAttribute('aria-hidden') === 'false'"),
    'wybór postaci');
  const creation = await evaluate(`({ menuHidden: document.querySelector('#main-menu').hidden,
    title: document.querySelector('#character-creation-title').textContent.trim(),
    background: getComputedStyle(document.querySelector('.character-creation-scene')).backgroundImage,
    choices: document.querySelectorAll('.character-creation-class').length,
    noGenderSwitch: !document.querySelector('#character-creation-switch-gender'),
    noVersionChoice: !document.querySelector('#character-creation-version'),
    shellInert: document.querySelector('#app').inert })`);
  assert(creation.menuHidden && creation.title === 'Wybierz klasę postaci'
    && creation.background.includes('character-select-clean-camp-v2.png')
    && creation.choices === 8 && creation.shellInert
    && creation.noGenderSwitch && creation.noVersionChoice,
  'Nowa gra otwiera wybór oryginalnych postaci bez płci i wersji', creation);
  assert(await evaluate("!document.title.includes('v0.5.18')"),
    'Numer wersji nie pojawia się w tytule okna');
  await screenshot('character-creation-reference-1920x1080.png');
  await click('.character-creation-class[data-hero-id="korgan"]');
  const forwardBarbarian = await evaluate(`(() => {
    const figure = document.querySelector('.character-creation-class[data-hero-id="korgan"]');
    const input = document.querySelector('#character-creation-name');
    return { selected: figure.dataset.selected, background: figure.querySelector('img')?.getAttribute('src'),
      focusedName: document.activeElement === input, name: input.value };
  })()`);
  assert(forwardBarbarian.selected === 'true'
    && forwardBarbarian.background.endsWith('/character-select-original-figures-v2.png')
    && forwardBarbarian.focusedName && forwardBarbarian.name === 'Korgan',
  'Wybrana oryginalna postać występuje do przodu i pole imienia otrzymuje fokus', forwardBarbarian);
  await click('.character-creation-class[data-hero-id="isendra"]');
  await send('Input.insertText', { text: 'IsendraTest' });
  const customName = await evaluate("document.querySelector('#character-creation-name').value");
  assert(customName === 'IsendraTest', 'Imię można nadać rzeczywistym wpisaniem po wyborze postaci', customName);
  await click('#character-creation-hardcore');
  const choices = await evaluate(`({
    selected: [...document.querySelectorAll('.character-creation-class[data-selected="true"]')].map(button => button.dataset.heroId),
    mode: document.querySelector('#character-creation-hardcore').getAttribute('aria-pressed'),
    canCreate: !document.querySelector('#character-creation-confirm').disabled,
  })`);
  assert(JSON.stringify(choices.selected) === JSON.stringify(['korgan', 'isendra'])
    && choices.mode === 'true' && choices.canCreate,
  'Wybór dwóch bohaterów i trybu działa', choices);
  await screenshot('character-creation-two-heroes-1920x1080.png');
  const createPoint = await evaluate(`(() => {
    const rect = document.querySelector('#character-creation-confirm').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...createPoint });
  assert(await evaluate("document.querySelector('#character-creation-confirm').matches(':hover')"),
    'Dostępny przycisk Stwórz podświetla się po najechaniu');
  await screenshot('character-creation-create-highlight-1920x1080.png');
  const calmCamp = await audioState();
  assert(calmCamp.tracks.some(item => item.src.endsWith('/diablo-intro.mp3') && !item.paused),
    'Po Nowej grze spokojny utwór nadal gra', calmCamp);
  await click('#character-creation-confirm');
  await until(() => evaluate("document.querySelector('#character-creation').hidden && document.querySelector('#app').inert === false"),
    'wejście do obozu');
  const camp = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    return { partyIds: save.partyIds, creationProfile: save.creationProfile,
      names: save.roster.filter(hero => save.partyIds.includes(hero.id)).map(hero => hero.name),
      campVisible: !document.querySelector('#camp-layer').classList.contains('hidden'),
      sprite: document.querySelector('.hero[data-character-id="korgan"] img')?.getAttribute('src') };
  })()`);
  assert(JSON.stringify(camp.partyIds) === JSON.stringify(['korgan', 'isendra'])
    && camp.creationProfile.mode === 'hardcore'
    && camp.names.includes('IsendraTest')
    && camp.sprite?.endsWith('/unit-barbarian-v0517.png')
    && camp.campVisible,
  'Dwuosobowa drużyna z wybranym wyglądem i trybem wchodzi do obozu', camp);
  await click('#camp-open-map');
  assert(await evaluate("document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false'"),
    'Mapa jest dostępna po wejściu do obozu');
  await click('#close-panel');
  await click('#camp-open-team');
  await click('.team-selection-card[data-hero-id="isendra"]');
  await click('#team-selection-confirm');
  const solo = await evaluate("window.__rotwDebug.snapshot().save.partyIds");
  assert(JSON.stringify(solo) === JSON.stringify(['korgan']),
    'W obozie można grać jedną postacią', solo);
  await click('#camp-open-team');
  await click('.team-selection-card[data-hero-id="hadriel"]');
  await click('.team-selection-card[data-hero-id="isendra"]');
  await click('#team-selection-confirm');
  const trio = await evaluate("window.__rotwDebug.snapshot().save.partyIds");
  assert(JSON.stringify(trio) === JSON.stringify(['korgan', 'hadriel', 'isendra']),
    'W obozie można wrócić do trzech postaci', trio);
  await click('#camp-load');
  const restored = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    return { partyIds: save.partyIds, profile: save.creationProfile,
      name: save.roster.find(hero => hero.id === 'isendra')?.name };
  })()`);
  assert(JSON.stringify(restored.partyIds) === JSON.stringify(trio)
    && restored.profile.mode === 'hardcore'
    && restored.name === 'IsendraTest',
  'Odczyt zapisu zachowuje skład, tryb, wygląd i imię', restored);

  const trainingUrl = new URL(BASE_URL);
  trainingUrl.search = '?training=1&skip-main-menu=1';
  await send('Page.navigate', { url: trainingUrl.href });
  await until(() => evaluate("document.readyState === 'complete' && Boolean(window.__rotwDebug?.snapshot)"),
    'uruchomienie treningu');
  const battleBefore = await audioState();
  assert(battleBefore.tracks.some(item => item.src.endsWith('/diablo-walka.mp3')),
    'Ekran przygotowania starcia wybiera utwór bojowy', battleBefore);
  await markAudio();
  await click('#start-battle');
  await until(() => evaluate("window.__rotwDebug?.snapshot()?.phase === 'active' || document.querySelector('#phase-label')?.textContent.includes('WALKA')"),
    'start starcia', 6_000);
  const battle = await assertPlaying('diablo-walka');
  assert(battle.src.endsWith('/diablo-walka.mp3'), 'Walka przełącza na drugi MP3', battle.src);
  assert(runtimeExceptions.length === 0, 'Brak wyjątków JavaScript', runtimeExceptions);

  const result = { passed: checks.length, checks, initial, settings, creation, choices, camp, solo, trio, restored, mp3Responses,
    calmMenu, calmCamp, battleBefore, battle, fullscreen, runtimeExceptions, consoleErrors,
    network, media: media.filter(item => /error|event|playerCreated/i.test(item.method)).slice(-30) };
  await writeFile(path.join(OUTPUT, 'main-menu-smoke-results.json'), JSON.stringify(result, null, 2));
  console.log(`RESULT ${checks.length} checks, ${runtimeExceptions.length} JS exceptions, ${consoleErrors.length} console errors`);
} catch (error) {
  const result = { failed: String(error), checks, fullscreen, runtimeExceptions,
    consoleErrors, network, media: media.slice(-30), audio: socket?.readyState === WebSocket.OPEN
      ? await audioState().catch(() => null) : null };
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, 'main-menu-smoke-results.json'), JSON.stringify(result, null, 2));
  throw error;
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  const cleaned = browser ? await cleanupTrackedBrowser(browser) : null;
  console.log(`CLEANUP ${JSON.stringify({ remainingBrowserProcesses: cleaned?.remaining.length ?? 0 })}`);
}

// A separate browser profile exercises the exit button without risking the screenshots above.
if (process.argv.includes('--check-exit')) {
  browser = null;
  socket = null;
  let exitResult = { closed: false, status: '', exceptions: [] };
  try {
    browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: `${WIDTH},${HEIGHT}` });
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    socket = new WebSocket(targets.find(item => item.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        exitResult.exceptions.push(message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text);
      }
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Karta zamknięta po Zapisz i wyjdź'));
      }
      pending.clear();
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: new URL(BASE_URL).href });
    await until(() => evaluate("document.readyState === 'complete' && Boolean(window.__rotwDebug?.snapshot)"),
      'świeże menu do testu wyjścia');
    const clickResult = await click('#menu-save-exit').then(() => null, error => String(error));
    await delay(600);
    exitResult.closed = socket.readyState !== WebSocket.OPEN;
    exitResult.clickResult = clickResult;
    if (!exitResult.closed) {
      exitResult.status = await evaluate("document.querySelector('#main-menu-status').textContent.trim()");
      assert(exitResult.status.includes('Jeśli okno nie zamknie się automatycznie')
        && exitResult.status.includes('zapis'),
      'Przycisk wyjścia pokazuje komunikat awaryjny w headless', exitResult.status);
    } else {
      checks.push('Przycisk wyjścia zamknął kartę w headless');
      console.log('PASS Przycisk wyjścia zamknął kartę w headless');
    }
    assert(exitResult.exceptions.length === 0, 'Wyjście bez wyjątków JavaScript', exitResult.exceptions);
    await writeFile(path.join(OUTPUT, 'main-menu-exit-results.json'), JSON.stringify(exitResult, null, 2));
    console.log(`EXIT ${JSON.stringify(exitResult)}`);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket?.close();
    const cleaned = browser ? await cleanupTrackedBrowser(browser) : null;
    console.log(`EXIT CLEANUP ${JSON.stringify({ remainingBrowserProcesses: cleaned?.remaining.length ?? 0 })}`);
  }
}
