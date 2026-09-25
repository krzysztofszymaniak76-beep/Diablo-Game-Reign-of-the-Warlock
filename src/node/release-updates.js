import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const RELEASE_VERSION = '0.1';
export const RELEASE_REPOSITORY = 'krzysztofszymaniak76-beep/Diablo-Game';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const INSTALLER_PREFIX = 'Diablo-Game-Reign-of-the-Warlock-Setup-';
const MAX_INSTALLER_BYTES = 800 * 1024 * 1024;

export function parseReleaseVersion(value) {
  const match = /^v?(\d+)\.(\d+)$/.exec(String(value ?? ''));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && minor <= 9 &&
    (major > 0 || minor > 0) ? [major, minor] : null;
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error('Nieprawidłowy numer wydania gry');
  return Math.sign(a[0] - b[0]) || Math.sign(a[1] - b[1]);
}

export function expectedInstallerName(version) {
  if (!parseReleaseVersion(version) || String(version).startsWith('v')) throw new Error('Nieprawidłowy numer instalatora');
  return `${INSTALLER_PREFIX}${version}.exe`;
}

export function readLatestRelease(data, currentVersion = RELEASE_VERSION) {
  const current = { currentVersion, latestVersion: currentVersion, updateAvailable: false, release: null };
  if (!data || typeof data !== 'object' || data.draft || data.prerelease) return current;
  const parsed = parseReleaseVersion(data.tag_name);
  if (!parsed) return { ...current, error: 'Najnowsze wydanie ma nieprawidłowy numer.' };
  const latestVersion = `${parsed[0]}.${parsed[1]}`;
  const release = {
    version: latestVersion,
    date: typeof data.published_at === 'string' ? data.published_at.slice(0, 10) : null,
    changes: String(data.body ?? '').split(/\r?\n/).map(line => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim()).filter(Boolean).slice(0, 100),
  };
  const result = { ...current, latestVersion, release };
  if (compareReleaseVersions(latestVersion, currentVersion) <= 0) return result;
  const asset = Array.isArray(data.assets) ? data.assets.find(item => item?.name === expectedInstallerName(latestVersion)) : null;
  if (!asset) return { ...result, error: 'Nowsza wersja nie ma kompletnego instalatora.' };
  const url = new URL(asset.browser_download_url);
  const expectedPath = `/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(data.tag_name)}/${encodeURIComponent(asset.name)}`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== expectedPath || url.search || url.hash) {
    return { ...result, error: 'Adres instalatora w wydaniu jest nieprawidłowy.' };
  }
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest ?? ''));
  if (!digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) {
    return { ...result, error: 'Instalator nie ma poprawnej sumy SHA-256 lub rozmiaru.' };
  }
  return {
    ...result,
    updateAvailable: true,
    installer: { url: url.href, name: asset.name, sha256: digest[1].toLowerCase(), size: asset.size },
  };
}

export async function checkGitHubRelease({ fetchImpl = fetch, signal, currentVersion = RELEASE_VERSION } = {}) {
  const response = await fetchImpl(RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Kris-Labs-PL-Reign-of-the-Warlock-Updater' },
    signal,
  });
  if (response.status === 404) return {
    currentVersion, latestVersion: currentVersion, updateAvailable: false, release: null,
    error: 'Wydanie gry nie jest jeszcze dostępne na GitHubie.',
  };
  if (!response.ok) throw new Error(`GitHub nie odpowiedział poprawnie (HTTP ${response.status}).`);
  return readLatestRelease(await response.json(), currentVersion);
}

function updateDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Kris Labs PL', 'Reign of the Warlock', 'updates');
}

export async function downloadVerifiedInstaller(release, {
  fetchImpl = fetch, directory = updateDirectory(), signal,
} = {}) {
  if (!release?.updateAvailable || !release.installer) throw new Error('Brak zweryfikowanego nowszego wydania.');
  const { url, name, sha256, size } = release.installer;
  if (name !== expectedInstallerName(release.latestVersion) ||
      !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) {
    throw new Error('Nieprawidłowe metadane instalatora.');
  }
  const installerUrl = new URL(url);
  if (installerUrl.protocol !== 'https:' || installerUrl.hostname !== 'github.com' ||
      !installerUrl.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/download/`)) {
    throw new Error('Niedozwolony adres pobierania instalatora.');
  }
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  try {
    const existing = await stat(target);
    if (existing.size === size) {
      const handle = await open(target, 'r');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream()) hash.update(chunk);
      if (hash.digest('hex') === sha256) return target;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(url, { signal, headers: { 'user-agent': 'Kris-Labs-PL-Reign-of-the-Warlock-Updater' } });
  if (!response.ok || !response.body) throw new Error(`Nie udało się pobrać instalatora (HTTP ${response.status}).`);
  const temporary = path.join(directory, `${name}.${process.pid}.${Date.now()}.download`);
  const handle = await open(temporary, 'wx');
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > size || bytes > MAX_INSTALLER_BYTES) throw new Error('Pobrany instalator przekracza podany rozmiar.');
      hash.update(chunk);
      for (let offset = 0; offset < chunk.length;) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten <= 0) throw new Error('Nie udało się zapisać pobranego instalatora.');
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  if (bytes !== size || hash.digest('hex') !== sha256) {
    await rm(temporary, { force: true });
    throw new Error('Kontrola rozmiaru lub SHA-256 instalatora nie powiodła się.');
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await rename(target, `${target}.invalid-${Date.now()}`);
    await rename(temporary, target);
  }
  return target;
}

export async function launchInstaller(installerPath, { spawnImpl = spawn } = {}) {
  if (path.extname(installerPath).toLowerCase() !== '.exe') throw new Error('Wydanie nie zawiera instalatora EXE.');
  const child = spawnImpl(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return true;
}
