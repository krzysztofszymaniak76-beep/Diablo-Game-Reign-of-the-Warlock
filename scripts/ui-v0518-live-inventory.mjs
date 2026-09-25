import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/live-inventory-v0518');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, label, detail) => {
  if (!value) throw new Error(`${label}: ${JSON.stringify(detail)}`);
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true, userGesture:true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
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
async function capture(name) {
  const response = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false, fromSurface:true });
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(response.data, 'base64'));
  console.log(`EVIDENCE ${file}`);
}
async function size(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
  await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()');
}

async function run() {
  await mkdir(OUT, { recursive:true });
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), { signal:AbortSignal.timeout(5000) })).json();
  assert(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(), 'Serwer wskazuje bieżący projekt');
  browser = await launchTrackedBrowser({ appUrl:'about:blank', windowSize:'1920,1080', stdio:['ignore','ignore','pipe'] });
  socket = new WebSocket(browser.target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); });
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
  await size(1920, 1080);
  await send('Page.navigate', { url:APP_URL });
  await until(() => evaluate('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'Start gry');
  await until(() => evaluate('document.querySelector("#team-selection-layer")?.getAttribute("aria-hidden") === "false"'), 'Wybór drużyny');
  await evaluate(`(() => {
    for (const card of [...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]) card.click();
    for (const id of ['korgan','mael','veyran']) document.querySelector('#team-selection-grid [data-hero-id="'+id+'"]').click();
    document.querySelector('#team-selection-confirm').click();
  })()`);
  await until(() => evaluate('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"'), 'Obóz');
  await evaluate('document.querySelector("#camp-open-inventory").click()');
  await until(() => evaluate('document.querySelector("#game-panel")?.classList.contains("empty-inventory-template") && Boolean(document.querySelector(".d2-live-inventory"))'), 'Kanoniczny ekwipunek');
  await evaluate(`(async () => {
    const frame = new Image(); frame.src='/app/assets/inventory-empty-canonical-v0518.png'; await frame.decode();
    await Promise.all([...document.querySelectorAll('.d2-live-item-art img')].map(img => img.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);

  const gameState = (await evaluate('window.__rotwDebug.snapshot()')).save;
  for (const [index, heroId] of ['korgan','mael','veyran'].entries()) {
    const hero = gameState.roster.find(entry => entry.id === heroId);
    assert(Boolean(hero), `Postać ${heroId} w drużynie`);
    await evaluate(`(() => [...document.querySelectorAll('#equipment-owner-tabs button')].find(node => node.textContent.trim() === ${JSON.stringify(hero.name)})?.click())()`);
    await evaluate(`(async () => {
      await Promise.all([...document.querySelectorAll('.d2-live-item-art img')].map(image => image.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(resolve));
    })()`);
    const inventory = gameState.inventories.find(([id]) => id === heroId)?.[1];
    const ui = await evaluate(`(() => {
      const panel=document.querySelector('#game-panel');
      const body=panel.querySelector('.d2-live-inventory');
      const r=panel.getBoundingClientRect();
      return {
        title:document.querySelector('#panel-title')?.textContent,
        owner:body.querySelector('.d2-empty-layout')?.getAttribute('aria-label'),
        slots:[...body.querySelectorAll('.d2-empty-slot')].map(node=>({slot:node.dataset.slot,itemId:node.dataset.itemId??null})),
        itemIds:[...body.querySelectorAll('#inventory-grid .inventory-item')].map(node=>node.dataset.itemId),
        itemLabels:[...body.querySelectorAll('#inventory-grid .inventory-item')].map(node=>({
          id:node.dataset.itemId, aria:node.getAttribute('aria-label'), tooltip:Boolean(node.dataset.itemTooltip),
          visualNameHidden:getComputedStyle(node.querySelector('.d2-live-item-name')).display === 'none',
        })),
        artworkCount:body.querySelectorAll('#inventory-grid .inventory-item .d2-trade-item-art').length,
        missingArtwork:[...body.querySelectorAll('#inventory-grid .inventory-item img')].filter(img=>!img.complete||!img.naturalWidth).length,
        cells:body.querySelectorAll('#inventory-grid .inventory-cell').length,
        tabs:[...body.querySelectorAll('#equipment-owner-tabs button')].map(node=>({name:node.textContent.trim(),active:node.classList.contains('active')})),
        frame:getComputedStyle(panel).backgroundImage,
        viewport:{width:innerWidth,height:innerHeight},
        pageOverflow:document.documentElement.scrollWidth-innerWidth,
        panelRect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},
        gridBottom:body.querySelector('#inventory-grid').getBoundingClientRect().bottom,
        goldTop:body.querySelector('.d2-empty-gold').getBoundingClientRect().top,
        goldBottom:body.querySelector('.d2-empty-gold').getBoundingClientRect().bottom,
        ownerTabsTop:body.querySelector('#equipment-owner-tabs').getBoundingClientRect().top,
      };
    })()`);
    assert(ui.title === 'EKWIPUNEK' && ui.owner.includes(hero.name) && ui.frame.includes('inventory-empty-canonical-v0518.png'), `Wspólny wzór: ${hero.name}`, ui);
    assert(ui.slots.length === 10 && ui.slots.filter(slot => slot.itemId).length === Object.keys(hero.equipment).length, `Wyposażenie ${hero.name}`, ui.slots);
    assert(ui.cells === 40 && inventory.items.every(item => ui.itemIds.includes(item.id)), `Plecak ${hero.name}`, ui);
    assert(inventory.items.every(item => {
      const label = ui.itemLabels.find(entry => entry.id === item.id);
      return label?.visualNameHidden && label.aria === item.name && label.tooltip;
    }), `Grafiki bez uciętych podpisów, pełne nazwy dostępne: ${hero.name}`, ui.itemLabels);
    assert(ui.artworkCount >= inventory.items.filter(item => item.canonicalId !== 'minor_healing_potion').length
      && ui.missingArtwork === 0, `Grafiki przedmiotów ${hero.name}`, ui);
    assert(ui.tabs.filter(tab => tab.active).length === 1 && ui.tabs.find(tab => tab.active)?.name === hero.name, `Przełączona postać: ${hero.name}`, ui.tabs);
    assert(ui.pageOverflow <= 2 && ui.panelRect.left >= 0 && ui.panelRect.top >= 0 && ui.panelRect.right <= ui.viewport.width + 1 && ui.panelRect.bottom <= ui.viewport.height + 1, `Bez ucięcia ${hero.name}`, ui);
    assert(ui.gridBottom <= ui.goldTop + 2 && ui.goldBottom <= ui.ownerTabsTop + 2,
      `Plecak, złoto i zakładki nie zachodzą na siebie: ${hero.name}`, ui);
    if (index === 0) {
      await capture('inventory-korgan-1920x1080.png');
      const itemId = inventory.items[0].id;
      await evaluate(`document.querySelector('#inventory-grid .inventory-item[data-item-id="${itemId}"]').click()`);
      assert(await evaluate('Boolean(document.querySelector("#item-details:not([hidden])"))'), 'Opis przedmiotu działa');
      assert(await evaluate(`document.querySelector('#item-details .item-detail-name')?.textContent === ${JSON.stringify(inventory.items[0].name)}`),
        'Pełna nazwa przedmiotu jest widoczna w opisie po wyborze');
      await evaluate('document.querySelector(".d2-live-detail-close").click()');
      assert(await evaluate('Boolean(document.querySelector("#item-details[hidden]"))'), 'Opis można zamknąć');
    }
    if (index === 1) {
      await size(1280, 720);
      await capture('inventory-mael-1280x720.png');
      await size(1920, 1080);
    }
  }
  assert(errors.length === 0, 'Brak błędów JavaScript', errors);
}

try { await run(); }
finally { socket?.close(); if (browser) await cleanupTrackedBrowser(browser); }
