// Isolated browser check of a real camp hotspot click, healing and direct trade.
// The disposable browser profile never reads or writes the player's saves.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const EVIDENCE_DIR = path.resolve('docs/evidence/akara-direct-trade');
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

async function click(selector) {
  const result = await evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.disabled) return { found: Boolean(button), disabled: button?.disabled };
    button.click();
    return { found: true, disabled: false };
  })()`);
  check(result?.found && !result.disabled, `Kliknięcie ${selector}`, result);
}

async function clickCampAkara() {
  const target = await evaluate(`(() => {
    const button = document.querySelector('[data-camp-action="akara"]');
    const rect = button?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return { x, y, visible: document.elementFromPoint(x, y)?.closest('[data-camp-action="akara"]') === button };
  })()`);
  check(target?.visible, 'Widoczny NPC Akara przyjmuje kliknięcie myszą', target);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
}

async function screenshot(name) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await evaluate('(async () => { await Promise.race([Promise.all([...document.images].map(image => image.decode().catch(() => {}))), new Promise(resolve => setTimeout(resolve, 2000))]); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const filename = path.join(EVIDENCE_DIR, `${name}.png`);
  await writeFile(filename, Buffer.from(image.data, 'base64'));
  console.log(`SCREENSHOT ${filename}`);
}

async function merchantState() {
  return evaluate(`(() => ({
    title: document.querySelector('#panel-title')?.textContent.trim(),
    tradePair: document.querySelector('#panel-layer')?.classList.contains('trade-pair'),
    merchant: document.querySelector('#merchant-panel')?.getAttribute('aria-label'),
    offers: document.querySelectorAll('#merchant-panel .merchant-offer').length,
    dialogue: Boolean(document.querySelector('.d2-dialogue-sheet')),
    questStatus: window.__rotwDebug.snapshot().save.campaign.questState['act1.den_of_evil']?.status ?? 'available',
  }))()`);
}

async function checkMerchant(description) {
  await until(`document.querySelector('#panel-title')?.textContent.trim() === 'HANDEL · AKARA'
    && [8, 9].includes(document.querySelectorAll('#merchant-panel .merchant-offer').length)`, description);
  const state = await merchantState();
  check(state.tradePair && state.merchant?.toLowerCase().includes('akara')
    && [8, 9].includes(state.offers) && !state.dialogue, description, state);
}

async function main() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL), {
    signal: AbortSignal.timeout(5_000),
  })).json();
  check(path.resolve(health.projectRoot).toLowerCase() === path.resolve(process.cwd()).toLowerCase(),
    'Serwer wskazuje bieżący projekt', health);

  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    appUrl: 'about:blank', windowSize: '1536,864', stdio: ['ignore', 'ignore', 'pipe'],
    extraArgs: ['--mute-audio', '--no-sandbox', '--disable-software-rasterizer', '--disable-gpu-compositing'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  check(Boolean(target?.webSocketDebuggerUrl), 'Przeglądarka udostępnia kartę testową');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async ({ data }) => {
    const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    const message = JSON.parse(raw);
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
    width: 1536, height: 864, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: APP_URL });
  await until('Boolean(window.__rotwDebug?.snapshot) && !document.querySelector("#main-menu").hidden',
    'Menu startowe');
  await click('#menu-new-game');
  await until('document.querySelector("#character-creation")?.getAttribute("aria-hidden") === "false"',
    'Wybór postaci');
  await click('.character-creation-class[data-hero-id="korgan"]');
  await click('.character-creation-class[data-hero-id="mael"]');
  await click('.character-creation-class[data-hero-id="veyran"]');
  await click('#character-creation-confirm');
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"',
    'Obozowisko Łotrzyc');
  check(await evaluate(`!Object.hasOwn(
    window.__rotwDebug.snapshot().save.campaign.questState, 'act1.den_of_evil')`),
  'Świeża kampania nie ma przyjętego zadania');
  check(await evaluate('window.__rotwDebug.saveGameState()'), 'Testowy zapis stanu obozu');
  const prepared = await evaluate(`(() => {
    const debug = window.__rotwDebug, save = debug.snapshot().save;
    const active = new Set(save.partyIds);
    for (const hero of save.roster) {
      if (!active.has(hero.id) || hero.lifeState !== 'alive') continue;
      hero.resources.hp = Math.max(1, hero.resources.maxHp - 5);
      hero.resources.mana = Math.max(0, hero.resources.maxMana - 3);
    }
    for (const unit of save.combat.units) {
      const hero = save.roster.find(candidate => candidate.id === unit.id);
      if (hero && unit.resources) unit.resources = structuredClone(hero.resources);
    }
    localStorage.setItem(debug.storageKeys.current, JSON.stringify(save));
    return { loaded: debug.loadGameState(), active: save.partyIds };
  })()`);
  check(prepared.loaded, 'Wczytanie testowej drużyny z niepełnym HP i maną', prepared);
  const before = await evaluate(`(() => { const save=window.__rotwDebug.snapshot().save; return {
    roster: save.roster.filter(hero=>save.partyIds.includes(hero.id)).map(hero=>({
      id:hero.id,lifeState:hero.lifeState,hp:hero.resources.hp,maxHp:hero.resources.maxHp,
      mana:hero.resources.mana,maxMana:hero.resources.maxMana })),
    offers: save.campServices.vendors.find(v=>v.id==='akara').offers.map(o=>({id:o.offerId,item:o.item.canonicalId})),
    healLogs: save.combat.log.filter(line=>line.startsWith('Akara uleczyła:')).length,
  }; })()`);
  check(before.roster.length===3 && before.roster.every(hero=>hero.lifeState==='alive'
    && hero.hp<hero.maxHp && hero.mana<hero.maxMana),
  'Trzech aktywnych żywych bohaterów ma niepełne HP i manę', before.roster);
  await screenshot('01-akara-oboz-przed');
  const hovered = await evaluate(`(() => { const r=document.querySelector('[data-camp-action="akara"]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hovered.x, y: hovered.y });
  check(await evaluate(`window.__rotwDebug.snapshot().save.roster.find(hero=>hero.id===${JSON.stringify(before.roster[0].id)})?.resources.hp`) === before.roster[0].hp,
    'Hover Akary nie leczy');

  await clickCampAkara();
  await checkMerchant('Pierwsze kliknięcie Akary od razu otwiera pełny sklep');
  const after = await evaluate(`(() => { const save=window.__rotwDebug.snapshot().save; return {
    roster: save.roster.filter(hero=>save.partyIds.includes(hero.id)).map(hero=>({
      id:hero.id,lifeState:hero.lifeState,hp:hero.resources.hp,maxHp:hero.resources.maxHp,
      mana:hero.resources.mana,maxMana:hero.resources.maxMana })),
    offers: save.campServices.vendors.find(v=>v.id==='akara').offers.map(o=>({id:o.offerId,item:o.item.canonicalId})),
    healLogs: save.combat.log.filter(line=>line.startsWith('Akara uleczyła:')).length,
  }; })()`);
  check(after.roster.every(hero=>hero.lifeState!=='alive' || (hero.hp===hero.maxHp && hero.mana===hero.maxMana))
    && after.healLogs === before.healLogs + 1, 'Jedno kliknięcie raz leczy żywą aktywną drużynę', {before:before.roster,after:after.roster,healLogs:[before.healLogs,after.healLogs]});
  check(JSON.stringify(after.offers)===JSON.stringify(before.offers), 'Leczenie nie zmienia oferty Akary');
  check(after.offers.some(offer=>offer.item.startsWith('potion_health'))
    && after.offers.some(offer=>offer.item.startsWith('potion_mana'))
    && after.offers.some(offer=>offer.item==='wand')
    && after.offers.some(offer=>offer.item==='scepter')
    && after.offers.every(offer=>['scroll_identify','scroll_town_portal','tome_identify','tome_town_portal',
      'potion_health_lesser','potion_mana_lesser','wand','scepter','dagger'].includes(offer.item)),
  'Oferta Akary zawiera właściwe towary i nie zawiera sprzętu Charsi', after.offers);
  await screenshot('02-po-kliknieciu-bez-menu');
  await writeFile(path.join(EVIDENCE_DIR, 'hp-mana-przed-po.json'),
    JSON.stringify({before:before.roster,after:after.roster,healExecutions:after.healLogs-before.healLogs,offers:after.offers},null,2));
  await click('#close-panel');
  await until('document.querySelector("#panel-layer")?.getAttribute("aria-hidden") === "true"',
    'Zamknięcie sklepu');
  await clickCampAkara();
  await checkMerchant('Ponowne kliknięcie od razu otwiera sklep Akary');
  const reopened = await evaluate(`window.__rotwDebug.snapshot().save.campServices.vendors.find(v=>v.id==='akara').offers.map(o=>({id:o.offerId,item:o.item.canonicalId}))`);
  check(JSON.stringify(reopened)===JSON.stringify(after.offers), 'Ponowne otwarcie nie losuje oferty w tej samej sesji');
  await screenshot('03-pelny-sklep-akary');
  await click('#close-panel');
  check(await evaluate(`!Object.hasOwn(window.__rotwDebug.snapshot().save.campaign.questState,'act1.den_of_evil')`),
    'Bezpośredni handel nie odbiera ani nie kasuje zadania Siedlisko Zła');
  await click('#camp-open-map');
  await click('#map-akara');
  check(await evaluate(`Boolean(document.querySelector('#akara-accept:not([disabled])'))
    && !document.querySelector('#akara-heal') && !document.querySelector('#akara-trade')`),
    'Zadanie pozostaje w dzienniku bez starego menu usług');
  await click('#akara-accept');
  check(await evaluate(`window.__rotwDebug.snapshot().save.campaign.questState['act1.den_of_evil']?.status==='active'`),
    'Przyjęcie Siedliska Zła w dzienniku nadal działa');
  await click('#close-panel');
  await clickCampAkara();
  await checkMerchant('Po przyjęciu zadania Akara nadal otwiera handel bezpośrednio');
  await click('#close-panel');
  check(await evaluate('window.__rotwDebug.saveGameState() && window.__rotwDebug.loadGameState()'),
    'Nowa sesja z zapisu wczytuje się poprawnie');
  await clickCampAkara();
  await checkMerchant('Nowa sesja nadal otwiera sklep bez menu');
  const nextSession = await evaluate(`window.__rotwDebug.snapshot().save.campServices.vendors.find(v=>v.id==='akara').offers.map(o=>({id:o.offerId,item:o.item.canonicalId}))`);
  check(nextSession.every(offer=>!after.offers.some(previous=>previous.id===offer.id)),
    'Nowa sesja generuje nowe egzemplarze oferty Akary');
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
