import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/v0.5.18');
const SIZE = [[1280, 720], [1536, 864], [1920, 1080]];
const ACTIONS = ['akara', 'charsi', 'kashya', 'gheed', 'warriv', 'cain', 'stash', 'waypoint'];
// Independently picked visible features on the unchanged 1659 x 948 camp plate.
const PAINTED_TARGETS = {
  akara: [1385, 475], charsi: [539, 310], kashya: [1170, 490],
  gheed: [390, 475], warriv: [191, 455], cain: [1030, 350],
  stash: [730, 365], waypoint: [1260, 185], gate: [1395, 720],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ensure = (value, message, detail) => {
  if (!value) throw new Error(`${message}: ${JSON.stringify(detail)}`);
};

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async ({ data }) => {
      const message = JSON.parse(typeof data === 'string' ? data : await data.text());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

let browser;
let cdp;
installGlobalCleanupHandlers();

async function until(predicate, label) {
  const end = Date.now() + 18_000;
  while (Date.now() < end) {
    if (await predicate().catch(() => false)) return;
    await delay(70);
  }
  throw new Error(`Timeout: ${label}`);
}

async function mouse(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

async function enterCamp(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.eval('localStorage.clear()').catch(() => {});
  const address = new URL(APP_URL);
  address.searchParams.set('cain-rescued', '1');
  address.searchParams.set('camp-hitbox-check', `${width}`);
  await cdp.send('Page.navigate', { url: address.href });
  await until(() => cdp.eval('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'aplikacja');
  await until(() => cdp.eval('document.querySelector("#team-selection-layer").getAttribute("aria-hidden") === "false"'), 'wybór trójki');
  await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')];
    for (const card of cards) card.click();
    for (const id of ['korgan', 'mael', 'veyran']) document.querySelector('#team-selection-grid [data-hero-id="' + id + '"]').click();
    document.querySelector('#team-selection-confirm').click();
  })()`);
  await until(() => cdp.eval('document.querySelector("#camp-layer").getAttribute("aria-hidden") === "false"'), 'obozowisko');
  await cdp.eval('(async () => { await Promise.all([...document.querySelectorAll(".camp-npc img")].map(img => img.decode().catch(() => {}))); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()');
}

async function checkAction(action, width, height) {
  const position = await cdp.eval(`(() => {
    const button = document.querySelector('[data-camp-action="${action}"]');
    const rect = button.getBoundingClientRect();
    const plate = document.querySelector('.camp-scene').getBoundingClientRect();
    const scale = Math.max(plate.width / 1659, plate.height / 948);
    const x = plate.left + (plate.width - 1659 * scale) / 2 + ${PAINTED_TARGETS[action][0]} * scale;
    const y = plate.top + (plate.height - 948 * scale) / 2 + ${PAINTED_TARGETS[action][1]} * scale;
    const hit = document.elementFromPoint(x, y)?.closest('[data-camp-action]')?.dataset.campAction ?? null;
    const neighbor = document.elementFromPoint(rect.right + 3, y)?.closest('[data-camp-action]')?.dataset.campAction ?? null;
    return {x, y, hit, neighbor, box:[rect.left, rect.top, rect.width, rect.height], hidden:button.classList.contains('hidden')};
  })()`);
  ensure(!position.hidden && position.hit === action && position.neighbor !== action,
    `Hitbox ${action} ${width}x${height}`, position);
  await mouse(position.x, position.y);
  await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"'), `panel ${action}`);
  const heading = await cdp.eval('document.querySelector("#panel-title")?.textContent');
  ensure(heading?.trim().length, `Nagłówek interakcji ${action}`, heading);
  await cdp.eval('document.querySelector("#close-panel").click()');
  await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "true"'), `zamknięcie ${action}`);
  return { action, position, heading };
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), { signal: AbortSignal.timeout(5_000) })).json();
  ensure(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(), 'Właściwy serwer D2', health);
  await mkdir(OUT, { recursive: true });
  browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '1536,864', stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = new Cdp(browser.target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const result = [];
  for (const [width, height] of SIZE) {
    await enterCamp(width, height);
    const css = await cdp.eval('[...document.styleSheets].some(sheet => sheet.href?.includes("v0518-camp.css"))');
    ensure(css, `CSS obozu v0.5.18 ${width}x${height}`);
    const cainVisible = await cdp.eval('!document.querySelector(".camp-cain").classList.contains("hidden")');
    ensure(cainVisible, `Cain widoczny we fladze fabularnego podglądu ${width}x${height}`);
    if (width === 1536) await screenshot('camp-cain-preview-1536x864.png');
    for (const action of ACTIONS) result.push(await checkAction(action, width, height));
    if (width === 1536) {
      await mouse(...await cdp.eval('(() => { const r=document.querySelector(".camp-waypoint").getBoundingClientRect(); return [r.left+r.width/2,r.top+r.height/2]; })()'));
      await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"'), 'ponowne otwarcie waypointu');
      const activation = await cdp.eval(`(() => [...document.querySelectorAll('.camp-waypoint-view button')].find(button => button.textContent.includes('AKTYWUJ BIEŻĄCY WAYPOINT'))?.outerHTML)()`);
      ensure(activation, 'Dostępny przycisk aktywacji waypointu');
      await cdp.eval(`[...document.querySelectorAll('.camp-waypoint-view button')].find(button => button.textContent.includes('AKTYWUJ BIEŻĄCY WAYPOINT')).click()`);
      await until(() => cdp.eval('document.querySelector(".camp-waypoint").classList.contains("is-active")'), 'łuna aktywnego waypointu');
      await cdp.eval('document.querySelector("#close-panel").click()');
      await delay(1200);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 25, y: 50 });
      await delay(130);
      await screenshot('camp-waypoint-active-1536x864.png');
    }
    const gate = await cdp.eval(`(() => {const r=document.querySelector('.camp-scene').getBoundingClientRect();const scale=Math.max(r.width/1659,r.height/948);const x=r.left+(r.width-1659*scale)/2+1395*scale;const y=r.top+(r.height-948*scale)/2+720*scale;return {x,y,hit:document.elementFromPoint(x,y)?.closest('[data-camp-action]')?.dataset.campAction};})()`);
    ensure(gate.hit === 'gate', `Brama klikalna ${width}x${height}`, gate);
    await mouse(gate.x, gate.y);
    await until(() => cdp.eval('window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === "act1.blood_moor"'), 'przejście przez bramę');
    console.log(`PASS obóz ${width}x${height}: 8 interakcji + brama`);
  }
  ensure(!cdp.errors.length, 'Brak błędów aplikacji', cdp.errors);
  await writeFile(path.join(OUT, 'camp-hitboxes-v0.5.18.json'), JSON.stringify({ checks: result, errors: cdp.errors }, null, 2));
  console.log(`PASS obóz: ${result.length} poprawnych interakcji w trzech rozdzielczościach, aktywacja waypointu, przejście przez bramę`);
}

try { await run(); }
finally { cdp?.close(); if (browser) await cleanupTrackedBrowser(browser); }
