import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignState } from '../src/core/campaign.js';
import { EquipmentCatalog } from '../src/core/equipment.js';
import { rollBloodMoorEncounter } from '../src/core/random-act1-encounter.js';

const MOOR='act1.blood_moor',CAMP='act1.rogue_encampment';
const catalog=new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json',import.meta.url),'utf8')));
const idOf=campaign=>({expectedAreaId:campaign.act1.currentAreaId,
  expectedSectorId:campaign.act1.exploration.currentSectorId,
  expectedSequence:campaign.act1.exploration.movementSequence});

function adjacentResult(seed,predicate) {
  const campaign=new CampaignState({worldSeed:seed});campaign.travelAct1(MOOR);
  const map=campaign.act1ExplorationMap(),start=campaign.act1.exploration.currentSectorId;
  const neighbors=map.edges.flatMap(edge=>edge.a===start?[edge.b]:edge.b===start?[edge.a]:[]).sort();
  for(const sectorId of neighbors) {
    if(map.encounters.some(item=>item.sectorId===sectorId)||map.exits.some(item=>item.sectorId===sectorId))continue;
    const result=rollBloodMoorEncounter({worldSeed:seed,difficulty:'normal',sectorId});
    if(predicate(result))return {campaign,sectorId,result};
  }
  return null;
}

test('first-entry 50/50 and 10% Champion rates are deterministic and bounded',()=>{
  const samples=10000;let battles=0,champions=0;
  for(let seed=0;seed<samples;seed++) {
    const {result}=rollBloodMoorEncounter({worldSeed:seed,difficulty:'normal',sectorId:'sector-041'});
    if(result.outcome==='encounter'){battles++;if(result.encounterKind==='champion')champions++;}
  }
  assert.ok(battles/samples>.47&&battles/samples<.53,`battle rate ${battles/samples}`);
  assert.ok(champions/battles>.075&&champions/battles<.125,`Champion rate ${champions/battles}`);
  assert.deepEqual(rollBloodMoorEncounter({worldSeed:5150,sectorId:'sector-041'}),
    rollBloodMoorEncounter({worldSeed:5150,sectorId:'sector-041'}));
});

test('a newly entered group is saved, defeated once and remains cleared after travel and reload',()=>{
  const selected=adjacentResult(5150,result=>result.result.outcome==='encounter');
  assert.ok(selected,'fixture must contain an adjacent encounter');
  const {campaign,sectorId,result:expected}=selected;
  const moved=campaign.moveAct1Sector(sectorId,idOf(campaign));
  assert.equal(moved.encounterKind,expected.result.encounterKind);
  assert.equal(moved.encounterId,expected.config.id);
  assert.equal(moved.encounterStatus,'unvisited');
  const pending=campaign.toJSON();
  assert.deepEqual(CampaignState.restoreAct1(pending).toJSON(),pending);
  assert.throws(()=>campaign.moveAct1Sector(campaign.act1ExplorationMap().startSectorId,idOf(campaign)),/odkryte starcie/);
  const config=campaign.beginAct1Encounter(moved.encounterId,{sectorId});
  assert.equal(config.monsters.length,3);
  assert.ok(config.monsters.every(monster=>['fallen1','zombie1'].includes(monster.profileId)));
  for(const monster of config.monsters)campaign.recordAct1Defeat(monster.id,{hex:monster.position,catalog});
  assert.equal(campaign.act1.encounters[config.id].status,'completed');
  campaign.travelAct1(CAMP);campaign.travelAct1(MOOR);
  const returned=campaign.moveAct1Sector(sectorId,idOf(campaign));
  assert.equal(returned.encounterId,config.id);
  assert.equal(returned.encounterStatus,'completed');
  const saved=campaign.toJSON();
  assert.deepEqual(CampaignState.restoreAct1(saved,{catalog}).toJSON(),saved);
});

test('Champion outcome stages the stronger six-enemy group and survives save/load',()=>{
  let selected=null;
  for(let seed=0;seed<3000&&!selected;seed++)selected=adjacentResult(seed,result=>result.result.encounterKind==='champion');
  assert.ok(selected,'fixture must produce a Champion outcome');
  const {campaign,sectorId,result:expected}=selected;
  const moved=campaign.moveAct1Sector(sectorId,idOf(campaign));
  assert.equal(moved.encounterKind,'champion');
  const config=campaign.act1Encounter(moved.encounterId);
  assert.equal(config.monsters.length,6);
  assert.ok(config.monsters.every(monster=>['fallen1','zombie1'].includes(monster.profileId)));
  assert.deepEqual(CampaignState.restoreAct1(campaign.toJSON()).toJSON(),campaign.toJSON());
  assert.equal(expected.result.encounterId,moved.encounterId);
});

test('an empty first-entry roll stays empty and cannot create an encounter on return',()=>{
  let selected=null;
  for(let seed=0;seed<100&&!selected;seed++)selected=adjacentResult(seed,result=>result.result.outcome==='empty');
  assert.ok(selected,'fixture must contain an empty adjacent sector');
  const {campaign,sectorId}=selected;
  const moved=campaign.moveAct1Sector(sectorId,idOf(campaign));
  assert.equal(moved.encounterId,null);
  const saved=campaign.toJSON();
  assert.deepEqual(CampaignState.restoreAct1(saved).toJSON(),saved);
  campaign.travelAct1(CAMP);campaign.travelAct1(MOOR);
  const returned=campaign.moveAct1Sector(sectorId,idOf(campaign));
  assert.equal(returned.encounterId,null);
  assert.equal(campaign.act1.exploration.areaStates[MOOR].randomEncounterRolls[sectorId].outcome,'empty');
});
