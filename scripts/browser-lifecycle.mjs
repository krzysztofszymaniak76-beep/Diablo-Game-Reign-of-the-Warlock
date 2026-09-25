import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_ROOTS = 2;
const REGISTRY_DIR = path.join(os.tmpdir(), 'rotw-browser-registry');
const trackedBrowsers = new Set();
let handlersInstalled = false;
let globalCleanupPromise = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(command, args = [], timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill(); resolve({ code: null, stdout, stderr }); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timeout); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

export async function processSnapshot() {
  if (process.platform !== 'win32') return [];
  const script = "$names=@('msedge.exe','chrome.exe','chromium.exe','msedgewebview2.exe'); Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      name: String(row.Name ?? ''),
      commandLine: String(row.CommandLine ?? ''),
    })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

export async function captureOwnedProcessTree(rootPid, snapshot = null) {
  const rows = snapshot ?? await processSnapshot();
  const owned = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parentPid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
    }
  }
  return rows.filter((row) => owned.has(row.pid));
}

async function pidExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  const rows = await processSnapshot();
  return rows.some((row) => row.pid === Number(pid));
}

async function readRegistry() {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const entries = await readdir(REGISTRY_DIR, { withFileTypes: true });
  const records = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
    const file = path.join(REGISTRY_DIR, entry.name);
    try { records.push({ file, value: JSON.parse(await readFile(file, 'utf8')) }); } catch { await rm(file, { force: true }).catch(() => {}); }
  }
  return records;
}

async function acquireSlot(metadata) {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const rows = await processSnapshot();
  for (const record of await readRegistry()) {
    const profileHeld = record.value?.profileDirectory
      && rows.some((row) => row.commandLine.includes(record.value.profileDirectory));
    if (!record.value?.rootPid || (!(await pidExists(record.value.rootPid)) && !profileHeld)) {
      await rm(record.file, { force: true }).catch(() => {});
    }
  }
  for (let index = 0; index < MAX_ROOTS; index += 1) {
    const file = path.join(REGISTRY_DIR, `slot-${index}.json`);
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify(metadata));
      await handle.close();
      return file;
    } catch { /* another process owns this slot */ }
  }
  throw new Error(`Limit testowych przeglądarek osiągnięty: maksymalnie ${MAX_ROOTS} root procesy.`);
}

async function updateSlot(file, metadata) {
  if (!file) return;
  await writeFile(file, JSON.stringify(metadata)).catch(() => {});
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(80);
  }
  throw new Error(`Timeout lifecycle: ${label}`);
}

async function waitForDevtools(profileDirectory, timeoutMs) {
  return waitFor(async () => {
    try {
      const [line, page] = (await readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const port = Number(line);
      if (!Number.isInteger(port) || port <= 0) return false;
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return { port, target: targets.find((item) => item.type === 'page') ?? null, page };
    } catch { return false; }
  }, timeoutMs, 'DevToolsActivePort');
}

export async function launchTrackedBrowser({
  edgePath = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  appUrl = 'about:blank',
  extraArgs = [],
  windowSize = '1536,864',
  startupTimeoutMs = 45_000,
  waitForDevtools: awaitDevtools = true,
  stdio = ['ignore', 'pipe', 'pipe'],
} = {}) {
  const sessionId = `rotw-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), `${sessionId}-`));
  const slotFile = await acquireSlot({ sessionId, rootPid: null, profileDirectory, createdAt: new Date().toISOString() }).catch(async (error) => {
    await rm(profileDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  });
  const args = [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-background-mode', '--disable-component-update', '--disable-features=msEdgeStartupBoost',
    '--no-service-autorun', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
    `--window-size=${windowSize}`, '--force-device-scale-factor=1', ...extraArgs,
  ];
  if (appUrl) args.push(appUrl);
  let child;
  try {
    child = spawn(edgePath, args, { stdio, windowsHide: true });
    const record = { sessionId, child, rootPid: child.pid, profileDirectory, slotFile, port: null, cleanupPromise: null };
    trackedBrowsers.add(record);
    await updateSlot(slotFile, { sessionId, rootPid: child.pid, profileDirectory, createdAt: new Date().toISOString() });
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
    if (awaitDevtools) {
      const devtools = await waitForDevtools(profileDirectory, startupTimeoutMs);
      record.port = devtools.port;
      record.target = devtools.target;
    }
    record.stderr = () => stderr;
    return record;
  } catch (error) {
    const record = { sessionId, child, rootPid: child?.pid, profileDirectory, slotFile, cleanupPromise: null };
    await cleanupTrackedBrowser(record);
    throw error;
  }
}

async function terminateTree(rootPid, knownTree = []) {
  if (!rootPid) return;
  const pids = [...new Set([rootPid, ...knownTree.map((row) => row.pid)])].reverse();
  for (const pid of pids) await command('taskkill.exe', ['/pid', String(pid), '/t', '/f'], 5_000);
  await waitFor(async () => (await captureOwnedProcessTree(rootPid)).length === 0, 8_000, `process tree ${rootPid} gone`).catch(() => {});
}

export async function cleanupTrackedBrowser(record) {
  if (!record) return { rootPid: null, childCount: 0, remaining: [] };
  if (record.cleanupPromise) return record.cleanupPromise;
  record.cleanupPromise = (async () => {
    const rootPid = record.rootPid ?? record.child?.pid;
    const before = rootPid ? await captureOwnedProcessTree(rootPid) : [];
    try { record.child?.kill?.(); } catch { /* continue with tree cleanup */ }
    await delay(350);
    if (rootPid) await terminateTree(rootPid, before);
    const remaining = rootPid ? await captureOwnedProcessTree(rootPid) : [];
    if (record.slotFile) await rm(record.slotFile, { force: true }).catch(() => {});
    if (record.profileDirectory) await rm(record.profileDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => {});
    trackedBrowsers.delete(record);
    return { rootPid, before, childCount: before.length > 0 ? before.length - 1 : 0, remaining };
  })();
  return record.cleanupPromise;
}

export async function safeClosePage(page) { try { await page?.close?.(); } catch { /* independent cleanup */ } }
export async function safeCloseContext(context) { try { await context?.close?.(); } catch { /* independent cleanup */ } }
export async function safeCloseBrowser(browser) { try { await browser?.close?.(); } catch { /* independent cleanup */ } }

export async function cleanupAllTrackedResources() {
  if (globalCleanupPromise) return globalCleanupPromise;
  globalCleanupPromise = Promise.all([...trackedBrowsers].map((record) => cleanupTrackedBrowser(record))).then((results) => results.flat());
  return globalCleanupPromise;
}

export function installGlobalCleanupHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const handle = async (signal, code) => { await cleanupAllTrackedResources(); process.exit(code); };
  process.once('SIGINT', () => { void handle('SIGINT', 130); });
  process.once('SIGTERM', () => { void handle('SIGTERM', 143); });
  process.once('uncaughtException', async (error) => { console.error(error); await cleanupAllTrackedResources(); process.exit(1); });
  process.once('unhandledRejection', async (error) => { console.error(error); await cleanupAllTrackedResources(); process.exit(1); });
}

export async function isPortListening(port) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(400, () => { socket.destroy(); resolve(false); });
  });
}

export async function lifecycleSnapshot() {
  const rows = await processSnapshot();
  const registry = await readRegistry();
  const owned = [];
  for (const record of registry) {
    if (record.value?.rootPid) owned.push({ ...record.value, tree: await captureOwnedProcessTree(record.value.rootPid, rows) });
  }
  return { registryDir: REGISTRY_DIR, maxRoots: MAX_ROOTS, owned, processCount: rows.length };
}

export { MAX_ROOTS, REGISTRY_DIR, trackedBrowsers };
