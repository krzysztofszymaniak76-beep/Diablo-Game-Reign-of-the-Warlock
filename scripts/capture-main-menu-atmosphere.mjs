// Capture the real animated title menu in an isolated, headless Edge profile.
// Run: ROTW_MENU_URL=http://127.0.0.1:4174/ node scripts/capture-main-menu-atmosphere.mjs
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  cleanupTrackedBrowser,
  installGlobalCleanupHandlers,
  launchTrackedBrowser,
} from './browser-lifecycle.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(PROJECT_ROOT, 'work', 'main-menu-atmosphere');
const BASE_URL = process.env.ROTW_MENU_URL ?? 'http://127.0.0.1:4174/';
const WIDTH = 1920;
const HEIGHT = 1080;
const FRAME_COUNT = Math.max(2, Number(process.env.ROTW_CAPTURE_FRAMES ?? 150));
const FRAME_INTERVAL_MS = 200;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
const exceptions = [];
let browser;
let socket;
let nextId = 0;
let frameDirectory;

installGlobalCleanupHandlers();

function insist(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${message}`);
}

async function send(method, params = {}) {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function until(check, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(80);
  }
  throw new Error(`Timeout: ${label}`);
}

async function capture(format, filename, quality) {
  const response = await send('Page.captureScreenshot', {
    format, ...(quality ? { quality } : {}),
    captureBeyondViewport: false, fromSurface: true,
  });
  const bytes = Buffer.from(response.data, 'base64');
  await writeFile(filename, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function readMenu() {
  return evaluate(`(() => {
    const menu = document.querySelector('#main-menu');
    const canvas = menu?.querySelector('canvas.main-menu-atmosphere');
    const ids = ['#menu-new-game', '#menu-open-settings', '#menu-save-exit'];
    const buttons = ids.map(selector => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      if (!rect) return { selector, found: false };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { selector, found: true, text: element.textContent.trim(),
        disabled: element.disabled, x, y, width: rect.width, height: rect.height,
        clickable: element === hit || element.contains(hit) };
    });
    const rect = canvas?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      menuVisible: Boolean(menu && !menu.hidden && menu.getAttribute('aria-hidden') === 'false'),
      background: menu ? getComputedStyle(menu, '::before').backgroundImage : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height,
        bounds: [rect.x, rect.y, rect.width, rect.height],
        pointerEvents: getComputedStyle(canvas).pointerEvents,
        effectLayers: canvas.dataset.effectLayers,
        lavaReady: canvas.dataset.lavaReady,
        atmosphereReady: canvas.dataset.atmosphereReady,
        motion: canvas.dataset.motion } : null,
      buttons,
    };
  })()`);
}

async function click(selector) {
  const button = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, clickable: element === hit || element.contains(hit) };
  })()`);
  insist(button?.clickable, `Klikalny ${selector}`, button);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y,
    button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y,
    button: 'left', buttons: 0, clickCount: 1 });
}

async function encodeWebp(directory, destination) {
  const python = `import os, sys\nfrom PIL import Image\nfolder, output = sys.argv[1:3]\npaths = sorted(os.path.join(folder, item) for item in os.listdir(folder) if item.endswith('.jpg'))\nframes = []\nfor filename in paths:\n    with Image.open(filename) as source:\n        frames.append(source.convert('RGB').resize((960, 540), Image.Resampling.LANCZOS))\nif len(frames) < 2:\n    raise SystemExit('Not enough captured frames')\nframes[0].save(output, format='WEBP', save_all=True, append_images=frames[1:], duration=200, loop=0, quality=72, method=4)\nprint(f'{len(frames)} frames -> {output}')`;
  let failure;
  for (const [command, prefix] of [['py', ['-3']], ['python', []]]) {
    try {
      const result = await execFileAsync(command, [...prefix, '-c', python, directory, destination], {
        windowsHide: true, timeout: 90_000,
      });
      console.log(result.stdout.trim());
      return true;
    } catch (error) { failure = error; }
  }
  console.warn(`Animated WebP unavailable; JPEG frames retained: ${failure}`);
  return false;
}

async function auditStaticScenery(baseline, first, second) {
  const python = `import json, sys
import numpy as np
from PIL import Image
base, first, second = (np.asarray(Image.open(path).convert('RGB')) for path in sys.argv[1:4])
height, width = base.shape[:2]
sy, sx = np.mgrid[:height, :width]
scale = max(width / 1690, height / 964)
sx = (sx - (width - 1690 * scale) / 2) / scale
sy = (sy - (height - 964 * scale) / 2) / scale
lava = (sx >= 1143) & (sx <= 1337) & (sy >= 463) & (sy <= 952)
sky = (sx >= 518) & (sx <= 826) & (sy >= 14) & (sy <= 324)
protected = ~(lava | sky)
protected |= (sx < 1155) & (sy >= 550) & (sy < 610)
protected |= (sx < 1190) & (sy >= 610) & (sy <= 800)
protected |= (sx > 1307) & (sy >= 500) & (sy <= 730)
chain_x = np.interp(sy, [728, 763, 805, 845, 882, 927, 952],
                    [1390, 1368, 1338, 1307, 1279, 1243, 1216])
protected |= (sy >= 728) & (sy <= 952) & (np.abs(sx - chain_x) <= 12)
for x, y, rx, ry in [(1275, 555, 26, 30), (1220, 665, 19, 15),
                     (1270, 745, 19, 20), (1220, 905, 28, 22)]:
    protected |= ((sx - x) / rx) ** 2 + ((sy - y) / ry) ** 2 <= .65 ** 2
base_delta = np.any(base != first, axis=2) | np.any(base != second, axis=2)
motion = np.any(first != second, axis=2)
print(json.dumps({'protectedChanged': int(np.count_nonzero(base_delta & protected)),
                  'lavaChanged': int(np.count_nonzero(motion & lava & ~protected)),
                  'skyChanged': int(np.count_nonzero(motion & sky & ~protected))}))`;
  let failure;
  for (const [command, prefix] of [['py', ['-3']], ['python', []]]) {
    try {
      const result = await execFileAsync(command, [...prefix, '-c', python,
        baseline, first, second], { windowsHide: true, timeout: 30_000 });
      return JSON.parse(result.stdout.trim());
    } catch (error) { failure = error; }
  }
  throw new Error(`Nie można porównać statycznego otoczenia: ${failure}`);
}

try {
  await mkdir(OUTPUT, { recursive: true });
  const appUrl = new URL(BASE_URL);
  const health = await (await fetch(new URL('/__rotw_health', appUrl))).json();
  insist(path.resolve(health.projectRoot).toLowerCase() === PROJECT_ROOT.toLowerCase(),
    'Serwer wskazuje właściwy projekt', health);

  browser = await launchTrackedBrowser({ appUrl: 'about:blank',
    windowSize: `${WIDTH},${HEIGHT}`, extraArgs: ['--mute-audio'] });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = targets.find(item => item.type === 'page');
  if (!page) throw new Error('Brak testowej karty Edge');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  // These values apply only to the disposable test profile.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try {
    localStorage.setItem('rotw.music.volume.v1', '0.05');
    localStorage.setItem('rotw.effects.volume.v1', '0.05');
  } catch {}` });
  await send('Page.navigate', { url: appUrl.href });
  await until(() => evaluate(`document.readyState === 'complete'
    && Boolean(document.querySelector('#main-menu canvas.main-menu-atmosphere'))
    && document.querySelector('#main-menu')?.getAttribute('aria-hidden') === 'false'`),
  'animowane menu');
  await evaluate('document.fonts.ready');
  await delay(1000); // Let the original CSS menu entrance finish before comparison.
  await until(() => evaluate("document.querySelector('canvas.main-menu-atmosphere')?.dataset.lavaReady === 'true'"),
    'wczytanie maski lawy');
  await until(() => evaluate("document.querySelector('canvas.main-menu-atmosphere')?.dataset.atmosphereReady === 'true'"),
    'wczytanie warstw tła');

  const initial = await readMenu();
  insist(initial.viewport[0] === WIDTH && initial.viewport[1] === HEIGHT,
    'Render 1920×1080', initial.viewport);
  insist(initial.menuVisible && initial.background?.includes('main-menu-user-reference-v1.png'),
    'Zatwierdzony obraz jest tłem widocznego menu', initial);
  insist(initial.canvas?.bounds[2] === WIDTH && initial.canvas?.bounds[3] === HEIGHT
    && initial.canvas.pointerEvents === 'none' && initial.canvas.motion === 'running',
  'Animacja pokrywa kadr i nie przechwytuje kliknięć', initial.canvas);
  insist(initial.canvas.effectLayers === 'lava smoke lightning eruption'
    && initial.canvas.atmosphereReady === 'true',
  'Włączone są cztery miejscowe efekty tła', initial.canvas);
  insist(initial.buttons.every(button => button.found && button.clickable && !button.disabled),
    'Trzy przyciski menu są klikalne', initial.buttons);

  await evaluate("document.querySelector('canvas.main-menu-atmosphere').style.visibility = 'hidden'");
  await delay(100);
  const baseline = path.join(OUTPUT, 'menu-statyczna-baza-1920x1080.png');
  await capture('png', baseline);
  await evaluate("document.querySelector('canvas.main-menu-atmosphere').style.visibility = 'visible'");
  await delay(100);
  const first = path.join(OUTPUT, 'menu-spoczynek-1920x1080.png');
  const firstHash = await capture('png', first);
  await delay(2200);
  const after = await readMenu();
  const second = path.join(OUTPUT, 'menu-animacja-1920x1080.png');
  const secondHash = await capture('png', second);
  insist(firstHash !== secondHash, 'Obraz zmienia się w czasie');
  const pixelAudit = await auditStaticScenery(baseline, first, second);
  insist(pixelAudit.protectedChanged === 0,
    'Postać, łańcuch, skały, ruiny i całe otoczenie poza lawą są nieruchome', pixelAudit);
  insist(pixelAudit.lavaChanged > 100,
    'Wewnątrz istniejącej lawy widać ruch', pixelAudit);
  insist(pixelAudit.skyChanged > 100,
    'Dym porusza się w oddalonym niebie', pixelAudit);
  insist(JSON.stringify(initial.buttons) === JSON.stringify(after.buttons),
    'Pozycje przycisków nie zmieniły się podczas animacji', { initial: initial.buttons, after: after.buttons });

  frameDirectory = await mkdtemp(path.join(os.tmpdir(), 'rotw-menu-atmosphere-'));
  let lightningStill = null;
  let eruptionStill = null;
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const filename = path.join(frameDirectory, `frame-${String(index).padStart(3, '0')}.jpg`);
    const started = Date.now();
    await capture('jpeg', filename, 64);
    const eventState = await evaluate(`(() => {
      const canvas = document.querySelector('canvas.main-menu-atmosphere');
      const lightning = canvas.__rotwLightningEvents.at(-1);
      const eruption = canvas.__rotwEruptionEvents.at(-1);
      return { lightningAge: lightning ? canvas.__rotwSeconds - lightning.time : -1,
        eruptionAge: eruption ? canvas.__rotwSeconds - eruption.time : -1 };
    })()`);
    if (!lightningStill && eventState.lightningAge >= 0 && eventState.lightningAge <= .3) {
      lightningStill = path.join(OUTPUT, 'menu-piorun-1920x1080.png');
      await capture('png', lightningStill);
    }
    if (!eruptionStill && eventState.eruptionAge >= .45 && eventState.eruptionAge <= .9) {
      eruptionStill = path.join(OUTPUT, 'menu-erupcja-1920x1080.png');
      await capture('png', eruptionStill);
    }
    await delay(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
  }
  const webp = path.join(OUTPUT, 'menu-ruch-960x540.webp');
  const animated = await encodeWebp(frameDirectory, webp);
  if (!animated) {
    const fallback = path.join(OUTPUT, 'frames');
    await mkdir(fallback, { recursive: true });
    for (const name of await readdir(frameDirectory)) {
      const source = path.join(frameDirectory, name);
      const destination = path.join(fallback, name);
      await copyFile(source, destination);
    }
  }

  const events = await evaluate(`(() => {
    const canvas = document.querySelector('canvas.main-menu-atmosphere');
    return { lightning: canvas.__rotwLightningEvents.slice(),
      eruption: canvas.__rotwEruptionEvents.slice() };
  })()`);
  const lightningIntervals = events.lightning.slice(1)
    .map((event, index) => event.time - events.lightning[index].time);
  insist(events.lightning.length >= 4
    && events.lightning[0].time >= 3 && events.lightning[0].time <= 6.15
    && lightningIntervals.every(interval => interval >= 3 && interval <= 6.15),
  'Pioruny błyskają losowo co 3–6 sekund', { events: events.lightning,
    intervals: lightningIntervals });
  insist(new Set(events.lightning.map(event => event.zone)).size >= 2,
    'Błyskawice pojawiają się w różnych miejscach nieba', events.lightning);
  insist(events.eruption.length >= 2
    && new Set(events.eruption.map(event => event.site)).size >= 2,
  'Wyrzut z odległej szczeliny występuje okresowo w różnych wariantach', events.eruption);
  insist(Boolean(lightningStill && eruptionStill),
    'Utrwalono rzeczywiste klatki błysku i erupcji', { lightningStill, eruptionStill });
  const eventPixelAudit = await auditStaticScenery(baseline, lightningStill, eruptionStill);
  insist(eventPixelAudit.protectedChanged === 0,
    'Podczas błysku i erupcji postacie, łańcuch, skały, ruiny i menu pozostają nieruchome',
    eventPixelAudit);

  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await until(() => evaluate("document.querySelector('canvas.main-menu-atmosphere')?.dataset.motion === 'reduced'"),
    'tryb ograniczonego ruchu');
  insist(await evaluate("document.querySelector('canvas.main-menu-atmosphere')?.dataset.motion === 'reduced'"),
    'Animacja zatrzymuje się przy ograniczeniu ruchu');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  // CDP changes the media query but does not reliably dispatch its change event.
  await evaluate("window.dispatchEvent(new Event('resize'))");
  await until(() => evaluate("document.querySelector('canvas.main-menu-atmosphere')?.dataset.motion === 'running'"),
    'wznowienie animacji');

  await click('#menu-open-settings');
  await until(() => evaluate("document.querySelector('#main-menu-settings')?.hidden === false"),
    'otwarcie ustawień');
  await click('#menu-settings-back');
  await until(() => evaluate("document.querySelector('#main-menu-actions')?.hidden === false"),
    'powrót do menu');
  insist(exceptions.length === 0, 'Bez wyjątków JavaScript', exceptions);

  const result = { sourceUrl: appUrl.href, viewport: [WIDTH, HEIGHT], initial, after,
    screenshotBaseline: baseline, screenshotBefore: first, screenshotAfter: second,
    lightningStill, eruptionStill,
    animatedWebp: animated ? webp : null, frameCount: FRAME_COUNT,
    pixelAudit, eventPixelAudit, events, lightningIntervals,
    tested: ['obraz menu', 'precyzyjna maska lawy', 'nieruchome otoczenie',
      'ruch lawy', 'dym w tle', 'pioruny 3–6 s', 'okresowe erupcje',
      'stały układ przycisków',
      'klikalność przycisków', 'otwarcie ustawień i powrót'], exceptions };
  await writeFile(path.join(OUTPUT, 'capture-results.json'), JSON.stringify(result, null, 2));
  console.log(`RESULT ${JSON.stringify({ output: OUTPUT, animated, exceptions })}`);
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  if (browser) {
    const cleaned = await cleanupTrackedBrowser(browser);
    console.log(`CLEANUP ${JSON.stringify({ remainingBrowserProcesses: cleaned.remaining.length })}`);
  }
  if (frameDirectory) {
    const target = path.resolve(frameDirectory);
    const tempRoot = path.resolve(os.tmpdir());
    if (target.startsWith(`${tempRoot}${path.sep}`)
      && path.basename(target).startsWith('rotw-menu-atmosphere-')) {
      await rm(target, { recursive: true, force: true });
    }
  }
}
