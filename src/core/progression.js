import { PROGRESSION_DATA } from '../../data/progression.v057.js';

export const PROGRESSION_SCHEMA_VERSION = 1;
export const CHARACTER_ATTRIBUTES = Object.freeze(['strength', 'dexterity', 'vitality', 'energy']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`Nieprawidłowe ${label}`);
};
function resource(value, label) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * 256)) throw new RangeError(`Nieprawidłowe ${label}`);
}

export function classProgressionProfile(classId) {
  const profile = PROGRESSION_DATA.classes[classId];
  if (!profile || !Object.hasOwn(PROGRESSION_DATA.classes, classId)) throw new RangeError(`Nieznana klasa rozwoju: ${classId}`);
  return profile;
}

export function levelForExperience(classId, experience) {
  integer(experience, 'EXP');
  const profile = classProgressionProfile(classId);
  let level = 1;
  while (level < profile.maxLevel && experience >= profile.thresholds[level]) level += 1;
  return level;
}

export function validateCharacterProgression(character) {
  const profile = classProgressionProfile(character.classId);
  integer(character.level, 'poziom', 1);
  if (character.level > profile.maxLevel) throw new RangeError('Poziom przekracza maksimum źródłowe');
  for (const key of ['experience', 'unspentStatPoints', 'unspentSkillPoints']) integer(character[key], key);
  if (!plain(character.stats) || !plain(character.resources)) throw new TypeError('Brak atrybutów lub zasobów bohatera');
  for (const key of CHARACTER_ATTRIBUTES) integer(character.stats[key], key);
  for (const key of ['hp', 'maxHp', 'mana', 'maxMana']) resource(character.resources[key], key);
  if (character.resources.hp > character.resources.maxHp || character.resources.mana > character.resources.maxMana) throw new RangeError('Zasób przekracza maksimum');
  if (character.progression !== undefined) {
    const p = character.progression;
    if (!plain(p) || p.schemaVersion !== PROGRESSION_SCHEMA_VERSION || p.catalogId !== PROGRESSION_DATA.catalogId) throw new Error('Nieobsługiwana wersja rozwoju bohatera');
    integer(p.awardedThroughLevel, 'poziom rozliczonych awansów', 1);
    if (p.awardedThroughLevel > character.level) throw new Error('Poziom rozliczonych awansów wyprzedza bohatera');
    if (!plain(p.allocatedStatPoints)) throw new Error('Brak zapisu rozdanych punktów');
    for (const key of CHARACTER_ATTRIBUTES) integer(p.allocatedStatPoints[key], `rozdane ${key}`);
  }
  return profile;
}

function initializeStaged(character) {
  const profile = validateCharacterProgression(character);
  if (!character.progression) {
    character.progression = {
      schemaVersion: PROGRESSION_SCHEMA_VERSION,
      catalogId: PROGRESSION_DATA.catalogId,
      // Earlier levels are accepted as already accounted for. Only XP beyond that level awards new points.
      awardedThroughLevel: character.level,
      allocatedStatPoints: Object.fromEntries(CHARACTER_ATTRIBUTES.map(key => [key, 0])),
    };
    if (CHARACTER_ATTRIBUTES.every(key => character.stats[key] === 0)) {
      character.stats = structuredClone(profile.stats);
      character.attributeSource = { catalogId: PROGRESSION_DATA.catalogId, table: 'charstats.txt', classId: character.classId };
    }
  }
  return profile;
}

/** One resolver for resource growth; rendering/save/load never invoke a refill. */
export function progressionResourceMaxima(character, { levelsGained = 0, attribute = null, points = 0 } = {}) {
  const profile = validateCharacterProgression(character);
  integer(levelsGained, 'liczba awansów'); integer(points, 'punkty');
  if (attribute !== null && !CHARACTER_ATTRIBUTES.includes(attribute)) throw new RangeError('Nieznany atrybut');
  const maxHp = character.resources.maxHp + levelsGained * profile.lifePerLevel
    + (attribute === 'vitality' ? points * profile.lifePerVitality : 0);
  const maxMana = character.resources.maxMana + levelsGained * profile.manaPerLevel
    + (attribute === 'energy' ? points * profile.manaPerEnergy : 0);
  resource(maxHp, 'maksymalne HP'); resource(maxMana, 'maksymalna mana');
  return { maxHp, maxMana };
}

function reconcileStaged(character) {
  const profile = initializeStaged(character);
  const fromLevel = character.level;
  // Existing levels are retained if legacy XP is below the corresponding threshold.
  const toLevel = Math.max(fromLevel, levelForExperience(character.classId, character.experience));
  const levelsGained = toLevel - fromLevel;
  const statPointsGained = levelsGained * profile.statPointsPerLevel;
  const skillPointsGained = levelsGained * profile.skillPointsPerLevel;
  const nextStats = character.unspentStatPoints + statPointsGained;
  const nextSkills = character.unspentSkillPoints + skillPointsGained;
  integer(nextStats, 'punkty statystyk'); integer(nextSkills, 'punkty umiejętności');
  const maxima = progressionResourceMaxima(character, { levelsGained });
  character.level = toLevel;
  character.unspentStatPoints = nextStats;
  character.unspentSkillPoints = nextSkills;
  Object.assign(character.resources, maxima);
  character.progression.awardedThroughLevel = toLevel;
  return { fromLevel, toLevel, levelsGained, statPointsGained, skillPointsGained };
}

function publish(character, staged) {
  for (const key of ['level', 'experience', 'unspentStatPoints', 'unspentSkillPoints', 'stats', 'resources', 'progression']) character[key] = staged[key];
  if (staged.attributeSource) character.attributeSource = staged.attributeSource;
}

export function reconcileCharacterProgression(character) {
  const staged = structuredClone(character);
  const result = reconcileStaged(staged);
  publish(character, staged);
  return result;
}

export function initializeCharacterProgression(character) {
  return reconcileCharacterProgression(character);
}

export function addCharacterExperience(character, amount) {
  integer(amount, 'nagroda EXP');
  const staged = structuredClone(character);
  validateCharacterProgression(staged);
  integer(staged.experience + amount, 'suma EXP');
  staged.experience += amount;
  const result = reconcileStaged(staged);
  publish(character, staged);
  return { amount, ...result };
}

export function spendCharacterStatPoints(character, attribute, amount = 1) {
  if (!CHARACTER_ATTRIBUTES.includes(attribute)) throw new RangeError('Nieznany atrybut');
  integer(amount, 'liczba wydawanych punktów', 1);
  const staged = structuredClone(character);
  initializeStaged(staged);
  if (staged.unspentStatPoints < amount) throw new Error('Brak wolnych punktów statystyk');
  integer(staged.stats[attribute] + amount, attribute);
  integer(staged.progression.allocatedStatPoints[attribute] + amount, 'rozdane punkty');
  const maxima = progressionResourceMaxima(staged, { attribute, points: amount });
  staged.stats[attribute] += amount;
  staged.unspentStatPoints -= amount;
  staged.progression.allocatedStatPoints[attribute] += amount;
  Object.assign(staged.resources, maxima);
  publish(character, staged);
  return { characterId: character.id, attribute, amount, value: character.stats[attribute], ...maxima };
}

/** Read-only: opening the character panel cannot award points or restore resources. */
export function characterProgressionView(character) {
  const profile = validateCharacterProgression(character);
  const isMaxLevel = character.level === profile.maxLevel;
  const levelStartExperience = profile.thresholds[character.level - 1];
  const nextLevelExperience = isMaxLevel ? null : profile.thresholds[character.level];
  const experienceIntoLevel = Math.max(0, character.experience - levelStartExperience);
  const experienceForLevel = isMaxLevel ? null : nextLevelExperience - levelStartExperience;
  const fraction = isMaxLevel ? 1 : Math.min(1, experienceIntoLevel / experienceForLevel);
  return {
    level: character.level, experience: character.experience, maxLevel: profile.maxLevel, isMaxLevel,
    levelStartExperience, nextLevelExperience, experienceIntoLevel, experienceForLevel,
    fraction, progress: fraction * 100,
    unspentStatPoints: character.unspentStatPoints, unspentSkillPoints: character.unspentSkillPoints,
  };
}

/** Derive the ten visible HUD cells from the same earned EXP and level threshold.
 * This is a read-only view; neither progress nor segment fills are saved.
 */
export function characterExperienceSegments(character) {
  const view = characterProgressionView(character);
  const currentExp = view.experienceIntoLevel;
  const expRequiredForNextLevel = view.experienceForLevel;
  const progress = view.isMaxLevel ? 1 : Math.min(1, currentExp / expRequiredForNextLevel);
  const segments = Array.from({ length: 10 }, (_, index) =>
    Math.round(Math.max(0, Math.min(1, progress * 10 - index)) * 1e6) / 1e6);
  return {
    currentExp,
    expRequiredForNextLevel,
    percent: progress * 100,
    segments,
    filledSegments: segments.filter((fill) => fill === 1).length,
    isMaxLevel: view.isMaxLevel,
  };
}
