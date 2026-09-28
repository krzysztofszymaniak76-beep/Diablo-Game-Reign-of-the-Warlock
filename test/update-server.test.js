import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('update installation endpoint refuses foreign origin and rejects unknown actions', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'rotw-update-http-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port)], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ROTW_SAVE_FILE: path.join(temp, 'save.json'), ROTW_INSTALLED_MODE: '0' },
  });
  t.after(() => child.kill());
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/__rotw_health`);
      ready = response.ok;
      if (ready) break;
    } catch { /* Server still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(ready, true);
  const foreign = await fetch(`${url}/__rotw_update`, {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install' }),
  });
  assert.equal(foreign.status, 403);
  const source = await fetch(`${url}/__rotw_update`, {
    method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'invalid' }),
  });
  assert.equal(source.status, 409);
  assert.match((await source.json()).error, /Nieznana operacja aktualizacji/);
});
