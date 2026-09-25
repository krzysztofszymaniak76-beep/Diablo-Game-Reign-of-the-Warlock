import snapshot from '../../data/necroskeleton-source.v056.js';

export const SOURCE_DATA_NOT_FOUND = 'SOURCE_DATA_NOT_FOUND';
export const FORMULA_NOT_CONFIRMED = 'FORMULA_NOT_CONFIRMED';
export const NECROSKELETON_RESOLVER_ID = 'necroskeleton-source-v0.5.6';
function level(value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 999) throw new RangeError('Invalid summon skill level');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
freeze(snapshot);
function normalizedInputs({ skillLevel = 1, masteryLevel = 0, difficulty = 'normal' } = {}) {
  const normalized = { skillLevel: level(skillLevel,1), masteryLevel: level(masteryLevel,0), difficulty };
  if (!Object.hasOwn({ normal:1, nightmare:1, hell:1 }, difficulty)) throw new Error('Unknown summon difficulty');
  return normalized;
}
export function createNecroskeletonStatInputs(value = {}) {
  const { skillLevel, masteryLevel, difficulty } = normalizedInputs(value);
  return freeze({
    schemaVersion: 1,
    resolverId: NECROSKELETON_RESOLVER_ID,
    sourceSnapshotId: snapshot.records.skill.source.snapshotId,
    sourceSkillSha256: snapshot.records.skill.source.sha256,
    sourceMonsterSha256: snapshot.records.monster.source.sha256,
    skillLevel,
    masteryLevel,
    difficulty,
  });
}
export function resolveNecroskeletonStatInputs(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('Unsupported necroskeleton stat-input schema');
  const expected = createNecroskeletonStatInputs(value);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('Necroskeleton stat-input provenance mismatch');
  return necroskeletonStats(expected);
}
export function statInputsFromSkeletonSourceData(value) {
  const resolved = validateSkeletonSourceData(value);
  return createNecroskeletonStatInputs(resolved);
}
export function summonStatsForUnit(unit) {
  if (unit?.statInputs) return resolveNecroskeletonStatInputs(unit.statInputs);
  if (unit?.sourceData) return validateSkeletonSourceData(unit.sourceData);
  return null;
}
export function validateSummonOwnerSkill(unit, party) {
  if (!party.roster.has(unit.ownerId) || !party.isActive(unit.ownerId)) throw new Error('Invalid summon ownerHeroId');
  const definition = snapshot.summonSkills[unit.sourceSkillId];
  const legacyUnresolved = unit.sourceSkillId === SOURCE_DATA_NOT_FOUND && unit.sourceMonsterCode === SOURCE_DATA_NOT_FOUND && !unit.sourceData;
  if (!legacyUnresolved && (!definition || unit.sourceSkillId.split('.')[0] !== party.roster.get(unit.ownerId).classId)) throw new Error('Unknown or foreign summon sourceSkillId');
  if (!legacyUnresolved && unit.summonType === 'skeleton' && unit.sourceSkillId !== 'necromancer.raise_skeleton') throw new Error('Skeleton sourceSkillId mismatch');
  if (unit.aiProfile !== 'melee_random') throw new Error('Unknown summon aiProfile');
  if (unit.schemaVersion !== undefined && unit.schemaVersion !== 1) throw new Error('Unsupported summon schema');
  if (unit.sourceData) {
    validateSkeletonSourceData(unit.sourceData);
    if (unit.summonType !== 'skeleton' || unit.sourceMonsterCode !== unit.sourceData.sourceMonsterCode) throw new Error('Summon source identity mismatch');
  }
  if (unit.statInputs) {
    const resolved = resolveNecroskeletonStatInputs(unit.statInputs);
    if (unit.summonType !== 'skeleton' || unit.sourceMonsterCode !== resolved.sourceMonsterCode) throw new Error('Summon stat-input identity mismatch');
    if (unit.sourceData && JSON.stringify(unit.statInputs) !== JSON.stringify(statInputsFromSkeletonSourceData(unit.sourceData))) {
      throw new Error('Summon sourceData/statInputs mismatch');
    }
  }
}
function numeric(record, field) {
  const raw = record.fields[field];
  return raw !== '' && raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : SOURCE_DATA_NOT_FOUND;
}
function evidence(record, field, formula = null) {
  return { ...record.source, field, raw: record.fields[field] ?? SOURCE_DATA_NOT_FOUND, ...(formula ? { formula } : {}) };
}

// Only the literal, audited expressions below are supported; no eval or guessed engine functions.
export function necroskeletonStats({ skillLevel = 1, masteryLevel = 0, difficulty = 'normal' } = {}) {
  const normalized = normalizedInputs({ skillLevel, masteryLevel, difficulty });
  const lvl = normalized.skillLevel, mastery = normalized.masteryLevel;
  const suffix = { normal:'', nightmare:'(N)', hell:'(H)' }[difficulty];
  if (suffix === undefined) throw new Error('Unknown summon difficulty');
  const { skill: s, monster: m, mastery: sm } = snapshot.records;
  const fields = { hpMin: suffix ? `MinHP${suffix}`:'minHP', hpMax:suffix ? `MaxHP${suffix}`:'maxHP',
    damageMin:`A1MinD${suffix}`,damageMax:`A1MaxD${suffix}`,defense:`AC${suffix}`,attackRating:`A1TH${suffix}`,
    level:`Level${suffix}`, resistPhysical:`ResDm${suffix}`,resistMagic:`ResMa${suffix}`,resistFire:`ResFi${suffix}`,
    resistCold:`ResCo${suffix}`,resistLightning:`ResLi${suffix}`,resistPoison:`ResPo${suffix}`,velocity:'Velocity',run:'Run' };
  const base = {}, provenance = {};
  for (const [key,field] of Object.entries(fields)) { base[key]=numeric(m,field); provenance[`base.${key}`]=evidence(m,field); }
  const confirmed = (field, literal, calculate, statDefinition = null) => {
    if (s.fields[field] !== literal) throw new Error(`Unsupported source formula: ${field}`);
    const parameters = Object.fromEntries(Object.entries(s.fields).filter(([key,value])=>/^Param\d+$/.test(key)&&value!==''));
    provenance[field] = { ...evidence(s,field,literal), parameters,
      mastery: { ...sm.source, Param1:sm.fields.Param1,Param2:sm.fields.Param2 },
      ...(statDefinition ? { statDefinition: evidence(snapshot.records[statDefinition], 'Stat') } : {}) };
    return calculate();
  };
  const modifiers = {
    hpPercent: confirmed('calc1','(lvl < 4) ? 0 : (par2 * (lvl - 3))',()=>lvl<4?0:numeric(s,'Param2')*(lvl-3)),
    damagePercent: confirmed('aurastatcalc1','((lvl < 4) ? 0 : ((lvl-3)*par3))',()=>lvl<4?0:(lvl-3)*numeric(s,'Param3'),'statDamagePercent'),
    attackRating: confirmed('aurastatcalc2',"(lvl+skill('Skeleton Mastery'.lvl))*par4",()=>(lvl+mastery)*numeric(s,'Param4'),'statAttackRating'),
    defense: confirmed('aurastatcalc3',"(lvl+skill('Skeleton Mastery'.lvl))*par5",()=>(lvl+mastery)*numeric(s,'Param5'),'statDefense'),
    masteryHpFixed: confirmed('passivecalc1',"skill('Skeleton Mastery'.lvl) * skill('Skeleton Mastery'.par1) * 256",()=>mastery*numeric(sm,'Param1')*256,'statMaxHp'),
    masteryNormalDamage: mastery*numeric(sm,'Param2'),
    normalDamage: FORMULA_NOT_CONFIRMED,
  };
  provenance['modifiers.masteryNormalDamage'] = { ...evidence(s,'passivecalc2',s.fields.passivecalc2),
    statDefinition: evidence(snapshot.records.statNormalDamage,'Stat'),
    edmn: evidence(snapshot.records.skillCalcEdmn,'code','engine skill-calculation token') };
  provenance['modifiers.normalDamage'] = provenance['modifiers.masteryNormalDamage'];
  const maxCount = confirmed('petmax','(lvl < 4) ?lvl:(2+lvl/3)',()=>lvl<4?lvl:2+Math.trunc(lvl/3));
  provenance.petmax.integerDivisionPolicy = 'truncate non-negative count; engine bytecode absent from snapshot';
  return freeze({schemaVersion:1, sourceMonsterCode:m.fields.Id,petType:s.fields.pettype, skillLevel:lvl,masteryLevel:mastery,difficulty,
    base, modifiers, maxCount, provenance,
    final:{ hp:FORMULA_NOT_CONFIRMED, damageMin:FORMULA_NOT_CONFIRMED, damageMax:FORMULA_NOT_CONFIRMED,
      defense:FORMULA_NOT_CONFIRMED, attackRating:FORMULA_NOT_CONFIRMED,
      resistances:SOURCE_DATA_NOT_FOUND, monsterLevel:SOURCE_DATA_NOT_FOUND },
    limitation:'Engine stat composition, edmn tier thresholds and monster-level inheritance are absent from the local snapshot.'});
}

export function validateSkeletonSourceData(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('Unsupported skeleton source schema');
  const expected = necroskeletonStats(value);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('Skeleton runtime provenance/stat data mismatch');
  return expected;
}
