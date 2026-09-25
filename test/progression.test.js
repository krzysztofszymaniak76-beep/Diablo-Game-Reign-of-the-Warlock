import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCharacter, Roster } from '../src/core/characters.js';
import { Party } from '../src/core/party.js';
import { CombatState } from '../src/core/combat.js';
import { PlayersSetting } from '../src/core/players.js';
import { EquipmentCatalog, equipmentStats, createEquipmentItem, requirementsFor } from '../src/core/equipment.js';
import { PROGRESSION_DATA } from '../data/progression.v057.js';
import {
  addCharacterExperience, reconcileCharacterProgression, initializeCharacterProgression,
  spendCharacterStatPoints, characterProgressionView, characterExperienceSegments,
  levelForExperience, classProgressionProfile,
} from '../src/core/progression.js';

const hero = (id = 'hero', classId = 'barbarian') => createCharacter({ id, name: id, classId });
const equipment = new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));

test('source curve uses accumulated thresholds, correct row offset and the actual level 99 cap', () => {
  for (const profile of Object.values(PROGRESSION_DATA.classes)) {
    assert.equal(profile.thresholds.length, 99);
    assert.deepEqual(profile.thresholds.slice(0, 4), [0, 500, 1500, 3750]);
    assert.equal(profile.thresholds[98], 3520485254);
    assert.equal(profile.maxLevel, 99);
    assert.equal(profile.statPointsPerLevel, 5);
    assert.equal(profile.skillPointsPerLevel, 1);
  }
  assert.equal(classProgressionProfile('druid').lifePerLevel, 1.5);
  assert.equal(classProgressionProfile('assassin').manaPerEnergy, 1.75);
  assert.equal(classProgressionProfile('warlock').baseHp, 55);
  assert.equal(classProgressionProfile('warlock').baseMana, 20);
});

test('new characters of every class start independently at 1/0 with source attributes', () => {
  for (const classId of Object.keys(PROGRESSION_DATA.classes)) {
    const h = hero(classId, classId);
    assert.equal(h.level, 1); assert.equal(h.experience, 0);
    assert.equal(h.unspentStatPoints, 0); assert.equal(h.unspentSkillPoints, 0);
    assert.deepEqual(h.stats, classProgressionProfile(classId).stats);
  }
  const a = hero('a'), b = hero('b');
  addCharacterExperience(a, 1500);
  assert.equal(b.level, 1); assert.equal(b.experience, 0);
  assert.equal(hero('replacement').level, 1);
});

test('HUD experience cells show true zero, partial gain and restored progress', () => {
  const h = hero();
  const initial = characterExperienceSegments(h);
  assert.equal(initial.currentExp, 0);
  assert.equal(initial.expRequiredForNextLevel, 500);
  assert.equal(initial.percent, 0);
  assert.equal(initial.filledSegments, 0);
  assert.deepEqual(initial.segments, Array(10).fill(0));

  addCharacterExperience(h, 185);
  const earned = characterExperienceSegments(h);
  assert.equal(earned.percent, 37);
  assert.equal(earned.filledSegments, 3);
  assert.deepEqual(earned.segments.slice(0, 5), [1, 1, 1, .7, 0]);
  assert.deepEqual(characterExperienceSegments(new Roster([h]).get(h.id)), earned);

  addCharacterExperience(h, 315);
  const afterLevel = characterExperienceSegments(h);
  assert.equal(h.level, 2);
  assert.equal(afterLevel.currentExp, 0);
  assert.equal(afterLevel.expRequiredForNextLevel, 1000);
  assert.equal(afterLevel.percent, 0);
  assert.equal(afterLevel.filledSegments, 0);
});

test('below/exact threshold and multi-level award grant points only once without healing', () => {
  const h = hero(); h.resources.hp = 17; h.resources.mana = 3;
  assert.equal(addCharacterExperience(h, 499).levelsGained, 0);
  assert.equal(h.level, 1); assert.equal(h.unspentStatPoints, 0);
  assert.equal(addCharacterExperience(h, 1).levelsGained, 1);
  assert.equal(h.level, 2); assert.equal(h.unspentStatPoints, 5); assert.equal(h.unspentSkillPoints, 1);
  const gain = addCharacterExperience(h, 3250);
  assert.equal(gain.levelsGained, 2); assert.equal(h.level, 4); assert.equal(h.experience, 3750);
  assert.equal(h.unspentStatPoints, 15); assert.equal(h.unspentSkillPoints, 3);
  assert.deepEqual(h.resources, { hp: 17, maxHp: 61, mana: 3, maxMana: 13 });
  const before = JSON.stringify(h);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(reconcileCharacterProgression(h).levelsGained, 0);
    characterProgressionView(h);
  }
  assert.equal(JSON.stringify(h), before);
});

test('max level awards exactly 98 advances and exposes no next threshold or zero divisor', () => {
  const h = hero();
  addCharacterExperience(h, 3520485253); assert.equal(h.level, 98);
  addCharacterExperience(h, 1); assert.equal(h.level, 99);
  assert.equal(h.unspentStatPoints, 490); assert.equal(h.unspentSkillPoints, 98);
  const view = characterProgressionView(h);
  assert.equal(view.nextLevelExperience, null); assert.equal(view.experienceForLevel, null);
  assert.equal(view.fraction, 1); assert.equal(view.isMaxLevel, true);
  addCharacterExperience(h, 317253763); // source technical row 99 must not unlock level 100
  assert.equal(h.level, 99); assert.equal(h.unspentStatPoints, 490);
  assert.equal(levelForExperience('barbarian', Number.MAX_SAFE_INTEGER), 99);
});

test('stat spending changes one owner, follows resource quarter units and rejects invalid spending atomically', () => {
  const h = hero('assassin', 'assassin');
  h.resources.hp = 12.5; h.resources.mana = 2.25;
  addCharacterExperience(h, 500);
  spendCharacterStatPoints(h, 'energy');
  assert.equal(h.stats.energy, 26); assert.equal(h.unspentStatPoints, 4);
  assert.equal(h.resources.maxMana, 28.25); assert.equal(h.resources.mana, 2.25);
  spendCharacterStatPoints(h, 'vitality', 4);
  assert.equal(h.resources.maxHp, 64); assert.equal(h.resources.hp, 12.5);
  assert.equal(h.unspentStatPoints, 0);
  assert.deepEqual(h.progression.allocatedStatPoints, { strength: 0, dexterity: 0, vitality: 4, energy: 1 });
  for (const [attribute, count] of [['energy', 1], ['energy', 0], ['energy', -1], ['energy', 1.5], ['luck', 1]]) {
    const before = JSON.stringify(h);
    assert.throws(() => spendCharacterStatPoints(h, attribute, count));
    assert.equal(JSON.stringify(h), before);
  }
});

test('strength/dexterity spending uses existing equipment damage, defense and requirement resolver', () => {
  const h = hero(); addCharacterExperience(h, 1500);
  h.equipment.weapon = createEquipmentItem(equipment, 'hand_axe', 'axe');
  assert.deepEqual(equipmentStats(h, equipment).weaponDamage, [3, 7]);
  spendCharacterStatPoints(h, 'strength', 5);
  assert.deepEqual(equipmentStats(h, equipment).weaponDamage, [4, 8]);
  const previousDefense = equipmentStats(h, equipment).defense;
  spendCharacterStatPoints(h, 'dexterity', 4);
  assert.equal(equipmentStats(h, equipment).defense, previousDefense + 1);
  const requirement = { ...equipment.get('great_axe'), requiredStrength: 36, requiredDexterity: 0, requiredLevel: 1 };
  assert.ok(requirementsFor(h, requirement).some(message => message.includes('siła')));
  spendCharacterStatPoints(h, 'strength');
  assert.deepEqual(requirementsFor(h, requirement), []);
});

test('old level-one accumulated XP migrates once without losing resources, equipment or demo skills', () => {
  const old = hero(); delete old.progression;
  old.stats = { strength: 0, dexterity: 0, vitality: 0, energy: 0 };
  old.experience = 1500; old.resources.hp = 7; old.resources.mana = 2;
  old.skills = { 'barbarian.bash': { hardPoints: 1, softPoints: 0, effectiveLevel: 1 } };
  old.equipment.weapon = createEquipmentItem(equipment, 'hand_axe', 'kept-axe');
  const roster = new Roster([old]), h = roster.get(old.id);
  assert.equal(old.level, 1); assert.equal(old.progression, undefined); // source save untouched
  assert.equal(h.level, 3); assert.equal(h.experience, 1500);
  assert.equal(h.unspentStatPoints, 10); assert.equal(h.unspentSkillPoints, 2);
  assert.equal(h.resources.hp, 7); assert.equal(h.resources.mana, 2);
  assert.equal(h.stats.strength, 30); assert.equal(h.equipment.weapon.id, 'kept-axe');
  assert.deepEqual(h.skills, old.skills);
  spendCharacterStatPoints(h, 'vitality');
  const snapshot = roster.toJSON();
  assert.deepEqual(new Roster(JSON.parse(JSON.stringify(snapshot))).toJSON(), snapshot);
  assert.deepEqual(new Roster(new Roster(snapshot).toJSON()).toJSON(), snapshot);
});

test('legacy existing levels and custom maxima are preserved and only later new XP grants growth', () => {
  const h = hero(); delete h.progression;
  h.level = 3; h.experience = 1500; h.unspentStatPoints = 2; h.unspentSkillPoints = 1;
  h.stats.strength = 45; h.resources = { hp: 17, maxHp: 100, mana: 2, maxMana: 80 };
  initializeCharacterProgression(h);
  assert.equal(h.unspentStatPoints, 2); assert.equal(h.resources.maxHp, 100); assert.equal(h.stats.strength, 45);
  addCharacterExperience(h, 2250);
  assert.deepEqual(h.resources, { hp: 17, maxHp: 102, mana: 2, maxMana: 81 });
  assert.equal(h.unspentStatPoints, 7); assert.equal(h.unspentSkillPoints, 2);
});

test('fractional life growth persists and dead heroes are never revived by leveling or spending', () => {
  const h = hero('druid', 'druid'); h.resources.hp = 0; h.lifeState = 'corpse';
  addCharacterExperience(h, 500);
  assert.equal(h.resources.maxHp, 56.5); assert.equal(h.resources.hp, 0);
  spendCharacterStatPoints(h, 'vitality');
  assert.equal(h.resources.maxHp, 58.5); assert.equal(h.resources.hp, 0); assert.equal(h.lifeState, 'corpse');
  assert.deepEqual(new Roster([h]).get(h.id), h);
});

test('combat awards apply /players only at spawn, share once and never award reserve or replayed kills', () => {
  const roster = new Roster([hero('a'), hero('b'), hero('reserve')]);
  const party = new Party(roster, ['a', 'b']);
  const combat = new CombatState({ party, playersSetting: new PlayersSetting(3) });
  const monster = combat.spawnMonster({ id: 'monster', name: 'Wróg', baseHp: 10, baseExperience: 500 });
  assert.equal(monster.experience, 1000); monster.hp = 0;
  const awards = combat.grantMonsterExperience(monster.id, ['a', 'a', 'b', 'reserve']);
  assert.equal(awards.length, 2);
  for (const id of ['a', 'b']) {
    assert.equal(roster.get(id).experience, 500); assert.equal(roster.get(id).level, 2);
    assert.equal(awards.find(a => a.characterId === id).levelUp.levelsGained, 1);
  }
  assert.equal(roster.get('reserve').experience, 0);
  assert.deepEqual(combat.grantMonsterExperience(monster.id, ['a', 'b']), []);
  assert.equal(roster.get('a').unspentStatPoints, 5);
});

test('invalid XP, future progression schemas and party overflow fail without partial rewards', () => {
  const h = hero();
  for (const amount of [-1, NaN, Infinity, 1.5, null]) {
    const before = JSON.stringify(h); assert.throws(() => addCharacterExperience(h, amount)); assert.equal(JSON.stringify(h), before);
  }
  const future = structuredClone(h); future.progression.schemaVersion = 99;
  assert.throws(() => new Roster([future]), /wersja/);
  const roster = new Roster([hero('a'), hero('b')]);
  roster.get('b').experience = Number.MAX_SAFE_INTEGER;
  const combat = new CombatState({ party: new Party(roster, ['a', 'b']), playersSetting: new PlayersSetting(1) });
  const monster = combat.spawnMonster({ id: 'm', name: 'Wróg', baseHp: 1, baseExperience: 100 }); monster.hp = 0;
  const before = roster.toJSON();
  assert.throws(() => combat.grantMonsterExperience('m', ['a', 'b']), /suma EXP/);
  assert.deepEqual(roster.toJSON(), before); assert.equal(monster.rewardsGranted, false);
});
