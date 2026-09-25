import test from 'node:test';
import assert from 'node:assert/strict';
import { ACT1_ENCOUNTERS } from '../data/act1-encounters.v057.js';
import { stageAct1Encounter } from '../src/core/act1-encounter.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';
import { CombatState } from '../src/core/combat.js';
import { HexGrid } from '../src/core/hex-grid.js';
import { BattlePreparationState } from '../src/core/battle-preparation.js';
import { PortalSystem, TownPortalScrollSupply, EncounterRules } from '../src/core/portals.js';

// Existing 187-cell battlefield selection, used only as a test fixture; no geometry changes.
function actualTiles() {
  const tiles = [];
  for (let q = -32; q <= 32; q += 1) for (let r = -32; r <= 32; r += 1) {
    if (11 * q + r >= -19 && 11 * q + r <= 203 && 3 * q + 7 * r >= -11 && 3 * q + 7 * r <= 50) tiles.push({ q, r });
  }
  return tiles;
}
const column = p => Math.floor((11 * p.q + p.r + 19) / (11 + 1e-7));
const approvedColumn = p => p.q;
function approvedTiles() {
  const tiles = [];
  for (let column = 0; column < 25; column += 1) {
    for (let row = 0; row < (column % 2 ? 8 : 9); row += 1) {
      tiles.push({ q: column, r: row - Math.floor(column / 2) });
    }
  }
  return tiles;
}
function fixture() {
  const roster = new Roster(['a', 'b', 'c'].map(id => createCharacter({ id, name: id, classId: 'barbarian' })));
  const party = new Party(roster, ['a', 'b', 'c']), players = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting: players, seed: 210 });
  const hexGrid = new HexGrid({ tiles: actualTiles() });
  const left = hexGrid.tiles().filter(tile => column(tile) >= 0 && column(tile) < 3);
  const initialPositions = new Map(party.slots.map((id, index) => [id, left[index]]));
  for (const [id, position] of initialPositions) { hexGrid.addUnit({ id, position }); combat.units.get(id).position = { ...position }; }
  const enemy = combat.spawnMonster({ id: 'fallen-1', name: 'Upadły treningowy', baseHp: 42, baseExperience: 24, position: { q: 10, r: 0 } });
  hexGrid.addUnit({ id: enemy.id, position: enemy.position });
  const preparation = new BattlePreparationState({ heroIds: party.slots, heroPositions: Object.fromEntries(initialPositions),
    loadouts: Object.fromEntries(party.slots.map(id => [id, { left: 'basic.attack', right: [`${id}.buff`, `${id}.other`, `${id}.summon`] }])), deploymentColumnOf: column });
  const portals = new PortalSystem();
  for (const id of party.slots) portals.setCharacterLocation(id, { kind: 'town', town_id: 'act1.rogue_encampment' });
  return { roster, party, players, combat, enemy, hexGrid, preparation, portals, initialPositions, deploymentColumnOf: column };
}
const stage = (f, config = ACT1_ENCOUNTERS[0]) => stageAct1Encounter({ ...f, config });
const state = f => JSON.stringify({ roster: f.roster.toJSON(), combat: f.combat.snapshot(), prep: f.preparation.snapshot(), grid: f.hexGrid.snapshot(), portals: f.portals.toJSON() });
function complete(f) {
  f.preparation.startBattle();
  for (const unit of f.combat.units.values()) if (unit.kind === 'monster') {
    unit.hp = 0; f.combat.grantMonsterExperience(unit.id, f.party.slots); f.hexGrid.removeUnit(unit.id);
  }
  f.preparation.completeBattle();
  return f;
}

test('first authored encounter stages six independent enemies without touching roster, old graph or geometry', () => {
  const f = fixture(); f.roster.get('a').resources.hp = 17; f.roster.get('a').resources.mana = 2;
  const before = state(f), n = stage(f), monsters = [...n.combat.units.values()].filter(unit => unit.kind === 'monster');
  assert.equal(state(f), before); assert.equal(monsters.length, 6);
  assert.equal(new Set(monsters.map(unit => unit.id)).size, 6);
  assert.equal(new Set(monsters.map(unit => `${unit.position.q},${unit.position.r}`)).size, 6);
  assert.equal(n.enemy.id, ACT1_ENCOUNTERS[0].monsters[0].id);
  assert.equal(n.preparation.encounterNumber, 2); assert.equal(n.preparation.phase, 'preparation');
  assert.equal(n.combat.scheduler.queue.length, 0); assert.equal(n.preparation.enemyTurnsEnabled, false);
  assert.deepEqual(n.hexGrid.tiles(), f.hexGrid.tiles()); assert.equal(n.hexGrid.tiles().length, 187);
  assert.deepEqual(n.preparation.snapshot().rules, f.preparation.snapshot().rules);
  assert.deepEqual(n.preparation.snapshot().loadouts, f.preparation.snapshot().loadouts);
  for (const id of f.party.slots) {
    assert.ok(n.preparation.isDeploymentHex(n.hexGrid.positionOf(id)));
    assert.deepEqual(n.hexGrid.positionOf(id), n.combat.units.get(id).position);
    assert.equal(n.portals.locationOf(id).instance_id, ACT1_ENCOUNTERS[0].id);
  }
  for (const unit of monsters) {
    assert.equal(n.preparation.isDeploymentHex(unit.position), false);
    assert.deepEqual(n.hexGrid.positionOf(unit.id), unit.position);
    assert.equal(n.enemyAiById[unit.id].currentTargetId, null);
  }
  monsters[0].hp -= 1;
  assert.equal(monsters[1].hp, 4); assert.equal(monsters[3].hp, 12);
});

test('source HP/EXP are scaled at spawn once for the six enemies', () => {
  const f = fixture(); f.players.set(8);
  const n = stage(f), units = [...n.combat.units.values()].filter(unit => unit.kind === 'monster');
  assert.deepEqual(units.map(unit => unit.hp), [18, 18, 18, 54, 54, 54]);
  assert.deepEqual(units.map(unit => unit.experience), [81, 81, 81, 148, 148, 148]);
  assert.deepEqual(units.map(unit => unit.sourceMonsterCode), ['fallen1', 'fallen1', 'fallen1', 'zombie1', 'zombie1', 'zombie1']);
  assert.ok(units.every(unit => unit.playersSnapshot === 8));
  f.players.set(1);
  assert.equal(units[0].maxHp, 18); assert.equal(units[0].experience, 81);
});

test('individual kills preserve the other enemies and do not end a multi-enemy fight', () => {
  const f = fixture(), n = { ...f, ...stage(f) }; n.preparation.startBattle();
  const ids = ACT1_ENCOUNTERS[0].monsters.map(monster => monster.id);
  for (const id of ids.slice(0, 2)) {
    n.combat.units.get(id).hp = 0;
    n.combat.grantMonsterExperience(id, n.party.slots);
    n.hexGrid.removeUnit(id);
  }
  assert.equal(n.combat.livingEnemyCount(), 4); assert.equal(n.preparation.phase, 'active');
  assert.equal(n.combat.units.get(ids[2]).hp, 4); assert.equal(n.combat.units.get(ids[3]).hp, 12);
  assert.deepEqual(n.combat.grantMonsterExperience(ids[0], n.party.slots), []);
  assert.equal(n.roster.get('a').experience, 12);
  assert.throws(() => stage(n, ACT1_ENCOUNTERS[1]), /zakończ/);
});

test('completed transition retains resources, loadouts and monotonic time; changes encounter identities', () => {
  const f = fixture(), first = { ...f, ...stage(f) }; complete(first);
  first.combat.scheduler.advanceTo(9800); first.combat.units.get('a').readyAt = 10500;
  first.combat.scheduler.sequence = 31;
  first.combat.effects.add({ id: 'old-aura', sourceId: 'a', targetId: 'b', kind: 'aura' });
  first.roster.get('a').resources.hp = 7; first.roster.get('a').resources.mana = 1;
  const before = state(first), n = stage(first, ACT1_ENCOUNTERS[3]);
  assert.equal(state(first), before);
  assert.equal(n.combat.scheduler.time, 10500); assert.equal(n.combat.scheduler.sequence, 31);
  assert.equal(n.preparation.encounterNumber, 5);
  assert.equal(n.combat.battleId, ACT1_ENCOUNTERS[3].id); assert.equal(n.combat.encounterId, ACT1_ENCOUNTERS[3].id);
  assert.equal(n.portals.locationOf('a').area_id, 'act1.den_of_evil');
  assert.deepEqual([...n.combat.units.values()].filter(unit => unit.kind === 'monster').map(unit => unit.hp), [12, 12, 12, 19, 19, 19]);
  assert.equal(n.combat.effects.effects.size, 0);
  assert.doesNotThrow(() => CombatState.restore(n.combat.snapshot(), { party: f.party, playersSetting: f.players }));
});

test('surviving persistent summon identity/state carries, and old portal endpoints close without reviving dead heroes', () => {
  const f = fixture();
  const summonPosition = f.hexGrid.tiles().find(tile => f.preparation.isDeploymentHex(tile) && !f.hexGrid.isBlocked(tile));
  f.preparation.summonUnit({ id: 'existing-pet', ownerId: 'a', kind: 'wolf', skillId: 'a.summon', position: summonPosition, persistent: true });
  f.combat.spawnSummon({ id: 'existing-pet', ownerId: 'a', summonType: 'wolf', sourceSkillId: 'SOURCE_DATA_NOT_FOUND', sourceMonsterCode: 'SOURCE_DATA_NOT_FOUND', position: summonPosition, hp: 5, maxHp: 9 });
  f.hexGrid.addUnit({ id: 'existing-pet', position: summonPosition });
  f.roster.get('c').lifeState = 'corpse'; f.roster.get('c').resources.hp = 0;
  const opened = f.portals.openPortal({ owner: f.roster.get('a'), source: { area_id: 'act1.blood_moor', instance_id: 'training', hex: { q: 5, r: 1 } },
    destinationTown: 'act1.rogue_encampment', campaignProfile: { act: 1 }, difficultyProfile: { difficulty: 'normal', players: 1 },
    scrollSupply: new TownPortalScrollSupply(1), encounterRules: EncounterRules.standard(), isLegalHex: () => true });
  assert.equal(opened.ok, true);
  const before = state(f), n = stage(f);
  assert.equal(state(f), before); assert.equal(n.portals.listActivePortals().length, 0);
  assert.equal(n.preparation.isUnitOnField('c'), false); assert.throws(() => n.hexGrid.positionOf('c'));
  assert.equal(f.roster.get('c').resources.hp, 0);
  assert.equal(n.portals.locationOf('c').area_id, ACT1_ENCOUNTERS[0].areaId);
  assert.equal(n.portals.locationOf('c').instance_id, ACT1_ENCOUNTERS[0].id);
  const pet = n.combat.units.get('existing-pet');
  assert.equal(pet.ownerId, 'a'); assert.equal(pet.hp, 5); assert.equal(pet.maxHp, 9);
  assert.equal(pet.encounterId, ACT1_ENCOUNTERS[0].id);
  assert.deepEqual(pet.position, n.hexGrid.positionOf(pet.id));
  assert.equal(n.preparation.listSummons()[0].id, 'existing-pet');
});

test('changed config, live/unfinished replacement and blocked placement reject atomically', () => {
  const f = fixture(), before = state(f);
  const changed = structuredClone(ACT1_ENCOUNTERS[0]); changed.monsters[0].position = { q: 1, r: 1 };
  assert.throws(() => stage(f, changed), /konfiguracja/); assert.equal(state(f), before);
  const n = { ...f, ...stage(f) };
  assert.throws(() => stage(n), /już/);
  assert.throws(() => stage(n, ACT1_ENCOUNTERS[1]), /zakończ/);
  const blocked = f.hexGrid.snapshot(); blocked.blockedTerrain = ['12,0'];
  f.hexGrid = HexGrid.restore(blocked);
  const blockedBefore = state(f);
  assert.throws(() => stage(f), /Nielegalne/); assert.equal(state(f), blockedBefore);
});

test('a completed 187-cell save enters the next encounter on 213 cells without rewriting its old graph', () => {
  const old = complete(fixture());
  old.roster.get('a').resources.hp = 13;
  old.roster.get('a').resources.mana = 2;
  const rawSave = JSON.stringify({
    combat: old.combat.snapshot(),
    preparation: old.preparation.snapshot(),
    hexGrid: old.hexGrid.snapshot(),
    portals: old.portals.toJSON(),
  });
  const saved = JSON.parse(rawSave);
  assert.equal(HexGrid.restore(saved.hexGrid).tiles().length, 187);
  assert.doesNotThrow(() => BattlePreparationState.restore(saved.preparation, { deploymentColumnOf: column }));

  const nextPositions = new Map([
    ['a', { q: 2, r: 2 }], ['b', { q: 1, r: 4 }], ['c', { q: 0, r: 5 }],
  ]);
  const next = { ...old, ...stageAct1Encounter({
    ...old,
    config: ACT1_ENCOUNTERS[0],
    preparation: BattlePreparationState.restore(saved.preparation,
      { deploymentColumnOf: approvedColumn }),
    hexGrid: new HexGrid({ tiles: approvedTiles() }),
    initialPositions: nextPositions,
    deploymentColumnOf: approvedColumn,
  }) };
  const tiles = next.hexGrid.tiles();
  assert.equal(tiles.length, 213);
  assert.equal(new Set(tiles.map(({ q, r }) => `${q},${r}`)).size, 213);
  assert.equal(tiles.filter((tile) => approvedColumn(tile) < 3).length, 26);
  assert.equal(next.preparation.phase, 'preparation');
  assert.equal(next.roster.get('a').resources.hp, 13);
  assert.equal(next.roster.get('a').resources.mana, 2);
  for (const id of old.party.slots) {
    assert.deepEqual(next.hexGrid.positionOf(id), nextPositions.get(id));
    assert.deepEqual(next.combat.units.get(id).position, nextPositions.get(id));
  }
  assert.equal(JSON.stringify({
    combat: old.combat.snapshot(),
    preparation: old.preparation.snapshot(),
    hexGrid: old.hexGrid.snapshot(),
    portals: old.portals.toJSON(),
  }), rawSave);
});
