export const BATTLE_PREPARATION_SCHEMA_VERSION = 2;

export const DEPLOYMENT_COLUMN_COUNT = 3;
export const MAX_MAIN_HEROES = 3;
export const PARTY_SUMMON_FACTION_ID = "party";

export const BATTLE_PHASE = Object.freeze({
  PREPARATION: "preparation",
  ACTIVE: "active",
  COMPLETED: "completed",
});

export const BATTLE_ACTIVATION_REASON = Object.freeze({
  LEFT_DEPLOYMENT_ZONE: "left-deployment-zone",
  OFFENSIVE_SKILL: "offensive-skill",
  EXPLICIT_START: "explicit-start",
});

export const SKILL_CATEGORY = Object.freeze({
  OFFENSIVE: "offensive",
  BUFF: "buff",
  AURA: "aura",
  SUMMON: "summon",
  UTILITY: "utility",
});

export const UNIT_PRESENCE = Object.freeze({
  ON_FIELD: "on-field",
  OFF_FIELD: "off-field",
});

export const DEFAULT_PREPARATION_BALANCE = Object.freeze({
  secondsPerTurn: 6,
  minimumTurns: 1,
  maximumTurns: 99,
  rounding: "ceil",
});

const PHASES = new Set(Object.values(BATTLE_PHASE));
const ACTIVATION_REASONS = new Set(Object.values(BATTLE_ACTIVATION_REASON));
const SKILL_CATEGORIES = new Set(Object.values(SKILL_CATEGORY));
const UNIVERSAL_EQUIPPED_SKILLS = new Set(["basic.attack"]);
const UNIT_PRESENCE_STATES = new Set(Object.values(UNIT_PRESENCE));
const ROUNDING_POLICIES = new Set(["ceil", "floor", "nearest"]);
const INTERNAL_RESTORE = Symbol("battle-preparation-restore");
const MAX_COORDINATE = 1_000_000;
const MAX_SUMMON_LIMIT = 10_000;
const SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "phase",
  "activation",
  "encounterNumber",
  "actionSequence",
  "rules",
  "heroIds",
  "heroPresence",
  "positions",
  "loadouts",
  "summons",
  "buffs",
]);
const LEGACY_SNAPSHOT_KEYS = Object.freeze(SNAPSHOT_KEYS.filter((key) => key !== "heroPresence"));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(requireRecord(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  if (value !== value.trim()) throw new TypeError(`${label} must not contain leading or trailing whitespace`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function requireSafeInteger(value, label, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireFiniteNumber(value, label, { minimum = -Infinity, maximum = Infinity, exclusiveMinimum = false } = {}) {
  if (!Number.isFinite(value)
    || (exclusiveMinimum ? value <= minimum : value < minimum)
    || value > maximum) {
    const comparator = exclusiveMinimum ? "greater than" : "at least";
    throw new RangeError(`${label} must be finite, ${comparator} ${minimum}, and at most ${maximum}`);
  }
  return value;
}

function compareIds(left, right) {
  return left.localeCompare(right, "en");
}

function frozenClone(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(clone);
}

function normalizeHex(value, label = "Hex") {
  requireExactKeys(value, ["q", "r"], label);
  return Object.freeze({
    q: requireSafeInteger(value.q, `${label}.q`, { minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
    r: requireSafeInteger(value.r, `${label}.r`, { minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
  });
}

function positionKey(position) {
  return `${position.q},${position.r}`;
}

function normalizeBalance(value = {}) {
  if (!isRecord(value)) throw new TypeError("Preparation balance must be an object");
  const allowed = new Set(Object.keys(DEFAULT_PREPARATION_BALANCE));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown preparation balance field: ${key}`);
  }
  const merged = { ...DEFAULT_PREPARATION_BALANCE, ...value };
  const secondsPerTurn = requireFiniteNumber(merged.secondsPerTurn, "secondsPerTurn", {
    minimum: 0,
    maximum: 3600,
    exclusiveMinimum: true,
  });
  const minimumTurns = requireSafeInteger(merged.minimumTurns, "minimumTurns", { minimum: 1, maximum: 10_000 });
  const maximumTurns = requireSafeInteger(merged.maximumTurns, "maximumTurns", {
    minimum: minimumTurns,
    maximum: 10_000,
  });
  if (!ROUNDING_POLICIES.has(merged.rounding)) throw new RangeError(`Unknown turn rounding policy: ${merged.rounding}`);
  return Object.freeze({ secondsPerTurn, minimumTurns, maximumTurns, rounding: merged.rounding });
}

/**
 * Converts a Diablo-style timed effect into whole battle turns.
 * Skill growth belongs to data, while the pacing divisor and clamp belong to balance.
 */
export function durationSecondsToTurns({
  baseDurationSeconds,
  perLevelSeconds = 0,
  skillLevel = 1,
} = {}, balance = DEFAULT_PREPARATION_BALANCE) {
  const normalizedBalance = normalizeBalance(balance);
  const base = requireFiniteNumber(baseDurationSeconds, "baseDurationSeconds", {
    minimum: 0,
    maximum: 1_000_000,
    exclusiveMinimum: true,
  });
  const growth = requireFiniteNumber(perLevelSeconds, "perLevelSeconds", { minimum: 0, maximum: 1_000_000 });
  const level = requireSafeInteger(skillLevel, "skillLevel", { minimum: 1, maximum: 999 });
  const duration = base + growth * (level - 1);
  if (!Number.isSafeInteger(Math.ceil(duration)) && duration > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Effective buff duration exceeds the supported range");
  }
  const rawTurns = duration / normalizedBalance.secondsPerTurn;
  const rounded = normalizedBalance.rounding === "floor"
    ? Math.floor(rawTurns)
    : normalizedBalance.rounding === "nearest"
      ? Math.round(rawTurns)
      : Math.ceil(rawTurns);
  return Math.min(normalizedBalance.maximumTurns, Math.max(normalizedBalance.minimumTurns, rounded));
}

function normalizeHeroIds(value) {
  if (!Array.isArray(value)) throw new TypeError("heroIds must be an array");
  if (value.length < 1 || value.length > MAX_MAIN_HEROES) {
    throw new RangeError(`A battle requires from 1 to ${MAX_MAIN_HEROES} main heroes`);
  }
  const ids = value.map((id, index) => requireNonEmptyString(id, `heroIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError("heroIds must be unique");
  return Object.freeze(ids);
}

function normalizeLoadout(value, heroId) {
  requireExactKeys(value, ["left", "right"], `Loadout for ${heroId}`);
  const left = requireNonEmptyString(value.left, `Left skill for ${heroId}`);
  if (!Array.isArray(value.right) || value.right.length !== 3) {
    throw new RangeError(`Loadout for ${heroId} must have exactly three right-button skills`);
  }
  const right = value.right.map((id, index) => requireNonEmptyString(id, `Right skill ${index} for ${heroId}`));
  const all = [left, ...right];
  if (new Set(all).size !== all.length) throw new TypeError(`The four active skills for ${heroId} must be unique`);
  return Object.freeze({ left, right: Object.freeze(right) });
}

function getNamedValue(collection, id, label) {
  const value = collection instanceof Map ? collection.get(id) : collection?.[id];
  if (value === undefined) throw new TypeError(`${label} is missing ${id}`);
  return value;
}

function rejectUnexpectedNamedValues(collection, allowedIds, label) {
  if (collection instanceof Map) {
    for (const key of collection.keys()) {
      if (!allowedIds.has(key)) throw new TypeError(`${label} contains unknown id ${String(key)}`);
    }
    return;
  }
  requireRecord(collection, label);
  for (const key of Object.keys(collection)) {
    if (!allowedIds.has(key)) throw new TypeError(`${label} contains unknown id ${key}`);
  }
}

function normalizeLimit(value, label) {
  return requireSafeInteger(value, label, { minimum: 1, maximum: MAX_SUMMON_LIMIT });
}

function normalizeSummonLimits(value = {}) {
  if (!isRecord(value)) throw new TypeError("summonLimits must be an object");
  const limits = new Map();
  for (const [kind, limit] of Object.entries(value)) {
    const normalizedKind = requireNonEmptyString(kind, "Summon kind");
    limits.set(normalizedKind, normalizeLimit(limit, `Summon limit for ${normalizedKind}`));
  }
  return limits;
}

function normalizeSummon(value, label = "Summon", { snapshotShape = false } = {}) {
  const keys = Object.keys(requireRecord(value, label));
  const expectedKeys = ["id", "ownerId", "kind", "persistent", "position", ...(snapshotShape ? ["factionId"] : [])];
  if (!snapshotShape && keys.includes("factionId")) expectedKeys.push("factionId");
  requireExactKeys(value, expectedKeys, label);
  const factionId = value.factionId ?? PARTY_SUMMON_FACTION_ID;
  if (factionId !== PARTY_SUMMON_FACTION_ID) throw new RangeError(`${label} must belong to the party faction`);
  return Object.freeze({
    id: requireNonEmptyString(value.id, `${label} id`),
    ownerId: requireNonEmptyString(value.ownerId, `${label} ownerId`),
    kind: requireNonEmptyString(value.kind, `${label} kind`),
    factionId,
    persistent: requireBoolean(value.persistent, `${label} persistent`),
    position: normalizeHex(value.position, `${label} position`),
  });
}

function normalizeBuff(value, knownUnitIds, label = "Buff") {
  requireExactKeys(value, [
    "id",
    "skillId",
    "sourceId",
    "targetIds",
    "exclusiveGroup",
    "originalTurns",
    "remainingTurns",
  ], label);
  const id = requireNonEmptyString(value.id, `${label} id`);
  const skillId = requireNonEmptyString(value.skillId, `${label} skillId`);
  const sourceId = requireNonEmptyString(value.sourceId, `${label} sourceId`);
  if (!knownUnitIds.has(sourceId)) throw new TypeError(`${label} sourceId references an unknown unit`);
  if (!Array.isArray(value.targetIds) || value.targetIds.length < 1) throw new TypeError(`${label} targetIds must be non-empty`);
  const targetIds = value.targetIds.map((targetId, index) => {
    const idValue = requireNonEmptyString(targetId, `${label} targetIds[${index}]`);
    if (!knownUnitIds.has(idValue)) throw new TypeError(`${label} targetIds references an unknown unit`);
    return idValue;
  });
  if (new Set(targetIds).size !== targetIds.length) throw new TypeError(`${label} targetIds must be unique`);
  const sortedTargets = [...targetIds].sort(compareIds);
  if (targetIds.some((targetId, index) => targetId !== sortedTargets[index])) {
    throw new TypeError(`${label} targetIds must use canonical id order`);
  }
  const exclusiveGroup = value.exclusiveGroup === null
    ? null
    : requireNonEmptyString(value.exclusiveGroup, `${label} exclusiveGroup`);
  const permanent = value.originalTurns === null || value.remainingTurns === null;
  if (permanent && (value.originalTurns !== null || value.remainingTurns !== null)) {
    throw new TypeError(`${label} turn fields must both be null for a permanent effect`);
  }
  let originalTurns = null;
  let remainingTurns = null;
  if (!permanent) {
    originalTurns = requireSafeInteger(value.originalTurns, `${label} originalTurns`, { minimum: 1, maximum: 10_000 });
    remainingTurns = requireSafeInteger(value.remainingTurns, `${label} remainingTurns`, {
      minimum: 1,
      maximum: originalTurns,
    });
  }
  return Object.freeze({
    id,
    skillId,
    sourceId,
    targetIds: Object.freeze(targetIds),
    exclusiveGroup,
    originalTurns,
    remainingTurns,
  });
}

function actionResult({ phaseBefore, phaseAfter, activated = false, activationReason = null, consumesTurn, changed = true }) {
  return frozenClone({
    ok: true,
    changed,
    phase: phaseAfter,
    activated,
    activationReason,
    consumesTurn,
    freePreparationAction: phaseBefore === BATTLE_PHASE.PREPARATION && consumesTurn === false,
  });
}

const DEFAULT_DEPLOYMENT_COLUMN_OF = ({ q }) => q;

function normalizeDeploymentColumnOf(value) {
  if (value === undefined) return DEFAULT_DEPLOYMENT_COLUMN_OF;
  if (typeof value !== "function") throw new TypeError("deploymentColumnOf must be a function");
  return value;
}

export class BattlePreparationState {
  #phase;
  #activation;
  #encounterNumber;
  #actionSequence;
  #rules;
  #heroIds;
  #heroPresence;
  #positions;
  #loadouts;
  #summons;
  #buffs;
  #deploymentColumnOf;

  constructor(options = {}) {
    this.#deploymentColumnOf = normalizeDeploymentColumnOf(options?.deploymentColumnOf);
    if (isRecord(options) && options[INTERNAL_RESTORE]) {
      this.#loadNormalizedSnapshot(options[INTERNAL_RESTORE]);
      return;
    }

    const {
      heroIds,
      loadouts,
      heroPositions,
      persistentSummons = [],
      summonLimits = {},
      defaultSummonLimit = 8,
      maxSummonsPerOwner = 20,
      deploymentStartColumn = 0,
      balance = DEFAULT_PREPARATION_BALANCE,
    } = options;
    this.#phase = BATTLE_PHASE.PREPARATION;
    this.#activation = null;
    this.#encounterNumber = 1;
    this.#actionSequence = 0;
    this.#heroIds = normalizeHeroIds(heroIds);
    this.#heroPresence = new Map(this.#heroIds.map((heroId) => [heroId, UNIT_PRESENCE.ON_FIELD]));
    this.#rules = Object.freeze({
      deploymentStartColumn: requireSafeInteger(deploymentStartColumn, "deploymentStartColumn", {
        minimum: -MAX_COORDINATE,
        maximum: MAX_COORDINATE - DEPLOYMENT_COLUMN_COUNT,
      }),
      deploymentColumns: DEPLOYMENT_COLUMN_COUNT,
      maxMainHeroes: MAX_MAIN_HEROES,
      defaultSummonLimit: normalizeLimit(defaultSummonLimit, "defaultSummonLimit"),
      maxSummonsPerOwner: normalizeLimit(maxSummonsPerOwner, "maxSummonsPerOwner"),
      summonLimits: normalizeSummonLimits(summonLimits),
      balance: normalizeBalance(balance),
    });
    if (this.#rules.defaultSummonLimit > this.#rules.maxSummonsPerOwner) {
      throw new RangeError("defaultSummonLimit cannot exceed maxSummonsPerOwner");
    }
    for (const [kind, limit] of this.#rules.summonLimits) {
      if (limit > this.#rules.maxSummonsPerOwner) {
        throw new RangeError(`Summon limit for ${kind} cannot exceed maxSummonsPerOwner`);
      }
    }

    const heroSet = new Set(this.#heroIds);
    rejectUnexpectedNamedValues(loadouts, heroSet, "loadouts");
    rejectUnexpectedNamedValues(heroPositions, heroSet, "heroPositions");
    this.#loadouts = new Map(this.#heroIds.map((heroId) => [heroId, normalizeLoadout(
      getNamedValue(loadouts, heroId, "loadouts"),
      heroId,
    )]));
    this.#positions = new Map(this.#heroIds.map((heroId) => [heroId, normalizeHex(
      getNamedValue(heroPositions, heroId, "heroPositions"),
      `Position for ${heroId}`,
    )]));
    this.#summons = new Map();
    this.#buffs = new Map();

    if (!Array.isArray(persistentSummons)) throw new TypeError("persistentSummons must be an array");
    for (const [index, rawSummon] of persistentSummons.entries()) {
      const summon = normalizeSummon(rawSummon, `persistentSummons[${index}]`);
      if (!summon.persistent) throw new TypeError("persistentSummons cannot contain a non-persistent summon");
      this.#validateNewSummon(summon);
      this.#summons.set(summon.id, summon);
      this.#positions.set(summon.id, summon.position);
    }
    this.#assertUniquePositions();
    this.#assertAllUnitsInDeploymentZone("Initial preparation position");
  }

  get phase() {
    return this.#phase;
  }

  get activation() {
    return this.#activation ? frozenClone(this.#activation) : null;
  }

  get encounterNumber() {
    return this.#encounterNumber;
  }

  get actionSequence() {
    return this.#actionSequence;
  }

  get enemyTurnsEnabled() {
    return this.#phase === BATTLE_PHASE.ACTIVE;
  }

  get enemyAwarenessEnabled() {
    return this.#phase === BATTLE_PHASE.ACTIVE;
  }

  get heroIds() {
    return Object.freeze([...this.#heroIds]);
  }

  get balance() {
    return frozenClone(this.#rules.balance);
  }

  isDeploymentHex(position) {
    const normalized = normalizeHex(position, "Deployment query hex");
    const column = requireSafeInteger(this.#deploymentColumnOf(normalized), "Deployment query column", {
      minimum: -MAX_COORDINATE,
      maximum: MAX_COORDINATE,
    });
    return column >= this.#rules.deploymentStartColumn
      && column < this.#rules.deploymentStartColumn + DEPLOYMENT_COLUMN_COUNT;
  }

  presenceOf(unitId) {
    const id = this.#requireUnit(unitId);
    return this.#summons.has(id) ? UNIT_PRESENCE.ON_FIELD : this.#heroPresence.get(id);
  }

  isUnitOnField(unitId) {
    return this.presenceOf(unitId) === UNIT_PRESENCE.ON_FIELD;
  }

  positionOf(unitId) {
    const id = this.#requireUnit(unitId);
    if (!this.isUnitOnField(id)) return null;
    const position = this.#positions.get(id);
    if (!position) throw new Error(`On-field unit ${id} has no position`);
    return frozenClone(position);
  }

  getLoadout(heroId) {
    const id = this.#requireHero(heroId);
    return frozenClone(this.#loadouts.get(id));
  }

  listSummons({ ownerId = null } = {}) {
    if (ownerId !== null) this.#requireHero(ownerId);
    return frozenClone([...this.#summons.values()]
      .filter((summon) => ownerId === null || summon.ownerId === ownerId)
      .sort((left, right) => compareIds(left.id, right.id)));
  }

  listBuffs({ targetId = null } = {}) {
    if (targetId !== null) this.#requireUnit(targetId);
    return frozenClone([...this.#buffs.values()]
      .filter((buff) => targetId === null || buff.targetIds.includes(targetId))
      .sort((left, right) => compareIds(left.id, right.id)));
  }

  moveUnit({ unitId, to } = {}) {
    this.#requireActionablePhase();
    const id = this.#requireUnit(unitId);
    this.#requireOnFieldUnit(id);
    const destination = normalizeHex(to, "Movement destination");
    const occupied = [...this.#positions.entries()].find(([otherId, position]) => (
      otherId !== id && positionKey(position) === positionKey(destination)
    ));
    if (occupied) throw new Error(`Movement destination is occupied by ${occupied[0]}`);
    const current = this.#positions.get(id);
    if (positionKey(current) === positionKey(destination)) {
      return actionResult({
        phaseBefore: this.#phase,
        phaseAfter: this.#phase,
        consumesTurn: false,
        changed: false,
      });
    }
    const phaseBefore = this.#phase;
    let activated = false;
    if (phaseBefore === BATTLE_PHASE.PREPARATION && !this.isDeploymentHex(destination)) {
      this.#activate(BATTLE_ACTIVATION_REASON.LEFT_DEPLOYMENT_ZONE, { actorId: id, skillId: null });
      activated = true;
    } else {
      this.#incrementActionSequence();
    }
    this.#positions.set(id, destination);
    if (this.#summons.has(id)) {
      this.#summons.set(id, Object.freeze({ ...this.#summons.get(id), position: destination }));
    }
    const consumesTurn = phaseBefore === BATTLE_PHASE.ACTIVE || activated;
    return actionResult({
      phaseBefore,
      phaseAfter: this.#phase,
      activated,
      activationReason: activated ? BATTLE_ACTIVATION_REASON.LEFT_DEPLOYMENT_ZONE : null,
      consumesTurn,
    });
  }

  withdrawUnit(unitId) {
    this.#requireActivePhase("A unit can be withdrawn only during active combat");
    const id = this.#requireHero(unitId);
    if (this.#heroPresence.get(id) === UNIT_PRESENCE.OFF_FIELD) {
      return frozenClone({
        ...actionResult({
          phaseBefore: this.#phase,
          phaseAfter: this.#phase,
          consumesTurn: false,
          changed: false,
        }),
        unitId: id,
        presence: UNIT_PRESENCE.OFF_FIELD,
        position: null,
        removedBuffIds: [],
        updatedBuffIds: [],
      });
    }
    this.#ensureActionCapacity();
    const removedBuffIds = [];
    const updatedBuffs = [];
    for (const [buffId, buff] of this.#buffs) {
      if (buff.sourceId === id) {
        removedBuffIds.push(buffId);
        continue;
      }
      if (!buff.targetIds.includes(id)) continue;
      const targetIds = buff.targetIds.filter((targetId) => targetId !== id);
      if (targetIds.length === 0) {
        removedBuffIds.push(buffId);
      } else {
        updatedBuffs.push([buffId, Object.freeze({
          ...buff,
          targetIds: Object.freeze(targetIds),
        })]);
      }
    }
    this.#positions.delete(id);
    this.#heroPresence.set(id, UNIT_PRESENCE.OFF_FIELD);
    for (const buffId of removedBuffIds) this.#buffs.delete(buffId);
    for (const [buffId, buff] of updatedBuffs) this.#buffs.set(buffId, buff);
    this.#incrementActionSequence();
    return frozenClone({
      ...actionResult({
        phaseBefore: this.#phase,
        phaseAfter: this.#phase,
        consumesTurn: false,
      }),
      unitId: id,
      presence: UNIT_PRESENCE.OFF_FIELD,
      position: null,
      removedBuffIds: removedBuffIds.sort(compareIds),
      updatedBuffIds: updatedBuffs.map(([buffId]) => buffId).sort(compareIds),
    });
  }

  returnUnit({ unitId, to } = {}) {
    this.#requireActivePhase("A unit can return only during active combat");
    const id = this.#requireHero(unitId);
    const destination = normalizeHex(to, "Return destination");
    if (this.#heroPresence.get(id) === UNIT_PRESENCE.ON_FIELD) {
      const current = this.#positions.get(id);
      if (current && positionKey(current) === positionKey(destination)) {
        return frozenClone({
          ...actionResult({
            phaseBefore: this.#phase,
            phaseAfter: this.#phase,
            consumesTurn: false,
            changed: false,
          }),
          unitId: id,
          presence: UNIT_PRESENCE.ON_FIELD,
          position: current,
        });
      }
      throw new Error(`Main hero ${id} is already on the field`);
    }
    const occupied = [...this.#positions.entries()].find(([, position]) => (
      positionKey(position) === positionKey(destination)
    ));
    if (occupied) throw new Error(`Return destination is occupied by ${occupied[0]}`);
    this.#ensureActionCapacity();
    this.#positions.set(id, destination);
    this.#heroPresence.set(id, UNIT_PRESENCE.ON_FIELD);
    this.#incrementActionSequence();
    return frozenClone({
      ...actionResult({
        phaseBefore: this.#phase,
        phaseAfter: this.#phase,
        consumesTurn: false,
      }),
      unitId: id,
      presence: UNIT_PRESENCE.ON_FIELD,
      position: destination,
    });
  }

  useSkill({ actorId, skillId, category } = {}) {
    this.#requireActionablePhase();
    const actor = this.#requireHero(actorId);
    this.#requireOnFieldUnit(actor);
    const skill = requireNonEmptyString(skillId, "Skill id");
    this.#requireEquippedSkill(actor, skill);
    if (!SKILL_CATEGORIES.has(category)) throw new RangeError(`Unknown skill category: ${String(category)}`);
    const phaseBefore = this.#phase;
    const activates = phaseBefore === BATTLE_PHASE.PREPARATION && category === SKILL_CATEGORY.OFFENSIVE;
    if (activates) {
      this.#activate(BATTLE_ACTIVATION_REASON.OFFENSIVE_SKILL, { actorId: actor, skillId: skill });
    } else {
      this.#incrementActionSequence();
    }
    return actionResult({
      phaseBefore,
      phaseAfter: this.#phase,
      activated: activates,
      activationReason: activates ? BATTLE_ACTIVATION_REASON.OFFENSIVE_SKILL : null,
      consumesTurn: phaseBefore === BATTLE_PHASE.ACTIVE || activates,
    });
  }

  applyBuff({
    id,
    skillId,
    sourceId,
    targetIds,
    baseDurationSeconds,
    perLevelSeconds = 0,
    skillLevel = 1,
    permanent = false,
    exclusiveGroup = null,
  } = {}) {
    this.#requireActionablePhase();
    const buffId = requireNonEmptyString(id, "Buff id");
    const source = this.#requireHero(sourceId);
    this.#requireOnFieldUnit(source);
    const skill = requireNonEmptyString(skillId, "Buff skill id");
    this.#requireEquippedSkill(source, skill);
    if (!Array.isArray(targetIds) || targetIds.length < 1) throw new TypeError("Buff targetIds must be a non-empty array");
    const targets = targetIds.map((targetId) => this.#requireOnFieldUnit(this.#requireUnit(targetId))).sort(compareIds);
    if (new Set(targets).size !== targets.length) throw new TypeError("Buff targetIds must be unique");
    if (typeof permanent !== "boolean") throw new TypeError("Buff permanent must be boolean");
    const group = exclusiveGroup === null ? null : requireNonEmptyString(exclusiveGroup, "Buff exclusiveGroup");
    const previous = this.#buffs.get(buffId);
    if (previous && previous.sourceId !== source) throw new Error(`Buff id ${buffId} belongs to another source`);
    let turns = null;
    if (permanent) {
      if (baseDurationSeconds !== undefined) throw new TypeError("A permanent buff cannot specify baseDurationSeconds");
    } else {
      turns = durationSecondsToTurns({ baseDurationSeconds, perLevelSeconds, skillLevel }, this.#rules.balance);
    }
    const buff = Object.freeze({
      id: buffId,
      skillId: skill,
      sourceId: source,
      targetIds: Object.freeze(targets),
      exclusiveGroup: group,
      originalTurns: turns,
      remainingTurns: turns,
    });
    const phaseBefore = this.#phase;
    this.#ensureActionCapacity();
    if (group !== null) {
      for (const [otherId, other] of this.#buffs) {
        if (otherId !== buffId && other.sourceId === source && other.exclusiveGroup === group) this.#buffs.delete(otherId);
      }
    }
    this.#buffs.set(buffId, buff);
    this.#incrementActionSequence();
    return frozenClone({
      ...actionResult({
        phaseBefore,
        phaseAfter: this.#phase,
        consumesTurn: phaseBefore === BATTLE_PHASE.ACTIVE,
      }),
      buff,
    });
  }

  summonUnit({ id, ownerId, kind, skillId, persistent = true, position } = {}) {
    this.#requireActionablePhase();
    const owner = this.#requireHero(ownerId);
    this.#requireOnFieldUnit(owner);
    const skill = requireNonEmptyString(skillId, "Summon skill id");
    this.#requireEquippedSkill(owner, skill);
    const summon = normalizeSummon({
      id,
      ownerId: owner,
      kind,
      factionId: PARTY_SUMMON_FACTION_ID,
      persistent,
      position,
    });
    this.#validateNewSummon(summon);
    if (this.#positionsHasHex(summon.position)) throw new Error("Summon position is occupied");
    if (this.#phase === BATTLE_PHASE.PREPARATION && !this.isDeploymentHex(summon.position)) {
      throw new Error("A preparation summon must be placed inside the deployment zone");
    }
    const phaseBefore = this.#phase;
    this.#ensureActionCapacity();
    this.#summons.set(summon.id, summon);
    this.#positions.set(summon.id, summon.position);
    this.#incrementActionSequence();
    return frozenClone({
      ...actionResult({
        phaseBefore,
        phaseAfter: this.#phase,
        consumesTurn: phaseBefore === BATTLE_PHASE.ACTIVE,
      }),
      summon,
    });
  }

  defeatSummon(summonId) {
    this.#requireActionablePhase();
    const id = requireNonEmptyString(summonId, "Summon id");
    if (!this.#summons.has(id)) return false;
    this.#ensureActionCapacity();
    this.#summons.delete(id);
    this.#positions.delete(id);
    for (const [buffId, buff] of this.#buffs) {
      if (buff.sourceId === id) {
        this.#buffs.delete(buffId);
        continue;
      }
      if (!buff.targetIds.includes(id)) continue;
      const targetIds = buff.targetIds.filter((targetId) => targetId !== id);
      if (targetIds.length === 0) {
        this.#buffs.delete(buffId);
      } else {
        this.#buffs.set(buffId, Object.freeze({
          ...buff,
          targetIds: Object.freeze(targetIds),
        }));
      }
    }
    this.#incrementActionSequence();
    return true;
  }

  changeSkill({ heroId, slot, rightIndex, skillId } = {}) {
    this.#requireActionablePhase();
    const hero = this.#requireHero(heroId);
    this.#requireOnFieldUnit(hero);
    const skill = requireNonEmptyString(skillId, "Replacement skill id");
    if (slot !== "left" && slot !== "right") throw new RangeError("Skill slot must be left or right");
    if (slot === "left" && rightIndex !== undefined) throw new TypeError("rightIndex is only valid for a right skill slot");
    if (slot === "right") requireSafeInteger(rightIndex, "rightIndex", { minimum: 0, maximum: 2 });
    const oldLoadout = this.#loadouts.get(hero);
    const current = slot === "left" ? oldLoadout.left : oldLoadout.right[rightIndex];
    if (current === skill) {
      return frozenClone({
        ...actionResult({
          phaseBefore: this.#phase,
          phaseAfter: this.#phase,
          consumesTurn: false,
          changed: false,
        }),
        loadout: oldLoadout,
      });
    }
    const next = {
      left: slot === "left" ? skill : oldLoadout.left,
      right: oldLoadout.right.map((entry, index) => (
        slot === "right" && index === rightIndex ? skill : entry
      )),
    };
    const loadout = normalizeLoadout(next, hero);
    const phaseBefore = this.#phase;
    this.#ensureActionCapacity();
    this.#loadouts.set(hero, loadout);
    this.#incrementActionSequence();
    return frozenClone({
      ...actionResult({
        phaseBefore,
        phaseAfter: this.#phase,
        consumesTurn: phaseBefore === BATTLE_PHASE.ACTIVE,
      }),
      loadout,
    });
  }

  startBattle() {
    this.#requireActionablePhase();
    if (this.#phase === BATTLE_PHASE.ACTIVE) {
      return actionResult({
        phaseBefore: this.#phase,
        phaseAfter: this.#phase,
        consumesTurn: false,
        changed: false,
      });
    }
    const phaseBefore = this.#phase;
    this.#activate(BATTLE_ACTIVATION_REASON.EXPLICIT_START, { actorId: null, skillId: null });
    return actionResult({
      phaseBefore,
      phaseAfter: this.#phase,
      activated: true,
      activationReason: BATTLE_ACTIVATION_REASON.EXPLICIT_START,
      consumesTurn: false,
    });
  }

  advanceTurn(count = 1, options = {}) {
    if (this.#phase !== BATTLE_PHASE.ACTIVE) throw new Error("Buff turns advance only during active combat");
    const turns = requireSafeInteger(count, "Turn count", { minimum: 1, maximum: 10_000 });
    if (!isRecord(options)) throw new TypeError("Turn advance options must be an object");
    for (const key of Object.keys(options)) {
      if (key !== "eligibleBuffIds") throw new TypeError(`Unknown turn advance option: ${key}`);
    }
    let eligibleBuffIds = null;
    if (options.eligibleBuffIds !== undefined) {
      if (!Array.isArray(options.eligibleBuffIds)) throw new TypeError("eligibleBuffIds must be an array");
      const ids = options.eligibleBuffIds.map((id, index) => requireNonEmptyString(id, `eligibleBuffIds[${index}]`));
      if (new Set(ids).size !== ids.length) throw new TypeError("eligibleBuffIds must be unique");
      eligibleBuffIds = new Set(ids);
    }
    this.#ensureActionCapacity();
    const expired = [];
    for (const [buffId, buff] of this.#buffs) {
      if (eligibleBuffIds !== null && !eligibleBuffIds.has(buffId)) continue;
      if (buff.remainingTurns === null) continue;
      const remainingTurns = buff.remainingTurns - turns;
      if (remainingTurns <= 0) {
        this.#buffs.delete(buffId);
        expired.push(buffId);
      } else {
        this.#buffs.set(buffId, Object.freeze({ ...buff, remainingTurns }));
      }
    }
    this.#incrementActionSequence();
    return frozenClone({ expiredBuffIds: expired.sort(compareIds), buffs: this.listBuffs() });
  }

  completeBattle({ survivingSummonIds } = {}) {
    if (this.#phase !== BATTLE_PHASE.ACTIVE) throw new Error("Only active combat can be completed");
    let survivors = new Set(this.#summons.keys());
    if (survivingSummonIds !== undefined) {
      if (!Array.isArray(survivingSummonIds)) throw new TypeError("survivingSummonIds must be an array");
      const normalized = survivingSummonIds.map((id, index) => requireNonEmptyString(id, `survivingSummonIds[${index}]`));
      if (new Set(normalized).size !== normalized.length) throw new TypeError("survivingSummonIds must be unique");
      for (const id of normalized) {
        if (!this.#summons.has(id)) throw new Error(`Unknown surviving summon: ${id}`);
      }
      survivors = new Set(normalized);
    }
    this.#ensureActionCapacity();
    for (const [summonId, summon] of this.#summons) {
      if (!survivors.has(summonId) || !summon.persistent) {
        this.#summons.delete(summonId);
        this.#positions.delete(summonId);
      }
    }
    this.#buffs.clear();
    this.#phase = BATTLE_PHASE.COMPLETED;
    this.#incrementActionSequence();
    return frozenClone({ phase: this.#phase, persistentSummons: this.listSummons() });
  }

  beginNextBattle({ heroPositions, summonPositions = {} } = {}) {
    if (this.#phase !== BATTLE_PHASE.COMPLETED) throw new Error("The next battle can begin only after completing the current one");
    const expectedHeroes = new Set(this.#heroIds);
    const expectedSummons = new Set(this.#summons.keys());
    rejectUnexpectedNamedValues(heroPositions, expectedHeroes, "heroPositions");
    rejectUnexpectedNamedValues(summonPositions, expectedSummons, "summonPositions");
    const positions = new Map();
    for (const heroId of this.#heroIds) {
      positions.set(heroId, normalizeHex(getNamedValue(heroPositions, heroId, "heroPositions"), `Position for ${heroId}`));
    }
    for (const [summonId, summon] of this.#summons) {
      positions.set(summonId, normalizeHex(
        getNamedValue(summonPositions, summonId, "summonPositions"),
        `Position for ${summonId}`,
      ));
    }
    const positionKeys = [...positions.values()].map(positionKey);
    if (new Set(positionKeys).size !== positionKeys.length) throw new Error("Preparation unit positions must be unique");
    for (const position of positions.values()) {
      if (!this.isDeploymentHex(position)) {
        throw new Error("Next battle position must be inside the three-column deployment zone");
      }
    }
    this.#ensureActionCapacity();
    this.#nextSafeCounter(this.#encounterNumber, "Encounter number");
    this.#positions = positions;
    this.#heroPresence = new Map(this.#heroIds.map((heroId) => [heroId, UNIT_PRESENCE.ON_FIELD]));
    for (const [summonId, summon] of this.#summons) {
      this.#summons.set(summonId, Object.freeze({ ...summon, position: this.#positions.get(summonId) }));
    }
    this.#phase = BATTLE_PHASE.PREPARATION;
    this.#activation = null;
    this.#encounterNumber = this.#nextSafeCounter(this.#encounterNumber, "Encounter number");
    this.#incrementActionSequence();
    return frozenClone({
      phase: this.#phase,
      encounterNumber: this.#encounterNumber,
      persistentSummons: this.listSummons(),
    });
  }

  snapshot() {
    return structuredClone({
      schemaVersion: BATTLE_PREPARATION_SCHEMA_VERSION,
      phase: this.#phase,
      activation: this.#activation,
      encounterNumber: this.#encounterNumber,
      actionSequence: this.#actionSequence,
      rules: {
        deploymentStartColumn: this.#rules.deploymentStartColumn,
        deploymentColumns: this.#rules.deploymentColumns,
        maxMainHeroes: this.#rules.maxMainHeroes,
        defaultSummonLimit: this.#rules.defaultSummonLimit,
        maxSummonsPerOwner: this.#rules.maxSummonsPerOwner,
        summonLimits: [...this.#rules.summonLimits.entries()]
          .sort(([left], [right]) => compareIds(left, right))
          .map(([kind, limit]) => ({ kind, limit })),
        balance: this.#rules.balance,
      },
      heroIds: [...this.#heroIds],
      heroPresence: this.#heroIds.map((heroId) => ({
        heroId,
        state: this.#heroPresence.get(heroId),
      })),
      positions: [...this.#positions.entries()]
        .sort(([left], [right]) => compareIds(left, right))
        .map(([unitId, position]) => ({ unitId, ...position })),
      loadouts: this.#heroIds.map((heroId) => ({ heroId, ...this.#loadouts.get(heroId) })),
      summons: [...this.#summons.values()].sort((left, right) => compareIds(left.id, right.id)),
      buffs: [...this.#buffs.values()].sort((left, right) => compareIds(left.id, right.id)),
    });
  }

  static restore(snapshot, { deploymentColumnOf } = {}) {
    const normalizedColumnOf = normalizeDeploymentColumnOf(deploymentColumnOf);
    const normalized = BattlePreparationState.#normalizeSnapshot(snapshot, normalizedColumnOf);
    const restored = new BattlePreparationState({
      [INTERNAL_RESTORE]: normalized,
      deploymentColumnOf: normalizedColumnOf,
    });
    const roundTrip = restored.snapshot();
    if (JSON.stringify(roundTrip) !== JSON.stringify(snapshot)) {
      throw new TypeError("Battle preparation snapshot is not in canonical deterministic order");
    }
    return restored;
  }

  static migrateSnapshot(snapshot, { deploymentColumnOf } = {}) {
    requireRecord(snapshot, "Battle preparation snapshot");
    if (snapshot?.schemaVersion === BATTLE_PREPARATION_SCHEMA_VERSION) {
      return BattlePreparationState.restore(snapshot, { deploymentColumnOf }).snapshot();
    }
    if (snapshot.schemaVersion !== 1) {
      throw new RangeError(`Unsupported battle preparation schema version: ${String(snapshot.schemaVersion)}`);
    }
    requireExactKeys(snapshot, LEGACY_SNAPSHOT_KEYS, "Legacy battle preparation snapshot");
    if (!Array.isArray(snapshot.heroIds)) throw new TypeError("Legacy heroIds must be an array");
    const migrated = {
      schemaVersion: BATTLE_PREPARATION_SCHEMA_VERSION,
      phase: structuredClone(snapshot.phase),
      activation: structuredClone(snapshot.activation),
      encounterNumber: structuredClone(snapshot.encounterNumber),
      actionSequence: structuredClone(snapshot.actionSequence),
      rules: structuredClone(snapshot.rules),
      heroIds: structuredClone(snapshot.heroIds),
      heroPresence: snapshot.heroIds.map((heroId) => ({ heroId, state: UNIT_PRESENCE.ON_FIELD })),
      positions: structuredClone(snapshot.positions),
      loadouts: structuredClone(snapshot.loadouts),
      summons: structuredClone(snapshot.summons),
      buffs: structuredClone(snapshot.buffs),
    };
    const normalized = BattlePreparationState.restore(migrated, { deploymentColumnOf }).snapshot();
    const canonicalLegacy = {
      schemaVersion: 1,
      phase: structuredClone(normalized.phase),
      activation: structuredClone(normalized.activation),
      encounterNumber: normalized.encounterNumber,
      actionSequence: normalized.actionSequence,
      rules: structuredClone(normalized.rules),
      heroIds: structuredClone(normalized.heroIds),
      positions: structuredClone(normalized.positions),
      loadouts: structuredClone(normalized.loadouts),
      summons: structuredClone(normalized.summons),
      buffs: structuredClone(normalized.buffs),
    };
    if (JSON.stringify(canonicalLegacy) !== JSON.stringify(snapshot)) {
      throw new TypeError("Legacy battle preparation snapshot is not in canonical deterministic order");
    }
    return normalized;
  }

  #loadNormalizedSnapshot(snapshot) {
    this.#phase = snapshot.phase;
    this.#activation = snapshot.activation ? Object.freeze(snapshot.activation) : null;
    this.#encounterNumber = snapshot.encounterNumber;
    this.#actionSequence = snapshot.actionSequence;
    this.#heroIds = Object.freeze(snapshot.heroIds);
    this.#heroPresence = new Map(snapshot.heroPresence.map(({ heroId, state }) => [heroId, state]));
    this.#positions = new Map(snapshot.positions.map(({ unitId, q, r }) => [unitId, Object.freeze({ q, r })]));
    this.#loadouts = new Map(snapshot.loadouts.map(({ heroId, left, right }) => [
      heroId,
      Object.freeze({ left, right: Object.freeze(right) }),
    ]));
    this.#summons = new Map(snapshot.summons.map((summon) => [summon.id, Object.freeze({
      ...summon,
      position: Object.freeze(summon.position),
    })]));
    this.#buffs = new Map(snapshot.buffs.map((buff) => [buff.id, Object.freeze({
      ...buff,
      targetIds: Object.freeze(buff.targetIds),
    })]));
    this.#rules = Object.freeze({
      ...snapshot.rules,
      summonLimits: new Map(snapshot.rules.summonLimits.map(({ kind, limit }) => [kind, limit])),
      balance: Object.freeze(snapshot.rules.balance),
    });
  }

  static #normalizeSnapshot(snapshot, deploymentColumnOf = DEFAULT_DEPLOYMENT_COLUMN_OF) {
    requireRecord(snapshot, "Battle preparation snapshot");
    if (snapshot.schemaVersion !== BATTLE_PREPARATION_SCHEMA_VERSION) {
      throw new RangeError(`Unsupported battle preparation schema version: ${String(snapshot.schemaVersion)}`);
    }
    requireExactKeys(snapshot, SNAPSHOT_KEYS, "Battle preparation snapshot");
    if (!PHASES.has(snapshot.phase)) throw new RangeError(`Unknown battle phase: ${String(snapshot.phase)}`);
    const heroIds = normalizeHeroIds(snapshot.heroIds);
    const heroSet = new Set(heroIds);
    if (!Array.isArray(snapshot.heroPresence) || snapshot.heroPresence.length !== heroIds.length) {
      throw new TypeError("Snapshot heroPresence must contain every hero exactly once");
    }
    const heroPresence = snapshot.heroPresence.map((entry, index) => {
      requireExactKeys(entry, ["heroId", "state"], `heroPresence[${index}]`);
      if (entry.heroId !== heroIds[index]) throw new TypeError("Snapshot heroPresence must follow heroIds order");
      if (!UNIT_PRESENCE_STATES.has(entry.state)) {
        throw new RangeError(`Unknown hero presence state: ${String(entry.state)}`);
      }
      return Object.freeze({ heroId: entry.heroId, state: entry.state });
    });
    const onFieldHeroIds = new Set(heroPresence
      .filter(({ state }) => state === UNIT_PRESENCE.ON_FIELD)
      .map(({ heroId }) => heroId));
    const encounterNumber = requireSafeInteger(snapshot.encounterNumber, "encounterNumber", { minimum: 1 });
    const actionSequence = requireSafeInteger(snapshot.actionSequence, "actionSequence", { minimum: 0 });
    requireExactKeys(snapshot.rules, [
      "deploymentStartColumn",
      "deploymentColumns",
      "maxMainHeroes",
      "defaultSummonLimit",
      "maxSummonsPerOwner",
      "summonLimits",
      "balance",
    ], "Battle preparation rules");
    const deploymentStartColumn = requireSafeInteger(snapshot.rules.deploymentStartColumn, "deploymentStartColumn", {
      minimum: -MAX_COORDINATE,
      maximum: MAX_COORDINATE - DEPLOYMENT_COLUMN_COUNT,
    });
    if (snapshot.rules.deploymentColumns !== DEPLOYMENT_COLUMN_COUNT) throw new RangeError("Deployment zone must contain exactly three columns");
    if (snapshot.rules.maxMainHeroes !== MAX_MAIN_HEROES) throw new RangeError("Battle main-hero limit must be exactly three");
    const defaultSummonLimit = normalizeLimit(snapshot.rules.defaultSummonLimit, "defaultSummonLimit");
    const maxSummonsPerOwner = normalizeLimit(snapshot.rules.maxSummonsPerOwner, "maxSummonsPerOwner");
    if (defaultSummonLimit > maxSummonsPerOwner) throw new RangeError("defaultSummonLimit cannot exceed maxSummonsPerOwner");
    if (!Array.isArray(snapshot.rules.summonLimits)) throw new TypeError("rules.summonLimits must be an array");
    const summonLimitEntries = snapshot.rules.summonLimits.map((entry, index) => {
      requireExactKeys(entry, ["kind", "limit"], `rules.summonLimits[${index}]`);
      const kind = requireNonEmptyString(entry.kind, `rules.summonLimits[${index}].kind`);
      const limit = normalizeLimit(entry.limit, `Summon limit for ${kind}`);
      if (limit > maxSummonsPerOwner) throw new RangeError(`Summon limit for ${kind} cannot exceed maxSummonsPerOwner`);
      return Object.freeze({ kind, limit });
    });
    if (new Set(summonLimitEntries.map(({ kind }) => kind)).size !== summonLimitEntries.length) {
      throw new TypeError("rules.summonLimits kinds must be unique");
    }
    const sortedLimitKinds = summonLimitEntries.map(({ kind }) => kind).sort(compareIds);
    if (summonLimitEntries.some(({ kind }, index) => kind !== sortedLimitKinds[index])) {
      throw new TypeError("rules.summonLimits must use canonical kind order");
    }
    const balance = normalizeBalance(snapshot.rules.balance);

    if (!Array.isArray(snapshot.summons)) throw new TypeError("Snapshot summons must be an array");
    const summons = snapshot.summons.map((summon, index) => normalizeSummon(
      summon,
      `summons[${index}]`,
      { snapshotShape: true },
    ));
    const summonIds = summons.map(({ id }) => id);
    if (new Set(summonIds).size !== summonIds.length) throw new TypeError("Snapshot summon ids must be unique");
    if (summonIds.some((id, index) => id !== [...summonIds].sort(compareIds)[index])) {
      throw new TypeError("Snapshot summons must use canonical id order");
    }
    for (const summon of summons) {
      if (!heroSet.has(summon.ownerId)) throw new TypeError(`Summon ${summon.id} has an unknown owner`);
      if (heroSet.has(summon.id)) throw new TypeError(`Summon id collides with hero id: ${summon.id}`);
    }
    const allUnitIds = new Set([...heroIds, ...summonIds]);
    const expectedPositionIds = new Set([...onFieldHeroIds, ...summonIds]);

    if (!Array.isArray(snapshot.positions) || snapshot.positions.length !== expectedPositionIds.size) {
      throw new TypeError("Snapshot positions must contain every on-field hero and summon exactly once");
    }
    const positions = snapshot.positions.map((entry, index) => {
      requireExactKeys(entry, ["unitId", "q", "r"], `positions[${index}]`);
      const unitId = requireNonEmptyString(entry.unitId, `positions[${index}].unitId`);
      if (!expectedPositionIds.has(unitId)) throw new TypeError(`Position references an unknown or off-field unit ${unitId}`);
      return Object.freeze({ unitId, ...normalizeHex({ q: entry.q, r: entry.r }, `Position for ${unitId}`) });
    });
    const positionIds = positions.map(({ unitId }) => unitId);
    if (new Set(positionIds).size !== positionIds.length) throw new TypeError("Snapshot position unit ids must be unique");
    if (positionIds.some((id) => !expectedPositionIds.has(id))
      || [...expectedPositionIds].some((id) => !positionIds.includes(id))) {
      throw new TypeError("Snapshot positions disagree with hero presence");
    }
    const sortedPositionIds = [...positionIds].sort(compareIds);
    if (positionIds.some((id, index) => id !== sortedPositionIds[index])) {
      throw new TypeError("Snapshot positions must use canonical id order");
    }
    if (new Set(positions.map(positionKey)).size !== positions.length) throw new TypeError("Snapshot unit positions must be unique");
    const positionMap = new Map(positions.map(({ unitId, q, r }) => [unitId, { q, r }]));
    for (const summon of summons) {
      if (positionKey(summon.position) !== positionKey(positionMap.get(summon.id))) {
        throw new TypeError(`Summon ${summon.id} position disagrees with positions registry`);
      }
    }

    if (!Array.isArray(snapshot.loadouts) || snapshot.loadouts.length !== heroIds.length) {
      throw new TypeError("Snapshot loadouts must contain every hero exactly once");
    }
    const loadouts = snapshot.loadouts.map((entry, index) => {
      requireExactKeys(entry, ["heroId", "left", "right"], `loadouts[${index}]`);
      if (entry.heroId !== heroIds[index]) throw new TypeError("Snapshot loadouts must follow heroIds order");
      return Object.freeze({ heroId: entry.heroId, ...normalizeLoadout({ left: entry.left, right: entry.right }, entry.heroId) });
    });

    if (!Array.isArray(snapshot.buffs)) throw new TypeError("Snapshot buffs must be an array");
    const buffs = snapshot.buffs.map((buff, index) => normalizeBuff(buff, allUnitIds, `buffs[${index}]`));
    for (const buff of buffs) {
      if (!expectedPositionIds.has(buff.sourceId)
        || buff.targetIds.some((targetId) => !expectedPositionIds.has(targetId))) {
        throw new TypeError(`Buff ${buff.id} references an off-field unit`);
      }
    }
    const buffIds = buffs.map(({ id }) => id);
    if (new Set(buffIds).size !== buffIds.length) throw new TypeError("Snapshot buff ids must be unique");
    const sortedBuffIds = [...buffIds].sort(compareIds);
    if (buffIds.some((id, index) => id !== sortedBuffIds[index])) {
      throw new TypeError("Snapshot buffs must use canonical id order");
    }
    if (snapshot.phase === BATTLE_PHASE.COMPLETED && buffs.length !== 0) {
      throw new TypeError("Completed battle cannot retain encounter buffs");
    }
    if (snapshot.phase === BATTLE_PHASE.COMPLETED && summons.some((summon) => !summon.persistent)) {
      throw new TypeError("Completed battle cannot retain non-persistent summons");
    }
    const exclusiveBuffGroups = new Set();
    for (const buff of buffs) {
      if (buff.exclusiveGroup === null) continue;
      const key = `${buff.sourceId}\u0000${buff.exclusiveGroup}`;
      if (exclusiveBuffGroups.has(key)) throw new TypeError("Snapshot contains competing buffs in one exclusive group");
      exclusiveBuffGroups.add(key);
    }

    const countByOwner = new Map();
    const countByOwnerKind = new Map();
    const limitMap = new Map(summonLimitEntries.map(({ kind, limit }) => [kind, limit]));
    for (const summon of summons) {
      const ownerCount = (countByOwner.get(summon.ownerId) ?? 0) + 1;
      if (ownerCount > maxSummonsPerOwner) throw new RangeError(`Summon owner ${summon.ownerId} exceeds total summon limit`);
      countByOwner.set(summon.ownerId, ownerCount);
      const group = `${summon.ownerId}\u0000${summon.kind}`;
      const groupCount = (countByOwnerKind.get(group) ?? 0) + 1;
      const groupLimit = limitMap.get(summon.kind) ?? defaultSummonLimit;
      if (groupCount > groupLimit) throw new RangeError(`Summon kind ${summon.kind} exceeds its owner limit`);
      countByOwnerKind.set(group, groupCount);
    }

    let activation = null;
    if (snapshot.activation !== null) {
      requireExactKeys(snapshot.activation, ["reason", "actorId", "skillId", "actionSequence"], "Battle activation");
      if (!ACTIVATION_REASONS.has(snapshot.activation.reason)) throw new RangeError("Unknown battle activation reason");
      const activationSequence = requireSafeInteger(snapshot.activation.actionSequence, "Activation actionSequence", {
        minimum: 1,
        maximum: actionSequence,
      });
      let actorId = null;
      let skillId = null;
      if (snapshot.activation.reason === BATTLE_ACTIVATION_REASON.EXPLICIT_START) {
        if (snapshot.activation.actorId !== null || snapshot.activation.skillId !== null) {
          throw new TypeError("Explicit activation cannot have an actor or skill");
        }
      } else {
        actorId = requireNonEmptyString(snapshot.activation.actorId, "Activation actorId");
        if (snapshot.activation.reason === BATTLE_ACTIVATION_REASON.OFFENSIVE_SKILL) {
          if (!heroSet.has(actorId)) throw new TypeError("Offensive skill activation actor must be a main hero");
          skillId = requireNonEmptyString(snapshot.activation.skillId, "Activation skillId");
          const loadout = loadouts.find((entry) => entry.heroId === actorId);
          if (![loadout.left, ...loadout.right].includes(skillId)) {
            throw new TypeError("Activation skill is absent from the actor loadout");
          }
        } else if (snapshot.activation.skillId !== null) {
          throw new TypeError("Movement activation cannot have a skill id");
        }
      }
      activation = Object.freeze({
        reason: snapshot.activation.reason,
        actorId,
        skillId,
        actionSequence: activationSequence,
      });
    }
    if (snapshot.phase === BATTLE_PHASE.PREPARATION && activation !== null) {
      throw new TypeError("Preparation phase cannot have an activation record");
    }
    if (snapshot.phase !== BATTLE_PHASE.PREPARATION && activation === null) {
      throw new TypeError("Active or completed battle requires an activation record");
    }
    if (snapshot.phase === BATTLE_PHASE.PREPARATION) {
      if (encounterNumber === 1 && heroPresence.some(({ state }) => state !== UNIT_PRESENCE.ON_FIELD)) {
        throw new TypeError("Preparation phase requires every main hero on the field");
      }
      // Later encounters may keep defeated heroes OFF_FIELD. The application
      // validates that an absent hero is actually dead or otherwise unavailable.
      if (!heroPresence.some(({ state }) => state === UNIT_PRESENCE.ON_FIELD)) {
        throw new TypeError("Preparation phase requires at least one hero on the field");
      }
      for (const position of positions) {
        const column = requireSafeInteger(deploymentColumnOf(position), "Preparation position column", {
          minimum: -MAX_COORDINATE,
          maximum: MAX_COORDINATE,
        });
        if (column < deploymentStartColumn || column >= deploymentStartColumn + DEPLOYMENT_COLUMN_COUNT) {
          throw new TypeError("Preparation unit is outside the deployment zone");
        }
      }
    }

    return {
      schemaVersion: BATTLE_PREPARATION_SCHEMA_VERSION,
      phase: snapshot.phase,
      activation,
      encounterNumber,
      actionSequence,
      rules: {
        deploymentStartColumn,
        deploymentColumns: DEPLOYMENT_COLUMN_COUNT,
        maxMainHeroes: MAX_MAIN_HEROES,
        defaultSummonLimit,
        maxSummonsPerOwner,
        summonLimits: summonLimitEntries,
        balance,
      },
      heroIds: [...heroIds],
      heroPresence,
      positions,
      loadouts,
      summons,
      buffs,
    };
  }

  #requireHero(value) {
    const id = requireNonEmptyString(value, "Hero id");
    if (!this.#loadouts.has(id)) throw new Error(`Unknown main hero: ${id}`);
    return id;
  }

  #requireUnit(value) {
    const id = requireNonEmptyString(value, "Unit id");
    if (!this.#loadouts.has(id) && !this.#summons.has(id)) throw new Error(`Unknown preparation unit: ${id}`);
    return id;
  }

  #requireOnFieldUnit(unitId) {
    if (!this.#positions.has(unitId)) throw new Error(`Unit ${unitId} is off field`);
    return unitId;
  }

  #requireEquippedSkill(heroId, skillId) {
    if (UNIVERSAL_EQUIPPED_SKILLS.has(skillId)) return;
    const loadout = this.#loadouts.get(heroId);
    if (loadout.left !== skillId && !loadout.right.includes(skillId)) {
      throw new Error(`Skill ${skillId} is not active in ${heroId}'s loadout`);
    }
  }

  #requireActionablePhase() {
    if (this.#phase === BATTLE_PHASE.COMPLETED) throw new Error("Completed battle accepts no actions");
  }

  #requireActivePhase(message) {
    if (this.#phase !== BATTLE_PHASE.ACTIVE) throw new Error(message);
  }

  #activate(reason, { actorId, skillId }) {
    if (this.#phase !== BATTLE_PHASE.PREPARATION) throw new Error("Battle can only activate from preparation");
    this.#incrementActionSequence();
    this.#phase = BATTLE_PHASE.ACTIVE;
    this.#activation = Object.freeze({
      reason,
      actorId,
      skillId,
      actionSequence: this.#actionSequence,
    });
  }

  #incrementActionSequence() {
    this.#actionSequence = this.#nextSafeCounter(this.#actionSequence, "Action sequence");
  }

  #ensureActionCapacity() {
    if (this.#actionSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("Action sequence is exhausted");
  }

  #nextSafeCounter(current, label) {
    if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError(`${label} is exhausted`);
    return current + 1;
  }

  #positionsHasHex(position) {
    const key = positionKey(position);
    return [...this.#positions.values()].some((other) => positionKey(other) === key);
  }

  #validateNewSummon(summon) {
    if (!this.#heroIds.includes(summon.ownerId)) throw new Error(`Unknown summon owner: ${summon.ownerId}`);
    if (this.#loadouts.has(summon.id) || this.#positions.has(summon.id) || this.#summons.has(summon.id)) {
      throw new Error(`Duplicate unit id: ${summon.id}`);
    }
    const byOwner = [...this.#summons.values()].filter((entry) => entry.ownerId === summon.ownerId);
    if (byOwner.length >= this.#rules.maxSummonsPerOwner) {
      throw new RangeError(`Summon owner ${summon.ownerId} reached the total summon limit`);
    }
    const byKind = byOwner.filter((entry) => entry.kind === summon.kind);
    const limit = this.#rules.summonLimits.get(summon.kind) ?? this.#rules.defaultSummonLimit;
    if (byKind.length >= limit) throw new RangeError(`Summon kind ${summon.kind} reached its owner limit`);
  }

  #assertUniquePositions() {
    const keys = [...this.#positions.values()].map(positionKey);
    if (new Set(keys).size !== keys.length) throw new Error("Preparation unit positions must be unique");
  }

  #assertAllUnitsInDeploymentZone(label) {
    for (const heroId of this.#heroIds) {
      if (this.#heroPresence.get(heroId) !== UNIT_PRESENCE.ON_FIELD || !this.#positions.has(heroId)) {
        throw new Error(`${label} requires every main hero on the field`);
      }
    }
    for (const position of this.#positions.values()) {
      if (!this.isDeploymentHex(position)) throw new Error(`${label} must be inside the three-column deployment zone`);
    }
  }
}
