import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EquipmentCatalog, createEquipmentItem, initializeEquipmentAttributes, requirementsFor,
  planEquipmentChange, commitEquipmentChange, validateEquipmentItem, validateOwnerEquipment,
  validateEquipmentWorld, migrateLegacyEquipment, equipmentStats, equipmentSkillProfile,
} from '../src/core/equipment.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';

const data=JSON.parse(readFileSync(new URL('../data/equipment.v051.json',import.meta.url),'utf8'));
const catalog=new EquipmentCatalog(data);
function hero(classId='barbarian',id='hero') {
 const h=createCharacter({id,name:'Hero',classId});initializeEquipmentAttributes(h,catalog);return h;
}
function item(code,id=code,extra={}) {return createEquipmentItem(catalog,code,id,extra);}
function grid(items=[],width=10,height=4) {return new InventoryGrid({width,height,items});}
function equip(h,g,id) {const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:id});commitEquipmentChange(h,g,catalog,plan);return plan;}
function unequip(h,g,slot) {const plan=planEquipmentChange({character:h,inventory:g,catalog,slot});commitEquipmentChange(h,g,catalog,plan);return plan;}
const state=(h,g)=>JSON.stringify({h,g:g.toJSON()});

// Expectations below are explicit numeric source checks, not values produced by the resolver itself.
test('source catalogue has 25 staged bases and four explicit class profiles',()=>{
 assert.equal(catalog.all().length,25);
 assert.deepEqual(catalog.get('hand_axe').oneHandDamage,[3,6]);
 assert.equal(catalog.get('hand_axe').width,1);
 assert.deepEqual(catalog.get('scepter').oneHandDamage,[6,11]);
 assert.equal(catalog.get('scepter').requiredStrength,25);
 assert.equal(catalog.get('targe').requiredLevel,3);
 assert.equal(catalog.get('targe').classOnly,'paladin');
 assert.deepEqual(catalog.get('great_sword').twoHandDamage,[25,42]);
 assert.deepEqual(catalog.get('war_hammer').oneHandDamage,[19,29]);
 assert.deepEqual(catalog.get('throwing_axe').throwDamage,[8,12]);
 assert.equal(catalog.get('throwing_axe').stackable,true);
 assert.deepEqual([item('throwing_axe','throwing').quantity,item('throwing_axe','throwing').maxQuantity],[48,200]);
 assert.equal(catalog.get('katar').classOnly,'assassin');
 assert.deepEqual(catalog.classProfile('barbarian').stats,{strength:30,dexterity:20,vitality:25,energy:10});
});
test('catalogue rejects missing provenance / duplicate definitions / wrong ranges',()=>{
 for(const edit of [d=>d.bases.push(d.bases[0]),d=>delete d.bases[0].source.sha256,d=>d.bases[0].oneHandDamage=[7,2],d=>d.bases[0].width=0]){
  const bad=structuredClone(data);edit(bad);assert.throws(()=>new EquipmentCatalog(bad));
 }
});
test('catalogue is immutable to consumers',()=>{
 assert.throws(()=>{catalog.get('hand_axe').oneHandDamage[0]=999});
 assert.equal(catalog.get('hand_axe').oneHandDamage[0],3);
});
test('class attributes initialized once, resources/EXP/points not reset',()=>{
 const h=hero('paladin');h.resources.hp=10;h.experience=90;h.stats.strength=31;
 assert.equal(initializeEquipmentAttributes(h,catalog),false);
 assert.equal(h.stats.strength,31);assert.equal(h.resources.hp,10);assert.equal(h.experience,90);
});
test('equip transfers one identity to weapon; removing restores it without duplicates',()=>{
 const h=hero(),g=grid([item('hand_axe','axe',{position:{x:0,y:0}})]);
 equip(h,g,'axe');assert.equal(g.items.size,0);assert.equal(h.equipment.weapon.id,'axe');
 assert.equal(Object.hasOwn(h.equipment.weapon,'position'),false);
 assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[3,7]);
 unequip(h,g,'weapon');assert.deepEqual(h.equipment,{});assert.equal(g.items.size,1);
 assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[1,2]);assert.deepEqual(h.inventoryItemIds,['axe']);
});
test('equipment calculation is pure and does not grow cumulatively',()=>{
 const h=hero(),g=grid([item('hand_axe','axe',{position:{x:0,y:0}})]);equip(h,g,'axe');
 const before=state(h,g);for(let i=0;i<100;i++)assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[3,7]);
 assert.equal(state(h,g),before);
});
test('a planned swap does not change live state before commit',()=>{
 const h=hero(),g=grid([item('hand_axe','a',{position:{x:0,y:0}}),item('short_sword','b',{position:{x:1,y:0}})]);
 equip(h,g,'a');const before=state(h,g);
 const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:'b'});assert.equal(state(h,g),before);
 commitEquipmentChange(h,g,catalog,plan);assert.equal(h.equipment.weapon.id,'b');assert.equal(g.items.has('a'),true);assert.equal(g.items.has('b'),false);
 assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[2,9]);
});
test('stale/replayed transfer is rejected without mutation',()=>{
 const h=hero(),g=grid([item('hand_axe','a',{position:{x:0,y:0}})]);
 const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:'a'});commitEquipmentChange(h,g,catalog,plan);
 const before=state(h,g);assert.throws(()=>commitEquipmentChange(h,g,catalog,plan),/Stan wyposażenia/);assert.equal(state(h,g),before);
});
test('strength / dexterity / level and class are enforced before transfer',()=>{
 const h=hero('necromancer'),g=grid([item('great_axe','gax',{position:{x:0,y:0}})]);
 const before=state(h,g);assert.throws(()=>equip(h,g,'gax'),/siła/);assert.equal(state(h,g),before);
 const p=hero('paladin'),tg=grid([item('targe','targe',{position:{x:0,y:0}})]);
 assert.throws(()=>equip(p,tg,'targe'),/poziom 3/);p.level=3;equip(p,tg,'targe');
 assert.equal(requirementsFor(h,catalog.get('targe')).some(s=>s.includes('innej klasy')),true);
});
test('full backpack: unequip is atomic and never loses the equipped item',()=>{
 const h=hero(),g=grid([item('hand_axe','axe',{position:{x:0,y:0}})]);equip(h,g,'axe');
 assert.equal(g.place({id:'big',width:10,height:4},{x:0,y:0}),true);
 const before=state(h,g);assert.throws(()=>unequip(h,g,'weapon'),/Brak miejsca/);assert.equal(state(h,g),before);
});
test('weapon swap can use the space just freed by the incoming item',()=>{
 const h=hero(),g=grid([item('hand_axe','a',{position:{x:0,y:0}}),item('short_sword','b',{position:{x:1,y:0}})]);
 equip(h,g,'a');
 for(let y=0;y<4;y++)for(let x=0;x<10;x++)if(!g.itemAt(x,y))g.place({id:`fill-${x}-${y}`,width:1,height:1},{x,y});
 equip(h,g,'b');assert.equal(h.equipment.weapon.id,'b');assert.equal(g.items.has('a'),true);
});
test('two-handed axe moves shield into backpack; failure rolls back both slots',()=>{
 const h=hero();h.stats.strength=70;h.stats.dexterity=50;
 const g=grid([item('buckler','b',{position:{x:0,y:0}}),item('great_axe','a',{position:{x:2,y:0}})]);
 equip(h,g,'b');equip(h,g,'a');assert.equal(h.equipment.offhand,undefined);assert.equal(g.items.has('b'),true);
 equip(h,g,'b');assert.equal(h.equipment.weapon,undefined);assert.equal(g.items.has('a'),true);
});
test('barbarian can hold two-handed sword with shield, using correct hand damage',()=>{
 const h=hero();h.stats.strength=40;h.stats.dexterity=30;
 const g=grid([item('two_handed_sword','s',{position:{x:0,y:0}}),item('buckler','b',{position:{x:2,y:0}})]);
 equip(h,g,'s');assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[11,23]);
 equip(h,g,'b');assert.equal(h.equipment.weapon.id,'s');assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[2,12]);
 unequip(h,g,'offhand');assert.deepEqual(equipmentStats(h,catalog).weaponDamage,[11,23]);
});
test('armor/shield sum defense; removing one subtracts exactly its contribution',()=>{
 const h=hero('paladin'),g=grid([item('quilted_armor','q',{defense:9,position:{x:0,y:0}}),item('buckler','b',{defense:5,position:{x:3,y:0}})]);
 equip(h,g,'q');equip(h,g,'b');assert.equal(equipmentStats(h,catalog).defense,19);
 unequip(h,g,'chest');assert.equal(equipmentStats(h,catalog).defense,10);
});
test('spell damage never receives weapon damage; weapon cards do',()=>{
 const h=hero('necromancer'),g=grid([item('wand','w',{position:{x:0,y:0}})]);
 const teeth={id:'necromancer.teeth',damage:[6,9],range:5,status:'ADAPTATION_PLACEHOLDER'};
 const before=equipmentSkillProfile(h,teeth,catalog);equip(h,g,'w');assert.deepEqual(equipmentSkillProfile(h,teeth,catalog),before);
 const barb=hero(),bg=grid([item('short_sword','s',{position:{x:0,y:0}})]);equip(barb,bg,'s');
 const bash=equipmentSkillProfile(barb,{id:'barbarian.bash',damage:[999,999],range:1},catalog);
 assert.equal(bash.weaponMin,2);assert.equal(bash.weaponMax,9);assert.equal(bash.damageOrigin,'equipment');
});

test('generic Attack uses the currently equipped weapon and falls back to unarmed damage',()=>{
 const h=hero('barbarian');
 const skill={id:'basic.attack',name:'Atak',damage:[1,2],range:1,status:'SOURCE_BACKED_CONTROL_SKILL'};
 let profile=equipmentSkillProfile(h,skill,catalog);
 assert.deepEqual([profile.weaponMin,profile.weaponMax],[1,2]);assert.equal(profile.damageOrigin,'equipment');assert.equal(profile.sourceCode,null);
 const g=grid([item('short_sword','s',{position:{x:0,y:0}})]);equip(h,g,'s');
 profile=equipmentSkillProfile(h,skill,catalog);
 assert.deepEqual([profile.weaponMin,profile.weaponMax],[2,9]);assert.equal(profile.damageOrigin,'equipment');assert.equal(profile.sourceCode,'ssd');
 unequip(h,g,'weapon');profile=equipmentSkillProfile(h,skill,catalog);
 assert.deepEqual([profile.weaponMin,profile.weaponMax],[1,2]);assert.equal(profile.sourceCode,null);
});

test('Smite requires shield and uses its shield damage, not sword damage',()=>{
 const h=hero('paladin'),g=grid([item('buckler','b',{position:{x:0,y:0}})]);
 const skill={id:'paladin.smite',damage:[8,12],range:1};
 assert.match(equipmentSkillProfile(h,skill,catalog).error,/tarczy/);equip(h,g,'b');
 assert.equal(equipmentSkillProfile(h,skill,catalog).error,null);
 assert.equal(equipmentSkillProfile(h,skill,catalog).weaponMax,3);
});
test('unknown or modified items are not silently treated as normal bases',()=>{
 for(const edit of [i=>i.baseCode='xxx',i=>i.width=3,i=>i.defense=999,i=>i.quality='unique',i=>i.ethereal=true,i=>i.sockets=[{}],i=>i.equipmentVersion=9]){
  const i=item('hand_axe','a');edit(i);assert.throws(()=>validateEquipmentItem(i,catalog));
 }
});
test('dead heroes cannot equip',()=>{
 const h=hero(),g=grid([item('hand_axe','a',{position:{x:0,y:0}})]);h.resources.hp=0;h.lifeState='corpse';
 assert.throws(()=>equip(h,g,'a'),/Martwa/);
});
test('save JSON round-trip preserves all IDs, rolls, stats and one hand set',()=>{
 const h=hero('paladin'),g=grid([item('scepter','s',{position:{x:0,y:0}}),item('cap','c',{defense:4,position:{x:2,y:0}})]);
 equip(h,g,'s');equip(h,g,'c');
 const restored=JSON.parse(JSON.stringify({h,g:g.toJSON()}));
 assert.deepEqual(equipmentStats(restored.h,catalog),equipmentStats(h,catalog));
 assert.deepEqual([...validateOwnerEquipment(restored.h,InventoryGrid.fromJSON(restored.g),catalog)],['s','c']);
});
test('global identity checker rejects one item on multiple owners or containers',()=>{
 const a=hero('barbarian','a'),b=hero('paladin','b');
 const ga=grid([item('hand_axe','shared',{position:{x:0,y:0}})]),gb=grid([item('hand_axe','shared',{position:{x:0,y:0}})]);
 a.inventoryItemIds=['shared'];b.inventoryItemIds=['shared'];
 assert.throws(()=>validateEquipmentWorld(new Roster([a,b]),new Map([['a',ga],['b',gb]]),catalog),/właścicieli/);
});
test('legacy migration keeps IDs, HP, EXP, unknown items and is idempotent',()=>{
 const h=createCharacter({id:'h',name:'Hero',classId:'barbarian'});h.resources.hp=17;h.experience=24;
 const r=new Roster([h]);
 const g=grid([{id:'old-axe',canonicalId:'hand_axe',name:'Old Axe',quality:'normal',width:2,height:3,position:{x:0,y:0}},
  {id:'tome',canonicalId:'tome_of_town_portal',name:'Księga',quality:'magic',width:2,height:2,position:{x:3,y:0}}]);
 const inventories=new Map([['h',g]]);migrateLegacyEquipment(r,inventories,catalog);
 assert.equal(r.get('h').stats.strength,30);assert.equal(r.get('h').resources.hp,17);assert.equal(r.get('h').experience,24);
 assert.equal(inventories.get('h').items.get('old-axe').width,1);assert.equal(inventories.get('h').items.get('tome').name,'Księga');
 const before=JSON.stringify([r.toJSON(),inventories.get('h').toJSON()]);migrateLegacyEquipment(r,inventories,catalog);
 assert.equal(JSON.stringify([r.toJSON(),inventories.get('h').toJSON()]),before);
});
test('legacy migration does not silently discard unsupported quality',()=>{
 const r=new Roster([createCharacter({id:'h',name:'Hero',classId:'barbarian'})]);
 const i={id:'magic',canonicalId:'hand_axe',name:'Magic',quality:'magic',width:1,height:3,position:{x:0,y:0}};
 assert.throws(()=>migrateLegacyEquipment(r,new Map([['h',grid([i])]]),catalog),/bezstratnie/);
});
