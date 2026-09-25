import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CampaignState } from '../src/core/campaign.js';
import { shortestSectorPath } from '../src/core/exploration.js';
import { HexGrid, hexDistance } from '../src/core/hex-grid.js';
import { explorationPoint, findOpenTerrainPath, openTerrainSectorAt } from '../src/core/open-terrain.js';
import { characterExperienceSegments } from '../src/core/progression.js';
import { rollBloodMoorEncounter } from '../src/core/random-act1-encounter.js';
import {
  cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser,
} from './browser-lifecycle.mjs';

// Standalone, off-screen acceptance. It never opens the desktop game, changes
// the user's browser profile, or writes to the user's save slot.
const WIDTH = 1920;
const HEIGHT = 1080;
const PORT = 4199;
const HERO_IDS = ['korgan', 'isendra', 'veyran'];
const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const WORLD_SEED = 122;
const BATTLE_GUIDE_ONLY = process.argv.includes('--battle-guide-only');
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const EVIDENCE = path.resolve(BATTLE_GUIDE_ONLY
  ? `docs/evidence/battle-guide-v${version}-1920x1080`
  : `docs/evidence/exploration-live-map-v${version}-physical-input`);
const TEST_SAVE_DIR = await mkdtemp(path.join(os.tmpdir(), 'rotw-exploration-save-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const mouseCoverage = { left:0, right:0 };
let hexGeometryChecked = false;
let server;
let browser;
let cdp;
installGlobalCleanupHandlers();

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async ({ data }) => {
      const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
  async eval(expression) {
    const reply = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (reply.exceptionDetails) throw new Error(
      reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
    );
    return reply.result?.value;
  }
  close() {
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.socket.close();
  }
}

function check(condition, label) {
  assert.ok(condition, label);
  checks.push(label);
}

async function until(predicate, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* page in transition */ }
    await delay(75);
  }
  throw new Error(`Timeout: ${label}`);
}

const snapshot = () => cdp.eval('window.__rotwDebug.snapshot()');
async function campaign() {
  return CampaignState.restoreAct1((await snapshot()).save.campaign);
}

async function click(selector) {
  const response = await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return 'missing';
    if (node.disabled) return 'disabled';
    node.click();
    return 'ok';
  })()`);
  assert.equal(response, 'ok', `Click ${selector}: ${response}`);
  await delay(75);
}

async function clickVisibleEncounterButton() {
  const target = await cdp.eval(`(() => {
    const button = document.querySelector('#start-map-encounter');
    if (!button) return {error:'missing'};
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const layer = document.querySelector('#panel-layer');
    const samples = [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75]];
    const points = samples.map(([fx,fy]) => {
      const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
      const top = document.elementFromPoint(x,y);
      return {x,y,hit:top === button || button.contains(top),top:top?.outerHTML?.slice(0,200)};
    });
    return {disabled:button.disabled,rect:rect.toJSON(),display:style.display,
      visibility:style.visibility,opacity:style.opacity,pointerEvents:style.pointerEvents,
      layerHidden:layer?.getAttribute('aria-hidden'),points};
  })()`);
  const point = target?.points?.find(item => item.hit);
  check(Boolean(point) && !target.disabled && target.display !== 'none'
    && target.visibility === 'visible' && Number(target.opacity) > 0
    && target.pointerEvents !== 'none' && target.layerHidden === 'false',
  `encounter button is visibly clickable in the viewport (${JSON.stringify(target)})`);
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x,y:point.y});
  await cdp.send('Input.dispatchMouseEvent',
    {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',
    {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  await delay(75);
}

async function checkPendingEncounter(sectorId) {
  const before = await snapshot();
  check(before.save.campaign.act1.exploration.currentSectorId === sectorId
    && before.save.campaign.act1.exploration.activeBattle === null,
  `arrival in ${sectorId} leaves the fight pending until the player chooses it`);
  await delay(1500);
  const after = await snapshot();
  check(after.phase === before.phase
    && after.save.combat.battleId === before.save.combat.battleId
    && after.save.campaign.act1.exploration.currentSectorId === sectorId
    && after.save.campaign.act1.exploration.activeBattle === null
    && after.save.campaign.act1.exploration.movementSequence
      === before.save.campaign.act1.exploration.movementSequence
    && await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`),
  `pending fight in ${sectorId} does not start itself after 1.5 seconds`);
}

async function openMap() {
  const visible = await cdp.eval(`document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false'`);
  if (!visible) await click('[data-open-panel="map"]');
  else if (!await cdp.eval(`Boolean(document.querySelector('#exploration-map'))`)) {
    await click('#close-panel');
    await click('[data-open-panel="map"]');
  }
  await until(() => cdp.eval(`Boolean(document.querySelector('#exploration-map'))`), 'map visible');
}

async function screenshot(name) {
  await cdp.eval(`(async () => {
    await document.fonts?.ready;
    await Promise.race([
      Promise.all([...document.images].map(image => image.decode?.().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const png = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  const file = path.join(EVIDENCE, name);
  await writeFile(file, Buffer.from(png.data, 'base64'));
  console.log(`EVIDENCE ${file}`);
  return file;
}

async function clickMapSector(sectorId, { clicks=1, closeDuring=false, captureOpenTerrainTarget=false } = {}) {
  await openMap();
  const state = await campaign();
  const view = state.act1ExplorationView();
  const target = view.sectors.find(sector => sector.id === sectorId);
  check(target?.reachable === true || target?.discovered === true,
    `map destination ${sectorId} is a reachable neighbor or remembered sector`);
  const frontier = view.sectors.filter(sector => sector.reachable && !sector.discovered);
  const index = frontier.findIndex(sector => sector.id === sectorId);
  const selector = target.discovered
    ? `.landscape-sector[data-sector-id="${sectorId}"] .land-hit`
    : `.landscape-sector[data-frontier-index="${index}"] .land-hit`;
  const locate = () => cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const svg = document.querySelector('#exploration-map')?.getBoundingClientRect();
    const left=Math.max(rect.left, svg.left), right=Math.min(rect.right, svg.right);
    const top=Math.max(rect.top, svg.top), bottom=Math.min(rect.bottom, svg.bottom);
    const expect=${JSON.stringify(target.discovered ? sectorId : String(index))};
    const samples=[0.5,0.25,0.75,0.1,0.9];
    for (const fx of samples) for (const fy of samples) {
      const x=left+(right-left)*fx, y=top+(bottom-top)*fy;
      const element=document.elementFromPoint(x,y);
      const hit=element?.closest('.landscape-sector')?.getAttribute('data-sector-id') ??
        element?.closest('.landscape-sector')?.getAttribute('data-frontier-index') ?? null;
      if (hit===expect) return {x,y,hit,width:rect.width,height:rect.height};
    }
    return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2,
      width:rect.width,height:rect.height,svgTop:svg.top,svgBottom:svg.bottom,
      top:document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2)?.outerHTML?.slice(0,300),
      hit:null};
  })()`);
  let point = await locate();
  if (point?.hit !== (target.discovered ? sectorId : String(index))) {
    await click('#map-fit');
    point = await locate();
  }
  check(point.hit === (target.discovered ? sectorId : String(index)),
    `map target ${sectorId} receives the physical click (${JSON.stringify(point)})`);
  const openTerrainTarget = captureOpenTerrainTarget ? await cdp.eval(`(() => {
    const world=document.querySelector('#exploration-world');
    if(!world)return null;
    const inverse=world.getScreenCTM()?.inverse();
    if(!inverse)return null;
    const p=new DOMPoint(${point.x},${point.y}).matrixTransform(inverse);
    return {x:p.x,y:p.y};
  })()`) : null;
  const before = state.act1.exploration.currentSectorId;
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:point.x, y:point.y });
  for (let count = 1; count <= clicks; count += 1) {
    const params = { x:point.x, y:point.y, button:'left', clickCount:count };
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', ...params });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', ...params });
  }
  if (closeDuring) await click('#close-panel');
  await until(async () => {
    const after = await campaign();
    return after.act1.exploration.currentSectorId !== before
      && !await cdp.eval('window.__rotwDebug.explorationCommandLocked()');
  }, `physical map click completes movement from ${before} to ${sectorId}`, 30_000);
  const after = await campaign();
  check(after.act1.exploration.currentSectorId === sectorId,
    `physical map click reached ${sectorId} without teleporting elsewhere`);
  return openTerrainTarget;
}

async function clickLandmarkExit(sectorId) {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const before = await campaign();
    const point = await cdp.eval(`(() => {
      const node=document.querySelector(${JSON.stringify(`.land-exit-target[data-sector-id="${sectorId}"]`)});
      if(!node)return null;
      const rect=node.getBoundingClientRect(),svg=document.querySelector('#exploration-map')?.getBoundingClientRect();
      if(!svg)return null;
      for(const [fx,fy] of [[.5,.5],[.4,.5],[.6,.5],[.5,.4],[.5,.6],[.35,.5],[.65,.5]]) {
        const x=Math.max(svg.left,Math.min(svg.right,rect.left+rect.width*fx));
        const y=Math.max(svg.top,Math.min(svg.bottom,rect.top+rect.height*fy));
        const hit=document.elementFromPoint(x,y)?.closest('[data-landmark-exit]');
        if(hit?.dataset.sectorId===${JSON.stringify(sectorId)}) return {x,y,hit:hit.dataset.landmarkExit};
      }
      return null;
    })()`);
    if (!point) return false;
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x,y:point.y});
    await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
    await until(async () => {
      const after = await campaign();
      return after.act1.currentAreaId !== before.act1.currentAreaId
        || after.act1.exploration.currentSectorId !== before.act1.exploration.currentSectorId
        || Boolean(after.act1.exploration.activeBattle)
        || (!await cdp.eval('window.__rotwDebug.explorationCommandLocked()')
          && after.act1.exploration.movementSequence > before.act1.exploration.movementSequence);
    }, `visible landmark exit movement toward ${sectorId}`, 30_000);
    const after = await campaign();
    if (after.act1.currentAreaId !== before.act1.currentAreaId) return true;
    if (after.act1.exploration.activeBattle) {
      await resolveTravelEncounter();
      continue;
    }
    if (after.act1.exploration.currentSectorId === sectorId) {
      if (await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`)) {
        await resolveTravelEncounter();
        continue;
      }
      return true;
    }
    check(after.act1.exploration.movementSequence > before.act1.exploration.movementSequence,
      `the visible exit hotspot moves through open terrain toward ${sectorId}`);
  }
  throw new Error(`Landmark travel retry limit exceeded for ${sectorId}`);
}

function encounterKindAt(state, sectorId) {
  return state.act1ExplorationView().sectors.find(sector => sector.id === sectorId)?.encounter?.encounterKind ?? null;
}

function isEmptyNewMoorSector(state, sectorId) {
  const map = state.act1ExplorationMap();
  if (map.encounters.some(item => item.sectorId === sectorId)) return false;
  if (map.exits.some(item => item.sectorId === sectorId)) return true;
  return rollBloodMoorEncounter({ worldSeed: state.worldSeed, sectorId }).result.outcome === 'empty';
}

async function finishMapEncounter() {
  if (!await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`)) return false;
  const before = await campaign();
  const sectorId = before.act1.exploration.currentSectorId;
  const kind = encounterKindAt(before, sectorId);
  check(Boolean(kind), `the pending fight is attached to the current sector (${sectorId})`);
  await clickVisibleEncounterButton();
  await until(async () => (await snapshot()).phase === 'preparation', 'map encounter preparation');
  await winBattle();
  await until(() => cdp.eval(`Boolean(document.querySelector('#exploration-map'))`), 'map returned after encounter victory');
  const after = await campaign();
  check(after.act1.exploration.currentSectorId === sectorId
    && after.act1.exploration.activeBattle === null,
  `victory in ${sectorId} returns to the same cleared sector`);
  return { sectorId, kind };
}

async function resolveTravelEncounter() {
  if (await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`))
    await clickVisibleEncounterButton();
  await until(async () => Boolean((await campaign()).act1.exploration.activeBattle)
    && (await snapshot()).phase === 'preparation', 'travel encounter preparation');
  const before = await campaign();
  const battle = before.act1.exploration.activeBattle;
  check(Boolean(battle?.sectorId), 'a travel encounter is attached to its actual map sector');
  await winBattle();
  await until(async () => (await snapshot()).phase !== 'preparation'
    && await cdp.eval(`Boolean(document.querySelector('#exploration-map'))`), 'map returned after travel encounter');
  const after = await campaign();
  check(after.act1.exploration.currentSectorId === battle.sectorId
    && after.act1.exploration.activeBattle === null,
  `travel encounter victory returns to ${battle.sectorId} without moving the party`);
  check(after.act1.encounters[battle.encounterId]?.status === 'completed',
    `travel encounter in ${battle.sectorId} is saved as defeated`);
}

async function walkMap(targetId, forbidden = new Set(), {leaveEncounter=false} = {}) {
  for (let guard = 0; guard < 120; guard += 1) {
    const state = await campaign();
    const here = state.act1.exploration.currentSectorId;
    if (here === targetId) {
      if (!leaveEncounter && (state.act1.exploration.activeBattle
        || await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`))) {
        await resolveTravelEncounter();
        continue;
      }
      return;
    }
    if (state.act1.exploration.activeBattle) {
      await resolveTravelEncounter();
      continue;
    }
    if (await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`)) {
      await resolveTravelEncounter();
      continue;
    }
    const map = state.act1ExplorationMap();
    const allowed = new Set(map.sectors.map(sector => sector.id)
      .filter(id => !forbidden.has(id) || id === targetId || id === here));
    const route = shortestSectorPath(map, here, targetId, allowed);
    assert.ok(route?.length > 1, `No legal route from ${here} to ${targetId}`);
    const exitSector = map.exits.some(exit => exit.sectorId === targetId)
      && await cdp.eval(`Boolean(document.querySelector('.land-exit-target[data-sector-id="${targetId}"]'))`);
    const usedExit = exitSector && route[1] === targetId && await clickLandmarkExit(targetId);
    if (!usedExit) await clickMapSector(route[1]);
    const activeBattle = (await campaign()).act1.exploration.activeBattle;
    const encounterButton = await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`);
    if (route[1] !== targetId && (activeBattle || encounterButton)) await resolveTravelEncounter();
  }
  throw new Error(`Travel guard exceeded for ${targetId}`);
}

async function chooseInitialParty() {
  await until(() => cdp.eval(`Boolean(window.__rotwDebug?.snapshot)`), 'game ready');
  const selector = await cdp.eval(`document.querySelector('#team-selection-layer')?.getAttribute('aria-hidden') === 'false'`);
  if (!selector) return;
  const selected = await cdp.eval(`([...document.querySelectorAll('#team-selection-grid [aria-selected="true"]')]
    .map(card => card.dataset.heroId))`);
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of HERO_IDS) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click('#team-selection-confirm');
  await until(() => cdp.eval(`document.querySelector('#camp-layer')?.getAttribute('aria-hidden') === 'false'`), 'camp');
  check(JSON.stringify((await snapshot()).save.partyIds) === JSON.stringify(HERO_IDS),
    'battle acceptance uses the three known starter heroes');
}

function degree(map, id) {
  return map.edges.filter(edge => edge.a === id || edge.b === id).length;
}

async function clickOpenGround(target) {
  const before = await campaign();
  const exploration = before.act1.exploration;
  const from = exploration.currentPosition;
  const screen = await cdp.eval(`(() => {
    const world=document.querySelector('#exploration-world');
    const svg=document.querySelector('#exploration-map');
    const point=new DOMPoint(${target.x},${target.y}).matrixTransform(world.getScreenCTM());
    return {x:point.x,y:point.y,inMap:svg.getBoundingClientRect().toJSON()};
  })()`);
  check(screen.x >= screen.inMap.x && screen.x <= screen.inMap.x + screen.inMap.width
    && screen.y >= screen.inMap.y && screen.y <= screen.inMap.y + screen.inMap.height,
  'free-roam destination is inside the visible terrain');
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:screen.x,y:screen.y});
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:screen.x,y:screen.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:screen.x,y:screen.y,button:'left',clickCount:1});
  await until(async () => {
    const after = await campaign();
    return after.act1.exploration.movementSequence > exploration.movementSequence
      && !await cdp.eval('window.__rotwDebug.explorationCommandLocked()');
  }, 'free-roam point movement completes', 30_000);
  const after = await campaign();
  check(after.act1.exploration.currentSectorId === exploration.currentSectorId,
    'free-roam movement can stop inside the same logical sector');
  check(Math.hypot(after.act1.exploration.currentPosition.x-target.x,
    after.act1.exploration.currentPosition.y-target.y) < 1.5,
  `the party reaches the clicked terrain coordinate, not a node center (${JSON.stringify({target,actual:after.act1.exploration.currentPosition})})`);
}

async function firstOpenGroundJourney() {
  // Step away from the encampment portal first so the free-ground click cannot
  // overlap its intentionally large, dedicated exit hit area.
  await clickMapSector('sector-061');
  const state = await campaign();
  const map = state.act1ExplorationMap();
  const start = state.act1.exploration.currentSectorId;
  check(!await cdp.eval(`Boolean(document.querySelector('[data-travel-option]'))`),
    'open-ground movement is not presented as a sector-choice tree');
  const current = state.act1.exploration.currentSectorId;
  const from = state.act1.exploration.currentPosition;
  const center = explorationPoint(MOOR,map.sectors.find(sector=>sector.id===current));
  let target = null;
  for (let distance = 32; distance <= 72 && !target; distance += 8) {
    for (let angle = 0; angle < Math.PI*2; angle += Math.PI/8) {
      const candidate={x:from.x+Math.cos(angle)*distance,y:from.y+Math.sin(angle)*distance};
      const path=findOpenTerrainPath(map,from,candidate);
      if (openTerrainSectorAt(map,candidate)!==current
        || Math.hypot(candidate.x-center.x,candidate.y-center.y)<24
        || !path?.length||path.some(point=>openTerrainSectorAt(map,point)!==current)) continue;
      target=candidate;break;
    }
  }
  assert.ok(target,'a legal non-node point exists on the visible starting ground');
  await clickOpenGround(target);
  check(!await cdp.eval(`Boolean(document.querySelector('[data-travel-option]'))`),
    'ordinary open-ground movement remains direct and card-free');
  await screenshot('02-open-ground-free-movement.png');
  const latest = await campaign();
  const currentMap = latest.act1ExplorationMap();
  const special = new Set([
    ...currentMap.encounters.map(item => item.sectorId),
    ...currentMap.exits.map(item => item.sectorId),
    ...currentMap.points.map(item => item.sectorId),
  ]);
  const safeSector = sectorId => !special.has(sectorId) && isEmptyNewMoorSector(latest,sectorId);
  const choices = currentMap.sectors.filter(sector => degree(currentMap,sector.id)>=3)
    .map(sector=>({sector,route:shortestSectorPath(currentMap,latest.act1.exploration.currentSectorId,sector.id)}))
    .filter(({route})=>route?.length>=4&&route.slice(1).every(safeSector))
    .sort((a,b)=>a.route.length-b.route.length);
  assert.ok(choices.length,'a safe visible route reaches a later open-terrain region');
  const route=choices[0].route;
  for(let index=1;index<route.length;index+=1) {
    await clickMapSector(route[index]);
    if(index<route.length-1
      && await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`)) await finishMapEncounter();
    if(index===3) {
      const moved=await campaign();
      const startView=moved.act1ExplorationView().sectors.find(sector=>sector.id===start);
      check(startView.discovered&&!startView.visible,
        'the previously discovered starting region is remembered but dimmed');
      await screenshot('03-open-terrain-no-route-tree.png');
    }
  }
  check(!await cdp.eval(`Boolean(document.querySelector('[data-travel-option]'))`),
    'later open-ground exploration still exposes terrain, not route-choice cards');
}

async function edgeCaseChecks() {
  await openMap();
  const beforeTools = (await campaign()).toJSON();
  await click('#map-zoom-in');
  await click('#map-zoom-out');
  await click('#map-center');
  await click('#map-fit');
  const drag = await cdp.eval(`(() => {
    const box=document.querySelector('#exploration-map').getBoundingClientRect();
    return {x:box.left+box.width*.42,y:box.top+box.height*.55};
  })()`);
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:drag.x,y:drag.y});
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',x:drag.x,y:drag.y,button:'left',clickCount:1});
  for (let step = 1; step <= 4; step += 1) await cdp.send('Input.dispatchMouseEvent',
    {type:'mouseMoved',x:drag.x+step*9,y:drag.y+step*5,button:'left'});
  await cdp.send('Input.dispatchMouseEvent',
    {type:'mouseReleased',x:drag.x+36,y:drag.y+20,button:'left',clickCount:1});
  await delay(100);
  check(JSON.stringify((await campaign()).toJSON()) === JSON.stringify(beforeTools),
    'pan, zoom, center and fit modify only the camera, never the world');
  await click('#map-fit');

  const state = await campaign();
  const hidden = state.act1ExplorationView().sectors.find(sector => !sector.discovered && !sector.reachable);
  check(Boolean(hidden) && !await cdp.eval(`Boolean(document.querySelector('[data-sector-id="${hidden.id}"]'))`),
    'an illegal hidden sector has no public clickable target');
  const blank = await cdp.eval(`(() => {
    const svg=document.querySelector('#exploration-map'),box=svg.getBoundingClientRect();
    for(const fy of [.08,.16,.84,.92,.5])for(const fx of [.08,.16,.84,.92,.5]){
      const x=box.left+box.width*fx,y=box.top+box.height*fy;
      const top=document.elementFromPoint(x,y);
      if(top?.closest('#exploration-map')&&!top.closest('[data-sector-id],[data-frontier-index]'))return {x,y};
    }
    return null;
  })()`);
  check(Boolean(blank), 'the map exposes a physical blank or undiscovered area for illegal-click test');
  const beforeIllegal = (await campaign()).toJSON();
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',...blank});
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',...blank,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',...blank,button:'left',clickCount:1});
  await delay(150);
  check(JSON.stringify((await campaign()).toJSON()) === JSON.stringify(beforeIllegal),
    'physical click on illegal hidden terrain does not move the party');

  const map = state.act1ExplorationMap();
  const forbidden = new Set([...map.encounters.map(item=>item.sectorId),
    ...map.exits.map(item=>item.sectorId),...map.points.map(item=>item.sectorId)]);
  const currentSectorId = state.act1.exploration.currentSectorId;
  const neighbor = state.act1ExplorationView().sectors.find(sector => sector.reachable
    && map.edges.some(edge => (edge.a===currentSectorId&&edge.b===sector.id)
      || (edge.b===currentSectorId&&edge.a===sector.id))
    && !sector.current && !forbidden.has(sector.id) && isEmptyNewMoorSector(state, sector.id));
  assert.ok(neighbor, 'Need a safe adjacent region for double-click/close-during-animation checks');
  const initial = state.act1.exploration;
  const destination = await clickMapSector(neighbor.id,{clicks:2,captureOpenTerrainTarget:true});
  const planned = state.planAct1OpenTerrain(destination,{expectedAreaId:MOOR,
    expectedSectorId:initial.currentSectorId,expectedSequence:initial.movementSequence});
  await delay(300);
  const afterDouble = await campaign();
  const expectedSequence=initial.movementSequence+planned.pathPoints.length-1;
  const finalPosition=afterDouble.act1.exploration.currentPosition;
  const doubleClickSummary={from:initial.currentSectorId,to:neighbor.id,expectedSequence,
    actualSequence:afterDouble.act1.exploration.movementSequence,
    expectedPosition:destination,actualPosition:finalPosition};
  check(afterDouble.act1.exploration.currentSectorId === neighbor.id
    && afterDouble.act1.exploration.movementSequence === expectedSequence
    && Math.hypot(finalPosition.x-destination.x,finalPosition.y-destination.y)<1.5,
  `rapid physical double-click commits one open-terrain destination without chaining (${JSON.stringify(doubleClickSummary)})`);
  const returnBefore=await campaign();
  const returnDestination=await clickMapSector(initial.currentSectorId,
    {closeDuring:true,captureOpenTerrainTarget:true});
  const returnPlan=returnBefore.planAct1OpenTerrain(returnDestination,{expectedAreaId:MOOR,
    expectedSectorId:returnBefore.act1.exploration.currentSectorId,
    expectedSequence:returnBefore.act1.exploration.movementSequence});
  await openMap();
  const afterClose = await campaign();
  const expectedReturnSequence=returnBefore.act1.exploration.movementSequence+returnPlan.pathPoints.length-1;
  const returnPosition=afterClose.act1.exploration.currentPosition;
  const closeSummary={target:initial.currentSectorId,sector:afterClose.act1.exploration.currentSectorId,
    expectedSequence:expectedReturnSequence,actualSequence:afterClose.act1.exploration.movementSequence,
    expectedPosition:returnDestination,actualPosition:returnPosition,
    distance:Math.hypot(returnPosition.x-returnDestination.x,returnPosition.y-returnDestination.y)};
  check(afterClose.act1.exploration.currentSectorId === initial.currentSectorId
    && afterClose.act1.exploration.movementSequence === expectedReturnSequence,
  `closing map during movement commits once and reopening shows the same region (${JSON.stringify(closeSummary)})`);
}

function tacticalOptions(state, actorId, range) {
  const grid = HexGrid.restore(state.save.hexGrid);
  const actor = grid.positionOf(actorId);
  const campaignDrops = Object.values(state.save.campaign.act1.encounters)
    .flatMap(record=>record.drops ?? []);
  const groundDrops = [...campaignDrops,...state.save.encounterProgress.drops]
    .filter(drop => drop.status === 'ground');
  const loot = new Set(groundDrops
    .map(drop => `${drop.hex.q},${drop.hex.r}`));
  if(state.save.loot?.hex)loot.add(`${state.save.loot.hex.q},${state.save.loot.hex.r}`);
  const enemies = state.save.combat.units.filter(unit => unit.kind === 'monster' && unit.hp > 0)
    .map(unit => ({ id:unit.id, hp:unit.hp, position:grid.positionOf(unit.id) }));
  const fireFrom = (position, enemy) => hexDistance(position, enemy.position) <= range
    && grid.hasLineOfSight(position, enemy.position, {ignoreUnitIds:[actorId, enemy.id]})
    && (range === 1 || grid.hasProjectilePath(position, enemy.position, {ignoreUnitIds:[actorId, enemy.id]}));
  const visible = enemies.filter(enemy => fireFrom(actor, enemy))
    .sort((a,b) => a.hp-b.hp || hexDistance(actor,a.position)-hexDistance(actor,b.position));
  const moves = grid.reachable(actorId, 3)
    .filter(choice => choice.cost > 0 && !loot.has(`${choice.position.q},${choice.position.r}`))
    .map(choice => ({ ...choice,
      nearest:Math.min(...enemies.map(enemy => hexDistance(choice.position, enemy.position))),
      fire:enemies.some(enemy => fireFrom(choice.position, enemy)),
    }))
    .sort((a,b) => Number(b.fire)-Number(a.fire) || a.nearest-b.nearest || b.cost-a.cost);
  return { visible, moves };
}

async function clickHex(position, button = 'left') {
  const point = await cdp.eval(`(() => {
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
    const center = window.__rotwDebug.projectHex(${position.q},${position.r});
    if (!center) return null;
    const x=rect.left + center.x * rect.width / viewport.width;
    const y=rect.top + center.y * rect.height / viewport.height;
    const top=document.elementFromPoint(x,y);
    const hit=window.__rotwDebug.hitTestClient(x,y);
    return {x,y,canvasHit:top===canvas,hex:hit ? {q:hit.q,r:hit.r}:null,
      top:top?.outerHTML?.slice(0,180)};
  })()`);
  assert.ok(point, `Hex ${position.q},${position.r} not projected`);
  const legal = point.canvasHit && point.hex?.q === position.q && point.hex?.r === position.r;
  if (!hexGeometryChecked) {
    check(legal, `visible battlefield canvas hit-tests the legal hex ${position.q},${position.r} (${JSON.stringify(point)})`);
    hexGeometryChecked = true;
  } else assert.ok(legal, `Physical ${button} click misses legal hex ${position.q},${position.r}: ${JSON.stringify(point)}`);
  const params = { x:point.x,y:point.y,button,clickCount:1 };
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x,y:point.y});
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',...params});
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',...params});
  await delay(110);
}

async function chooseSkill(skillId, side = 'left') {
  const bound = await cdp.eval(`document.querySelector('#mouse-skill-${side}')?.dataset.skillId`);
  if (bound === skillId) return;
  await click(`#mouse-skill-${side}`);
  await click(`#mouse-skill-chooser [data-mouse-side="${side}"][data-skill-id="${skillId}"]`);
  check(await cdp.eval(`document.querySelector('#mouse-skill-${side}')?.dataset.skillId`) === skillId,
    `${side === 'left' ? 'LPM' : 'PPM'} is bound to the selected legal skill ${skillId}`);
}

async function checkBattleGuideLayout() {
  const state = await snapshot();
  const grid = HexGrid.restore(state.save.hexGrid);
  const positions = HERO_IDS.map(id => ({id,position:grid.positionOf(id)}));
  const layout = await cdp.eval(`(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    const canvas = document.querySelector('#scene').getBoundingClientRect();
    const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
    const heroes = ${JSON.stringify(positions)}.map(({id,position}) => {
      const point = window.__rotwDebug.projectHex(position.q,position.r);
      return {id,x:canvas.left + point.x * canvas.width / viewport.width,
        y:canvas.top + point.y * canvas.height / viewport.height};
    });
    const guide = document.querySelector('#battle-turn-guide');
    return {guideVisible:!guide.classList.contains('hidden'),guide:rect('#battle-turn-guide'),
      plate:rect('.enemy-plate'),heroes,guideCopy:document.querySelector('#battle-guide-copy')?.textContent,
      enemyName:document.querySelector('#enemy-name')?.textContent};
  })()`);
  const overlap = (a,b) => a.left < b.right && a.right > b.left
    && a.top < b.bottom && a.bottom > b.top;
  const heroBounds = layout.heroes.map(({id,x,y}) => ({id,left:x-60,right:x+60,top:y-125,bottom:y+45}));
  check(state.phase === 'active' && layout.guideVisible && layout.guideCopy?.length > 0,
    `the turn guide is visible at the beginning of an active player turn (${JSON.stringify(layout)})`);
  check(!overlap(layout.guide,layout.plate),
    `the turn guide does not cover the enemy nameplate (${JSON.stringify(layout)})`);
  check(heroBounds.every(bound => !overlap(layout.guide,bound)),
    `the turn guide does not cover any hero's visual space (${JSON.stringify({guide:layout.guide,heroBounds})})`);
  return layout;
}

async function winBattle() {
  await click('#start-battle');
  await until(async () => {
    const state = await snapshot();
    return state.phase === 'active' && HERO_IDS.includes(state.actingUnitId);
  }, 'active player turn');
  const idleStart = await snapshot();
  await delay(1500);
  const idleEnd = await snapshot();
  check(idleEnd.phase === 'active' && idleEnd.actingUnitId === idleStart.actingUnitId
    && JSON.stringify(idleEnd.save.combat) === JSON.stringify(idleStart.save.combat)
    && JSON.stringify(idleEnd.save.roster) === JSON.stringify(idleStart.save.roster),
  'active player turn and scheduler stay unchanged for 1.5 seconds without a command');
  const skills = { korgan:'barbarian.bash', isendra:'sorceress.fire_bolt', veyran:'warlock.miasma_bolt' };
  let attacks = 0;
  for (let turn = 0; turn < 180; turn += 1) {
    const state = await snapshot();
    if (state.phase === 'completed') break;
    const id = state.actingUnitId;
    assert.ok(HERO_IDS.includes(id), `Unexpected actor on turn ${turn}: ${id}`);
    const actor = state.save.roster.find(hero => hero.id === id);
    assert.ok(actor?.resources.hp > 0, `Actor ${id} is not alive`);
    if (state.save.inspectedCharacterId !== id) await click(`#party [data-character-id="${id}"]`);
    const skillCost={korgan:2,isendra:2.5,veyran:2}[id];
    let accepted = false;
    let lastDiagnostic = null;
    for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
      let mouseButton = null;
      let mouseSkillId = null;
      const before = await snapshot();
      if (before.phase === 'completed') { accepted = true; break; }
      if (before.actingUnitId !== id) break;
      const currentActor = before.save.roster.find(hero => hero.id === id);
      if (!currentActor || currentActor.resources.hp <= 0) break;
      const belt = before.save.belts.find(([heroId]) => heroId === id)?.[1] ?? [];
      const healthPotions = belt[0]?.count ?? 0;
      const manaPotions = belt[1]?.count ?? 0;
      const missingHp = currentActor.resources.maxHp - currentActor.resources.hp;
      const useHealthPotion = healthPotions > 0 && missingHp >= 6;
      const useManaPotion = !useHealthPotion && manaPotions > 0
        && currentActor.resources.mana < skillCost;

      if (useHealthPotion) await click('#potion-health');
      else if (useManaPotion) await click('#potion-mana');
      else {
        const range = id === 'korgan' ? 1 : 6;
        const options = tacticalOptions(before, id, range);
        if (options.visible.length && currentActor.resources.mana >= skillCost) {
          mouseButton = mouseCoverage.left > 0 && mouseCoverage.right === 0 ? 'right' : 'left';
          mouseSkillId = skills[id];
          await chooseSkill(mouseSkillId, mouseButton);
          const ready = await snapshot();
          if (ready.phase !== 'completed' && ready.actingUnitId === id) {
            await clickHex(options.visible[0].position, mouseButton);
            attacks += 1;
          }
        } else {
          const basicAttack = tacticalOptions(before, id, 1).visible;
          if (basicAttack.length) {
            mouseButton = mouseCoverage.left > 0 && mouseCoverage.right === 0 ? 'right' : 'left';
            mouseSkillId = 'basic.attack';
            await chooseSkill(mouseSkillId, mouseButton);
            const ready = await snapshot();
            if (ready.phase !== 'completed' && ready.actingUnitId === id) {
              await clickHex(basicAttack[0].position, mouseButton);
              attacks += 1;
            }
          } else if (options.moves.length) await clickHex(options.moves[0].position);
          else await click('#end-turn');
        }
      }

      const expectedSequence = before.save.combat.readiness.commandSequence;
      const wasAccepted = async () => {
        const after = await snapshot();
        if (after.phase === 'completed') return true;
        const commands = [
          ...(after.save.combat.commands.history ?? []),
          ...(after.save.combat.commands.active ?? []),
        ];
        const acceptedCommand = commands.some(command => {
          const sequence = Number(command.commandId?.match(/^command-(\d+)$/)?.[1]);
          return command.actorId === id && Number.isFinite(sequence) && sequence >= expectedSequence;
        });
        if (acceptedCommand) return true;
        lastDiagnostic = {
          expectedSequence,
          actualSequence: after.save.combat.readiness.commandSequence,
          actor: after.actingUnitId,
          input: await cdp.eval('window.__rotwDebug.inputState()'),
          toast: await cdp.eval("document.querySelector('#game-toast')?.textContent"),
        };
        return after.actingUnitId !== id;
      };
      try {
        await until(wasAccepted, `battle accepts ${id}'s action`, 3_500);
        accepted = true;
      } catch {
        const after = await snapshot();
        if (after.phase === 'completed') { accepted = true; break; }
        if (after.actingUnitId !== id) break;
        // A map redraw or a just-resolved enemy action can invalidate the
        // physical click. Re-read state and retry only while this hero is still
        // the authoritative ready actor.
        if (attempt === 2) {
          throw new Error(`Battle did not accept ${id}'s action after retries: ${JSON.stringify(lastDiagnostic)}`);
        }
      }
      if (accepted && mouseButton) {
        const action = await snapshot();
        const command = [...(action.save.combat.commands.history ?? []),
          ...(action.save.combat.commands.active ?? [])].find(item => {
          const sequence = Number(item.commandId?.match(/^command-(\d+)$/)?.[1]);
          return item.actorId === id && Number.isFinite(sequence)
            && sequence >= expectedSequence && item.payload?.skillId === mouseSkillId;
        });
        check(Boolean(command), `${mouseButton === 'left' ? 'LPM' : 'PPM'} physical click submits the bound skill ${mouseSkillId}`);
        mouseCoverage[mouseButton] += 1;
      }
    }
    if (!accepted && (await snapshot()).phase !== 'completed') continue;
  }
  const won = await snapshot();
  check(won.phase === 'completed' && attacks > 0,
    'the existing hex battle was actually won with UI commands');
  return won;
}

async function main() {
  await mkdir(EVIDENCE, { recursive:true });
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(PORT)],
    { windowsHide:true, stdio:['ignore','pipe','pipe'],
      env:{ ...process.env, ROTW_SAVE_FILE:path.join(TEST_SAVE_DIR, 'player-save.json') } });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/__rotw_health`)).json()).pid === server.pid; }
    catch { return false; }
  }, 'owned game server');
  browser = await launchTrackedBrowser({
    edgePath:process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    windowSize:`${WIDTH},${HEIGHT}`, appUrl:'about:blank',
    extraArgs:['--mute-audio','--no-sandbox','--disable-software-rasterizer','--disable-gpu-compositing'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  cdp = new Cdp(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    {width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate', {url:`http://127.0.0.1:${PORT}/?exploration-test=1&exploration-test-seed=${WORLD_SEED}`});
  await chooseInitialParty();
  const fresh = await snapshot();
  const freshXp = await cdp.eval(`({label:document.querySelector('#hud-xp-label')?.textContent,
    value:document.querySelector('.d2-xp-rail')?.getAttribute('aria-valuenow'),
    width:document.querySelector('#hud-xp-fill')?.style.width})`);
  check(HERO_IDS.every(id => fresh.save.roster.find(hero => hero.id === id)?.experience === 0)
    && freshXp.label === 'EXP 0%' && freshXp.value === '0' && freshXp.width === '0%',
  `fresh starter party shows genuine zero experience (${JSON.stringify(freshXp)})`);
  await screenshot('00-fresh-exp-zero.png');
  await click('[data-camp-action="gate"]');
  await until(async () => (await campaign()).act1.currentAreaId === MOOR, 'Blood Moor entry');
  await openMap();
  const start = await campaign();
  check(start.worldSeed === WORLD_SEED, 'the isolated browser session uses the controlled acceptance seed');
  check(start.act1ExplorationView().sectors.some(sector => !sector.discovered),
    'Blood Moor begins largely under undiscovered black fog');
  check(!await cdp.eval(`Boolean(document.querySelector('[data-area-exit="${DEN}"]'))`),
    'the Den entrance is absent from undiscovered map controls');
  await screenshot('01-moor-start-black-fog.png');

  await firstOpenGroundJourney();
  const forkState = await campaign();
  check(forkState.act1.exploration.currentSectorId === 'sector-069',
    'free-roam exploration reaches the deterministic open-terrain region');
  await edgeCaseChecks();

  const normalSector = 'sector-044';
  await walkMap(normalSector, new Set(), {leaveEncounter:true});
  check(encounterKindAt(await campaign(), normalSector) === 'normal'
    && await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`),
  'the ordinary random encounter appears at its seeded new sector');
  await checkPendingEncounter(normalSector);
  const normalXpBefore = (await snapshot()).save.roster;
  await screenshot('04-normal-encounter-on-map.png');
  await clickVisibleEncounterButton();
  await until(async () => (await snapshot()).phase === 'preparation', 'normal battle preparation');
  check((await campaign()).act1.exploration.activeBattle?.sectorId === normalSector,
    'the normal hex battle keeps its exact map sector identity');
  await screenshot('04b-normal-encounter-and-hex-battle.png');
  if (BATTLE_GUIDE_ONLY) {
    await click('#start-battle');
    await until(async () => {
      const state = await snapshot();
      return state.phase === 'active' && HERO_IDS.includes(state.actingUnitId);
    }, 'first active player turn for guide visual check');
    await delay(250);
    const layout = await checkBattleGuideLayout();
    await screenshot('04d-first-active-turn-guide.png');
    await writeFile(path.join(EVIDENCE, 'checks.json'), JSON.stringify({
      result:'PASS',mode:'battle-guide-only',viewport:`${WIDTH}x${HEIGHT}`,
      worldSeed:WORLD_SEED,checks,layout,
      screenshots:['04-normal-encounter-on-map.png','04b-normal-encounter-and-hex-battle.png',
        '04d-first-active-turn-guide.png'],
    },null,2));
    console.log(`PASS battle-guide visual check, screenshots in ${EVIDENCE}`);
    return;
  }
  await winBattle();
  await until(() => cdp.eval(`Boolean(document.querySelector('#exploration-map'))`), 'map returned after normal victory');
  const normalWin = await snapshot();
  const gained = HERO_IDS.map(id => ({id,
    before:normalXpBefore.find(hero => hero.id === id)?.experience,
    after:normalWin.save.roster.find(hero => hero.id === id)?.experience}));
  check(gained.every(item => item.after > item.before),
    `all active heroes gain EXP from the defeated group (${JSON.stringify(gained)})`);
  const inspected = normalWin.save.roster.find(hero => hero.id === normalWin.save.inspectedCharacterId);
  const expectedXp = characterExperienceSegments(inspected);
  const earnedXp = await cdp.eval(`({label:document.querySelector('#hud-xp-label')?.textContent,
    value:document.querySelector('.d2-xp-rail')?.getAttribute('aria-valuenow')})`);
  check(earnedXp.label === `EXP ${Math.round(expectedXp.percent)}%`
    && earnedXp.value === String(Math.round(expectedXp.percent)),
  `earned EXP is reflected by the visible HUD rail (${JSON.stringify(earnedXp)})`);
  await click('#close-panel');
  await screenshot('04c-earned-exp-after-victory.png');
  await openMap();
  const normalEncounterId = (await campaign()).act1.encounters[`act1.blood_moor.random.${normalSector}`];
  check(normalEncounterId?.status === 'completed', 'the ordinary random group is recorded as defeated');
  await walkMap('sector-052');
  await walkMap(normalSector);
  check(encounterKindAt(await campaign(), normalSector) === 'normal'
    && !await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`),
  'returning to the ordinary sector does not respawn its completed group');
  await screenshot('06-cleared-terrain-no-respawn.png');

  const championSector = 'sector-057';
  await walkMap(championSector, new Set(), {leaveEncounter:true});
  check(encounterKindAt(await campaign(), championSector) === 'champion'
    && await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`),
  'the seeded Champion group is a distinct exploration outcome');
  await checkPendingEncounter(championSector);
  await screenshot('05-champion-encounter-on-map.png');
  await clickVisibleEncounterButton();
  await until(async () => (await snapshot()).phase === 'preparation', 'Champion battle preparation');
  check((await campaign()).act1.encounters[`act1.blood_moor.random.${championSector}`]
    .defeatedIds.length === 0, 'the Champion encounter is persisted before battle resolution');
  await screenshot('05b-champion-encounter-and-hex-battle.png');
  await winBattle();
  await until(() => cdp.eval(`Boolean(document.querySelector('#exploration-map'))`), 'map returned after Champion victory');
  check((await campaign()).act1.encounters[`act1.blood_moor.random.${championSector}`]?.status === 'completed',
    'the Champion group is recorded as defeated');

  const map = (await campaign()).act1ExplorationMap();
  const denExit = map.exits.find(item => item.targetAreaId === DEN);
  const moorApproachPath = shortestSectorPath(map,
    (await campaign()).act1.exploration.currentSectorId, denExit.sectorId);
  assert.ok(moorApproachPath?.length > 1, 'the Den entrance has a discoverable approach');
  await walkMap(moorApproachPath.at(-2));
  check(await cdp.eval(`Boolean(document.querySelector('.land-exit-target[data-landmark-exit="${DEN}"][data-sector-id="${denExit.sectorId}"]'))`),
    'the discovered Den entrance has its real clickable world hotspot');
  await screenshot('06-den-entrance-discovered.png');
  await clickLandmarkExit(denExit.sectorId);
  await until(async () => (await campaign()).act1.currentAreaId === DEN, 'Den entry');
  await openMap();
  const caveStart = (await campaign()).act1.exploration.currentSectorId;
  for (let step = 0; step < 3; step += 1) {
    const state = await campaign();
    const forbidden = new Set(state.act1ExplorationMap().encounters.map(item => item.sectorId));
    const next = state.act1ExplorationView().sectors.find(sector => sector.reachable
      && !forbidden.has(sector.id) && !sector.exits.length);
    if (!next) break;
    await clickMapSector(next.id);
  }
  const inCave = await campaign();
  check(inCave.act1.exploration.areaStates[DEN].discoveredSectorIds.length
    < inCave.act1ExplorationMap().sectors.length,
  'the cave reveals chambers gradually, never the entire dungeon at once');
  await screenshot('07-den-cave-partly-explored.png');
  const caveExit = inCave.act1ExplorationMap().exits.find(item => item.targetAreaId === MOOR);
  const caveApproachPath = shortestSectorPath(inCave.act1ExplorationMap(),
    inCave.act1.exploration.currentSectorId, caveExit.sectorId);
  assert.ok(caveApproachPath?.length > 1, 'the cave exit has a discoverable approach');
  await walkMap(caveApproachPath.at(-2),
    new Set(inCave.act1ExplorationMap().encounters.map(item => item.sectorId)));
  check(await cdp.eval(`Boolean(document.querySelector('.land-exit-target[data-landmark-exit="${MOOR}"][data-sector-id="${caveExit.sectorId}"]'))`),
    'the cave exit is a visible clickable landmark');
  await clickLandmarkExit(caveExit.sectorId);
  await until(async () => (await campaign()).act1.currentAreaId === MOOR, 'Moor return');
  check((await campaign()).act1.exploration.areaStates[DEN].discoveredSectorIds.includes(caveStart),
    'the cave exit preserves discovery of the original chamber');
  const beforeReload = (await campaign()).toJSON();
  const rosterBeforeReload = (await snapshot()).save.roster;
  check(beforeReload.act1.exploration.currentSectorId === denExit.sectorId,
    'the cave returns to the exact Moor entrance sector');
  check(await cdp.eval(`window.__rotwDebug.saveGameState()`), 'native save succeeds');
  await cdp.send('Page.reload', {ignoreCache:true});
  await until(() => cdp.eval(`Boolean(window.__rotwDebug?.snapshot)`), 'reloaded game');
  check(await cdp.eval(`window.__rotwDebug.loadGameState()`),
    'the native Load action restores the persisted session after document reload');
  await openMap();
  const restored = await campaign();
  check(JSON.stringify(restored.toJSON()) === JSON.stringify(beforeReload),
    'real document reload preserves worldSeed, position, fog and defeated enemies');
  check(JSON.stringify((await snapshot()).save.roster) === JSON.stringify(rosterBeforeReload),
    'real document reload preserves every hero level and EXP value');
  await screenshot('08-after-save-and-reload.png');
  await walkMap(normalSector);
  check((await campaign()).act1.encounters[`act1.blood_moor.random.${normalSector}`]?.status === 'completed'
    && !await cdp.eval(`Boolean(document.querySelector('#start-map-encounter'))`),
    'saved and reloaded defeated sector remains clear after physical return');
  await screenshot('09-reloaded-cleared-sector-no-respawn.png');
  check(mouseCoverage.left > 0 && mouseCoverage.right > 0,
    `active battles accept both physical LPM and PPM skill attacks (${JSON.stringify(mouseCoverage)})`);
  check(cdp.errors.length === 0, `no uncaught browser errors: ${cdp.errors.join('; ')}`);
  await writeFile(path.join(EVIDENCE, 'checks.json'), JSON.stringify({
    result:'PASS',viewport:`${WIDTH}x${HEIGHT}`,worldSeed:WORLD_SEED,checks,
    screenshots:[
      '00-fresh-exp-zero.png','01-moor-start-black-fog.png','02-open-ground-free-movement.png','03-open-terrain-no-route-tree.png',
      '04-normal-encounter-on-map.png','05-champion-encounter-on-map.png',
      '06-cleared-terrain-no-respawn.png','06-den-entrance-discovered.png','07-den-cave-partly-explored.png',
      '08-after-save-and-reload.png','09-reloaded-cleared-sector-no-respawn.png',
    ],
    additionalScreenshots:['04b-normal-encounter-and-hex-battle.png','04c-earned-exp-after-victory.png','05b-champion-encounter-and-hex-battle.png'],
    mouseCoverage,
  }, null, 2));
  await rm(path.join(EVIDENCE, 'failure.json'), {force:true});
  await rm(path.join(EVIDENCE, 'failure.png'), {force:true});
  console.log(`PASS ${checks.length} checks, acceptance screenshots in ${EVIDENCE}`);
}

try { await main(); }
catch (error) {
  await mkdir(EVIDENCE, {recursive:true});
  if (cdp) await screenshot('failure.png').catch(() => {});
  const diagnostic = cdp ? await cdp.eval(`({
    snapshot:window.__rotwDebug?.snapshot(),
    inputState:window.__rotwDebug?.inputState(),
    toast:document.querySelector('#game-toast')?.textContent,
    map:Boolean(document.querySelector('#exploration-map')),
  })`).catch(() => null) : null;
  await writeFile(path.join(EVIDENCE, 'failure.json'), JSON.stringify({
    message:error.message,stack:error.stack,checks,diagnostic,
  }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (browser) await cleanupTrackedBrowser(browser);
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(TEST_SAVE_DIR, { recursive:true, force:true });
}
