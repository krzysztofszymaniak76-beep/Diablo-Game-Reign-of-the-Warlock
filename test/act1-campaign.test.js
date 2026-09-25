import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACT1_WORLD_SCHEMA_VERSION, CampaignState } from '../src/core/campaign.js';
import { ACT1_AREAS, ACT1_ENCOUNTERS, ACT1_MONSTERS } from '../data/act1-encounters.v057.js';
import { Roster, createCharacter } from '../src/core/characters.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { HoradricCubeState } from '../src/core/cube.js';
import { EquipmentCatalog, createEquipmentItem, validateEquipmentWorld } from '../src/core/equipment.js';
import { explorationPoint, shortestSectorPath } from '../src/core/exploration.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const CAMP = 'act1.rogue_encampment', MOOR = 'act1.blood_moor', COLD = 'act1.cold_plains', DEN = 'act1.den_of_evil';
function fixture() {
  const roster = new Roster(['a', 'b', 'c'].map(id => createCharacter({ id, name: id, classId: 'barbarian' })));
  return { campaign: new CampaignState(), roster, inventories: new Map(roster.toJSON().map(h => [h.id, new InventoryGrid()])), catalog };
}
function enter(f) {
  f.campaign.travelAct1(MOOR);
  const config = f.campaign.nextAct1Encounter();
  f.campaign.beginAct1Encounter(config.id);
  return config;
}
function defeat(f, monster) { return f.campaign.recordAct1Defeat(monster.id, { hex: monster.position, catalog }); }
function finish(f, config) { for (const monster of config.monsters) defeat(f, monster); return f; }
function take(f, dropId, characterId = 'a', extra = {}) {
  const character = f.roster.get(characterId);
  return f.campaign.stageAct1Pickup({ dropId, character, inventory: f.inventories.get(characterId),
    ownedIds: validateEquipmentWorld(f.roster, f.inventories, catalog), catalog, phase: 'completed', ...extra });
}
function commitPickup(f, result, characterId = 'a') {
  f.campaign = result.campaign;
  f.inventories.set(characterId, result.inventory);
  f.roster.get(characterId).inventoryItemIds = result.inventoryItemIds;
}
const snapshot = f => JSON.stringify({ campaign: f.campaign.toJSON(), roster: f.roster.toJSON(),
  inventories: [...f.inventories].map(([id, value]) => [id, value.toJSON()]) });
function moveToSector(campaign, sectorId) {
  const map = campaign.act1ExplorationMap();
  const path = shortestSectorPath(map, campaign.act1.exploration.currentSectorId, sectorId);
  assert.ok(path);
  for (const step of path.slice(1)) campaign.moveAct1Sector(step);
}
function activateAreaWaypoint(campaign) {
  const waypoint = campaign.act1ExplorationMap().points.find(point => point.kind === 'waypoint');
  assert.ok(waypoint);
  moveToSector(campaign, waypoint.sectorId);
  assert.deepEqual(campaign.activateCurrentWaypoint(), waypoint);
  return waypoint;
}
function activateCampAndColdPlains(campaign) {
  const camp = activateAreaWaypoint(campaign);
  campaign.travelAct1(MOOR);
  campaign.travelAct1(COLD);
  const cold = activateAreaWaypoint(campaign);
  return { camp, cold };
}

test('Act I config has stable individual identities, source rewards and legal six-unit formations', () => {
  const identities = new Set();
  let expPerHero = 0;
  assert.equal(ACT1_ENCOUNTERS.length, 8);
  for (const config of ACT1_ENCOUNTERS) {
    assert.equal(identities.has(config.id), false); identities.add(config.id);
    assert.equal(config.monsters.length, 6);
    const positions = new Set();
    for (const monster of config.monsters) {
      assert.equal(identities.has(monster.id), false); identities.add(monster.id);
      const { q, r } = monster.position, u = 11 * q + r, v = 3 * q + 7 * r;
      assert(u >= -19 && u <= 203 && v >= -11 && v <= 50);
      assert(Math.floor((u + 19) / (11 + 1e-7)) >= 3);
      assert.equal(positions.has(`${q},${r}`), false); positions.add(`${q},${r}`);
      expPerHero += Math.floor(ACT1_MONSTERS[monster.profileId].baseExperience / 3);
    }
  }
  assert.equal(identities.size, 56); assert.equal(expPerHero, 558);
  assert.deepEqual(Object.values(ACT1_MONSTERS).map(m => m.baseExperience), [18, 33, 48]);
});

test('new campaign begins in safe camp with no battle or fabricated loot', () => {
  const f = fixture();
  assert.equal(f.campaign.act1.currentAreaId, CAMP);
  assert.equal(f.campaign.act1.currentEncounterId, null);
  assert.deepEqual(f.campaign.act1.visitedAreaIds, [CAMP]);
  assert.equal(f.campaign.nextAct1Encounter(), null);
  assert.deepEqual(f.campaign.groundAct1Drops(), []);
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('travel accepts only adjacent areas and preserves hero resources, equipment and EXP', () => {
  const f = fixture(), h = f.roster.get('a');
  h.resources.hp = 7; h.resources.mana = 0; h.experience = 70;
  const heroes = structuredClone(f.roster.toJSON()), before = snapshot(f);
  assert.throws(() => f.campaign.travelAct1(DEN), /połączenia/);
  assert.throws(() => f.campaign.travelAct1('not-an-area'), /połączenia/);
  assert.equal(snapshot(f), before);
  f.campaign.travelAct1(MOOR); f.campaign.travelAct1(DEN); f.campaign.travelAct1(MOOR); f.campaign.travelAct1(CAMP);
  assert.deepEqual(f.campaign.act1.visitedAreaIds, [CAMP, MOOR, DEN]);
  assert.deepEqual(f.roster.toJSON(), heroes);
});

test('begin requires its area and an unvisited encounter; active combat blocks travel and another fight', () => {
  const f = fixture(), before = snapshot(f);
  assert.throws(() => f.campaign.beginAct1Encounter(ACT1_ENCOUNTERS[0].id));
  assert.equal(snapshot(f), before);
  const config = enter(f), active = snapshot(f);
  assert.throws(() => f.campaign.travelAct1(CAMP), /zakończ/);
  assert.throws(() => f.campaign.beginAct1Encounter(ACT1_ENCOUNTERS[1].id), /trwa/);
  assert.throws(() => f.campaign.beginAct1Encounter(config.id));
  assert.equal(snapshot(f), active);
});

test('one death creates one receipt but does not complete a six-monster encounter', () => {
  const f = fixture(), config = enter(f), result = defeat(f, config.monsters[0]);
  assert.equal(result.recorded, true); assert.equal(result.completed, false);
  assert.equal(f.campaign.act1.encounters[config.id].status, 'active');
  assert.deepEqual(f.campaign.act1.encounters[config.id].defeatedIds, [config.monsters[0].id]);
  assert.equal(result.drop.item.canonicalId, 'short_sword');
  assert.equal(result.drop.id, `act1.loot.${config.monsters[0].id}`);
  assert.equal(result.drop.instanceId, config.id);
});

test('wrong-area, unknown or unstarted monsters cannot receive receipts', () => {
  const f = fixture(), before = snapshot(f);
  assert.throws(() => defeat(f, ACT1_ENCOUNTERS[0].monsters[0]));
  assert.equal(snapshot(f), before);
  enter(f); const active = snapshot(f);
  assert.throws(() => defeat(f, ACT1_ENCOUNTERS[3].monsters[0]));
  assert.throws(() => defeat(f, { id: 'fallen-1', position: { q: 10, r: 1 } }));
  assert.equal(snapshot(f), active);
});

test('invalid death hex or missing catalogue cannot partially publish a receipt', () => {
  const f = fixture(), config = enter(f), before = snapshot(f);
  assert.throws(() => f.campaign.recordAct1Defeat(config.monsters[0].id, { hex: { q: 1.5, r: 0 }, catalog }));
  assert.throws(() => f.campaign.recordAct1Defeat(config.monsters[0].id, { hex: config.monsters[0].position }));
  assert.equal(snapshot(f), before);
});

test('loot base selection depends on stable monster identity, not kill order', () => {
  const f = fixture(), config = enter(f);
  const last = defeat(f, config.monsters[5]);
  const first = defeat(f, config.monsters[0]);
  assert.equal(last.drop.item.canonicalId, 'buckler');
  assert.equal(first.drop.item.canonicalId, 'short_sword');
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('last death completes encounter, and repeated reconciliation never recreates a reward', () => {
  const f = fixture(), config = enter(f);
  finish(f, config);
  assert.equal(f.campaign.act1.encounters[config.id].status, 'completed');
  const before = snapshot(f), again = defeat(f, config.monsters[0]);
  assert.equal(again.recorded, false); assert.equal(again.completed, true);
  assert.equal(snapshot(f), before);
  assert.throws(() => f.campaign.beginAct1Encounter(config.id));
  assert.equal(f.campaign.nextAct1Encounter().id, ACT1_ENCOUNTERS[1].id);
});

test('camp roundtrip preserves completed runtime identity and area-owned ground loot', () => {
  const f = fixture(), config = enter(f); finish(f, config);
  const receipts = structuredClone(f.campaign.act1.encounters[config.id]);
  f.campaign.travelAct1(CAMP);
  assert.equal(f.campaign.act1.currentEncounterId, config.id);
  assert.deepEqual(f.campaign.groundAct1Drops(), []);
  assert.deepEqual(f.campaign.groundAct1Drops(MOOR), []);
  f.campaign.travelAct1(MOOR); f.campaign.travelAct1(DEN);
  assert.deepEqual(f.campaign.groundAct1Drops(), []);
  f.campaign.travelAct1(MOOR);
  assert.equal(f.campaign.groundAct1Drops().length, 6);
  assert.deepEqual(f.campaign.act1.encounters[config.id], receipts);
});

test('pickup stages independently then transfers exactly one existing item without EXP or healing', () => {
  const f = fixture(), config = enter(f); finish(f, config);
  const h = f.roster.get('a'); h.resources.hp = 4; h.resources.mana = 0;
  const before = snapshot(f), resources = structuredClone(h.resources), xp = h.experience;
  const drop = f.campaign.groundAct1Drops()[0], result = take(f, drop.id);
  assert.equal(snapshot(f), before); assert(result.campaign instanceof CampaignState);
  commitPickup(f, result);
  assert.equal(f.campaign.groundAct1Drops().length, 5);
  assert.deepEqual(h.inventoryItemIds, [drop.id]);
  assert.equal(h.experience, xp); assert.deepEqual(h.resources, resources);
  assert.equal(f.campaign.validateAct1World(f), true);
  const after = snapshot(f);
  assert.throws(() => take(f, drop.id), /zebrany/);
  assert.equal(snapshot(f), after);
});

test('active, dead, remote and town pickups fail without mutation', () => {
  const f = fixture(), config = enter(f); defeat(f, config.monsters[0]);
  const drop = f.campaign.groundAct1Drops()[0];
  let before = snapshot(f); assert.throws(() => take(f, drop.id)); assert.equal(snapshot(f), before);
  finish(f, config); f.roster.markDead('a');
  before = snapshot(f); assert.throws(() => take(f, drop.id), /żywy/); assert.equal(snapshot(f), before);
  f.campaign.travelAct1(DEN);
  before = snapshot(f); assert.throws(() => take(f, drop.id, 'b'), /lokacji/); assert.equal(snapshot(f), before);
  f.campaign.travelAct1(MOOR); f.campaign.travelAct1(CAMP);
  before = snapshot(f); assert.throws(() => take(f, drop.id, 'b')); assert.equal(snapshot(f), before);
});

test('full inventory and duplicate ownership reject pickup without consuming the ground item', () => {
  const f = fixture(), config = enter(f); finish(f, config);
  const drop = f.campaign.groundAct1Drops()[0], before = snapshot(f);
  assert.throws(() => take(f, drop.id, 'a', { inventory: new InventoryGrid({ width: 1, height: 1 }) }), /Brak miejsca/);
  assert.throws(() => take(f, drop.id, 'a', { ownedIds: [drop.id] }), /Powielony/);
  assert.equal(snapshot(f), before);
});

test('next fight keeps earlier ground items and cannot collect while the next fight is active', () => {
  const f = fixture(), first = enter(f); finish(f, first);
  const drop = f.campaign.groundAct1Drops()[0], next = f.campaign.nextAct1Encounter();
  f.campaign.beginAct1Encounter(next.id);
  assert.equal(f.campaign.groundAct1Drops().length, 6);
  assert.throws(() => take(f, drop.id));
  finish(f, next);
  assert.equal(f.campaign.groundAct1Drops().length, 12);
  commitPickup(f, take(f, drop.id));
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('partial and completed saves restore exactly, including dormant fight and collected loot', () => {
  const f = fixture(), config = enter(f); defeat(f, config.monsters[2]);
  let raw = f.campaign.toJSON();
  assert.deepEqual(CampaignState.restoreAct1(raw, { catalog }).toJSON(), raw);
  finish(f, config); commitPickup(f, take(f, f.campaign.groundAct1Drops()[0].id)); f.campaign.travelAct1(CAMP);
  raw = f.campaign.toJSON(); f.campaign = CampaignState.fromJSON(raw, { catalog });
  assert.deepEqual(f.campaign.toJSON(), raw); assert.equal(f.campaign.validateAct1World(f), true);
  assert.equal(f.campaign.act1.currentEncounterId, config.id);
});

test('old campaign migration adds an empty world while preserving existing quest and campaign records', () => {
  const raw = new CampaignState().toJSON(); delete raw.act1;
  raw.questState = { historical: { completed: true } }; raw.waypoints = { old: true };
  const migrated = CampaignState.restoreAct1(raw, { catalog });
  assert.deepEqual(migrated.questState, raw.questState); assert.deepEqual(migrated.waypoints, raw.waypoints);
  assert.equal(migrated.act1.currentAreaId, CAMP); assert.equal(migrated.act1.currentEncounterId, null);
  assert.deepEqual(CampaignState.restoreAct1(migrated.toJSON(), { catalog }).toJSON(), migrated.toJSON());
  const oldObject = new CampaignState(); delete oldObject.act1;
  assert.equal(oldObject.ensureAct1().currentAreaId, CAMP);
});

test('future, null and malformed world schemas are rejected instead of reset', () => {
  const raw = new CampaignState().toJSON();
  for (const change of [d => { d.act1 = null; }, d => { d.act1.schemaVersion = ACT1_WORLD_SCHEMA_VERSION + 1; },
    d => { d.act1.extra = true; }, d => { d.act1.encounters.extra = { status: 'unvisited', defeatedIds: [], drops: [] }; },
    d => { delete d.act1.encounters[ACT1_ENCOUNTERS[0].id]; },
    d => { d.act1.visitedAreaIds.push(CAMP); }, d => { d.act1.visitedAreaIds.push('unknown'); },
    d => { d.act1.currentAreaId = DEN; }, d => { d.act1.currentEncounterId = ACT1_ENCOUNTERS[0].id; },
    d => { d.worldSeed = -1; }, d => { d.unlockedDifficulties.push('impossible'); }]) {
    const data = structuredClone(raw); change(data); const before = structuredClone(data);
    assert.throws(() => CampaignState.restoreAct1(data, { catalog })); assert.deepEqual(data, before);
  }
});

test('corrupt death and loot graphs are rejected atomically on restore', () => {
  const f = fixture(), config = enter(f); defeat(f, config.monsters[0]); const raw = f.campaign.toJSON();
  const mutations = [
    s => { s.status = 'completed'; }, s => { s.status = 'unvisited'; },
    s => { s.defeatedIds.push(s.defeatedIds[0]); }, s => { s.defeatedIds[0] = ACT1_ENCOUNTERS[3].monsters[0].id; },
    s => { s.drops = []; }, s => { s.drops.push(structuredClone(s.drops[0])); },
    s => { s.drops[0].areaId = DEN; }, s => { s.drops[0].instanceId = 'BM-01'; },
    s => { s.drops[0].item.defense += 1; }, s => { s.drops[0].item.canonicalId = 'hand_axe'; },
    s => { s.drops[0].item.name = 'Invented'; }, s => { s.drops[0].item.position = { x: 0, y: 0 }; },
    s => { s.drops[0].collectorId = 'a'; }, s => { s.drops[0].hex.q = NaN; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(raw); mutate(data.act1.encounters[config.id]);
    assert.throws(() => CampaignState.restoreAct1(data, { catalog }));
  }
  const mismatch = structuredClone(raw); mismatch.act1.currentAreaId = CAMP;
  assert.throws(() => CampaignState.restoreAct1(mismatch, { catalog }));
  const two = structuredClone(raw); two.act1.encounters[ACT1_ENCOUNTERS[1].id].status = 'active';
  assert.throws(() => CampaignState.restoreAct1(two, { catalog }));
});

test('world ownership rejects ground-plus-bag duplication, missing collected item and forged receipt namespace', () => {
  const f = fixture(), config = enter(f); finish(f, config);
  const drop = f.campaign.groundAct1Drops()[0];
  f.inventories.get('a').place(drop.item, { x: 0, y: 0 }); f.roster.get('a').inventoryItemIds = [drop.id];
  assert.throws(() => f.campaign.validateAct1World(f), /jednocześnie/);
  f.inventories.get('a').remove(drop.id); f.roster.get('a').inventoryItemIds = [];
  commitPickup(f, take(f, drop.id));
  f.inventories.get('a').remove(drop.id); f.roster.get('a').inventoryItemIds = [];
  assert.throws(() => f.campaign.validateAct1World(f), /właściciela/);
  const pristine = fixture(), forged = createEquipmentItem(catalog, 'cap', 'act1.loot.fabricated');
  pristine.inventories.get('a').place(forged, { x: 0, y: 0 }); pristine.roster.get('a').inventoryItemIds = [forged.id];
  assert.throws(() => pristine.campaign.validateAct1World(pristine), /potwierdzenia/);
});

test('collected Act I loot keeps its receipt when moved into the Horadric Cube', () => {
  const f = fixture(), config = enter(f); finish(f, config);
  const drop = f.campaign.groundAct1Drops()[0];
  commitPickup(f, take(f, drop.id));
  const cube = new HoradricCubeState();
  cube.transferToCube({ itemId: drop.id, inventory: f.inventories.get('a') });
  f.roster.get('a').inventoryItemIds = [];
  assert.throws(() => f.campaign.validateAct1World(f), /nie ma właściciela/);
  const owned = cube.grid.toJSON().items;
  assert.equal(f.campaign.validateAct1World({ ...f, otherOwnedItems: owned }), true);
  assert.throws(() => f.campaign.validateAct1World({ ...f, otherOwnedItems: [...owned, ...owned] }), /wielu właścicieli/);
});

test('all eight fights retain 48 unique receipts after roundtrips and repeated defeat reconciliation', () => {
  const f = fixture(); f.campaign.travelAct1(MOOR);
  for (const areaId of [MOOR, DEN]) {
    if (f.campaign.act1.currentAreaId !== areaId) f.campaign.travelAct1(areaId);
    let config;
    while ((config = f.campaign.nextAct1Encounter())) {
      f.campaign.beginAct1Encounter(config.id); finish(f, config);
      const before = f.campaign.toJSON();
      for (const monster of config.monsters) assert.equal(defeat(f, monster).recorded, false);
      assert.deepEqual(f.campaign.toJSON(), before);
      f.campaign = CampaignState.restoreAct1(before, { catalog });
    }
  }
  const drops = Object.values(f.campaign.act1.encounters).flatMap(e => e.drops);
  assert.equal(drops.length, 48); assert.equal(new Set(drops.map(d => d.id)).size, 48);
  assert.equal(f.campaign.groundAct1Drops().length, 30); assert.equal(f.campaign.validateAct1World(f), true);
  f.campaign.travelAct1(MOOR); assert.equal(f.campaign.groundAct1Drops().length, 18);
  f.campaign.travelAct1(CAMP); assert.equal(f.campaign.groundAct1Drops().length, 0);
  assert.deepEqual(f.campaign.questState, {});
});

test('unsupported difficulty cannot silently consume the Normal encounter scenario', () => {
  const campaign = new CampaignState({ difficulty: 'nightmare' });
  assert.throws(() => campaign.travelAct1(MOOR), /Normal/);
  assert.equal(campaign.act1.currentAreaId, CAMP);
  for (const area of Object.values(ACT1_AREAS)) for (const linked of area.connections) {
    assert(ACT1_AREAS[linked].connections.includes(area.id));
  }
});

test('activated waypoints travel atomically between camp and Cold Plains and land on the exact target sector', () => {
  const campaign = new CampaignState(), points = activateCampAndColdPlains(campaign);
  const beforeCamp = campaign.toJSON(), toCamp = campaign.travelViaWaypoint(CAMP);
  const expectedCamp = structuredClone(beforeCamp);
  expectedCamp.act1.currentAreaId = CAMP;
  expectedCamp.act1.exploration.currentSectorId = points.camp.sectorId;
  expectedCamp.act1.exploration.currentPosition = explorationPoint(CAMP,
    campaign.act1ExplorationMap(CAMP).sectors.find(sector => sector.id === points.camp.sectorId));
  expectedCamp.act1.exploration.movementSequence += 1;
  assert.deepEqual(campaign.toJSON(), expectedCamp);
  assert.equal(toCamp.area.id, CAMP);
  assert.equal(toCamp.sectorId, points.camp.sectorId);
  assert.deepEqual(toCamp.waypoint, points.camp);

  const beforeCold = campaign.toJSON(), toCold = campaign.travelViaWaypoint(COLD);
  const expectedCold = structuredClone(beforeCold);
  expectedCold.act1.currentAreaId = COLD;
  expectedCold.act1.exploration.currentSectorId = points.cold.sectorId;
  expectedCold.act1.exploration.currentPosition = explorationPoint(COLD,
    campaign.act1ExplorationMap(COLD).sectors.find(sector => sector.id === points.cold.sectorId));
  expectedCold.act1.exploration.movementSequence += 1;
  assert.deepEqual(campaign.toJSON(), expectedCold);
  assert.equal(toCold.area.id, COLD);
  assert.equal(toCold.sectorId, points.cold.sectorId);
  assert.deepEqual(toCold.waypoint, points.cold);
});

test('waypoint travel rejects unknown, same-area and merely flagged inactive targets without mutation', () => {
  const campaign = new CampaignState();
  activateAreaWaypoint(campaign);
  campaign.travelAct1(MOOR);
  campaign.travelAct1(COLD);
  campaign.waypoints[COLD] = true; // Legacy flag alone is not an activation receipt.
  campaign.travelAct1(MOOR);
  campaign.travelAct1(CAMP);
  moveToSector(campaign, campaign.act1ExplorationMap().points.find(point => point.kind === 'waypoint').sectorId);
  const before = campaign.toJSON();
  assert.throws(() => campaign.travelViaWaypoint('act1.not_real'), /Nieznany cel/);
  assert.throws(() => campaign.travelViaWaypoint(CAMP), /innej lokacji/);
  assert.throws(() => campaign.travelViaWaypoint(MOOR), /celu nie jest aktywowany/);
  assert.throws(() => campaign.travelViaWaypoint(COLD), /celu nie jest aktywowany/);
  assert.deepEqual(campaign.toJSON(), before);
});

test('waypoint travel requires the activated source sector and rejects active combat atomically', () => {
  const campaign = new CampaignState();
  activateCampAndColdPlains(campaign);
  const map = campaign.act1ExplorationMap();
  const adjacent = map.edges.find(edge => edge.a === campaign.act1.exploration.currentSectorId
    || edge.b === campaign.act1.exploration.currentSectorId);
  const away = adjacent.a === campaign.act1.exploration.currentSectorId ? adjacent.b : adjacent.a;
  campaign.moveAct1Sector(away);
  let before = campaign.toJSON();
  assert.throws(() => campaign.travelViaWaypoint(CAMP), /obecności w sektorze/);
  assert.deepEqual(campaign.toJSON(), before);

  moveToSector(campaign, map.points.find(point => point.kind === 'waypoint').sectorId);
  campaign.travelAct1(MOOR);
  const encounter = campaign.nextAct1Encounter();
  campaign.beginAct1Encounter(encounter.id);
  before = campaign.toJSON();
  assert.throws(() => campaign.travelViaWaypoint(CAMP), /zakończ aktywne starcie/);
  assert.deepEqual(campaign.toJSON(), before);
});

test('waypoint travel is limited to Normal Act I', () => {
  for (const campaign of [new CampaignState({ difficulty: 'nightmare' }), new CampaignState({ act: 2 })]) {
    const before = campaign.toJSON();
    assert.throws(() => campaign.travelViaWaypoint(CAMP), /Normal/);
    assert.deepEqual(campaign.toJSON(), before);
  }
});
