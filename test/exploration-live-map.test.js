import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACT1_ENCOUNTERS } from '../data/act1-encounters.v057.js';
import { CampaignState } from '../src/core/campaign.js';
import { EquipmentCatalog } from '../src/core/equipment.js';
import { shortestSectorPath } from '../src/core/exploration.js';

const CAMP = 'act1.rogue_encampment';
const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const catalog = new EquipmentCatalog(JSON.parse(readFileSync(
  new URL('../data/equipment.v051.json', import.meta.url), 'utf8',
)));

function identity(campaign) {
  return {
    expectedAreaId: campaign.act1.currentAreaId,
    expectedSectorId: campaign.act1.exploration.currentSectorId,
    expectedSequence: campaign.act1.exploration.movementSequence,
  };
}

function walk(campaign, targetSectorId) {
  const map = campaign.act1ExplorationMap();
  const path = shortestSectorPath(map, campaign.act1.exploration.currentSectorId, targetSectorId);
  assert.ok(path, `No path to ${targetSectorId}`);
  for (const step of path.slice(1)) {
    const result = campaign.moveAct1Sector(step, identity(campaign));
    if (result.encounterId && result.encounterStatus === 'unvisited') {
      const config = campaign.beginAct1Encounter(result.encounterId, { sectorId: result.sectorId });
      for (const monster of config.monsters) campaign.recordAct1Defeat(monster.id, { hex: monster.position, catalog });
    }
  }
  return path;
}

function takeExit(campaign, targetAreaId) {
  const exit = campaign.act1ExplorationMap().exits.find(item => item.targetAreaId === targetAreaId);
  assert.ok(exit, `No exit to ${targetAreaId}`);
  walk(campaign, exit.sectorId);
  return campaign.travelThroughAct1Exit(targetAreaId, identity(campaign));
}

function neighbors(map, sectorId) {
  return map.edges.flatMap(({ a, b }) => a === sectorId ? [b] : b === sectorId ? [a] : []);
}

test('live map keeps one deterministic world seed and never mutates on public reads', () => {
  const first = new CampaignState({ worldSeed: 0x417b });
  const same = new CampaignState({ worldSeed: 0x417b });
  const different = new CampaignState({ worldSeed: 0x417c });
  const before = first.toJSON();
  assert.deepEqual(first.act1ExplorationMap(MOOR), same.act1ExplorationMap(MOOR));
  assert.notEqual(first.act1ExplorationMap(MOOR).layoutSignature,
    different.act1ExplorationMap(MOOR).layoutSignature);
  first.act1ExplorationView();
  first.act1ExplorationView();
  assert.deepEqual(first.toJSON(), before);
  assert.equal(CampaignState.restoreAct1(before).worldSeed, 0x417b);
});

test('movement reveals the current neighborhood but public fog does not disclose hidden features', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  takeExit(campaign, MOOR);
  const before = campaign.act1ExplorationView();
  const current = before.sectors.find(sector => sector.current);
  const adjacent = before.sectors.filter(sector => neighbors(before.map, current.id).includes(sector.id));
  assert.equal(current.visible, true);
  assert.ok(adjacent.length > 0 && adjacent.every(sector => sector.visible),
    'neighbors of the party are visible');
  assert.ok(before.sectors.some(sector => !sector.discovered), 'the whole area is not revealed at once');
  for (const sector of before.sectors.filter(entry => !entry.discovered)) {
    assert.equal(sector.encounter, null);
    assert.deepEqual(sector.points, []);
    assert.deepEqual(sector.exits, []);
  }

  const next = adjacent[0];
  const priorSequence = campaign.act1.exploration.movementSequence;
  campaign.moveAct1Sector(next.id, identity(campaign));
  assert.equal(campaign.act1.exploration.currentSectorId, next.id);
  assert.equal(campaign.act1.exploration.movementSequence, priorSequence + 1);
  assert.ok(campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds.includes(next.id));
  assert.equal(campaign.act1ExplorationView().sectors.find(sector => sector.current).visible, true);
});

test('known-sector route is atomic, stops at its target and rejects repeated or fogged commands', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  const map = campaign.act1ExplorationMap();
  const exit = map.exits.find(item => item.targetAreaId === MOOR);
  const path = walk(campaign, exit.sectorId);
  const interiorIndex = path.findIndex((sectorId, index) => index > 0 && index < path.length - 1
    && neighbors(map, sectorId).length === 2
    && !map.points.some(item => item.sectorId === sectorId)
    && !map.exits.some(item => item.sectorId === sectorId));
  assert.ok(interiorIndex > 0, 'fixed camp map has a safe two-step known route');
  const sourceId = path[interiorIndex + 1];
  const middleId = path[interiorIndex];
  const targetId = path[interiorIndex - 1];
  walk(campaign, sourceId);
  const command = identity(campaign);
  const result = campaign.moveAct1KnownRoute(targetId, command);
  assert.equal(result.stoppedBy, 'route-end');
  assert.deepEqual(result.traversedSectorIds, [middleId, targetId]);
  assert.equal(campaign.act1.exploration.currentSectorId, targetId);
  const committed = campaign.toJSON();
  assert.throws(() => campaign.moveAct1KnownRoute(sourceId, command), /Nieaktualne/);
  assert.deepEqual(campaign.toJSON(), committed, 'stale double activation changes nothing');
  const fogged = map.sectors.find(sector => !campaign.act1.exploration.areaStates[CAMP]
    .discoveredSectorIds.includes(sector.id));
  assert.ok(fogged, 'a part of the camp remains unknown');
  assert.throws(() => campaign.moveAct1KnownRoute(fogged.id, identity(campaign)), /odkryt|znan/i);
  assert.deepEqual(campaign.toJSON(), committed, 'a fogged route changes nothing');
});

test('encounter halts travel, battle completion returns to the same sector and saves defeated enemies', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  takeExit(campaign, MOOR);
  const map = campaign.act1ExplorationMap();
  const placement = map.encounters.map(item => ({ item,
    path: shortestSectorPath(map, campaign.act1.exploration.currentSectorId, item.sectorId) }))
    .sort((a, b) => a.path.length - b.path.length)[0];
  assert.ok(placement.path.length > 1);
  walk(campaign, placement.path.at(-2));
  const result = campaign.moveAct1KnownRoute(placement.item.sectorId, identity(campaign));
  assert.equal(result.stoppedBy, 'encounter');
  assert.equal(result.encounterId, placement.item.encounterId);
  assert.equal(campaign.act1.exploration.currentSectorId, placement.item.sectorId);
  const pending = campaign.toJSON();
  assert.throws(() => campaign.moveAct1Sector(placement.path.at(-2), identity(campaign)),
    /odkryte starcie/);
  assert.deepEqual(campaign.toJSON(), pending, 'the pending encounter cannot be walked past');
  assert.ok(campaign.act1ExplorationView().sectors.every(sector => !sector.reachable),
    'map controls stay unavailable until the encounter begins');
  campaign.beginAct1Encounter(placement.item.encounterId,
    { sectorId: placement.item.sectorId });
  assert.deepEqual(campaign.act1.exploration.activeBattle,
    { encounterId: placement.item.encounterId, areaId: MOOR, sectorId: placement.item.sectorId });
  assert.throws(() => campaign.moveAct1Sector(placement.path.at(-2)), /aktywnej walki/);

  const encounter = ACT1_ENCOUNTERS.find(item => item.id === placement.item.encounterId);
  for (const monster of encounter.monsters) campaign.recordAct1Defeat(monster.id,
    { hex: monster.position, catalog });
  assert.equal(campaign.act1.exploration.activeBattle, null);
  assert.equal(campaign.act1.exploration.currentSectorId, placement.item.sectorId);
  assert.equal(campaign.act1.encounters[encounter.id].status, 'completed');
  assert.deepEqual(campaign.act1.encounters[encounter.id].defeatedIds,
    encounter.monsters.map(monster => monster.id));

  const saved = campaign.toJSON();
  const restored = CampaignState.restoreAct1(saved, { catalog });
  assert.deepEqual(restored.toJSON(), saved);
  assert.deepEqual(restored.act1ExplorationMap().layoutSignature, map.layoutSignature);
  assert.deepEqual(restored.act1.exploration.areaStates[MOOR].discoveredSectorIds,
    campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds);
  assert.equal(restored.act1.exploration.currentSectorId, placement.item.sectorId);
  assert.deepEqual(restored.act1.encounters[encounter.id].defeatedIds,
    encounter.monsters.map(monster => monster.id));
});

test('Den entry and exit keep independent fog and return to the same Moor entrance', () => {
  const campaign = new CampaignState({ worldSeed: 5150 });
  takeExit(campaign, MOOR);
  const moorMap = campaign.act1ExplorationMap();
  const denEntrance = moorMap.exits.find(item => item.targetAreaId === DEN);
  walk(campaign, denEntrance.sectorId);
  const moorFog = [...campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds];
  const moorSignature = moorMap.layoutSignature;
  campaign.travelThroughAct1Exit(DEN, identity(campaign));
  assert.equal(campaign.act1.currentAreaId, DEN);
  assert.equal(campaign.act1ExplorationMap().profile, 'cave');
  assert.ok(campaign.act1.exploration.areaStates[DEN].discoveredSectorIds.length > 0);
  takeExit(campaign, MOOR);
  assert.equal(campaign.act1.currentAreaId, MOOR);
  assert.equal(campaign.act1.exploration.currentSectorId, denEntrance.sectorId);
  assert.equal(campaign.act1ExplorationMap().layoutSignature, moorSignature);
  assert.deepEqual(campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds, moorFog);
  assert.notStrictEqual(campaign.act1.exploration.areaStates[DEN],
    campaign.act1.exploration.areaStates[MOOR]);

  const saved = campaign.toJSON();
  const restored = CampaignState.restoreAct1(saved);
  assert.deepEqual(restored.toJSON(), saved);
  assert.equal(restored.act1.exploration.currentSectorId, denEntrance.sectorId);
  assert.equal(restored.act1ExplorationMap(DEN).profile, 'cave');
});
