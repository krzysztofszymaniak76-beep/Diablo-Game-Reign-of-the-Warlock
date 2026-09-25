import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTrackedBrowser, cleanupTrackedBrowser, lifecycleSnapshot, installGlobalCleanupHandlers } from './browser-lifecycle.mjs';

const stage = process.argv[2] ?? 'progression';
const viewportMatch = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? '1536x864');
if (!viewportMatch) throw new Error('Viewport must use WIDTHxHEIGHT');
const viewportWidth=Number(viewportMatch[1]),viewportHeight=Number(viewportMatch[2]);
const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const outputVersion = `v${packageMetadata.version}`;
const out = path.resolve(`outputs/${outputVersion}`, process.argv[3] ? `${stage}-${viewportWidth}x${viewportHeight}` : stage);
const port = 4187;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, socket, sequence = 0;
const pending = new Map(), errors = [];
installGlobalCleanupHandlers();
async function send(method, params = {}) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 300000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}
try {
  await mkdir(out, { recursive: true });
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let serverError = '';
  server.stderr.on('data', bytes => { serverError += bytes; });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('Server failed: ' + serverError);
    try { const health = await (await fetch(`http://127.0.0.1:${port}/__rotw_health`)).json(); if (health.pid === server.pid) break; } catch {}
    if (i === 79) throw new Error('Owned server not ready');
    await pause(100);
  }
  browser = await launchTrackedBrowser({ edgePath: process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', windowSize: `${viewportWidth},${viewportHeight}`, appUrl: 'about:blank' });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true}); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); } }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width:viewportWidth, height:viewportHeight, deviceScaleFactor:1, mobile:false });
  // Off-screen browser must emulate document focus to evaluate :focus states.
  await send('Emulation.setFocusEmulationEnabled', { enabled:true });
  await send('Page.navigate', { url:`http://127.0.0.1:${port}/${stage === 'progression' ? '?training=1' : stage === 'exploration' ? '?exploration-test=1' : '?skip-main-menu=1'}` });
  for (let i=0;i<150;i++) { if (await evaluate('Boolean(window.__rotwDebug?.snapshot)')) break; if(i===149)throw new Error('App did not start: '+errors.join('\n')); await pause(100); }
  const modulePath = stage === 'progression' ? 'progression-browser-checks' : stage==='edges' ? 'act1-native-edge-checks' : stage==='exploration' ? 'exploration-browser-checks' : 'act1-browser-checks';
  const functionName = stage === 'progression' ? 'runProgressionBrowserChecks' : stage==='edges' ? 'runAct1NativeEdgeChecks' : stage==='exploration' ? 'runExplorationBrowserChecks' : 'runAct1BrowserChecks';
  // Screenshots are requested by the UI driver via a binding; all gameplay stays in actual UI handlers.
  await send('Runtime.addBinding', {name:'captureAct1Evidence'});
  let shotQueue = Promise.resolve();
  socket.addEventListener('message', event => { const message=JSON.parse(event.data); if(message.method==='Runtime.bindingCalled'&&message.params.name==='captureAct1Evidence') {
    const name=message.params.payload.replace(/[^a-z0-9_-]/gi,'');
    shotQueue=shotQueue.then(async()=>{
      const clip=name==='map-frame'?await evaluate("(()=>{const p=document.querySelector('#game-panel').getBoundingClientRect(),h=document.querySelector('.game-panel-header').getBoundingClientRect();return {x:p.x,y:p.y,width:p.width,height:h.bottom-p.y+28,scale:1};})()"):undefined;
      const shot=await send('Page.captureScreenshot',{format:'png',...(clip?{clip}:{})});
      await writeFile(path.join(out,`${name}.png`),Buffer.from(shot.data,'base64'));await evaluate(`window.__act1CaptureDone=${JSON.stringify(name)}`);
    });
  }});
  const checks = await evaluate(`(async()=>{const module=await import('/scripts/${modulePath}.mjs');return await module.${functionName}({full:${stage==='full'}});})()`);
  await shotQueue;
  if(stage==='exploration')for(const areaId of ['act1.blood_moor','act1.den_of_evil']) {
    const probe=`(await import('/scripts/exploration-browser-checks.mjs')).landscapeReloadProbe`;
    const before=await evaluate(`(async()=>${probe}(${JSON.stringify(areaId)},true))()`);
    const loaded=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.removeEventListener('message',handler);reject(new Error('Document reload timeout'));},20000);
      const handler=event=>{if(JSON.parse(event.data).method==='Page.loadEventFired'){clearTimeout(timer);socket.removeEventListener('message',handler);resolve();}};
      socket.addEventListener('message',handler);
    });
    await send('Page.reload',{ignoreCache:true});await loaded;
    for(let i=0;i<150;i++){if(await evaluate('Boolean(window.__rotwDebug?.snapshot)'))break;if(i===149)throw new Error('Reloaded app not ready');await pause(100);}
    const after=await evaluate(`(async()=>${probe}(${JSON.stringify(areaId)}))()`);
    if(!before.art||JSON.stringify(before)!==JSON.stringify(after))throw new Error(`Reload changed landscape/save: ${areaId}`);
    checks.checks.push(`real document reload preserves terrain and campaign: ${areaId}`);checks.passed++;
  }
  if(errors.length)throw new Error(errors.join('\n'));
  await writeFile(path.join(out,'checks.json'), JSON.stringify({stage,checks,errors},null,2));
  console.log(JSON.stringify({stage,passed:checks.passed ?? checks.length,checks:checks.checks ?? checks},null,2));
} catch(error) {
  if(socket?.readyState===WebSocket.OPEN) {
    const failure=await evaluate('window.__act1Failure ?? window.__act1NativeEdgeFailure ?? {snapshot:window.__rotwDebug?.snapshot(),toast:document.querySelector("#game-toast")?.textContent}').catch(()=>null);
    await writeFile(path.join(out,'failure.json'),JSON.stringify(failure,null,2));
    console.error('UI FAILURE '+JSON.stringify(failure?.diagnostic ?? failure?.toast ?? failure));
  }
  throw error;
} finally {
  for(const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  const cleanup=browser ? await cleanupTrackedBrowser(browser) : null;
  if(server && server.exitCode===null) { const exited=new Promise(resolve=>server.once('exit',resolve)); server.kill(); await exited; }
  const lifecycle=await lifecycleSnapshot();
  const result={cleanup,lifecycle,ownedServers:server?.exitCode===null && server?.signalCode===null ? 1 : 0};
  await mkdir(out,{recursive:true});await writeFile(path.join(out,'cleanup.json'),JSON.stringify(result,null,2));
  console.log('CLEANUP '+JSON.stringify({remainingBrowserProcesses:cleanup?.remaining?.length ?? 0,ownedRoots:lifecycle.owned.length,ownedServers:result.ownedServers}));
}
