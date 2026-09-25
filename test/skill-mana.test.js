import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MouseSkillCatalog } from '../src/core/mouse-skills.js';
import { canPaySkillMana, formatMana, skillManaProfile, spendSkillMana } from '../src/core/skill-mana.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'skill-mouse-bindings.v055.json'), 'utf8'));
const catalog = new MouseSkillCatalog(payload);

test('source mana fields are retained for runtime mouse skills', () => {
  assert.deepEqual(catalog.get('necromancer.teeth').mana, {
    useOnDo: false,
    start: 0,
    minimum: 1,
    shift: 7,
    base: 6,
    perLevel: 1,
  });
  assert.deepEqual(catalog.get('barbarian.whirlwind').mana, {
    useOnDo: false,
    start: 0,
    minimum: 1,
    shift: 7,
    base: 25,
    perLevel: 1,
  });
});

test('mana formula preserves D2 fixed-point shifts and per-level growth', () => {
  assert.equal(skillManaProfile(catalog.get('basic.attack'), 1).cost, 0);
  assert.equal(skillManaProfile(catalog.get('necromancer.teeth'), 1).cost, 3);
  assert.equal(skillManaProfile(catalog.get('necromancer.teeth'), 2).cost, 3.5);
  assert.equal(skillManaProfile(catalog.get('barbarian.whirlwind'), 1).cost, 12.5);
  assert.equal(skillManaProfile(catalog.get('barbarian.whirlwind'), 2).cost, 13);
  assert.equal(skillManaProfile(catalog.get('paladin.blessed_hammer'), 1).cost, 5);
});

test('minimum mana floors a positive decreasing cost but does not invent cost at raw zero', () => {
  const synthetic = {
    mana: { useOnDo: false, start: 0, minimum: 1, shift: 5, base: 12, perLevel: -1 },
  };
  assert.equal(skillManaProfile(synthetic, 1).cost, 1.5);
  assert.equal(skillManaProfile(synthetic, 5).cost, 1);
  assert.equal(skillManaProfile(synthetic, 12).cost, 1);
  assert.equal(skillManaProfile(synthetic, 13).cost, 0);
  assert.equal(skillManaProfile(synthetic, 99).cost, 0);
});

test('zero-mana auras remain free even when source minmana is one', () => {
  assert.equal(skillManaProfile(catalog.get('paladin.might'), 1).cost, 0);
  assert.equal(skillManaProfile(catalog.get('paladin.holy_fire'), 1).cost, 0);
});

test('startmana is a cast requirement but is not added to the paid cost', () => {
  const synthetic = {
    mana: { useOnDo: false, start: 8, minimum: 1, shift: 8, base: 3, perLevel: 0 },
  };
  assert.equal(canPaySkillMana(7, synthetic).affordable, false);
  assert.equal(canPaySkillMana(8, synthetic).affordable, true);
  const actor = { resources: { mana: 8 } };
  const spent = spendSkillMana(actor, synthetic);
  assert.equal(spent.cost, 3);
  assert.equal(actor.resources.mana, 5);
});

test('failed mana payment is atomic and successful payment may be fractional', () => {
  const whirlwind = catalog.get('barbarian.whirlwind');
  const actor = { resources: { mana: 10 } };
  assert.throws(() => spendSkillMana(actor, whirlwind), /Za mało many/);
  assert.equal(actor.resources.mana, 10);
  actor.resources.mana = 15;
  const result = spendSkillMana(actor, whirlwind);
  assert.equal(result.cost, 12.5);
  assert.equal(actor.resources.mana, 2.5);
  assert.equal(formatMana(actor.resources.mana), '2,5');
});

test('mana validation rejects values outside the source fixed-point precision', () => {
  const source = catalog.get('necromancer.teeth');
  assert.throws(() => canPaySkillMana(3.001, source), /1\/256/);
  assert.throws(() => canPaySkillMana(0.1, source), /1\/256/);
  assert.equal(canPaySkillMana(3 + 1 / 256, source).affordable, true);
});
