import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/cain-identify-v0518');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, label, details) => {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(details)}`);
  console.log(`PASS ${label}`);
};

let browser;
let socket;
let sequence = 0;
const pending = new Map();
const errors = [];
installGlobalCleanupHandlers();

function send(method, params = {}) {
  const id = ++sequence;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function until(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await wait(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5_000),
  })).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer wskazuje bieżący projekt', health);
  await mkdir(OUT, { recursive: true });

  browser = await launchTrackedBrowser({
    appUrl: 'about:blank', windowSize: '1920,1080', stdio: ['ignore', 'ignore', 'pipe'],
  });
  socket = new WebSocket(browser.target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(typeof data === 'string' ? data : await data.text());
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });

  const address = new URL(APP_URL);
  address.searchParams.set('cain-rescued', '1');
  await send('Page.navigate', { url: address.href });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'Start gry');
  await until(() => evaluate('document.querySelector("#team-selection-layer")?.getAttribute("aria-hidden") === "false"'), 'Wybór drużyny');
  await evaluate(`(() => {
    for (const card of [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]) card.click();
    for (const id of ['korgan', 'mael', 'veyran']) document.querySelector('#team-selection-grid [data-hero-id="' + id + '"]').click();
    document.querySelector('#team-selection-confirm').click();
  })()`);
  await until(() => evaluate('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"'), 'Obozowisko Łotrzyc');
  assert(await evaluate('!document.querySelector("[data-camp-action=cain]")?.classList.contains("hidden")'),
    'Cain widoczny w podglądzie uratowania');
  await evaluate('document.querySelector("[data-camp-action=cain]").click()');
  await until(() => evaluate('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "false" && Boolean(document.querySelector(".d2-cain-identify"))'), 'Okno Caina');

  const before = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    const panel = document.querySelector('.d2-cain-identify');
    const buttons = [...panel.querySelectorAll('button')];
    const frame = document.querySelector('#game-panel').getBoundingClientRect();
    return {
      title: document.querySelector('#panel-title')?.textContent?.trim(),
      buttons: buttons.map(button => button.textContent.trim()),
      initialStatus: panel.querySelector('[role="status"]')?.textContent?.trim(),
      inventories: JSON.stringify(save.inventories),
      gold: save.campServices?.gold,
      panelRect: { left: frame.left, top: frame.top, right: frame.right, bottom: frame.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  assert(before.title === 'DECKARD CAIN', 'Nagłówek okna Caina', before.title);
  assert(before.buttons.length === 1 && before.buttons[0] === 'Identyfikuj',
    'Dokładnie jeden przycisk usługi: Identyfikuj', before.buttons);
  assert(before.initialStatus === 'Brak niezidentyfikowanych przedmiotów w tym plecaku.',
    'Uczciwy stan pustego plecaka przed identyfikacją', before.initialStatus);
  assert(before.panelRect.left >= 0 && before.panelRect.top >= 0
    && before.panelRect.right <= before.viewport.width + 1
    && before.panelRect.bottom <= before.viewport.height + 1,
  'Okno mieści się na ekranie 1920×1080', before.panelRect);

  await evaluate('document.querySelector("#cain-identify").click()');
  const after = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    return {
      status: document.querySelector('#cain-identify-status')?.textContent?.trim(),
      inventories: JSON.stringify(save.inventories),
      gold: save.campServices?.gold,
      buttonCount: document.querySelectorAll('.d2-cain-identify button').length,
    };
  })()`);
  assert(after.status === 'Brak przedmiotów do identyfikacji.',
    'Uczciwy wynik kliknięcia bez przedmiotów', after.status);
  assert(after.inventories === before.inventories && after.gold === before.gold,
    'Puste kliknięcie nie zmienia plecaków ani złota', { before, after });
  assert(after.buttonCount === 1, 'Po kliknięciu pozostaje jeden przycisk usługi', after);

  await evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('.d2-cain-identify img')].map(img => img.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const file = path.join(OUT, 'cain-identify-1920x1080.png');
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  console.log(`EVIDENCE ${file}`);

  // The tracked browser has a fresh temporary profile. This fixture touches
  // only that profile's localStorage, never an existing player's save.
  await evaluate('document.querySelector("#close-panel").click()');
  await until(() => evaluate('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"'),
    'Zamknięcie pustego okna Caina');
  const fixture = await evaluate(`(() => {
    const debug = window.__rotwDebug;
    const save = debug.snapshot().save;
    const ownerId = save.inspectedCharacterId;
    const backpack = save.inventories.find(([id]) => id === ownerId)?.[1];
    const item = backpack?.items?.[0];
    if (!item) throw new Error('Brak bezpiecznego przedmiotu bazowego do identyfikacji');
    if (item.identified === false) throw new Error('Przedmiot testowy już jest niezidentyfikowany');
    item.identified = false;
    localStorage.setItem(debug.storageKeys.current, JSON.stringify(save));
    return { ownerId, itemId: item.id, position: item.position,
      canonicalId: item.canonicalId, gold: save.campServices.gold,
      saveKey: debug.storageKeys.current };
  })()`);
  assert(await evaluate('window.__rotwDebug.loadGameState()') === true,
    'Kontrolowany zapis z przedmiotem niezidentyfikowanym wczytuje się');
  const staged = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    const item = save.inventories.find(([id]) => id === ${JSON.stringify(fixture.ownerId)})?.[1].items
      .find(entry => entry.id === ${JSON.stringify(fixture.itemId)});
    return { item, gold: save.campServices.gold };
  })()`);
  assert(staged.item?.identified === false && staged.gold === fixture.gold,
    'Wczytany przedmiot rzeczywiście wymaga identyfikacji', staged);

  await evaluate('document.querySelector("[data-camp-action=cain]").click()');
  await until(() => evaluate('Boolean(document.querySelector(".d2-cain-identify"))'),
    'Ponownie otwarte okno Caina');
  assert(await evaluate('document.querySelector("#cain-identify-status")?.textContent?.trim()')
      === 'Niezidentyfikowane przedmioty: 1.',
    'Cain wykrywa dokładnie jeden niezidentyfikowany przedmiot');
  await evaluate('document.querySelector("#cain-identify").click()');
  const identified = await evaluate(`(() => {
    const debug = window.__rotwDebug;
    const live = debug.snapshot().save;
    const persisted = JSON.parse(localStorage.getItem(debug.storageKeys.current));
    const findItem = save => save.inventories.find(([id]) => id === ${JSON.stringify(fixture.ownerId)})?.[1].items
      .find(entry => entry.id === ${JSON.stringify(fixture.itemId)});
    return {
      status: document.querySelector('#cain-identify-status')?.textContent?.trim(),
      liveItem: findItem(live), persistedItem: findItem(persisted),
      liveGold: live.campServices.gold, persistedGold: persisted.campServices.gold,
    };
  })()`);
  assert(identified.status === 'Zidentyfikowano 1 przedmiot.',
    'Cain potwierdza rzeczywistą identyfikację', identified.status);
  assert(identified.liveItem?.identified === true && identified.persistedItem?.identified === true,
    'Flaga identified=true w stanie gry i zapisanym stanie', identified);
  assert(identified.liveItem.id === fixture.itemId
    && JSON.stringify(identified.liveItem.position) === JSON.stringify(fixture.position)
    && identified.liveItem.canonicalId === fixture.canonicalId
    && identified.persistedItem.id === fixture.itemId
    && JSON.stringify(identified.persistedItem.position) === JSON.stringify(fixture.position)
    && identified.liveGold === fixture.gold && identified.persistedGold === fixture.gold,
  'ID, pozycja, baza i złoto pozostają bez zmian', { fixture, identified });

  await evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('.d2-cain-identify img')].map(img => img.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const successShot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const successFile = path.join(OUT, 'cain-identify-success-1920x1080.png');
  await writeFile(successFile, Buffer.from(successShot.data, 'base64'));
  console.log(`EVIDENCE ${successFile}`);

  assert(await evaluate('window.__rotwDebug.loadGameState()') === true,
    'Ponowne wczytanie zapisanego stanu działa');
  const reloaded = await evaluate(`(() => {
    const save = window.__rotwDebug.snapshot().save;
    return save.inventories.find(([id]) => id === ${JSON.stringify(fixture.ownerId)})?.[1].items
      .find(entry => entry.id === ${JSON.stringify(fixture.itemId)});
  })()`);
  assert(reloaded?.identified === true && reloaded.id === fixture.itemId
    && JSON.stringify(reloaded.position) === JSON.stringify(fixture.position),
  'Identyfikacja utrzymuje się po ponownym wczytaniu', reloaded);
  assert(errors.length === 0, 'Brak błędów JavaScript', errors);
}

try { await run(); }
finally { socket?.close(); if (browser) await cleanupTrackedBrowser(browser); }
