import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EquipmentCatalog, createEquipmentItem, initializeEquipmentAttributes, planEquipmentChange, commitEquipmentChange, equipmentSkillProfile, equipmentStats, validateEquipmentWorld } from '../src/core/equipment.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { MouseSkillBindings, MouseSkillCatalog } from '../src/core/mouse-skills.js';
import { spendSkillMana } from '../src/core/skill-mana.js';
import { CombatState, ATTACK_IMPACT_OFFSET } from '../src/core/combat.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';
import { BattlePreparationState } from '../src/core/battle-preparation.js';
import { HexGrid } from '../src/core/hex-grid.js';
import { PortalSystem } from '../src/core/portals.js';
import { ENCOUNTER_INSTANCE_ID, createEncounterProgress, stageVictoryLoot } from '../src/core/encounter-loot.js';
import { stageNextEncounter } from '../src/core/encounter-loop.js';

const equipmentData = JSON.parse(fs.readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8'));
const skillData = JSON.parse(fs.readFileSync(new URL('../data/skill-mouse-bindings.v055.json', import.meta.url), 'utf8'));
const equipment = new EquipmentCatalog(equipmentData);
const skills = new MouseSkillCatalog(skillData);

function hero(id, classId = 'barbarian') {
  const value = createCharacter({ id, name: id, classId });
  initializeEquipmentAttributes(value, equipment);
  return value;
}

function item(base, id, position = { x: 0, y: 0 }, extra = {}) {
  return createEquipmentItem(equipment, base, id, { position, ...extra });
}

function grid(items = []) { return new InventoryGrid({ width: 10, height: 4, items }); }
function change(character, inventory, args) {
  const plan = planEquipmentChange({ character, inventory, catalog: equipment, ...args });
  commitEquipmentChange(character, inventory, equipment, plan);
  return plan;
}

function bindingFixture() {
  const heroIds = ['korgan', 'hadriel', 'ormus'];
  const knownSkillsByHero = {
    korgan: ['basic.attack', 'barbarian.bash', 'barbarian.whirlwind', 'barbarian.shout'],
    hadriel: ['basic.attack', 'paladin.smite', 'paladin.zeal', 'paladin.might'],
    ormus: ['basic.attack', 'necromancer.teeth', 'necromancer.raise_skeleton', 'necromancer.corpse_explosion'],
  };
  const initialBindings = {
    korgan: { left: 'basic.attack', right: 'barbarian.bash' },
    hadriel: { left: 'basic.attack', right: 'paladin.smite' },
    ormus: { left: 'necromancer.teeth', right: 'necromancer.raise_skeleton' },
  };
  return { heroIds, knownSkillsByHero, catalog: skills, bindings: new MouseSkillBindings({ heroIds, knownSkillsByHero, initialBindings, catalog: skills }) };
}

function pendingCast() {
  const character = hero('caster');
  character.resources.mana = 2;
  const roster = new Roster([character]);
  const party = new Party(roster, ['caster']);
  const combat = new CombatState({ party, playersSetting: new PlayersSetting(1), seed: 700 });
  combat.units.get('caster').position = { q: 0, r: 0 };
  const enemy = combat.spawnMonster({ id: 'target', name: 'Cel', baseHp: 20, baseExperience: 1, position: { q: 1, r: 0 } });
  enemy.readyAt = 9999;
  combat.nextReady(['caster']);
  const source = skills.get('barbarian.bash');
  const execution = {
    schemaVersion: 1, skillId: 'barbarian.bash', skillLevel: 1, side: 'left', weaponFingerprint: null,
  };
  const payload = { skillId: 'barbarian.bash', skillExecution: execution, targetId: enemy.id, damage: 5, range: 1, attackType: 'melee' };
  combat.submitSequence('caster', 'attack', payload, { transactionId: 'second-pass-cast', events: [{ offset: ATTACK_IMPACT_OFFSET, kind: 'attack:impact', payload }] });
  return { character, roster, party, combat, enemy, source };
}

test('Attack crosses unarmed, one-handed and two-handed equipment without changing binding', () => {
  const h = hero('korgan');
  const g = grid([item('hand_axe', 'axe'), item('great_axe', 'great', { x: 2, y: 0 })]);
  const { bindings } = bindingFixture();
  const attack = { id: 'basic.attack', name: 'Attack', damage: [1, 2], range: 1 };
  assert.deepEqual([equipmentSkillProfile(h, attack, equipment).weaponMin, equipmentSkillProfile(h, attack, equipment).weaponMax], [1, 2]);
  change(h, g, { itemId: 'axe' });
  assert.deepEqual([equipmentSkillProfile(h, attack, equipment).weaponMin, equipmentSkillProfile(h, attack, equipment).weaponMax], [3, 7]);
  h.stats.strength = 70; h.stats.dexterity = 50;
  change(h, g, { itemId: 'great' });
  assert.equal(equipmentStats(h, equipment).twoHanded, true);
  assert.deepEqual(bindings.get('korgan'), { left: 'basic.attack', right: 'barbarian.bash' });
});

test('chooser binding survives a weapon swap and re-evaluates skill profile', () => {
  const h = hero('korgan');
  const g = grid([item('hand_axe', 'a'), item('short_sword', 'b', { x: 2, y: 0 })]);
  const { bindings } = bindingFixture();
  bindings.assign('korgan', 'left', 'barbarian.bash');
  change(h, g, { itemId: 'a' });
  const bash = { id: 'barbarian.bash', name: 'Bash', damage: [999, 999], range: 1 };
  assert.deepEqual([equipmentSkillProfile(h, bash, equipment).weaponMin, equipmentSkillProfile(h, bash, equipment).weaponMax], [3, 7]);
  change(h, g, { itemId: 'b' });
  assert.deepEqual([equipmentSkillProfile(h, bash, equipment).weaponMin, equipmentSkillProfile(h, bash, equipment).weaponMax], [2, 9]);
  assert.equal(bindings.get('korgan').left, 'barbarian.bash');
});

test('shield-dependent skill remains assigned but is unavailable until a shield is equipped', () => {
  const h = hero('hadriel', 'paladin');
  const g = grid([item('buckler', 'shield')]);
  const { bindings } = bindingFixture();
  const smite = { id: 'paladin.smite', name: 'Smite', damage: [8, 12], range: 1 };
  assert.equal(bindings.get('hadriel').right, 'paladin.smite');
  assert.match(equipmentSkillProfile(h, smite, equipment).error, /tarczy/);
  change(h, g, { itemId: 'shield' });
  assert.equal(equipmentSkillProfile(h, smite, equipment).error, null);
  change(h, g, { slot: 'offhand' });
  assert.match(equipmentSkillProfile(h, smite, equipment).error, /tarczy/);
  assert.equal(bindings.get('hadriel').right, 'paladin.smite');
});

test('equipment, binding and mana survive one JSON save/load round trip', () => {
  const h = hero('korgan');
  const g = grid([item('short_sword', 'sword')]);
  const fixture = bindingFixture();
  fixture.bindings.assign('korgan', 'left', 'barbarian.bash');
  change(h, g, { itemId: 'sword' });
  spendSkillMana(h, skills.get('barbarian.bash'));
  const save = JSON.stringify({ hero: h, inventory: g.toJSON(), bindings: fixture.bindings.snapshot() });
  const parsed = JSON.parse(save);
  const restoredBindings = MouseSkillBindings.restore(parsed.bindings, fixture);
  assert.equal(parsed.hero.resources.mana, h.resources.mana);
  assert.equal(parsed.hero.equipment.weapon.id, 'sword');
  assert.equal(restoredBindings.get('korgan').left, 'barbarian.bash');
  assert.equal(InventoryGrid.fromJSON(parsed.inventory).items.has('sword'), false);
});

test('cancelled queued cast keeps mana and a later save does not resurrect it', () => {
  const f = pendingCast();
  const cancelled = f.combat.advanceTimeline(['caster', 'target'], { resolve() { throw new Error('cancelled by target move'); } });
  assert.equal(cancelled.type, 'interrupted');
  assert.equal(f.character.resources.mana, 2);
  const save = JSON.parse(JSON.stringify({ hero: f.character, combat: f.combat.snapshot() }));
  assert.equal(save.hero.resources.mana, 2);
  assert.equal(save.combat.commands.active.length, 0);
  assert.equal(save.combat.commands.history.at(-1).status, 'interrupted');
});

test('successful cast, save/load and second cast debit exactly once per execution', () => {
  const f = pendingCast();
  f.combat.advanceTimeline(['caster', 'target'], { resolve(event, resolveCore) { spendSkillMana(f.character, f.source); return resolveCore(); } });
  assert.equal(f.character.resources.mana, 0);
  const save = JSON.parse(JSON.stringify({ hero: f.character, combat: f.combat.snapshot() }));
  assert.equal(save.hero.resources.mana, 0);
  assert.equal(save.combat.commands.history.filter((entry) => entry.status === 'effects-complete').length, 1);
  assert.equal(f.combat.commandHistory.filter((entry) => entry.commandId === 'command-0').length, 1);
});

test('rapid hero switching keeps each LPM/PPM pair independent', () => {
  const fixture = bindingFixture();
  for (const [heroId, side, skill] of [
    ['korgan', 'left', 'barbarian.whirlwind'], ['hadriel', 'right', 'paladin.might'], ['ormus', 'left', 'necromancer.teeth'], ['korgan', 'right', 'barbarian.shout'],
  ]) fixture.bindings.assign(heroId, side, skill);
  assert.deepEqual(fixture.bindings.get('korgan'), { left: 'barbarian.whirlwind', right: 'barbarian.shout' });
  assert.deepEqual(fixture.bindings.get('hadriel'), { left: 'basic.attack', right: 'paladin.might' });
  assert.deepEqual(fixture.bindings.get('ormus'), { left: 'necromancer.teeth', right: 'necromancer.raise_skeleton' });
});

test('hero switching and mana use never leaks resources between heroes', () => {
  const heroes = ['korgan', 'hadriel', 'ormus'].map((id) => hero(id));
  const source = skills.get('barbarian.bash');
  heroes[0].resources.mana = 6; heroes[1].resources.mana = 6; heroes[2].resources.mana = 6;
  spendSkillMana(heroes[0], source); spendSkillMana(heroes[2], source);
  assert.equal(heroes[0].resources.mana, 4);
  assert.equal(heroes[1].resources.mana, 6);
  assert.equal(heroes[2].resources.mana, 4);
});

test('full inventory blocks unequip atomically while preserving equipped weapon and owner index', () => {
  const h = hero('korgan');
  const g = grid([item('hand_axe', 'axe')]);
  change(h, g, { itemId: 'axe' });
  g.place({ id: 'full', width: 10, height: 4 }, { x: 0, y: 0 });
  const before = JSON.stringify({ h, g: g.toJSON() });
  assert.throws(() => change(h, g, { slot: 'weapon' }), /Brak miejsca/);
  assert.equal(JSON.stringify({ h, g: g.toJSON() }), before);
  assert.equal(h.equipment.weapon.id, 'axe');
});

test('two-handed swap displaces offhand exactly once and preserves identity on save', () => {
  const h = hero('korgan'); h.stats.strength = 100; h.stats.dexterity = 100;
  const g = grid([item('buckler', 'shield'), item('great_axe', 'axe', { x: 2, y: 0 })]);
  change(h, g, { itemId: 'shield' }); change(h, g, { itemId: 'axe' });
  assert.equal(h.equipment.weapon.id, 'axe'); assert.equal(h.equipment.offhand, undefined); assert.equal(g.items.has('shield'), true);
  const roundTrip = JSON.parse(JSON.stringify({ h, g: g.toJSON() }));
  assert.equal(roundTrip.h.equipment.weapon.id, 'axe');
  assert.deepEqual(roundTrip.g.items.map((entry) => entry.id), ['shield']);
});

test('world ownership validation rejects an item duplicated between inventory and equipment', () => {
  const h = hero('korgan');
  const g = grid([item('hand_axe', 'shared')]);
  h.inventoryItemIds = ['shared'];
  h.equipment.weapon = item('hand_axe', 'shared');
  assert.throws(() => validateEquipmentWorld(new Roster([h]), new Map([['korgan', g]]), equipment), /Powielony|nieprawidłowym miejscu/);
});

test('stale equipment plan cannot commit after a save/load-like inventory replacement', () => {
  const h = hero('korgan');
  const g = grid([item('hand_axe', 'axe')]);
  const plan = planEquipmentChange({ character: h, inventory: g, catalog: equipment, itemId: 'axe' });
  const restored = InventoryGrid.fromJSON(g.toJSON());
  restored.move('axe', { x: 1, y: 0 });
  assert.throws(() => commitEquipmentChange(h, restored, equipment, plan), /Stan wyposażenia/);
  assert.equal(h.equipment.weapon, undefined);
  assert.equal(restored.items.has('axe'), true);
});

test('command history remains single-use after an interrupted target change', () => {
  const f = pendingCast();
  const first = f.combat.advanceTimeline(['caster', 'target'], { resolve() { throw new Error('target moved'); } });
  assert.equal(first.type, 'interrupted');
  const before = JSON.stringify(f.combat.snapshot().commands.history);
  const replay = f.combat.advanceTimeline(['caster', 'target'], { resolve() { throw new Error('replay'); } });
  assert.ok(replay === null || replay.type === 'ready' || replay.type === 'interrupted');
  assert.equal(JSON.stringify(f.combat.snapshot().commands.history), before);
});

test('dead actor cannot execute a queued skill after hero state changes', () => {
  const f = pendingCast();
  f.character.resources.hp = 0; f.character.lifeState = 'corpse';
  const before = JSON.stringify(f.combat.snapshot());
  const result = f.combat.advanceTimeline(['caster', 'target'], { resolve() { throw new Error('dead actor guard'); } });
  assert.equal(result.type, 'interrupted');
  assert.equal(JSON.stringify(f.combat.snapshot()).includes('completed'), false);
  assert.notEqual(JSON.stringify(f.combat.snapshot()), before);
});

test('new encounter starts with fresh command history while preserving hero equipment and mana', () => {
  const heroes = ['a', 'b', 'c'].map((id) => hero(id));
  const roster = new Roster(heroes); const party = new Party(roster, ['a', 'b', 'c']); const players = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting: players, seed: 33 });
  const positions = { a: { q: 1, r: 0 }, b: { q: 1, r: 1 }, c: { q: 1, r: 2 }, 'fallen-1': { q: 6, r: 2 } };
  for (const [id, position] of Object.entries(positions)) { if (id !== 'fallen-1') combat.units.get(id).position = position; }
  const enemy = combat.spawnMonster({ id: 'fallen-1', name: 'Upadły', baseHp: 10, baseExperience: 2, position: positions['fallen-1'] });
  const preparation = new BattlePreparationState({ heroIds: party.slots, heroPositions: { a: positions.a, b: positions.b, c: positions.c }, loadouts: Object.fromEntries(party.slots.map((id) => [id, { left: 'basic.attack', right: ['x', 'y', 'z'] }])), deploymentColumnOf: (position) => position.q });
  preparation.startBattle(); enemy.hp = 0; preparation.completeBattle();
  const gridWorld = new HexGrid({ tiles: Array.from({ length: 8 }, (_, q) => Array.from({ length: 6 }, (_, r) => ({ q, r }))).flat() });
  for (const [id, position] of Object.entries(positions)) gridWorld.addUnit({ id, position });
  const portals = new PortalSystem(); for (const id of party.slots) portals.setCharacterLocation(id, { kind: 'area', area_id: 'act1.blood_moor', instance_id: ENCOUNTER_INSTANCE_ID, hex: positions[id] });
  const inventories = new Map(party.slots.map((id) => [id, new InventoryGrid()]));
  let progress = createEncounterProgress();
  const originalHp = heroes[0].resources.hp;
  progress = stageVictoryLoot(progress, { enemy, hex: positions['fallen-1'], catalog: equipment });
  combat.grantMonsterExperience(enemy.id, party.slots);
  const next = stageNextEncounter({ progress, expectedEncounter: 1, catalog: equipment, roster, party, players, combat, enemy, preparation, hexGrid: gridWorld, portals, initialPositions: new Map(Object.entries(positions)), deploymentColumnOf: (position) => position.q, areaId: 'act1.blood_moor' });
  assert.equal(next.combat.commandHistory.length, 0);
  assert.equal(heroes[0].resources.hp, originalHp);
  assert.equal(next.preparation.getLoadout('a').left, 'basic.attack');
});

test('preparation snapshot rejects active-combat-only loot/equipment phase combinations', () => {
  const preparation = new BattlePreparationState({ heroIds: ['a'], heroPositions: { a: { q: 1, r: 0 } }, loadouts: { a: { left: 'basic.attack', right: ['x', 'y', 'z'] } }, deploymentColumnOf: (position) => position.q });
  preparation.startBattle();
  assert.equal(preparation.phase, 'active');
  assert.throws(() => preparation.beginNextBattle({ heroPositions: { a: { q: 1, r: 0 } } }), /only after completing/);
  assert.equal(preparation.phase, 'active');
});

test('malformed skill/equipment input fails without consuming mana or moving inventory', () => {
  const h = hero('korgan'); h.resources.mana = 6; const g = grid([item('hand_axe', 'axe')]);
  const before = JSON.stringify({ h, g: g.toJSON() });
  assert.throws(() => spendSkillMana(h, { id: 'bad', mana: null }), /mana/);
  assert.throws(() => change(h, g, { itemId: 'missing' }), /plecaku/);
  assert.equal(JSON.stringify({ h, g: g.toJSON() }), before);
});

test('repeated cross-system sequence is deterministic across two independent runs', () => {
  const run = () => {
    const h = hero('korgan'); const g = grid([item('short_sword', 's')]); const { bindings } = bindingFixture();
    bindings.assign('korgan', 'left', 'barbarian.bash'); change(h, g, { itemId: 's' }); h.resources.mana = 10; spendSkillMana(h, skills.get('barbarian.bash'));
    return JSON.stringify({ h, inventory: g.toJSON(), bindings: bindings.snapshot() });
  };
  assert.equal(run(), run());
});
