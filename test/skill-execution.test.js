import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SkillTarget, skillTargetMode, validateSkillTarget, createSkillExecution, checkSkillExecution, validateSkillExecution, WorldInputGuard } from '../src/core/skill-execution.js';
import { MouseSkillCatalog } from '../src/core/mouse-skills.js';
import { canPaySkillMana, spendSkillMana } from '../src/core/skill-mana.js';
import { CombatState, ATTACK_IMPACT_OFFSET } from '../src/core/combat.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';

const catalog = new MouseSkillCatalog(JSON.parse(fs.readFileSync(new URL('../data/skill-mouse-bindings.v055.json', import.meta.url))));
function fixture() {
  const character = createCharacter({ id: 'hero', name: 'Korgan', classId: 'barbarian' });
  const skill = { id: 'barbarian.bash', category: 'offensive', range: 1 };
  const profile = { damageOrigin: 'equipment', error: null };
  const source = catalog.get(skill.id);
  const args = { character, skill, source, skillLevel: 1, knownSkillIds: [skill.id], profile };
  const execution = createSkillExecution({ ...args, side: 'left' });
  return { ...args, execution, args };
}

test('source flags and existing categories distinguish enemy, ground, self, aura and corpse', () => {
  const cases = [
    ['basic.attack', 'offensive', SkillTarget.ENEMY],
    ['necromancer.teeth', 'offensive', SkillTarget.ENEMY],
    ['necromancer.clay_golem', 'summon', SkillTarget.GROUND],
    ['barbarian.battle_orders', 'buff', SkillTarget.SELF],
    ['paladin.might', 'aura', SkillTarget.AURA],
    ['necromancer.raise_skeleton', 'summon', SkillTarget.CORPSE],
    ['necromancer.corpse_explosion', 'offensive', SkillTarget.CORPSE],
  ];
  for (const [id, category, expected] of cases) assert.equal(skillTargetMode(catalog.get(id), { id, category }), expected);
});

test('target guard accepts only the correct runtime target and never invents battlefield corpses', () => {
  assert.equal(validateSkillTarget(SkillTarget.ENEMY, { enemy: true }), true);
  assert.throws(() => validateSkillTarget(SkillTarget.ENEMY, { hasHex: true, freeGround: true }), /przeciwnika/);
  assert.equal(validateSkillTarget(SkillTarget.GROUND, { hasHex: true, freeGround: true }), true);
  assert.throws(() => validateSkillTarget(SkillTarget.GROUND, { hasHex: true }), /pusty/);
  assert.equal(validateSkillTarget(SkillTarget.SELF), true);
  assert.equal(validateSkillTarget(SkillTarget.AURA), true);
  for (const id of ['necromancer.raise_skeleton', 'necromancer.corpse_explosion']) {
    assert.equal(catalog.allows(id, 'left'), false);
    assert.equal(catalog.allows(id, 'right'), true);
    assert.throws(() => validateSkillTarget(SkillTarget.CORPSE, { corpse: { id: 'fake', state: 'available' } }), /nie jest jeszcze podłączony/);
  }
  for (const mode of [SkillTarget.ALLY, SkillTarget.PET, SkillTarget.ITEM]) {
    assert.throws(() => validateSkillTarget(mode), /nie jest jeszcze obsługiwany/);
  }
});

test('execution checks are pure and reject changed weapon, skill level, legality, death and mana', () => {
  const { character, execution, args } = fixture();
  const before = structuredClone(character);
  assert.equal(checkSkillExecution(execution, args).mana.cost, 2);
  assert.deepEqual(character, before);
  assert.throws(() => checkSkillExecution(execution, { ...args, skillLevel: 2 }), /Poziom/);
  assert.throws(() => checkSkillExecution(execution, { ...args, knownSkillIds: [] }), /legalna/);
  assert.throws(() => checkSkillExecution(execution, { ...args, source: { ...args.source, mouse: { left: false, right: true } } }), /legalna/);
  character.equipment.weapon = { id: 'changed' };
  assert.throws(() => checkSkillExecution(execution, args), /Broń zmieniła/);
  character.equipment = {};
  character.resources.mana = 1;
  assert.throws(() => checkSkillExecution(execution, args), /Za mało many/);
  character.resources.mana = 2;
  assert.equal(checkSkillExecution(execution, args).mana.affordable, true);
  character.resources.hp = 0;
  assert.throws(() => checkSkillExecution(execution, args), /nie żyje/);
  // Only an already launched projectile can opt into the existing lifetime
  // policy; default melee/approach execution still requires a living actor.
  assert.equal(checkSkillExecution(execution, { ...args, allowDefeatedSource: true }).mana.affordable, true);
});

test('execution descriptors reject corrupt or ambiguous persisted control state', () => {
  const { execution } = fixture();
  for (const bad of [{ ...execution, schemaVersion: 0 }, { ...execution, skillLevel: 0 },
    { ...execution, side: 'middle' }, { ...execution, prepaid: true }, { ...execution, weaponFingerprint: 7 }]) {
    assert.throws(() => validateSkillExecution(bad), /Nieprawidłowy/);
  }
});

test('input guard rejects repeated event delivery, real double-click and immediate synthetic duplicate', () => {
  const guard = new WorldInputGuard();
  const event = { type: 'click', button: 0, detail: 1 };
  const hex = { q: 2, r: 3 };
  assert.equal(guard.accept(event, hex, 1000), true);
  assert.equal(guard.accept(event, hex, 1500), false);
  assert.equal(guard.accept({ ...event, detail: 2 }, hex, 1700), false);
  assert.equal(guard.accept({ ...event }, hex, 1200), false);
  assert.equal(guard.accept({ ...event }, hex, 1300), true);
  assert.equal(guard.accept({ ...event }, { q: 3, r: 3 }, 1301), true);
  assert.equal(guard.accept({ type: 'contextmenu', button: 2 }, hex, 1302), true);
  assert.equal(guard.accept({ type: 'contextmenu', button: 2 }, hex, 1400), false);
});

function pendingAttack() {
  const f = fixture();
  const roster = new Roster([f.character]);
  const hero = roster.get('hero');
  hero.resources.mana = 2;
  const combat = new CombatState({ party: new Party(roster, ['hero']), playersSetting: new PlayersSetting(1), seed: 13 });
  combat.units.get('hero').position = { q: 0, r: 0 };
  const enemy = combat.spawnMonster({ id: 'enemy', name: 'Enemy', baseHp: 30, baseExperience: 1, position: { q: 1, r: 0 } });
  enemy.readyAt = 9999;
  combat.nextReady(['hero', 'enemy']);
  const payload = { skillId: f.skill.id, skillExecution: f.execution, targetId: 'enemy', damage: 5, range: 1, attackType: 'melee' };
  combat.submitSequence('hero', 'attack', payload, { transactionId: 'cast-once', events: [{ offset: ATTACK_IMPACT_OFFSET, kind: 'attack:impact', payload }] });
  return { ...f, hero, combat, enemy, args: { ...f.args, character: hero } };
}

test('queued cast pays at execution exactly once and cancelled cast has no mana debit', () => {
  const f = pendingAttack();
  assert.equal(f.hero.resources.mana, 2);
  const result = f.combat.advanceTimeline(['hero', 'enemy'], { resolve(event, resolveCore) {
    checkSkillExecution(event.payload.skillExecution, f.args);
    spendSkillMana(f.hero, f.source);
    return resolveCore();
  } });
  assert.equal(result.type, 'event');
  assert.equal(f.hero.resources.mana, 0);
  assert.equal(f.enemy.hp, 25);
  const cancelled = pendingAttack();
  const rejection = cancelled.combat.advanceTimeline(['hero', 'enemy'], { resolve() { throw new Error('target left planned anchor'); } });
  assert.equal(rejection.type, 'interrupted');
  assert.equal(cancelled.hero.resources.mana, 2);
  assert.equal(cancelled.enemy.hp, 30);
});

test('combat transaction restores mana if the cast fails after payment', () => {
  const f = pendingAttack();
  const result = f.combat.advanceTimeline(['hero', 'enemy'], { resolve() {
    spendSkillMana(f.hero, f.source);
    throw new Error('failed execution');
  } });
  assert.equal(result.type, 'interrupted');
  assert.equal(f.hero.resources.mana, 2);
  assert.equal(f.enemy.hp, 30);
});

test('exact mana, one point too little, repeated casts and resource save roundtrip', () => {
  const { character, source } = fixture();
  character.resources.mana = 1;
  assert.equal(canPaySkillMana(character.resources.mana, source).affordable, false);
  character.resources.mana = 6;
  for (const remaining of [4, 2, 0]) assert.equal(spendSkillMana(character, source).remainingMana, remaining);
  assert.throws(() => spendSkillMana(character, source), /Za mało many/);
  const restored = new Roster(JSON.parse(JSON.stringify(new Roster([character]).toJSON())));
  assert.equal(restored.get(character.id).resources.mana, 0);
});
