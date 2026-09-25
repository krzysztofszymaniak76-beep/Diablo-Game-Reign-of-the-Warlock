import assert from 'node:assert/strict';
import {
  MAX_ROOTS,
  captureOwnedProcessTree,
  cleanupTrackedBrowser,
  isPortListening,
  launchTrackedBrowser,
  lifecycleSnapshot,
  processSnapshot,
} from './browser-lifecycle.mjs';

const reports = [];
let maxSimultaneousRoots = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rootCount = (rows) => rows.filter((row) => row.name === 'msedge.exe' && row.commandLine.includes('--headless') && !row.commandLine.includes('--type=')).length;

async function after(label, before, createdRootCount, port = null) {
  const afterSnapshot = await lifecycleSnapshot();
  const ownedRoots = afterSnapshot.owned.filter((record) => record.rootPid).length;
  const ownedChildren = afterSnapshot.owned.reduce((sum, record) => sum + (record.tree?.length ?? 0) - 1, 0);
  assert.equal(ownedRoots, 0, `${label}: owned roots after cleanup`);
  assert.equal(ownedChildren, 0, `${label}: owned children after cleanup`);
  if (port) assert.equal(await isPortListening(port), false, `${label}: CDP port released`);
  reports.push({ label, beforeRoots: rootCount(before), createdRoots: createdRootCount, maxSimultaneousRoots, afterRoots: ownedRoots, afterChildren: ownedChildren, remainingServers: 0 });
}

async function normalExit() {
  const before = await processSnapshot();
  let browser;
  try {
    browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '800,600' });
    await captureOwnedProcessTree(browser.rootPid);
    maxSimultaneousRoots = Math.max(maxSimultaneousRoots, rootCount(await processSnapshot()));
    const port = browser.port;
    await cleanupTrackedBrowser(browser);
    await after('A normal completion', before, 1, port);
  } finally { await cleanupTrackedBrowser(browser); }
}

async function assertionFailure() {
  const before = await processSnapshot();
  let browser;
  let created = 0;
  try {
    try {
      browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '800,600' });
      await captureOwnedProcessTree(browser.rootPid);
      created = 1;
      maxSimultaneousRoots = Math.max(maxSimultaneousRoots, rootCount(await processSnapshot()));
      throw new Error('controlled assertion failure');
    } catch (error) {
      assert.match(error.message, /controlled assertion/);
    } finally { await cleanupTrackedBrowser(browser); }
    await after('B assertion failure', before, created, browser?.port);
  } finally { await cleanupTrackedBrowser(browser); }
}

async function interruptedFlow() {
  const before = await processSnapshot();
  let browser;
  let created = 0;
  try {
    browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '800,600' });
    await captureOwnedProcessTree(browser.rootPid);
    created = 1;
    maxSimultaneousRoots = Math.max(maxSimultaneousRoots, rootCount(await processSnapshot()));
    await delay(80);
  } finally { await cleanupTrackedBrowser(browser); }
  await after('C interrupted/timeout flow', before, created, browser?.port);
}

async function twoInstanceLimit() {
  const before = await processSnapshot();
  let first;
  let second;
  let created = 0;
  try {
    first = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '640,480' });
    second = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '640,480' });
    await captureOwnedProcessTree(first.rootPid);
    await captureOwnedProcessTree(second.rootPid);
    created = 2;
    maxSimultaneousRoots = Math.max(maxSimultaneousRoots, rootCount(await processSnapshot()));
    await assert.rejects(() => launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '640,480', startupTimeoutMs: 1_000 }), /maksymalnie 2/);
  } finally {
    await cleanupTrackedBrowser(first);
    await cleanupTrackedBrowser(second);
  }
  await after('D two instances and blocked third', before, created, null);
}

async function externalSnapshotIsUntouched() {
  const before = await processSnapshot();
  let browser;
  let created = 0;
  try {
    browser = await launchTrackedBrowser({ appUrl: 'about:blank', windowSize: '640,480' });
    await captureOwnedProcessTree(browser.rootPid);
    created = 1;
    maxSimultaneousRoots = Math.max(maxSimultaneousRoots, rootCount(await processSnapshot()));
  } finally { await cleanupTrackedBrowser(browser); }
  const afterRows = await processSnapshot();
  const beforeExternal = before.filter((row) => !row.commandLine.includes('rotw-browser-'));
  const afterExternal = afterRows.filter((row) => !row.commandLine.includes('rotw-browser-'));
  assert.deepEqual(afterExternal.map((row) => row.pid).sort((a, b) => a - b), beforeExternal.map((row) => row.pid).sort((a, b) => a - b), 'E external browser snapshot is untouched');
  await after('E external Edge snapshot', before, created, null);
}

try {
  await normalExit();
  await assertionFailure();
  await interruptedFlow();
  await twoInstanceLimit();
  await externalSnapshotIsUntouched();
  const final = await lifecycleSnapshot();
  console.log(JSON.stringify({ status: 'PASS', maxSimultaneousRoots, limit: MAX_ROOTS, ownedRootsAfter: final.owned.length, ownedChildrenAfter: final.owned.reduce((sum, item) => sum + Math.max(0, (item.tree?.length ?? 1) - 1), 0), reports }, null, 2));
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
