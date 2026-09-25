// Capture and verify the real battle torches in an isolated, headless Chrome session.
// Run: node scripts/capture-torch-v0521.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.ROTW_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PYTHON = process.env.ROTW_PYTHON ?? path.join(os.homedir(), '.cache', 'codex-runtimes',
  'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const WIDTH = 1920;
const HEIGHT = 1080;
const OUTPUT = path.join(ROOT, 'docs', 'evidence', 'torch-v0521',
  `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CAPTURE_COUNT = 36;
const CAPTURE_STEP_MS = 150;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sourcePaths = [
  'app/index.html', 'app/torch-flames.js', 'app/battlefield-d2r-v0521-torches.css',
  'app/assets/battle-torch-flame-atlas-v0521.png', 'app/assets/battle-torch-sconce-v0519.png',
];
const checks = [];
let server;
let browser;
let cdp;
let remote;
let frameDirectory;

installGlobalCleanupHandlers();

function check(ok, name, detail) {
  checks.push({ name, pass: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async relative =>
    [relative, sha256(await readFile(path.join(ROOT, relative)))])));
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: ROOT, windowsHide: true, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}__rotw_health`);
      const health = await response.json();
      if (path.resolve(health.projectRoot).toLowerCase() !== ROOT.toLowerCase()) {
        throw new Error(`Serwer wskazuje inny projekt: ${health.projectRoot}`);
      }
      return base;
    } catch { await sleep(80); }
  }
  throw new Error('Nie udało się uruchomić lokalnego serwera projektu.');
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function until(expression, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`Nie załadowano: ${label}`);
}

async function screenshot(filename, clip) {
  const response = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
    ...(clip ? { clip } : {}),
  });
  const png = Buffer.from(response.data, 'base64');
  if (!clip && (png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT)) {
    throw new Error(`Zły rozmiar zrzutu: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  const target = path.join(OUTPUT, filename);
  await writeFile(target, png, { flag: 'wx' });
  return { file: target, bytes: png.length, sha256: sha256(png) };
}

const stateExpression = `(() => {
  const rect = element => { const r = element.getBoundingClientRect();
    return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
  const torches = [...document.querySelectorAll('.battlefield-shell > .battle-torch')].map(torch => {
    const img = torch.querySelector('img');
    const holder = torch.querySelector('.torch-flame');
    const canvas = holder.querySelector('canvas.torch-fire-canvas');
    const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261, anchorWeight = 0, anchorX = 0, anchorBottom = -1;
    if (pixels) for (let y=0; y<canvas.height; y++) for (let x=0; x<canvas.width; x++) {
      const n = (y*canvas.width+x)*4;
      hash = Math.imul(hash ^ pixels[n], 16777619);
      hash = Math.imul(hash ^ pixels[n+1], 16777619);
      hash = Math.imul(hash ^ pixels[n+2], 16777619);
      hash = Math.imul(hash ^ pixels[n+3], 16777619);
      if (y >= canvas.height*.78 && pixels[n+3] >= 180) {
        anchorWeight += pixels[n+3]; anchorX += x*pixels[n+3]; anchorBottom = y;
      }
    }
    return { torch:rect(torch), img:rect(img), holder:rect(holder), canvas:canvas && rect(canvas),
      imgSrc:img.currentSrc, imgComplete:img.complete && img.naturalWidth>0,
      imgTransform:getComputedStyle(img).transform, imgAnimation:getComputedStyle(img).animationName,
      imgAnimationCount:img.getAnimations().length, holderTransform:getComputedStyle(holder).transform,
      holderAnimation:getComputedStyle(holder).animationName, frame:holder.dataset.flameFrame ?? null,
      fireHash:canvas ? (hash>>>0).toString(16) : null,
      fireSize:canvas ? [canvas.width,canvas.height] : null,
      anchor:anchorWeight ? { x:anchorX/anchorWeight, bottom:anchorBottom } : null,
      pointerEvents:getComputedStyle(torch).pointerEvents };
  });
  const scene = document.querySelector('#scene');
  return { viewport:[innerWidth,innerHeight], scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],
    camp:document.querySelector('#app').classList.contains('camp-mode'), scene:rect(scene), torches };
})()`;

async function getState() { return evaluate(stateExpression); }

function closeupClip(torch) {
  const width = 240, height = 320;
  const x = Math.max(0,Math.min(WIDTH-width,Math.round(torch.left+torch.width/2-width/2)));
  const y = Math.max(0,Math.min(HEIGHT-height,Math.round(torch.top-80)));
  return {x,y,width,height,scale:2};
}

// These points verify both the visual metal/fire footprint and that battle clicks reach the canvas.
const gridExpression = `(() => {
  const canvas=document.querySelector('#scene'), rect=canvas.getBoundingClientRect();
  const geometry=window.__rotwDebug.battlefieldGeometry();
  const frame=document.querySelector('.battle-ornate-frame');
  const frameRect=frame.getBoundingClientRect(), frameStyle=getComputedStyle(frame);
  const visibleInterior={left:frameRect.left+parseFloat(frameStyle.borderLeftWidth),
    top:frameRect.top+parseFloat(frameStyle.borderTopWidth),
    right:frameRect.right-parseFloat(frameStyle.borderRightWidth),
    bottom:frameRect.bottom-parseFloat(frameStyle.borderBottomWidth)};
  const tiles=geometry.tiles.map(tile=>({ q:tile.q, r:tile.r, polygon:tile.vertices.map(vertex=>({
    x:rect.left+vertex.x*rect.width/geometry.viewport.width,
    y:rect.top+vertex.y*rect.height/geometry.viewport.height })),
    center:{ x:rect.left+tile.center.x*rect.width/geometry.viewport.width,
      y:rect.top+tile.center.y*rect.height/geometry.viewport.height } }));
  const hitFailures=tiles.flatMap(tile=>{
    const points=[tile.center,...tile.polygon.map(vertex=>({x:tile.center.x+(vertex.x-tile.center.x)*.58,
      y:tile.center.y+(vertex.y-tile.center.y)*.58}))];
    return points.flatMap(point=>{
      const hit=document.elementFromPoint(point.x,point.y);
      return hit===canvas ? [] : [{q:tile.q,r:tile.r,hit:hit?.id||hit?.className||hit?.tagName||null}];
    });
  });
  const inside=(x,y,polygon)=>{ let value=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const a=polygon[i],b=polygon[j];
      if(((a.y>y)!==(b.y>y))&&(x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)) value=!value;
    }
    return value;
  };
  function opaqueOverlaps(element,source,threshold) {
    const r=element.getBoundingClientRect();
    const s=document.createElement('canvas'); s.width=source.width; s.height=source.height;
    const ctx=s.getContext('2d',{willReadFrequently:true}); ctx.drawImage(source,0,0);
    const alpha=ctx.getImageData(0,0,s.width,s.height).data;
    const isImage=source instanceof HTMLImageElement;
    const containedScale=Math.min(r.width/s.width,r.height/s.height);
    const scaleX=isImage?containedScale:r.width/s.width;
    const scaleY=isImage?containedScale:r.height/s.height;
    const x0=isImage?r.left+(r.width-s.width*scaleX)/2:r.left;
    const y0=isImage?r.top+(r.height-s.height*scaleY)/2:r.top;
    const x1=x0+s.width*scaleX,y1=y0+s.height*scaleY;
    const overlaps=[];
    for(const tile of tiles) {
      const px=tile.polygon.map(p=>p.x),py=tile.polygon.map(p=>p.y);
      const left=Math.max(x0,Math.min(...px),visibleInterior.left);
      const right=Math.min(x1,Math.max(...px),visibleInterior.right);
      const top=Math.max(y0,Math.min(...py),visibleInterior.top);
      const bottom=Math.min(y1,Math.max(...py),visibleInterior.bottom);
      if(left>=right||top>=bottom) continue;
      let found=false;
      for(let y=Math.ceil(top);y<bottom&&!found;y++) for(let x=Math.ceil(left);x<right&&!found;x++) {
        if(!inside(x,y,tile.polygon)) continue;
        const sx=Math.floor((x-x0)/scaleX),sy=Math.floor((y-y0)/scaleY);
        if(sx>=0&&sx<s.width&&sy>=0&&sy<s.height&&alpha[(sy*s.width+sx)*4+3]>=threshold) {
          overlaps.push({q:tile.q,r:tile.r,x,y});found=true;
        }
      }
    }
    return overlaps;
  }
  const overlap=[...document.querySelectorAll('.battlefield-shell > .battle-torch')].map(torch=>({
    metal:opaqueOverlaps(torch.querySelector('img'),torch.querySelector('img'),128),
    fire:opaqueOverlaps(torch.querySelector('canvas.torch-fire-canvas'),torch.querySelector('canvas.torch-fire-canvas'),128),
  }));
  return {tileCount:tiles.length,hitFailures,visibleInterior,overlap};
})()`;

async function makeGif() {
  const program = `from PIL import Image
from pathlib import Path
import sys
folder,destination=sys.argv[1:3]
frames=[]
for index in range(${CAPTURE_COUNT}):
    with Image.open(Path(folder)/f'left-{index:02d}.png') as left, Image.open(Path(folder)/f'right-{index:02d}.png') as right:
        left=left.convert('RGB');right=right.convert('RGB')
        target_height=max(left.height,right.height)
        frame=Image.new('RGB',(left.width+right.width,target_height),'#090909')
        frame.paste(left,(0,0));frame.paste(right,(left.width,0))
        frames.append(frame.resize((frame.width*2//3,frame.height*2//3),Image.Resampling.LANCZOS))
frames[0].save(destination,format='GIF',save_all=True,append_images=frames[1:],
    duration=${CAPTURE_STEP_MS},loop=0,disposal=2,optimize=True)
print(f'{len(frames)} frames, {frames[0].width}x{frames[0].height}')`;
  const gif = path.join(OUTPUT, 'torch-animation-loop.gif');
  const child = spawn(PYTHON, ['-c', program, frameDirectory, gif], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const code = await new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',resolve);
  });
  if(code!==0) throw new Error(`Nie można utworzyć GIF: ${stderr}`);
  return { file:gif, detail:stdout.trim() };
}

try {
  await mkdir(OUTPUT,{recursive:true});
  frameDirectory=await mkdtemp(path.join(os.tmpdir(),'rotw-torch-frames-'));
  const beforeSources=await sourceHashes();
  const base=await startServer();
  browser=await launchTrackedBrowser({ edgePath:CHROME,appUrl:'about:blank',
    windowSize:`${WIDTH},${HEIGHT}`,
    extraArgs:['--mute-audio','--no-sandbox','--disable-gpu-sandbox'],stdio:['ignore','pipe','pipe'] });
  const playwrightPath=path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime',
    'dependencies','node','node_modules','playwright','index.mjs');
  const {chromium}=await import(pathToFileURL(playwrightPath).href);
  remote=await chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`,{timeout:15000});
  const context=remote.contexts()[0];
  const page=context.pages().find(candidate=>candidate.url()==='about:blank') ?? await context.newPage();
  const session=await context.newCDPSession(page);
  cdp={send:(method,params)=>session.send(method,params),close:()=>remote.close()};
  // Runtime.enable can hang on this Chrome build; direct evaluate works without it.
  await cdp.send('Emulation.setDeviceMetricsOverride',{
    width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:false });
  const url=new URL(base);
  url.searchParams.set('training','1');
  url.searchParams.set('skip-team-selection','1');
  url.searchParams.set('torch-evidence','v0521');
  await cdp.send('Page.navigate',{url:url.href});
  await until(`document.readyState==='complete' && !document.querySelector('#app')?.classList.contains('camp-mode')
    && window.__rotwDebug?.battlefieldGeometry()?.tiles?.length===213
    && document.querySelectorAll('.torch-fire-canvas').length===2`, 'ekran walki z dwiema pochodniami');
  await evaluate(`(async()=>{await document.fonts?.ready;
    await Promise.race([Promise.all([...document.images].map(img=>img.decode?.().catch(()=>{}))),
      new Promise(resolve=>setTimeout(resolve,5000))]);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;})()`);
  const initial=await getState();
  check(initial.viewport[0]===WIDTH && initial.viewport[1]===HEIGHT &&
    initial.scroll[0]<=WIDTH && initial.scroll[1]<=HEIGHT, 'Viewport 1920x1080 bez przewijania',initial);
  check(!initial.camp && initial.torches.length===2 &&
    initial.torches.every(torch=>torch.imgComplete && torch.fireSize?.join('x')==='128x256'),
    'Dwie pochodnie i dwa płótna płomienia',initial.torches.map(t=>({loaded:t.imgComplete,fireSize:t.fireSize})));
  const visible=await evaluate(`(() => [...document.querySelectorAll('.battlefield-shell > .battle-torch img')].map(img => {
    const rect=img.getBoundingClientRect();
    const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(img,0,0);
    const data=context.getImageData(0,0,canvas.width,canvas.height).data;
    let left=canvas.width,top=canvas.height,right=-1,bottom=-1;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++) {
      if(data[(y*canvas.width+x)*4+3]<128)continue;
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    const scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
    const x0=rect.left+(rect.width-canvas.width*scale)/2;
    const y0=rect.top+(rect.height-canvas.height*scale)/2;
    return {left:x0+left*scale,top:y0+top*scale,right:x0+(right+1)*scale,
      bottom:y0+(bottom+1)*scale};
  }))()`);
  check(visible.length===2 && visible.every(bounds=>bounds.left>=0&&bounds.right<=WIDTH&&
    bounds.top>=0&&bounds.bottom<=HEIGHT),
    'Widoczne metalowe oprawy mieszczą się w kadrze',visible);

  const start=await evaluate(`(()=>{const button=document.querySelector('#start-battle');
    const r=button?.getBoundingClientRect();return r?{x:r.left+r.width/2,y:r.top+r.height/2}:null;})()`);
  if(start) {
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x,y:start.y,button:'left',buttons:0,clickCount:1});
    await until(`window.__rotwDebug?.snapshot()?.phase==='active'`,'aktywna walka');
  }
  const grid=await evaluate(gridExpression);
  check(grid.tileCount===213 && grid.hitFailures.length===0,
    '213 heksów pozostaje dostępnych dla kliknięć',
    {count:grid.tileCount,failures:grid.hitFailures.slice(0,8)});
  check(grid.overlap.length===2 && grid.overlap.every(side=>side.metal.length===0&&side.fire.length===0),
    'Nieprzezroczyste piksele pochodni nie zakrywają heksów',grid.overlap);
  const full=await screenshot('battle-1920x1080.png');
  const clips=initial.torches.map(torch=>closeupClip(torch.torch));
  const left=await screenshot('torch-left-closeup.png',clips[0]);
  const right=await screenshot('torch-right-closeup.png',clips[1]);

  const states=[];
  const sampledFrames=new Set();
  const animatedOverlap=[];
  const started=Date.now();
  for(let i=0;i<CAPTURE_COUNT;i++) {
    await sleep(Math.max(0,started+i*CAPTURE_STEP_MS-Date.now()));
    states.push(await getState());
    const framePair=states.at(-1).torches.map(torch=>torch.frame).join(':');
    if(!sampledFrames.has(framePair)) {
      sampledFrames.add(framePair);
      const sample=await evaluate(gridExpression);
      animatedOverlap.push({frames:framePair,overlap:sample.overlap});
    }
    for(let side=0;side<2;side++) {
      const result=await cdp.send('Page.captureScreenshot',{
        format:'png',fromSurface:true,captureBeyondViewport:false,clip:clips[side] });
      await writeFile(path.join(frameDirectory,`${side===0?'left':'right'}-${String(i).padStart(2,'0')}.png`),
        Buffer.from(result.data,'base64'));
    }
  }
  const variation=[];
  const still=[];
  const anchors=[];
  for(let side=0;side<2;side++) {
    const sampled=states.map(state=>state.torches[side]);
    const frames=new Set(sampled.map(torch=>torch.frame));
    const hashes=new Set(sampled.map(torch=>torch.fireHash));
    const a=sampled.map(torch=>torch.anchor).filter(Boolean);
    const xRange=Math.max(...a.map(p=>p.x))-Math.min(...a.map(p=>p.x));
    const bottomRange=Math.max(...a.map(p=>p.bottom))-Math.min(...a.map(p=>p.bottom));
    variation.push({side,frameCount:frames.size,hashCount:hashes.size,frames:[...frames]});
    still.push({side,rectCount:new Set(sampled.map(t=>JSON.stringify(t.img))).size,
      transformCount:new Set(sampled.map(t=>t.imgTransform)).size,
      animations:sampled.map(t=>t.imgAnimationCount).reduce((max,n)=>Math.max(max,n),0),
      animationNames:[...new Set(sampled.map(t=>t.imgAnimation))]});
    const xRangeCss=xRange*sampled[0].holder.width/sampled[0].fireSize[0];
    const bottomRangeCss=bottomRange*sampled[0].holder.height/sampled[0].fireSize[1];
    anchors.push({side,xRange,bottomRange,xRangeCss,bottomRangeCss,
      holderRectCount:new Set(sampled.map(t=>JSON.stringify(t.holder))).size,
      holderTransformCount:new Set(sampled.map(t=>t.holderTransform)).size,
      holderAnimationNames:[...new Set(sampled.map(t=>t.holderAnimation))]});
  }
  check(variation.every(side=>side.frameCount>=8&&side.hashCount>=8),
    'Oba płótna ognia zmieniają klatki i piksele',variation);
  check(animatedOverlap.length>=12&&animatedOverlap.every(sample=>sample.overlap.every(side=>
    side.metal.length===0&&side.fire.length===0)),
    'Każda klatka ognia pozostaje poza heksami',animatedOverlap);
  check(still.every(side=>side.rectCount===1&&side.transformCount===1&&
    side.animations===0&&side.animationNames.join(',')==='none'),
    'Metalowe obrazy pozostają nieruchome',still);
  check(anchors.every(side=>side.holderRectCount===1&&side.holderTransformCount===1&&
    side.holderAnimationNames.join(',')==='none'&&side.xRangeCss<=5&&side.bottomRangeCss<=10),
    'Nasada płomienia pozostaje zakotwiczona',anchors);
  const gif=await makeGif();
  const afterSources=await sourceHashes();
  check(JSON.stringify(beforeSources)===JSON.stringify(afterSources),
    'Pliki źródłowe nie zmieniły się w trakcie pomiaru');
  const result={ testedAt:new Date().toISOString(),browser:CHROME,viewport:[WIDTH,HEIGHT],
    url:url.href,sourceHashes:beforeSources,checks,measurements:{grid,animatedOverlap,
      variation,still,anchors},
    files:{full,left,right,gif} };
  await writeFile(path.join(OUTPUT,'results.json'),JSON.stringify(result,null,2));
  console.log(`EVIDENCE ${OUTPUT}`);
  if(checks.some(item=>!item.pass)) process.exitCode=1;
} catch(error) {
  console.error(error.stack??error);
  if(browser) console.error('CHROME_PROCESS',JSON.stringify({pid:browser.rootPid,exitCode:browser.child?.exitCode,
    stderr:browser.stderr?.().slice(-4000)}));
  await writeFile(path.join(OUTPUT,'failure.json'),JSON.stringify({
    error:error.stack??String(error),checks},null,2)).catch(()=>{});
  process.exitCode=1;
} finally {
  if(cdp) await cdp.close();
  if(browser) console.log(`BROWSER_CLEANUP ${JSON.stringify(await cleanupTrackedBrowser(browser))}`);
  server?.kill();
  if(frameDirectory) await rm(frameDirectory,{recursive:true,force:true});
}
