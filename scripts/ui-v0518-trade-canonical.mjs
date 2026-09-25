// Headless visual/interaction acceptance for the in-game merchant windows.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUT = path.resolve('docs/evidence/trade-canonical-v0518');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const failures = [];
let browser;
let socket;
let sequence = 0;
installGlobalCleanupHandlers();

function send(method, params = {}) {
  const id = ++sequence;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function until(expression, label) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (await evaluate(expression).catch(() => false)) return;
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}

function check(value, label) {
  if (!value) throw new Error(label);
  console.log(`PASS ${label}`);
}

async function screenshot(name, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('(async () => { await Promise.race([Promise.all([...document.images].map(image => image.decode().catch(() => {}))), new Promise(resolve => setTimeout(resolve, 2500))]); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
  const layout = await evaluate(`(() => { const r = x => x.getBoundingClientRect(); const p = document.querySelector('#game-panel'); const m=document.querySelector('#merchant-panel'); const offers=[...document.querySelectorAll('#merchant-panel .merchant-offer')]; return { viewport:[innerWidth,innerHeight], panel:p&&[r(p).left,r(p).top,r(p).right,r(p).bottom], merchant:m&&[r(m).left,r(m).top,r(m).right,r(m).bottom], offers:offers.length, pageOverflow:document.documentElement.scrollWidth-innerWidth, broken:[...document.querySelectorAll('#merchant-panel img, #game-panel img')].filter(x => !x.complete || !x.naturalWidth).map(x => x.src) }; })()`);
  const bounds = [layout.panel,layout.merchant].filter(Boolean);
  check(bounds.length >= 1 && bounds.every(rect => rect[0] >= -1 && rect[1] >= -1 && rect[2] <= width + 1 && rect[3] <= height + 1), `${name}: okno w kadrze ${width}×${height}`);
  if (!name.includes('inventory')) check(bounds.length === 2, `${name}: lewy handel i prawe inventory są obecne`);
  check(layout.pageOverflow <= 2 && layout.broken.length === 0, `${name}: brak przewijania poziomego i brak uszkodzonych ikon`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const filename = path.join(OUT, `${name}-${width}x${height}.png`);
  await writeFile(filename, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${filename}`);
}

async function hoverItem(selector) {
  const point = await evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) return null; const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,withinViewport:r.left+r.width/2>=0&&r.left+r.width/2<innerWidth&&r.top+r.height/2>=0&&r.top+r.height/2<innerHeight}; })()`);
  check(point?.withinViewport, `Cel hover ${selector}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await until('Boolean(document.querySelector("#rotw-item-tooltip.is-visible"))', `tooltip ${selector}`);
  return point;
}

async function tooltipScreenshot(name, width, height, selector) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const point = await hoverItem(selector);
  const content = await evaluate('document.querySelector("#rotw-item-tooltip")?.innerText ?? ""');
  check(content.includes('Obrażenia:') || content.includes('Obrażenia przy rzucie:'), `${name}: obrażenia z danych bazy`);
  check(content.includes('Wymagania:') && content.includes('Trwałość:'), `${name}: wymagania i trwałość w tooltipie`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const filename = path.join(OUT, `${name}-${width}x${height}.png`);
  await writeFile(filename, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${filename}; hover=${Math.round(point.x)},${Math.round(point.y)}`);
}

async function qualityPreviewScreenshot(quality, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const point = await evaluate(`(async () => {
    const original = window.__rotwDebug.snapshot().save.inventories.flatMap(([,bag])=>bag.items)[0];
    const definition = (await (await fetch('/data/equipment.v051.json')).json()).bases.find(base=>base.id===original?.canonicalId);
    if (!original || !definition) throw new Error('Brak rzeczywistej bazy do podglądu jakości');
    const { attachItemTooltip } = await import('/app/item-tooltip-v0518.js');
    const trigger=document.createElement('button');
    trigger.type='button'; trigger.setAttribute('aria-label','Diagnostyczny podgląd koloru jakości');
    trigger.style.cssText='position:fixed;left:12px;top:12px;z-index:99999;opacity:.01;width:24px;height:24px';
    document.body.append(trigger);
    attachItemTooltip(trigger,{item:{...original,quality:${JSON.stringify(quality)}},definition});
    const r=trigger.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`);
  check(point && point.x >= 0 && point.y >= 0, `${quality}: cel diagnostyczny`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await until(`document.querySelector('#rotw-item-tooltip')?.classList.contains('quality-${quality}')`, `${quality} tooltip`);
  const style = await evaluate(`(() => { const node=document.querySelector('#rotw-item-tooltip'); return {className:node.className,color:getComputedStyle(node.querySelector('.rotw-item-tooltip-name')).color,text:node.innerText}; })()`);
  check(style.className.includes(`quality-${quality}`) && style.text.length > 0, `${quality}: nazwa otrzymuje właściwą klasę koloru jakości`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const filename = path.join(OUT, `quality-preview-${quality}-${width}x${height}.png`);
  await writeFile(filename, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${filename}; kolor=${style.color}; to tylko diagnostyczny podgląd stylu, nie przedmiot z właściwościami jakości`);
  await evaluate(`(() => { document.querySelector('[aria-label="Diagnostyczny podgląd koloru jakości"]')?.remove(); const tip=document.querySelector('#rotw-item-tooltip'); if(tip){tip.hidden=true;tip.className='rotw-item-tooltip';} return true; })()`);
}

try {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), { signal: AbortSignal.timeout(5000) })).json();
  check(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(), 'Serwer udostępnia projekt D2');
  await mkdir(OUT, { recursive: true });
  browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '1920,1080', stdio: ['ignore','ignore','pipe'] });
  socket = new WebSocket(browser.target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(typeof data === 'string' ? data : await data.text());
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      failures.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error','assert'].includes(message.params.type)) {
      failures.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const address = new URL(APP_URL);
  address.searchParams.set('skip-team-selection', '1');
  await send('Page.navigate', { url: address.href });
  await until('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"', 'start gry');
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"', 'obóz');
  const byMerchant = {};
  for (const id of ['charsi', 'gheed']) {
    await evaluate(`document.querySelector('[data-camp-action="${id}"]').click()`);
    if (id === 'akara') {
      await until('Boolean(document.querySelector(".d2-dialogue-sheet"))', 'rozmowa z Akarą');
      await evaluate('([...document.querySelectorAll(".d2-dialogue-sheet button")].find(button=>button.textContent.includes("HANDEL Z AKARĄ"))).click()');
    }
    await until('Boolean(document.querySelector("#merchant-panel[aria-label]")) && Boolean(document.querySelector("#game-panel #panel-body.d2-live-inventory"))', `okno ${id}`);
    await evaluate('(async () => { await Promise.race([Promise.all([...document.querySelectorAll("#merchant-panel img,#game-panel img")].map(image=>image.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,2500))]); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return true; })()');
    const state = await evaluate(`(() => ({ offers:[...document.querySelectorAll('#merchant-panel .merchant-offer')].map(x=>x.dataset.canonicalId), art:[...document.querySelectorAll('#merchant-panel .merchant-offer')].every(x=>x.querySelector('img')), bagCells:document.querySelectorAll('#game-panel #inventory-grid .inventory-cell').length, inventoryItems:document.querySelectorAll('#game-panel #inventory-grid .inventory-item').length, equipped:[...document.querySelectorAll('#game-panel #equipment-slots .d2-empty-slot')].map(x=>({slot:x.dataset.slot,id:x.dataset.itemId??null})), owner:window.__rotwDebug.equipment().equipment }))()`);
    console.log(`INFO ${id} offers: ${JSON.stringify(state.offers)}`);
    check(state.offers.length >= 2 && state.bagCells === 40, `${id}: oferta handlarza oraz rzeczywisty ekwipunek gracza`);
    if (id === 'charsi') {
      const expected = ['hand_axe','great_axe','short_sword','two_handed_sword','great_sword','dagger','war_hammer','flail','spear','war_staff','wand','hunters_bow','light_crossbow','throwing_axe','katar'];
      check(state.offers.length === 15 && JSON.stringify([...state.offers].sort()) === JSON.stringify([...expected].sort()), 'Charsi pokazuje dokładnie 15 różnych baz z partii kontrolnej');
      const imageState = await evaluate('[...document.querySelectorAll("#merchant-panel .merchant-offer img")].map(x=>({src:x.src,complete:x.complete,width:x.naturalWidth}))');
      check(imageState.length === 15 && imageState.every(x=>x.complete && x.width>0), `Każda broń w ofercie ma załadowany oryginalny sprite PNG: ${JSON.stringify(imageState.filter(x=>!x.width))}`);
    }
    check(state.equipped.length >= 7, `${id}: sloty wyposażenia zachowane w prawdziwym panelu gracza`);
    byMerchant[id] = state.offers;
    await screenshot(id, 1920, 1080);
    await screenshot(id, 1280, 720);
    if (id === 'charsi') {
      await tooltipScreenshot('charsi-tooltip-normal', 1920, 1080, '#merchant-panel .merchant-offer:not(:disabled)');
      await tooltipScreenshot('charsi-tooltip-normal', 1280, 720, '#merchant-panel .merchant-offer:not(:disabled)');
    }
    await evaluate('document.querySelector("#close-panel").click()');
  }
  check(JSON.stringify(byMerchant.charsi) !== JSON.stringify(byMerchant.gheed), 'Charsi i Gheed mają różne pule');
  await evaluate('document.querySelector("[data-camp-action=charsi]").click()');
  await until('Boolean(document.querySelector("#merchant-panel[aria-label]"))', 'ponowne okno Charsi');
  const before = await evaluate('({ gold:window.__rotwDebug.snapshot().save.campServices.gold, offers:[...document.querySelectorAll("#merchant-panel .merchant-offer")].map(x=>x.dataset.canonicalId) })');
  check(JSON.stringify(before.offers) === JSON.stringify(byMerchant.charsi), 'Ponowne otwarcie sklepu nie rotuje ofert');
  await tooltipScreenshot('charsi-tooltip-normal',1920,1080,'#merchant-panel .merchant-offer:not(:disabled)');
  const bought = await evaluate('(() => { const item=document.querySelector("#merchant-panel .merchant-offer:not(:disabled)"); if (!item) return false; item.click(); return true; })()');
  check(bought, 'Można kupić dostępny towar');
  check(await evaluate('window.__rotwDebug.snapshot().save.campServices.gold < ' + before.gold), 'Zakup pobiera złoto');
  check(await evaluate('document.querySelectorAll("#inventory-grid .inventory-item").length > 0'), 'Ekwipunek ma widoczne przedmioty po zakupie');
  const ownership = await evaluate('(() => { const save=window.__rotwDebug.snapshot().save; return { gold:save.campServices.gold, owned:save.inventories.flatMap(([,bag])=>bag.items.map(item=>item.id)), offers:save.campServices.vendors.flatMap(vendor=>vendor.offers.map(offer=>offer.item.id)) }; })()');
  check(await evaluate('window.__rotwDebug.saveGameState()'), 'Zapis po zakupie działa');
  check(await evaluate('window.__rotwDebug.loadGameState()'), 'Wczytanie zapisanej gry działa');
  const relog = await evaluate('(() => { const save=window.__rotwDebug.snapshot().save; return { gold:save.campServices.gold, owned:save.inventories.flatMap(([,bag])=>bag.items.map(item=>item.id)), offers:save.campServices.vendors.flatMap(vendor=>vendor.offers.map(offer=>offer.item.id)) }; })()');
  check(relog.gold === ownership.gold && JSON.stringify(relog.owned) === JSON.stringify(ownership.owned), 'Ponowne wejście nie zmienia złota ani posiadanych przedmiotów');
  check(relog.offers.every(id => !ownership.offers.includes(id)), 'Ponowne wejście zmienia egzemplarze ofert bez kolizji ID');
  await evaluate('document.querySelector("#close-panel").click(); document.querySelector("[data-camp-action=akara]").click()');
  await until('document.querySelector(".d2-dialogue-sheet") !== null', 'rozmowa z Akarą');
  await evaluate('([...document.querySelectorAll(".d2-dialogue-sheet button")].find(button=>button.textContent.includes("HANDEL Z AKARĄ"))).click()');
  await until('Boolean(document.querySelector("#merchant-panel[aria-label]"))', 'sklep Akary');
  check(await evaluate('document.querySelectorAll("#merchant-panel .merchant-offer").length === 2'), 'Akara ma własną ofertę w tym samym prawdziwym oknie handlu');
  await screenshot('akara', 1920, 1080);
  await evaluate('document.querySelector("#close-panel").click()');
  const weaponItemId = await evaluate('window.__rotwDebug.equipment().items.items.find(item=>item.canonicalId === "hand_axe")?.id');
  check(Boolean(weaponItemId), 'Bohater ma prawdziwy topór w plecaku do sprawdzenia tooltipa');
  await evaluate('document.querySelector("#camp-open-inventory").click()');
  await until('document.querySelector("#panel-body.d2-live-inventory") !== null', 'ekwipunek bohatera');
  await screenshot('weapon-batch-inventory', 1920, 1080);
  await screenshot('weapon-batch-inventory', 1280, 720);
  await tooltipScreenshot('weapon-batch-inventory-tooltip-normal', 1920, 1080, '#inventory-grid .inventory-item');
  await tooltipScreenshot('weapon-batch-inventory-tooltip-normal', 1280, 720, '#inventory-grid .inventory-item');
  for (const quality of ['magic','rare','unique']) {
    await qualityPreviewScreenshot(quality,1920,1080);
    await qualityPreviewScreenshot(quality,1280,720);
  }
  await evaluate('document.querySelector("#close-panel").click(); document.querySelector("[data-camp-action=stash]").click()');
  await until('document.querySelector("#panel-body.d2-stash-v0518") !== null', 'otwarta skrytka');
  const stashMove = await evaluate('(() => { const before=window.__rotwDebug.snapshot().save; const sourceId=before.inventories.flatMap(([,bag])=>bag.items)[0]?.id; document.querySelector("#panel-body .d2-stash-backpack-wing .loot-row .metal-button")?.click(); const after=window.__rotwDebug.snapshot().save; return {sourceId,stashIds:after.campServices.stash.items.map(item=>item.id),bags:after.inventories.flatMap(([,bag])=>bag.items.map(item=>item.id))}; })()');
  check(Boolean(stashMove.sourceId) && stashMove.stashIds.includes(stashMove.sourceId) && !stashMove.bags.includes(stashMove.sourceId), 'Przeniesienie plecak → skrytka zachowuje tę samą tożsamość bez duplikatu');
  await tooltipScreenshot('stash-item-tooltip-normal',1920,1080,'#panel-body .d2-stash-wing .loot-row[data-item-tooltip="true"]');
  const stashReturn = await evaluate('(() => { document.querySelector("#panel-body .d2-stash-wing .loot-row .metal-button")?.click(); const save=window.__rotwDebug.snapshot().save; return {sourceId:' + JSON.stringify(stashMove.sourceId) + ',stashIds:save.campServices.stash.items.map(item=>item.id),bags:save.inventories.flatMap(([,bag])=>bag.items.map(item=>item.id))}; })()');
  check(stashReturn.bags.includes(stashReturn.sourceId) && !stashReturn.stashIds.includes(stashReturn.sourceId), 'Powrót skrytka → plecak zachowuje tę samą tożsamość i nie tworzy kopii');
  check(failures.length === 0, `Brak błędów JS: ${failures.join('; ')}`);
} finally {
  socket?.close();
  if (browser) {
    const cleanup = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP own browser: ${cleanup.remaining?.length ?? 0} remaining processes`);
  }
}
