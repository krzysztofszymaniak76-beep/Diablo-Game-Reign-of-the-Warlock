import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_BROWSER_SAVE_BYTES = 8 * 1024 * 1024;

// This is the full browser save envelope, not the older, smaller GameState v1.
// Deep world validation remains in the browser's validateSaveEnvelope/stageGameState.
export function validateBrowserSaveEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 3) {
    throw new Error('Nieobsługiwany format pełnego zapisu gry');
  }
  if (!Array.isArray(value.roster) || value.roster.length < 1
    || !Array.isArray(value.partyIds) || value.partyIds.length < 1 || value.partyIds.length > 3
    || new Set(value.partyIds).size !== value.partyIds.length
    || !value.combat || !value.battlePreparation || !value.hexGrid
    || !Array.isArray(value.inventories) || !value.campServices
    || !value.horadricCube || !value.encounterProgress
    || !value.rng || !value.portals) {
    throw new Error('Niekompletny pełny zapis gry');
  }
  return value;
}

function classify(raw) {
  if (raw === null) return 'absent';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== 3) return 'incompatible';
    validateBrowserSaveEnvelope(parsed);
    return 'valid';
  } catch { return 'corrupt'; }
}

async function optionalRead(file) {
  try {
    const info = await stat(file);
    if (info.size > MAX_BROWSER_SAVE_BYTES) return { raw: null, issue: 'oversize' };
    return { raw: await readFile(file, 'utf8'), issue: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, issue: null };
    throw error;
  }
}

export async function readBrowserSave(filePath) {
  const absolute = path.resolve(filePath);
  const [primary, backup] = await Promise.all([
    optionalRead(absolute), optionalRead(`${absolute}.bak`),
  ]);
  return { primary: primary.raw, backup: backup.raw,
    primaryIssue: primary.issue, backupIssue: backup.issue };
}

async function atomicWrite(file, raw) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file);
  }
  catch (error) {
    try { await rm(temp, { force: true }); } catch { /* retain original error */ }
    throw error;
  }
}

let writes = Promise.resolve();
export function writeBrowserSave(filePath, raw, {
  preserveBackup = false, preservePrimary = false, preserveInvalidBackup = false,
} = {}) {
  const work = writes.catch(() => {}).then(async () => {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BROWSER_SAVE_BYTES) {
      throw new Error('Nieprawidłowy rozmiar zapisu');
    }
    validateBrowserSaveEnvelope(JSON.parse(raw));
    const absolute = path.resolve(filePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const { primary, backup, primaryIssue, backupIssue } = await readBrowserSave(absolute);
    const primaryKind = primaryIssue ? 'corrupt' : classify(primary);
    const backupKind = backupIssue ? 'corrupt' : classify(backup);
    if (primaryKind === 'incompatible' || backupKind === 'incompatible') {
      throw new Error('Zapis z nowszego lub obcego schematu zachowano bez zmian');
    }
    if ((primary !== null || primaryIssue) && (primaryKind === 'corrupt' || preservePrimary)) {
      // Recovery never destroys damaged bytes, including valid-looking JSON that
      // the browser's full staged validator rejected.
      await copyFile(absolute, `${absolute}.corrupt-${Date.now()}-${randomUUID()}`);
    }
    if (!preserveBackup && primaryKind === 'valid' && !preservePrimary) {
      if ((backup !== null || backupIssue) && (backupKind === 'corrupt' || preserveInvalidBackup)) {
        await copyFile(`${absolute}.bak`, `${absolute}.bak.corrupt-${Date.now()}-${randomUUID()}`);
      }
      await atomicWrite(`${absolute}.bak`, primary);
    }
    await atomicWrite(absolute, raw);
    if ((await optionalRead(absolute)).raw !== raw) throw new Error('Kontrola odczytu zapisu nie powiodła się');
    return true;
  });
  writes = work;
  return work;
}
