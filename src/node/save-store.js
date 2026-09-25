import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GameState, SAVE_SCHEMA_VERSION } from "../core/state.js";

export async function saveAtomic(filePath, gameState) {
  const absolute = path.resolve(filePath);
  const serialized = gameState.serialize();
  GameState.deserialize(structuredClone(serialized));
  const encoded = `${JSON.stringify(serialized, null, 2)}\n`;
  await mkdir(path.dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.tmp`;
  const backupPath = `${absolute}.bak`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      const previous = await readFile(absolute, "utf8");
      let parsed = null;
      try { parsed = JSON.parse(previous); } catch { /* malformed primary is not backup material */ }
      if (Number.isInteger(parsed?.schemaVersion) && parsed.schemaVersion !== SAVE_SCHEMA_VERSION) {
        const error = new Error(`Unsupported primary save schema preserved: ${parsed.schemaVersion}`);
        error.stopSavePublish = true;
        throw error;
      }
      if (parsed) {
        let previousIsValid = false;
        try { GameState.deserialize(parsed); previousIsValid = true; }
        catch { /* same-schema invalid data is not backup material */ }
        if (previousIsValid) await copyFile(absolute, backupPath);
      }
    } catch (error) {
      if (error.stopSavePublish || (error.code && error.code !== "ENOENT")) throw error;
    }
    await rename(tempPath, absolute);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function loadGame(filePath) {
  const absolute = path.resolve(filePath);
  const failures = [];
  for (const [index, candidate] of [absolute, `${absolute}.bak`].entries()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (index === 0 && Number.isInteger(parsed?.schemaVersion)
        && parsed.schemaVersion !== SAVE_SCHEMA_VERSION) {
        const error = new Error(`Unsupported primary save schema preserved: ${parsed.schemaVersion}`);
        error.stopSaveFallback = true;
        throw error;
      }
      return GameState.deserialize(parsed);
    } catch (error) {
      if (error.stopSaveFallback) throw error;
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "Primary save and backup could not be loaded");
}

export async function removeSaveArtifacts(filePath) {
  for (const suffix of ["", ".tmp", ".bak"]) {
    await rm(`${path.resolve(filePath)}${suffix}`, { force: true });
  }
}
