// Run against `node scripts/serve.mjs --port 4451`; updater responses are simulated.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const BASE_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4451/';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, label, detail) => {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${label}`);
};
const pending = new Map();
const exceptions = [];
let browser;
let socket;
let nextId = 0;
installGlobalCleanupHandlers();

async function send(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}; socket=${socket?.readyState}; edge=${browser?.stderr?.().slice(-300)}`)); }, 15_000);
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
    await delay(70);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  const target = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const box = element?.getBoundingClientRect();
    if (!box) return null;
    const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
    return { x, y, width: box.width, height: box.height,
      hit: element === document.elementFromPoint(x, y) || element.contains(document.elementFromPoint(x, y)) };
  })()`);
  check(target?.width > 0 && target.height > 0 && target.hit, `Klikalny ${selector}`, target);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
}

try {
  const base = new URL(BASE_URL);
  const health = await (await fetch(new URL('/__rotw_health', base))).json();
  check(path.resolve(health.projectRoot).toLowerCase() === ROOT.toLowerCase(), 'Serwer wskazuje projekt D2', health);

  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_TEST_BROWSER ?? (existsSync(chrome) ? chrome : undefined),
    appUrl: 'about:blank', windowSize: '1920,1080',
  });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__updateStub = {
      get: { currentVersion: '0.1', latestVersion: '0.1', updateAvailable: false },
      posts: [],
    };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/__rotw_update') return originalFetch(input, init);
      if (init?.method === 'POST') {
        window.__updateStub.posts.push(JSON.parse(init.body));
        return Promise.resolve(new Response(JSON.stringify({ started: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify(window.__updateStub.get), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    };
  })()` });
  await send('Page.navigate', { url: base.href });
  await until(() => evaluate("document.querySelector('#menu-current-version')?.textContent === '0.1' && Boolean(window.__rotwDebug?.snapshot)"), 'Menu i wersja 0.1');

  const tile = await evaluate(`(() => {
    const box = document.querySelector('#menu-release-open').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewport: innerWidth,
      label: document.querySelector('#menu-release-open').innerText,
      credit: document.querySelector('.main-menu-release-credit').textContent };
  })()`);
  check(tile.x > 1500 && tile.y > 900 && tile.width <= 190 && tile.height <= 70,
    'Mały kafelek w prawym dolnym rogu', tile);
  check(tile.label.includes('Aktualizacja') && tile.label.includes('0.1')
    && tile.credit.includes('Kris Labs PL') && tile.credit.includes('2026'),
  'Wersja i subtelny podpis', tile);

  await click('#menu-release-open');
  await until(() => evaluate("document.querySelectorAll('#menu-release-list .main-menu-release-entry li').length === 14"), 'Historia wersji');
  const history = await evaluate(`(() => ({
    visible: !document.querySelector('#menu-release-dialog').hidden,
    title: document.querySelector('#menu-release-list h3')?.textContent,
    date: document.querySelector('#menu-release-list time')?.textContent,
    changes: document.querySelectorAll('#menu-release-list li').length,
    status: document.querySelector('#menu-release-status').textContent,
    installHidden: document.querySelector('#menu-release-install').hidden,
    contentInert: document.querySelector('.main-menu-content').inert,
  }))()`);
  check(history.visible && history.title === 'Wersja 0.1' && history.date.includes('2026')
    && history.changes === 14 && history.status.includes('Brak dostępnego instalatora')
    && history.installHidden && history.contentInert,
  'Historia i brak nieopublikowanego instalatora', history);

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check(await evaluate("document.querySelector('#menu-release-dialog').hidden && document.activeElement.id === 'menu-release-open' && !document.querySelector('.main-menu-content').inert"),
    'Escape zamyka historię i przywraca fokus');

  await evaluate(`window.__updateStub.get = {
    currentVersion: '0.1', latestVersion: '0.2', updateAvailable: true,
    release: { version: '0.2', date: '2026-10-01', changes: ['Potwierdzona poprawka testowa.'] },
  }`);
  await click('#menu-release-open');
  await until(() => evaluate("!document.querySelector('#menu-release-install').hidden"), 'Przycisk dostępnej aktualizacji');
  check(await evaluate("document.querySelector('#menu-release-list h3')?.textContent === 'Wersja 0.2' && document.querySelectorAll('#menu-release-list article').length === 2"),
    'Nowe wydanie trafia na początek historii');
  await click('#menu-release-install');
  await until(() => evaluate("document.querySelector('#menu-release-status').textContent.includes('Instalator został uruchomiony')"), 'Potwierdzenie uruchomienia');
  const posts = await evaluate('window.__updateStub.posts');
  check(posts.length === 1 && posts[0].action === 'install', 'Instalacja wymaga osobnego kliknięcia', posts);
  check(exceptions.length === 0, 'Brak wyjątków JavaScript', exceptions);
} finally {
  socket?.close();
  if (browser) await cleanupTrackedBrowser(browser);
}
