import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignState } from '../src/core/campaign.js';
import { EquipmentCatalog } from '../src/core/equipment.js';
import { explorationPoint, shortestSectorPath } from '../src/core/exploration.js';
import { fieldDecorations, findOpenTerrainPath, isOpenTerrainPointPassable,
  isOpenTerrainSegmentPassable, openTerrainObstacles } from '../src/core/open-terrain.js';
import { renderExplorationLandscape } from '../app/exploration-landscape.js';
import { rollBloodMoorEncounter } from '../src/core/random-act1-encounter.js';

const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const catalog = new EquipmentCatalog(JSON.parse(readFileSync(
  new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));

function identity(campaign) {
  return { expectedAreaId: campaign.act1.currentAreaId,
    expectedSectorId: campaign.act1.exploration.currentSectorId,
    expectedSequence: campaign.act1.exploration.movementSequence };
}

function walk(campaign, sectorId) {
  const map = campaign.act1ExplorationMap();
  const path = shortestSectorPath(map, campaign.act1.exploration.currentSectorId, sectorId);
  assert.ok(path);
  for (const id of path.slice(1)) campaign.moveAct1Sector(id, identity(campaign));
}

function follow(campaign, plan) {
  const results = [];
  for (const point of plan.pathPoints.slice(1)) {
    const result = campaign.advanceAct1OpenTerrain(point, identity(campaign));
    results.push(result);
    if (result.stoppedBy) break;
  }
  return results;
}

test('v1 exploration save migrates to a precise center without changing sector IDs or map identity', () => {
  const original = new CampaignState({ worldSeed: 919 });
  original.travelAct1(MOOR);
  const map = original.act1ExplorationMap();
  assert.equal(map.layoutSignature, 'b21e5728');
  const serialized = original.toJSON();
  const worldId = serialized.act1.exploration.worldId;
  const sectorId = serialized.act1.exploration.currentSectorId;
  const signatures = Object.fromEntries(Object.entries(serialized.act1.exploration.areaStates)
    .map(([areaId, state]) => [areaId, state.layoutSignature]));
  serialized.act1.exploration.schemaVersion = 1;
  delete serialized.act1.exploration.currentPosition;
  const migrated = CampaignState.restoreAct1(serialized);
  assert.equal(migrated.act1.exploration.schemaVersion, 3);
  assert.equal(migrated.act1.exploration.worldId, worldId);
  assert.equal(migrated.act1.exploration.currentSectorId, sectorId);
  assert.deepEqual(Object.fromEntries(Object.entries(migrated.act1.exploration.areaStates)
    .map(([areaId, state]) => [areaId, state.layoutSignature])), signatures);
  assert.deepEqual(migrated.act1.exploration.currentPosition,
    explorationPoint(MOOR, map.sectors.find(sector => sector.id === sectorId)));
  assert.equal(migrated.act1ExplorationMap().layoutSignature, map.layoutSignature);
  const next = CampaignState.restoreAct1(migrated.toJSON());
  assert.deepEqual(next.toJSON(), migrated.toJSON());
});

test('off-path point is genuinely reachable, remains canonical and reveals fog step by step', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  campaign.travelAct1(MOOR);
  const start = structuredClone(campaign.act1.exploration.currentPosition);
  const target = { x: start.x + 40, y: start.y + 20 };
  const before = campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds.length;
  const plan = campaign.planAct1OpenTerrain(target, identity(campaign));
  assert.deepEqual(plan.pathPoints[0], start);
  assert.deepEqual(plan.pathPoints.at(-1), target);
  assert.ok(plan.pathPoints.length >= 3, 'movement has intermediate commit points');
  const results = follow(campaign, plan);
  assert.ok(results.every(result => result.stoppedBy === null));
  assert.deepEqual(campaign.act1.exploration.currentPosition, target);
  assert.equal(campaign.act1.exploration.currentSectorId, results.at(-1).sectorId);
  assert.ok(campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds.length >= before);
  assert.equal(campaign.act1.exploration.movementSequence, plan.movementSequence + results.length);
  assert.deepEqual(CampaignState.restoreAct1(campaign.toJSON()).act1.exploration.currentPosition, target);
  const saved = campaign.toJSON();
  assert.throws(() => campaign.advanceAct1OpenTerrain({ x: target.x + 1, y: target.y },
    { ...identity(campaign), expectedSequence: plan.movementSequence }), /Nieaktualne/);
  assert.deepEqual(campaign.toJSON(), saved);
});

test('fog is revealed at the step crossing a sector, before the whole walk completes', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  campaign.travelAct1(MOOR);
  const map = campaign.act1ExplorationMap();
  const neighbor = map.edges.find(edge => edge.a === campaign.act1.exploration.currentSectorId);
  assert.ok(neighbor);
  const target = explorationPoint(MOOR, map.sectors.find(sector => sector.id === neighbor.b));
  const plan = campaign.planAct1OpenTerrain(target, identity(campaign));
  assert.ok(plan.pathPoints.length > 3);
  const before = new Set(campaign.act1.exploration.areaStates[MOOR].discoveredSectorIds);
  const results = follow(campaign, plan);
  const revealIndex = results.findIndex(result => result.newlyDiscoveredSectorIds.length > 0);
  assert.ok(revealIndex >= 0 && revealIndex < results.length - 1,
    'new terrain is revealed during movement, not at the final commit');
  assert.ok(results[revealIndex].newlyDiscoveredSectorIds.every(id => !before.has(id)));
  assert.deepEqual(campaign.act1.exploration.currentPosition, target);
});

test('rock, tree, fence and exterior are solid; legal path bends around rocks', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  const map = campaign.act1ExplorationMap(MOOR);
  const obstacles = openTerrainObstacles(map);
  assert.ok(obstacles.some(item => item.kind === 'rock'));
  assert.ok(obstacles.some(item => item.kind === 'tree'));
  assert.ok(obstacles.some(item => item.kind === 'fence'));
  for (const item of obstacles.filter(item => item.kind !== 'hedge')) {
    const center = item.kind === 'tree' || item.kind === 'rock'
      ? { x: item.x, y: item.y }
      : { x: (item.x1 + item.x2) / 2, y: (item.y1 + item.y2) / 2 };
    assert.equal(isOpenTerrainPointPassable(map, center), false, item.id);
  }
  const rock = obstacles.find(item => item.kind === 'rock');
  const from = { x: rock.x - 35, y: rock.y }, to = { x: rock.x + 35, y: rock.y };
  assert.equal(isOpenTerrainPointPassable(map, from), true);
  assert.equal(isOpenTerrainPointPassable(map, to), true);
  assert.equal(isOpenTerrainSegmentPassable(map, from, to), false);
  const path = findOpenTerrainPath(map, from, to);
  assert.ok(path?.length > 2, 'A* finds a detour');
  assert.deepEqual(path[0], from);
  assert.deepEqual(path.at(-1), to);
  for (let index = 1; index < path.length; index += 1) {
    assert.ok(Math.hypot(path[index].x - path[index - 1].x,
      path[index].y - path[index - 1].y) <= 24 + 1e-7);
    assert.equal(isOpenTerrainSegmentPassable(map, path[index - 1], path[index]), true);
  }
  assert.equal(isOpenTerrainPointPassable(map,
    { x: map.bounds.maxX * 168 + 500, y: map.bounds.maxY * 132 + 500 }), false);
});

test('planned obstacle-edge steps are all executable by the campaign', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  campaign.travelAct1(MOOR);
  const map = campaign.act1ExplorationMap();
  // The long ray grazes rock:sector-001. Its original 8-unit samples missed
  // the rock while a later <=24-unit commit sampled directly on its boundary.
  const from = { x: -1335, y: -2040 }, target = { x: -1205, y: -2040 };
  assert.equal(openTerrainObstacles(map).some(item => item.id === 'rock:sector-001'), true);
  assert.equal(isOpenTerrainPointPassable(map, from), true);
  assert.equal(isOpenTerrainPointPassable(map, target), true);
  campaign.act1.exploration.currentPosition = from;
  const plan = campaign.planAct1OpenTerrain(target, identity(campaign));
  assert.deepEqual(plan.pathPoints[0], from);
  assert.deepEqual(plan.pathPoints.at(-1), target);
  for (const point of plan.pathPoints.slice(1)) {
    const before = campaign.act1.exploration.currentPosition;
    assert.ok(Math.hypot(point.x - before.x, point.y - before.y) > 1e-7);
    assert.ok(Math.hypot(point.x - before.x, point.y - before.y) <= 24 + 1e-7);
    assert.equal(isOpenTerrainSegmentPassable(map, before, point), true);
    campaign.advanceAct1OpenTerrain(point, identity(campaign));
  }
  assert.deepEqual(campaign.act1.exploration.currentPosition, target);
});

test('planned paths around obstacle margins contain no rejected or zero-length steps across seeds', () => {
  let checked = 0;
  for (const worldSeed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 919, 1597]) {
    const map = new CampaignState({ worldSeed }).act1ExplorationMap(MOOR);
    for (const rock of openTerrainObstacles(map).filter(item => item.kind === 'rock').slice(0, 4)) {
      for (const offset of [-.1, 0, .1]) {
        const from = { x: rock.x - 65, y: rock.y - 15 + offset };
        const target = { x: rock.x + 65, y: rock.y - 15 + offset };
        if (!isOpenTerrainPointPassable(map, from) || !isOpenTerrainPointPassable(map, target)) continue;
        const path = findOpenTerrainPath(map, from, target);
        if (!path) continue;
        checked += 1;
        for (let index = 1; index < path.length; index += 1) {
          const distance = Math.hypot(path[index].x - path[index - 1].x,
            path[index].y - path[index - 1].y);
          assert.ok(distance > 1e-7 && distance <= 24 + 1e-7,
            `seed ${worldSeed}, ${rock.id}, step ${index}: ${distance}`);
          assert.equal(isOpenTerrainSegmentPassable(map, path[index - 1], path[index]), true,
            `seed ${worldSeed}, ${rock.id}, step ${index}`);
        }
      }
    }
  }
  assert.ok(checked >= 100, `only ${checked} candidate paths were available`);
});

test('rendered rocks, trees and fences use the exact geometry consumed by navigation', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  campaign.travelAct1(MOOR);
  const view = campaign.act1ExplorationView();
  const markup = renderExplorationLandscape(view).markup;
  const visible = view.sectors.filter(sector => sector.discovered);
  for (const sector of visible) {
    const details = fieldDecorations(view.map, sector);
    if (details.bushes.some(item => item.tree)) assert.match(markup, new RegExp(`data-obstacle-id="tree:${sector.id}"`));
    if (details.rock) assert.match(markup, new RegExp(`data-obstacle-id="rock:${sector.id}"`));
    if (details.fence) assert.match(markup, new RegExp(`data-obstacle-id="fence:${sector.id}"`));
  }
});

test('cave keeps legal corridors and rejects open-ground movement', () => {
  const campaign = new CampaignState({ worldSeed: 919 });
  campaign.travelAct1(MOOR);
  campaign.travelAct1(DEN);
  const map = campaign.act1ExplorationMap();
  const current = campaign.act1.exploration.currentSectorId;
  const adjacent = map.edges.find(edge => edge.a === current || edge.b === current);
  assert.ok(adjacent);
  const next = adjacent.a === current ? adjacent.b : adjacent.a;
  const nonAdjacent = map.sectors.find(sector => sector.id !== current && sector.id !== next
    && !map.edges.some(edge => (edge.a === current && edge.b === sector.id)
      || (edge.b === current && edge.a === sector.id)));
  assert.ok(nonAdjacent);
  assert.throws(() => campaign.planAct1OpenTerrain({ x: 0, y: 0 }, identity(campaign)), /Wrzosowiska/);
  assert.throws(() => campaign.moveAct1Sector(nonAdjacent.id, identity(campaign)), /sąsiedniego/);
  campaign.moveAct1Sector(next, identity(campaign));
  assert.deepEqual(campaign.act1.exploration.currentPosition,
    explorationPoint(DEN, map.sectors.find(sector => sector.id === next)));
});

test('a free open-ground walk stops precisely at a seeded encounter and battle keeps its exact point', () => {
  const seed = 919;
  const initial = new CampaignState({ worldSeed: seed });
  initial.travelAct1(MOOR);
  const map = initial.act1ExplorationMap();
  const candidates = map.sectors.filter(sector => !map.encounters.some(item => item.sectorId === sector.id)
    && !map.exits.some(item => item.sectorId === sector.id)
    && rollBloodMoorEncounter({ worldSeed: seed, sectorId: sector.id }).result.outcome === 'encounter')
    .sort((a, b) => (shortestSectorPath(map, map.startSectorId, a.id)?.length ?? Infinity)
      - (shortestSectorPath(map, map.startSectorId, b.id)?.length ?? Infinity));
  let selected = null;
  for (const sector of candidates) {
    const candidate = CampaignState.restoreAct1(initial.toJSON(), { catalog });
    let plan;
    try { plan = candidate.planAct1OpenTerrain(explorationPoint(MOOR, sector), identity(candidate)); }
    catch { continue; }
    for (const point of plan.pathPoints.slice(1)) {
      const result = candidate.advanceAct1OpenTerrain(point, identity(candidate));
      if (result.stoppedBy === 'encounter') {
        selected = { campaign: candidate, encounter: result };
        break;
      }
      if (result.stoppedBy) break;
    }
    if (selected) break;
  }
  assert.ok(selected, 'a direct free-ground path reaches a first-entry random encounter');
  const { campaign, encounter } = selected;
  assert.ok(['normal', 'champion'].includes(encounter.encounterKind));
  const exactEntry = structuredClone(campaign.act1.exploration.currentPosition);
  const config = campaign.beginAct1Encounter(encounter.encounterId, { sectorId: encounter.sectorId });
  assert.deepEqual(campaign.act1.exploration.currentPosition, exactEntry);
  for (const monster of config.monsters) campaign.recordAct1Defeat(monster.id,
    { hex: monster.position, catalog });
  assert.equal(campaign.act1.encounters[config.id].status, 'completed');
  const restored = CampaignState.restoreAct1(campaign.toJSON(), { catalog });
  assert.deepEqual(restored.act1.exploration.currentPosition, exactEntry);
  assert.equal(restored.act1.encounters[config.id].status, 'completed');
  assert.ok(restored.act1ExplorationView().sectors.some(sector => sector.encounter?.encounterId === config.id));
});
