// Real game screenshots for the v0.5.18 camp and Diablo-style windows.
// Uses only this script's tracked headless Edge; run from the D2 project root.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
  lifecycleSnapshot,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('docs/evidence/v0.5.18');
const SIZES = [{ width: 1536, height: 864 }, { width: 1280, height: 720 }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const errors = [];
const layout = [];
const screenshots = [];
const pending = new Map();
let browser;
let socket;
let nextId = 0;

installGlobalCleanupHandlers();

function assert(condition, label, detail) {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function send(method, params = {}) {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 45_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function until(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await until(() => evaluate(`innerWidth === ${width} && innerHeight === ${height}`),
    `viewport ${width}x${height}`);
  await delay(90);
}

async function elementCenter(selector) {
  return evaluate(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return !candidate.disabled && !candidate.classList.contains('hidden')
        && rect.width > 1 && rect.height > 1;
    }) ?? candidates[0];
    if (!element || element.disabled || element.classList.contains('hidden')) {
      return { found: Boolean(element), disabled: Boolean(element?.disabled), hidden: Boolean(element?.classList.contains('hidden')) };
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return {
      found: true, disabled: false, hidden: false, x, y,
      width: rect.width, height: rect.height,
      withinViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
      topElementMatches: element === document.elementFromPoint(x, y)
        || element.contains(document.elementFromPoint(x, y)),
    };
  })()`);
}

async function hover(selector) {
  const point = await elementCenter(selector);
  assert(point?.found && !point.disabled && !point.hidden && point.withinViewport,
    `Widoczny cel ${selector}`, point);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await delay(130);
}

async function click(selector) {
  const point = await elementCenter(selector);
  assert(point?.found && !point.disabled && !point.hidden && point.withinViewport && point.topElementMatches,
    `Klikalny cel ${selector}`, point);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y,
    button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y,
    button: 'left', buttons: 0, clickCount: 1 });
  await delay(100);
}

async function stableFrame() {
  await evaluate(`(async () => {
    await document.fonts?.ready;
    const images = [...document.images].map(image => image.complete
      ? image.decode?.().catch(() => {})
      : new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        }));
    await Promise.race([Promise.all(images), new Promise(resolve => setTimeout(resolve, 7000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
}

async function measure(name, width, height, panelExpected) {
  const state = await evaluate(`(() => {
    const r = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height,
        overflowX: Math.max(0, element.scrollWidth - element.clientWidth) };
    };
    return {
      viewport: [innerWidth, innerHeight],
      camp: r(document.querySelector('#camp-layer')),
      panelOpen: document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false',
      panel: r(document.querySelector('#game-panel')),
      body: r(document.querySelector('#panel-body')),
      footer: r(document.querySelector('#game-panel .d2-footer')),
      gold: r(document.querySelector('.d2-inventory-v0518 .d2-empty-gold')),
      cubeButton: r(document.querySelector('.d2-inventory-v0518 #open-horadric-cube')),
      ownerTabs: r(document.querySelector('.d2-inventory-v0518 #equipment-owner-tabs')),
      inventoryFrame: document.querySelector('#game-panel')?.classList.contains('empty-inventory-template'),
      itemDetails: r(document.querySelector('.d2-inventory-v0518 #item-details')),
      grids: [...document.querySelectorAll('#panel-body .d2-grid, #panel-body #inventory-grid, #panel-body .cube-item-grid')]
        .map(grid => ({ label: grid.getAttribute('aria-label'), ...r(grid) })),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  layout.push({ name, width, height, ...state });
  assert(state.viewport[0] === width && state.viewport[1] === height,
    `${name}: rozdzielczość ${width}x${height}`, state.viewport);
  assert(state.horizontalOverflow <= 2,
    `${name}: brak poziomego przewijania strony ${width}x${height}`, state.horizontalOverflow);
  if (panelExpected) {
    assert(state.panelOpen && state.panel.left >= -1 && state.panel.top >= -1
      && state.panel.right <= width + 1 && state.panel.bottom <= height + 1,
    `${name}: okno mieści się w ekranie ${width}x${height}`, state.panel);
    assert(state.body.overflowX <= 2,
      `${name}: zawartość okna nie jest ucięta w poziomie ${width}x${height}`, state.body);
    assert(state.grids.every(grid => grid.left >= state.body.left - 2
      && grid.right <= state.body.right + 2
      && grid.top >= state.body.top - 2
      && grid.bottom <= state.body.bottom + 2),
    `${name}: siatki mieszczą się w panelu ${width}x${height}`, state.grids);
    if (name === '06-inventory') {
      assert(state.inventoryFrame && Boolean(state.gold) && Boolean(state.cubeButton)
        && Boolean(state.ownerTabs)
        && state.gold.left >= state.body.left - 2
        && state.gold.right <= state.body.right + 2
        && state.gold.top >= state.body.top - 2
        && state.gold.bottom <= state.body.bottom + 2
        && state.cubeButton.left >= state.gold.left - 2
        && state.cubeButton.right <= state.gold.right + 2
        && state.ownerTabs.left >= state.body.left - 2
        && state.ownerTabs.right <= state.body.right + 2
        && state.ownerTabs.bottom <= state.body.bottom + 2,
      `${name}: złoto, przycisk Kostki i wybór bohatera mieszczą się w kanonicznej ramie ${width}x${height}`,
      { gold: state.gold, cubeButton: state.cubeButton, ownerTabs: state.ownerTabs, body: state.body });
      assert(Boolean(state.itemDetails),
      `${name}: opis przedmiotu pozostaje dostępny po wyborze itemu ${width}x${height}`,
      { itemDetails: state.itemDetails });
    }
  } else {
    assert(!state.panelOpen, `${name}: pełna scena bez zasłaniającego okna`, state);
  }
}

async function screenshotPair(name, { panel = false, hoverSelector = null } = {}) {
  for (const { width, height } of SIZES) {
    await setViewport(width, height);
    await stableFrame();
    if (hoverSelector) await hover(hoverSelector);
    const image = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    });
    const file = path.join(OUT, `${name}-${width}x${height}.png`);
    await writeFile(file, Buffer.from(image.data, 'base64'));
    screenshots.push(file);
    console.log(`SCREENSHOT ${file}`);
    await measure(name, width, height, panel);
  }
  await setViewport(1536, 864);
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await until(() => evaluate("document.readyState === 'complete' && Boolean(window.__rotwDebug?.snapshot)"),
    `start gry ${url}`);
}

async function ensureTeam() {
  if (!await evaluate("document.querySelector('#team-selection-layer')?.getAttribute('aria-hidden') === 'false'")) return;
  const selected = await evaluate(`([...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]
    .map(element => element.dataset.heroId))`);
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of ['korgan', 'mael', 'veyran']) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click('#team-selection-confirm');
}

async function closePanel() {
  if (await evaluate("document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false'")) {
    await click('#close-panel');
    await until(() => evaluate("document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'true'"),
      'zamknięcie okna');
  }
}

async function openCampAction(action, marker) {
  await closePanel();
  await click(`[data-camp-action="${action}"]`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(marker)}))
    && document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false'`),
    `okno ${action}`);
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5_000),
  })).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer 4174 udostępnia bieżący projekt D2', health);
  const lifecycle = await lifecycleSnapshot();
  assert(lifecycle.owned.length < lifecycle.maxRoots,
    'Dostępny izolowany slot przeglądarki', lifecycle.owned.length);

  browser = await launchTrackedBrowser({
    edgePath: EDGE, appUrl: 'about:blank', windowSize: '1536,864',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  assert(Boolean(target?.webSocketDebuggerUrl), 'Karta testowa Edge jest dostępna');
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
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled'
      && ['error', 'assert'].includes(message.params.type)) {
      errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await setViewport(1536, 864);

  const initial = new URL(APP_URL);
  initial.searchParams.set('acceptance', 'v0.5.18');
  await navigate(initial.href);
  await ensureTeam();
  await until(() => evaluate("document.querySelector('#camp-layer')?.getAttribute('aria-hidden') === 'false'"),
    'Obozowisko Łotrzyc');
  assert(await evaluate("document.querySelector('[data-camp-action=\"cain\"]')?.classList.contains('hidden')"),
    'Cain pozostaje ukryty bez fabularnej flagi');
  await screenshotPair('01-obozowisko-lotrzyc');

  // The waypoint is a real scene hotspot, and its halo is captured on hover.
  await screenshotPair('02-waypoint-luna', { hoverSelector: '[data-camp-action="waypoint"]' });
  await openCampAction('waypoint', '.camp-waypoint-view');
  await closePanel();

  await openCampAction('akara', '.d2-dialogue-v0518');
  await screenshotPair('04-akara', { panel: true });
  await openCampAction('charsi', '.d2-trade-v0518 .d2-trade-columns');
  await screenshotPair('05-charsi', { panel: true });

  await closePanel();
  await click('#camp-open-inventory');
  await until(() => evaluate("Boolean(document.querySelector('.d2-inventory-v0518 #inventory-grid'))"),
    'ekwipunek bohatera');
  assert(await evaluate("document.querySelectorAll('.d2-inventory-v0518 #inventory-grid .inventory-cell').length") === 40,
    'Plecak ma 40 rzeczywistych pól');
  await screenshotPair('06-inventory', { panel: true });
  await click('#inventory-grid .inventory-item');
  assert(await evaluate("document.querySelector('#item-details')?.hidden === false && Boolean(document.querySelector('#equipment-action'))"),
    'Wybrany przedmiot otwiera działający opis i akcję wyposażenia');
  await click('.d2-live-detail-close');

  await click('#open-horadric-cube');
  await until(() => evaluate("Boolean(document.querySelector('.horadric-cube-panel .cube-relic-grid'))"),
    'Kostka Horadrimów');
  assert(await evaluate("document.querySelectorAll('.cube-relic-grid .cube-grid-cell').length") === 12,
    'Kostka ma 4 × 3 rzeczywiste pola');
  await screenshotPair('08-kostka-horadrimow', { panel: true });

  await openCampAction('stash', '.d2-stash-v0518 .d2-stash-grid');
  assert(await evaluate("document.querySelectorAll('.d2-stash-grid .d2-grid-cell').length") === 80,
    'Skrytka ma 10 × 8 rzeczywistych pól');
  await screenshotPair('07-skrytka', { panel: true });

  await openCampAction('akara', '.d2-dialogue-v0518');
  await click('.d2-dialogue-sheet > button');
  await until(() => evaluate("Boolean(document.querySelector('.d2-trade-v0518 .d2-trade-columns'))"),
    'handel z Akarą');
  await screenshotPair('09-handel-npc-akara', { panel: true });

  // Preview state is explicit in the URL; a normal new campaign keeps Cain hidden.
  await closePanel();
  const preview = new URL(APP_URL);
  preview.searchParams.set('acceptance', 'v0.5.18-cain-preview');
  preview.searchParams.set('cain-rescued', '1');
  preview.searchParams.set('skip-team-selection', '1');
  await navigate(preview.href);
  await until(() => evaluate("document.querySelector('#camp-layer')?.getAttribute('aria-hidden') === 'false'"),
    'obóz z testową flagą Caina');
  assert(await evaluate("!document.querySelector('[data-camp-action=\"cain\"]')?.classList.contains('hidden')"),
    'Cain widoczny tylko w stanie podglądowym');
  await screenshotPair('03-cain-po-ratunku-podglad', { hoverSelector: '[data-camp-action="cain"]' });
  await openCampAction('cain', '.camp-dialogue-view');
  assert((await evaluate("document.querySelector('#panel-title')?.textContent.trim()")) === 'DECKARD CAIN',
    'Kliknięcie Caina otwiera jego dialog');
  await closePanel();

  await click('[data-camp-action="gate"]');
  await until(() => evaluate("window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === 'act1.blood_moor'"),
    'wyjście na Krwawe Wrzosowisko');
  await click('[data-open-panel="map"]');
  await until(() => evaluate("Boolean(document.querySelector('#exploration-map'))"),
    'mapa Krwawego Wrzosowiska');
  await screenshotPair('10-wyjscie-krwawe-wrzosowisko', { panel: true });

  assert(errors.length === 0, 'Brak wyjątków i błędów konsoli', errors);
  await writeFile(path.join(OUT, 'ui-v0518-panels-acceptance.json'), JSON.stringify({
    result: 'PASS', checks, errors, layout, screenshots,
  }, null, 2));
}

let failed;
try {
  await mkdir(OUT, { recursive: true });
  await run();
} catch (error) {
  failed = error;
  await writeFile(path.join(OUT, 'ui-v0518-panels-acceptance.json'), JSON.stringify({
    result: 'FAIL', checks, errors, layout, screenshots, failure: error.stack ?? error.message,
  }, null, 2)).catch(() => {});
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  const cleanup = browser ? await cleanupTrackedBrowser(browser) : null;
  if (cleanup?.remaining?.length && !failed) failed = new Error('Pozostały procesy własnej przeglądarki testowej');
  console.log(`BROWSER_CLEANUP ${JSON.stringify({ rootPid: cleanup?.rootPid,
    remaining: cleanup?.remaining?.length ?? 0 })}`);
}
if (failed) {
  console.error(failed.stack ?? failed.message);
  process.exitCode = 1;
} else {
  console.log(`PASS ui-v0518-panels-acceptance ${checks.length} checks; ${screenshots.length} screenshots`);
}
