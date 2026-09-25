// Isolated, off-screen acceptance for exploration and disk-backed Continue.
// Run from this project's root with Node 24+. Only this script's temporary
// ROTW_SAVE_FILE is writable by its game servers; no desktop launcher is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignState } from '../src/core/campaign.js';
import { shortestSectorPath } from '../src/core/exploration.js';
import { explorationPoint, findOpenTerrainPath, isOpenTerrainSegmentPassable,
  openTerrainSectorAt } from '../src/core/open-terrain.js';
import { HexGrid, hexDistance } from '../src/core/hex-grid.js';
import { EquipmentCatalog, requirementsFor } from '../src/core/equipment.js';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 1920;
const HEIGHT = 1080;
const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const HERO_IDS = ['korgan', 'isendra', 'veyran'];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 'world-save-acceptance', RUN_ID);
const checks = [];
const screenshots = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let tempRoot;
let saveFile;
let browser;
let server;
let cdp;
let firstPort;
let secondPort;
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
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(typeof event.data === 'string'
        ? event.data : Buffer.from(event.data).toString('utf8'));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params?.exceptionDetails?.exception?.description
          ?? message.params?.exceptionDetails?.text ?? 'Browser exception');
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
    this.pending.clear();
    this.socket.close();
  }
}

function check(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function until(predicate, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch { /* The page may be re-rendering. */ }
    await sleep(75);
  }
  throw new Error(`Timeout: ${label}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(port) {
  assert.ok(path.isAbsolute(saveFile) && saveFile.startsWith(tempRoot + path.sep));
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ROTW_SAVE_FILE: saveFile },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}/__rotw_health`, {
      signal: AbortSignal.timeout(1200),
    });
    const health = await response.json();
    return health.pid === child.pid && health.port === port
      && path.resolve(health.projectRoot).toLowerCase() === ROOT.toLowerCase()
      && health.saveApiVersion >= 1;
  }, `isolated server ${port}`);
  server = child;
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  if (child.exitCode === null) {
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([done, sleep(8_000).then(() => { throw new Error(`Server ${child.pid} did not exit`); })]);
  }
}

async function startBrowser(port) {
  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    appUrl: 'about:blank', windowSize: `${WIDTH},${HEIGHT}`,
    extraArgs: ['--mute-audio', '--no-sandbox', '--disable-software-rasterizer', '--disable-gpu-compositing'],
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })).json();
  const page = targets.find(target => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Headless browser page target');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('rotw.music.volume.v1', '0'); } catch {}",
  });
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await until(() => cdp.eval("document.readyState === 'complete' && Boolean(window.__rotwDebug?.snapshot)"),
    `game on port ${port}`);
}

async function stopBrowser() {
  cdp?.close();
  cdp = null;
  if (browser) await cleanupTrackedBrowser(browser);
  browser = null;
}

async function mouse(x, y) {
  const button = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button });
}

async function click(selector) {
  const point = await cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
    });
    if (!node) return { error: nodes.length ? 'not visible' : 'missing' };
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, width: rect.width, height: rect.height, disabled: Boolean(node.disabled),
      hit: node === top || node.contains(top), visible: getComputedStyle(node).visibility !== 'hidden' };
  })()`);
  assert.ok(point?.width > 0 && point.height > 0 && point.visible && point.hit && !point.disabled,
    `Physical click target ${selector}: ${JSON.stringify(point)}`);
  await mouse(point.x, point.y);
}

async function screenshot(name) {
  await cdp.eval(`(async () => {
    await document.fonts?.ready;
    await Promise.race([Promise.all([...document.images].map(image => image.decode?.().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 4000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const image = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(path.join(EVIDENCE, name), Buffer.from(image.data, 'base64'));
  screenshots.push(name);
  console.log(`SCREENSHOT ${name}`);
}

const snapshot = () => cdp.eval('window.__rotwDebug.snapshot()');
async function campaign() {
  return CampaignState.restoreAct1((await snapshot()).save.campaign);
}

async function openMap() {
  if (await cdp.eval("Boolean(document.querySelector('#exploration-map'))")) return;
  const panelOpen = await cdp.eval("document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false'");
  if (panelOpen) await click('#close-panel');
  const camp = await cdp.eval("document.querySelector('#camp-layer')?.getAttribute('aria-hidden') === 'false'");
  await click(camp ? '#camp-open-map' : '[data-open-panel="map"]');
  await until(() => cdp.eval("Boolean(document.querySelector('#exploration-map'))"), 'map visible');
}

async function worldPointToClient(point, { fit = false } = {}) {
  await openMap();
  if (fit) await click('#map-fit');
  return cdp.eval(`(() => {
    const world = document.querySelector('#exploration-world');
    const map = document.querySelector('#exploration-map');
    const point = new DOMPoint(${point.x}, ${point.y}).matrixTransform(world.getScreenCTM());
    const box = map.getBoundingClientRect();
    const top = document.elementFromPoint(point.x, point.y);
    return { x: point.x, y: point.y, inside: point.x > box.left + 3 && point.x < box.right - 3
      && point.y > box.top + 3 && point.y < box.bottom - 3,
      mapHit: Boolean(top?.closest('#exploration-map')) };
  })()`);
}

async function clickMoorPoint(point, { stopAtSector = null } = {}) {
  let client = await worldPointToClient(point);
  if (!client.inside || !client.mapHit) client = await worldPointToClient(point, { fit: true });
  assert.ok(client.inside && client.mapHit, `Moor point is physically clickable: ${JSON.stringify({ point, client })}`);
  const before = (await campaign()).act1.exploration.movementSequence;
  await mouse(client.x, client.y);
  await until(async () => (await campaign()).act1.exploration.movementSequence > before,
    `open terrain click ${point.x},${point.y}`, 25_000);
  // The point-click route may consist of many committed steps.
  await until(async () => {
    const state = (await campaign()).act1.exploration;
    const phase = (await snapshot()).phase;
    // CDP mouse coordinates are rounded to device pixels before SVG inversion.
    return Math.hypot(state.currentPosition.x - point.x, state.currentPosition.y - point.y) < 3
      || (stopAtSector && state.currentSectorId === stopAtSector)
      || phase === 'preparation';
  }, `open terrain walk settles at ${point.x},${point.y}`, 45_000);
  if (stopAtSector) await sleep(120);
}

function specialSectorIds(map) {
  return new Set([
    ...map.encounters.map(item => item.sectorId),
    ...map.exits.map(item => item.sectorId),
    ...map.points.map(item => item.sectorId),
  ]);
}

function safePointInSector(state, sectorId) {
  const map = state.act1ExplorationMap();
  const sector = map.sectors.find(item => item.id === sectorId);
  assert.ok(sector, `Sector ${sectorId} exists`);
  const center = explorationPoint(MOOR, sector);
  const current = state.act1.exploration;
  for (const [dx, dy] of [[24, 18], [-24, 18], [19, -21], [-19, -21], [0, 0],
    [12, 12], [-12, 12], [12, -12], [-12, -12], [36, 0], [-36, 0], [0, 36], [0, -36]]) {
    const candidate = { x: center.x + dx, y: center.y + dy };
    if (openTerrainSectorAt(map, candidate) !== sectorId
      || !findOpenTerrainPath(map, current.currentPosition, candidate)) continue;
    try {
      const plan = state.planAct1OpenTerrain(candidate, {
        expectedAreaId: MOOR, expectedSectorId: current.currentSectorId,
        expectedSequence: current.movementSequence,
      });
      if (plan.pathPoints.some((to, index) => index > 0
        && (Math.hypot(to.x - plan.pathPoints[index - 1].x,
          to.y - plan.pathPoints[index - 1].y) > 24 + 1e-7
          || !isOpenTerrainSegmentPassable(map, plan.pathPoints[index - 1], to)))) continue;
      const end = plan.pathPoints.at(-1);
      if (Math.hypot(end.x - candidate.x, end.y - candidate.y) < 1
        || openTerrainSectorAt(map, end) === sectorId) return candidate;
    } catch { /* Try another point. */ }
  }
  throw new Error(`No safe point-click target for ${sectorId}`);
}

async function walkMoorRoute(targetId, { forbidden = new Set() } = {}) {
  for (let guard = 0; guard < 90; guard += 1) {
    const state = await campaign();
    const here = state.act1.exploration.currentSectorId;
    if (here === targetId) return;
    const map = state.act1ExplorationMap();
    const allowed = new Set(map.sectors.map(item => item.id)
      .filter(id => !forbidden.has(id) || id === here || id === targetId));
    const route = shortestSectorPath(map, here, targetId, allowed);
    assert.ok(route?.length > 1, `No safe Moor route from ${here} to ${targetId}`);
    const next = route[1];
    const target = safePointInSector(state, next);
    await clickMoorPoint(target, { stopAtSector: specialSectorIds(map).has(next) ? next : null });
    const after = await campaign();
    assert.equal(after.act1.exploration.currentSectorId, next, `Walk reached ${next}`);
  }
  throw new Error(`Moor route guard exceeded for ${targetId}`);
}

async function clickDenSector(sectorId) {
  await openMap();
  const state = await campaign();
  const view = state.act1ExplorationView();
  const target = view.sectors.find(item => item.id === sectorId);
  check(Boolean(target?.reachable || target?.discovered), `Den sector ${sectorId} may be selected`);
  const frontier = view.sectors.filter(item => item.reachable && !item.discovered);
  const index = frontier.findIndex(item => item.id === sectorId);
  const selector = target.discovered
    ? `.landscape-sector[data-sector-id="${sectorId}"] .land-hit`
    : `.landscape-sector[data-frontier-index="${index}"] .land-hit`;
  let point = await cdp.eval(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point || !await cdp.eval(`Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest('.landscape-sector'))`)) {
    await click('#map-fit');
    point = await cdp.eval(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
  }
  assert.ok(point, `Den physical target ${sectorId}`);
  await mouse(point.x, point.y);
  await until(async () => (await campaign()).act1.exploration.currentSectorId === sectorId,
    `Den reaches ${sectorId}`, 20_000);
}

function tacticalOptions(state, actorId, range) {
  const grid = HexGrid.restore(state.save.hexGrid);
  const actor = grid.positionOf(actorId);
  const encounter = state.save.campaign.act1.encounters[state.save.campaign.act1.currentEncounterId];
  const loot = new Set(encounter.drops.filter(drop => drop.status === 'ground')
    .map(drop => `${drop.hex.q},${drop.hex.r}`));
  const enemies = state.save.combat.units.filter(unit => unit.kind === 'monster' && unit.hp > 0)
    .map(unit => ({ id: unit.id, hp: unit.hp, position: grid.positionOf(unit.id) }));
  const fireFrom = (position, enemy) => hexDistance(position, enemy.position) <= range
    && grid.hasLineOfSight(position, enemy.position, { ignoreUnitIds: [actorId, enemy.id] })
    && (range === 1 || grid.hasProjectilePath(position, enemy.position, { ignoreUnitIds: [actorId, enemy.id] }));
  const visible = enemies.filter(enemy => fireFrom(actor, enemy))
    .sort((a, b) => a.hp - b.hp || hexDistance(actor, a.position) - hexDistance(actor, b.position));
  const moves = grid.reachable(actorId, 3)
    .filter(choice => choice.cost > 0 && !loot.has(`${choice.position.q},${choice.position.r}`))
    .map(choice => ({ ...choice, nearest: Math.min(...enemies.map(enemy => hexDistance(choice.position, enemy.position))),
      fire: enemies.some(enemy => fireFrom(choice.position, enemy)) }))
    .sort((a, b) => Number(b.fire) - Number(a.fire) || a.nearest - b.nearest || b.cost - a.cost);
  return { visible, moves };
}

async function clickHex(position) {
  const point = await cdp.eval(`(() => {
    const rect = document.querySelector('#scene').getBoundingClientRect();
    const viewport = window.__rotwDebug.battlefieldGeometry().viewport;
    const center = window.__rotwDebug.projectHex(${position.q}, ${position.r});
    return center ? { x: rect.left + center.x * rect.width / viewport.width,
      y: rect.top + center.y * rect.height / viewport.height } : null;
  })()`);
  assert.ok(point, `Battle hex ${position.q},${position.r}`);
  await mouse(point.x, point.y);
  await sleep(90);
}

async function chooseSkill(skillId) {
  const bound = await cdp.eval("document.querySelector('#mouse-skill-left')?.dataset.skillId");
  if (bound === skillId) return;
  await click('#mouse-skill-left');
  await click(`#mouse-skill-chooser [data-skill-id="${skillId}"]`);
}

async function winBattle() {
  await click('#start-battle');
  await until(async () => (await snapshot()).phase === 'active', 'active battle');
  const skills = { korgan: 'barbarian.bash', isendra: 'sorceress.fire_bolt', veyran: 'warlock.miasma_bolt' };
  let attacks = 0;
  for (let turn = 0; turn < 360; turn += 1) {
    const state = await snapshot();
    if (state.phase === 'completed') break;
    const id = state.actingUnitId;
    assert.ok(HERO_IDS.includes(id), `Unexpected acting unit ${id} at turn ${turn}`);
    const actor = state.save.roster.find(hero => hero.id === id);
    assert.ok(actor?.resources.hp > 0, `Actor ${id} alive`);
    if (state.save.inspectedCharacterId !== id) await click(`#party [data-character-id="${id}"]`);
    const canCast = actor.resources.mana >= (id === 'korgan' ? 2 : 4);
    const skill = canCast ? skills[id] : 'basic.attack';
    const options = tacticalOptions(state, id, id === 'korgan' || !canCast ? 1 : 6);
    if (options.visible.length) {
      await chooseSkill(skill);
      await clickHex(options.visible[0].position);
      attacks += 1;
    } else if (options.moves.length) await clickHex(options.moves[0].position);
    else await click('#end-turn');
  }
  check((await snapshot()).phase === 'completed' && attacks > 0, 'Encounter won with real battle controls');
  await until(() => cdp.eval("Boolean(document.querySelector('#exploration-map'))"), 'return to map after battle');
}

function comparable(save) {
  return {
    schemaVersion: save.schemaVersion,
    partyIds: save.partyIds,
    inspectedCharacterId: save.inspectedCharacterId,
    creationProfile: save.creationProfile,
    roster: save.roster,
    inventories: save.inventories,
    belts: save.belts,
    weaponSets: save.weaponSets,
    campaign: save.campaign,
    encounterProgress: save.encounterProgress,
    horadricCube: save.horadricCube,
  };
}

async function diskSave() {
  const response = await fetch(`http://127.0.0.1:${serverPort()}/__rotw_save`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.primary ? JSON.parse(body.primary) : null;
}

function serverPort() { return server === null ? null : (server === firstServer ? firstPort : secondPort); }
let firstServer;

async function main() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rotw-world-save-'));
  saveFile = path.join(tempRoot, 'test-save-v3.json');
  check(path.resolve(saveFile).toLowerCase() !== path.join(ROOT, 'work', 'player-save-v3.json').toLowerCase(),
    'Test save path is separate from the player save');
  await mkdir(EVIDENCE, { recursive: true });
  firstPort = await freePort();
  await startServer(firstPort);
  firstServer = server;
  await startBrowser(firstPort);
  check(await cdp.eval("document.querySelector('#main-menu')?.getAttribute('aria-hidden') === 'false'"),
    'Fresh title menu visible');
  await until(() => cdp.eval("document.querySelector('#menu-continue')?.disabled === true"),
    'Continue disabled without a save');
  await screenshot('01-fresh-title.png');

  await click('#menu-new-game');
  await until(() => cdp.eval("document.querySelector('#character-creation')?.getAttribute('aria-hidden') === 'false'"),
    'character creation visible');
  for (const id of HERO_IDS) await click(`.character-creation-class[data-hero-id="${id}"]`);
  await click('#character-creation-confirm');
  await until(() => cdp.eval("document.querySelector('#camp-layer')?.getAttribute('aria-hidden') === 'false'"),
    'new team in camp');
  check(JSON.stringify((await snapshot()).save.partyIds) === JSON.stringify(HERO_IDS),
    'Three starter heroes selected');

  await click('#camp-open-inventory');
  await until(() => cdp.eval("Boolean(document.querySelector('#inventory-grid [data-item-tooltip=true], #equipment-slots [data-item-tooltip=true]'))"),
    'starter item in inventory');
  const tooltipTarget = await cdp.eval(`(() => {
    const node = document.querySelector('#inventory-grid [data-item-tooltip=true], #equipment-slots [data-item-tooltip=true]');
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, itemId: node.dataset.itemId };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tooltipTarget.x, y: tooltipTarget.y });
  const tooltip = await until(() => cdp.eval(`(() => {
    const node = document.querySelector('#rotw-item-tooltip.is-visible:not([hidden])');
    if (!node) return null;
    return { name: node.querySelector('.rotw-item-tooltip-name')?.textContent,
      rows: node.querySelectorAll('.rotw-item-tooltip-row').length,
      footprint: node.querySelector('.rotw-item-tooltip-footprint')?.textContent,
      width: node.getBoundingClientRect().width };
  })()`), 'visible item tooltip');
  check(tooltip.name?.length > 0 && tooltip.rows > 0 && tooltip.footprint?.includes('Miejsce:')
    && tooltip.width >= 160, 'Readable data-backed item tooltip', tooltip);
  await screenshot('02-item-tooltip.png');
  await click('#close-panel');

  await click('#camp-open-map');
  await click('#map-akara');
  await click('#akara-accept');
  check((await campaign()).denQuestView().status === 'active',
    'Den quest accepted through its real camp UI');
  await click('#close-panel');

  await click('[data-camp-action="gate"]');
  await until(async () => (await campaign()).act1.currentAreaId === MOOR, 'Blood Moor entry');
  await openMap();
  const start = await campaign();
  const startView = start.act1ExplorationView();
  const startCount = startView.sectors.filter(item => item.discovered).length;
  check(startCount < startView.sectors.length, 'Moor has undiscovered fog');
  const marker = await cdp.eval(`(() => {
    const node = document.querySelector('.party-map-figure');
    return node ? { width: Number(node.getAttribute('width')), height: Number(node.getAttribute('height')),
      rendered: node.getBoundingClientRect().width } : null;
  })()`);
  check(marker?.width === 26 && marker.height === 36 && marker.rendered > 0,
    'Small party marker is visible on Moor terrain', marker);
  await screenshot('03-moor-marker-and-fog.png');

  const current = start.act1.exploration;
  const initialSector = startView.sectors.find(item => item.current);
  const center = explorationPoint(MOOR, initialSector);
  const offPath = [[38, 22], [-38, 22], [38, -22], [-38, -22], [60, 0], [-60, 0]]
    .map(([dx, dy]) => ({ x: center.x + dx, y: center.y + dy }))
    .find(point => openTerrainSectorAt(startView.map, point) === initialSector.id
      && findOpenTerrainPath(startView.map, current.currentPosition, point));
  assert.ok(offPath, 'A walkable off-center point exists');
  await clickMoorPoint(offPath);
  check(Math.hypot((await campaign()).act1.exploration.currentPosition.x - center.x,
    (await campaign()).act1.exploration.currentPosition.y - center.y) > 10,
  'Moor movement lands at a point away from the old sector center');
  const afterOffPath = await campaign();
  const map = afterOffPath.act1ExplorationMap();
  const specials = specialSectorIds(map);
  const routes = map.sectors.map(sector => shortestSectorPath(map, afterOffPath.act1.exploration.currentSectorId,
    sector.id, new Set(map.sectors.map(item => item.id)
      .filter(id => !specials.has(id) || id === afterOffPath.act1.exploration.currentSectorId))))
    .filter(route => route?.length >= 2)
    .sort((a, b) => b.length - a.length);
  assert.ok(routes.length, 'At least one safe neighboring sector exists');
  for (const sectorId of routes[0].slice(1)) await walkMoorRoute(sectorId, { forbidden: specials });
  const afterFog = await campaign();
  check(afterFog.act1ExplorationView().sectors.filter(item => item.discovered).length > startCount,
    'Point-click journey discovers new terrain');
  await screenshot('04-new-fog-discovered.png');

  const battleMap = afterFog.act1ExplorationMap();
  const here = afterFog.act1.exploration.currentSectorId;
  const options = battleMap.encounters.map(item => {
    const banned = new Set([...specialSectorIds(battleMap)].filter(id => id !== item.sectorId));
    const allowed = new Set(battleMap.sectors.map(sector => sector.id)
      .filter(id => !banned.has(id) || id === here));
    return { item, path: shortestSectorPath(battleMap, here, item.sectorId, allowed) };
  }).filter(option => option.path?.length > 1).sort((a, b) => a.path.length - b.path.length);
  assert.ok(options.length, 'Reachable encounter on a safe route');
  const encounter = options[0].item;
  await walkMoorRoute(encounter.sectorId, {
    forbidden: new Set([...specialSectorIds(battleMap)].filter(id => id !== encounter.sectorId)),
  });
  await until(async () => (await snapshot()).phase === 'preparation', 'encounter preparation');
  check((await campaign()).act1.exploration.activeBattle?.sectorId === encounter.sectorId,
    'Encounter is tied to the clicked Moor sector');
  await screenshot('05-encounter-preparation.png');
  await winBattle();
  const won = await campaign();
  check(won.act1.encounters[encounter.encounterId]?.status === 'completed'
    && won.act1.exploration.currentSectorId === encounter.sectorId,
  'Victory returns to the same sector and marks enemy defeated');
  const drops = won.act1.encounters[encounter.encounterId].drops.filter(drop => drop.status === 'ground');
  const catalog = new EquipmentCatalog(JSON.parse(await readFile(path.join(ROOT, 'data', 'equipment.v051.json'), 'utf8')));
  const korgan = (await snapshot()).save.roster.find(hero => hero.id === 'korgan');
  const usableDrops = drops.filter(drop => {
    const definition = catalog.get(drop.item.canonicalId);
    return definition && ['weapon', 'head', 'offhand', 'chest', 'hands', 'belt', 'feet'].includes(definition.slot)
      && requirementsFor(korgan, definition).length === 0;
  }).sort((a, b) => Number(b.item.canonicalId === 'short_sword') - Number(a.item.canonicalId === 'short_sword'));
  assert.ok(usableDrops.length, `No equipable drop for Korgan: ${drops.map(drop => drop.item.canonicalId).join(', ')}`);
  const drop = usableDrops[0];
  const slot = catalog.get(drop.item.canonicalId).slot;
  await click('#map-loot');
  check((await cdp.eval("document.querySelector('#loot-owner-tabs button:first-child')?.textContent.trim()")) === 'Korgan',
    'Korgan is the loot recipient');
  await click('#loot-owner-tabs button:first-child');
  await click(`[data-pickup="${drop.id}"]`);
  check((await snapshot()).save.inventories.find(([id]) => id === 'korgan')[1].items
    .some(item => item.id === drop.id), 'Real monster drop picked up into Korgan backpack');
  await click('#loot-open-inventory');
  await click('#equipment-owner-tabs button:first-child');
  await click(`#inventory-grid [data-item-id="${drop.id}"]`);
  await click('#equipment-action');
  check((await snapshot()).save.roster.find(hero => hero.id === 'korgan').equipment[slot]?.id === drop.id,
    'Picked-up monster drop equipped through inventory UI');
  await click('#close-panel');
  await openMap();
  const safeNeighbor = won.act1ExplorationView().sectors.find(item => item.reachable && !item.current
    && !specialSectorIds(won.act1ExplorationMap()).has(item.id));
  assert.ok(safeNeighbor, 'Safe sector for no-respawn revisit');
  await walkMoorRoute(safeNeighbor.id, { forbidden: specialSectorIds(won.act1ExplorationMap()) });
  await walkMoorRoute(encounter.sectorId, {
    forbidden: new Set([...specialSectorIds(won.act1ExplorationMap())].filter(id => id !== encounter.sectorId)),
  });
  check((await campaign()).act1.encounters[encounter.encounterId].status === 'completed'
    && (await snapshot()).phase !== 'preparation'
    && !await cdp.eval("Boolean(document.querySelector('#start-map-encounter'))"),
  'Defeated enemy does not respawn when its sector is revisited');
  await screenshot('06-defeated-no-respawn.png');

  const stateToDen = await campaign();
  const denExit = stateToDen.act1ExplorationMap().exits.find(item => item.targetAreaId === DEN);
  assert.ok(denExit, 'Den entrance on Moor map');
  await walkMoorRoute(denExit.sectorId, {
    forbidden: new Set([...specialSectorIds(stateToDen.act1ExplorationMap())].filter(id => id !== denExit.sectorId)),
  });
  await click(`[data-area-exit="${DEN}"]`);
  await until(async () => (await campaign()).act1.currentAreaId === DEN, 'Den entry');
  await openMap();
  const caveStart = await campaign();
  const caveMap = caveStart.act1ExplorationMap();
  const caveSpecial = specialSectorIds(caveMap);
  const nextCave = caveStart.act1ExplorationView().sectors.find(item => item.reachable && !item.current
    && !caveSpecial.has(item.id));
  assert.ok(nextCave, 'Safe reachable cave chamber');
  await clickDenSector(nextCave.id);
  const caveAfterMove = await campaign();
  check(caveAfterMove.act1.exploration.areaStates[DEN].discoveredSectorIds.length < caveMap.sectors.length,
    'Cave reveals only reachable chambers');
  const hidden = caveAfterMove.act1ExplorationView().sectors.find(item => !item.discovered && !item.reachable);
  assert.ok(hidden, 'Cave retains inaccessible hidden chamber');
  check(!await cdp.eval(`Boolean(document.querySelector('[data-sector-id="${hidden.id}"]'))`),
    'Hidden cave chamber has no clickable sector target');
  await screenshot('07-cave-restricted-path.png');

  const caveHere = caveAfterMove.act1.exploration.currentSectorId;
  const caveOptions = caveMap.encounters.map(item => {
    const blocked = new Set([...caveSpecial].filter(id => id !== item.sectorId));
    const allowed = new Set(caveMap.sectors.map(sector => sector.id)
      .filter(id => !blocked.has(id) || id === caveHere));
    return { item, route: shortestSectorPath(caveMap, caveHere, item.sectorId, allowed) };
  }).filter(option => option.route?.length > 1).sort((a, b) => a.route.length - b.route.length);
  assert.ok(caveOptions.length, 'Reachable Den quest encounter');
  const denEncounter = caveOptions[0].item;
  for (const sectorId of caveOptions[0].route.slice(1)) await clickDenSector(sectorId);
  await click('#start-map-encounter');
  await until(async () => (await snapshot()).phase === 'preparation', 'Den encounter preparation');
  await winBattle();
  const denVictory = await campaign();
  const quest = denVictory.denQuestView();
  check(denVictory.act1.encounters[denEncounter.encounterId]?.status === 'completed'
    && quest.status === 'active' && quest.killed >= 6 && quest.killed < quest.total,
  'First Den fight records a real partial quest objective', quest);
  await click('#close-panel');
  await click('[data-open-panel="quests"]');
  check(await cdp.eval("document.querySelector('#den-quest-progress')?.textContent.includes('6/30')"),
    'Quest journal displays six of thirty Den kills');

  const beforeClose = (await snapshot()).save;
  await click('#close-panel');
  await click('#save');
  await until(async () => {
    const persisted = await diskSave();
    return persisted && JSON.stringify(comparable(persisted)) === JSON.stringify(comparable(beforeClose));
  }, 'disk save contains explored cave and defeated enemy', 20_000);
  await openMap();
  await click('#map-center');
  await sleep(750);
  const beforeCloseMapTransform = await cdp.eval("document.querySelector('#exploration-world')?.getAttribute('transform')");
  await screenshot('08-before-close.png');
  const persisted = await diskSave();
  check(persisted.campaign.act1.currentAreaId === DEN
    && persisted.campaign.act1.encounters[encounter.encounterId]?.status === 'completed',
  'Disk envelope retains cave position and defeated encounter');
  const profile1 = browser.profileDirectory;
  await stopBrowser();
  await stopServer();

  secondPort = await freePort();
  while (secondPort === firstPort) secondPort = await freePort();
  await startServer(secondPort);
  await startBrowser(secondPort);
  check(browser.profileDirectory !== profile1 && secondPort !== firstPort,
    'Second run has a new browser profile and a different server port');
  const localKey = await cdp.eval('window.__rotwDebug.storageKeys.current');
  check(await cdp.eval(`localStorage.getItem(${JSON.stringify(localKey)}) === null`),
    'Second origin has no browser-local save');
  await until(() => cdp.eval("document.querySelector('#menu-continue')?.disabled === false"),
    'Continue enabled from disk on a new port');
  await screenshot('09-restarted-continue.png');
  await click('#menu-continue');
  await until(() => cdp.eval("document.querySelector('#main-menu')?.getAttribute('aria-hidden') === 'true'"),
    'Continue closes title menu');
  const resumed = (await snapshot()).save;
  check(JSON.stringify(comparable(resumed)) === JSON.stringify(comparable(persisted)),
    'Continued world, heroes, inventory, and encounter match saved envelope');
  await openMap();
  await click('#map-center');
  await sleep(750);
  check(await cdp.eval("document.querySelector('#exploration-world')?.getAttribute('transform')") === beforeCloseMapTransform,
    'Before-close and Continue maps have the same camera view');
  check((await campaign()).act1.currentAreaId === DEN
    && (await campaign()).act1.exploration.currentSectorId === persisted.campaign.act1.exploration.currentSectorId,
  'Continue returns to the same cave chamber');
  await screenshot('10-after-continue.png');
  check(cdp.errors.length === 0, 'No uncaught browser exceptions', cdp.errors);
  await writeFile(path.join(EVIDENCE, 'checks.json'), JSON.stringify({
    result: 'PASS', viewport: `${WIDTH}x${HEIGHT}`, ports: [firstPort, secondPort],
    checks, screenshots, saveFile: 'isolated temporary file removed after run',
  }, null, 2));
  console.log(`PASS ${checks.length} checks; ${screenshots.length} real screenshots in ${EVIDENCE}`);
}

try { await main(); }
catch (error) {
  await mkdir(EVIDENCE, { recursive: true });
  const diagnostic = cdp ? await cdp.eval(`({
    menu: document.querySelector('#main-menu')?.getAttribute('aria-hidden'),
    panel: document.querySelector('#panel-title')?.textContent,
    map: Boolean(document.querySelector('#exploration-map')),
    tooltip: document.querySelector('#rotw-item-tooltip')?.textContent,
    phase: window.__rotwDebug?.snapshot()?.phase,
    campaign: window.__rotwDebug?.snapshot()?.save?.campaign?.act1,
    toast: document.querySelector('#game-toast')?.textContent,
  })`).catch(() => null) : null;
  await writeFile(path.join(EVIDENCE, 'failure.json'), JSON.stringify({
    error: error.stack ?? String(error), checks, screenshots, diagnostic,
    ports: [firstPort, secondPort], browserErrors: cdp?.errors ?? [],
  }, null, 2));
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await stopBrowser().catch(error => console.error(`Browser cleanup: ${error.message}`));
  await stopServer().catch(error => console.error(`Server cleanup: ${error.message}`));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
