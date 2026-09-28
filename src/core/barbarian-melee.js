import {bashValues} from './audited-skill-rules.js';
import {equipmentStats} from './equipment.js';

// Normal Act I baseline used by this project's encounter catalogue.
// monstats AC=84; monlvl L-AC=6/12 -> floor(84*6/100)=5, floor(84*12/100)=10.
// Cross-checked against Blizzard's Fallen/Zombie/Wendigo tables; no fallback.
const TARGETS = Object.freeze({fallen1:{level:1,defense:5,block:9},
  zombie1:{level:1,defense:5,block:3},brute1:{level:2,defense:10,block:4}});

export function barbarianSwordProfile(character, skill, equipmentCatalog, skillCatalog) {
  if (character.classId !== 'barbarian' || character.equipment.weapon?.canonicalId !== 'short_sword'
    || character.equipment.offhand) throw new Error('Ten etap Odrzucenia obsługuje krótki miecz jednoręczny bez drugiej broni/tarczy');
  const stats = equipmentStats(character, equipmentCatalog);
  const values = skill.id === 'barbarian.bash' ? bashValues(character, skillCatalog)
    : {damagePercent:0,flatDamage:0,ratingPercent:0};
  // Bash calc1 adds to off-weapon ED; calc2 is added after weapon damage.
  // Cross-check: D2MOO SkillBar.cpp SrvSt32, not copied implementation.
  const damage = stats.baseDamage.map(n => Math.floor(n * (100 + stats.attributePercent + values.damagePercent) / 100) + values.flatDamage);
  // charstats.txt: Barbarian ToHitFactor=20. Normal unmodified sword only.
  const attackRating = Math.floor(Math.max(0, character.stats.dexterity * 5 - 35 + 20) * (100 + values.ratingPercent) / 100);
  return {label:skill.name,range:1,weaponMin:damage[0],weaponMax:damage[1],offWeaponFlat:0,
    damageOrigin:'equipment',damageType:'physical',status:'SOURCE_NUMERIC_HEX_ADAPTATION',
    sourceCode:stats.sourceCode,attackRating,attackerLevel:character.level,
    knockback:skill.id === 'barbarian.bash',bash:values};
}

export function meleeHitChance(attackRating, attackerLevel, defense, defenderLevel) {
  if (![attackRating,attackerLevel,defense,defenderLevel].every(Number.isFinite)
    || attackerLevel < 1 || defenderLevel < 1 || attackRating < 0 || defense < 0) throw new Error('Brak danych trafienia');
  const chance = attackRating === 0 ? 0 : Math.floor(200 * attackRating / (attackRating + defense) * attackerLevel / (attackerLevel + defenderLevel));
  return Math.max(5, Math.min(95, chance));
}

export function resolveBarbarianStrike(profile, targetCode, rng) {
  const target = TARGETS[targetCode];
  if (!target) throw new Error('Brak zweryfikowanej obrony celu dla tego testu Barbarzyńcy');
  const chance = meleeHitChance(profile.attackRating, profile.attackerLevel, target.defense, target.level);
  const hit = rng.integer(0,99) < chance;
  const blocked = hit && rng.integer(0,99) < target.block;
  return {hit:hit && !blocked,blocked,chance,
    damage:hit && !blocked ? rng.integer(profile.weaponMin,profile.weaponMax) : 0};
}

// A one-hex displacement is an explicit board adaptation, not D2 subtiles.
export function knockbackHex(from, target) {
  return {q:target.q + target.q - from.q,r:target.r + target.r - from.r};
}
