export const MOUSE_SKILL_SCHEMA_VERSION = 1;

const SIDES = new Set(['left', 'right']);
const TARGET_MODES = Object.freeze({
  PASSIVE: 'passive',
  AURA: 'aura',
  CORPSE: 'corpse',
  ALLY: 'ally',
  PET: 'pet',
  ITEM: 'item',
  WORLD: 'world',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function frozenClone(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(clone);
}

function normalizeSkillDefinition(value, key) {
  exactKeys(value, [
    'runtimeId', 'sourceName', 'sourceId', 'classCode', 'mouse', 'targeting', 'aura', 'passive',
    'rangeToken', 'weaponSelection', 'requiredLevel', 'mana', 'source',
  ], `Skill metadata ${key}`);
  if (value.runtimeId !== key) throw new TypeError(`Skill metadata key mismatch for ${key}`);
  exactKeys(value.mouse, ['left', 'right'], `Skill metadata ${key}.mouse`);
  exactKeys(value.targeting, ['corpse', 'pet', 'ally', 'item'], `Skill metadata ${key}.targeting`);
  const mouse = Object.freeze({
    left: requireBoolean(value.mouse.left, `${key}.mouse.left`),
    right: requireBoolean(value.mouse.right, `${key}.mouse.right`),
  });
  if (!mouse.left && !mouse.right && value.passive !== true) {
    throw new TypeError(`Active skill ${key} cannot be unavailable from both mouse buttons`);
  }
  const targeting = Object.freeze(Object.fromEntries(Object.entries(value.targeting).map(([name, enabled]) => [
    name,
    requireBoolean(enabled, `${key}.targeting.${name}`),
  ])));
  if (Object.values(targeting).filter(Boolean).length > 1) {
    throw new TypeError(`Skill ${key} declares mutually ambiguous target flags`);
  }
  if (!Number.isSafeInteger(value.sourceId) || value.sourceId < 0) throw new TypeError(`${key}.sourceId must be a non-negative safe integer`);
  if (!Number.isSafeInteger(value.requiredLevel) || value.requiredLevel < 1) throw new TypeError(`${key}.requiredLevel must be a positive safe integer`);
  if (value.weaponSelection !== null && (!Number.isSafeInteger(value.weaponSelection) || value.weaponSelection < 0)) {
    throw new TypeError(`${key}.weaponSelection must be null or a non-negative safe integer`);
  }
  if (value.rangeToken !== null && typeof value.rangeToken !== 'string') throw new TypeError(`${key}.rangeToken must be null or string`);
  exactKeys(value.mana, ['useOnDo', 'start', 'minimum', 'shift', 'base', 'perLevel'], `Skill metadata ${key}.mana`);
  requireBoolean(value.mana.useOnDo, `${key}.mana.useOnDo`);
  for (const [field, minimum] of [['start', 0], ['minimum', 0], ['shift', 0], ['base', 0]]) {
    if (!Number.isSafeInteger(value.mana[field]) || value.mana[field] < minimum) {
      throw new TypeError(`${key}.mana.${field} must be a non-negative safe integer`);
    }
  }
  if (value.mana.shift > 31) throw new RangeError(`${key}.mana.shift is outside the supported range`);
  if (!Number.isSafeInteger(value.mana.perLevel)) throw new TypeError(`${key}.mana.perLevel must be a safe integer`);
  if (value.classCode !== null) nonEmptyString(value.classCode, `${key}.classCode`);
  nonEmptyString(value.sourceName, `${key}.sourceName`);
  requireBoolean(value.aura, `${key}.aura`);
  requireBoolean(value.passive, `${key}.passive`);
  if (value.passive && (mouse.left || mouse.right)) throw new TypeError(`Passive skill ${key} cannot be mouse-assignable`);
  exactKeys(value.source, ['snapshotId', 'table', 'line'], `${key}.source`);
  nonEmptyString(value.source.snapshotId, `${key}.source.snapshotId`);
  nonEmptyString(value.source.table, `${key}.source.table`);
  if (!Number.isSafeInteger(value.source.line) || value.source.line < 2) throw new TypeError(`${key}.source.line must be a source row`);
  return Object.freeze({
    ...frozenClone(value),
    mouse,
    targeting,
  });
}

export class MouseSkillCatalog {
  #id;
  #skills;

  constructor(payload) {
    exactKeys(payload, [
      'schemaVersion', 'catalogId', 'sourceSnapshotId', 'sourceTable', 'sourceSha256', 'status', 'skills',
    ], 'Mouse-skill catalog');
    if (payload.schemaVersion !== MOUSE_SKILL_SCHEMA_VERSION) throw new Error('Unsupported mouse-skill catalog schema');
    this.#id = nonEmptyString(payload.catalogId, 'catalogId');
    nonEmptyString(payload.sourceSnapshotId, 'sourceSnapshotId');
    nonEmptyString(payload.sourceTable, 'sourceTable');
    if (typeof payload.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.sourceSha256)) {
      throw new TypeError('sourceSha256 must be a SHA-256 hex digest');
    }
    nonEmptyString(payload.status, 'status');
    if (!isRecord(payload.skills) || Object.keys(payload.skills).length < 1) throw new TypeError('skills must be a non-empty object');
    this.#skills = new Map(Object.entries(payload.skills).map(([id, definition]) => [
      nonEmptyString(id, 'Skill id'),
      normalizeSkillDefinition(definition, id),
    ]));
  }

  get id() {
    return this.#id;
  }

  has(skillId) {
    return this.#skills.has(skillId);
  }

  get(skillId) {
    const id = nonEmptyString(skillId, 'Skill id');
    const skill = this.#skills.get(id);
    if (!skill) throw new Error(`Unknown mouse skill: ${id}`);
    return frozenClone(skill);
  }

  allows(skillId, side) {
    if (!SIDES.has(side)) throw new RangeError('Mouse side must be left or right');
    const skill = this.get(skillId);
    return skill.passive !== true && skill.mouse[side] === true;
  }

  targetMode(skillId) {
    const skill = this.get(skillId);
    if (skill.passive) return TARGET_MODES.PASSIVE;
    if (skill.aura) return TARGET_MODES.AURA;
    if (skill.targeting.corpse) return TARGET_MODES.CORPSE;
    if (skill.targeting.ally) return TARGET_MODES.ALLY;
    if (skill.targeting.pet) return TARGET_MODES.PET;
    if (skill.targeting.item) return TARGET_MODES.ITEM;
    return TARGET_MODES.WORLD;
  }

  list(skillIds, side) {
    if (!SIDES.has(side)) throw new RangeError('Mouse side must be left or right');
    if (!Array.isArray(skillIds)) throw new TypeError('skillIds must be an array');
    const seen = new Set();
    const result = [];
    for (const rawId of skillIds) {
      const id = nonEmptyString(rawId, 'Known skill id');
      if (seen.has(id)) continue;
      seen.add(id);
      if (!this.has(id)) continue;
      if (this.allows(id, side)) result.push(id);
    }
    return Object.freeze(result);
  }
}

function normalizeHeroIds(heroIds) {
  if (!Array.isArray(heroIds) || heroIds.length < 1) throw new TypeError('heroIds must be a non-empty array');
  const ids = heroIds.map((id, index) => nonEmptyString(id, `heroIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError('heroIds must be unique');
  return Object.freeze(ids);
}

function knownSkillsFor(knownSkillsByHero, heroId) {
  const raw = knownSkillsByHero instanceof Map ? knownSkillsByHero.get(heroId) : knownSkillsByHero?.[heroId];
  if (!Array.isArray(raw) || raw.length < 1) throw new TypeError(`Known skills missing for ${heroId}`);
  const skills = raw.map((id, index) => nonEmptyString(id, `Known skill ${index} for ${heroId}`));
  if (new Set(skills).size !== skills.length) throw new TypeError(`Known skills for ${heroId} must be unique`);
  return Object.freeze(skills);
}

function bindingValue(initialBindings, heroId) {
  return initialBindings instanceof Map ? initialBindings.get(heroId) : initialBindings?.[heroId];
}

function normalizeBinding(binding, heroId, known, catalog) {
  exactKeys(binding, ['left', 'right'], `Mouse binding for ${heroId}`);
  const left = nonEmptyString(binding.left, `Left mouse skill for ${heroId}`);
  const right = nonEmptyString(binding.right, `Right mouse skill for ${heroId}`);
  const knownSet = new Set(known);
  for (const [side, skillId] of [['left', left], ['right', right]]) {
    if (!knownSet.has(skillId)) throw new Error(`${heroId} cannot bind unknown/unlearned skill ${skillId}`);
    if (!catalog.allows(skillId, side)) throw new Error(`${skillId} is not legal on ${side} mouse button`);
  }
  return Object.freeze({ left, right });
}

export class MouseSkillBindings {
  #heroIds;
  #known;
  #catalog;
  #bindings;

  constructor({ heroIds, knownSkillsByHero, initialBindings, catalog } = {}) {
    if (!(catalog instanceof MouseSkillCatalog)) throw new TypeError('catalog must be MouseSkillCatalog');
    this.#catalog = catalog;
    this.#heroIds = normalizeHeroIds(heroIds);
    this.#known = new Map(this.#heroIds.map((heroId) => [heroId, knownSkillsFor(knownSkillsByHero, heroId)]));
    this.#bindings = new Map(this.#heroIds.map((heroId) => [
      heroId,
      normalizeBinding(bindingValue(initialBindings, heroId), heroId, this.#known.get(heroId), catalog),
    ]));
  }

  get(heroId) {
    const id = nonEmptyString(heroId, 'Hero id');
    const binding = this.#bindings.get(id);
    if (!binding) throw new Error(`Unknown hero mouse binding: ${id}`);
    return frozenClone(binding);
  }

  knownSkills(heroId) {
    const id = nonEmptyString(heroId, 'Hero id');
    const known = this.#known.get(id);
    if (!known) throw new Error(`Unknown hero mouse binding: ${id}`);
    return Object.freeze([...known]);
  }

  assign(heroId, side, skillId) {
    const id = nonEmptyString(heroId, 'Hero id');
    if (!SIDES.has(side)) throw new RangeError('Mouse side must be left or right');
    const current = this.#bindings.get(id);
    if (!current) throw new Error(`Unknown hero mouse binding: ${id}`);
    const skill = nonEmptyString(skillId, 'Skill id');
    if (!this.#known.get(id).includes(skill)) throw new Error(`${id} does not know ${skill}`);
    if (!this.#catalog.allows(skill, side)) throw new Error(`${skill} is not legal on ${side} mouse button`);
    if (current[side] === skill) {
      return frozenClone({ changed: false, actionCost: 0, binding: current });
    }
    const next = Object.freeze({ ...current, [side]: skill });
    this.#bindings.set(id, next);
    return frozenClone({ changed: true, actionCost: 0, binding: next });
  }

  available(heroId, side) {
    const id = nonEmptyString(heroId, 'Hero id');
    const known = this.#known.get(id);
    if (!known) throw new Error(`Unknown hero mouse binding: ${id}`);
    return this.#catalog.list(known, side);
  }

  refreshKnown(heroId, skillIds) {
    const id = nonEmptyString(heroId, 'Hero id');
    const previous = this.#bindings.get(id);
    if (!previous) throw new Error(`Unknown hero mouse binding: ${id}`);
    const known = knownSkillsFor({[id]:skillIds}, id);
    const next = {...previous};
    for (const side of ['left','right']) {
      const legal = this.#catalog.list(known, side);
      if (!legal.includes(next[side])) {
        if (!legal.includes('basic.attack')) throw new Error('Brak bezpiecznej akcji Attack');
        next[side] = 'basic.attack';
      }
    }
    this.#known.set(id, known);
    this.#bindings.set(id, Object.freeze(next));
    return previous.left !== next.left || previous.right !== next.right;
  }

  snapshot() {
    return frozenClone({
      schemaVersion: MOUSE_SKILL_SCHEMA_VERSION,
      catalogId: this.#catalog.id,
      bindings: this.#heroIds.map((heroId) => ({ heroId, ...this.#bindings.get(heroId) })),
    });
  }

  static restore(snapshot, { heroIds, knownSkillsByHero, catalog } = {}) {
    exactKeys(snapshot, ['schemaVersion', 'catalogId', 'bindings'], 'Mouse binding snapshot');
    if (snapshot.schemaVersion !== MOUSE_SKILL_SCHEMA_VERSION) throw new Error('Unsupported mouse binding snapshot schema');
    if (!(catalog instanceof MouseSkillCatalog)) throw new TypeError('catalog must be MouseSkillCatalog');
    if (snapshot.catalogId !== catalog.id) throw new Error('Mouse binding snapshot uses another catalog');
    const ids = normalizeHeroIds(heroIds);
    if (!Array.isArray(snapshot.bindings) || snapshot.bindings.length !== ids.length) {
      throw new TypeError('Mouse binding snapshot has wrong hero count');
    }
    const byHero = new Map();
    for (const entry of snapshot.bindings) {
      exactKeys(entry, ['heroId', 'left', 'right'], 'Mouse binding snapshot entry');
      const heroId = nonEmptyString(entry.heroId, 'Mouse binding heroId');
      if (byHero.has(heroId)) throw new Error(`Duplicate mouse binding hero: ${heroId}`);
      byHero.set(heroId, { left: entry.left, right: entry.right });
    }
    if (ids.some((heroId) => !byHero.has(heroId)) || [...byHero.keys()].some((heroId) => !ids.includes(heroId))) {
      throw new Error('Mouse binding snapshot hero set mismatch');
    }
    return new MouseSkillBindings({ heroIds: ids, knownSkillsByHero, initialBindings: byHero, catalog });
  }
}

export function defaultMouseBindingsFromLoadouts(heroIds, loadoutForHero, catalog) {
  if (!(catalog instanceof MouseSkillCatalog)) throw new TypeError('catalog must be MouseSkillCatalog');
  if (typeof loadoutForHero !== 'function') throw new TypeError('loadoutForHero must be a function');
  const ids = normalizeHeroIds(heroIds);
  return Object.freeze(Object.fromEntries(ids.map((heroId) => {
    const loadout = loadoutForHero(heroId);
    if (!isRecord(loadout) || typeof loadout.left !== 'string' || !Array.isArray(loadout.right)) {
      throw new TypeError(`Invalid loadout for ${heroId}`);
    }
    const known = [loadout.left, ...loadout.right].filter((skillId, index, all) => all.indexOf(skillId) === index);
    const leftCandidates = [loadout.left, ...loadout.right];
    const rightCandidates = [...loadout.right, loadout.left];
    const left = leftCandidates.find((skillId) => catalog.has(skillId) && catalog.allows(skillId, 'left'));
    const right = rightCandidates.find((skillId) => catalog.has(skillId) && catalog.allows(skillId, 'right'));
    if (!left || !right) throw new Error(`Loadout for ${heroId} has no legal left/right mouse defaults`);
    return [heroId, Object.freeze({ left, right })];
  })));
}

export const MouseSkillTargetMode = TARGET_MODES;
