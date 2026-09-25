// Headless acceptance for the empty merchant frame paired with the approved
// live inventory. This test uses its own disposable browser profile.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/trade-empty-v0518');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const errors = [];
let browser;
let socket;
let sequence = 0;
installGlobalCleanupHandlers();

function assert(condition, label, detail) {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${label}`);
}

function send(method, params = {}) {
  const id = ++sequence;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}${params.expression ? `: ${params.expression.slice(0, 120)}` : ''}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function until(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await wait(80);
  }
  throw new Error(`Timeout: ${label}`);
}

const layoutExpression = `(() => {
  const panel = document.querySelector('#game-panel');
  const body = panel?.querySelector('#panel-body.d2-live-inventory');
  if (!panel || !body) return null;
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
  };
  const frame = rect(panel);
  const relative = node => {
    const r = rect(node);
    return { left:r.left-frame.left, top:r.top-frame.top, width:r.width, height:r.height };
  };
  return {
    frame,
    grid:relative(body.querySelector('#inventory-grid')),
    gold:relative(body.querySelector('.d2-empty-gold')),
    head:relative(body.querySelector('.d2-empty-slot[data-slot=head]')),
    weapon:relative(body.querySelector('.d2-empty-slot[data-slot=weapon]')),
    cells:body.querySelectorAll('#inventory-grid .inventory-cell').length,
    slots:body.querySelectorAll('#equipment-slots .d2-empty-slot').length,
    itemIds:[...body.querySelectorAll('#inventory-grid .inventory-item')].map(node => node.dataset.itemId).sort(),
    background:getComputedStyle(panel).backgroundImage,
  };
})()`;

function sameRect(a, b, tolerance = 2) {
  return ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= tolerance);
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
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: APP_URL });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'),
    'Start gry');
  await until(() => evaluate('document.querySelector("#team-selection-layer")?.getAttribute("aria-hidden") === "false"'),
    'Wybór drużyny');
  await evaluate(`(() => {
    for (const card of [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]) card.click();
    for (const id of ['korgan', 'mael', 'veyran']) {
      document.querySelector('#team-selection-grid [data-hero-id="' + id + '"]').click();
    }
    document.querySelector('#team-selection-confirm').click();
  })()`);
  await until(() => evaluate('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"'),
    'Obozowisko Łotrzyc');
  const before = await evaluate('JSON.stringify(window.__rotwDebug.snapshot().save)');

  await evaluate('document.querySelector("#camp-open-inventory").click()');
  await until(() => evaluate('Boolean(document.querySelector("#game-panel.empty-inventory-template #panel-body.d2-live-inventory"))'),
    'Zatwierdzony ekwipunek gracza');
  await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()');
  const inventoryLayout = await evaluate(layoutExpression);
  assert(inventoryLayout?.cells === 40 && inventoryLayout.slots === 10
    && inventoryLayout.background.includes('inventory-empty-canonical-v0518.png'),
  'Punkt odniesienia: kanoniczny ekwipunek', inventoryLayout);
  assert(inventoryLayout.itemIds.length > 0, 'Punkt odniesienia zawiera istniejące przedmioty gracza', inventoryLayout.itemIds);
  await evaluate('document.querySelector("#close-panel").click()');

  await evaluate('document.querySelector("[data-camp-action=charsi]").click()');
  await until(() => evaluate(`Boolean(document.querySelector('#panel-layer.trade-pair #merchant-panel.merchant-inventory-frame'))
    && Boolean(document.querySelector('#game-panel.empty-inventory-template #panel-body.d2-live-inventory'))`),
  'Dwie strony okna handlu Charsi');
  await evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.race([
      Promise.all([...document.querySelectorAll('#game-panel img, #merchant-panel img')]
        .map(image => image.decode().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 2500)),
    ]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const trade = await evaluate(`(() => {
    const merchant = document.querySelector('#merchant-panel');
    const grid = merchant.querySelector('.merchant-empty-grid');
    const player = document.querySelector('#game-panel');
    const left = merchant.getBoundingClientRect();
    const right = player.getBoundingClientRect();
    const cells = [...grid.querySelectorAll('button')];
    return {
      merchant:{left:left.left,top:left.top,right:left.right,bottom:left.bottom,width:left.width,height:left.height},
      player:{left:right.left,top:right.top,right:right.right,bottom:right.bottom,width:right.width,height:right.height},
      merchantCells:cells.length,
      visibleCells:cells.filter(cell => {
        const r = cell.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(cell).visibility === 'visible';
      }).length,
      merchantItems:merchant.querySelectorAll('[data-item-id], .inventory-item, .d2-trade-item').length,
      merchantImages:merchant.querySelectorAll('img').length,
      playerCells:player.querySelectorAll('#inventory-grid .inventory-cell').length,
      viewport:{width:innerWidth,height:innerHeight},
      pageOverflow:document.documentElement.scrollWidth-innerWidth,
    };
  })()`);
  const tradeLayout = await evaluate(layoutExpression);
  assert(trade.merchantCells === 80 && trade.visibleCells === 80,
    'Po lewej 80 rzeczywistych, widocznych pustych pól', trade);
  assert(trade.merchantItems === 0 && trade.merchantImages === 0,
    'Panel Charsi bez towarów, przedmiotów próbnych i ikon', trade);
  assert(trade.merchant.right < trade.player.left && trade.merchant.top >= 0
    && trade.player.top >= 0 && trade.merchant.bottom <= 1081 && trade.player.bottom <= 1081,
  'Handlarz po lewej, zatwierdzony ekwipunek po prawej; oba mieszczą się w 1920×1080', trade);
  assert(tradeLayout.cells === 40 && tradeLayout.slots === 10
    && tradeLayout.background.includes('inventory-empty-canonical-v0518.png'),
  'Prawy panel jest rzeczywistym ekwipunkiem, a nie uproszczoną kopią', tradeLayout);
  assert(JSON.stringify(tradeLayout.itemIds) === JSON.stringify(inventoryLayout.itemIds),
    'Prawa strona pokazuje dokładnie te same istniejące rzeczy gracza',
    { normal:inventoryLayout.itemIds, trade:tradeLayout.itemIds });
  assert(Math.abs(tradeLayout.frame.width - inventoryLayout.frame.width) <= 2
    && Math.abs(tradeLayout.frame.height - inventoryLayout.frame.height) <= 2
    && ['grid', 'gold', 'head', 'weapon'].every(part => sameRect(tradeLayout[part], inventoryLayout[part])),
  'Proporcje oraz położenia pól prawej strony są takie same jak w zwykłym ekwipunku',
  { normal:inventoryLayout, trade:tradeLayout });
  assert(trade.pageOverflow <= 2, 'Brak poziomego przewijania strony', trade.pageOverflow);
  assert(before === await evaluate('JSON.stringify(window.__rotwDebug.snapshot().save)'),
    'Otwarcie pustego handlu nie zmienia gry ani przedmiotów');

  await evaluate('document.querySelector(".merchant-empty-grid button").focus()');
  assert(await evaluate('document.activeElement?.matches(".merchant-empty-grid button")'),
    'Puste pole handlarza jest dostępnym elementem interfejsu');
  await evaluate('document.querySelector("#close-panel").focus()');
  const image = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  const filename = path.join(OUT, 'trade-empty-charsi-1920x1080.png');
  await writeFile(filename, Buffer.from(image.data, 'base64'));
  console.log(`EVIDENCE ${filename}`);
  assert(await evaluate('Boolean(document.querySelector("#merchant-panel .merchant-inventory-close"))'),
    'Lewy czerwony X ma rzeczywisty przycisk zamknięcia');
  await evaluate('document.querySelector("#merchant-panel .merchant-inventory-close").click()');
  await until(() => evaluate('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"'),
    'Zamknięcie handlu lewym X');
  for (const vendor of ['gheed', 'akara']) {
    await evaluate(`document.querySelector('[data-camp-action=${vendor}]').click()`);
    if (vendor === 'akara') {
      await until(() => evaluate('Boolean(document.querySelector(".d2-dialogue-sheet"))'), 'Rozmowa z Akarą');
      await evaluate(`([...document.querySelectorAll('.d2-dialogue-sheet button')]
        .find(button => button.textContent.includes('HANDEL Z AKARĄ'))).click()`);
    }
    await until(() => evaluate(`Boolean(document.querySelector('#panel-layer.trade-pair #merchant-panel'))
      && document.querySelector('#merchant-panel')?.textContent.includes(${JSON.stringify(vendor === 'gheed' ? 'Gheed' : 'Akara')})`),
    `Pusty handel: ${vendor}`);
    const state = await evaluate(`(() => ({
      emptyCells:document.querySelectorAll('#merchant-panel .merchant-empty-grid button').length,
      merchantItems:document.querySelectorAll('#merchant-panel [data-item-id], #merchant-panel .inventory-item').length,
      playerCells:document.querySelectorAll('#game-panel #inventory-grid .inventory-cell').length,
      playerItems:[...document.querySelectorAll('#game-panel #inventory-grid .inventory-item')]
        .map(node => node.dataset.itemId).sort(),
    }))()`);
    assert(state.emptyCells === 80 && state.merchantItems === 0
      && state.playerCells === 40
      && JSON.stringify(state.playerItems) === JSON.stringify(inventoryLayout.itemIds),
    `Puste pola handlarza i niezmieniony ekwipunek gracza: ${vendor}`, state);
    await evaluate('document.querySelector("#close-panel").click()');
  }
  assert(errors.length === 0, 'Brak błędów JavaScript', errors);
}

try { await run(); }
finally {
  socket?.close();
  if (browser) {
    const cleanup = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP own browser: ${cleanup.remaining?.length ?? 0} remaining processes`);
  }
}
