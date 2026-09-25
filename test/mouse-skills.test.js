import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  MOUSE_SKILL_SCHEMA_VERSION,
  MouseSkillBindings,
  MouseSkillCatalog,
  MouseSkillTargetMode,
  defaultMouseBindingsFromLoadouts,
} from '../src/core/mouse-skills.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'skill-mouse-bindings.v055.json'), 'utf8'));
const catalog = new MouseSkillCatalog(payload);

const heroIds = ['korgan', 'hadriel', 'ormus'];
const known = {
  korgan: ['basic.attack', 'barbarian.bash', 'barbarian.battle_orders', 'barbarian.shout', 'barbarian.whirlwind', 'barbarian.leap_attack'],
  hadriel: ['basic.attack', 'paladin.zeal', 'paladin.might', 'paladin.holy_fire', 'paladin.blessed_hammer', 'paladin.smite'],
  ormus: ['basic.attack', 'necromancer.teeth', 'necromancer.raise_skeleton', 'necromancer.clay_golem', 'necromancer.amplify_damage', 'necromancer.corpse_explosion'],
};
const initial = {
  korgan: { left: 'barbarian.bash', right: 'barbarian.battle_orders' },
  hadriel: { left: 'paladin.zeal', right: 'paladin.might' },
  ormus: { left: 'necromancer.teeth', right: 'necromancer.raise_skeleton' },
};

function bindings() {
  return new MouseSkillBindings({ heroIds, knownSkillsByHero: known, initialBindings: initial, catalog });
}


test('source-backed generic Attack is available to every hero on both mouse buttons', () => {
  const attack = catalog.get('basic.attack');
  assert.equal(attack.sourceName, 'Attack');
  assert.equal(attack.sourceId, 0);
  assert.equal(attack.classCode, null);
  assert.equal(catalog.allows('basic.attack', 'left'), true);
  assert.equal(catalog.allows('basic.attack', 'right'), true);
  assert.equal(catalog.targetMode('basic.attack'), MouseSkillTargetMode.WORLD);
  const state = bindings();
  for (const heroId of heroIds) {
    assert.equal(state.available(heroId, 'left').includes('basic.attack'), true);
    assert.equal(state.available(heroId, 'right').includes('basic.attack'), true);
  }
});

test('generated D2R snapshot rules expose exact left/right flags for current Necromancer skills', () => {
  assert.equal(catalog.allows('necromancer.teeth', 'left'), true);
  assert.equal(catalog.allows('necromancer.teeth', 'right'), true);
  assert.equal(catalog.allows('necromancer.raise_skeleton', 'left'), false);
  assert.equal(catalog.allows('necromancer.raise_skeleton', 'right'), true);
  assert.equal(catalog.allows('necromancer.corpse_explosion', 'left'), false);
  assert.equal(catalog.allows('necromancer.corpse_explosion', 'right'), true);
});

test('Paladin aura source rows are right-only and are classified as auras', () => {
  assert.equal(catalog.allows('paladin.might', 'left'), false);
  assert.equal(catalog.allows('paladin.might', 'right'), true);
  assert.equal(catalog.targetMode('paladin.might'), MouseSkillTargetMode.AURA);
  assert.equal(catalog.targetMode('paladin.holy_fire'), MouseSkillTargetMode.AURA);
});

test('Paladin combat skills retain source left/right legality while auras remain right-only', () => {
  for (const id of ['paladin.zeal', 'paladin.smite', 'paladin.blessed_hammer']) {
    assert.equal(catalog.allows(id, 'left'), true);
    assert.equal(catalog.allows(id, 'right'), true);
  }
  for (const id of ['paladin.might', 'paladin.holy_fire']) {
    assert.equal(catalog.allows(id, 'left'), false);
    assert.equal(catalog.allows(id, 'right'), true);
  }
});

test('Druid Maul is legal on both buttons while current summon slice is right-only', () => {
  assert.equal(catalog.allows('druid.maul', 'left'), true);
  assert.equal(catalog.allows('druid.maul', 'right'), true);
  for (const id of ['druid.spirit_wolf', 'druid.oak_sage', 'druid.grizzly']) {
    assert.equal(catalog.allows(id, 'left'), false);
    assert.equal(catalog.allows(id, 'right'), true);
  }
});

test('Barbarian war cries are right-only while Bash and Whirlwind are legal on both buttons', () => {
  for (const id of ['barbarian.battle_orders', 'barbarian.shout']) {
    assert.equal(catalog.allows(id, 'left'), false);
    assert.equal(catalog.allows(id, 'right'), true);
  }
  for (const id of ['barbarian.bash', 'barbarian.whirlwind', 'barbarian.leap_attack']) {
    assert.equal(catalog.allows(id, 'left'), true);
    assert.equal(catalog.allows(id, 'right'), true);
  }
});

test('Corpse-target skills are classified from skills.txt target flags', () => {
  assert.equal(catalog.targetMode('necromancer.raise_skeleton'), MouseSkillTargetMode.CORPSE);
  assert.equal(catalog.targetMode('necromancer.corpse_explosion'), MouseSkillTargetMode.CORPSE);
  assert.equal(catalog.targetMode('necromancer.teeth'), MouseSkillTargetMode.WORLD);
});

test('available skills filter illegal mouse-side assignments without mutating known skill order', () => {
  const state = bindings();
  assert.deepEqual(state.available('ormus', 'left'), ['basic.attack', 'necromancer.teeth']);
  assert.deepEqual(state.available('ormus', 'right'), known.ormus);
  assert.deepEqual(state.knownSkills('ormus'), known.ormus);
});

test('each hero has an independent left/right active skill pair', () => {
  const state = bindings();
  assert.deepEqual(state.get('korgan'), initial.korgan);
  assert.deepEqual(state.get('hadriel'), initial.hadriel);
  assert.deepEqual(state.get('ormus'), initial.ormus);
});

test('switching the active mouse skill is a zero-cost selection change', () => {
  const state = bindings();
  const result = state.assign('korgan', 'right', 'barbarian.shout');
  assert.equal(result.changed, true);
  assert.equal(result.actionCost, 0);
  assert.deepEqual(state.get('korgan'), { left: 'barbarian.bash', right: 'barbarian.shout' });
  assert.deepEqual(state.get('hadriel'), initial.hadriel);
});

test('selecting the same mouse skill is idempotent and zero-cost', () => {
  const state = bindings();
  const before = state.snapshot();
  const result = state.assign('korgan', 'left', 'barbarian.bash');
  assert.equal(result.changed, false);
  assert.equal(result.actionCost, 0);
  assert.deepEqual(state.snapshot(), before);
});


test('generic Attack can replace a class LPM without changing the other mouse side', () => {
  const state = bindings();
  const beforeRight = state.get('korgan').right;
  const result = state.assign('korgan', 'left', 'basic.attack');
  assert.equal(result.changed, true);
  assert.equal(result.actionCost, 0);
  assert.deepEqual(state.get('korgan'), { left: 'basic.attack', right: beforeRight });
});

test('Raise Skeleton cannot be assigned to LPM and rejection is atomic', () => {
  const state = bindings();
  const before = state.snapshot();
  assert.throws(() => state.assign('ormus', 'left', 'necromancer.raise_skeleton'), /not legal on left/);
  assert.deepEqual(state.snapshot(), before);
});

test('a hero cannot bind another class skill even when that mouse side permits it', () => {
  const state = bindings();
  const before = state.snapshot();
  assert.throws(() => state.assign('ormus', 'left', 'barbarian.bash'), /does not know/);
  assert.deepEqual(state.snapshot(), before);
});

test('snapshot round-trip preserves independent assignments exactly', () => {
  const state = bindings();
  state.assign('korgan', 'right', 'barbarian.shout');
  state.assign('hadriel', 'right', 'paladin.holy_fire');
  state.assign('ormus', 'right', 'necromancer.clay_golem');
  const snapshot = state.snapshot();
  assert.equal(snapshot.schemaVersion, MOUSE_SKILL_SCHEMA_VERSION);
  assert.equal(snapshot.catalogId, catalog.id);
  const restored = MouseSkillBindings.restore(snapshot, { heroIds, knownSkillsByHero: known, catalog });
  assert.deepEqual(restored.snapshot(), snapshot);
});

test('restore rejects future schema, catalog mismatch, duplicates, unknown heroes, and illegal sides', () => {
  const snapshot = bindings().snapshot();
  assert.throws(() => MouseSkillBindings.restore({ ...snapshot, schemaVersion: 99 }, { heroIds, knownSkillsByHero: known, catalog }), /Unsupported/);
  assert.throws(() => MouseSkillBindings.restore({ ...snapshot, catalogId: 'other' }, { heroIds, knownSkillsByHero: known, catalog }), /another catalog/);
  const duplicate = structuredClone(snapshot);
  duplicate.bindings[1].heroId = duplicate.bindings[0].heroId;
  assert.throws(() => MouseSkillBindings.restore(duplicate, { heroIds, knownSkillsByHero: known, catalog }), /Duplicate/);
  const unknownHero = structuredClone(snapshot);
  unknownHero.bindings[0].heroId = 'ghost';
  assert.throws(() => MouseSkillBindings.restore(unknownHero, { heroIds, knownSkillsByHero: known, catalog }), /hero set mismatch/);
  const illegal = structuredClone(snapshot);
  illegal.bindings.find(({ heroId }) => heroId === 'ormus').left = 'necromancer.raise_skeleton';
  assert.throws(() => MouseSkillBindings.restore(illegal, { heroIds, knownSkillsByHero: known, catalog }), /not legal on left/);
});

test('default binding migration selects first legal left and first legal right skill from existing loadouts', () => {
  const loadouts = {
    korgan: { left: 'barbarian.bash', right: ['barbarian.battle_orders', 'barbarian.shout', 'barbarian.whirlwind'] },
    hadriel: { left: 'paladin.zeal', right: ['paladin.might', 'paladin.holy_fire', 'paladin.blessed_hammer'] },
    ormus: { left: 'necromancer.teeth', right: ['necromancer.raise_skeleton', 'necromancer.clay_golem', 'necromancer.amplify_damage'] },
  };
  assert.deepEqual(defaultMouseBindingsFromLoadouts(heroIds, id => loadouts[id], catalog), initial);
});

test('catalog rejects malformed source-derived metadata instead of silently accepting it', () => {
  const corrupted = structuredClone(payload);
  corrupted.skills['necromancer.raise_skeleton'].mouse.left = '0';
  assert.throws(() => new MouseSkillCatalog(corrupted), /must be boolean/);
  const ambiguous = structuredClone(payload);
  ambiguous.skills['necromancer.raise_skeleton'].targeting.ally = true;
  assert.throws(() => new MouseSkillCatalog(ambiguous), /ambiguous/);
});

test('source-derived level requirements are retained for later skill-tree gating', () => {
  assert.equal(catalog.get('necromancer.raise_skeleton').requiredLevel, 1);
  assert.equal(catalog.get('necromancer.corpse_explosion').requiredLevel, 6);
  assert.equal(catalog.get('paladin.zeal').requiredLevel, 12);
  assert.equal(catalog.get('barbarian.whirlwind').requiredLevel, 30);
});
