// This module reads the installed-build audit. Unsupported formulae/effects
// are errors, never invented values or a generic attack bearing a skill name.
export function sourceSkillLevel(character, source) {
  const state = character.skills?.[source.id];
  return Math.max(0, (state?.hardPoints ?? 0) + (state?.softPoints ?? 0));
}

export function learnedSourceSkill(character, source, catalog) {
  const hardPoints = character.skills?.[source.id]?.hardPoints ?? 0;
  // Native skills only. A saved softPoints value is not proof of an equipped
  // oskill/charge/staffmod and must never unlock a tree skill by itself.
  if (!source.id.startsWith(`${character.classId}.`) || !Number.isSafeInteger(hardPoints)
    || hardPoints < 1 || hardPoints > source.maximumBaseLevel
    || character.level < source.requirements.characterLevel + hardPoints - 1) return false;
  if (catalog && !source.requirements.prerequisiteSkills.every(name =>
    learnedSourceSkill(character, catalog.skill(character.classId, name), catalog))) return false;
  return true;
}

// One current source of truth for popup contents and assignable runtime skills.
// Never writes ranks and never invents item-granted sources.
export function nativeSkillSources(character, catalog) {
  return catalog.skillsForClass(character.classId)
    .filter(source => !source.mechanicFlags.passive && learnedSourceSkill(character, source, catalog))
    .map(source => ({skillId:source.id, sourceType:'NATIVE_SKILL', sourceClassId:character.classId, source}));
}

// Milestones used by skills.txt EMin/EMaxLev1..5: 2..8, 9..16,
// 17..22, 23..28, 29+. Retain fractions until the combat integer boundary.
export function tieredSkillValue(raw, prefix, level) {
  if (!Number.isInteger(level) || level < 1) throw new Error('Nieprawidłowa ranga');
  const base = Number(raw[prefix]);
  const steps = [7, 8, 6, 6, Infinity];
  let value = base, remaining = level - 1;
  if (!Number.isFinite(base)) throw new Error('Brak wartości źródłowej');
  for (let tier = 0; tier < steps.length && remaining > 0; tier += 1) {
    const increase = Number(raw[`${prefix}Lev${tier + 1}`]);
    if (!Number.isFinite(increase)) throw new Error('Brak przyrostu źródłowego');
    const count = Math.min(steps[tier], remaining);
    value += count * increase; remaining -= count;
  }
  return value;
}

export function fireBoltValues(character, catalog) {
  const source = catalog.skill('sorceress', 'Fire Bolt');
  if (!learnedSourceSkill(character, source)) throw new Error('Ognisty Piorun nie jest wyuczony');
  const raw = source.scalingRaw;
  if (raw.EDmgSymPerCalc !== "(skill('Fire Ball'.blvl)+skill('Meteor'.blvl))*par8" || raw.EType !== 'fire') {
    throw new Error('Nieobsługiwany wariant formuły Ognistego Pioruna');
  }
  const level = sourceSkillLevel(character, source);
  const synergy = ['Fire Ball', 'Meteor'].reduce((sum, name) =>
    sum + (character.skills?.[catalog.skill('sorceress', name).id]?.hardPoints ?? 0), 0) * Number(raw.Param8);
  // Fire Mastery is a passive damage bonus, NOT a hard-point synergy.
  const mastery = catalog.skill('sorceress', 'Fire Mastery');
  const masteryLevel = sourceSkillLevel(character, mastery);
  if (mastery.scalingRaw.passivecalc1 !== 'ln12' || mastery.scalingRaw.passivestat1 !== 'passive_fire_mastery') {
    throw new Error('Nieobsługiwany wariant Mistrzostwa Ognia');
  }
  const masteryPercent = masteryLevel > 0 ? Number(mastery.scalingRaw.Param1) + (masteryLevel - 1) * Number(mastery.scalingRaw.Param2) : 0;
  const hitShift = Number(raw.HitShift);
  if (!Number.isInteger(hitShift) || hitShift < 0 || hitShift > 8) throw new Error('Brak poprawnego HitShift');
  return { level, synergyPercent: synergy, masteryPercent, damageType: 'fire', damage: ['EMin', 'EMax']
    .map(prefix => Math.floor(tieredSkillValue(raw, prefix, level) * 2 ** (hitShift - 8) * (100 + synergy) / 100 * (100 + masteryPercent) / 100)) };
}

export function runtimeSkillStatus(id) {
  if (id === 'basic.attack') return { supported: true, label: 'Atak założoną bronią' };
  if (id === 'barbarian.bash') return { supported: true,
    label: 'Odrzucenie: krótki miecz, źródłowe premie i mana. Odrzut o 1 wolny heks — adaptacja turowa. Inne bronie jeszcze nieobsługiwane.' };
  if (id === 'necromancer.raise_skeleton') return { supported: true,
    label: 'Przywołanie ze zwłok i AI działają; statystyki źródłowe częściowe, ograniczenia opisane w danych przywołania.' };
  if (id === 'sorceress.fire_bolt') return { supported: true,
    label: 'Źródłowe obrażenia, mana i synergie; zasięg i czas adaptowane do heksów. Odporności niewdrożone.' };
  return { supported: false, label: 'Nieukończone: efekt bojowy nie został odwzorowany. Brak zastępczego ataku.' };
}

export function bashValues(character, catalog) {
  const source = catalog.skill('barbarian', 'Bash');
  if (!learnedSourceSkill(character, source, catalog)) throw new Error('Odrzucenie nie jest wyuczone');
  const raw = source.scalingRaw;
  const accuracy = source.crossSkillDependenciesIncoming.find(e => e.field === 'ToHitCalc');
  if (raw.calc1 !== "ln12+skill('Stun'.blvl)*par8" || raw.calc2 !== 'ln34'
    || accuracy?.formula !== "15+lvl*5+skill('Concentrate'.blvl)*par7") throw new Error('Nieobsługiwany ruleset Odrzucenia');
  const level = sourceSkillLevel(character, source);
  const hard = name => character.skills?.[catalog.skill('barbarian', name).id]?.hardPoints ?? 0;
  const damageSynergy = hard('Stun') * Number(raw.Param8);
  const ratingSynergy = hard('Concentrate') * Number(raw.Param7);
  return {level, damageSynergy, ratingSynergy,
    damagePercent: Number(raw.Param1) + (level - 1) * Number(raw.Param2) + damageSynergy,
    flatDamage: Number(raw.Param3) + (level - 1) * Number(raw.Param4),
    ratingPercent: 15 + level * 5 + ratingSynergy};
}
