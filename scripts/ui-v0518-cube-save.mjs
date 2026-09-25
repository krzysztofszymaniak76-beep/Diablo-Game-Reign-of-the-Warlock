import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser, lifecycleSnapshot } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('docs/evidence/v0.5.18');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const pageErrors = [];
let browser;
let socket;
let sequence = 0;
const pending = new Map();

installGlobalCleanupHandlers();

function check(condition, label, detail = null) {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function send(method, params = {}) {
  const id = ++sequence;
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout CDP: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
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

async function until(probe, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe().catch(() => null);
    if (result) return result;
    await sleep(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  const state = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return { found: Boolean(element), disabled: element?.disabled };
    element.click();
    return { found: true, disabled: false };
  })()`);
  check(state?.found && !state.disabled, `kliknięcie ${selector}`, state);
}

const save = () => evaluate('window.__rotwDebug.snapshot().save');
const bagOf = (snapshot, id) => snapshot.inventories.find(([ownerId]) => ownerId === id)?.[1];
const identity = item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'position'));

function uniqueOwnership(snapshot) {
  const ids = snapshot.inventories.flatMap(([, grid]) => grid.items.map(item => item.id));
  ids.push(...snapshot.horadricCube.grid.items.map(item => item.id));
  ids.push(...snapshot.campServices.stash.items.map(item => item.id));
  ids.push(...snapshot.campServices.vendors.flatMap(vendor => vendor.offers.map(offer => offer.item.id)));
  ids.push(...snapshot.roster.flatMap(hero => Object.values(hero.equipment).map(item => item.id)));
  return ids.length === new Set(ids).size;
}

async function acquireBrowser() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      return await launchTrackedBrowser({ edgePath: EDGE, appUrl: 'about:blank', windowSize: '1536,864', stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      if (!String(error.message).includes('Limit testowych przeglądarek')) throw error;
      if (attempt % 20 === 0) console.log('WAIT wolny slot przeglądarki testowej');
      await sleep(1500);
    }
  }
  throw new Error('Nie zwolnił się slot przeglądarki testowej');
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
  const target = targets.find(entry => entry.type === 'page');
  check(Boolean(target?.webSocketDebuggerUrl), 'własna karta testowa jest dostępna');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async event => {
    let raw = event.data;
    if (typeof raw !== 'string' && typeof raw?.text === 'function') raw = await raw.text();
    const message = JSON.parse(String(raw));
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params?.exceptionDetails?.exception?.description ?? 'Wyjątek strony');
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
}

async function screenshot() {
  await evaluate(`(async () => { await document.fonts?.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const file = path.join(OUT, 'horadric-cube-real-1536x864.png');
  await mkdir(OUT, { recursive: true });
  await writeFile(file, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${file}`);
  return file;
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), { signal: AbortSignal.timeout(3_000) })).json();
  check(health.app === 'reign-of-the-warlock-turn-based'
    && path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
  'serwer 4174 udostępnia aktualny projekt D2', health);

  browser = await acquireBrowser();
  await connect();
  const app = new URL(APP_URL);
  app.searchParams.set('ui-v0518-cube-save', '1');
  await send('Page.navigate', { url: app.href });
  await until(() => evaluate("Boolean(window.__rotwDebug?.snapshot) && document.readyState === 'complete'"), 'uruchomienie gry');
  await until(() => evaluate("document.querySelector('#team-selection-layer')?.getAttribute('aria-hidden') === 'false'"), 'wybór drużyny');
  const selected = await evaluate("[...document.querySelectorAll('#team-selection-grid [aria-selected=\"true\"]')].map(node => node.dataset.heroId)");
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of ['korgan', 'hadriel', 'ormus']) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click('#team-selection-confirm');
  await until(() => evaluate("document.querySelector('#team-selection-layer')?.getAttribute('aria-hidden') === 'true'"), 'zatwierdzenie drużyny');

  await click('#camp-open-inventory');
  await until(() => evaluate("document.querySelector('#panel-title')?.textContent === 'EKWIPUNEK'"), 'okno inventory');
  await click('#open-horadric-cube');
  await until(() => evaluate("document.querySelector('#panel-title')?.textContent === 'KOSTKA HORADRIMÓW'"), 'okno Kostki');
  check(await evaluate("document.querySelectorAll('.cube-relic-grid .cube-grid-cell').length === 12 && document.querySelectorAll('.cube-backpack-grid .cube-grid-cell').length === 40"),
    'Kostka i plecak mają odpowiednio 12 i 40 pełnych pól');
  check(await evaluate("document.querySelector('.cube-transmute-button')?.disabled === true"),
    'Transmutuj jest uczciwie nieaktywne bez receptury');

  const ownerId = (await save()).inspectedCharacterId;
  const originalSave = await save();
  const original = bagOf(originalSave, ownerId).items.find(item => item.id === 'korgan.hand_axe')
    ?? bagOf(originalSave, ownerId).items[0];
  check(Boolean(original?.id), 'bohater ma rzeczywisty przedmiot w plecaku');
  await click(`.cube-backpack-grid [data-item-id="${original.id}"]`);
  const inCube = await until(async () => {
    const state = await save();
    return state.horadricCube.grid.items.some(item => item.id === original.id)
      && !bagOf(state, ownerId).items.some(item => item.id === original.id) ? state : null;
  }, 'przeniesienie plecak → Kostka');
  check(uniqueOwnership(inCube), 'po włożeniu każdy przedmiot ma jednego właściciela');
  check(JSON.stringify(identity(inCube.horadricCube.grid.items.find(item => item.id === original.id))) === JSON.stringify(identity(original)),
    'przeniesienie zachowało ID i pełne parametry');
  const shot = await screenshot();
  await click('#close-panel');
  check((await save()).horadricCube.grid.items.some(item => item.id === original.id), 'zamknięcie okna zachowuje zawartość Kostki');
  await click('#camp-open-inventory');
  await click('#open-horadric-cube');
  await click(`.cube-relic-grid [data-item-id="${original.id}"]`);
  const outCube = await until(async () => {
    const state = await save();
    return !state.horadricCube.grid.items.some(item => item.id === original.id)
      && bagOf(state, ownerId).items.some(item => item.id === original.id) ? state : null;
  }, 'przeniesienie Kostka → plecak');
  check(uniqueOwnership(outCube), 'po wyjęciu każdy przedmiot ma jednego właściciela');
  check(JSON.stringify(identity(bagOf(outCube, ownerId).items.find(item => item.id === original.id))) === JSON.stringify(identity(original)),
    'wyjęcie zachowało ID i pełne parametry');

  await click(`.cube-backpack-grid [data-item-id="${original.id}"]`);
  await until(async () => (await save()).horadricCube.grid.items.some(item => item.id === original.id), 'przygotowanie zapisu z przedmiotem w Kostce');
  check(await evaluate('window.__rotwDebug.saveGameState()') === true, 'zapis z przedmiotem w Kostce');
  const savedWithCube = await evaluate(`localStorage.getItem(window.__rotwDebug.storageKeys.current)`);
  check(Boolean(savedWithCube), 'zapis w izolowanym profilu przeglądarki istnieje');
  await click(`.cube-relic-grid [data-item-id="${original.id}"]`);
  await until(async () => !(await save()).horadricCube.grid.items.some(item => item.id === original.id), 'późniejsza zmiana żywego stanu');
  await evaluate(`localStorage.setItem(window.__rotwDebug.storageKeys.current, ${JSON.stringify(savedWithCube)})`);
  check(await evaluate('window.__rotwDebug.loadGameState()') === true, 'wczytanie wcześniejszego zapisu z Kostką');
  const loaded = await save();
  check(loaded.horadricCube.grid.items.some(item => item.id === original.id)
    && !bagOf(loaded, ownerId).items.some(item => item.id === original.id)
    && uniqueOwnership(loaded), 'odczyt przywraca jedno ID w Kostce');

  const liveBeforeInvalid = JSON.stringify(loaded);
  const currentKey = await evaluate('window.__rotwDebug.storageKeys.current');
  const backupKey = await evaluate('window.__rotwDebug.storageKeys.backup');
  const validPrimary = await evaluate(`localStorage.getItem(${JSON.stringify(currentKey)})`);
  const validBackup = await evaluate(`localStorage.getItem(${JSON.stringify(backupKey)})`);
  const malformed = structuredClone(loaded);
  delete malformed.horadricCube;
  await evaluate(`localStorage.removeItem(${JSON.stringify(backupKey)}); localStorage.setItem(${JSON.stringify(currentKey)}, ${JSON.stringify(JSON.stringify(malformed))})`);
  check(await evaluate('window.__rotwDebug.loadGameState()') === false, 'niekompletny zapis Kostki jest odrzucony');
  check(JSON.stringify(await save()) === liveBeforeInvalid, 'odrzucenie nie zmienia żywej sesji');

  const duplicate = structuredClone(loaded);
  duplicate.inventories.find(([id]) => id === ownerId)[1].items.push({
    ...structuredClone(duplicate.horadricCube.grid.items.find(item => item.id === original.id)),
    position: { x: 7, y: 0 },
  });
  duplicate.roster.find(hero => hero.id === ownerId).inventoryItemIds.push(original.id);
  await evaluate(`localStorage.setItem(${JSON.stringify(currentKey)}, ${JSON.stringify(JSON.stringify(duplicate))})`);
  check(await evaluate('window.__rotwDebug.loadGameState()') === false, 'podwójne ID w zapisie jest odrzucone');
  check(JSON.stringify(await save()) === liveBeforeInvalid, 'błędny zapis nie usuwa przedmiotu z żywej sesji');
  await evaluate(`localStorage.setItem(${JSON.stringify(currentKey)}, ${JSON.stringify(validPrimary)});
    ${validBackup === null ? `localStorage.removeItem(${JSON.stringify(backupKey)})` : `localStorage.setItem(${JSON.stringify(backupKey)}, ${JSON.stringify(validBackup)})`}`);

  check(pageErrors.length === 0, 'brak wyjątków JavaScript w grze', pageErrors);
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'cube-save-smoke.json'), JSON.stringify({
    checks, ownerId, itemId: original.id, screenshot: shot, errors: pageErrors,
  }, null, 2));
  console.log(`PASS ${checks.length} kontroli; dowód ${shot}`);
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* browser lifecycle owns the process */ }
  const cleanup = await cleanupTrackedBrowser(browser);
  if (browser) console.log(`CLEANUP root=${cleanup.rootPid} remaining=${cleanup.remaining.length}`);
  const lifecycle = await lifecycleSnapshot();
  console.log(`BROWSER SLOTS ${lifecycle.owned.length}/${lifecycle.maxRoots}`);
}
