import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCharacter, Roster } from '../src/core/characters.js';
import { MouseSkillBindings, MouseSkillCatalog } from '../src/core/mouse-skills.js';
import { spendSkillMana } from '../src/core/skill-mana.js';
import {
  ACTIVE_AURA_SAVE_SCHEMA_VERSION, buildActiveAuraSnapshot, validateActiveAuraSnapshot,
  migrateMouseSkillSnapshot, validatePendingSkillCommands,
} from '../src/core/hero-control-save.js';

const catalog = new MouseSkillCatalog(JSON.parse(readFileSync(new URL('../data/skill-mouse-bindings.v055.json', import.meta.url))));
const heroIds = ['korgan', 'hadriel', 'ormus'];
const knownSkillsByHero = {
  korgan: ['basic.attack', 'barbarian.bash', 'barbarian.whirlwind'],
  hadriel: ['basic.attack', 'paladin.might', 'paladin.holy_fire'],
  ormus: ['basic.attack', 'necromancer.teeth', 'necromancer.raise_skeleton'],
};
const initialBindings = {
  korgan: { left: 'barbarian.bash', right: 'barbarian.whirlwind' },
  hadriel: { left: 'basic.attack', right: 'paladin.holy_fire' },
  ormus: { left: 'necromancer.teeth', right: 'necromancer.raise_skeleton' },
};
const legacyCatalogIds = new Set(['d2r-mouse-skill-bindings-v0.5.4']);
const mouseOptions = { heroIds, knownSkillsByHero, initialBindings, catalog };
const envelope = () => ({ mouseSkillSchemaVersion: 1, mouseSkillCatalogId: catalog.id,
  mouseSkills: structuredClone(new MouseSkillBindings(mouseOptions).snapshot()) });
const aura = skillId => ({ id: skillId, sourceId: 'hadriel', skillId,
  exclusiveGroup: 'aura:hadriel', originalTurns: null, remainingTurns: null });
const auraOptions = () => ({ heroIds, buffs: [aura('paladin.holy_fire')], catalog });

test('source-paid fractional mana and independent per-hero mouse bindings survive JSON restore', () => {
  const roster = new Roster([
    createCharacter({ id: 'korgan', name: 'Korgan', classId: 'barbarian' }),
    createCharacter({ id: 'hadriel', name: 'Hadriel', classId: 'paladin' }),
    createCharacter({ id: 'ormus', name: 'Ormus', classId: 'necromancer' }),
  ]);
  roster.get('korgan').resources.mana = 15;
  spendSkillMana(roster.get('korgan'), catalog.get('barbarian.whirlwind'));
  spendSkillMana(roster.get('ormus'), catalog.get('necromancer.teeth'));
  const before = { ...envelope(), roster: roster.toJSON() };
  const serialized = JSON.parse(JSON.stringify(before));
  const migration = migrateMouseSkillSnapshot(serialized, { catalog, legacyCatalogIds });
  const restoredBindings = MouseSkillBindings.restore(migration.snapshot, mouseOptions);
  const restoredRoster = new Roster(serialized.roster);
  assert.equal(restoredRoster.get('korgan').resources.mana, 2.5);
  assert.deepEqual(restoredRoster.toJSON(), roster.toJSON());
  for (const id of heroIds) assert.deepEqual(restoredBindings.get(id), initialBindings[id]);
  assert.equal(migration.migrated, false);
});

test('v054 control catalog migration changes only the catalog id, preserving gameplay data', () => {
  const old = envelope();
  old.mouseSkillCatalogId = old.mouseSkills.catalogId = [...legacyCatalogIds][0];
  Object.assign(old, { inventories: [['korgan', { items: ['kept'] }]], equipment: { weapon: 'kept' }, loot: { roll: 47 }, mana: 2.5 });
  const before = structuredClone(old);
  const migrated = migrateMouseSkillSnapshot(old, { catalog, legacyCatalogIds });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.snapshot.catalogId, catalog.id);
  assert.deepEqual(MouseSkillBindings.restore(migrated.snapshot, mouseOptions).snapshot().bindings, old.mouseSkills.bindings);
  assert.deepEqual(old, before);
});

test('legacy save without mouse metadata requests explicit defaults without mutating the save', () => {
  const old = { inventory: ['kept'], mana: 3.5 };
  assert.deepEqual(migrateMouseSkillSnapshot(old, { catalog }), { snapshot: null, migrated: true });
  assert.deepEqual(old, { inventory: ['kept'], mana: 3.5 });
});

test('partial, future, or nested mismatched mouse headers are rejected before migration', () => {
  for (const field of ['mouseSkillSchemaVersion', 'mouseSkillCatalogId', 'mouseSkills']) {
    const broken = envelope(); delete broken[field];
    assert.throws(() => migrateMouseSkillSnapshot(broken, { catalog, legacyCatalogIds }), /Niekompletny/);
  }
  const broken = envelope();
  broken.mouseSkillCatalogId = [...legacyCatalogIds][0];
  broken.mouseSkills.catalogId = 'unknown-nested-catalog';
  assert.throws(() => migrateMouseSkillSnapshot(broken, { catalog, legacyCatalogIds }), /niespójny/);
  broken.mouseSkills.catalogId = broken.mouseSkillCatalogId;
  broken.mouseSkills.schemaVersion = 99;
  assert.throws(() => migrateMouseSkillSnapshot(broken, { catalog, legacyCatalogIds }), /niespójny/);
  assert.throws(() => migrateMouseSkillSnapshot({ ...envelope(), mouseSkillSchemaVersion: 99 }, { catalog }), /Nieobsługiwany/);
});

test('aura index records exactly one own active aura and migration derives it from actual buffs', () => {
  const options = auraOptions();
  const expected = [{ heroId: 'korgan', activeAuraSkillId: null },
    { heroId: 'hadriel', activeAuraSkillId: 'paladin.holy_fire' }, { heroId: 'ormus', activeAuraSkillId: null }];
  assert.deepEqual(buildActiveAuraSnapshot(options), expected);
  assert.deepEqual(validateActiveAuraSnapshot({}, options), { snapshot: expected, migrated: true });
  assert.deepEqual(validateActiveAuraSnapshot({ activeAuraSchemaVersion: ACTIVE_AURA_SAVE_SCHEMA_VERSION, activeAuras: expected }, options),
    { snapshot: expected, migrated: false });
});

test('aura restore rejects forged groups, timed auras and simultaneous own auras', () => {
  for (const mutation of [buff => { buff.exclusiveGroup = null; }, buff => { buff.exclusiveGroup = 'other'; },
    buff => { buff.remainingTurns = 1; }, buff => { buff.originalTurns = 1; }]) {
    const options = auraOptions(); mutation(options.buffs[0]);
    assert.throws(() => buildActiveAuraSnapshot(options), /trwałej grupy/);
  }
  const options = auraOptions(); options.buffs.push(aura('paladin.might'));
  assert.throws(() => buildActiveAuraSnapshot(options), /dwóch własnych aur/);
});

test('saved aura index cannot forge active skill, duplicate heroes, or omit half of its header', () => {
  const options = auraOptions();
  const saved = { activeAuraSchemaVersion: 1, activeAuras: buildActiveAuraSnapshot(options) };
  const forged = structuredClone(saved); forged.activeAuras[1].activeAuraSkillId = 'paladin.might';
  assert.throws(() => validateActiveAuraSnapshot(forged, options), /nie zgadza/);
  const duplicate = structuredClone(saved); duplicate.activeAuras[1].heroId = 'korgan';
  assert.throws(() => validateActiveAuraSnapshot(duplicate, options), /powielony/);
  assert.throws(() => validateActiveAuraSnapshot({ activeAuras: saved.activeAuras }, options), /Niekompletny/);
  assert.throws(() => validateActiveAuraSnapshot({ ...saved, activeAuraSchemaVersion: 99 }, options), /Nieobsługiwany/);
});

test('saved aura index rejects a hero id that is not present in the roster', () => {
  const options = auraOptions();
  const saved = { activeAuraSchemaVersion: 1, activeAuras: buildActiveAuraSnapshot(options) };
  const unknownHero = structuredClone(saved);
  unknownHero.activeAuras[0].heroId = 'ghost';
  assert.throws(() => validateActiveAuraSnapshot(unknownHero, options), /nie zgadza/);
});

function pending({ ranged = false } = {}) {
  const actorId = ranged ? 'ormus' : 'korgan';
  const skillId = ranged ? 'necromancer.teeth' : 'barbarian.bash';
  const execution = { schemaVersion: 1, skillId, skillLevel: 1, side: 'left', weaponFingerprint: ranged ? null : 'weapon' };
  const payload = { skillId, skillExecution: execution, range: ranged ? 8 : 1, attackType: ranged ? 'ranged' : 'melee' };
  const events = [{ kind: ranged ? 'projectile:impact' : 'attack:impact', payload: { ...payload, commandId: 'command-1' } }];
  if (ranged) events.unshift({ kind: 'projectile:step', payload: { commandId: 'command-1' } });
  return { heroIds, knownSkillsByHero, catalog,
    skillDefinitions: { [skillId]: { category: 'offensive', range: ranged ? 8 : 1 } },
    combat: { commands: { active: [{ commandId: 'command-1', actorId, kind: 'attack', transactionId: 'tx-1', payload }],
      history: [], transactions: [['tx-1', { result: { events: structuredClone(events) } }]] }, scheduler: { queue: events } } };
}

test('pending melee and ranged saves retain deferred execution metadata without double-payment data', () => {
  assert.doesNotThrow(() => validatePendingSkillCommands(pending()));
  assert.doesNotThrow(() => validatePendingSkillCommands(pending({ ranged: true })));
});

test('legacy in-flight hero attack is clearly rejected but completed history and monster attacks are allowed', () => {
  const options = pending(); delete options.combat.commands.active[0].payload.skillExecution;
  assert.throws(() => validatePendingSkillCommands(options), /v0.5.5.*rozliczeniu many/);
  options.combat.commands.history = options.combat.commands.active;
  options.combat.commands.active = [];
  assert.doesNotThrow(() => validatePendingSkillCommands(options));
  const monster = pending(); monster.combat.commands.active[0].actorId = 'fallen-1';
  delete monster.combat.commands.active[0].payload.skillExecution;
  assert.doesNotThrow(() => validatePendingSkillCommands(monster));
});

test('pending attack restore rejects forged cost, wrong range and inconsistent impact descriptor', () => {
  const mutations = [
    data => { data.combat.commands.active[0].payload.manaCost = 0; },
    data => { data.combat.commands.active[0].payload.range = 999; },
    data => { data.combat.commands.active[0].payload.attackType = 'ranged'; },
    data => { data.combat.scheduler.queue[0].payload.skillExecution = { ...data.combat.scheduler.queue[0].payload.skillExecution, skillLevel: 999 }; },
    data => { data.combat.commands.transactions[0][1].result.events[0].payload.skillId = 'basic.attack'; },
  ];
  for (const mutate of mutations) {
    const options = pending(); mutate(options);
    assert.throws(() => validatePendingSkillCommands(options), /nielegalnej|niespójny/);
  }
});

test('pending attack restore rejects an unknown skill id before rebuilding the command graph', () => {
  const options = pending();
  options.combat.commands.active[0].payload.skillId = 'barbarian.unknown';
  options.combat.commands.active[0].payload.skillExecution.skillId = 'barbarian.unknown';
  assert.throws(() => validatePendingSkillCommands(options), /Unknown mouse skill/);
});

test('mana restore accepts exact 1/256 values and rejects silent rounding of corrupted resources', () => {
  const hero = createCharacter({ id: 'hero', name: 'Hero', classId: 'barbarian' });
  hero.resources.mana = 2 + 1 / 256;
  assert.equal(new Roster([hero]).get('hero').resources.mana, hero.resources.mana);
  for (const mana of [0.1, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    const broken = structuredClone(hero); broken.resources.mana = mana;
    assert.throws(() => new Roster([broken]), /1\/256/);
  }
});
