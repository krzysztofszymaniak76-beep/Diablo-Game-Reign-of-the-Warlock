import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4317/';
const EVIDENCE = path.resolve('docs/evidence/v0.5.17');
const HERO_IDS = ['korgan', 'isendra', 'veyran'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, label, detail) => {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`);
};
const trace = [];

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
      const message = JSON.parse(typeof data === 'string' ? data : await data.text());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) {
        this.errors.push(message.params.args?.map(arg => arg.value ?? arg.description).join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout CDP: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

let browser;
let cdp;
installGlobalCleanupHandlers();

async function until(predicate, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await predicate()) return; } catch { /* navigation */ }
    await wait(75);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  const state = await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return 'missing';
    if (node.disabled) return 'disabled';
    node.click();
    return 'ok';
  })()`);
  assert(state === 'ok', `Kliknięcie ${selector}`, state);
  await wait(65);
}

async function mouse(hex, button = 'left') {
  const point = await cdp.eval(`(() => {
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
    const center = window.__rotwDebug.projectHex(${hex.q}, ${hex.r});
    if (!center) return null;
    return { x: rect.left + center.x * rect.width / viewport.width,
      y: rect.top + center.y * rect.height / viewport.height,
      inverse:window.__rotwDebug.hitTestHex(center.x,center.y),
      hit: document.elementFromPoint(rect.left + center.x * rect.width / viewport.width,
        rect.top + center.y * rect.height / viewport.height)?.id };
  })()`);
  assert(point?.hit === 'scene', 'Heks dostępny kursorem', { hex, point });
  assert(point.inverse?.q === hex.q && point.inverse?.r === hex.r, 'Środek heksa wskazuje właściwe pole', {hex,point});
  const params = { x: point.x, y: point.y, button, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
  await wait(110);
}

const snapshot = () => cdp.eval('window.__rotwDebug.snapshot()');
const remaining = state => state.save.combat.units.filter(unit => unit.kind === 'monster' && unit.hp > 0);
const hero = (state, id) => state.save.roster.find(item => item.id === id);
const position = (state, id) => state.hexUnits.find(item => item.id === id)?.position;

async function screenshot(name) {
  await cdp.eval(`(async () => { await document.fonts?.ready;
    await Promise.race([Promise.all([...document.images].map(image => image.decode?.().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 5000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  const file = path.join(EVIDENCE, name);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log(`EVIDENCE ${file}`);
}

async function startFreshAndReachBattle() {
  await cdp.send('Page.navigate', { url: `${APP_URL}?v0517-battle-acceptance=1` });
  await until(() => cdp.eval('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'gra załadowana');
  await until(() => cdp.eval('document.querySelector("#team-selection-layer").getAttribute("aria-hidden") === "false"'), 'wybór drużyny');
  const initial = await cdp.eval(`[...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')].map(card => card.dataset.heroId)`);
  for (const id of initial) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of HERO_IDS) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click('#team-selection-confirm');
  await until(() => cdp.eval('document.querySelector("#camp-layer").getAttribute("aria-hidden") === "false"'), 'obóz');
  assert(JSON.stringify((await snapshot()).save.partyIds) === JSON.stringify(HERO_IDS), 'Aktywna drużyna', (await snapshot()).save.partyIds);
  await click('#camp-save');
  await click('[data-camp-action="gate"]');
  await until(async () => (await snapshot()).save.campaign.act1.currentAreaId === 'act1.blood_moor', 'Krwawe Wrzosowisko');
  if (!await cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"')) {
    await click('[data-open-panel="map"]');
  }
  for (let step = 0; step < 40; step += 1) {
    const state = await snapshot();
    if (state.save.campaign.act1.exploration.activeBattle) {
      await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "true"'), 'zamknięcie mapy przy spotkaniu');
      assert(state.phase === 'preparation', 'Przygotowanie', state.phase);
      return;
    }
    const route = await cdp.eval(`(async () => {
      const {CampaignState} = await import('/src/core/campaign.js');
      const {shortestSectorPath} = await import('/src/core/exploration.js');
      const campaign = CampaignState.restoreAct1(window.__rotwDebug.snapshot().save.campaign);
      const map = campaign.act1ExplorationMap();
      return shortestSectorPath(map, campaign.act1.exploration.currentSectorId, map.encounters[0].sectorId);
    })()`);
    assert(route?.length > 1, 'Rzeczywista trasa do spotkania', route);
    await click(`[data-travel-sector="${route[1]}"]`);
    await until(async () => {
      const exploration = (await snapshot()).save.campaign.act1.exploration;
      return exploration.currentSectorId !== route[0] || Boolean(exploration.activeBattle);
    }, `Podróż do ${route[1]}`);
  }
  throw new Error('Nie osiągnięto spotkania po 40 krokach');
}

async function chooseOffensiveSkill(actorId, skillId) {
  const side = skillId === 'barbarian.bash' ? 'left' : 'left';
  const bound = await cdp.eval(`document.querySelector('#mouse-skill-${side}').dataset.skillId`);
  if (bound === skillId) return;
  await click(`#mouse-skill-${side}`);
  await click(`#mouse-skill-chooser [data-skill-id="${skillId}"]`);
  assert(await cdp.eval(`document.querySelector('#mouse-skill-${side}').dataset.skillId === ${JSON.stringify(skillId)}`),
    'Umiejętność przypięta przez HUD', { actorId, skillId });
}

async function tacticalOptions(actorId, range) {
  return cdp.eval(`(async () => {
    const {HexGrid, hexDistance} = await import('/src/core/hex-grid.js');
    const state = window.__rotwDebug.snapshot().save;
    const grid = HexGrid.restore(state.hexGrid);
    const actor = grid.positionOf(${JSON.stringify(actorId)});
    const encounter = state.campaign.act1.encounters[state.campaign.act1.currentEncounterId];
    const groundLoot = new Set(encounter.drops.filter(drop => drop.status === 'ground')
      .map(drop => drop.hex.q+','+drop.hex.r));
    const enemies = state.combat.units.filter(item => item.kind === 'monster' && item.hp > 0)
      .map(item => ({id: item.id, hp:item.hp, position:grid.positionOf(item.id)}));
    const visible = enemies.filter(item => {
      const distance = hexDistance(actor, item.position);
      return distance <= ${range} && grid.hasLineOfSight(actor, item.position, {ignoreUnitIds:[${JSON.stringify(actorId)}, item.id]})
        && (${range} === 1 || grid.hasProjectilePath(actor,item.position,{ignoreUnitIds:[${JSON.stringify(actorId)},item.id]}));
    }).sort((a,b) => a.hp-b.hp || hexDistance(actor,a.position)-hexDistance(actor,b.position));
    const moves = grid.reachable(${JSON.stringify(actorId)},3)
      .filter(choice => choice.cost > 0 && !groundLoot.has(choice.position.q+','+choice.position.r)).map(choice => ({
      ...choice,
      nearest: Math.min(...enemies.map(enemy => hexDistance(choice.position,enemy.position))),
      fire: enemies.some(enemy => hexDistance(choice.position,enemy.position) <= ${range}
        && grid.hasLineOfSight(choice.position,enemy.position,{ignoreUnitIds:[${JSON.stringify(actorId)},enemy.id]})
        && (${range} === 1 || grid.hasProjectilePath(choice.position,enemy.position,{ignoreUnitIds:[${JSON.stringify(actorId)},enemy.id]}))),
    })).sort((a,b) => Number(b.fire)-Number(a.fire) || a.nearest-b.nearest || b.cost-a.cost);
    return {actor, enemies, visible, moves:moves.slice(0,12)};
  })()`);
}

async function runBattle() {
  await screenshot('battle-real-before-start-v0.5.17.png');
  const before = await snapshot();
  await click('#start-battle');
  await until(async () => (await snapshot()).phase === 'active', 'aktywna walka');
  await cdp.eval(`(() => {
    window.__battleProbe = [];
    const canvas = document.querySelector('#scene');
    canvas.addEventListener('click', event => {
      const rect = canvas.getBoundingClientRect();
      const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
      const state = window.__rotwDebug.snapshot();
      const hex = window.__rotwDebug.hitTestHex((event.clientX-rect.left)*viewport.width/rect.width,
        (event.clientY-rect.top)*viewport.height/rect.height);
      window.__battleProbe.push({
        detail:event.detail,button:event.button,clientX:event.clientX,clientY:event.clientY,
        hex, actor:state.actingUnitId, inspected:state.save.inspectedCharacterId,
        occupant:state.hexUnits.find(unit=>unit.position?.q===hex?.q&&unit.position?.r===hex?.r)?.id,
        panelOpen:document.querySelector('#panel-layer').getAttribute('aria-hidden')==='false',
        targetHidden:document.querySelector('#targeting-banner').classList.contains('hidden'),
      });
    }, true);
    canvas.addEventListener('click', () => {
      const state = window.__rotwDebug.snapshot();
      window.__battleProbe.at(-1).after = {
        actor:state.actingUnitId,inspected:state.save.inspectedCharacterId,
        targetHidden:document.querySelector('#targeting-banner').classList.contains('hidden'),
        toast:document.querySelector('#game-toast').textContent.trim(),
        panelOpen:document.querySelector('#panel-layer').getAttribute('aria-hidden')==='false',
        panelTitle:document.querySelector('#panel-title').textContent.trim(),
      };
    });
  })()`);
  let sawManaDrop = false;
  let sawHpDrop = false;
  let offensiveActions = 0;
  let battleShotSaved = false;
  const skillByHero = { korgan:'barbarian.bash', isendra:'sorceress.fire_bolt', veyran:'warlock.miasma_bolt' };
  for (let turn = 0; turn < 180; turn += 1) {
    const state = await snapshot();
    if (state.phase === 'completed') {
      console.log(`PASS zwycięstwo po ${turn} decyzjach`);
      break;
    }
    const actorId = state.actingUnitId;
    assert(HERO_IDS.includes(actorId), 'Aktywny bohater ma kolejkę', { turn, actorId, phase:state.phase, monsters:remaining(state).length });
    const actor = hero(state, actorId);
    assert(actor?.resources.hp > 0, 'Aktywny bohater żyje', { actorId, actor });
    const inspected = state.save.inspectedCharacterId;
    if (inspected !== actorId) await click(`#party [data-character-id="${actorId}"]`);
    const skillId = skillByHero[actorId];
    const range = actorId === 'korgan' ? 1 : 6;
    const manaCost = actorId === 'korgan' ? 0 : 4;
    const options = await tacticalOptions(actorId, range);
    const current = options.visible[0];
    const canCast = actor.resources.mana >= manaCost;
    let command;
    if (current && canCast) {
      await chooseOffensiveSkill(actorId, skillId);
      await mouse(current.position);
      offensiveActions += 1;
      command = `atak ${skillId} → ${current.id}`;
    } else if (options.moves.length) {
      const choice = options.moves[0];
      await mouse(choice.position);
      command = `ruch ${choice.position.q},${choice.position.r}; dystans ${choice.nearest}`;
    } else {
      await click('#end-turn');
      command = 'zakończ kolejkę';
    }
    const next = await snapshot();
    const previousHeroHp = new Map(state.save.roster.map(item => [item.id,item.resources.hp]));
    sawHpDrop ||= next.save.roster.some(item => HERO_IDS.includes(item.id) && item.resources.hp < previousHeroHp.get(item.id));
    sawManaDrop ||= next.save.roster.some(item => HERO_IDS.includes(item.id) && item.resources.mana < hero(state,item.id).resources.mana);
    const log = { turn, actorId, command, phase:next.phase, nextActor:next.actingUnitId,
      inspected:next.save.inspectedCharacterId,
      actorPosition:position(next,actorId),
      enemies:remaining(next).map(item => ({id:item.id,hp:item.hp})),
      hp:HERO_IDS.map(id=>[id,hero(next,id).resources.hp]),
      mana:HERO_IDS.map(id=>[id,hero(next,id).resources.mana]),
      toast:await cdp.eval('document.querySelector("#game-toast")?.textContent.trim()'),
      targeting:await cdp.eval(`({hidden:document.querySelector('#targeting-banner').classList.contains('hidden'),
        title:document.querySelector('#targeting-title').textContent,
        copy:document.querySelector('#targeting-copy').textContent})`),
      probe:await cdp.eval('window.__battleProbe?.at(-1)'),
      recentLog:await cdp.eval(`[...document.querySelectorAll('#combat-log li')].slice(-3).map(item=>item.textContent.trim())`) };
    trace.push(log);
    console.log(`TURN ${turn} ${actorId}: ${command}; przeciwnicy ${log.enemies.map(item=>item.hp).join(',')}; następny ${log.nextActor}; ${log.toast}`);
    if (!battleShotSaved && sawManaDrop && sawHpDrop && next.phase === 'active') {
      await screenshot('battle-real-active-v0.5.17.png');
      battleShotSaved = true;
    }
    if (next.actingUnitId === actorId && next.phase === 'active'
      && JSON.stringify(next.hexUnits) === JSON.stringify(state.hexUnits)
      && JSON.stringify(next.save.combat) === JSON.stringify(state.save.combat)) {
      throw new Error(`Polecenie nie zmieniło stanu w turze ${turn}: ${command}; ${JSON.stringify({log,jsErrors:cdp.errors})}`);
    }
  }
  const completed = await snapshot();
  assert(completed.phase === 'completed', 'Legalne zwycięstwo', {phase:completed.phase, remaining:remaining(completed), last:trace.at(-1)});
  assert(offensiveActions > 0, 'Wykonano ofensywne kliknięcia', offensiveActions);
  assert(sawManaDrop, 'Mana zmieniła się w realnym starciu');
  assert(sawHpDrop, 'Życie zmieniło się w realnym starciu');
  assert(battleShotSaved, 'Zapisano widok aktywnej walki po zmianie zasobów');
  if (await cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"')) {
    await click('#close-panel');
  }
  await click('#party [data-character-id="korgan"]');
  const korganLife = await cdp.eval('document.querySelector("#life-orb-value").textContent.trim()');
  assert(korganLife === `${hero(completed,'korgan').resources.hp} / ${hero(completed,'korgan').resources.maxHp}`,
    'Kula życia pokazuje utracone HP Korgana', korganLife);
  await click('#party [data-character-id="isendra"]');
  const orb = await cdp.eval(`(async () => {
    const {formatMana}=await import('/src/core/skill-mana.js');
    const state=window.__rotwDebug.snapshot().save;
    const current=state.roster.find(hero=>hero.id==='isendra');
    return {hp:document.querySelector('#life-orb-value').textContent.trim(),
      mana:document.querySelector('#mana-orb-value').textContent.trim(),
      expectedMana:formatMana(current.resources.mana)+' / '+formatMana(current.resources.maxMana)};
  })()`);
  assert(orb.mana === orb.expectedMana && hero(completed,'isendra').resources.mana < hero(before,'isendra').resources.mana,
    'Kula many pokazuje faktyczne zużycie Isendry', orb);
  await screenshot('battle-real-victory-v0.5.17.png');
  return { before, completed, orb, sawHpDrop, sawManaDrop, offensiveActions };
}

async function collectEquipAndRestore() {
  const won = await snapshot();
  const drops = won.save.campaign.act1.exploration?.activeBattle;
  await click('#party [data-character-id="korgan"]');
  await click('#loot-toast');
  await until(() => cdp.eval('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"'), 'panel łupu');
  const offer = await cdp.eval(`(() => [...document.querySelectorAll('#ground-loot-list [data-drop-id]')]
    .map(row => ({id:row.dataset.dropId,name:row.querySelector('h3')?.textContent,
      disabled:row.querySelector('[data-pickup]')?.disabled})))()`);
  assert(offer.length > 0 && offer.some(item=>!item.disabled), 'Prawdziwy łup po zwycięstwie', offer);
  const recipient = await cdp.eval(`document.querySelector('#loot-owner-tabs button.active')?.textContent.trim()`);
  assert(recipient === 'Korgan', 'Odbiorca łupu wybrany przez interfejs', recipient);
  await screenshot('battle-real-loot-v0.5.17.png');
  await click(`#ground-loot-list [data-drop-id="${offer[0].id}"] [data-pickup]`);
  const picked = await snapshot();
  const ownerId = picked.save.inspectedCharacterId;
  const inventory = picked.save.inventories.find(([id])=>id===ownerId)?.[1];
  const lootItem = inventory?.items.find(item=>item.id===offer[0].id);
  assert(lootItem, 'Łup trafił do plecaka przez UI', {ownerId, id:offer[0].id, inventory:inventory?.items.map(item=>item.id)});
  await click('#loot-open-inventory');
  await until(() => cdp.eval('Boolean(document.querySelector("#inventory-grid .inventory-item"))'), 'panel plecaka');
  await click(`#inventory-grid .inventory-item[data-item-id="${lootItem.id}"]`);
  const button = await cdp.eval(`({disabled:document.querySelector('#equipment-action')?.disabled,
    text:document.querySelector('#equipment-action')?.textContent.trim(),
    reason:document.querySelector('.equipment-error')?.textContent.trim()})`);
  assert(button.text === 'ZAŁÓŻ' && !button.disabled, 'Zdobyty przedmiot można założyć', {lootItem,button});
  await click('#equipment-action');
  const equipped = await snapshot();
  const owner = hero(equipped,ownerId);
  assert(Object.values(owner.equipment).some(item=>item?.id===lootItem.id), 'Zdobyty przedmiot założony przez UI', owner.equipment);
  await click('#close-panel');
  await click('#save');
  const saved = await snapshot();
  await click('#load');
  const restored = await snapshot();
  assert(restored.phase === saved.phase, 'Faza po zapisie/wczytaniu', [saved.phase,restored.phase]);
  assert(JSON.stringify(restored.save.campaign) === JSON.stringify(saved.save.campaign), 'Postęp kampanii po wczytaniu');
  assert(JSON.stringify(restored.save.inventories) === JSON.stringify(saved.save.inventories), 'Plecaki po wczytaniu');
  assert(Object.values(hero(restored,ownerId).equipment).some(item=>item?.id===lootItem.id), 'Łup pozostaje założony po wczytaniu');
  console.log(`PASS łup ${lootItem.name}, ekwipunek ${ownerId}, zapis/wczytanie`);
  return {drops, lootItem, ownerId};
}

async function run() {
  const health = await (await fetch(new URL('/__rotw_health',APP_URL))).json();
  assert(path.resolve(health.projectRoot) === process.cwd(), 'Serwer bieżącego projektu', health);
  await mkdir(EVIDENCE, {recursive:true});
  browser = await launchTrackedBrowser({appUrl:'about:blank',windowSize:'1536,864',stdio:['ignore','ignore','pipe']});
  cdp = new Cdp(browser.target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'),cdp.send('Runtime.enable'),cdp.send('Log.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1536,height:864,deviceScaleFactor:1,mobile:false});
  await startFreshAndReachBattle();
  const battle = await runBattle();
  const loot = await collectEquipAndRestore();
  assert(cdp.errors.length===0,'Brak błędów JS',cdp.errors);
  console.log(`PASS realne starcie: ${battle.offensiveActions} ataków, spadek HP/many, łup, wyposażenie, save/load`);
  return {battle:{orb:battle.orb,sawHpDrop:battle.sawHpDrop,sawManaDrop:battle.sawManaDrop,offensiveActions:battle.offensiveActions},loot};
}

let failure;
let result;
try { result=await run(); }
catch(error) { failure=error; }
finally {
  if (trace.length) await writeFile(path.join(EVIDENCE,'battle-real-trace-v0.5.17.json'),JSON.stringify({result,trace},null,2));
  cdp?.close();
  const cleanup=browser?await cleanupTrackedBrowser(browser):null;
  if(cleanup?.remaining?.length) failure ??= new Error(`Pozostałe własne procesy: ${JSON.stringify(cleanup.remaining)}`);
}
if(failure) { console.error(`FAIL ui-v0517-battle-acceptance: ${failure.stack??failure.message}`); process.exitCode=1; }
