import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/empty-inventory-v0518');
const SIZES = [[1920, 1080], [1280, 720]];
const checks = [];
const errors = [];
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, label, detail) => {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  checks.push(label);
  console.log(`PASS ${label}`);
};

let browser;
let socket;
let sequence = 0;
const pending = new Map();
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function until(predicate, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate().catch(() => false)) return;
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function mouse(x, y) {
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
}

async function screenshot(width, height) {
  const capture = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const file = path.join(OUT, `empty-inventory-${width}x${height}.png`);
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  return file;
}

async function prepareApp() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5_000),
  })).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer 4174 udostępnia bieżący projekt D2', health);
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
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
      errors.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  const address = new URL(APP_URL);
  address.searchParams.set('inventory-template', '1');
  await send('Page.navigate', { url: address.href });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'start gry');
  await until(() => evaluate('document.querySelector("#team-selection-layer")?.getAttribute("aria-hidden") === "false"'),
    'wybór drużyny');
  await evaluate(`(() => {
    for (const card of [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]) card.click();
    for (const id of ['korgan', 'mael', 'veyran']) document.querySelector('#team-selection-grid [data-hero-id="' + id + '"]').click();
    document.querySelector('#team-selection-confirm').click();
  })()`);
  await until(() => evaluate('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"'),
    'obozowisko po wyborze');
  await evaluate('document.querySelector("#camp-open-inventory").click()');
  await until(() => evaluate('document.querySelector("#game-panel")?.classList.contains("empty-inventory-template")'),
    'pusty szablon ekwipunku');
  await evaluate(`(async () => {
    await document.fonts?.ready;
    const art = new Image();
    art.src = '/app/assets/inventory-empty-canonical-v0518.png';
    await art.decode();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

async function checkSize(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await evaluate('(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()');
  const view = await evaluate(`(() => {
    const panel = document.querySelector('#game-panel');
    const body = panel.querySelector('.game-panel-body');
    const layout = body.querySelector('.d2-empty-layout');
    const gold = body.querySelector('.d2-empty-gold');
    const footer = panel.querySelector('.game-panel-footer');
    const slots = [...body.querySelectorAll('.d2-empty-slot')];
    const cells = [...body.querySelectorAll('.d2-empty-cell')];
    const groups = [...body.querySelectorAll('.d2-empty-weapon-tabs')];
    const box = element => { const r = element.getBoundingClientRect(); return {
      left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height,
      center:{x:r.left+r.width/2,y:r.top+r.height/2},
    }; };
    const bounds = [layout, gold, ...slots, ...cells, ...groups].filter(Boolean).map(box);
    return {
      viewport:[innerWidth, innerHeight],
      panel:box(panel), body:box(body), layout:layout&&box(layout), gold:gold&&box(gold),
      footer:box(footer),
      bodyOverflowX:body.scrollWidth-body.clientWidth,
      bodyOverflowY:body.scrollHeight-body.clientHeight,
      pageOverflowX:document.documentElement.scrollWidth-innerWidth,
      boundsWithinViewport:bounds.every(r => r.left >= -1 && r.right <= innerWidth+1
        && r.top >= -1 && r.bottom <= innerHeight+1),
      layoutWithinBody:layout && box(layout).left >= box(body).left-2
        && box(layout).right <= box(body).right+2
        && box(layout).bottom <= box(body).bottom+2,
      slots:slots.map(node => ({
        name:node.dataset.slot, label:node.getAttribute('aria-label'), tag:node.tagName,
        disabled:node.disabled, box:box(node),
        hit:document.elementFromPoint(box(node).center.x,box(node).center.y)?.closest('.d2-empty-slot')===node,
      })),
      cells:cells.map(node => ({
        label:node.getAttribute('aria-label'), empty:node.children.length===0 && !node.textContent.trim(),
      })),
      itemCount:body.querySelectorAll('.inventory-item, .d2-grid-item, .cube-grid-item, .equipped').length,
      heroTabs:body.querySelectorAll('.owner-tabs button, #equipment-owner-tabs button').length,
      weaponTabs:groups.map(group => [...group.querySelectorAll('button')].map(node => ({
        name:node.textContent.trim(),set:node.dataset.weaponSet,pressed:node.getAttribute('aria-pressed'),
        box:box(node),
      }))),
      unwanted:body.querySelectorAll('.d2-empty-stats, .d2-empty-character, .d2-empty-backpack').length,
      unwantedText:/DOŚWIADCZENIE|POZIOM|ODPORNOŚĆ|STATYSTYKI/i.test(body.textContent),
      footerContents:footer.querySelectorAll('.d2-orb, .d2-belt, .d2-empty-belt').length,
      themed:panel.classList.contains('diablo-panel') && panel.classList.contains('empty-inventory-template'),
      frameImage:getComputedStyle(panel).backgroundImage,
    };
  })()`);
  assert(view.viewport[0] === width && view.viewport[1] === height,
    `Rozdzielczość ${width}×${height}`, view.viewport);
  assert(view.themed && view.frameImage.includes('inventory-empty-canonical-v0518.png'),
    `Jedno kamienne okno ekwipunku ${width}×${height}`,
    { themed:view.themed, image:view.frameImage });
  assert(view.slots.length === 10 && new Set(view.slots.map(slot => slot.name)).size === 10
    && view.slots.every(slot => slot.tag === 'BUTTON' && !slot.disabled
      && slot.label?.startsWith('Pusty slot:') && slot.hit),
  `Dziesięć funkcjonalnych pustych slotów ${width}×${height}`, view.slots);
  assert(view.cells.length === 40 && view.cells.every(cell => cell.empty && cell.label?.startsWith('Puste pole')),
    `Czterdzieści pustych pól plecaka ${width}×${height}`, view.cells.length);
  assert(view.weaponTabs.length === 2 && view.weaponTabs.every(pair => pair.length === 2
    && pair[0].name === 'I' && pair[1].name === 'II'
    && pair[0].pressed === 'true' && pair[1].pressed === 'false'),
  `Dwie pary przełączników broni ${width}×${height}`, view.weaponTabs);
  assert(view.itemCount === 0 && view.heroTabs === 0 && view.unwanted === 0
    && !view.unwantedText && view.footerContents === 0,
  `Bez przedmiotów, statystyk, kul, pasa i zakładek bohaterów ${width}×${height}`,
  { itemCount:view.itemCount, heroTabs:view.heroTabs, unwanted:view.unwanted,
    unwantedText:view.unwantedText, footerContents:view.footerContents });
  assert(view.boundsWithinViewport && view.layoutWithinBody
    && view.bodyOverflowX <= 2 && view.bodyOverflowY <= 2 && view.pageOverflowX <= 2,
  `Brak ucięcia po bokach i od dołu ${width}×${height}`,
  { panel:view.panel, body:view.body, layout:view.layout, gold:view.gold,
    footer:view.footer, boundsWithinViewport:view.boundsWithinViewport,
    layoutWithinBody:view.layoutWithinBody,
    bodyOverflowX:view.bodyOverflowX, bodyOverflowY:view.bodyOverflowY,
    pageOverflowX:view.pageOverflowX });
  const shot = await screenshot(width, height);
  for (const slot of view.slots) {
    await mouse(slot.box.center.x, slot.box.center.y);
    const focused = await evaluate(`document.activeElement?.dataset.slot === ${JSON.stringify(slot.name)}`);
    assert(focused, `Klikalny slot ${slot.name} ${width}×${height}`);
  }
  for (let index = 0; index < view.weaponTabs.length; index += 1) {
    const [, second] = view.weaponTabs[index];
    await mouse(second.box.center.x, second.box.center.y);
    const switched = await evaluate(`(() => {
      const pair=document.querySelectorAll('.d2-empty-weapon-tabs')[${index}];
      const [first,second]=pair.querySelectorAll('button');
      return first.getAttribute('aria-pressed')==='false' && second.getAttribute('aria-pressed')==='true';
    })()`);
    assert(switched, `Przełączenie pary broni ${index+1} ${width}×${height}`);
    const first = view.weaponTabs[index][0];
    await mouse(first.box.center.x, first.box.center.y);
  }
  return { ...view, screenshot:shot };
}

async function run() {
  await mkdir(OUT, { recursive: true });
  await prepareApp();
  const views = [];
  for (const [width, height] of SIZES) views.push(await checkSize(width, height));
  const close = await evaluate(`(() => { const r=document.querySelector('#close-panel').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await mouse(close.x, close.y);
  await until(() => evaluate('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"'),
    'zamknięcie inventory');
  assert(true, 'Przycisk zamknięcia działa');
  assert(errors.length === 0, 'Brak wyjątków i błędów JavaScript', errors);
  const file = path.join(OUT, 'empty-inventory-acceptance.json');
  await writeFile(file, JSON.stringify({ url:new URL('/?inventory-template=1', APP_URL).href,
    checks, views, errors }, null, 2));
  console.log(`PASS pusty inventory: ${checks.length} kontroli; dowody: ${file}`);
}

try { await run(); }
finally { socket?.close(); if (browser) await cleanupTrackedBrowser(browser); }
