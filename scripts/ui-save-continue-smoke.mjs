// Disposable end-to-end save check. Never touches the player's browser profile
// or work/player-save-v3.json; both ports share only a temporary save file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cleanupTrackedBrowser, launchTrackedBrowser } from './browser-lifecycle.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = await mkdtemp(path.join(os.tmpdir(), 'rotw-save-ui-'));
const saveFile = path.join(temp, 'full-game.json');
let browser;
let socket;
let server;
let nextId = 0;
const pending = new Map();

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}

async function until(read, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}

async function startServer(port) {
  server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ROTW_SAVE_FILE: saveFile },
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    const response = await fetch(`${base}/__rotw_health`);
    const health = await response.json();
    return response.ok && health.pid === server.pid && health.saveApiVersion === 1;
  }, `server ${port}`);
  return base;
}

async function stopServer() {
  if (!server) return;
  const old = server;
  server = null;
  if (old.exitCode !== null) return;
  old.kill();
  await Promise.race([new Promise(resolve => old.once('exit', resolve)), delay(3_000)]);
  if (old.exitCode === null) old.kill('SIGKILL');
}

async function send(method, params = {}) {
  const id = ++nextId;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
}

async function click(selector) {
  const found = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled || element.hidden) return false;
    element.click(); return true;
  })()`);
  assert.equal(found, true, `clickable ${selector}`);
}

async function navigate(base) {
  await send('Page.navigate', { url: `${base}/` });
  await until(() => evaluate('Boolean(window.__rotwDebug && document.querySelector("#main-menu")?.hidden === false)'), 'main menu');
  await until(() => evaluate('document.querySelector("#menu-new-game")?.disabled === false'), 'save probe complete');
}

async function keyEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

try {
  const port1 = await freePort();
  let port2 = await freePort();
  while (port2 === port1) port2 = await freePort();
  const base1 = await startServer(port1);
  browser = await launchTrackedBrowser({
    edgePath: process.env.ROTW_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    appUrl: 'about:blank', windowSize: '1536,864', stdio: ['ignore', 'ignore', 'pipe'],
    extraArgs: ['--mute-audio', '--no-sandbox', '--disable-software-rasterizer', '--disable-gpu-compositing'],
  });
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = targets.find(item => item.type === 'page');
  assert.ok(page, 'isolated browser page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await navigate(base1);
  assert.equal(await evaluate('document.querySelector("#menu-continue").disabled'), true, 'no save disables Continue');
  await click('#menu-new-game');
  await until(() => evaluate('document.querySelector("#character-creation")?.hidden === false'), 'character creation');
  await click('#character-creation-classes button[data-hero-id="korgan"]');
  await click('#character-creation-confirm');
  await until(() => evaluate('document.querySelector("#character-creation")?.hidden === true && document.querySelector("#main-menu")?.hidden === true'), 'camp after creation');
  await until(async () => (await fetch(`${base1}/__rotw_save`).then(response => response.json())).primary, 'created save on disk');
  await keyEscape();
  await until(() => evaluate('document.querySelector("#main-menu")?.hidden === false'), 'camp menu');
  await click('#menu-open-settings');
  await evaluate(`(() => {
    for (const [id, value] of [['menu-music-volume','20'], ['menu-effects-volume','35']]) {
      const control = document.getElementById(id); control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await click('#menu-settings-back');
  await click('#menu-save-exit');
  await until(() => evaluate('document.querySelector("#main-menu")?.dataset.context === "title"'), 'saved return to title');
  const diskBytes = await readFile(saveFile, 'utf8');
  const diskSave = JSON.parse(diskBytes);
  assert.equal(diskSave.settings.musicVolume, 0.2, 'music preference is in full disk save');
  assert.equal(diskSave.settings.effectsVolume, 35, 'effects preference is in full disk save');
  await stopServer();

  const base2 = await startServer(port2);
  await navigate(base2);
  await until(() => evaluate('document.querySelector("#menu-continue")?.disabled === false'), 'Continue on new port');
  await click('#menu-new-game');
  await until(() => evaluate('document.querySelector("#main-menu-new-game-confirm")?.hidden === false'), 'overwrite confirmation');
  assert.equal(await readFile(saveFile, 'utf8'), diskBytes, 'opening New Game does not overwrite save');
  await click('#menu-new-game-back');
  // A stale origin-local save is deliberately different from the canonical
  // disk slot. Continue must choose the newer disk state, not this local copy.
  const stale = structuredClone(diskSave);
  stale.settings.musicVolume = 0.73;
  stale.settings.effectsVolume = 78;
  stale.campaign.worldSeed = stale.campaign.worldSeed === 1 ? 2 : 1;
  await evaluate(`localStorage.setItem(window.__rotwDebug.storageKeys.current, ${JSON.stringify(JSON.stringify(stale))})`);
  await click('#menu-continue');
  await until(() => evaluate('document.querySelector("#main-menu")?.hidden === true'), 'Continue loads saved camp');
  const result = await evaluate('window.__rotwDebug.snapshot().save');
  assert.equal(result.campaign.worldSeed, diskSave.campaign.worldSeed, 'disk world wins over stale origin');
  assert.equal(result.settings.musicVolume, 0.2, 'music restored from disk on another port');
  assert.equal(result.settings.effectsVolume, 35, 'effects restored from disk on another port');
  assert.deepEqual(result.partyIds, diskSave.partyIds, 'party survives restart');
  assert.deepEqual(result.inventories, diskSave.inventories, 'items survive restart');
  assert.deepEqual(result.campServices, diskSave.campServices, 'vendor stock does not rotate on Continue');
  assert.equal(await readFile(saveFile, 'utf8'), diskBytes, 'Continue does not rewrite canonical save');
  console.log('PASS isolated UI save/Continue/new-game guard across two ports');
} finally {
  try { socket?.close(); } catch { /* cleanup below */ }
  await cleanupTrackedBrowser(browser);
  await stopServer();
  await rm(temp, { recursive: true, force: true });
}
