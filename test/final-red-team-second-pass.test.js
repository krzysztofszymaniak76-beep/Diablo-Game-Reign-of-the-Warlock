import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EquipmentCatalog, createEquipmentItem, initializeEquipmentAttributes, planEquipmentChange, commitEquipmentChange, validateEquipmentWorld } from '../src/core/equipment.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { spendSkillMana } from '../src/core/skill-mana.js';
import { MouseSkillCatalog } from '../src/core/mouse-skills.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';
import { CombatState, ATTACK_IMPACT_OFFSET } from '../src/core/combat.js';
import { BattlePreparationState } from '../src/core/battle-preparation.js';

const equipment = new EquipmentCatalog(JSON.parse(fs.readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const skills = new MouseSkillCatalog(JSON.parse(fs.readFileSync(new URL('../data/skill-mouse-bindings.v055.json', import.meta.url), 'utf8')));
function hero(id = 'korgan') { const h = createCharacter({ id, name: id, classId: 'barbarian' }); initializeEquipmentAttributes(h, equipment); return h; }
function item(base, id, position = { x: 0, y: 0 }) { return createEquipmentItem(equipment, base, id, { position }); }
function grid(items = []) { return new InventoryGrid({ width: 10, height: 4, items }); }

test('red-team 01: malformed mana is rejected without mutation', () => {
  const h = hero(); h.resources.mana = 5; const before = JSON.stringify(h);
  assert.throws(() => spendSkillMana(h, { id: 'bad', mana: null }), /mana/); assert.equal(JSON.stringify(h), before);
});

test('red-team 02: missing equipment identity is rejected atomically', () => {
  const h = hero(); const g = grid([item('hand_axe', 'axe')]); const before = JSON.stringify({ h, g: g.toJSON() });
  assert.throws(() => commitEquipmentChange(h, g, equipment, planEquipmentChange({ character: h, inventory: g, catalog: equipment, itemId: 'missing' })), /plecaku/);
  assert.equal(JSON.stringify({ h, g: g.toJSON() }), before);
});

test('red-team 03: duplicate equipment ownership is rejected', () => {
  const h = hero(); const g = grid([item('hand_axe', 'shared')]); h.inventoryItemIds = ['shared']; h.equipment.weapon = item('hand_axe', 'shared');
  assert.throws(() => validateEquipmentWorld(new Roster([h]), new Map([['korgan', g]]), equipment), /Powielony|nieprawidłowym miejscu/);
});

test('red-team 04: stale equipment plan cannot move a replacement item', () => {
  const h = hero(); const g = grid([item('hand_axe', 'axe')]); const plan = planEquipmentChange({ character: h, inventory: g, catalog: equipment, itemId: 'axe' }); const restored = InventoryGrid.fromJSON(g.toJSON()); restored.move('axe', { x: 1, y: 0 });
  assert.throws(() => commitEquipmentChange(h, restored, equipment, plan), /Stan wyposażenia/); assert.equal(h.equipment.weapon, undefined); assert.equal(restored.items.has('axe'), true);
});

test('red-team 05: full inventory cannot unequip an equipped weapon', () => {
  const h = hero(); const g = grid([item('hand_axe', 'axe')]); const plan = planEquipmentChange({ character: h, inventory: g, catalog: equipment, itemId: 'axe' }); commitEquipmentChange(h, g, equipment, plan); g.place({ id: 'full', width: 10, height: 4 }, { x: 0, y: 0 }); const before = JSON.stringify({ h, g: g.toJSON() });
  assert.throws(() => commitEquipmentChange(h, g, equipment, planEquipmentChange({ character: h, inventory: g, catalog: equipment, slot: 'weapon' })), /Brak miejsca/); assert.equal(JSON.stringify({ h, g: g.toJSON() }), before);
});

test('red-team 06: dead actor cannot complete a queued action', () => {
  const h = hero(); const roster = new Roster([h]); const party = new Party(roster, ['korgan']); const combat = new CombatState({ party, playersSetting: new PlayersSetting(1), seed: 9 });
  combat.units.get('korgan').position = { q: 0, r: 0 }; const enemy = combat.spawnMonster({ id: 'target', name: 'Cel', baseHp: 10, baseExperience: 1, position: { q: 1, r: 0 } }); enemy.readyAt = 9999; combat.nextReady(['korgan']);
  const payload = { skillId: 'basic.attack', targetId: enemy.id, damage: 1, range: 1, attackType: 'melee' }; combat.submitSequence('korgan', 'attack', payload, { transactionId: 'red-team-dead', events: [{ offset: ATTACK_IMPACT_OFFSET, kind: 'attack:impact', payload }] });
  h.resources.hp = 0; h.lifeState = 'corpse'; const before = JSON.stringify(combat.snapshot()); const result = combat.advanceTimeline(['korgan', 'target'], { resolve() { throw new Error('dead actor'); } });
  assert.equal(result.type, 'interrupted'); assert.notEqual(JSON.stringify(combat.snapshot()), before);
});

test('red-team 07: active preparation rejects next-battle transition', () => {
  const preparation = new BattlePreparationState({ heroIds: ['korgan'], heroPositions: { korgan: { q: 1, r: 0 } }, loadouts: { korgan: { left: 'basic.attack', right: ['barbarian.bash', 'barbarian.shout', 'barbarian.whirlwind'] } }, deploymentColumnOf: position => position.q });
  preparation.startBattle(); assert.throws(() => preparation.beginNextBattle({ heroPositions: { korgan: { q: 1, r: 0 } } }), /only after completing/); assert.equal(preparation.phase, 'active');
});

test('red-team 08: skill catalog rejects an unknown runtime skill', () => {
  assert.throws(() => skills.get('skill.does.not.exist'), /Unknown mouse skill/); assert.deepEqual(skills.list(['barbarian.bash'], 'left').includes('barbarian.bash'), true);
});

test('red-team 09: repeated deterministic state transitions stay identical', () => {
  const run = () => { const h = hero(); h.resources.mana = 8; spendSkillMana(h, skills.get('barbarian.bash')); return JSON.stringify({ id: h.id, mana: h.resources.mana, hp: h.resources.hp }); };
  assert.equal(run(), run());
});

test('red-team 10: equipment planning does not mutate before commit', () => {
  const h = hero(); const g = grid([item('short_sword', 'sword')]); const before = JSON.stringify({ h, g: g.toJSON() }); planEquipmentChange({ character: h, inventory: g, catalog: equipment, itemId: 'sword' });
  assert.equal(JSON.stringify({ h, g: g.toJSON() }), before);
});
