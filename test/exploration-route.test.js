import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignState } from '../src/core/campaign.js';
import { EquipmentCatalog } from '../src/core/equipment.js';
import { shortestSectorPath } from '../src/core/exploration.js';
import { rollBloodMoorEncounter } from '../src/core/random-act1-encounter.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(
  new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));

function identity(campaign) {
  const state = campaign.act1.exploration;
  return { expectedAreaId: campaign.act1.currentAreaId, expectedSectorId: state.currentSectorId, expectedSequence: state.movementSequence };
}

function neighbors(map, sectorId) {
  return map.edges.flatMap(edge => edge.a === sectorId ? [edge.b] : edge.b === sectorId ? [edge.a] : []);
}

function resolveEncounter(campaign, encounterId, sectorId) {
  const config = campaign.beginAct1Encounter(encounterId, { sectorId });
  for (const monster of config.monsters) campaign.recordAct1Defeat(monster.id,
    { hex:monster.position, catalog });
}

function walk(campaign, targetId) {
  const map = campaign.act1ExplorationMap();
  const path = shortestSectorPath(map, campaign.act1.exploration.currentSectorId, targetId);
  assert.ok(path, `safe setup route exists to ${targetId}`);
  for (const sectorId of path.slice(1)) {
    const moved = campaign.moveAct1Sector(sectorId, identity(campaign));
    if (moved.encounterId && moved.encounterStatus === 'unvisited')
      resolveEncounter(campaign, moved.encounterId, sectorId);
  }
}

test('a short route is atomic and advances through the unchanged adjacent-sector rules', () => {
  const campaign = new CampaignState({ worldSeed: 7007 });
  const map = campaign.act1ExplorationMap();
  const blocked = new Set(map.exits.map(exit => exit.sectorId));
  const start = campaign.act1.exploration.currentSectorId;
  let route = null;
  for (const first of neighbors(map, start)) for (const second of neighbors(map, first)) {
    if (second !== start && !blocked.has(first) && !blocked.has(second)) {
      route = [first, second];
      break;
    }
  }
  assert.ok(route, 'camp has a two-step non-exit road for the route command');
  const sequence = campaign.act1.exploration.movementSequence;
  const result = campaign.moveAct1Route(route, identity(campaign));
  assert.deepEqual(result.traversedSectorIds, route);
  assert.equal(result.stoppedBy, 'route-end');
  assert.equal(campaign.act1.exploration.currentSectorId, route[1]);
  assert.equal(campaign.act1.exploration.movementSequence, sequence + 2);

  const rejected = new CampaignState({ worldSeed: 7007 });
  const before = rejected.toJSON();
  const far = map.sectors.find(sector => (shortestSectorPath(map, route[0], sector.id)?.length ?? 0) > 2);
  assert.ok(far, 'a non-adjacent second step exists');
  assert.throws(() => rejected.moveAct1Route([route[0], far.id], identity(rejected)), /sąsiedniego/);
  assert.deepEqual(rejected.toJSON(), before, 'a rejected later step commits no part of the route');
});

test('a route stops at its first unvisited encounter or exit instead of passing it', () => {
  const encounterCampaign = new CampaignState({ worldSeed: 919 });
  encounterCampaign.travelAct1('act1.blood_moor');
  const encounterMap = encounterCampaign.act1ExplorationMap();
  const encounterApproach = encounterMap.encounters.flatMap(encounter =>
    neighbors(encounterMap, encounter.sectorId).map(id => ({
      id, encounterSectorId:encounter.sectorId,
      path:shortestSectorPath(encounterMap, encounterCampaign.act1.exploration.currentSectorId, id),
    }))).find(candidate => candidate.path);
  assert.ok(encounterApproach, 'an encounter can be approached without entering its sector');
  walk(encounterCampaign, encounterApproach.id);
  const encounterResult = encounterCampaign.moveAct1Route([encounterApproach.encounterSectorId, encounterApproach.id], identity(encounterCampaign));
  assert.deepEqual(encounterResult.traversedSectorIds, [encounterApproach.encounterSectorId]);
  assert.equal(encounterResult.stoppedBy, 'encounter');
  assert.equal(encounterCampaign.act1.exploration.currentSectorId, encounterApproach.encounterSectorId);

  const exitCampaign = new CampaignState({ worldSeed: 7007 });
  const exitMap = exitCampaign.act1ExplorationMap();
  const exitSectorId = exitMap.exits[0].sectorId;
  const exitApproach = neighbors(exitMap, exitSectorId)
    .map(id => ({ id, path: shortestSectorPath(exitMap, exitCampaign.act1.exploration.currentSectorId, id) }))
    .find(candidate => candidate.path);
  assert.ok(exitApproach, 'an exit can be approached without entering its sector');
  walk(exitCampaign, exitApproach.id);
  const exitResult = exitCampaign.moveAct1Route([exitSectorId, exitApproach.id], identity(exitCampaign));
  assert.deepEqual(exitResult.traversedSectorIds, [exitSectorId]);
  assert.equal(exitResult.stoppedBy, 'exit');
  assert.equal(exitCampaign.act1.exploration.currentSectorId, exitSectorId);
});
