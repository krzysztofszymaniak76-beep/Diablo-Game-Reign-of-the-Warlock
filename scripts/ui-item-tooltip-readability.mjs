// Offscreen check of the real inventory tooltip at 1080p and 4K.
// Uses its own HTTP server, disposable save path and disposable Chrome profile.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cleanupTrackedBrowser, launchTrackedBrowser } from './browser-lifecycle.mjs';

const root = process.cwd();
const evidence = path.join(root, 'docs', 'evidence', 'item-tooltip-readability');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
let browser;
let socket;
let server;
let temporary;
let sequence = 0;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function send(method, params = {}) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result?.value;
}

async function until(expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return;
    await wait(100);
  }
  throw new Error(`Nie znaleziono: ${label}`);
}

async function render(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.querySelector("#camp-open-inventory")?.click()');
  await until('Boolean(document.querySelector("#inventory-grid .inventory-item"))', 'przedmiot w ekwipunku');
  const point = await evaluate(`(() => {
    const item = document.querySelector('#inventory-grid .inventory-item');
    const rect = item.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await until('Boolean(document.querySelector("#rotw-item-tooltip.is-visible"))', 'tooltip');
  const measured = await evaluate(`(() => {
    const tip = document.querySelector('#rotw-item-tooltip');
    const name = tip.querySelector('.rotw-item-tooltip-name');
    const rect = tip.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight], name: name.textContent,
      bodyFont: Number.parseFloat(getComputedStyle(tip).fontSize),
      nameFont: Number.parseFloat(getComputedStyle(name).fontSize),
      rowFonts: [...tip.querySelectorAll('.rotw-item-tooltip-row,.rotw-item-tooltip-property')]
        .map(node => Number.parseFloat(getComputedStyle(node).fontSize)),
      rect: [rect.left, rect.top, rect.right, rect.bottom],
      lines: tip.innerText.split('\\n').filter(Boolean),
    };
  })()`);
  if (Math.abs(measured.viewport[0] - width) > 1 || Math.abs(measured.viewport[1] - height) > 1
    || measured.bodyFont < (width >= 3840 ? 35 : 17)
    || measured.nameFont < (width >= 3840 ? 42 : 20)
    || measured.rowFonts.length === 0 || measured.rowFonts.some(size => size < (width >= 3840 ? 35 : 17))
    || measured.rect[0] < -1 || measured.rect[1] < -1
    || measured.rect[2] > width + 1 || measured.rect[3] > height + 1) {
    throw new Error(`Tooltip nie spełnia wymagań ${width}×${height}: ${JSON.stringify(measured)}`);
  }
  const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(path.join(evidence, `tooltip-${width}x${height}.png`), Buffer.from(image.data, 'base64'));
  console.log(`PASS ${width}×${height}: body ${measured.bodyFont}px, name ${measured.nameFont}px; ${measured.name}`);
  return measured;
}

try {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'rotw-tooltip-readability-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ROTW_SAVE_FILE: path.join(temporary, 'save.json') },
  });
  let healthy = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${origin}/__rotw_health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      healthy = response.ok && path.resolve(health.projectRoot) === path.resolve(root);
      if (healthy) break;
    } catch { /* server is starting */ }
    await wait(100);
  }
  if (!healthy) throw new Error('Izolowany serwer gry nie uruchomił się');
  await mkdir(evidence, { recursive: true });
  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    appUrl: 'about:blank', windowSize: '1920,1080', stdio: ['ignore', 'ignore', 'pipe'],
    extraArgs: ['--mute-audio', '--no-sandbox', '--disable-software-rasterizer'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('Brak testowej karty przeglądarki');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(typeof data === 'string' ? data : await data.text());
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${origin}/?skip-team-selection=1` });
  await until('Boolean(window.__rotwDebug?.snapshot) && document.readyState === "complete"', 'gotowa gra');
  await until('document.querySelector("#camp-layer")?.getAttribute("aria-hidden") === "false"', 'obóz');
  const result = [await render(1920, 1080), await render(3840, 2160)];
  await writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(result, null, 2));
} finally {
  socket?.close();
  if (browser) await cleanupTrackedBrowser(browser);
  server?.kill();
  if (temporary && path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    await rm(temporary, { recursive: true, force: true });
  }
}
