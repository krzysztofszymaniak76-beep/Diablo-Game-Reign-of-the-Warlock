import { DeterministicScheduler } from "./scheduler.js";
import { EffectRegistry } from "./effects.js";
import { ControlEffectRegistry } from "./control-effects.js";
import { axial, hexKey, hexLine } from "./hex-grid.js";
import { CorpseRegistry } from "./corpses.js";
import { statInputsFromSkeletonSourceData, validateSummonOwnerSkill } from "./necroskeleton-source.js";
import { addCharacterExperience } from "./progression.js";

export const ACTION_TIME = Object.freeze({
  attack: 900,
  cast: 1000,
  movePerTile: 350,
  wait: 500,
  swap: 1000,
  portalOpen: 1000,
  portalEnter: 500,
  itemUse: 500,
  equipmentChange: 800,
});

export const TIMELINE_MODE = Object.freeze({
  RECOVERY: "recovery",
});

export const READINESS_PHASE = Object.freeze({
  RESOLVING: "resolving",
  AWAITING_ACTION: "awaiting-action",
  SUSPENDED: "suspended",
});

export const TIMELINE_EVENT_PRIORITY = Object.freeze({
  CONTROL: -20,
  ATTACK_IMPACT: 0,
  PROJECTILE_IMPACT: 0,
  PROJECTILE_STEP: 5,
  MOVE_STEP: 10,
  DEFAULT: 50,
  ACTOR_READY: 100,
});

export const ATTACK_IMPACT_OFFSET = 450;
export const PROJECTILE_HEX_TIME = 100;

export const DEFAULT_PROJECTILE_COLLISION_MASK = Object.freeze({
  terrain: true,
  units: true,
  allies: true,
  enemies: true,
  piercing: false,
});

function commandFingerprint(actorId, kind, payload, timeline = null) {
  return JSON.stringify({ actorId, kind, payload, timeline });
}

function requireTransactionId(value) {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new TypeError("transactionId must be a non-empty string");
  }
  return value;
}

function eventPriority(kind) {
  if (kind === "attack:impact") return TIMELINE_EVENT_PRIORITY.ATTACK_IMPACT;
  if (kind === "projectile:impact") return TIMELINE_EVENT_PRIORITY.PROJECTILE_IMPACT;
  if (kind === "projectile:step") return TIMELINE_EVENT_PRIORITY.PROJECTILE_STEP;
  if (kind === "move:step") return TIMELINE_EVENT_PRIORITY.MOVE_STEP;
  if (kind.endsWith(":control")) return TIMELINE_EVENT_PRIORITY.CONTROL;
  if (kind === "actor:ready") return TIMELINE_EVENT_PRIORITY.ACTOR_READY;
  return TIMELINE_EVENT_PRIORITY.DEFAULT;
}

const SEQUENCED_EVENT_KINDS = Object.freeze({
  move: new Set(["move:step"]),
  attack: new Set(["attack:impact", "projectile:step", "projectile:impact"]),
  approachAttack: new Set(["move:step", "attack:impact"]),
});

function sequenceAllowsEvent(commandKind, eventKind) {
  return SEQUENCED_EVENT_KINDS[commandKind]?.has(eventKind) === true;
}

function normalizeProjectileCollisionMask(mask = {}) {
  if (!mask || typeof mask !== "object" || Array.isArray(mask)) {
    throw new TypeError("Projectile collisionMask must be an object");
  }
  return Object.freeze({
    terrain: mask.terrain !== false,
    units: mask.units !== false,
    allies: mask.allies !== false,
    enemies: mask.enemies !== false,
    piercing: mask.piercing === true,
  });
}

function sameHex(left, right) {
  try {
    return hexKey(left) === hexKey(right);
  } catch {
    return false;
  }
}

function sameProjectileCollisionMask(left, right) {
  return Object.keys(DEFAULT_PROJECTILE_COLLISION_MASK)
    .every((key) => left?.[key] === right?.[key]);
}

function sameSerializableValue(left, right) {
  // Hex rounding can produce -0. JSON transaction fingerprints/save files
  // serialize both signed zeros as 0, so they denote the same accepted value.
  if (Object.is(left, right) || (left === 0 && right === 0)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameSerializableValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameSerializableValue(left[key], right[key]));
}

function nextGeneratedSequence(ids, prefix) {
  let next = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number(suffix);
    if (!Number.isSafeInteger(value)) throw new RangeError(`Generated id is outside the safe integer range: ${id}`);
    next = Math.max(next, value + 1);
  }
  if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Generated ${prefix} sequence is exhausted`);
  }
  return next;
}

function restoredSequence(value, minimum, label) {
  if (value === undefined) {
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`${label} is exhausted or invalid`);
    }
    return minimum;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} must be a non-exhausted safe integer of at least ${minimum}`);
  }
  return value;
}

function availableSequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new RangeError(`${label} is exhausted or invalid`);
  }
  return value;
}

function resolveAtMostOnce(resolver) {
  let state = "pending";
  let value;
  let failure;
  return (...args) => {
    if (state === "resolved") return value;
    if (state === "rejected") throw failure;
    if (state === "resolving") throw new Error("Recursive resolution is not allowed");
    state = "resolving";
    try {
      value = resolver(...args);
      state = "resolved";
      return value;
    } catch (error) {
      failure = error;
      state = "rejected";
      throw error;
    }
  };
}

function requireSynchronousResolver(resolver, label) {
  if (resolver === undefined) return;
  if (typeof resolver !== "function") throw new TypeError(`${label} must be a function`);
  const tag = Object.prototype.toString.call(resolver);
  if (tag === "[object AsyncFunction]" || tag === "[object AsyncGeneratorFunction]") {
    throw new TypeError(`${label} must be synchronous`);
  }
}

function requireNonThenableResult(value, label) {
  if (value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function") {
    throw new TypeError(`${label} must be synchronous`);
  }
  return value;
}

function restoreRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(source));
  return target;
}

function restoreArray(reference, values) {
  reference.splice(0, reference.length, ...structuredClone(values));
  return reference;
}

function restoreRecordMap(reference, values, originalValues, keyFor) {
  reference.clear();
  for (const source of values) {
    const key = keyFor(source);
    const target = originalValues.get(key);
    reference.set(key, target ? restoreRecord(target, source) : structuredClone(source));
  }
  return reference;
}

export function actionDuration(kind, payload = {}) {
  let duration;
  if (kind === "move" || kind === "approachAttack") {
    const distance = payload.distance ?? 1;
    if (!Number.isSafeInteger(distance) || distance <= 0) throw new RangeError(`${kind === "move" ? "Move" : "Approach-attack"} distance must be finite and positive (safe integer)`);
    duration = ACTION_TIME.movePerTile * distance;
    if (kind === "approachAttack") duration += ACTION_TIME.attack;
  } else {
    duration = ACTION_TIME[kind];
  }
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error(`Unknown or invalid action kind: ${kind}`);
  return duration;
}

export class CombatState {
  constructor({ party, playersSetting, seed = 1, battleId = "combat", encounterId = null }) {
    this.party = party;
    this.playersSetting = playersSetting;
    this.seed = seed;
    this.battleId = battleId;
    this.encounterId = encounterId ?? battleId;
    this.scheduler = new DeterministicScheduler();
    this.effects = new EffectRegistry();
    this.controlEffects = new ControlEffectRegistry();
    this.corpses = new CorpseRegistry({ battleId: this.battleId, encounterId: this.encounterId });
    this.units = new Map();
    this.pendingPlayersValue = null;
    this.log = [];
    this.readinessSequence = 0;
    this.commandSequence = 0;
    this.transactionSequence = 0;
    this.activeCommands = new Map();
    this.commandHistory = [];
    this.transactionLedger = new Map();
    this.activeProjectiles = new Map();
    this.currentActorId = null;
    this.readinessPhase = READINESS_PHASE.RESOLVING;
    this.timelineMode = null;
    for (const character of party.activeCharacters()) {
      this.units.set(character.id, {
        id: character.id,
        kind: "hero",
        readyAt: 0,
        readySequence: this.#takeReadinessSequence(),
        readinessTieKey: character.id,
        readinessEventId: null,
        position: { q: 0, r: 0 },
      });
    }
  }

  /** Replace this instance's authoritative state while preserving references
   * held by the app's timeline resolver. Used by staged multi-model casts. */
  adoptFrom(other) {
    if (!(other instanceof CombatState)) throw new TypeError("CombatState.adoptFrom requires CombatState");
    for (const field of [
      "party", "playersSetting", "seed", "battleId", "encounterId", "scheduler", "effects",
      "controlEffects", "corpses", "units", "pendingPlayersValue", "log", "readinessSequence",
      "commandSequence", "transactionSequence", "activeCommands", "commandHistory", "transactionLedger",
      "activeProjectiles", "currentActorId", "readinessPhase", "timelineMode",
    ]) this[field] = other[field];
    return this;
  }

  spawnMonster({ id, name, baseHp, baseExperience, position = axial(5, 5), sourceMonsterCode = "SOURCE_DATA_NOT_FOUND", canLeaveCorpse = true }) {
    if (this.units.has(id)) throw new Error(`Duplicate unit: ${id}`);
    const axialPosition = axial(position?.q, position?.r);
    const scaled = this.playersSetting.scaleMonsterBase({ hp: baseHp, experience: baseExperience });
    const monster = {
      id,
      name,
      kind: "monster",
      sourceMonsterCode,
      canLeaveCorpse,
      hp: scaled.hp,
      maxHp: scaled.hp,
      experience: scaled.experience,
      playersSnapshot: scaled.playersSnapshot,
      rewardsGranted: false,
      readyAt: 0,
      readySequence: this.#takeReadinessSequence(),
      readinessTieKey: id,
      readinessEventId: null,
      position: axialPosition,
    };
    this.units.set(id, monster);
    return monster;
  }

  /**
   * Add a runtime summon to the same authoritative unit/scheduler model as
   * heroes and monsters.  Summon combat stats intentionally remain nullable
   * when the audited source tables do not provide them; `alive` is the
   * authoritative life flag in that case.
   */
  spawnSummon({
    id,
    ownerId,
    sourceSkillId,
    summonType = "skeleton",
    petType = summonType,
    sourceMonsterCode = "SOURCE_DATA_NOT_FOUND",
    position = axial(0, 0),
    encounterId = this.encounterId,
    hp = null,
    maxHp = hp,
    aiProfile = "melee_random",
    team = "player",
    statInputs = null,
    sourceData = null,
  } = {}) {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("Summon id is required");
    if (id !== id.trim()) throw new TypeError("Summon id must be canonical");
    if (this.units.has(id)) throw new Error(`Duplicate unit: ${id}`);
    if (typeof ownerId !== "string" || !ownerId.trim()) throw new TypeError("Summon ownerId is required");
    if (typeof sourceSkillId !== "string" || !sourceSkillId.trim()) throw new TypeError("Summon sourceSkillId is required");
    if (typeof summonType !== "string" || !summonType.trim()) throw new TypeError("Summon summonType is required");
    if (typeof petType !== "string" || !petType.trim()) throw new TypeError("Summon petType is required");
    if (typeof sourceMonsterCode !== "string" || !sourceMonsterCode.trim()) throw new TypeError("Summon sourceMonsterCode is required");
    if (typeof encounterId !== "string" || !encounterId.trim()) throw new TypeError("Summon encounterId is required");
    if (typeof aiProfile !== "string" || !aiProfile.trim()) throw new TypeError("Summon aiProfile is required");
    if (team !== "player") throw new RangeError("Summons must belong to the player team");
    if (hp !== null && (!Number.isSafeInteger(hp) || hp < 0)) throw new RangeError("Summon hp must be null or a non-negative safe integer");
    if (maxHp !== null && (!Number.isSafeInteger(maxHp) || maxHp < 0)) throw new RangeError("Summon maxHp must be null or a non-negative safe integer");
    if (hp !== null && maxHp !== null && hp > maxHp) throw new RangeError("Summon hp cannot exceed maxHp");
    if ((hp === null) !== (maxHp === null) || hp === 0) throw new Error("Invalid summon hp/maxHp pair");
    if (encounterId !== this.encounterId) throw new Error("Summon encounter identity mismatch");
    validateSummonOwnerSkill({ownerId,sourceSkillId,summonType,aiProfile,sourceMonsterCode,statInputs,sourceData},this.party);
    const canonicalStatInputs = statInputs ?? (sourceData ? statInputsFromSkeletonSourceData(sourceData) : null);
    const axialPosition = axial(position?.q, position?.r);
    const summon = {
      id: id.trim(),
      kind: "summon",
      schemaVersion: 1,
      team,
      ownerId: ownerId.trim(),
      sourceSkillId: sourceSkillId.trim(),
      summonType: summonType.trim(),
      petType: petType.trim(),
      sourceMonsterCode: sourceMonsterCode.trim(),
      encounterId: encounterId.trim(),
      aiProfile: aiProfile.trim(),
      alive: true,
      hp,
      maxHp,
      ...(canonicalStatInputs ? { statInputs: structuredClone(canonicalStatInputs) } : {}),
      readyAt: 0,
      readySequence: this.#takeReadinessSequence(),
      readinessTieKey: id.trim(),
      readinessEventId: null,
      position: axialPosition,
    };
    this.units.set(summon.id, summon);
    return summon;
  }

  listSummons({ ownerId = null, aliveOnly = false } = {}) {
    return [...this.units.values()]
      .filter((unit) => unit.kind === "summon")
      .filter((unit) => ownerId === null || unit.ownerId === ownerId)
      .filter((unit) => !aliveOnly || this.#unitIsAlive(unit))
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((unit) => structuredClone(unit));
  }

  /** Record a legal monster death exactly once; corpses are not combat units. */
  recordMonsterDeath(monsterId) {
    const monster = this.units.get(monsterId);
    if (!monster || monster.kind !== "monster") throw new Error("Unknown monster");
    if (monster.hp > 0) return null;
    return this.corpses.createFromDeath({
      sourceUnitId: monster.id,
      sourceMonsterCode: monster.sourceMonsterCode ?? "SOURCE_DATA_NOT_FOUND",
      position: monster.position,
      canLeaveCorpse: monster.canLeaveCorpse !== false,
    });
  }

  livingEnemyCount() {
    return [...this.units.values()].filter((unit) => unit.kind === "monster" && unit.hp > 0).length;
  }

  requestPlayersChange(value) {
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError("/players must be 1-8");
    this.pendingPlayersValue = value;
    this.log.push(`P${value} zostanie użyte w następnym starciu.`);
  }

  canAct(actorId) {
    const unit = this.units.get(actorId);
    if (this.timelineMode === TIMELINE_MODE.RECOVERY) {
      return Boolean(unit
        && this.readinessPhase === READINESS_PHASE.AWAITING_ACTION
        && this.currentActorId === actorId
        && unit.readyAt <= this.scheduler.time);
    }
    return Boolean(unit && unit.readyAt <= this.scheduler.time);
  }

  readinessQueue(legalIds = this.units.keys()) {
    if (!legalIds || typeof legalIds[Symbol.iterator] !== "function") throw new TypeError("legalIds must be iterable");
    const seen = new Set();
    const entries = [];
    const insertionOrder = new Map([...this.units.keys()].map((id, index) => [id, index]));
    for (const id of legalIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const unit = this.units.get(id);
      if (!unit) continue;
      if (!Number.isSafeInteger(unit.readyAt) || unit.readyAt < 0) throw new RangeError(`Invalid readyAt for ${id}`);
      const readySequence = Number.isSafeInteger(unit.readySequence)
        && unit.readySequence >= 0
        && unit.readySequence < Number.MAX_SAFE_INTEGER
        ? unit.readySequence
        : this.readinessSequence + insertionOrder.get(id);
      availableSequence(readySequence, `readySequence for ${id}`);
      entries.push({
        id: unit.id,
        kind: unit.kind,
        readyAt: Math.max(this.scheduler.time, unit.readyAt),
        scheduledReadyAt: unit.readyAt,
        tieKey: unit.readinessTieKey ?? unit.id,
        readySequence,
      });
    }
    entries.sort((a, b) => a.readyAt - b.readyAt || a.tieKey.localeCompare(b.tieKey) || a.readySequence - b.readySequence || a.id.localeCompare(b.id));
    if (this.currentActorId) {
      const currentIndex = entries.findIndex(({ id }) => id === this.currentActorId);
      if (currentIndex > 0) entries.unshift(entries.splice(currentIndex, 1)[0]);
    }
    return structuredClone(entries);
  }

  nextReady(legalIds = this.units.keys()) {
    for (let index = 0; index < 100000; index += 1) {
      const boundary = this.advanceTimeline(legalIds);
      if (!boundary) return null;
      if (boundary.type === "ready") return boundary.entry;
    }
    throw new Error("Timeline exceeded its deterministic safety limit");
  }

  advanceTimeline(legalIds = this.units.keys(), { resolve, onInterrupt } = {}) {
    requireSynchronousResolver(resolve, "resolve");
    this.#assertTimelineMode(TIMELINE_MODE.RECOVERY);
    if (onInterrupt !== undefined && typeof onInterrupt !== "function") throw new TypeError("onInterrupt must be a function");
    const legal = [...new Set(legalIds)];
    this.#syncRecoveryReadiness(legal);

    if (this.currentActorId) {
      const entry = this.readinessQueue(legal).find(({ id }) => id === this.currentActorId);
      if (!entry) throw new Error(`Current actor is no longer legal: ${this.currentActorId}`);
      return { type: "ready", entry };
    }

    const event = this.scheduler.pop();
    if (!event) {
      this.currentActorId = null;
      this.readinessPhase = READINESS_PHASE.SUSPENDED;
      this.timelineMode ??= TIMELINE_MODE.RECOVERY;
      return null;
    }

    this.timelineMode ??= TIMELINE_MODE.RECOVERY;
    if (event.kind === "actor:ready") {
      const unit = this.units.get(event.actorId);
      if (!unit) throw new Error(`Readiness event references missing actor: ${event.actorId}`);
      if (unit.readinessEventId !== event.id) throw new Error(`Stale readiness event for ${event.actorId}`);
      unit.readinessEventId = null;
      this.currentActorId = event.actorId;
      this.readinessPhase = READINESS_PHASE.AWAITING_ACTION;
      const entry = this.readinessQueue(legal).find(({ id }) => id === event.actorId);
      if (!entry) throw new Error(`Ready actor is no longer legal: ${event.actorId}`);
      return { type: "ready", entry, event: structuredClone(event) };
    }

    // Validate before invoking any domain callback: a duplicate final impact
    // must not deal damage (or spend mana) before discovering a stale command.
    try {
      this.#assertPendingCommandEvent(event);
    } catch (error) {
      const command = this.activeCommands.get(event.payload?.commandId);
      const interruption = command?.eventIds.includes(event.id)
        ? this.interruptCommand(command.commandId, error.message)
        : null;
      if (interruption && onInterrupt) onInterrupt(structuredClone(interruption));
      this.readinessPhase = READINESS_PHASE.RESOLVING;
      return {
        type: "interrupted",
        event: structuredClone(event),
        interruption,
        error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
      };
    }

    const resolveCore = resolveAtMostOnce((payloadOverride = null) => this.#resolveEvent(payloadOverride
      ? { ...event, payload: { ...event.payload, ...structuredClone(payloadOverride) } }
      : event));
    const historyStart = this.commandHistory.length;
    const checkpoint = this.#createResolverCheckpoint();
    let resolverCompleted = false;
    try {
      const resolution = requireNonThenableResult(
        resolve ? resolve(structuredClone(event), resolveCore) : resolveCore(),
        "resolve",
      );
      resolverCompleted = true;
      this.#consumeCommandEvent(event, { allowAlreadyInterrupted: true });
      const interruptions = this.commandHistory.slice(historyStart)
        .filter(({ status }) => status === "interrupted")
        .map((command) => ({ command, cancelledEvents: [] }));
      if (onInterrupt) for (const interruption of interruptions) onInterrupt(structuredClone(interruption));
      this.readinessPhase = READINESS_PHASE.RESOLVING;
      return { type: "event", event: structuredClone(event), resolution, interruptions: structuredClone(interruptions) };
    } catch (error) {
      if (!resolverCompleted) this.#restoreResolverCheckpoint(checkpoint);
      this.#consumeCommandEvent(event, { keepActive: true });
      const commandId = event.payload?.commandId;
      const interruption = commandId
        ? this.interruptCommand(commandId, error instanceof Error ? error.message : String(error))
        : null;
      if (interruption && onInterrupt) onInterrupt(structuredClone(interruption));
      this.readinessPhase = READINESS_PHASE.RESOLVING;
      return {
        type: "interrupted",
        event: structuredClone(event),
        interruption,
        error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
      };
    }
  }

  submitAction(actorId, kind, payload = {}, { resolve, transactionId } = {}) {
    requireTransactionId(transactionId);
    const fingerprint = commandFingerprint(actorId, kind, payload);
    const replay = transactionId ? this.#transactionReplay(transactionId, fingerprint) : null;
    if (replay) return replay;
    requireSynchronousResolver(resolve, "resolve");
    this.#assertTimelineMode(TIMELINE_MODE.RECOVERY);
    if (this.readinessPhase !== READINESS_PHASE.AWAITING_ACTION || this.currentActorId !== actorId) {
      throw new Error(`${actorId} is not the authoritative readiness head`);
    }
    const unit = this.units.get(actorId);
    if (!unit) throw new Error(`Unknown actor: ${actorId}`);
    if (unit.readyAt > this.scheduler.time) throw new Error(`${actorId} is not ready until ${unit.readyAt}`);
    const duration = actionDuration(kind, payload);
    const readyAt = this.scheduler.time + duration;
    if (!Number.isSafeInteger(readyAt)) throw new RangeError("Action readiness time must be a safe integer");
    const checkpoint = this.#createResolverCheckpoint();
    try {
      const commandSequence = this.#takeCommandSequence();
      const commandId = `command-${commandSequence}`;
      const acceptedTransactionId = transactionId ?? this.#takeAutomaticTransactionId();
      const event = {
        id: `${commandId}:resolve`,
        sequence: commandSequence,
        at: this.scheduler.time,
        kind: `${kind}:resolve`,
        actorId,
        commandId,
        transactionId: acceptedTransactionId,
        payload: structuredClone(payload),
      };
      const resolveCore = resolveAtMostOnce(() => this.#resolveEvent(event));
      const resolution = requireNonThenableResult(
        resolve ? resolve(structuredClone(event), resolveCore) : resolveCore(),
        "resolve",
      );

      const recoveryActorId = kind === "swap" ? payload.incomingId : actorId;
      const recoveryUnit = this.units.get(recoveryActorId);
      if (!recoveryUnit) throw new Error(`Recovery actor disappeared while resolving: ${recoveryActorId}`);
      recoveryUnit.readyAt = readyAt;
      recoveryUnit.readySequence = this.#takeReadinessSequence();
      recoveryUnit.readinessEventId = null;
      this.currentActorId = null;
      this.readinessPhase = READINESS_PHASE.RESOLVING;
      this.timelineMode ??= TIMELINE_MODE.RECOVERY;
      this.#scheduleReadinessEvent(recoveryUnit);
      const command = {
        commandId,
        transactionId: acceptedTransactionId,
        actorId,
        kind,
        status: "completed",
        startTick: event.at,
        recoveryEnd: readyAt,
        impactTicks: [event.at],
        sourceCalculation: this.#timingSource(kind, payload, duration),
        eventIds: [],
        payload: structuredClone(payload),
      };
      this.#archiveCommand(command);
      const result = { event: structuredClone(event), duration, readyAt, recoveryActorId, resolution, commandId, transactionId: acceptedTransactionId };
      this.transactionLedger.set(acceptedTransactionId, {
        fingerprint,
        result: structuredClone(result),
        automatic: transactionId === undefined,
      });
      return result;
    } catch (error) {
      this.#restoreResolverCheckpoint(checkpoint);
      throw error;
    }
  }

  submitSequence(actorId, kind, payload = {}, {
    events,
    resolveStart,
    transactionId,
  } = {}) {
    requireTransactionId(transactionId);
    const fingerprint = commandFingerprint(actorId, kind, payload, events);
    const replay = transactionId ? this.#transactionReplay(transactionId, fingerprint) : null;
    if (replay) return replay;
    requireSynchronousResolver(resolveStart, "resolveStart");
    this.#assertTimelineMode(TIMELINE_MODE.RECOVERY);
    if (this.readinessPhase !== READINESS_PHASE.AWAITING_ACTION || this.currentActorId !== actorId) {
      throw new Error(`${actorId} is not the authoritative readiness head`);
    }
    const unit = this.units.get(actorId);
    if (!unit) throw new Error(`Unknown actor: ${actorId}`);
    if (unit.readyAt > this.scheduler.time) throw new Error(`${actorId} is not ready until ${unit.readyAt}`);
    if (!Array.isArray(events) || events.length === 0) throw new TypeError("A sequenced action requires at least one event");
    if (!SEQUENCED_EVENT_KINDS[kind]) throw new TypeError(`Action ${kind} does not support a sequenced timeline`);

    const duration = actionDuration(kind, payload);
    const normalizedEvents = events.map((descriptor, index) => {
      if (!descriptor || typeof descriptor !== "object") throw new TypeError(`Invalid sequence event at index ${index}`);
      if (!Number.isSafeInteger(descriptor.offset) || descriptor.offset < 0) {
        throw new RangeError(`Sequence event offset ${index} must be a non-negative safe integer`);
      }
      if (typeof descriptor.kind !== "string" || !descriptor.kind || descriptor.kind === "actor:ready") {
        throw new TypeError(`Invalid sequence event kind at index ${index}`);
      }
      if (!sequenceAllowsEvent(kind, descriptor.kind)) {
        throw new TypeError(`Event ${descriptor.kind} is not valid for a ${kind} sequence`);
      }
      const priority = eventPriority(descriptor.kind);
      if (descriptor.priority !== undefined && descriptor.priority !== priority) {
        throw new RangeError(`Sequence event priority disagrees with phase order at index ${index}`);
      }
      return {
        offset: descriptor.offset,
        kind: descriptor.kind,
        priority,
        payload: structuredClone(descriptor.payload ?? {}),
      };
    }).sort((a, b) => a.offset - b.offset || a.priority - b.priority);

    const startTick = this.scheduler.time;
    const recoveryEnd = startTick + duration;
    if (!Number.isSafeInteger(recoveryEnd)) throw new RangeError("Action recovery end must be a safe integer");
    const absoluteEvents = normalizedEvents.map((descriptor, index) => {
      const at = startTick + descriptor.offset;
      if (!Number.isSafeInteger(at)) {
        throw new RangeError(`Sequence event time ${index} must be a safe integer`);
      }
      return { ...descriptor, at };
    });
    const checkpoint = this.#createResolverCheckpoint();
    try {
      const commandSequence = this.#takeCommandSequence();
      const commandId = `command-${commandSequence}`;
      const acceptedTransactionId = transactionId ?? this.#takeAutomaticTransactionId();
      const startResult = requireNonThenableResult(resolveStart?.({
        commandId,
        transactionId: acceptedTransactionId,
        actorId,
        kind,
        startTick,
        recoveryEnd,
        payload: structuredClone(payload),
      }), "resolveStart");

      const scheduled = absoluteEvents.map((descriptor, index) => this.scheduler.schedule({
        at: descriptor.at,
        kind: descriptor.kind,
        actorId,
        priority: descriptor.priority,
        tieKey: `${commandId}:${String(index).padStart(4, "0")}`,
        payload: {
          ...descriptor.payload,
          commandId,
          transactionId: acceptedTransactionId,
        },
      }));
      const command = {
        commandId,
        transactionId: acceptedTransactionId,
        actorId,
        kind,
        status: "active",
        startTick,
        recoveryEnd,
        impactTicks: scheduled.map(({ at }) => at),
        sourceCalculation: this.#timingSource(kind, payload, duration),
        eventIds: scheduled.map(({ id }) => id),
        payload: structuredClone(payload),
      };
      this.activeCommands.set(commandId, command);
      unit.readyAt = recoveryEnd;
      unit.readySequence = this.#takeReadinessSequence();
      unit.readinessEventId = null;
      this.currentActorId = null;
      this.readinessPhase = READINESS_PHASE.RESOLVING;
      this.timelineMode ??= TIMELINE_MODE.RECOVERY;
      this.#scheduleReadinessEvent(unit);

      const result = {
        commandId,
        transactionId: acceptedTransactionId,
        startTick,
        recoveryEnd,
        duration,
        events: structuredClone(scheduled),
        startResult,
      };
      this.transactionLedger.set(acceptedTransactionId, {
        fingerprint,
        result: structuredClone(result),
        automatic: transactionId === undefined,
      });
      return result;
    } catch (error) {
      this.#restoreResolverCheckpoint(checkpoint);
      throw error;
    }
  }

  submitProjectile(actorId, payload = {}, {
    from,
    to,
    targetAnchor = to,
    stepTime = PROJECTILE_HEX_TIME,
    collisionMask = DEFAULT_PROJECTILE_COLLISION_MASK,
    persistsAfterSourceDeath = true,
    resolveStart,
    transactionId,
  } = {}) {
    requireTransactionId(transactionId);
    if (typeof payload.targetId !== "string" || !payload.targetId) {
      throw new TypeError("A projectile requires targetId");
    }
    if (!Number.isSafeInteger(stepTime) || stepTime <= 0) {
      throw new RangeError("Projectile stepTime must be a positive safe integer");
    }
    if (typeof persistsAfterSourceDeath !== "boolean") {
      throw new TypeError("persistsAfterSourceDeath must be a boolean");
    }
    const path = hexLine(from, to);
    if (path.length < 2) throw new RangeError("A projectile requires distinct origin and destination hexes");
    const normalizedTargetAnchor = hexLine(targetAnchor, targetAnchor)[0];
    const normalizedMask = normalizeProjectileCollisionMask(collisionMask);
    const projectileId = transactionId
      ? `projectile:transaction:${transactionId}`
      : `projectile:command-${availableSequence(this.commandSequence, "commandSequence")}`;
    const existingProjectile = this.activeProjectiles.get(projectileId);
    if (existingProjectile && (!transactionId || !this.transactionLedger.has(transactionId))) {
      throw new Error(`Duplicate projectile: ${projectileId}`);
    }
    const commonPayload = {
      projectileId,
      targetId: payload.targetId,
      targetAnchor: normalizedTargetAnchor,
      collisionMask: normalizedMask,
      persistsAfterSourceDeath,
    };
    const events = path.slice(1, -1).map((destination, index) => ({
      offset: (index + 1) * stepTime,
      kind: "projectile:step",
      payload: {
        ...commonPayload,
        from: path[index],
        to: destination,
        pathIndex: index + 1,
      },
    }));
    const finalIndex = path.length - 1;
    events.push({
      offset: finalIndex * stepTime,
      kind: "projectile:impact",
      payload: {
        ...structuredClone(payload),
        ...commonPayload,
        from: path[finalIndex - 1],
        to: path[finalIndex],
        pathIndex: finalIndex,
      },
    });

    const result = this.submitSequence(actorId, "attack", {
      ...structuredClone(payload),
      projectileId,
      projectilePath: path,
      projectileStepTime: stepTime,
      projectileTargetAnchor: normalizedTargetAnchor,
      collisionMask: normalizedMask,
      persistsAfterSourceDeath,
    }, {
      events,
      resolveStart,
      transactionId,
    });
    if (!result.replayed) {
      if (this.activeProjectiles.has(projectileId)) throw new Error(`Duplicate projectile: ${projectileId}`);
      this.activeProjectiles.set(projectileId, {
        projectileId,
        commandId: result.commandId,
        transactionId: result.transactionId,
        actorId,
        targetId: payload.targetId,
        targetAnchor: normalizedTargetAnchor,
        status: "flying",
        launchedAt: result.startTick,
        stepTime,
        collisionMask: normalizedMask,
        persistsAfterSourceDeath,
        path,
        pathIndex: 0,
        position: path[0],
        eventIds: result.events.map(({ id }) => id),
      });
    }
    return { ...result, projectileId };
  }

  projectile(projectileId) {
    const projectile = this.activeProjectiles.get(projectileId);
    return projectile ? structuredClone(projectile) : null;
  }

  projectiles() {
    return structuredClone([...this.activeProjectiles.values()]);
  }

  validateProjectileEvent(event) {
    this.#projectileEventState(event);
    return true;
  }

  interruptCommand(commandId, reason = "interrupted") {
    const command = this.activeCommands.get(commandId);
    if (!command) return null;
    const cancelledEvents = this.scheduler.cancelWhere((event) => event.payload?.commandId === commandId);
    command.status = "interrupted";
    command.interruptedAt = this.scheduler.time;
    command.interruptionReason = String(reason);
    command.eventIds = command.eventIds.filter((id) => !cancelledEvents.some((event) => event.id === id));
    for (const [projectileId, projectile] of this.activeProjectiles) {
      if (projectile.commandId === commandId) this.activeProjectiles.delete(projectileId);
    }
    this.activeCommands.delete(commandId);
    this.#archiveCommand(command);
    this.log.push(`${command.actorId}: przerwano ${command.kind} w T=${this.scheduler.time} (${command.interruptionReason}).`);
    return structuredClone({ command, cancelledEvents });
  }

  interruptActorCommands(actorId, reason = "actor unavailable", { preserveProjectilesAfterSourceDeath = false } = {}) {
    if (typeof preserveProjectilesAfterSourceDeath !== "boolean") {
      throw new TypeError("preserveProjectilesAfterSourceDeath must be a boolean");
    }
    const interrupted = [];
    for (const command of [...this.activeCommands.values()]) {
      if (command.actorId !== actorId) continue;
      const preserveProjectile = preserveProjectilesAfterSourceDeath
        && command.payload?.projectileId
        && command.payload?.persistsAfterSourceDeath === true;
      if (!preserveProjectile) interrupted.push(this.interruptCommand(command.commandId, reason));
    }
    return interrupted;
  }

  interruptProjectilesTargeting(targetId, reason = "projectile target unavailable", { exceptCommandId = null } = {}) {
    if (typeof targetId !== "string" || !targetId) throw new TypeError("Projectile target id is required");
    const interrupted = [];
    for (const projectile of [...this.activeProjectiles.values()]) {
      if (projectile.targetId !== targetId || projectile.commandId === exceptCommandId) continue;
      const result = this.interruptCommand(projectile.commandId, reason);
      if (result) interrupted.push(result);
    }
    return interrupted;
  }

  timelinePreview(limit = 8) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("Timeline preview limit must be a non-negative integer");
    return structuredClone(this.scheduler.queue.slice(0, limit));
  }

  requestSwap(outgoingId, incomingId) {
    const slotIndex = this.party.indexOf(outgoingId);
    if (slotIndex < 0) throw new Error("Outgoing character is not active");
    if (!this.party.roster.has(incomingId)) throw new Error("Incoming character is not in roster");
    const incoming = this.party.roster.get(incomingId);
    if (incoming.hardcore && incoming.lifeState === "dead") throw new Error("A dead Hardcore character cannot return");
    if (this.party.isActive(incomingId)) throw new Error("Incoming character is already active");
    return this.submitAction(outgoingId, "swap", { slotIndex, incomingId });
  }

  #resolveEvent(event) {
    const kind = event.kind.split(":", 1)[0];
    if (kind === "projectile") return this.#resolveProjectile(event);
    if (kind === "swap") return this.#resolveSwap(event);
    if (kind === "attack") return this.#resolveAttack(event);
    if (kind === "move") return this.#resolveMove(event);
    if (kind === "wait") return this.log.push(`${event.actorId} czeka.`);
    if (kind === "cast") return this.log.push(`${event.actorId} rzuca zaklęcie.`);
    if (kind === "portalOpen") return this.log.push(`${event.actorId} kończy otwieranie Miejskiego Portalu.`);
    if (kind === "portalEnter") return this.log.push(`${event.actorId} przechodzi przez Miejski Portal.`);
    if (kind === "itemUse") return this.log.push(`${event.actorId} kończy użycie przedmiotu.`);
    if (kind === "equipmentChange") return this.log.push(`${event.actorId} kończy zmianę wyposażenia.`);
    throw new Error(`Unknown action event: ${event.kind}`);
  }

  #resolveSwap(event) {
    const outgoing = this.party.roster.get(event.actorId);
    const { slotIndex, incomingId } = event.payload;
    if (this.party.slots[slotIndex] !== event.actorId) throw new Error("Party changed before swap boundary");
    const outgoingPosition = structuredClone(this.units.get(event.actorId)?.position ?? { q: 0, r: 0 });
    this.party.replaceAt(slotIndex, incomingId);
    this.effects.removeByUnit(outgoing.id);
    this.controlEffects.removeByUnit(outgoing.id);
    this.interruptActorCommands(outgoing.id, "actor withdrawn");
    this.interruptProjectilesTargeting(outgoing.id, "projectile target withdrawn");
    for (const [id, unit] of this.units) {
      if (unit.ownerId === outgoing.id && !unit.persistsWhenOwnerWithdrawn) {
        this.effects.removeByUnit(id);
        this.controlEffects.removeByUnit(id);
        this.interruptActorCommands(id, "summon owner withdrawn");
        this.interruptProjectilesTargeting(id, "projectile target withdrawn");
        this.units.delete(id);
      }
    }
    this.units.delete(outgoing.id);
    this.units.set(incomingId, {
      id: incomingId,
      kind: "hero",
      readyAt: event.at,
      readySequence: this.#takeReadinessSequence(),
      readinessTieKey: incomingId,
      readinessEventId: null,
      position: outgoingPosition,
    });
    this.log.push(`${outgoing.name} wycofuje się; ${this.party.roster.get(incomingId).name} wchodzi do walki.`);
  }

  #resolveAttack(event) {
    const target = this.units.get(event.payload.targetId);
    if (!target) {
      if (this.corpses.has(event.payload.targetId)) {
        throw new Error(`Basic attack cannot target corpse: ${event.payload.targetId}`);
      }
      return;
    }
    const damage = Math.max(0, Math.floor(event.payload.damage ?? 0));
    if (target.kind === "hero") {
      const character = this.party.roster.get(target.id);
      if (character.resources.hp <= 0) return;
      character.resources.hp = Math.max(0, character.resources.hp - damage);
      if (character.resources.hp === 0) {
        character.lifeState = character.hardcore ? "dead" : "corpse";
        this.effects.removeByUnit(target.id, { persistent: true });
        this.controlEffects.removeByUnit(target.id);
        this.interruptActorCommands(target.id, "actor defeated", { preserveProjectilesAfterSourceDeath: true });
        this.interruptProjectilesTargeting(target.id, "projectile target defeated", {
          exceptCommandId: event.payload.commandId ?? null,
        });
      }
    } else {
      if (target.kind === "summon") {
        if (!target.alive || (target.hp !== null && target.hp <= 0)) return;
        if (target.hp !== null) target.hp = Math.max(0, target.hp - damage);
        if (target.hp === 0) target.alive = false;
      } else {
        if (target.hp <= 0) return;
        target.hp = Math.max(0, target.hp - damage);
      }
      if (target.kind === "monster" && target.hp === 0) {
        this.effects.removeByUnit(target.id, { persistent: true });
        this.controlEffects.removeByUnit(target.id);
        this.interruptActorCommands(target.id, "actor defeated", { preserveProjectilesAfterSourceDeath: true });
        this.interruptProjectilesTargeting(target.id, "projectile target defeated", {
          exceptCommandId: event.payload.commandId ?? null,
        });
        this.recordMonsterDeath(target.id);
      }
      if (target.kind === "summon" && !target.alive) {
        this.effects.removeByUnit(target.id, { persistent: true });
        this.controlEffects.removeByUnit(target.id);
        this.interruptActorCommands(target.id, "summon defeated", { preserveProjectilesAfterSourceDeath: true });
        this.interruptProjectilesTargeting(target.id, "summon target defeated", {
          exceptCommandId: event.payload.commandId ?? null,
        });
      }
    }
    this.log.push(`${event.actorId} zadaje ${damage} obrażeń ${target.id}.`);
  }

  #resolveProjectile(event) {
    const { projectile, expectedIndex } = this.#projectileEventState(event);
    const projectileId = projectile.projectileId;

    projectile.position = structuredClone(event.payload.to);
    projectile.pathIndex = expectedIndex;
    projectile.eventIds = projectile.eventIds.filter((id) => id !== event.id);
    if (event.kind === "projectile:step") return structuredClone(projectile.position);
    this.activeProjectiles.delete(projectileId);
    return this.#resolveAttack(event);
  }

  #projectileEventState(event) {
    const projectileId = event?.payload?.projectileId;
    const projectile = this.activeProjectiles.get(projectileId);
    if (!projectile) throw new Error(`Unknown active projectile: ${projectileId ?? "—"}`);
    if (projectile.commandId !== event.payload.commandId || projectile.actorId !== event.actorId) {
      throw new Error(`Projectile event identity mismatch: ${event.id}`);
    }
    if (event.payload.targetId !== projectile.targetId
      || !sameHex(event.payload.targetAnchor, projectile.targetAnchor)
      || !sameProjectileCollisionMask(event.payload.collisionMask, projectile.collisionMask)) {
      throw new Error(`Projectile target changed in flight: ${projectileId}`);
    }
    const expectedIndex = projectile.pathIndex + 1;
    if (event.payload.pathIndex !== expectedIndex
      || !sameHex(event.payload.from, projectile.position)
      || !sameHex(event.payload.to, projectile.path[expectedIndex])) {
      throw new Error(`Projectile path continuity failed: ${projectileId}`);
    }
    if (event.kind !== "projectile:step" && event.kind !== "projectile:impact") {
      throw new Error(`Invalid projectile event: ${event.kind}`);
    }
    if (event.kind === "projectile:impact") {
      if (expectedIndex !== projectile.path.length - 1) throw new Error(`Early projectile impact: ${projectileId}`);
      const target = this.units.get(projectile.targetId);
      if (!target || !this.#unitIsAlive(target)) throw new Error(`Projectile target is unavailable: ${projectile.targetId}`);
      if (!sameHex(target.position, projectile.targetAnchor)) {
        throw new Error(`Projectile target left the planned impact hex: ${projectile.targetId}`);
      }
    } else if (expectedIndex >= projectile.path.length - 1) {
      throw new Error(`Projectile step cannot replace impact: ${projectileId}`);
    }
    return { projectile, expectedIndex };
  }

  #unitIsAlive(unit) {
    if (unit.kind === "hero") {
      const character = this.party.roster.get(unit.id);
      return character.lifeState === "alive" && character.resources.hp > 0;
    }
    if (unit.kind === "summon") return unit.alive !== false && (unit.hp === null || unit.hp > 0);
    return unit.hp > 0;
  }

  #resolveMove(event) {
    const unit = this.units.get(event.actorId);
    if (unit && event.payload.to) unit.position = structuredClone(event.payload.to);
  }

  grantMonsterExperience(monsterId, eligibleCharacterIds) {
    const monster = this.units.get(monsterId);
    if (!monster || monster.kind !== "monster") throw new Error("Unknown monster");
    if (monster.hp > 0) throw new Error("Monster is still alive");
    this.recordMonsterDeath(monsterId);
    if (monster.rewardsGranted) return [];
    const eligible = [...new Set(eligibleCharacterIds)].filter((id) => this.party.isActive(id));
    if (!eligible.length) {
      monster.rewardsGranted = true;
      return [];
    }
    // Party/level penalties are deliberately isolated for replacement when the
    // verified 3.3 tables arrive. Reserve characters can never be recipients.
    const share = Math.floor(monster.experience / eligible.length);
    // Stage the entire party award before publishing; overflow/corruption cannot leave a partial payout.
    const stagedAwards = eligible.map((id) => {
      const character = this.party.roster.get(id);
      const staged = structuredClone(character);
      const progress = addCharacterExperience(staged, share);
      return { character, staged, progress };
    });
    const awards = stagedAwards.map(({ character, staged, progress }) => {
      Object.assign(character, staged);
      const award = { characterId: character.id, amount: share };
      if (progress.levelsGained) {
        const { amount, ...levelUp } = progress;
        award.levelUp = levelUp;
      }
      return award;
    });
    monster.rewardsGranted = true;
    return awards;
  }

  #createResolverCheckpoint() {
    const roster = this.party.roster;
    return {
      snapshot: {
        combat: this.snapshot(),
        partySlots: structuredClone(this.party.slots),
        partyRoster: roster.toJSON(),
      },
      party: this.party,
      partySlots: this.party.slots,
      roster,
      rosterCharacters: roster.characters,
      rosterCharacterReferences: new Map(roster.characters),
      scheduler: this.scheduler,
      schedulerQueue: this.scheduler.queue,
      effects: this.effects,
      effectMap: this.effects.effects,
      effectReferences: new Map(this.effects.effects),
      units: this.units,
      unitReferences: new Map(this.units),
      log: this.log,
      activeCommands: this.activeCommands,
      activeCommandReferences: new Map(this.activeCommands),
      commandHistory: this.commandHistory,
      transactionLedger: this.transactionLedger,
      transactionReferences: new Map(this.transactionLedger),
      activeProjectiles: this.activeProjectiles,
      activeProjectileReferences: new Map(this.activeProjectiles),
      corpses: this.corpses,
      playersSetting: this.playersSetting,
      playersSettingValue: this.playersSetting.value,
    };
  }

  #restoreResolverCheckpoint(checkpoint) {
    const { snapshot } = checkpoint;

    this.party = checkpoint.party;
    this.playersSetting = checkpoint.playersSetting;
    this.playersSetting.value = checkpoint.playersSettingValue;
    this.party.roster = checkpoint.roster;
    this.party.roster.characters = restoreRecordMap(
      checkpoint.rosterCharacters,
      snapshot.partyRoster,
      checkpoint.rosterCharacterReferences,
      (character) => character.id,
    );
    this.party.slots = restoreArray(checkpoint.partySlots, snapshot.partySlots);

    const restoredScheduler = DeterministicScheduler.restore(snapshot.combat.scheduler);
    checkpoint.scheduler.time = restoredScheduler.time;
    checkpoint.scheduler.sequence = restoredScheduler.sequence;
    checkpoint.scheduler.queue = restoreArray(checkpoint.schedulerQueue, restoredScheduler.queue);
    this.scheduler = checkpoint.scheduler;

    checkpoint.effects.effects = restoreRecordMap(
      checkpoint.effectMap,
      snapshot.combat.effects,
      checkpoint.effectReferences,
      (effect) => effect.id,
    );
    this.effects = checkpoint.effects;
    this.controlEffects = ControlEffectRegistry.restore(snapshot.combat.controlEffects);
    this.units = restoreRecordMap(
      checkpoint.units,
      snapshot.combat.units,
      checkpoint.unitReferences,
      (unit) => unit.id,
    );
    this.log = restoreArray(checkpoint.log, snapshot.combat.log);
    this.activeCommands = restoreRecordMap(
      checkpoint.activeCommands,
      snapshot.combat.commands.active,
      checkpoint.activeCommandReferences,
      (command) => command.commandId,
    );
    this.commandHistory = restoreArray(checkpoint.commandHistory, snapshot.combat.commands.history);

    checkpoint.transactionLedger.clear();
    for (const [transactionId, stored] of snapshot.combat.commands.transactions) {
      const target = checkpoint.transactionReferences.get(transactionId);
      checkpoint.transactionLedger.set(
        transactionId,
        target ? restoreRecord(target, stored) : structuredClone(stored),
      );
    }
    this.transactionLedger = checkpoint.transactionLedger;
    this.activeProjectiles = restoreRecordMap(
      checkpoint.activeProjectiles,
      snapshot.combat.projectiles.active,
      checkpoint.activeProjectileReferences,
      (projectile) => projectile.projectileId,
    );
    this.corpses = CorpseRegistry.restore(snapshot.combat.corpses, {
      battleId: this.battleId,
      encounterId: this.encounterId,
    });

    this.seed = snapshot.combat.seed;
    this.pendingPlayersValue = snapshot.combat.pendingPlayersValue;
    this.readinessSequence = snapshot.combat.readiness.sequence;
    this.commandSequence = snapshot.combat.readiness.commandSequence;
    this.transactionSequence = snapshot.combat.readiness.transactionSequence;
    this.currentActorId = snapshot.combat.readiness.currentActorId;
    this.readinessPhase = snapshot.combat.readiness.phase;
    this.timelineMode = snapshot.combat.readiness.timelineMode;
  }

  snapshot() {
    return structuredClone({
      seed: this.seed,
      battleId: this.battleId,
      encounterId: this.encounterId,
      corpses: this.corpses.snapshot(),
      scheduler: this.scheduler.snapshot(),
      effects: this.effects.snapshot(),
      controlEffects: this.controlEffects.snapshot(),
      units: [...this.units.values()],
      pendingPlayersValue: this.pendingPlayersValue,
      log: this.log,
      commands: {
        active: [...this.activeCommands.values()],
        history: this.commandHistory,
        transactions: [...this.transactionLedger.entries()],
      },
      projectiles: {
        active: [...this.activeProjectiles.values()],
      },
      readiness: {
        sequence: this.readinessSequence,
        commandSequence: this.commandSequence,
        transactionSequence: this.transactionSequence,
        currentActorId: this.currentActorId,
        phase: this.readinessPhase,
        timelineMode: this.timelineMode,
      },
    });
  }

  static restore(snapshot, { party, playersSetting }) {
    if (!snapshot || typeof snapshot !== "object") throw new TypeError("Combat snapshot is required");
    if (!party || !playersSetting) throw new TypeError("party and playersSetting are required");
    if (!Array.isArray(snapshot.units)) throw new TypeError("Combat units snapshot is required");

    const combat = new CombatState({
      party,
      playersSetting,
      seed: snapshot.seed,
      battleId: snapshot.battleId ?? snapshot.corpses?.battleId ?? "combat",
      encounterId: snapshot.encounterId ?? snapshot.corpses?.encounterId ?? snapshot.battleId ?? "combat",
    });
    combat.scheduler = DeterministicScheduler.restore(snapshot.scheduler);
    combat.effects = new EffectRegistry();
    for (const effect of snapshot.effects ?? []) combat.effects.add(effect);
    combat.units = new Map();
    const readySequences = new Set();
    let fallbackSequence = 0;
    for (const stored of snapshot.units) {
      if (!stored || typeof stored.id !== "string" || !stored.id) throw new TypeError("Invalid combat unit");
      if (combat.units.has(stored.id)) throw new Error(`Duplicate unit: ${stored.id}`);
      if (!Number.isSafeInteger(stored.readyAt) || stored.readyAt < 0) throw new RangeError(`Invalid readyAt for ${stored.id}`);
      const unit = structuredClone(stored);
      if (unit.kind === "summon") {
        const requiredSummonFields = [
          "ownerId", "sourceSkillId", "summonType", "petType", "sourceMonsterCode",
          "encounterId", "aiProfile", "team", "alive", "hp", "maxHp",
        ];
        for (const field of requiredSummonFields) {
          if (unit[field] === undefined) throw new TypeError(`Summon ${field} is required: ${unit.id}`);
        }
        for (const field of ["ownerId", "sourceSkillId", "summonType", "petType", "sourceMonsterCode", "encounterId", "aiProfile"]) {
          if (typeof unit[field] !== "string" || !unit[field].trim()) throw new TypeError(`Invalid summon ${field}: ${unit.id}`);
        }
        if (unit.team !== "player" || typeof unit.alive !== "boolean") throw new TypeError(`Invalid summon team/life state: ${unit.id}`);
        if (unit.hp !== null && (!Number.isSafeInteger(unit.hp) || unit.hp < 0)) throw new RangeError(`Invalid summon hp: ${unit.id}`);
        if (unit.maxHp !== null && (!Number.isSafeInteger(unit.maxHp) || unit.maxHp < 0)) throw new RangeError(`Invalid summon maxHp: ${unit.id}`);
        if (unit.hp !== null && unit.maxHp !== null && unit.hp > unit.maxHp) throw new RangeError(`Invalid summon hp/maxHp: ${unit.id}`);
        if (unit.encounterId !== combat.encounterId) throw new Error(`Summon encounter identity mismatch: ${unit.id}`);
        if (unit.alive && unit.hp === 0) throw new Error(`Live summon has zero hp: ${unit.id}`);
        if ((unit.hp === null) !== (unit.maxHp === null)) throw new Error(`Invalid summon hp/maxHp pair: ${unit.id}`);
        if (!unit.position || !Number.isSafeInteger(unit.position.q) || !Number.isSafeInteger(unit.position.r)) throw new Error(`Invalid summon position: ${unit.id}`);
        validateSummonOwnerSkill(unit, party);
        if (unit.sourceData && !unit.statInputs) unit.statInputs = statInputsFromSkeletonSourceData(unit.sourceData);
        if (unit.sourceData) delete unit.sourceData;
      }
      if (unit.readySequence === undefined) unit.readySequence = fallbackSequence;
      availableSequence(unit.readySequence, `readySequence for ${unit.id}`);
      if (typeof unit.readinessTieKey !== "string" || !unit.readinessTieKey) unit.readinessTieKey = unit.id;
      if (unit.readinessEventId === undefined) unit.readinessEventId = null;
      if (unit.readinessEventId !== null && (typeof unit.readinessEventId !== "string" || !unit.readinessEventId)) {
        throw new TypeError(`Invalid readinessEventId for ${unit.id}`);
      }
      if (readySequences.has(unit.readySequence)) throw new Error(`Duplicate readySequence: ${unit.readySequence}`);
      readySequences.add(unit.readySequence);
      fallbackSequence = Math.max(fallbackSequence, unit.readySequence + 1);
      if (!Number.isSafeInteger(fallbackSequence) || fallbackSequence >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Restored readiness sequence is exhausted or invalid");
      }
      combat.units.set(unit.id, unit);
    }
    combat.corpses = CorpseRegistry.restore(snapshot.corpses, {
      battleId: combat.battleId,
      encounterId: combat.encounterId,
    });
    for (const effect of combat.effects.snapshot()) {
      if (!combat.units.has(effect.targetId)
        || (!combat.units.has(effect.sourceId) && effect.persistsWhenSourceWithdrawn !== true)) {
        throw new Error(`Effect references a missing unit without an explicit persistence policy: ${effect.id}`);
      }
    }
    combat.controlEffects = snapshot.controlEffects
      ? ControlEffectRegistry.restore(snapshot.controlEffects)
      : new ControlEffectRegistry();
    for (const effect of combat.controlEffects.snapshot().effects) {
      if (!combat.units.has(effect.sourceId) || !combat.units.has(effect.targetId)) {
        throw new Error(`Control effect references a missing unit: ${effect.id}`);
      }
    }
    combat.pendingPlayersValue = snapshot.pendingPlayersValue ?? null;
    if (combat.pendingPlayersValue !== null
      && (!Number.isSafeInteger(combat.pendingPlayersValue)
        || combat.pendingPlayersValue < 1
        || combat.pendingPlayersValue > 8)) {
      throw new RangeError("pendingPlayersValue must be null or a safe integer from 1 to 8");
    }
    const restoredLog = snapshot.log ?? [];
    if (!Array.isArray(restoredLog) || restoredLog.some((entry) => typeof entry !== "string")) {
      throw new TypeError("Combat log must be an array of strings");
    }
    combat.log = structuredClone(restoredLog);
    const commands = snapshot.commands ?? {};
    if (commands.active !== undefined && !Array.isArray(commands.active)) throw new TypeError("Invalid active command snapshot");
    if (commands.history !== undefined && !Array.isArray(commands.history)) throw new TypeError("Invalid command history snapshot");
    if (commands.transactions !== undefined && !Array.isArray(commands.transactions)) throw new TypeError("Invalid transaction ledger snapshot");
    combat.activeCommands = new Map();
    for (const stored of commands.active ?? []) {
      if (!stored || typeof stored.commandId !== "string" || !/^command-\d+$/.test(stored.commandId)) {
        throw new TypeError("Invalid active command");
      }
      if (combat.activeCommands.has(stored.commandId)) throw new Error(`Duplicate active command: ${stored.commandId}`);
      if (!combat.units.has(stored.actorId)) throw new Error(`Active command actor is missing: ${stored.actorId}`);
      if (!Array.isArray(stored.eventIds)) throw new TypeError(`Active command eventIds are missing: ${stored.commandId}`);
      combat.activeCommands.set(stored.commandId, structuredClone(stored));
    }
    combat.commandHistory = structuredClone(commands.history ?? []);
    const commandsById = new Map(combat.activeCommands);
    for (const command of combat.commandHistory) {
      if (!command || typeof command.commandId !== "string" || !/^command-\d+$/.test(command.commandId)
        || typeof command.transactionId !== "string" || !command.transactionId
        || !["completed", "effects-complete", "interrupted"].includes(command.status)) {
        throw new TypeError("Invalid command history entry");
      }
      if (commandsById.has(command.commandId)) throw new Error(`Duplicate command identity: ${command.commandId}`);
      commandsById.set(command.commandId, command);
    }
    combat.transactionLedger = new Map();
    const ledgerCommandIds = new Set();
    for (const entry of structuredClone(commands.transactions ?? [])) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]) {
        throw new TypeError("Invalid transaction ledger entry");
      }
      const [transactionId, stored] = entry;
      if (combat.transactionLedger.has(transactionId)) throw new Error(`Duplicate transaction: ${transactionId}`);
      if (!stored || typeof stored.fingerprint !== "string" || !stored.result
        || stored.result.transactionId !== transactionId
        || typeof stored.result.commandId !== "string" || !stored.result.commandId
        || (stored.automatic !== undefined && typeof stored.automatic !== "boolean")) {
        throw new TypeError(`Invalid transaction ledger value: ${transactionId}`);
      }
      stored.automatic ??= /^transaction-auto-\d+$/.test(transactionId);
      if (stored.automatic && !/^transaction-auto-\d+$/.test(transactionId)) {
        throw new TypeError(`Automatic transaction id is invalid: ${transactionId}`);
      }
      if (ledgerCommandIds.has(stored.result.commandId)) {
        throw new Error(`Multiple transactions reference one command: ${stored.result.commandId}`);
      }
      const command = commandsById.get(stored.result.commandId);
      if (!command || command.transactionId !== transactionId
        || command.actorId !== (stored.result.event?.actorId ?? command.actorId)) {
        throw new Error(`Transaction has no exact command history match: ${transactionId}`);
      }
      if (stored.result.event) {
        const event = stored.result.event;
        if (event.commandId !== command.commandId
          || event.transactionId !== transactionId
          || event.actorId !== command.actorId
          || event.kind !== `${command.kind}:resolve`) {
          throw new Error(`Completed transaction event is inconsistent: ${transactionId}`);
        }
      } else if (!Array.isArray(stored.result.events) || stored.result.events.length === 0
        || stored.result.events.some((event, index) => event.actorId !== command.actorId
          || event.payload?.commandId !== command.commandId
          || event.payload?.transactionId !== transactionId
          || !sequenceAllowsEvent(command.kind, event.kind)
          || event.priority !== eventPriority(event.kind)
          || !Number.isSafeInteger(event.sequence)
          || event.sequence < 0
          || event.id !== `event-${event.sequence}`
          || event.tieKey !== `${command.commandId}:${String(index).padStart(4, "0")}`
          || (index > 0 && event.sequence <= stored.result.events[index - 1].sequence))) {
        throw new Error(`Sequenced transaction events are inconsistent: ${transactionId}`);
      }
      ledgerCommandIds.add(stored.result.commandId);
      combat.transactionLedger.set(transactionId, stored);
    }
    for (const command of commandsById.values()) {
      const transaction = combat.transactionLedger.get(command.transactionId);
      if (!transaction || transaction.result.commandId !== command.commandId) {
        throw new Error(`Command has no exact transaction match: ${command.commandId}`);
      }
    }

    const projectiles = snapshot.projectiles ?? {};
    if (projectiles.active !== undefined && !Array.isArray(projectiles.active)) {
      throw new TypeError("Invalid active projectile snapshot");
    }
    combat.activeProjectiles = new Map();
    for (const stored of projectiles.active ?? []) {
      if (!stored || typeof stored.projectileId !== "string" || !stored.projectileId) {
        throw new TypeError("Invalid active projectile");
      }
      if (combat.activeProjectiles.has(stored.projectileId)) {
        throw new Error(`Duplicate active projectile: ${stored.projectileId}`);
      }
      const command = combat.activeCommands.get(stored.commandId);
      if (!command || command.actorId !== stored.actorId) {
        throw new Error(`Active projectile command is missing: ${stored.projectileId}`);
      }
      const persistsAfterSourceDeath = stored.persistsAfterSourceDeath ?? true;
      if ((command.payload?.persistsAfterSourceDeath ?? true) !== persistsAfterSourceDeath) {
        throw new Error(`Active projectile source-death policy is inconsistent: ${stored.projectileId}`);
      }
      if (!combat.units.has(stored.actorId) || !combat.units.has(stored.targetId)) {
        throw new Error(`Active projectile unit is missing: ${stored.projectileId}`);
      }
      if (stored.status !== "flying" || !Array.isArray(stored.path) || stored.path.length < 2) {
        throw new TypeError(`Invalid projectile flight state: ${stored.projectileId}`);
      }
      const expectedPath = hexLine(stored.path[0], stored.path.at(-1));
      if (expectedPath.length !== stored.path.length
        || expectedPath.some((cell, index) => !sameHex(cell, stored.path[index]))) {
        throw new Error(`Projectile path is not one axial line: ${stored.projectileId}`);
      }
      if (!Number.isSafeInteger(stored.launchedAt) || stored.launchedAt < 0 || stored.launchedAt > combat.scheduler.time
        || !Number.isSafeInteger(stored.stepTime) || stored.stepTime <= 0
        || (stored.persistsAfterSourceDeath !== undefined && typeof stored.persistsAfterSourceDeath !== "boolean")
        || !Number.isInteger(stored.pathIndex) || stored.pathIndex < 0 || stored.pathIndex >= stored.path.length - 1
        || !sameHex(stored.position, stored.path[stored.pathIndex])
        || !sameHex(stored.targetAnchor, stored.targetAnchor)) {
        throw new Error(`Invalid projectile progress: ${stored.projectileId}`);
      }
      if (!Array.isArray(stored.eventIds) || stored.eventIds.some((id) => !command.eventIds.includes(id))) {
        throw new Error(`Invalid projectile event references: ${stored.projectileId}`);
      }
      const restored = structuredClone(stored);
      restored.collisionMask = normalizeProjectileCollisionMask(stored.collisionMask);
      restored.persistsAfterSourceDeath = persistsAfterSourceDeath;
      combat.activeProjectiles.set(restored.projectileId, restored);
    }

    const readiness = snapshot.readiness ?? {};
    const commandIds = [
      ...combat.activeCommands.keys(),
      ...combat.commandHistory.map(({ commandId }) => commandId),
      ...[...combat.transactionLedger.values()].map(({ result }) => result.commandId),
    ];
    const automaticTransactionIds = [...combat.transactionLedger.entries()]
      .filter(([, stored]) => stored.automatic)
      .map(([transactionId]) => transactionId);
    combat.readinessSequence = restoredSequence(readiness.sequence, fallbackSequence, "readiness.sequence");
    combat.commandSequence = restoredSequence(
      readiness.commandSequence,
      nextGeneratedSequence(commandIds, "command-"),
      "readiness.commandSequence",
    );
    if (commandsById.size !== combat.commandSequence) {
      throw new Error("Command history does not cover the complete generated command sequence");
    }
    const restoredCommandSequences = new Set();
    for (const commandId of commandsById.keys()) {
      const sequence = Number(commandId.slice("command-".length));
      if (!Number.isSafeInteger(sequence)
        || sequence < 0
        || sequence >= combat.commandSequence
        || commandId !== `command-${sequence}`
        || restoredCommandSequences.has(sequence)) {
        throw new Error(`Command history has a non-canonical or non-contiguous identity: ${commandId}`);
      }
      restoredCommandSequences.add(sequence);
    }
    combat.transactionSequence = restoredSequence(
      readiness.transactionSequence,
      nextGeneratedSequence(automaticTransactionIds, "transaction-auto-"),
      "readiness.transactionSequence",
    );
    combat.timelineMode = readiness.timelineMode ?? null;
    if (combat.timelineMode !== null && !Object.values(TIMELINE_MODE).includes(combat.timelineMode)) {
      throw new Error(`Invalid timeline mode: ${combat.timelineMode}`);
    }
    combat.currentActorId = readiness.currentActorId ?? null;
    combat.readinessPhase = readiness.phase ?? READINESS_PHASE.RESOLVING;
    if (!Object.values(READINESS_PHASE).includes(combat.readinessPhase)) {
      throw new Error(`Invalid readiness phase: ${combat.readinessPhase}`);
    }
    if (combat.currentActorId && !combat.units.has(combat.currentActorId)) throw new Error("Current actor is missing from combat units");
    if ((combat.readinessPhase === READINESS_PHASE.AWAITING_ACTION) !== Boolean(combat.currentActorId)) {
      throw new Error("Readiness phase and current actor are inconsistent");
    }
    if (combat.currentActorId && combat.units.get(combat.currentActorId).readyAt > combat.scheduler.time) {
      throw new Error("Current actor is not ready at restored scheduler time");
    }
    if (combat.currentActorId && combat.units.get(combat.currentActorId).readinessEventId) {
      throw new Error("Current actor cannot also have a future readiness event");
    }
    if (combat.currentActorId) {
      const currentUnit = combat.units.get(combat.currentActorId);
      const earlierSameTickEvent = combat.scheduler.queue.find((event) => {
        if (event.at !== combat.scheduler.time) return false;
        if (event.kind !== "actor:ready" || event.priority !== TIMELINE_EVENT_PRIORITY.ACTOR_READY) return true;
        const queuedUnit = combat.units.get(event.actorId);
        if (!queuedUnit) return true;
        return queuedUnit.readinessTieKey.localeCompare(currentUnit.readinessTieKey) < 0
          || (queuedUnit.readinessTieKey === currentUnit.readinessTieKey
            && (queuedUnit.readySequence < currentUnit.readySequence
              || (queuedUnit.readySequence === currentUnit.readySequence
                && queuedUnit.id.localeCompare(currentUnit.id) < 0)));
      });
      if (earlierSameTickEvent) {
        throw new Error(`Current decision skipped an earlier same-tick event: ${earlierSameTickEvent.id}`);
      }
    }
    if (combat.timelineMode === TIMELINE_MODE.RECOVERY) {
      const queuedIds = new Set();
      const queuedByCommand = new Map();
      for (const event of combat.scheduler.queue) {
        if (queuedIds.has(event.id)) throw new Error(`Duplicate timeline event id: ${event.id}`);
        queuedIds.add(event.id);
        if (event.kind === "actor:ready") {
          const unit = combat.units.get(event.actorId);
          if (!unit || unit.readinessEventId !== event.id) {
            throw new Error(`Readiness event is inconsistent: ${event.id}`);
          }
          if (event.priority !== TIMELINE_EVENT_PRIORITY.ACTOR_READY
            || event.at !== Math.max(combat.scheduler.time, unit.readyAt)
            || event.tieKey !== unit.readinessTieKey
            || event.payload?.readySequence !== unit.readySequence
            || event.payload?.tieKey !== unit.readinessTieKey) {
            throw new Error(`Readiness event state is inconsistent: ${event.id}`);
          }
          continue;
        }
        const commandId = event.payload?.commandId;
        const command = commandId ? combat.activeCommands.get(commandId) : null;
        if (!command || !command.eventIds.includes(event.id)) {
          throw new Error(`Timeline event has no active command: ${event.id}`);
        }
        if (command.status !== "active"
          || event.actorId !== command.actorId
          || event.priority !== eventPriority(event.kind)
          || event.payload?.transactionId !== command.transactionId
          || !sequenceAllowsEvent(command.kind, event.kind)
          || !Array.isArray(command.impactTicks)
          || !command.impactTicks.includes(event.at)
          || !Number.isSafeInteger(command.startTick)
          || event.at < command.startTick) {
          throw new Error(`Timeline event disagrees with active command: ${event.id}`);
        }
        if (!queuedByCommand.has(commandId)) queuedByCommand.set(commandId, []);
        queuedByCommand.get(commandId).push(event);
      }
      for (const unit of combat.units.values()) {
        if (unit.readinessEventId && !queuedIds.has(unit.readinessEventId)) {
          throw new Error(`Unit readiness event is missing: ${unit.id}`);
        }
      }
      for (const command of combat.activeCommands.values()) {
        if (command.status !== "active"
          || typeof command.transactionId !== "string" || !command.transactionId
          || !Number.isSafeInteger(command.startTick) || command.startTick < 0
          || !Number.isSafeInteger(command.recoveryEnd) || command.recoveryEnd < command.startTick
          || new Set(command.eventIds).size !== command.eventIds.length) {
          throw new Error(`Active command state is invalid: ${command.commandId}`);
        }
        const queued = queuedByCommand.get(command.commandId) ?? [];
        if (queued.length !== command.eventIds.length
          || queued.some((event) => !command.eventIds.includes(event.id))) {
          throw new Error(`Active command event set is inconsistent: ${command.commandId}`);
        }
        const transaction = combat.transactionLedger.get(command.transactionId);
        const transactionEvents = transaction?.result?.events;
        if (!transaction
          || transaction.result.commandId !== command.commandId
          || !Array.isArray(transactionEvents)
          || queued.some((event) => {
            const recorded = transactionEvents.find(({ id }) => id === event.id);
            return !recorded || !sameSerializableValue(recorded, event);
          })) {
          throw new Error(`Active command transaction is inconsistent: ${command.commandId}`);
        }
        const projectileId = command.payload?.projectileId;
        if (projectileId && !combat.activeProjectiles.has(projectileId)) {
          throw new Error(`Active projectile state is missing: ${projectileId}`);
        }
      }
      for (const projectile of combat.activeProjectiles.values()) {
        const remaining = combat.scheduler.queue
          .filter((event) => event.payload?.projectileId === projectile.projectileId)
          .sort((left, right) => left.at - right.at || left.sequence - right.sequence);
        if (remaining.length !== projectile.eventIds.length
          || remaining.some((event) => !projectile.eventIds.includes(event.id)
            || event.actorId !== projectile.actorId
            || event.payload?.targetId !== projectile.targetId
            || (event.payload?.persistsAfterSourceDeath ?? true) !== projectile.persistsAfterSourceDeath
            || !sameHex(event.payload?.targetAnchor, projectile.targetAnchor)
            || !sameProjectileCollisionMask(event.payload?.collisionMask, projectile.collisionMask))) {
          throw new Error(`Projectile timeline is inconsistent: ${projectile.projectileId}`);
        }
        const expectedCount = projectile.path.length - projectile.pathIndex - 1;
        if (remaining.length !== expectedCount || remaining.some((event, index) => {
          const pathIndex = projectile.pathIndex + index + 1;
          const final = pathIndex === projectile.path.length - 1;
          return event.kind !== (final ? "projectile:impact" : "projectile:step")
            || event.at !== projectile.launchedAt + pathIndex * projectile.stepTime
            || event.payload?.pathIndex !== pathIndex
            || !sameHex(event.payload?.from, projectile.path[pathIndex - 1])
            || !sameHex(event.payload?.to, projectile.path[pathIndex]);
        })) {
          throw new Error(`Projectile progress events are inconsistent: ${projectile.projectileId}`);
        }
      }
    }
    return combat;
  }

  #syncRecoveryReadiness(legalIds) {
    this.timelineMode ??= TIMELINE_MODE.RECOVERY;
    const legal = new Set(legalIds);
    if (this.currentActorId && !legal.has(this.currentActorId)) {
      throw new Error(`Current actor is no longer legal: ${this.currentActorId}`);
    }

    for (const unit of this.units.values()) {
      if (legal.has(unit.id) || !unit.readinessEventId) continue;
      const eventId = unit.readinessEventId;
      this.scheduler.cancelWhere((event) => event.id === eventId);
      unit.readinessEventId = null;
    }

    const missing = [...this.units.values()]
      .filter((unit) => legal.has(unit.id) && unit.id !== this.currentActorId && !unit.readinessEventId)
      .sort((a, b) => a.readyAt - b.readyAt || a.readinessTieKey.localeCompare(b.readinessTieKey) || a.readySequence - b.readySequence || a.id.localeCompare(b.id));
    for (const unit of missing) this.#scheduleReadinessEvent(unit);
  }

  #scheduleReadinessEvent(unit) {
    if (unit.readinessEventId) return unit.readinessEventId;
    const event = this.scheduler.schedule({
      at: Math.max(this.scheduler.time, unit.readyAt),
      kind: "actor:ready",
      actorId: unit.id,
      priority: TIMELINE_EVENT_PRIORITY.ACTOR_READY,
      tieKey: unit.readinessTieKey,
      payload: { readySequence: unit.readySequence, tieKey: unit.readinessTieKey },
    });
    unit.readinessEventId = event.id;
    return event.id;
  }

  #assertPendingCommandEvent(event) {
    const command = this.activeCommands.get(event.payload?.commandId);
    if (!command || command.status !== "active" || !command.eventIds.includes(event.id)) {
      throw new Error(`Timeline event has no pending active command: ${event.id}`);
    }
    if (event.actorId !== command.actorId
      || event.payload?.transactionId !== command.transactionId
      || event.priority !== eventPriority(event.kind)
      || !sequenceAllowsEvent(command.kind, event.kind)
      || !command.impactTicks.includes(event.at)
      || event.at < command.startTick) {
      throw new Error(`Timeline event disagrees with active command: ${event.id}`);
    }
    const transaction = this.transactionLedger.get(command.transactionId);
    const result = transaction?.result;
    const recorded = result?.events?.find(({ id }) => id === event.id);
    if (result?.commandId !== command.commandId
      || result?.transactionId !== command.transactionId
      || !recorded || !sameSerializableValue(recorded, event)) {
      throw new Error(`Timeline event disagrees with accepted transaction: ${event.id}`);
    }
    const duration = actionDuration(command.kind, command.payload);
    const actor = this.units.get(command.actorId);
    if (result.startTick !== command.startTick
      || result.recoveryEnd !== command.recoveryEnd
      || result.duration !== duration
      || command.recoveryEnd !== command.startTick + duration
      || (actor && actor.readyAt < command.recoveryEnd)) {
      throw new Error(`Command recovery budget is no longer valid: ${command.commandId}`);
    }
    const accepted = JSON.parse(transaction.fingerprint);
    if (accepted.actorId !== command.actorId || accepted.kind !== command.kind
      || !sameSerializableValue(accepted.payload, command.payload)) {
      throw new Error(`Command payload disagrees with accepted transaction: ${command.commandId}`);
    }
    return command;
  }

  #consumeCommandEvent(event, { keepActive = false, allowAlreadyInterrupted = false } = {}) {
    const commandId = event.payload?.commandId;
    if (!commandId) return;
    const command = this.activeCommands.get(commandId);
    if (!command) {
      const interrupted = allowAlreadyInterrupted
        && this.commandHistory.some((entry) => entry.commandId === commandId && entry.status === "interrupted");
      if (interrupted) return false;
      throw new Error(`Timeline event references inactive command: ${commandId}`);
    }
    command.eventIds = command.eventIds.filter((id) => id !== event.id);
    if (!keepActive && command.eventIds.length === 0) {
      command.status = "effects-complete";
      command.effectsCompletedAt = this.scheduler.time;
      this.activeCommands.delete(commandId);
      this.#archiveCommand(command);
    }
    return true;
  }

  #archiveCommand(command) {
    this.commandHistory.push(structuredClone(command));
  }

  #transactionReplay(transactionId, fingerprint) {
    const stored = this.transactionLedger.get(transactionId);
    if (!stored) return null;
    if (stored.fingerprint !== fingerprint) {
      throw new Error(`Transaction ${transactionId} was already used for a different command`);
    }
    return { ...structuredClone(stored.result), replayed: true };
  }

  #timingSource(kind, payload, duration) {
    if (kind === "move" || kind === "approachAttack") {
      return {
        rule: kind === "move"
          ? "ACTION_TIME.movePerTile * payload.distance"
          : "ACTION_TIME.movePerTile * payload.distance + ACTION_TIME.attack",
        movePerTile: ACTION_TIME.movePerTile,
        ...(kind === "approachAttack" ? { attack: ACTION_TIME.attack } : {}),
        distance: payload.distance,
        duration,
      };
    }
    return { rule: `ACTION_TIME.${kind}`, configuredDuration: ACTION_TIME[kind], duration };
  }

  #takeReadinessSequence() {
    const sequence = availableSequence(this.readinessSequence, "readinessSequence");
    this.readinessSequence += 1;
    return sequence;
  }

  #takeCommandSequence() {
    const sequence = availableSequence(this.commandSequence, "commandSequence");
    this.commandSequence += 1;
    return sequence;
  }

  #takeAutomaticTransactionId() {
    for (;;) {
      availableSequence(this.transactionSequence, "transactionSequence");
      const transactionId = `transaction-auto-${this.transactionSequence}`;
      this.transactionSequence += 1;
      if (!this.transactionLedger.has(transactionId)) return transactionId;
    }
  }

  #assertTimelineMode(requestedMode) {
    if (this.timelineMode && this.timelineMode !== requestedMode) {
      throw new Error(`Cannot mix ${this.timelineMode} and ${requestedMode} timeline APIs`);
    }
  }
}
