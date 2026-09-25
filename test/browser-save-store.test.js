import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { MAX_BROWSER_SAVE_BYTES, readBrowserSave, writeBrowserSave } from '../src/node/browser-save-store.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = () => ({
  schemaVersion: 3, roster: [{ id: 'hero-1', name: 'Test' }], partyIds: ['hero-1'],
  campaign: { worldSeed: 43123, act1: { currentAreaId: 'act1.den_of_evil',
    exploration: { currentSectorId: 'den-4', movementSequence: 7, areaStates: { den: { discovered: ['a', 'b'] } } } } },
  combat: { scheduler: { time: 42 } }, battlePreparation: { phase: 'preparation' },
  hexGrid: { tiles: [] }, inventories: [['hero-1', { items: [{ id: 'one-unique-sword', affixes: ['x'] }] }]],
  campServices: { stash: { items: [{ id: 'stash-unique' }] } }, horadricCube: { items: [] },
  encounterProgress: { defeatedIds: ['fallen-1'] }, rng: { state: 99 }, portals: { locations: [] },
  settings: { schemaVersion: 1, musicVolume: .2, effectsVolume: 5, keybindings: null },
});

async function tempSave(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rotw-browser-save-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'player-save-v3.json');
}

test('full browser envelope is exact, rotates a valid primary and preserves damaged bytes', async t => {
  const file = await tempSave(t);
  const original = JSON.stringify(fixture());
  await writeBrowserSave(file, original);
  assert.equal((await readBrowserSave(file)).primary, original);

  const later = fixture(); later.campaign.act1.exploration.currentSectorId = 'den-5';
  later.inventories[0][1].items[0].id = 'second-instance';
  const laterRaw = JSON.stringify(later);
  await writeBrowserSave(file, laterRaw);
  assert.deepEqual(await readBrowserSave(file), {
    primary: laterRaw, backup: original, primaryIssue: null, backupIssue: null,
  });

  await writeFile(file, '{broken-json', 'utf8');
  const recovered = fixture(); recovered.campaign.act1.exploration.currentSectorId = 'recovered';
  await writeBrowserSave(file, JSON.stringify(recovered), { preserveBackup: true, preservePrimary: true });
  assert.equal((await readBrowserSave(file)).backup, original);
  const archived = (await readdir(path.dirname(file))).filter(name => name.includes('.corrupt-'));
  assert.equal(archived.length, 1);
  assert.equal(await readFile(path.join(path.dirname(file), archived[0]), 'utf8'), '{broken-json');

  await writeFile(file, JSON.stringify({ schemaVersion: 99 }), 'utf8');
  await assert.rejects(writeBrowserSave(file, laterRaw), /nowszego|obcego/);
  assert.equal(await readFile(file, 'utf8'), JSON.stringify({ schemaVersion: 99 }));
});

test('oversized primary is not loaded but the valid backup remains available and primary is archived', async t => {
  const file = await tempSave(t);
  const raw = JSON.stringify(fixture());
  await writeFile(file, 'x'.repeat(MAX_BROWSER_SAVE_BYTES + 1), 'utf8');
  await writeFile(`${file}.bak`, raw, 'utf8');
  const available = await readBrowserSave(file);
  assert.equal(available.primary, null);
  assert.equal(available.primaryIssue, 'oversize');
  assert.equal(available.backup, raw);
  await writeBrowserSave(file, raw, { preserveBackup: true, preservePrimary: true });
  assert.equal((await readBrowserSave(file)).primary, raw);
  assert.ok((await readdir(path.dirname(file))).some(name => name.includes('.corrupt-')));
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launchServer(port, file, t) {
  const processRef = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: projectRoot, env: { ...process.env, ROTW_SAVE_FILE: file },
    windowsHide: true, stdio: 'ignore',
  });
  t.after(() => processRef.kill());
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await fetch(`${url}/__rotw_health`);
      if (result.ok && (await result.json()).saveApiVersion === 1) return { processRef, url };
    } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start');
}

test('HTTP save survives a restart on another port; work file cannot be served statically', async t => {
  const file = await tempSave(t);
  const firstPort = await freePort();
  let secondPort = await freePort();
  while (secondPort === firstPort) secondPort = await freePort();
  const first = await launchServer(firstPort, file, t);
  const raw = JSON.stringify(fixture());
  const saved = await fetch(`${first.url}/__rotw_save`, {
    method: 'POST', headers: { origin: first.url, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).saved, true);
  assert.equal((await fetch(`${first.url}/work/player-save-v3.json`)).status, 404);
  const rejected = await fetch(`${first.url}/__rotw_save`, {
    method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  assert.equal(rejected.status, 403);
  first.processRef.kill();
  await new Promise(resolve => first.processRef.once('exit', resolve));
  const second = await launchServer(secondPort, file, t);
  const roundTrip = await (await fetch(`${second.url}/__rotw_save`)).json();
  assert.equal(roundTrip.primary, raw);
  assert.equal(roundTrip.backup, null);
  assert.deepEqual(JSON.parse(roundTrip.primary).inventories, fixture().inventories);
});
