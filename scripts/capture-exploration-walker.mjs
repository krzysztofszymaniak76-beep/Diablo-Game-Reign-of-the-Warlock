import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupTrackedBrowser, launchTrackedBrowser } from './browser-lifecycle.mjs';

// Off-screen visual regression. This uses a disposable save path and the live
// game's approved hero art; it never opens the desktop game window.
const PORT = 4261;
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs', 'evidence', 'critical-exploration-v0.5.18', 'walk-frames'));
const previewDirection = process.argv[3] === 'north' ? 'north' : 'southeast';
const previewClass = ['amazon','assassin','necromancer','barbarian','paladin','sorceress','warlock','druid'].includes(process.argv[4])
  ? process.argv[4] : 'barbarian';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'rotw-walker-'));
const server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(PORT)], {
  cwd: ROOT, env: { ...process.env, ROTW_SAVE_FILE: path.join(tmp, 'save.json') }, windowsHide: true,
});
let browser;
let socket;
try {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__rotw_health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('Test server ready');
  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    appUrl: 'about:blank', windowSize: '900,700',
    extraArgs: ['--mute-audio', '--no-sandbox', '--disable-software-rasterizer', '--disable-gpu-compositing'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  console.log('Headless browser ready', targets.find(target => target.type === 'page')?.webSocketDebuggerUrl);
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  console.log('Browser protocol connected');
  socket.addEventListener('error', error => console.error('Browser socket error', error));
  socket.addEventListener('close', event => console.error('Browser socket closed', event.code, event.reason));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', async ({ data }) => {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : data instanceof Blob ? await data.text() : Buffer.from(data).toString('utf8'));
    } catch (error) { console.error('Browser message parse failed', error); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Browser timeout: ${method}`)); }, 15_000);
    const requestId = ++id;
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  console.log('Browser runtime ready');
  await evaluate(`(async()=>{
    const m=await import('/app/exploration-walker.js');
    const host=document.createElement('div');host.id='walker-preview';
    host.style='position:fixed;inset:0;background:#141812;z-index:999999;display:grid;place-items:center';
    host.innerHTML='<div style="text-align:center;color:#d5c49c;font:19px Georgia"><svg viewBox="-20 -39 40 45" width="280" height="315" style="display:block;background:#243021;border:2px solid #5c5a43"><g class="party-map-marker" transform="translate(0 0)"><ellipse class="party-map-shadow" cy="2" rx="11" ry="4"/>'+m.explorationWalkerMarkup('${previewClass}')+'</g></svg><p id="walker-label"></p></div>';
    document.body.append(host);window.__walkerPreview={m,marker:host.querySelector('.party-map-marker')};
    await new Promise(resolve=>setTimeout(resolve,400));return !!host.querySelector('.party-map-walker');
  })()`);
  await evaluate(`(()=>{const w=window.__walkerPreview;w.m.updateExplorationWalker(w.marker,{x:0,y:0},false);return true})()`);
  await mkdir(OUT, { recursive: true });
  for (let frame = 0; frame < 8; frame += 1) {
    const state = await evaluate(`(()=>{const w=window.__walkerPreview;const distance=(${frame}+.25)*86/8;w.m.updateExplorationWalker(w.marker,${previewDirection === 'north' ? '{x:0,y:-distance}' : '{x:distance/Math.SQRT2,y:distance/Math.SQRT2}'},true);const node=w.marker.querySelector('.party-map-walker');document.getElementById('walker-label').textContent='Klatka ${frame+1}/8 · ${previewDirection === 'north' ? 'północ' : 'południowy wschód'}';return {frame:node.dataset.walkFrame,direction:node.dataset.direction,source:document.getElementById('party-walker-source-${previewDirection === 'north' ? 'rear' : 'front'}')?.getAttribute('href')};})()`);
    if (state.frame !== String(frame) || state.direction !== previewDirection) throw new Error(`Unexpected live walker frame ${JSON.stringify(state)}`);
    const png = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(OUT, `walk-${frame + 1}.png`), Buffer.from(png.data, 'base64'));
    console.log(state);
  }
  const routing = await evaluate(`(()=>{const w=window.__walkerPreview;let point={x:0,y:0};w.m.updateExplorationWalker(w.marker,point,false);const result=[];for(const [dx,dy,direction] of [[10,0,'east'],[10,-10,'northeast'],[0,-10,'north'],[-10,-10,'northwest'],[-10,0,'west'],[-10,10,'southwest'],[0,10,'south'],[10,10,'southeast']]){point={x:point.x+dx,y:point.y+dy};w.m.updateExplorationWalker(w.marker,point,true);const node=w.marker.querySelector('.party-map-walker');result.push({direction:node.dataset.direction,front:getComputedStyle(node.querySelector('.party-map-view-front')).display,rear:getComputedStyle(node.querySelector('.party-map-view-rear')).display});}return result;})()`);
  for (const [index, direction] of ['east','northeast','north','northwest','west','southwest','south','southeast'].entries()) {
    const current = routing[index];
    const rear = ['northeast','north','northwest'].includes(direction);
    if (current.direction !== direction || (current.rear !== 'none') !== rear || (current.front !== 'none') === rear) {
      throw new Error(`Wrong facing image for ${direction}: ${JSON.stringify(current)}`);
    }
  }
  console.log('Eight-direction front/rear routing:', routing);
  const continuity = await evaluate(`(()=>{const w=window.__walkerPreview;
    w.m.updateExplorationWalker(w.marker,{x:0,y:0},false);
    w.m.updateExplorationWalker(w.marker,{x:10,y:0},true);
    const before=w.marker.querySelector('.party-map-walker').dataset.walkFrame;
    const replacement=w.marker.cloneNode(true);
    w.marker.replaceWith(replacement);w.marker=replacement;
    w.m.updateExplorationWalker(replacement,{x:35,y:0},true);
    const after=replacement.querySelector('.party-map-walker').dataset.walkFrame;
    w.m.updateExplorationWalker(replacement,{x:35,y:0},false);
    document.getElementById('walker-label').textContent='Postój · klatka spoczynkowa';
    return {before,after,idle:replacement.querySelector('.party-map-walker').dataset.walkState};})()`);
  if (continuity.before !== continuity.after || continuity.idle !== 'idle') {
    throw new Error(`Walking phase jumped during map redraw: ${JSON.stringify(continuity)}`);
  }
  console.log('Marker redraw retained step phase and returned to idle:', continuity);
  const idle = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, 'idle.png'), Buffer.from(idle.data, 'base64'));
  const threat = await evaluate(`(async()=>{const {renderExplorationLandscape}=await import('/app/exploration-landscape.js');
    const sector={id:'sector-001',x:0,y:0,variant:0,current:true,reachable:true,discovered:true,visible:true,
      encounter:{encounterId:'walk-preview',status:'available'},points:[],exits:[]};
    const map={areaId:'act1.blood_moor',layoutSignature:'walk-preview',bounds:{minX:0,maxX:0,minY:0,maxY:0},edges:[]};
    const rendered=renderExplorationLandscape({map,sectors:[sector]});
    document.getElementById('walker-preview').innerHTML='<svg viewBox="-100 -75 200 160" width="560" height="450" style="background:#101710;border:2px solid #5c5a43">'+rendered.defs+rendered.markup+'</svg>';
    await new Promise(resolve=>setTimeout(resolve,300));
    const token=document.querySelector('.land-threat');
    return {visible:!!token,bounds:token?.getBBox().width,fallen:!!token?.querySelector('[href$="unit-fallen-d2r-v1.png"]'),
      zombie:!!token?.querySelector('[href$="unit-zombie-d2r-v1.png"]'),assetsLoaded:(await fetch('/app/assets/unit-fallen-d2r-v1.png')).ok};})()`);
  if (!threat.visible || !threat.fallen || !threat.zombie || !threat.assetsLoaded || threat.bounds < 20) {
    throw new Error(`Encounter token is not visible: ${JSON.stringify(threat)}`);
  }
  const encounter = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, 'encounter-token.png'), Buffer.from(encounter.data, 'base64'));
  console.log('Visible encounter token:', threat);
  console.log(`Walker frames: ${OUT}`);
} finally {
  socket?.close();
  if (browser) await cleanupTrackedBrowser(browser);
  server.kill();
  if (path.dirname(tmp) === os.tmpdir() && path.basename(tmp).startsWith('rotw-walker-')) {
    await rm(tmp, { recursive: true, force: true });
  }
}
