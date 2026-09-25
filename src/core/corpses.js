import { axial, hexKey } from "./hex-grid.js";

export const CORPSE_SCHEMA_VERSION = 1;

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function requireHexId(value, label = "Corpse hexId") {
  if (typeof value !== "string" || !/^-?\d+,-?\d+$/.test(value)) {
    throw new TypeError(`${label} must be a canonical axial hex id`);
  }
  const [q, r] = value.split(",").map(Number);
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r) || hexKey(axial(q, r)) !== value) {
    throw new TypeError(`${label} must be a canonical axial hex id`);
  }
  return value;
}

function normalizeHexId(value) {
  if (typeof value === "string") return requireHexId(value);
  if (value && typeof value === "object") return hexKey(axial(value.q, value.r));
  throw new TypeError("Corpse hexId or position is required");
}

function clone(value) {
  return structuredClone(value);
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** True only for authoritative corpse records created by this runtime. */
export function isCorpseTarget(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.kind === "corpse"
    && typeof value.id === "string" && value.id.trim()
    && typeof value.sourceMonsterCode === "string" && value.sourceMonsterCode.trim()
    && typeof value.hexId === "string"
    && typeof value.consumed === "boolean");
}

function validateRecord(record, { battleId = null, hexGrid = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Invalid corpse record");
  if (record.schemaVersion !== undefined && record.schemaVersion !== CORPSE_SCHEMA_VERSION) throw new Error("Unsupported corpse record schema");
  if (record.commandId !== undefined && record.commandId !== null) requireId(record.commandId, "Corpse commandId");
  const required = ["id", "sourceMonsterCode", "hexId", "consumed", "battleId"];
  for (const key of required) if (record[key] === undefined) throw new TypeError(`Corpse ${key} is required`);
  const id = requireId(record.id, "Corpse id");
  const sourceMonsterCode = requireId(record.sourceMonsterCode, "Corpse sourceMonsterCode");
  const canonicalHexId = requireHexId(record.hexId);
  if (typeof record.consumed !== "boolean") throw new TypeError("Corpse consumed must be boolean");
  const recordBattleId = requireId(record.battleId, "Corpse battleId");
  if (battleId !== null && recordBattleId !== battleId) throw new Error(`Corpse belongs to another battle: ${id}`);
  if (record.sourceUnitId !== undefined) requireId(record.sourceUnitId, "Corpse sourceUnitId");
  if (record.encounterId !== undefined && record.encounterId !== null) requireId(record.encounterId, "Corpse encounterId");
  if (record.consumedBy !== undefined && record.consumedBy !== null) requireId(record.consumedBy, "Corpse consumedBy");
  if (record.purpose !== undefined && record.purpose !== null) requireId(record.purpose, "Corpse purpose");
  if (record.state !== undefined && !["available", "consumed", "shattered"].includes(record.state)) {
    throw new TypeError("Invalid corpse state");
  }
  if (record.state === "consumed" && !record.consumed) throw new TypeError("Consumed corpse state disagrees with consumed flag");
  if (record.consumed && record.state === "available") throw new TypeError("Consumed corpse cannot be available");
  if (hexGrid && !hexGrid.has({ q: Number(canonicalHexId.split(",")[0]), r: Number(canonicalHexId.split(",")[1]) })) {
    throw new RangeError(`Corpse hex is outside the battle grid: ${canonicalHexId}`);
  }
  return {
    ...clone(record),
    schemaVersion: CORPSE_SCHEMA_VERSION,
    kind: "corpse",
    id,
    sourceMonsterCode,
    hexId: canonicalHexId,
    consumed: record.consumed,
    battleId: recordBattleId,
  };
}

/**
 * Runtime-only corpse registry. Corpses are data records, never CombatState
 * units, so they cannot receive readiness events, move, attack, or enter AI.
 */
export class CorpseRegistry {
  constructor({ battleId = "combat", encounterId = null, hexGrid = null } = {}) {
    this.battleId = requireId(battleId, "Corpse battleId");
    this.encounterId = encounterId === null ? null : requireId(encounterId, "Corpse encounterId");
    this.hexGrid = hexGrid;
    this.corpses = new Map();
    this.sourceUnits = new Map();
  }

  createFromDeath({ sourceUnitId, sourceMonsterCode, hexId, position, canLeaveCorpse = true } = {}) {
    const sourceId = requireId(sourceUnitId, "Corpse sourceUnitId");
    if (canLeaveCorpse === false) return null;
    if (typeof canLeaveCorpse !== "boolean") throw new TypeError("canLeaveCorpse must be boolean");
    const existingId = this.sourceUnits.get(sourceId);
    if (existingId) return clone(this.corpses.get(existingId));
    const code = requireId(sourceMonsterCode, "Corpse sourceMonsterCode");
    const canonicalHexId = normalizeHexId(hexId ?? position);
    const id = `${this.battleId}:corpse:${sourceId}`;
    if (this.corpses.has(id)) return clone(this.corpses.get(id));
    const corpse = validateRecord({
      schemaVersion: CORPSE_SCHEMA_VERSION,
      kind: "corpse",
      id,
      sourceUnitId: sourceId,
      sourceMonsterCode: code,
      hexId: canonicalHexId,
      consumed: false,
      battleId: this.battleId,
      encounterId: this.encounterId,
      state: "available",
      consumedBy: null,
      purpose: null,
    }, { battleId: this.battleId, hexGrid: this.hexGrid });
    this.corpses.set(id, corpse);
    this.sourceUnits.set(sourceId, id);
    return clone(corpse);
  }

  // Compatibility API retained for the pre-foundation registry tests.
  create({ id, unitType, position, rewardsGranted = true, sourceMonsterCode = unitType, battleId = this.battleId } = {}) {
    const corpseId = requireId(id, "Corpse id");
    if (this.corpses.has(corpseId)) throw new Error(`Duplicate corpse: ${corpseId}`);
    const corpse = validateRecord({
      schemaVersion: CORPSE_SCHEMA_VERSION,
      kind: "corpse",
      id: corpseId,
      unitType: requireId(unitType, "Corpse unitType"),
      sourceMonsterCode: requireId(sourceMonsterCode, "Corpse sourceMonsterCode"),
      hexId: position && Number.isInteger(position.q) && Number.isInteger(position.r) ? hexKey(position) : "0,0",
      position: clone(position),
      consumed: false,
      state: "available",
      consumedBy: null,
      rewardsGranted,
      battleId,
    }, { battleId: this.battleId });
    this.corpses.set(corpseId, corpse);
    return clone(corpse);
  }

  get(id) {
    return this.corpses.has(id) ? clone(this.corpses.get(id)) : null;
  }

  has(id) {
    return this.corpses.has(id);
  }

  list() {
    return [...this.corpses.values()].sort((a, b) => a.id.localeCompare(b.id, "en")).map(clone);
  }

  size() {
    return this.corpses.size;
  }

  consumeCorpse(id, consumerId = null, purpose = null, commandId = null) {
    const corpseId = requireId(id, "Corpse id");
    const corpse = this.corpses.get(corpseId);
    if (!corpse) throw errorWithCode(`Unknown corpse: ${corpseId}`, "CORPSE_NOT_FOUND");
    if (corpse.consumed || corpse.state !== "available") {
      throw errorWithCode(`Corpse already consumed: ${corpseId}`, "CORPSE_ALREADY_CONSUMED");
    }
    const consumer = consumerId === null ? null : requireId(consumerId, "Corpse consumerId");
    const usage = purpose === null ? null : requireId(purpose, "Corpse purpose");
    const command = commandId === null ? null : requireId(commandId, "Corpse commandId");
    if (command && this.list().some(row=>row.commandId===command)) throw new Error("Corpse command was already executed");
    corpse.consumed = true;
    corpse.state = "consumed";
    corpse.consumedBy = consumer;
    corpse.purpose = usage;
    if (command !== null) corpse.commandId = command;
    return clone(corpse);
  }

  consume(id, consumerId, purpose) {
    try {
      this.consumeCorpse(id, consumerId, purpose);
      return true;
    } catch (error) {
      if (error?.code === "CORPSE_ALREADY_CONSUMED") return false;
      throw error;
    }
  }

  shatter(id) {
    const corpse = this.corpses.get(id);
    if (!corpse || corpse.consumed || corpse.state !== "available") return false;
    corpse.state = "shattered";
    corpse.consumed = true;
    return true;
  }

  clear() {
    this.corpses.clear();
    this.sourceUnits.clear();
  }

  snapshot() {
    return clone({
      schemaVersion: CORPSE_SCHEMA_VERSION,
      battleId: this.battleId,
      encounterId: this.encounterId,
      corpses: this.list(),
    });
  }

  static restore(snapshot, { battleId = null, encounterId = null, hexGrid = null } = {}) {
    const expectedBattleId = battleId === null ? null : requireId(battleId, "Corpse battleId");
    if (snapshot === undefined || snapshot === null) {
      return new CorpseRegistry({ battleId: expectedBattleId ?? "combat", encounterId, hexGrid });
    }
    if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== CORPSE_SCHEMA_VERSION
      || !Array.isArray(snapshot.corpses)) throw new TypeError("Invalid corpse snapshot");
    const storedBattleId = requireId(snapshot.battleId, "Corpse battleId");
    if (encounterId !== null && snapshot.encounterId !== null && snapshot.encounterId !== undefined && encounterId !== snapshot.encounterId) throw new Error("Corpse encounter identity mismatch");
    if (expectedBattleId !== null && storedBattleId !== expectedBattleId) throw new Error("Corpse snapshot battle identity mismatch");
    const registry = new CorpseRegistry({
      battleId: storedBattleId,
      encounterId: snapshot.encounterId ?? encounterId,
      hexGrid,
    });
    const sourceIds = new Set();
    const commandIds = new Set();
    for (const raw of snapshot.corpses) {
      const record = validateRecord(raw, { battleId: storedBattleId, hexGrid });
      if (record.encounterId !== undefined && record.encounterId !== null && record.encounterId !== registry.encounterId) throw new Error("Corpse record encounter identity mismatch");
      if (record.commandId && (!record.consumed || commandIds.has(record.commandId))) throw new Error("Invalid or duplicate corpse commandId");
      if (record.commandId) commandIds.add(record.commandId);
      if (registry.corpses.has(record.id)) throw new Error(`Duplicate corpse id: ${record.id}`);
      if (record.sourceUnitId && sourceIds.has(record.sourceUnitId)) throw new Error(`Duplicate corpse source unit: ${record.sourceUnitId}`);
      registry.corpses.set(record.id, record);
      if (record.sourceUnitId) {
        sourceIds.add(record.sourceUnitId);
        registry.sourceUnits.set(record.sourceUnitId, record.id);
      }
    }
    return registry;
  }
}
