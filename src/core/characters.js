import { CHARACTER_CLASSES, MAX_SKILL_POINTS } from "./constants.js";
import { classProgressionProfile, initializeCharacterProgression, validateCharacterProgression } from "./progression.js";

function clone(value) {
  return structuredClone(value);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function nonNegativeResource(value, label) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * 256)) {
    throw new RangeError(`${label} must be representable as a non-negative safe integer in 1/256 resource units`);
  }
}

function validateCharacter(character) {
  if (!plainObject(character)) throw new TypeError("Character must be an object");
  if (typeof character.id !== "string" || !character.id.trim()) throw new TypeError("Character id is required");
  if (typeof character.name !== "string" || !character.name.trim()) throw new TypeError("Character name is required");
  if (!CHARACTER_CLASSES.includes(character.classId)) throw new RangeError(`Unknown class: ${character.classId}`);
  if (typeof character.hardcore !== "boolean") throw new TypeError("Character hardcore flag must be a boolean");
  if (!["alive", "corpse", "dead"].includes(character.lifeState)) throw new RangeError("Invalid character lifeState");
  if (!Number.isSafeInteger(character.level) || character.level < 1) throw new RangeError("Character level must be a positive safe integer");
  for (const field of ["experience", "unspentSkillPoints", "unspentStatPoints"]) {
    nonNegativeInteger(character[field], `Character ${field}`);
  }
  if (!plainObject(character.stats)) throw new TypeError("Character stats are required");
  for (const field of ["strength", "dexterity", "vitality", "energy"]) {
    nonNegativeInteger(character.stats[field], `Character stat ${field}`);
  }
  if (!plainObject(character.resources)) throw new TypeError("Character resources are required");
  for (const field of ["hp", "maxHp", "mana", "maxMana"]) {
    nonNegativeResource(character.resources[field], `Character resource ${field}`);
  }
  if (character.resources.maxHp < 1 || character.resources.hp > character.resources.maxHp
    || character.resources.mana > character.resources.maxMana) {
    throw new RangeError("Character resources are outside their maxima");
  }
  if ((character.lifeState === "alive") !== (character.resources.hp > 0)) {
    throw new Error("Character lifeState disagrees with hit points");
  }
  for (const field of ["skills", "cooldowns", "equipment", "questRewards"]) {
    if (!plainObject(character[field])) throw new TypeError(`Character ${field} must be an object`);
  }
  for (const field of ["inventoryItemIds", "activeEffects"]) {
    if (!Array.isArray(character[field])) throw new TypeError(`Character ${field} must be an array`);
  }
  if (character.mercenaryContractId !== null
    && (typeof character.mercenaryContractId !== "string" || !character.mercenaryContractId)) {
    throw new TypeError("Character mercenaryContractId must be null or a non-empty string");
  }
  validateCharacterProgression(character);
  return character;
}

export function createCharacter({ id = globalThis.crypto.randomUUID(), name, classId, hardcore = false } = {}) {
  if (!CHARACTER_CLASSES.includes(classId)) throw new RangeError(`Unknown class: ${classId}`);
  if (typeof id !== "string" || !id.trim()) throw new TypeError("Character id is required");
  if (typeof name !== "string" || !name.trim()) throw new TypeError("Character name is required");
  if (typeof hardcore !== "boolean") throw new TypeError("Character hardcore flag must be a boolean");
  const profile = classProgressionProfile(classId);
  const character = {
    id: id.trim(),
    name: name.trim(),
    classId,
    hardcore,
    lifeState: "alive",
    level: 1,
    experience: 0,
    unspentSkillPoints: 0,
    unspentStatPoints: 0,
    stats: clone(profile.stats),
    resources: { hp: profile.baseHp, maxHp: profile.baseHp, mana: profile.baseMana, maxMana: profile.baseMana },
    skills: {},
    cooldowns: {},
    equipment: {},
    inventoryItemIds: [],
    questRewards: {},
    activeEffects: [],
    mercenaryContractId: null,
  };
  initializeCharacterProgression(character);
  return character;
}

export function setSkillPoints(character, skillId, hardPoints, softPoints = 0) {
  if (!Number.isInteger(hardPoints) || hardPoints < 0 || hardPoints > MAX_SKILL_POINTS) {
    throw new RangeError(`Hard points must be 0-${MAX_SKILL_POINTS}`);
  }
  if (!Number.isInteger(softPoints) || softPoints < 0) throw new RangeError("Soft points must be non-negative");
  character.skills[skillId] = { hardPoints, softPoints, effectiveLevel: hardPoints + softPoints };
}

export class Roster {
  constructor(characters = []) {
    this.characters = new Map();
    for (const character of characters) this.add(character);
  }

  add(character) {
    validateCharacter(character);
    if (this.characters.has(character.id)) throw new Error(`Duplicate character id: ${character.id}`);
    const imported = clone(character);
    initializeCharacterProgression(imported);
    validateCharacter(imported);
    this.characters.set(character.id, imported);
    return this.get(character.id);
  }

  create(input) {
    return this.add(createCharacter(input));
  }

  get(id) {
    const character = this.characters.get(id);
    if (!character) throw new Error(`Unknown character: ${id}`);
    return character;
  }

  has(id) {
    return this.characters.has(id);
  }

  markDead(id) {
    const character = this.get(id);
    character.lifeState = "dead";
    character.resources.hp = 0;
  }

  toJSON() {
    return [...this.characters.values()].map(clone);
  }
}
