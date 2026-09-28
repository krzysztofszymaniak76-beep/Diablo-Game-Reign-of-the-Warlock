import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_VERSION, RELEASE_REPOSITORY, compareReleaseVersions, parseReleaseVersion,
  expectedInstallerName, readLatestRelease, checkGitHubRelease, downloadVerifiedInstaller, launchInstaller,
} from '../src/node/release-updates.js';

function release(version, bytes = Buffer.from('private local installer test')) {
  const tag = `v${version}`;
  const name = expectedInstallerName(version);
  return {
    tag_name: tag, published_at: '2026-09-25T12:00:00Z', body: '- Nowa mapa\n- Naprawiono zapisy',
    draft: false, prerelease: false,
    assets: [{ name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      browser_download_url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}` }],
  };
}

test('public version sequence passes 0.9 to 1.0 and rejects 0.10', () => {
  assert.equal(RELEASE_VERSION, '0.3');
  assert.equal(compareReleaseVersions('1.0', '0.9'), 1);
  assert.equal(compareReleaseVersions('2.0', '1.9'), 1);
  assert.equal(compareReleaseVersions('0.2', '0.9'), -1);
  assert.equal(parseReleaseVersion('0.10'), null);
  assert.equal(parseReleaseVersion('0.0'), null);
  assert.throws(() => compareReleaseVersions('0.10', '0.9'));
});

test('new release is offered only with exact installer, size and digest', () => {
  const good = readLatestRelease(release('0.4'));
  assert.equal(good.updateAvailable, true);
  assert.deepEqual(good.release.changes, ['Nowa mapa', 'Naprawiono zapisy']);
  assert.equal(good.release.date, '2026-09-25');
  assert.equal(readLatestRelease(release('0.1')).updateAvailable, false);
  const noDigest = release('0.4');
  delete noDigest.assets[0].digest;
  assert.equal(readLatestRelease(noDigest).updateAvailable, false);
  const wrongHost = release('0.4');
  wrongHost.assets[0].browser_download_url = 'https://attacker.example/setup.exe';
  assert.equal(readLatestRelease(wrongHost).updateAvailable, false);
  const noInstaller = release('0.4');
  noInstaller.assets = [];
  assert.equal(readLatestRelease(noInstaller).updateAvailable, false);
});

test('GitHub 404 is a visible no-release state, not a phantom update', async () => {
  const result = await checkGitHubRelease({ fetchImpl: async () => ({ status: 404 }) });
  assert.equal(result.updateAvailable, false);
  assert.match(result.error, /nie jest jeszcze dostępne/);
});

test('download verifies exact bytes and SHA-256 before installer can launch', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rotw-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('EXE test bytes 0.4');
  const latest = readLatestRelease(release('0.4', bytes));
  const fetchImpl = async url => {
    assert.equal(url, latest.installer.url);
    return new Response(bytes, { status: 200 });
  };
  const file = await downloadVerifiedInstaller(latest, { directory, fetchImpl });
  assert.equal(path.basename(file), expectedInstallerName('0.4'));
  assert.deepEqual(await readFile(file), bytes);
  let downloadedAgain = false;
  assert.equal(await downloadVerifiedInstaller(latest, { directory, fetchImpl: async () => {
    downloadedAgain = true;
    throw new Error('cache should be used');
  } }), file);
  assert.equal(downloadedAgain, false);
});

test('damaged download is rejected and incomplete file is removed', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rotw-update-damage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const latest = readLatestRelease(release('0.3', Buffer.from('correct')));
  await assert.rejects(downloadVerifiedInstaller(latest, {
    directory, fetchImpl: async () => new Response(Buffer.from('damaged'), { status: 200 }),
  }), /SHA-256/);
  assert.deepEqual(await readdir(directory), []);
});

test('installer starts visibly only after validated EXE path', async () => {
  let called = false;
  const spawnImpl = (file, args, options) => {
    called = true;
    assert.equal(file, 'C:\\updates\\Setup.exe');
    assert.deepEqual(args, []);
    assert.equal(options.windowsHide, false);
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  assert.equal(await launchInstaller('C:\\updates\\Setup.exe', { spawnImpl }), true);
  assert.equal(called, true);
  let installArgs;
  const installDirectory = 'C:\\Users\\test\\Game Folder';
  await launchInstaller('C:\\updates\\Setup.exe', {
    spawnImpl: (file, args) => { installArgs = args; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; },
    installDirectory,
  });
  assert.deepEqual(installArgs, [`/DIR=${path.resolve(installDirectory)}`]);
  await assert.rejects(launchInstaller('C:\\updates\\package.zip', { spawnImpl }), /EXE/);
});
