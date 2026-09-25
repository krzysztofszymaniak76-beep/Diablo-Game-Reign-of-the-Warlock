const MANA_FRACTION = 256;

function requireFiniteMana(value, label) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * MANA_FRACTION)) {
    throw new RangeError(`${label} must be a non-negative value representable in 1/256 mana units`);
  }
  return Math.round(value * MANA_FRACTION) / MANA_FRACTION;
}

function requireSkillLevel(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) {
    throw new RangeError('skillLevel must be a positive safe integer no greater than 999');
  }
  return value;
}

function requireManaDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('mana definition is required');
  const keys = ['useOnDo', 'start', 'minimum', 'shift', 'base', 'perLevel'];
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError('mana definition has an invalid shape');
  }
  if (typeof value.useOnDo !== 'boolean') throw new TypeError('mana.useOnDo must be boolean');
  for (const field of ['start', 'minimum', 'shift', 'base']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new RangeError(`mana.${field} must be a non-negative safe integer`);
  }
  if (value.shift > 31) throw new RangeError('mana.shift is outside the supported range');
  if (!Number.isSafeInteger(value.perLevel)) throw new TypeError('mana.perLevel must be a safe integer');
  return value;
}

function fixedMana(value) {
  // skills.txt mana values are powers-of-two fractions because the game stores
  // mana in 1/256 units. Keep the runtime exact at the same precision.
  return Math.round(value * MANA_FRACTION) / MANA_FRACTION;
}

export function skillManaProfile(sourceSkill, skillLevel = 1) {
  if (!sourceSkill || typeof sourceSkill !== 'object') throw new TypeError('sourceSkill is required');
  const level = requireSkillLevel(skillLevel);
  const mana = requireManaDefinition(sourceSkill.mana);
  const raw = mana.base + mana.perLevel * (level - 1);
  const scaled = fixedMana(Math.max(0, raw) * (2 ** (mana.shift - 8)));
  // A skill whose raw mana expression is zero is genuinely free even when
  // skills.txt carries minmana=1 (e.g. Might). minmana floors a positive
  // computed cost; it does not invent a cost for zero-mana skills.
  const cost = raw <= 0 ? 0 : fixedMana(Math.max(mana.minimum, scaled));
  const startRequirement = fixedMana(Math.max(0, mana.start));
  return Object.freeze({
    skillLevel: level,
    cost,
    startRequirement,
    requiredToCast: Math.max(cost, startRequirement),
    useOnDo: mana.useOnDo,
    source: Object.freeze({
      base: mana.base,
      perLevel: mana.perLevel,
      shift: mana.shift,
      minimum: mana.minimum,
      start: mana.start,
    }),
  });
}

export function canPaySkillMana(currentMana, sourceSkill, skillLevel = 1) {
  const current = requireFiniteMana(currentMana, 'currentMana');
  const profile = skillManaProfile(sourceSkill, skillLevel);
  return Object.freeze({
    ...profile,
    currentMana: current,
    affordable: current >= profile.requiredToCast,
  });
}

export function spendSkillMana(character, sourceSkill, skillLevel = 1) {
  if (!character?.resources) throw new TypeError('character resources are required');
  const check = canPaySkillMana(character.resources.mana, sourceSkill, skillLevel);
  if (!check.affordable) {
    throw new Error(`Za mało many: potrzeba ${formatMana(check.requiredToCast)}, dostępne ${formatMana(check.currentMana)}`);
  }
  character.resources.mana = fixedMana(check.currentMana - check.cost);
  return Object.freeze({ ...check, remainingMana: character.resources.mana });
}

export function formatMana(value) {
  const normalized = requireFiniteMana(value, 'mana');
  return Number.isInteger(normalized)
    ? String(normalized)
    : normalized.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

export const MANA_FIXED_POINT_DENOMINATOR = MANA_FRACTION;
