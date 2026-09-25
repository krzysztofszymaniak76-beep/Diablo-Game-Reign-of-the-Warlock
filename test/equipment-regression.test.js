import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EquipmentCatalog, createEquipmentItem, initializeEquipmentAttributes,
  planEquipmentChange, commitEquipmentChange, validateEquipmentItem,
  validateOwnerEquipment, equipmentStats } from '../src/core/equipment.js';
import { createCharacter } from '../src/core/characters.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const item = (base, id, options) => createEquipmentItem(catalog, base, id, options);
function hero() {
  const h = createCharacter({id:'h', name:'Test', classId:'barbarian'});
  initializeEquipmentAttributes(h, catalog);
  h.stats.strength = 100; h.stats.dexterity = 100;
  return h;
}
const state = (h,g) => JSON.stringify({character:h,inventory:g.toJSON()});
const change = (h,g,args) => commitEquipmentChange(h,g,catalog,planEquipmentChange({character:h,inventory:g,catalog,...args}));
function packedSwapFixture(freeShieldSpace=true) {
  const h=hero(), g=new InventoryGrid();
  h.equipment.weapon=item('scepter','old-weapon');
  h.equipment.offhand=item('buckler','old-shield');
  g.place(item('great_axe','new-weapon'),{x:0,y:0});
  // The incoming axe frees 2x3; an adjacent 2x2 lets the shield shift right
  // and leave a tall column for the scepter. Greedy first-fit blocks both.
  for(let y=0;y<4;y++) for(let x=0;x<10;x++) {
    if(!g.itemAt(x,y) && !(freeShieldSpace && x>=2 && x<=3 && y<=1)) {
      g.place({id:`block-${x}-${y}`,width:1,height:1},{x,y});
    }
  }
  h.inventoryItemIds=g.toJSON().items.map(i=>i.id);
  return {h,g};
}

test('two displaced items: finds alternative placement instead of false full-backpack error',()=>{
  const {h,g}=packedSwapFixture();
  const original=g.toJSON().items.filter(i=>i.id!=='new-weapon');
  const ids=[...validateOwnerEquipment(h,g,catalog)].sort();
  const before=state(h,g);
  const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:'new-weapon'});
  assert.equal(state(h,g),before,'planning must be non-mutating');
  commitEquipmentChange(h,g,catalog,plan);
  assert.equal(h.equipment.weapon.id,'new-weapon');
  assert.equal(h.equipment.offhand,undefined);
  assert.deepEqual(g.items.get('old-shield').position,{x:1,y:0});
  assert.deepEqual(g.items.get('old-weapon').position,{x:0,y:0});
  for(const existing of original) assert.deepEqual(g.items.get(existing.id),existing,'existing bag items never move');
  assert.deepEqual([...validateOwnerEquipment(h,g,catalog)].sort(),ids,'identities conserved');
});
test('two displaced items: genuine no-space keeps weapon, shield and backpack byte-identical',()=>{
  const {h,g}=packedSwapFixture(false); const before=state(h,g);
  assert.throws(()=>planEquipmentChange({character:h,inventory:g,catalog,itemId:'new-weapon'}),/Brak miejsca/);
  assert.equal(state(h,g),before);
});
test('alternative packing is deterministic across repeated plans',()=>{
  const {h,g}=packedSwapFixture();
  const make=()=>planEquipmentChange({character:h,inventory:g,catalog,itemId:'new-weapon'});
  assert.deepEqual(make(),make());
});
test('returned-item packing survives swapping back and save JSON round-trip',()=>{
  const {h,g}=packedSwapFixture(); change(h,g,{itemId:'new-weapon'});
  const saved=JSON.parse(state(h,g)), restored=InventoryGrid.fromJSON(saved.inventory);
  assert.deepEqual(equipmentStats(saved.character,catalog),equipmentStats(h,catalog));
  // A user can move the shield right before swapping back: the existing
  // bag is deliberately not auto-rearranged by equip.
  assert.equal(restored.move('old-shield',{x:2,y:0}),true);
  change(saved.character,restored,{itemId:'old-weapon'});
  assert.equal(saved.character.equipment.weapon.id,'old-weapon');
  assert.ok(restored.items.has('new-weapon'));
  validateOwnerEquipment(saved.character,restored,catalog);
});
for (const field of ['sockets','properties']) {
  for(const [label,value] of [['object',{damage:999}],['empty object',{}],['number',0],['boolean',false],['string','']]) {
    test(`rejects malformed ${field}: ${label}, without mutating bag`,()=>{
      const h=hero(),g=new InventoryGrid();
      const bad={...item('hand_axe','bad'),[field]:value};
      g.place(bad,{x:0,y:0});h.inventoryItemIds=['bad'];const before=state(h,g);
      assert.throws(()=>change(h,g,{itemId:'bad'}),/Nieprawidłowy format/);
      assert.equal(state(h,g),before);
    });
  }
}
test('unmodified bases with empty arrays or null metadata remain load-compatible',()=>{
  for(const value of [[],null,undefined]) {
    const base={...item('hand_axe','a'),sockets:value,properties:value};
    assert.equal(validateEquipmentItem(base,catalog).id,'hand_axe');
  }
});
test('normal item cannot hide non-boolean ethereal flag',()=>{
  for(const flag of [0,'',{},'false']) assert.throws(()=>validateEquipmentItem({...item('hand_axe','a'),ethereal:flag},catalog),/eteryczność/);
});
test('normal item cannot hide malformed runeword reference',()=>{
  for(const value of [0,false,{},'',[]]) assert.throws(()=>validateEquipmentItem({...item('hand_axe','a'),runewordId:value},catalog),/słowo runiczne/);
});
test('commit refuses an actor whose HP reached zero since planning',()=>{
  const h=hero(),g=new InventoryGrid();g.place(item('hand_axe','a'),{x:0,y:0});h.inventoryItemIds=['a'];
  const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:'a'});
  h.resources.hp=0;const before=state(h,g);
  assert.throws(()=>commitEquipmentChange(h,g,catalog,plan),/Martwa/);
  assert.equal(state(h,g),before);
});
test('ordinary nonlethal HP loss does not invalidate a non-stale equipment plan',()=>{
  const h=hero(),g=new InventoryGrid();g.place(item('hand_axe','a'),{x:0,y:0});
  const plan=planEquipmentChange({character:h,inventory:g,catalog,itemId:'a'});
  h.resources.hp-=1;commitEquipmentChange(h,g,catalog,plan);
  assert.equal(h.equipment.weapon.id,'a');
});
test('repeated equip/unequip preserves exact identity and quantities',()=>{
  const h=hero(),g=new InventoryGrid();
  g.place(item('hand_axe','a'),{x:0,y:0});g.place(item('buckler','b'),{x:2,y:0});h.inventoryItemIds=['a','b'];
  for(let i=0;i<50;i++) {
    change(h,g,{itemId:'a'});change(h,g,{itemId:'b'});
    assert.deepEqual([...validateOwnerEquipment(h,g,catalog)].sort(),['a','b']);
    change(h,g,{slot:'weapon'});change(h,g,{slot:'offhand'});
    assert.deepEqual([...validateOwnerEquipment(h,g,catalog)].sort(),['a','b']);
    assert.equal(g.items.size,2);
  }
});
