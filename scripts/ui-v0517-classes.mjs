import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4317/';
const EVIDENCE_DIR = path.resolve('docs/evidence/v0.5.17');
const GROUPS = [
  ['korgan', 'hadriel', 'ormus'],
  ['mael', 'cassia', 'natalya'],
  ['isendra', 'veyran', 'korgan'],
];
const SUPPORT_SKILL = {
  korgan: 'barbarian.battle_orders',
  hadriel: 'paladin.might',
  ormus: 'necromancer.clay_golem',
  mael: 'druid.oak_sage',
  cassia: 'amazon.inner_sight',
  isendra: 'sorceress.frozen_armor',
  veyran: 'warlock.summon_goatman',
};
const SUMMONS = new Set(['ormus', 'mael', 'veyran']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message, detail) => {
  if (!condition) throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
};

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async ({ data }) => {
      const msg = JSON.parse(typeof data === 'string' ? data : await data.text());
      if (msg.id) {
        const task = this.pending.get(msg.id);
        if (!task) return;
        clearTimeout(task.timer);
        this.pending.delete(msg.id);
        if (msg.error) task.reject(new Error(msg.error.message));
        else task.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
        this.errors.push(msg.params.args?.map((arg) => arg.value ?? arg.description).join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  async eval(expression) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

let browser;
let cdp;
installGlobalCleanupHandlers();

async function until(predicate, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch { /* navigation can invalidate the context */ }
    await wait(75);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  const result = await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return 'missing';
    if (node.disabled) return 'disabled';
    node.click();
    return 'ok';
  })()`);
  assert(result === 'ok', `Klik ${selector}`, result);
  await wait(65);
}

async function mouse(position, button = 'left') {
  const point = await cdp.eval(`(() => {
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
    const local = window.__rotwDebug.projectHex(${position.q}, ${position.r});
    if (!local) return null;
    return {x: rect.left + local.x * rect.width / viewport.width,
      y: rect.top + local.y * rect.height / viewport.height};
  })()`);
  assert(point, 'Projekcja heksa', position);
  const params = { x: point.x, y: point.y, button, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
  await wait(90);
}

async function saveImage(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const file = path.join(EVIDENCE_DIR, name);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

const snapshot = () => cdp.eval('window.__rotwDebug.snapshot()');

async function freshGroup(group, index) {
  if (index > 0) {
    await cdp.eval('localStorage.clear()'); // only the temporary tracked browser profile
  }
  await cdp.send('Page.navigate', { url: `${APP_URL}?v0517-class-check=${index + 1}` });
  await until(() => cdp.eval('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'wczytanie aplikacji');
  await until(() => cdp.eval('document.querySelector("#team-selection-layer").getAttribute("aria-hidden") === "false"'), 'selektor ośmiu klas');
  const cards = await cdp.eval(`(() => [...document.querySelectorAll('#team-selection-grid [data-hero-id]')]
    .map(card => ({id:card.dataset.heroId, loaded:card.querySelector('img')?.naturalWidth > 0,
      name:card.querySelector('img')?.alt, selected:card.getAttribute('aria-selected') === 'true'})))()`);
  assert(cards.length === 8 && new Set(cards.map((card) => card.id)).size === 8, 'Osiem unikalnych kart', cards);
  await until(() => cdp.eval(`[...document.querySelectorAll('#team-selection-grid img')].every(img => img.complete && img.naturalWidth > 0)`), 'grafiki 8 klas');
  for (const card of cards.filter((card) => card.selected)) await click(`#team-selection-grid [data-hero-id="${card.id}"]`);
  for (const id of group) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  const selected = await cdp.eval(`[...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')].map(card => card.dataset.heroId)`);
  assert(JSON.stringify([...selected].sort()) === JSON.stringify([...group].sort()), 'Wybrana trójka', { selected, group });
  await click('#team-selection-confirm');
  await until(() => cdp.eval('document.querySelector("#camp-layer").getAttribute("aria-hidden") === "false"'), 'obóz po wyborze');
  const before = (await snapshot()).save;
  assert(JSON.stringify(before.partyIds) === JSON.stringify(group), 'Drużyna po zatwierdzeniu', before.partyIds);
  await click('#camp-open-inventory');
  await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"'), 'panel ekwipunku');
  for (const id of group) {
    const hero = before.roster.find((entry) => entry.id === id);
    await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('#equipment-owner-tabs button')]
        .find((item) => item.textContent.trim() === ${JSON.stringify(hero.name)});
      if (!button) throw new Error('Brak karty właściciela ${id}');
      button.click();
    })()`);
    const inventory = before.inventories.find(([owner]) => owner === id)?.[1];
    const ui = await cdp.eval(`(() => ({title: document.querySelector('#panel-subtitle')?.textContent,
      ids: [...document.querySelectorAll('#inventory-grid .inventory-item')].map(node => node.dataset.itemId)}))()`);
    assert(inventory && inventory.items.length > 0, `Ekwipunek ${id}`, inventory);
    assert(inventory.items.every((item) => ui.ids.includes(item.id)), `Przedmioty ${id} w UI`, ui);
    console.log(`PASS ${id}: wybór + ekwipunek ${inventory.items.length}`);
  }
  await click('#close-panel');
  await click('#camp-save');
  const stored = await cdp.eval('localStorage.getItem(window.__rotwDebug.storageKeys.current)');
  assert(typeof stored === 'string' && stored.length > 100, 'Zapis grupy w izolowanym profilu');
  await click('#camp-load');
  const restored = (await snapshot()).save;
  assert(JSON.stringify(restored.partyIds) === JSON.stringify(before.partyIds), 'Drużyna po wczytaniu');
  assert(JSON.stringify(restored.inventories) === JSON.stringify(before.inventories), 'Ekwipunki po wczytaniu');
  console.log(`PASS grupa ${index + 1}: zapis i wczytanie ${group.join(', ')}`);
}

async function reachBattle() {
  await click('[data-camp-action="gate"]');
  await until(async () => (await snapshot()).save.campaign.act1.currentAreaId === 'act1.blood_moor', 'brama na Krwawe Wrzosowisko');
  const panelOpen = await cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"');
  if (!panelOpen) await click('[data-open-panel="map"]');
  for (let step = 0; step < 35; step += 1) {
    const state = await snapshot();
    if (state.save.campaign.act1.exploration.activeBattle) {
      await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "true"'), 'zamknięcie mapy przy spotkaniu');
      assert(state.phase === 'preparation', 'Faza przygotowania pierwszego starcia', state.phase);
      return;
    }
    const route = await cdp.eval(`(async () => {
      const {CampaignState} = await import('/src/core/campaign.js');
      const {shortestSectorPath} = await import('/src/core/exploration.js');
      const campaign = CampaignState.restoreAct1(window.__rotwDebug.snapshot().save.campaign);
      const map = campaign.act1ExplorationMap();
      return shortestSectorPath(map, campaign.act1.exploration.currentSectorId, map.encounters[0].sectorId);
    })()`);
    assert(route?.length > 1, 'Ścieżka do spotkania', { route, step });
    const selector = `[data-travel-sector="${route[1]}"]`;
    await click(selector);
    await until(async () => {
      const current = (await snapshot()).save.campaign.act1.exploration;
      return current.currentSectorId !== route[0] || Boolean(current.activeBattle);
    }, `Karta podróży ${route[1]}`);
  }
  throw new Error('Nie osiągnięto spotkania w 35 krokach');
}

async function legalMove(id) {
  await click(`#party [data-character-id="${id}"]`);
  const before = await snapshot();
  assert(before.actingUnitId === id, `Aktywny bohater ${id}`, before.actingUnitId);
  const original = before.hexUnits.find((unit) => unit.id === id)?.position;
  assert(original, `Pozycja bohatera ${id}`);
  const portrait = await cdp.eval(`(() => {
    const button = document.querySelector('#party [data-character-id="${id}"]');
    const img = button?.querySelector('img');
    return {src:img?.getAttribute('src'), loaded:img?.complete && img.naturalWidth > 0,
      visible:img && !img.hidden, classId:button?.dataset.heroClass};
  })()`);
  assert(portrait.loaded && portrait.visible, `Sylwetka ${id} w rendererze`, portrait);
  const candidates = await cdp.eval(`(async () => {
    const {HexGrid} = await import('/src/core/hex-grid.js');
    const save = window.__rotwDebug.snapshot().save;
    const grid = HexGrid.restore(save.hexGrid);
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    const geometry = window.__rotwDebug.battlefieldGeometry();
    const deployment = new Set(geometry.tiles.filter(tile => tile.deployment).map(tile => tile.q + ',' + tile.r));
    return grid.reachable(${JSON.stringify(id)}, 3).filter(choice => choice.cost === 1)
      .filter(choice => deployment.has(choice.position.q + ',' + choice.position.r))
      .map(choice => {
        const center = window.__rotwDebug.projectHex(choice.position.q, choice.position.r);
        const x = rect.left + center.x * rect.width / geometry.viewport.width;
        const y = rect.top + center.y * rect.height / geometry.viewport.height;
        return {position:choice.position, x, y, hit: document.elementFromPoint(x,y) === canvas,
          inverse:window.__rotwDebug.hitTestHex(center.x,center.y)};
      }).filter(item => item.hit && item.inverse?.q === item.position.q && item.inverse?.r === item.position.r);
  })()`);
  assert(candidates.length > 0, `Dostępny heks rozstawienia ${id}`, { original, candidates });
  await mouse(candidates[0].position);
  await until(async () => {
    const current = (await snapshot()).hexUnits.find((unit) => unit.id === id)?.position;
    return current?.q === candidates[0].position.q && current?.r === candidates[0].position.r;
  }, `Klikalny ruch ${id}`);
  assert((await snapshot()).phase === 'preparation', `Ruch ${id} nie uruchomił walki`);
  console.log(`PASS ${id}: sprite ${portrait.src} + kliknięcie heksa ${original.q},${original.r} -> ${candidates[0].position.q},${candidates[0].position.r}`);
}

async function supportAction(id) {
  const skillId = SUPPORT_SKILL[id];
  if (!skillId) {
    await click(`#party [data-character-id="${id}"]`);
    await click('#mouse-skill-left');
    const assassinSkill = '#mouse-skill-chooser [data-skill-id="assassin.tiger_strike"]';
    assert(await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(assassinSkill)}))`),
      'Asasynka ma dostępny klasowy Tiger Strike LPM');
    await click(assassinSkill);
    const bound = await cdp.eval('document.querySelector("#mouse-skill-left").dataset.skillId');
    assert(bound === 'assassin.tiger_strike', 'Asasynka może przypisać Tiger Strike', bound);
    console.log(`PASS ${id}: klasowy skill ${bound} przypisany; legalną akcję potwierdził ruch`);
    return;
  }
  await click(`#party [data-character-id="${id}"]`);
  const before = await snapshot();
  await click('#mouse-skill-right');
  const option = `#mouse-skill-chooser [data-skill-id="${skillId}"]`;
  const available = await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(option)}))`);
  assert(available, `Dostępny skill ${skillId} w wyborze PPM`);
  await click(option);
  const bound = await cdp.eval('document.querySelector("#mouse-skill-right").dataset.skillId');
  assert(bound === skillId, `PPM przypisany ${skillId}`, bound);
  const own = before.hexUnits.find((unit) => unit.id === id).position;
  let target = own;
  if (SUMMONS.has(id)) {
    const choices = await cdp.eval(`(async () => {
      const {HexGrid} = await import('/src/core/hex-grid.js');
      const {hexDisk, hexDistance} = await import('/src/core/hex-grid.js');
      const grid = HexGrid.restore(window.__rotwDebug.snapshot().save.hexGrid);
      const own = ${JSON.stringify(own)};
      const canvas = document.querySelector('#scene');
      const rect = canvas.getBoundingClientRect();
      const geometry = window.__rotwDebug.battlefieldGeometry();
      const deployment = new Set(geometry.tiles.filter(tile => tile.deployment).map(tile => tile.q + ',' + tile.r));
      return hexDisk(own, 2).filter(pos => hexDistance(own,pos) > 0 && grid.has(pos) && !grid.isBlocked(pos))
        .filter(pos => deployment.has(pos.q + ',' + pos.r))
        .map(pos => {
          const center = window.__rotwDebug.projectHex(pos.q,pos.r);
          const x = rect.left + center.x * rect.width / geometry.viewport.width;
          const y = rect.top + center.y * rect.height / geometry.viewport.height;
          return {pos,hit:document.elementFromPoint(x,y) === canvas};
        }).filter(item => item.hit).map(item => item.pos);
    })()`);
    assert(choices.length > 0, `Wolny heks przywołania ${id}`);
    target = choices[0];
  }
  await mouse(target, 'right');
  await until(async () => {
    const state = await snapshot();
    return SUMMONS.has(id)
      ? state.preparation.summons?.some((summon) => summon.ownerId === id
        && !before.preparation.summons.some((previous) => previous.id === summon.id))
      : state.preparation.buffs?.some((buff) => buff.sourceId === id && buff.skillId === skillId);
  }, `Realne użycie umiejętności ${skillId}`, 5_000);
  assert((await snapshot()).phase === 'preparation', `Wsparcie ${id} zachowało przygotowanie`);
  console.log(`PASS ${id}: PPM ${skillId} zmienił stan przygotowania`);
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health', APP_URL))).json();
  assert(health.app === 'reign-of-the-warlock-turn-based' && path.resolve(health.projectRoot) === process.cwd(), 'Serwer właściwej gry', health);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '1536,864', stdio: ['ignore', 'ignore', 'pipe'] });
  cdp = new Cdp(browser.target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width:1536, height:864, deviceScaleFactor:1, mobile:false });
  for (const [index, group] of GROUPS.entries()) {
    await freshGroup(group, index);
    await reachBattle();
    const first = await snapshot();
    assert(first.hexUnits.filter((unit) => group.includes(unit.id) && unit.position).length === 3, 'Trzy postacie na polach', first.hexUnits);
    for (const id of group) await legalMove(id);
    for (const id of group) if (id !== 'korgan' || index === 0) await supportAction(id);
    const beforeBattleSave = await snapshot();
    await click('#save');
    await click('#load');
    const afterBattleLoad = await snapshot();
    assert(JSON.stringify(afterBattleLoad.save.partyIds) === JSON.stringify(beforeBattleSave.save.partyIds),
      'Skład po zapisie i wczytaniu pola');
    assert(JSON.stringify(afterBattleLoad.save.inventories) === JSON.stringify(beforeBattleSave.save.inventories),
      'Ekwipunki po zapisie i wczytaniu pola');
    assert(JSON.stringify(afterBattleLoad.hexUnits) === JSON.stringify(beforeBattleSave.hexUnits),
      'Pozycje ośmiu klas po zapisie i wczytaniu pola');
    assert(JSON.stringify(afterBattleLoad.preparation.buffs) === JSON.stringify(beforeBattleSave.preparation.buffs)
      && JSON.stringify(afterBattleLoad.preparation.summons) === JSON.stringify(beforeBattleSave.preparation.summons),
    'Akcje klasowe po zapisie i wczytaniu pola');
    await until(() => cdp.eval('document.querySelector("#game-toast").classList.contains("hidden")'),
      'czysty kadr bez powiadomienia', 8_000);
    const file = await saveImage(`battle-classes-${index + 1}-v0.5.17.png`);
    console.log(`EVIDENCE ${file}`);
  }
  assert(cdp.errors.length === 0, 'Brak błędów JS', cdp.errors);
  console.log('PASS 8 unikalnych klas: wybór, portret/sprite, pole, legalny ruch, ekwipunek, save/load; klasowe akcje wsparcia według logu.');
}

let failure;
try { await run(); } catch (error) { failure = error; }
finally {
  cdp?.close();
  const cleanup = browser ? await cleanupTrackedBrowser(browser) : null;
  if (cleanup?.remaining?.length) failure ??= new Error(`Pozostały procesy Edge: ${JSON.stringify(cleanup.remaining)}`);
}
if (failure) { console.error(`FAIL ui-v0517-classes: ${failure.stack ?? failure.message}`); process.exitCode = 1; }
