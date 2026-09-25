// Headless 1920x1080 evidence for the three live camp merchants.
// Uses a disposable browser profile and never changes the player's audio setting.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUTPUT = path.resolve('docs/evidence/trade-vendors');
const WIDTH = 1920;
const HEIGHT = 1080;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const errors = [];
let browser;
let socket;
let sequence = 0;
installGlobalCleanupHandlers();

function check(condition, description, details) {
  if (!condition) throw new Error(`${description}: ${JSON.stringify(details)}`);
  console.log(`PASS ${description}`);
}

function send(method, params = {}) {
  const id = ++sequence;
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return reply;
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

async function until(expression, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await wait(80);
  }
  throw new Error(`Timeout: ${description}`);
}

async function settleImages() {
  await evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.race([
      Promise.all([...document.images].map(image => image.decode().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 2500)),
    ]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

async function openMerchant(id) {
  await evaluate(`document.querySelector('[data-camp-action=${JSON.stringify(id)}]').click()`);
  if (id === 'akara') {
    await until('Boolean(document.querySelector(".d2-dialogue-sheet"))', 'Rozmowa z Akarą');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.d2-dialogue-sheet button')]
        .find(candidate => candidate.textContent.includes('HANDEL Z AKARĄ'));
      if (!button) throw new Error('Nie ma przycisku handlu z Akarą');
      button.click();
    })()`);
  }
  await until(`Boolean(document.querySelector('#panel-layer.trade-pair #merchant-panel.merchant-inventory-frame'))
    && Boolean(document.querySelector('#game-panel.empty-inventory-template #panel-body.d2-live-inventory'))
    && document.querySelector('#merchant-panel')?.textContent.includes(${JSON.stringify(id === 'charsi' ? 'Charsi' : id === 'gheed' ? 'Gheed' : 'Akara')})`,
  `Prawdziwy handel: ${id}`);
  await settleImages();
}

async function inspectMerchant(id) {
  const state = await evaluate(`(() => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    };
    const merchant = document.querySelector('#merchant-panel');
    const player = document.querySelector('#game-panel');
    const grid = merchant.querySelector('.merchant-goods-grid');
    const actions = merchant.querySelector('.merchant-action-bar');
    const offers = [...merchant.querySelectorAll('[data-offer-id], .d2-trade-buy, [data-canonical-id]')]
      .filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    const inventory = player.querySelector('#panel-body.d2-live-inventory');
    return {
      viewport:[innerWidth, innerHeight],
      merchant:rect(merchant), player:rect(player),
      goodsGrid:grid && rect(grid), actions:actions && rect(actions),
      repair:merchant.querySelector('#charsi-repair') && rect(merchant.querySelector('#charsi-repair')),
      offers:offers.length,
      offerIds:offers.map(node => node.dataset.offerId ?? node.dataset.canonicalId ?? node.title),
      merchantGridOverlay:(() => { const style=getComputedStyle(grid, '::after'); return {
        content:style.content, zIndex:Number(style.zIndex), backgroundImage:style.backgroundImage,
      }; })(),
      categoryTabs:merchant.querySelectorAll('.d2-shop-categories, [data-trade-category]').length,
      backpackCells:inventory.querySelectorAll('#inventory-grid .inventory-cell').length,
      equipmentSlots:inventory.querySelectorAll('#equipment-slots .d2-empty-slot').length,
      backpackGridOverlay:(() => { const node=inventory.querySelector('#inventory-grid'); const style=getComputedStyle(node, '::after'); return {
        content:style.content, zIndex:Number(style.zIndex), backgroundImage:style.backgroundImage,
      }; })(),
      playerBackground:getComputedStyle(player).backgroundImage,
      damagedImages:[...merchant.querySelectorAll('img'), ...player.querySelectorAll('img')]
        .filter(image => !image.complete || !image.naturalWidth).map(image => image.src),
      pageOverflow:document.documentElement.scrollWidth-innerWidth,
      music:localStorage.getItem('rotw.music.volume.v1'),
    };
  })()`);
  check(state.viewport[0] === WIDTH && state.viewport[1] === HEIGHT,
    `${id}: kadr 1920×1080`, state.viewport);
  check(state.merchant.x >= -1 && state.merchant.y >= -1
    && state.merchant.right < state.player.x && state.player.right <= WIDTH + 1
    && state.merchant.bottom <= HEIGHT + 1 && state.player.bottom <= HEIGHT + 1,
  `${id}: dwa pełne panele`, state);
  check(state.goodsGrid && state.actions
    && state.goodsGrid.y >= state.merchant.y
    && state.goodsGrid.bottom <= state.actions.y + 1
    && state.actions.bottom <= state.merchant.bottom + 1
    && state.actions.bottom <= HEIGHT + 1,
  `${id}: cała siatka oraz pasek usług mieszczą się w kadrze`, state);
  check(state.offers > 1 && state.categoryTabs === 0,
    `${id}: towary w jednym oknie bez kategorii`, state);
  check(state.merchantGridOverlay.content !== 'none' && state.merchantGridOverlay.zIndex > 0
    && state.merchantGridOverlay.backgroundImage.includes('repeating-linear-gradient')
    && state.backpackGridOverlay.content !== 'none' && state.backpackGridOverlay.zIndex > 0
    && state.backpackGridOverlay.backgroundImage.includes('repeating-linear-gradient'),
  `${id}: linie siatki są warstwą nad grafikami przedmiotów`,
  { merchant:state.merchantGridOverlay, backpack:state.backpackGridOverlay });
  if (id === 'charsi') {
    check(state.repair && state.repair.width > 0 && state.repair.height > 0
      && state.repair.bottom <= state.actions.bottom + 1,
    'charsi: młotek naprawy jest widoczny', state.repair);
  }
  check(state.backpackCells === 40 && state.equipmentSlots === 10
    && state.playerBackground.includes('inventory-empty-canonical-v0518.png'),
  `${id}: zaakceptowany ekwipunek gracza`, state);
  check(state.pageOverflow <= 2 && state.damagedImages.length === 0,
    `${id}: bez ucięcia strony i uszkodzonych ikon`, state);
  check(state.music === '0.05', `${id}: 5% tylko w profilu testowym`, state.music);
  console.log(`INFO ${id}: ${state.offers} rzeczywistych ofert`);
  return state;
}

async function screenshot(id) {
  const capture = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const file = path.join(OUTPUT, `trade-${id}-1920x1080.png`);
  await writeFile(file, Buffer.from(capture.data, 'base64'));
  console.log(`SCREENSHOT ${file}`);
}

async function main() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5000),
  })).json();
  check(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer wskazuje bieżący projekt', health);
  await mkdir(OUTPUT, { recursive: true });
  browser = await launchTrackedBrowser({
    appUrl: 'about:blank', windowSize: `${WIDTH},${HEIGHT}`, stdio: ['ignore', 'ignore', 'pipe'],
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
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled'
      && ['error', 'assert'].includes(message.params.type)) {
      errors.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('rotw.music.volume.v1', '0.05'); } catch {}",
  });
  await send('Page.navigate', { url: APP_URL });
  await until('Boolean(window.__rotwDebug?.snapshot) && !document.querySelector("#main-menu").hidden',
    'Menu startowe');
  await evaluate('document.querySelector("#menu-new-game").click()');
  await until('document.querySelector("#character-creation")?.getAttribute("aria-hidden") === "false"',
    'Wybór postaci');
  await evaluate(`(() => {
    document.querySelector('.character-creation-class[data-hero-id="korgan"]').click();
    document.querySelector('#character-creation-confirm').click();
  })()`);
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"',
    'Obozowisko Łotrzyc po nowej grze');

  for (const id of ['charsi', 'akara', 'gheed']) {
    await openMerchant(id);
    await inspectMerchant(id);
    await screenshot(id);
    await evaluate('document.querySelector("#close-panel").click()');
    await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"',
      `Zamknięcie handlu ${id}`);
  }
  check(errors.length === 0, 'Brak błędów JavaScript', errors);
}

try { await main(); }
finally {
  socket?.close();
  if (browser) {
    const result = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP own browser: ${result.remaining?.length ?? 0} remaining processes`);
  }
}
