// Focused, off-screen regression for Escape and save-and-return from Rogue Encampment.
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const URL_BASE = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, label, details) => {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(details)}`);
  console.log(`PASS ${label}`);
};
let browser;
let socket;
let nextId = 0;
const pending = new Map();
const exceptions = [];
installGlobalCleanupHandlers();

async function send(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}

async function until(predicate, label) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (await predicate().catch(() => false)) return;
    await delay(60);
  }
  throw new Error(`Timeout: ${label}`);
}

async function escape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

async function click(selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
    return { x, y, width: box.width, height: box.height,
      hit: element === document.elementFromPoint(x, y) || element.contains(document.elementFromPoint(x, y)) };
  })()`);
  check(target?.width > 0 && target.height > 0 && target.hit, `Przycisk ${selector} jest widoczny i klikalny`, target);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
}

try {
  const base = new URL(URL_BASE);
  const health = await (await fetch(new URL('/__rotw_health', base))).json();
  check(path.resolve(health.projectRoot).toLowerCase() === ROOT.toLowerCase(), 'Serwer wskazuje bieżący projekt', health);
  browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '1536,864' });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = targets.find(item => item.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
  // This is an isolated browser profile; the ordinary game keeps its own setting.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('rotw.music.volume.v1', '0.05'); localStorage.setItem('rotw.effects.volume.v1', '0.05'); } catch {}",
  });
  const campUrl = new URL(base);
  campUrl.searchParams.set('skip-team-selection', '1');
  await send('Page.navigate', { url: campUrl.href });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"'), 'Obozowisko');
  check(await evaluate('document.querySelector("#main-menu").hidden && document.querySelector("canvas.main-menu-atmosphere")?.dataset.motion === "paused"'),
    'Menu startowe i jego animacja są zatrzymane w obozie');

  await evaluate('document.querySelector("#camp-open-map").click()');
  await until(() => evaluate('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"'), 'Panel mapy');
  await escape();
  check(await evaluate('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "true" && document.querySelector("#pause-overlay").classList.contains("hidden")'),
    'ESC najpierw zamyka otwarty panel, bez pauzy');

  await escape();
  const opened = await evaluate(`(() => ({
    visible: !document.querySelector('#main-menu').hidden,
    context: document.querySelector('#main-menu').dataset.context,
    focus: document.activeElement?.id,
    shellInert: document.querySelector('#app').inert,
    pauseHidden: document.querySelector('#pause-overlay').classList.contains('hidden'),
    atmosphere: document.querySelector('canvas.main-menu-atmosphere')?.dataset.motion,
  }))()`);
  check(opened.visible && opened.context === 'game' && opened.focus === 'menu-new-game'
    && opened.shellInert && opened.pauseHidden && opened.atmosphere === 'running',
  'ESC otwiera to samo menu co ekran startowy i blokuje obóz', opened);
  await escape();
  check(await evaluate('document.querySelector("#main-menu").hidden && !document.querySelector("#app").inert && document.querySelector("canvas.main-menu-atmosphere")?.dataset.motion === "paused"'),
    'Ponowne ESC zamyka menu i wraca do obozu');

  await escape();
  await evaluate('window.__previousSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error("save blocked in smoke test"); };');
  await click('#menu-save-exit');
  const failure = await evaluate(`(() => ({
    menuVisible: !document.querySelector('#main-menu').hidden,
    context: document.querySelector('#main-menu').dataset.context,
    status: document.querySelector('#main-menu-status').textContent,
  }))()`);
  check(failure.menuVisible && failure.context === 'game' && failure.status.includes('Nie udało się zapisać'),
    'Nieudany zapis pozostawia gracza w menu gry', failure);
  await evaluate('Storage.prototype.setItem = window.__previousSetItem; delete window.__previousSetItem;');

  const before = await evaluate('window.__rotwDebug.snapshot().save');
  await click('#menu-save-exit');
  const saved = await evaluate(`(() => {
    const key = window.__rotwDebug.storageKeys.current;
    const value = JSON.parse(localStorage.getItem(key));
    return {
      menuVisible: !document.querySelector('#main-menu').hidden,
      context: document.querySelector('#main-menu').dataset.context,
      shellInert: document.querySelector('#app').inert,
      status: document.querySelector('#main-menu-status').textContent,
      schemaVersion: value.schemaVersion,
      area: value.campaign.act1.currentAreaId,
      party: value.partyIds,
      title: document.querySelector('#main-menu-title').textContent,
    };
  })()`);
  check(saved.menuVisible && saved.context === 'title' && saved.shellInert && saved.status.includes('Gra zapisana'),
    'Zapisz i wyjdź pozostawia ekran startowy bez zamykania strony', saved);
  check(saved.schemaVersion === 3 && saved.area === before.campaign.act1.currentAreaId
    && JSON.stringify(saved.party) === JSON.stringify(before.partyIds),
  'Zapis v3 zachowuje obszar i drużynę', saved);

  await escape();
  const confirmation = await evaluate(`(() => ({
    visible: !document.querySelector('#main-menu-exit-confirm').hidden,
    question: document.querySelector('#main-menu-exit-question').textContent,
    buttons: [...document.querySelectorAll('#main-menu-exit-confirm button')].map(button => button.textContent),
    focus: document.activeElement?.id,
  }))()`);
  check(confirmation.visible && confirmation.question === 'Wyjść z gry?'
    && JSON.stringify(confirmation.buttons) === JSON.stringify(['Wróć', 'Wyjdź'])
    && confirmation.focus === 'menu-exit-back',
  'ESC na ekranie startowym pyta o wyjście z gry', confirmation);
  await escape();
  check(await evaluate('document.querySelector("#main-menu-exit-confirm").hidden && !document.querySelector("#main-menu").hidden'),
    'ESC zamyka pytanie o wyjście bez zamykania gry');
  await escape();
  await click('#menu-exit-back');
  check(await evaluate('document.querySelector("#main-menu-exit-confirm").hidden'),
    'Przycisk Wróć zamyka pytanie o wyjście');

  const battleUrl = new URL(base);
  battleUrl.searchParams.set('training', '1');
  await send('Page.navigate', { url: battleUrl.href });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.querySelector("#main-menu").hidden'), 'Tryb treningowy');
  await click('#pause');
  check(await evaluate('!document.querySelector("#pause-overlay").classList.contains("hidden") && document.activeElement?.id === "resume"'),
    'Dotychczasowa pauza walki pozostaje dostępna');
  await escape();
  check(await evaluate('document.querySelector("#pause-overlay").classList.contains("hidden")'),
    'ESC nadal zamyka pauzę walki');
  check(exceptions.length === 0, 'Bez wyjątków JavaScript', exceptions);
  console.log('OK: test menu w obozie i pytania o wyjście');
} finally {
  try { socket?.close(); } catch { /* Best-effort cleanup. */ }
  if (browser) await cleanupTrackedBrowser(browser);
}
