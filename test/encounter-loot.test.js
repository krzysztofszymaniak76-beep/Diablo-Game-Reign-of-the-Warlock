import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EquipmentCatalog,initializeEquipmentAttributes,createEquipmentItem,planEquipmentChange,commitEquipmentChange} from '../src/core/equipment.js';
import {InventoryGrid} from '../src/core/inventory-grid.js';
import {HoradricCubeState} from '../src/core/cube.js';
import {Roster,createCharacter} from '../src/core/characters.js';
import {Party} from '../src/core/party.js';
import {PlayersSetting} from '../src/core/players.js';
import {CombatState} from '../src/core/combat.js';
import {HexGrid} from '../src/core/hex-grid.js';
import {PortalSystem,EncounterRules,TownPortalScrollSupply} from '../src/core/portals.js';
import {BattlePreparationState,SKILL_CATEGORY} from '../src/core/battle-preparation.js';
import {createEncounterProgress,stageVictoryLoot,stageLootPickup,validateLootRecords,validateEncounterWorld,
  currentLootMarker,groundDrops,encounterEnemyId,encounterItemId,encounterLootBase,migrateLegacyEncounter} from '../src/core/encounter-loot.js';
import {stageNextEncounter,postBattlePresence} from '../src/core/encounter-loop.js';
const catalog=new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json',import.meta.url),'utf8')));
const col=p=>p.q;
function fixture() {
 const heroes=['a','b','c'].map(id=>{const h=createCharacter({id,name:id,classId:'barbarian'});initializeEquipmentAttributes(h,catalog);return h});
 const roster=new Roster(heroes),party=new Party(roster,['a','b','c']),players=new PlayersSetting(1);
 const combat=new CombatState({party,playersSetting:players,seed:210});
 const enemy=combat.spawnMonster({id:'fallen-1',name:'Upadły',baseHp:42,baseExperience:24,position:{q:9,r:4}});
 const initialPositions=new Map([['a',{q:2,r:1}],['b',{q:1,r:2}],['c',{q:0,r:3}],['fallen-1',{q:9,r:4}]]);
 const hexGrid=new HexGrid({tiles:Array.from({length:12},(_,q)=>Array.from({length:8},(_,r)=>({q,r}))).flat()});
 for(const [id,position] of initialPositions){hexGrid.addUnit({id,position});combat.units.get(id).position=position}
 const preparation=new BattlePreparationState({heroIds:party.slots,heroPositions:Object.fromEntries(party.slots.map(id=>[id,initialPositions.get(id)])),
  loadouts:Object.fromEntries(party.slots.map(id=>[id,{left:`${id}.attack`,right:[`${id}.buff`,`${id}.other`,`${id}.summon`]}])),deploymentColumnOf:col});
 const portals=new PortalSystem();
 for(const h of heroes)portals.setCharacterLocation(h.id,{kind:'area',area_id:'act1.blood_moor',instance_id:'BM-01',hex:initialPositions.get(h.id)});
 const inventories=new Map(heroes.map(h=>[h.id,new InventoryGrid()]));
 return{catalog,roster,party,players,combat,enemy,preparation,hexGrid,portals,inventories,initialPositions,progress:createEncounterProgress(),deploymentColumnOf:col,areaId:'act1.blood_moor'};
}
function win(f){f.preparation.startBattle();f.enemy.hp=0;f.progress=stageVictoryLoot(f.progress,{enemy:f.enemy,hex:f.enemy.position,catalog});f.combat.grantMonsterExperience(f.enemy.id,f.party.slots);f.hexGrid.removeUnit(f.enemy.id);f.preparation.completeBattle();return f;}
function take(f,id=encounterItemId(1),ownerId='a') {
 const h=f.roster.get(ownerId), result=stageLootPickup({progress:f.progress,dropId:id,character:h,inventory:f.inventories.get(ownerId),catalog,
 phase:f.preparation.phase,onField:f.preparation.isUnitOnField(ownerId)});
 f.progress=result.progress;f.inventories.set(ownerId,result.inventory);h.inventoryItemIds=result.inventoryItemIds;return result;
}
const next=f=>stageNextEncounter({...f,expectedEncounter:f.progress.encounterNumber});
const checkWorld=f=>validateEncounterWorld(f.progress,{...f,catalog});
const state=f=>JSON.stringify({progress:f.progress,roster:f.roster.toJSON(),inventories:[...f.inventories].map(([id,g])=>[id,g.toJSON()]),combat:f.combat.snapshot(),grid:f.hexGrid.snapshot(),prep:f.preparation.snapshot(),portals:f.portals.toJSON()});

test('first encounter starts without a loot item or reward',()=>{const f=fixture();assert.equal(checkWorld(f),true);assert.deepEqual(groundDrops(f.progress),[]);assert.equal(currentLootMarker(f.progress),null)});
test('living monster cannot produce loot',()=>{const f=fixture();const before=state(f);assert.throws(()=>stageVictoryLoot(f.progress,{enemy:f.enemy,hex:f.enemy.position,catalog}));assert.equal(state(f),before)});
test('victory creates a real source-based sword with stable ID',()=>{const f=win(fixture());const d=groundDrops(f.progress)[0];assert.equal(d.id,'short-sword-1');assert.equal(d.item.canonicalId,'short_sword');assert.equal(d.item.width,1);assert.equal(d.item.height,3);assert.equal(d.item.baseCode,'ssd');assert.equal(d.status,'ground');assert.equal(checkWorld(f),true)});
test('victory replay does not create another item, RNG roll or reward',()=>{const f=win(fixture());const before=state(f);f.progress=stageVictoryLoot(f.progress,{enemy:f.enemy,hex:f.enemy.position,catalog});assert.deepEqual(f.combat.grantMonsterExperience(f.enemy.id,f.party.slots),[]);assert.equal(state(f),before)});
test('pickup stages without modifying the live graph',()=>{const f=win(fixture()),before=state(f);const result=stageLootPickup({progress:f.progress,dropId:'short-sword-1',character:f.roster.get('a'),inventory:f.inventories.get('a'),catalog,phase:'completed',onField:true});assert.equal(result.inventory.items.size,1);assert.equal(state(f),before)});
test('pickup transfers exactly one identity and grants no further experience',()=>{const f=win(fixture()),xp=f.roster.get('a').experience;take(f);assert.equal(f.roster.get('a').experience,xp);assert.equal(groundDrops(f.progress).length,0);assert.equal(f.inventories.get('a').items.size,1);assert.deepEqual(f.roster.get('a').inventoryItemIds,['short-sword-1']);assert.equal(checkWorld(f),true)});
test('double pickup is rejected atomically',()=>{const f=win(fixture());take(f);const before=state(f);assert.throws(()=>take(f),/już zebrany/);assert.equal(state(f),before)});
test('full bag leaves the loot and resources untouched',()=>{const f=win(fixture());f.inventories.get('a').place({id:'full',width:10,height:4},{x:0,y:0});f.roster.get('a').inventoryItemIds=['full'];const before=state(f);assert.throws(()=>take(f),/Brak miejsca/);assert.equal(state(f),before);assert.equal(checkWorld(f),true)});
test('another living hero can collect if first backpack is full',()=>{const f=win(fixture());f.inventories.get('a').place({id:'full',width:10,height:4},{x:0,y:0});f.roster.get('a').inventoryItemIds=['full'];take(f,'short-sword-1','b');assert.equal(f.progress.drops[0].collectorId,'b');assert.equal(checkWorld(f),true)});
for(const [label,edit,args] of [
 ['active battle',()=>{}, {phase:'active',onField:true}],['preparation',()=>{},{phase:'preparation',onField:true}],
 ['off-field owner',()=>{},{phase:'completed',onField:false}],['dead hero',h=>{h.lifeState='corpse';h.resources.hp=0},{phase:'completed',onField:true}],
])test(`pickup rejects ${label}`,()=>{const f=win(fixture()),h=f.roster.get('a');edit(h);const before=state(f);assert.throws(()=>stageLootPickup({progress:f.progress,dropId:'short-sword-1',character:h,inventory:f.inventories.get('a'),catalog,...args}));assert.equal(state(f),before)});
test('gathering does not enforce equip requirements',()=>{const f=win(fixture());f.roster.get('a').stats.strength=0;take(f);assert.equal(f.inventories.get('a').items.size,1)});
test('collected item can be equipped and retains receipt/save identity',()=>{const f=win(fixture());take(f);const h=f.roster.get('a'),g=f.inventories.get('a');commitEquipmentChange(h,g,catalog,planEquipmentChange({character:h,inventory:g,catalog,itemId:'short-sword-1'}));assert.equal(h.equipment.weapon.id,'short-sword-1');assert.equal(checkWorld(f),true);assert.equal(validateLootRecords(JSON.parse(JSON.stringify(f.progress)),catalog),true)});
test('collected training loot retains its receipt after transfer to the Horadric Cube',()=>{
 const f=win(fixture());take(f);
 const cube=new HoradricCubeState();
 cube.transferToCube({itemId:'short-sword-1',inventory:f.inventories.get('a')});
 f.roster.get('a').inventoryItemIds=[];
 assert.throws(()=>checkWorld(f),/nie ma właściciela/);
 const otherOwnedItems=cube.grid.toJSON().items;
 assert.equal(validateEncounterWorld(f.progress,{...f,catalog,otherOwnedItems}),true);
 assert.throws(()=>validateEncounterWorld(f.progress,{...f,catalog,otherOwnedItems:[...otherOwnedItems,...otherOwnedItems]}),/wielu właścicieli/);
});
test('loot record and inventory cannot both own same item',()=>{const f=win(fixture());const d=f.progress.drops[0];f.inventories.get('a').place(d.item,{x:0,y:0});f.roster.get('a').inventoryItemIds=[d.id];assert.throws(()=>checkWorld(f),/jednocześnie/)});
test('collected receipt requires a real item',()=>{const f=win(fixture());take(f);f.inventories.get('a').remove('short-sword-1');f.roster.get('a').inventoryItemIds=[];assert.throws(()=>checkWorld(f),/nie ma właściciela/)});
test('missing reward receipt cannot invent a bag item',()=>{const f=fixture();f.inventories.get('a').place(createEquipmentItem(catalog,'short_sword','short-sword-1'),{x:0,y:0});f.roster.get('a').inventoryItemIds=['short-sword-1'];assert.throws(()=>checkWorld(f),/bez potwierdzenia/)});
for(const [label,edit] of [
 ['future schema',p=>p.schemaVersion=99],['wrong encounter',p=>p.encounterNumber=0],['duplicate drop',p=>p.drops.push(p.drops[0])],
 ['wrong base',p=>p.drops[0].item=createEquipmentItem(catalog,'hand_axe','short-sword-1')],['out-of-range defense',p=>p.drops[0].item.defense=999],
 ['missing collector',p=>{p.drops[0].status='collected';p.drops[0].collectorId=null}],['bad hex',p=>p.drops[0].hex.q=NaN],['equipped-shaped loot',p=>p.drops[0].item.position={x:0,y:0}],
])test(`reject malformed ledger: ${label}`,()=>{const f=win(fixture()),p=structuredClone(f.progress);edit(p);assert.throws(()=>validateLootRecords(p,catalog))});
test('ledger rejects an otherwise valid drop outside the actual grid',()=>{const f=win(fixture());f.progress.drops[0].hex={q:999,r:999};assert.throws(()=>checkWorld(f),/poza planszą/)});
test('loot schedule is explicit; every base exists and IDs never collide',()=>{const ids=new Set();for(let n=1;n<=30;n++){ids.add(encounterItemId(n));assert.ok(catalog.get(encounterLootBase(n)))}assert.equal(ids.size,30);assert.equal(encounterLootBase(2),'leather_gloves');assert.equal(encounterEnemyId(2),'fallen-2')});
test('next encounter cannot start before victory',()=>{const f=fixture(),before=state(f);assert.throws(()=>next(f));assert.equal(state(f),before)});
test('next encounter retains old uncollected loot without mutating inputs',()=>{const f=win(fixture()),before=state(f),n=next(f);assert.equal(state(f),before);assert.equal(n.progress.encounterNumber,2);assert.equal(n.enemy.id,'fallen-2');assert.equal(n.enemy.hp,42);assert.equal(n.enemy.rewardsGranted,false);assert.equal(groundDrops(n.progress).length,1);assert.equal(n.preparation.phase,'preparation');assert.equal(n.combat.timelineMode,null);assert.equal(n.combat.scheduler.queue.length,0);assert.equal(currentLootMarker(n.progress),null)});
test('next encounter does not heal, add EXP/points or restore equipment',()=>{const f=win(fixture());take(f);const h=f.roster.get('a'),g=f.inventories.get('a');h.resources.hp=17;h.resources.mana=2;h.level=2;h.unspentStatPoints=3;h.unspentSkillPoints=1;
 commitEquipmentChange(h,g,catalog,planEquipmentChange({character:h,inventory:g,catalog,itemId:'short-sword-1'}));const before=state(f);next(f);assert.equal(state(f),before);assert.equal(h.resources.hp,17);assert.equal(h.equipment.weapon.id,'short-sword-1')});
test('next encounter uses P chosen for the next spawn, not current monster',()=>{const f=win(fixture());f.players.set(8);const n=next(f);assert.equal(n.enemy.maxHp,189);assert.equal(n.enemy.experience,108);assert.equal(n.enemy.playersSnapshot,8);assert.equal(f.enemy.maxHp,42)});
test('global clock survives while command IDs belong to a fresh encounter history',()=>{const f=win(fixture());f.combat.scheduler.advanceTo(9800);f.combat.units.get('a').readyAt=10500;f.combat.scheduler.sequence=41;f.combat.commandSequence=18;f.combat.transactionSequence=27;const n=next(f);assert.equal(n.combat.scheduler.time,10500);assert.equal(n.combat.scheduler.sequence,41);assert.equal(n.combat.commandSequence,0);assert.equal(n.combat.transactionSequence,0);assert.doesNotThrow(()=>CombatState.restore(n.combat.snapshot(),{party:f.party,playersSetting:f.players}))});
test('all persistent summons retain ID/kind/owner and are redeployed without collision',()=>{const f=fixture();f.preparation.summonUnit({id:'skeleton-A',ownerId:'c',kind:'skeleton',skillId:'c.summon',position:{q:2,r:4},persistent:true});f.hexGrid.addUnit({id:'skeleton-A',position:{q:2,r:4}});win(f);const n=next(f);assert.equal(n.preparation.listSummons()[0].id,'skeleton-A');assert.equal(n.preparation.listSummons()[0].ownerId,'c');assert.deepEqual(n.hexGrid.positionOf('skeleton-A'),n.preparation.listSummons()[0].position);assert.equal(n.hexGrid.snapshot().units.length,5)});
test('loadout is preserved on next encounter and enemy gets no preparation action',()=>{const f=win(fixture());const before=f.preparation.getLoadout('a');const n=next(f);assert.deepEqual(n.preparation.getLoadout('a'),before);assert.equal(n.preparation.enemyTurnsEnabled,false);assert.equal(n.combat.currentActorId,null)});
test('dead heroes remain dead and off field after the next preparation',()=>{const f=fixture();f.preparation.startBattle();f.roster.get('a').resources.hp=0;f.roster.get('a').lifeState='corpse';f.preparation.withdrawUnit('a');f.hexGrid.removeUnit('a');win(f);const n=next(f);assert.equal(n.preparation.isUnitOnField('a'),false);assert.equal(f.roster.get('a').resources.hp,0);assert.equal(n.actingUnitId,'b');assert.throws(()=>n.hexGrid.positionOf('a'));assert.equal(n.preparation.phase,'preparation')});
test('all dead prevents next encounter rather than reviving team',()=>{const f=win(fixture());for(const h of f.party.activeCharacters()){h.resources.hp=0;h.lifeState='corpse'}const before=state(f);assert.throws(()=>next(f),/Brak żywych/);assert.equal(state(f),before)});
test('town travelers must return before next encounter',()=>{const f=win(fixture());f.portals.setCharacterLocation('a',{kind:'town',town_id:'act1.rogue_encampment',via_portal_id:'old',source_instance_id:'BM-01'});assert.throws(()=>next(f),/z miasta/)});
test('stale next-encounter request is rejected',()=>{const f=win(fixture());assert.throws(()=>stageNextEncounter({...f,expectedEncounter:0}),/poprzedniego/)});
test('unresolved timeline effects block transition instead of disappearing',()=>{const f=win(fixture());f.combat.scheduler.schedule({at:100,kind:'anything',actorId:'a'});assert.throws(()=>next(f),/zdarzenia/)});
test('post-battle presence supports return without invoking combat or changing resources',()=>{const f=fixture();f.preparation.startBattle();f.preparation.withdrawUnit('b');win(f);const previous=state(f);const p=postBattlePresence(f.preparation,'b',{q:5,r:5},col);assert.equal(p.isUnitOnField('b'),true);assert.equal(p.phase,'completed');assert.equal(state(f),previous)});
test('legacy completed save upgrades only its marker without duplicating EXP',()=>{const f=win(fixture());const xp=f.roster.get('a').experience;const result=migrateLegacyEncounter({legacyLoot:{id:'short-sword-1',instanceId:'BM-01',hex:{q:9,r:4}},enemy:f.enemy,preparation:f.preparation,catalog});assert.equal(result.drops.length,1);assert.equal(f.roster.get('a').experience,xp);assert.equal(result.drops[0].status,'ground')});
test('legacy preparation upgrades without fabricating rewards',()=>{const f=fixture();assert.deepEqual(migrateLegacyEncounter({legacyLoot:null,enemy:f.enemy,preparation:f.preparation,catalog}),createEncounterProgress())});
test('legacy invalid/dead-without-marker saves fail, not silently award loot',()=>{const f=win(fixture());assert.throws(()=>migrateLegacyEncounter({legacyLoot:null,enemy:f.enemy,preparation:f.preparation,catalog}))});

test('next encounter preserves terrain flags and movement costs without touching geometry',()=>{
 const f=win(fixture());const raw=f.hexGrid.snapshot();raw.lineOfSightBlockers=[{q:6,r:0}];raw.projectileBlockers=[{q:7,r:0}];raw.movementCosts=[['8,0',2]];
 f.hexGrid=HexGrid.restore(raw);const n=next(f),out=n.hexGrid.snapshot();
 assert.deepEqual(out.tiles,raw.tiles);assert.equal(n.hexGrid.blocksLineOfSight({q:6,r:0}),true);assert.equal(n.hexGrid.blocksProjectile({q:7,r:0}),true);assert.deepEqual(out.movementCosts,raw.movementCosts);
});
test('thirty encounter cycles never duplicate items, heals, or EXP rewards',()=>{
 let f=fixture();const seen=new Set();
 for(let number=1;number<=30;number++) {
  win(f);const drop=f.progress.drops.at(-1);assert.equal(drop.encounterNumber,number);assert.equal(seen.has(drop.id),false);seen.add(drop.id);
  assert.equal(f.roster.get('a').experience,number*8);assert.equal(checkWorld(f),true);
  if(number%3===0) {take(f,drop.id,['a','b','c'][(number/3-1)%3]);assert.equal(checkWorld(f),true);}
  const resources=structuredClone(f.roster.get('a').resources);if(number<30){const n=next(f);f={...f,...n};assert.deepEqual(f.roster.get('a').resources,resources);assert.equal(checkWorld(f),true);}
 }
 assert.equal(f.progress.drops.length,30);assert.equal(groundDrops(f.progress).length,20);assert.equal(seen.size,30);
});
