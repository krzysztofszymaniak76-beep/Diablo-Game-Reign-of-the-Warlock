import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter, Roster } from '../src/core/characters.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';
import { CombatState } from '../src/core/combat.js';

test('clicked zero-row hex resolves the same attack live and after JSON save/load', () => {
  for (const attackType of ['melee', 'ranged']) {
    const roster = new Roster([createCharacter({ id: 'hero', name: 'Hero', classId: 'paladin' })]);
    const party = new Party(roster, ['hero']), playersSetting = new PlayersSetting(1);
    const combat = new CombatState({ party, playersSetting });
    combat.units.get('hero').position = { q: 0, r: 0 };
    combat.spawnMonster({ id: 'enemy', name: 'Enemy', baseHp: 10, baseExperience: 1, position: { q: 1, r: 0 } });
    combat.nextReady(['hero']);
    // screenToHex/cubeRound legitimately yields -0 along a zero coordinate.
    const impactHex = { q: 1, r: -0 };
    const payload = { targetId: 'enemy', damage: 3, attackType, impactHex };
    if (attackType === 'ranged') {
      combat.submitProjectile('hero', payload, { from: { q: 0, r: 0 }, to: impactHex });
    } else {
      combat.submitSequence('hero', 'attack', payload, {
        events: [{ offset: 450, kind: 'attack:impact', payload }],
      });
    }
    const save = JSON.parse(JSON.stringify(combat.snapshot()));
    const restored = CombatState.restore(save, { party, playersSetting });
    for (const [label, runtime] of [['live', combat], ['restored', restored]]) {
      const result = runtime.advanceTimeline([]);
      assert.equal(result.type, 'event', `${attackType} ${label}: ${result.error?.message ?? ''}`);
      assert.equal(runtime.units.get('enemy').hp, 7, `${attackType} ${label} deals damage once`);
      assert.equal(runtime.commandHistory.at(-1).status, 'effects-complete');
    }
    assert.deepEqual(JSON.parse(JSON.stringify(combat.snapshot())), JSON.parse(JSON.stringify(restored.snapshot())));
  }
});

test('signed-zero equivalence does not permit changing a real target or damage value', () => {
  const roster = new Roster([createCharacter({ id: 'hero', name: 'Hero', classId: 'paladin' })]);
  const party = new Party(roster, ['hero']), playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting });
  combat.spawnMonster({ id: 'enemy', name: 'Enemy', baseHp: 10, baseExperience: 1, position: { q: 1, r: 0 } });
  combat.nextReady(['hero']);
  const payload = { targetId: 'enemy', damage: 3, impactHex: { q: 1, r: -0 } };
  const command = combat.submitSequence('hero', 'attack', payload, {
    events: [{ offset: 450, kind: 'attack:impact', payload }],
  });
  combat.activeCommands.get(command.commandId).payload.damage = 999;
  const result = combat.advanceTimeline([]);
  assert.equal(result.type, 'interrupted');
  assert.match(result.error.message, /Command payload disagrees/);
  assert.equal(combat.units.get('enemy').hp, 10);
});
