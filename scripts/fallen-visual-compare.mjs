import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupTrackedBrowser, installGlobalCleanupHandlers, launchTrackedBrowser } from './browser-lifecycle.mjs';

const APP_URL = process.env.ROTW_UI_URL ?? 'http://127.0.0.1:4174/';
const OUTPUT = path.resolve(process.env.ROTW_MONSTER_EVIDENCE_DIR ?? 'docs/evidence/fallen-size-v0519');
const VIEWPORT_WIDTH = Number(process.env.ROTW_VIEWPORT_WIDTH ?? 1920);
const VIEWPORT_HEIGHT = Number(process.env.ROTW_VIEWPORT_HEIGHT ?? 1080);
const HERO_IDS = ['korgan', 'isendra', 'veyran'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async ({ data }) => {
      const msg = JSON.parse(typeof data === 'string' ? data : await data.text());
      if (!msg.id) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result?.value;
  }
  close() { this.socket.close(); }
}

let browser;
let cdp;
installGlobalCleanupHandlers();

async function waitFor(test, label, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await test()) return; } catch { /* page transition */ }
    await pause(100);
  }
  throw new Error(`Timeout: ${label}`);
}

async function click(selector) {
  const ok = await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true})()`);
  if (!ok) throw new Error(`Cannot click ${selector}`);
  await pause(90);
}

async function capture(label) {
  await cdp.evaluate(`(async()=>{await Promise.race([document.fonts?.ready,new Promise(r=>setTimeout(r,2500))]);await Promise.race([Promise.all([...document.images].map(i=>i.decode?.().catch(()=>{}))),new Promise(r=>setTimeout(r,2500))]);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const file = path.join(OUTPUT, `${label}-${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log(`IMAGE ${file}`);
}

async function captureMonsterDetail(name, label, index, width, height) {
  const clip = await cdp.evaluate(`(()=>{const s=window.__rotwDebug.snapshot(),u=s.save.combat.units.filter(x=>x.kind==='monster'&&x.hp>0&&x.name===${JSON.stringify(name)})[${index}],hex=s.hexUnits.find(x=>x.id===u.id).position,p=window.__rotwDebug.projectHex(hex.q,hex.r),r=document.querySelector('#scene').getBoundingClientRect();return{x:Math.round(r.left+p.x-${width}/2),y:Math.round(r.top+p.y-${height}+32),width:${width},height:${height},scale:1}})()`);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip });
  const file = path.join(OUTPUT, `${label}-detail.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  console.log(`DETAIL ${file}`);
}

const hexDistance = (a, b) => Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r));
async function moveNearFallen() {
  for (let turn = 0; turn < 90; turn++) {
    const state = await cdp.evaluate('window.__rotwDebug.snapshot()');
    const save = state.save;
    const fallen = save.combat.units.filter(unit => unit.kind === 'monster' && unit.hp > 0 && unit.name === 'Upadły');
    const heroes = save.partyIds.map(id => ({ id, position: state.hexUnits.find(unit => unit.id === id)?.position }))
      .filter(hero => hero.position);
    const closest = heroes.flatMap(hero => fallen.map(monster => ({ hero, monster, distance: hexDistance(hero.position, state.hexUnits.find(unit => unit.id === monster.id).position) })))
      .sort((a, b) => a.distance - b.distance)[0];
    if (closest?.distance <= 1) {
      console.log(`ADJACENT ${JSON.stringify({hero:closest.hero,monster:closest.monster.id,distance:closest.distance})}`);
      return;
    }
    const actor = state.actingUnitId;
    if (!save.partyIds.includes(actor)) { await pause(160); continue; }
    const actorPosition = state.hexUnits.find(unit => unit.id === actor)?.position;
    if (!actorPosition) throw new Error(`Missing active hero position ${actor}`);
    const destination = await cdp.evaluate(`(async()=>{const {HexGrid,hexDistance}=await import('/src/core/hex-grid.js');const s=window.__rotwDebug.snapshot();const g=HexGrid.restore(s.save.hexGrid);const actor=${JSON.stringify(actor)};const enemies=s.save.combat.units.filter(u=>u.kind==='monster'&&u.hp>0&&u.name==='Upadły').map(u=>g.positionOf(u.id));return g.reachable(actor,3).filter(x=>x.cost>0).sort((a,b)=>Math.min(...enemies.map(e=>hexDistance(a.position,e)))-Math.min(...enemies.map(e=>hexDistance(b.position,e)))||a.cost-b.cost||a.position.q-b.position.q||a.position.r-b.position.r)[0]?.position??null})()`);
    if (!destination) throw new Error(`No movement destination for ${actor}`);
    if (state.save.inspectedCharacterId !== actor) await click(`#party [data-character-id="${actor}"]`);
    await click('#move-command');
    const point = await cdp.evaluate(`(()=>{const c=document.querySelector('#scene'),r=c.getBoundingClientRect(),v=window.__rotwDebug.battlefieldGeometry().viewport,p=window.__rotwDebug.projectHex(${destination.q},${destination.r});return{x:r.left+p.x*r.width/v.width,y:r.top+p.y*r.height/v.height}})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await pause(180);
  }
  throw new Error('Could not move a hero adjacent to an Upadły');
}

try {
  await mkdir(OUTPUT, { recursive: true });
  browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: `${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}` });
  cdp = new Cdp(browser.target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${APP_URL}?fallen-visual-compare=1` });
  await waitFor(() => cdp.evaluate('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"'), 'game ready');
  await waitFor(() => cdp.evaluate('document.querySelector("#team-selection-layer").getAttribute("aria-hidden") === "false"'), 'team selection');
  const selected = await cdp.evaluate('[...document.querySelectorAll("#team-selection-grid [aria-selected=true]")].map(e=>e.dataset.heroId)');
  for (const id of selected) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  for (const id of HERO_IDS) await click(`#team-selection-grid [data-hero-id="${id}"]`);
  await click('#team-selection-confirm');
  await waitFor(() => cdp.evaluate('document.querySelector("#camp-layer").getAttribute("aria-hidden") === "false"'), 'camp');
  await click('#camp-save');
  await click('[data-camp-action="gate"]');
  await waitFor(() => cdp.evaluate('window.__rotwDebug.snapshot().save.campaign.act1.currentAreaId === "act1.blood_moor"'), 'Blood Moor');
  if (await cdp.evaluate('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "false"')) await click('[data-open-panel="map"]');
  for (let i = 0; i < 45; i++) {
    const state = await cdp.evaluate('window.__rotwDebug.snapshot()');
    if (state.save.campaign.act1.exploration.activeBattle) break;
    const next = await cdp.evaluate(`(async()=>{const {CampaignState}=await import('/src/core/campaign.js');const {shortestSectorPath}=await import('/src/core/exploration.js');const c=CampaignState.restoreAct1(window.__rotwDebug.snapshot().save.campaign);const m=c.act1ExplorationMap();return shortestSectorPath(m,c.act1.exploration.currentSectorId,m.encounters[0].sectorId)?.[1]})()`);
    if (!next) throw new Error('No route to first encounter');
    await click(`[data-travel-sector="${next}"]`);
    await pause(140);
  }
  await waitFor(() => cdp.evaluate('window.__rotwDebug.snapshot().phase === "preparation" && window.__rotwDebug.snapshot().save.campaign.act1.exploration.activeBattle'), 'encounter preparation');
  await waitFor(() => cdp.evaluate('document.querySelector("#panel-layer").getAttribute("aria-hidden") === "true"'), 'closed map');
  await click('#start-battle');
  await waitFor(() => cdp.evaluate('window.__rotwDebug.snapshot().phase === "active"'), 'active battle');
  await moveNearFallen();
  await pause(50);
  const summary = await cdp.evaluate(`(()=>{const s=window.__rotwDebug.snapshot();return {units:s.save.combat.units.filter(u=>u.kind==='monster'&&u.hp>0).map(u=>({id:u.id,name:u.name,position:s.hexUnits.find(p=>p.id===u.id)?.position})),heroes:s.save.partyIds.map(id=>({id,position:s.hexUnits.find(p=>p.id===id)?.position})),viewport:window.__rotwDebug.battlefieldGeometry().viewport}})()`);
  console.log(`SCENE ${JSON.stringify(summary)}`);
  const hitChecks = await cdp.evaluate(`(()=>{const s=window.__rotwDebug.snapshot();return ['Upadły','Zombie'].map(name=>{const u=s.save.combat.units.find(x=>x.kind==='monster'&&x.hp>0&&x.name===name),hex=s.hexUnits.find(x=>x.id===u.id).position,p=window.__rotwDebug.projectHex(hex.q,hex.r),hit=window.__rotwDebug.hitTestHex(p.x,p.y);return {unit:u.id,name,occupiedHex:hex,centerHit:hit,correct:hit?.q===hex.q&&hit?.r===hex.r&&s.hexUnits.find(x=>x.position?.q===hex.q&&x.position?.r===hex.r)?.id===u.id}})})()`);
  if (hitChecks.some(check => !check.correct)) throw new Error(`Monster logical hit target mismatch: ${JSON.stringify(hitChecks)}`);
  console.log(`HITBOX ${JSON.stringify(hitChecks)}`);
  await capture(process.env.CAPTURE_AFTER ? 'after' : 'before');
  if (process.env.CAPTURE_AFTER) {
    await captureMonsterDetail('Upadły', 'fallen', 1, 180, 180);
    await captureMonsterDetail('Zombie', 'zombie', 1, 190, 225);
  }
} finally {
  cdp?.close();
  if (browser) {
    const cleanup = await cleanupTrackedBrowser(browser);
    if (cleanup?.remaining?.length) throw new Error(`Remaining capture processes: ${JSON.stringify(cleanup.remaining)}`);
  }
}
