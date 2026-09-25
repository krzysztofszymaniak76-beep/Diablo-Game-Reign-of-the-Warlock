import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampServicesState, CAMP_AKARA_CORE_STOCK, CAMP_STASH_SIZE, CAMP_SUPPLY_DEFINITIONS, CAMP_VENDOR_DEFINITIONS, CAMP_VENDOR_POOLS } from '../src/core/camp-services.js';
import { EquipmentCatalog, createEquipmentItem, initializeEquipmentAttributes } from '../src/core/equipment.js';
import { createCharacter } from '../src/core/characters.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const backpack = (items = []) => new InventoryGrid({ width: 10, height: 4, items });
const item = (canonicalId, id, position = { x: 0, y: 0 }) => createEquipmentItem(catalog, canonicalId, id, { position });
const graph = (camp, inventory) => JSON.stringify({ camp: camp.snapshot(), inventory: inventory.toJSON() });
const repairOwner = () => {
  const character = createCharacter({ id: 'repairer', name: 'Bohater', classId: 'barbarian' });
  initializeEquipmentAttributes(character, catalog);
  return character;
};

test('fresh camp has non-negative integer gold, shared 10x8 stash and three Polish source-backed offers', () => {
  const camp = new CampServicesState({ catalog, gold: 321 });
  assert.equal(camp.gold, 321);
  assert.deepEqual({ width: camp.stash.width, height: camp.stash.height }, CAMP_STASH_SIZE);
  assert.deepEqual(camp.listVendors().map(vendor => vendor.id), ['akara', 'charsi', 'gheed']);
  assert.equal(CAMP_VENDOR_DEFINITIONS.length, 3);
  const offers = camp.listVendors().flatMap(vendor => vendor.offers);
  assert.deepEqual(offers.map(offer => offer.displayName), ['Różdżka', 'Topór ręczny', 'Czapka']);
  assert.deepEqual(offers.map(offer => offer.item.canonicalId), ['wand', 'hand_axe', 'cap']);
  for (const offer of offers) assert.equal(catalog.get(offer.item.canonicalId).displayName, offer.displayName);
  assert.equal(camp.validateUniqueOwnership().size, offers.length);
});

test('vendor stock is stable across repeated views and snapshot restore without refresh or reroll', () => {
  const camp = new CampServicesState({ catalog });
  const before = camp.snapshot();
  assert.deepEqual(camp.listVendors(), camp.listVendors());
  const restored = CampServicesState.restore(JSON.parse(JSON.stringify(before)), { catalog });
  assert.deepEqual(restored.snapshot(), before);
  assert.equal(restored.offers('akara')[0].item.id, 'camp.vendor.akara.wand');
  assert.equal(restored.offers('akara')[0].item.defense, before.vendors[0].offers[0].item.defense);
});

test('login rotation chooses finite, merchant-specific stock without changing gold or stash', () => {
  const camp = new CampServicesState({ catalog, gold: 432 });
  const first = camp.rotateOffers({ random: () => 0 });
  assert.deepEqual(first.map(vendor => vendor.offers.length), [9, 15, 8]);
  assert.deepEqual(first[0].offers.map(offer => offer.item.canonicalId), [...CAMP_AKARA_CORE_STOCK, 'dagger']);
  assert.deepEqual(CAMP_VENDOR_POOLS.akara, [...CAMP_AKARA_CORE_STOCK, 'dagger']);
  for (const vendor of first) {
    for (const offer of vendor.offers) {
      assert.ok(CAMP_VENDOR_POOLS[vendor.id].includes(offer.item.canonicalId));
      assert.equal(offer.displayName, catalog.get(offer.item.canonicalId)?.displayName
        ?? CAMP_SUPPLY_DEFINITIONS.find(supply => supply.id === offer.item.canonicalId)?.displayName);
    }
  }
  assert.equal(camp.gold, 432);
  assert.equal(camp.stash.toJSON().items.length, 0);
  assert.deepEqual(camp.listVendors(), camp.listVendors());
  assert.deepEqual(CampServicesState.restore(camp.snapshot(), { catalog }).snapshot(), camp.snapshot());
  const second = camp.rotateOffers({ random: () => .999 });
  assert.deepEqual(second[0].offers.slice(0, CAMP_AKARA_CORE_STOCK.length)
    .map(offer => offer.item.canonicalId), CAMP_AKARA_CORE_STOCK);
  assert.notDeepEqual(second[0].offers.map(offer => offer.item.canonicalId), first[0].offers.map(offer => offer.item.canonicalId));
  const ids = second.flatMap(vendor => vendor.offers.map(offer => offer.item.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('session stock is drawn once, survives repeated merchant visits and is redrawn after restoring a save', () => {
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const first = camp.beginSession({ random: () => 0 });
  const saved = camp.snapshot();
  assert.deepEqual(first.map(vendor => vendor.offers.length), [9, 15, 8]);
  assert.deepEqual(camp.beginSession({ random: () => .999 }), first);
  for (const vendor of first) assert.deepEqual(camp.offers(vendor.id), vendor.offers);
  assert.deepEqual(camp.snapshot(), saved);

  const nextSession = CampServicesState.restore(saved, { catalog });
  const next = nextSession.beginSession({ random: () => .999 });
  assert.equal(nextSession.gold, saved.gold);
  assert.deepEqual(nextSession.stash.toJSON(), saved.stash);
  assert.notDeepEqual(next[0].offers.map(offer => offer.item.canonicalId),
    first[0].offers.map(offer => offer.item.canonicalId));
  for (const vendor of next) {
    for (const offer of vendor.offers) assert.ok(CAMP_VENDOR_POOLS[vendor.id].includes(offer.item.canonicalId));
  }
  assert.deepEqual(nextSession.beginSession({ random: () => 0 }), next);
});

test('failed session draw is atomic and can be retried without changing legacy saves', () => {
  const legacyCamp = new CampServicesState({ catalog });
  const legacy = legacyCamp.snapshot();
  const restored = CampServicesState.restore(legacy, { catalog });
  assert.deepEqual(restored.snapshot(), legacy);
  assert.throws(() => restored.beginSession({ random: () => 1 }), /zakresu/);
  assert.deepEqual(restored.snapshot(), legacy);
  const first = restored.beginSession({ random: () => 0 });
  assert.deepEqual(first.map(vendor => vendor.offers.length), [9, 15, 8]);
  assert.deepEqual(restored.beginSession({ random: () => 1 }), first);
});

test('new session preserves purchases and sales, uses fresh IDs and still rejects a repeated buy', () => {
  const camp = new CampServicesState({ catalog, gold: 2000 });
  const inventory = backpack([item('short_sword', 'hero-owned', { x: 0, y: 0 })]);
  camp.beginSession({ inventories: new Map([['hero', inventory]]), random: () => 0 });
  const offer = camp.offers('charsi')[0];
  const bought = camp.buy({ vendorId: 'charsi', offerId: offer.offerId, inventory });
  const goldAfterBuy = camp.gold;
  assert.throws(() => camp.buy({ vendorId: 'charsi', offerId: offer.offerId, inventory }), /już dostępna/);
  assert.equal(camp.gold, goldAfterBuy);
  const sold = camp.sell({ vendorId: 'gheed', itemId: 'hero-owned', inventory });
  assert.equal(camp.gold, goldAfterBuy + sold.price);
  const nextSession = CampServicesState.restore(camp.snapshot(), { catalog });
  const next = nextSession.beginSession({ inventories: new Map([['hero', inventory]]), random: () => .999 });
  assert.ok(next.every(vendor => vendor.offers.every(entry => entry.item.id !== bought.item.id)));
  assert.ok(next.every(vendor => vendor.offers.every(entry => entry.item.id !== sold.item.id)));
  assert.equal(inventory.items.has(bought.item.id), true);
  assert.equal(nextSession.gold, camp.gold);
  assert.equal(nextSession.validateUniqueOwnership(new Map([['hero', inventory]])).size,
    inventory.items.size + nextSession.stash.items.size
      + next.reduce((sum, vendor) => sum + vendor.offers.length, 0));
});

test('rotation after purchase preserves owned item identity and never repopulates with that ID', () => {
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const inventory = backpack();
  const bought = camp.buy({ vendorId: 'akara', offerId: camp.offers('akara')[0].offerId, inventory });
  const goldAfterPurchase = camp.gold;
  camp.rotateOffers({ inventories: new Map([['hero', inventory]]), random: () => 0 });
  assert.equal(inventory.items.get(bought.item.id).canonicalId, 'wand');
  assert.equal(camp.gold, goldAfterPurchase);
  assert.equal(camp.validateUniqueOwnership(new Map([['hero', inventory]])).size,
    inventory.items.size + camp.stash.items.size
      + camp.listVendors().reduce((sum, vendor) => sum + vendor.offers.length, 0));
  assert.ok(camp.listVendors().every(vendor => vendor.offers.every(offer => offer.item.id !== bought.item.id)));
});

test('invalid random source aborts stock rotation without changing a save snapshot', () => {
  const camp = new CampServicesState({ catalog });
  const before = camp.snapshot();
  assert.throws(() => camp.rotateOffers({ random: () => 1 }), /zakresu/);
  assert.deepEqual(camp.snapshot(), before);
});

test('buy atomically moves the exact offer identity into the backpack and deducts its fixed price', () => {
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const inventory = backpack();
  const offer = camp.offers('charsi')[0];
  const result = camp.buy({ vendorId: 'charsi', offerId: offer.offerId, inventory });
  assert.equal(result.item.id, offer.item.id);
  assert.equal(inventory.items.get(offer.item.id).canonicalId, 'hand_axe');
  assert.equal(camp.offers('charsi').length, 0);
  assert.equal(camp.gold, 1000 - offer.buyPrice);
  assert.deepEqual([...camp.validateUniqueOwnership(new Map([['hero', inventory]]))].sort(),
    camp.snapshot().vendors.flatMap(vendor => vendor.offers.map(entry => entry.item.id))
      .concat(offer.item.id).sort());
});

test('Akara sells source-art scrolls, tomes and potions as saveable inventory goods', () => {
  const camp = new CampServicesState({ catalog, gold: 5000 });
  camp.beginSession({ random: () => 0 });
  assert.deepEqual(camp.offers('akara').slice(0, CAMP_AKARA_CORE_STOCK.length)
    .map(entry => entry.item.canonicalId), CAMP_AKARA_CORE_STOCK);
  const inventory = backpack();
  const offer = camp.offers('akara').find(entry => entry.item.canonicalId === 'scroll_identify');
  assert.ok(offer);
  assert.equal(offer.item.quantity, 20);
  assert.equal(offer.item.width * offer.item.height, 1);
  const result = camp.buy({ vendorId: 'akara', offerId: offer.offerId, inventory });
  assert.equal(result.item.canonicalId, 'scroll_identify');
  assert.equal(inventory.items.get(result.item.id).quantity, 20);
  assert.equal(camp.quoteSell({ item: result.item }), 20);
  const restored = CampServicesState.restore(camp.snapshot(), { catalog });
  assert.deepEqual(restored.snapshot(), camp.snapshot());
  assert.ok(CAMP_VENDOR_POOLS.akara.includes('tome_town_portal'));
  assert.ok(CAMP_VENDOR_POOLS.akara.includes('potion_mana_lesser'));
  assert.equal(CAMP_VENDOR_POOLS.charsi.some(id => CAMP_SUPPLY_DEFINITIONS.some(supply => supply.id === id)), false);
  assert.equal(CAMP_VENDOR_POOLS.gheed.some(id => CAMP_SUPPLY_DEFINITIONS.some(supply => supply.id === id)), false);
});

test('insufficient gold leaves camp, offer and backpack byte-for-byte unchanged', () => {
  const camp = new CampServicesState({ catalog, gold: 0 });
  const inventory = backpack([item('short_sword', 'owned')]);
  const before = graph(camp, inventory);
  assert.throws(() => camp.buy({ vendorId: 'akara', offerId: camp.offers('akara')[0].offerId, inventory }), /Za mało złota/);
  assert.equal(graph(camp, inventory), before);
});

test('full backpack rejects a purchase without charging gold or consuming the offer', () => {
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const inventory = backpack([{ id: 'full', width: 10, height: 4, position: { x: 0, y: 0 } }]);
  const before = graph(camp, inventory);
  assert.throws(() => camp.buy({ vendorId: 'gheed', offerId: camp.offers('gheed')[0].offerId, inventory }), /Brak miejsca w plecaku/);
  assert.equal(graph(camp, inventory), before);
});

test('sell keeps the item ID, credits gold and adds the exact item to persistent vendor stock', () => {
  const inventory = backpack([item('short_sword', 'loot-sword')]);
  const camp = new CampServicesState({ catalog, gold: 10 });
  const quotedPrice = camp.quoteSell({ item: inventory.items.get('loot-sword') });
  const result = camp.sell({ vendorId: 'gheed', itemId: 'loot-sword', inventory });
  assert.equal(inventory.items.has('loot-sword'), false);
  assert.ok(result.price > 0);
  assert.equal(result.price, quotedPrice);
  assert.equal(camp.gold, 10 + result.price);
  const resold = camp.offers('gheed').find(offer => offer.offerId === 'loot-sword');
  assert.equal(resold.item.id, 'loot-sword');
  assert.equal(resold.displayName, 'Krótki miecz');
  assert.deepEqual(CampServicesState.restore(camp.snapshot(), { catalog }).offers('gheed'), camp.offers('gheed'));
});

test('Charsi quotes and repairs a damaged backpack item without changing its identity or placement', () => {
  const inventory = backpack([item('hand_axe', 'damaged-axe')]);
  const character = repairOwner();
  const owned = inventory.items.get('damaged-axe');
  owned.durability -= 5;
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const beforeOffers = camp.listVendors();
  const quote = camp.repairQuote({ itemId: owned.id, inventory, character });
  assert.equal(quote.source, 'backpack');
  assert.equal(quote.missingDurability, 5);
  assert.ok(quote.price > 0);
  const result = camp.repair({ itemId: owned.id, inventory, character });
  assert.equal(result.price, quote.price);
  assert.equal(result.gold, 1000 - quote.price);
  assert.equal(result.item.durability, result.item.maxDurability);
  assert.equal(inventory.items.get(owned.id).id, owned.id);
  assert.deepEqual(inventory.items.get(owned.id).position, { x: 0, y: 0 });
  assert.deepEqual(camp.listVendors(), beforeOffers);
  const after = graph(camp, inventory);
  assert.equal(camp.repairQuote({ itemId: owned.id, inventory, character }).price, 0);
  assert.throws(() => camp.repair({ itemId: owned.id, inventory, character }), /nie wymaga naprawy/);
  assert.equal(graph(camp, inventory), after);
});

test('Charsi repairs an equipped item, not an invented backpack copy', () => {
  const character = repairOwner();
  const inventory = backpack();
  character.equipment.weapon = createEquipmentItem(catalog, 'hand_axe', 'equipped-axe');
  character.equipment.weapon.durability = 0;
  const camp = new CampServicesState({ catalog, gold: 1000 });
  const quote = camp.repairQuote({ itemId: 'equipped-axe', inventory, character });
  assert.equal(quote.source, 'equipment');
  assert.equal(quote.slot, 'weapon');
  const result = camp.repair({ itemId: 'equipped-axe', inventory, character });
  assert.equal(result.source, 'equipment');
  assert.equal(character.equipment.weapon.durability, character.equipment.weapon.maxDurability);
  assert.equal(character.equipment.weapon.id, 'equipped-axe');
  assert.equal(inventory.items.size, 0);
  assert.equal(camp.gold, 1000 - quote.price);
});

test('repair price grows with damage, and failed repairs leave gold and items unchanged', () => {
  const inventory = backpack([item('short_sword', 'sword')]);
  const character = repairOwner();
  const camp = new CampServicesState({ catalog, gold: 0 });
  const sword = inventory.items.get('sword');
  sword.durability -= 1;
  const small = camp.repairQuote({ itemId: sword.id, inventory, character });
  sword.durability -= 6;
  const large = camp.repairQuote({ itemId: sword.id, inventory, character });
  assert.ok(large.price > small.price);
  const before = graph(camp, inventory);
  assert.throws(() => camp.repair({ itemId: sword.id, inventory, character }), /Za mało złota/);
  assert.equal(graph(camp, inventory), before);
  assert.throws(() => camp.repair({ itemId: 'unknown', inventory, character }), /nie ma w plecaku/);
  assert.equal(graph(camp, inventory), before);

  character.equipment.weapon = createEquipmentItem(catalog, 'hand_axe', 'camp.vendor.charsi.hand_axe');
  character.equipment.weapon.durability -= 1;
  const beforeDuplicate = graph(camp, inventory);
  assert.throws(() => camp.repair({ itemId: character.equipment.weapon.id, inventory, character }), /wielu właścicieli/);
  assert.equal(graph(camp, inventory), beforeDuplicate);
});

test('backpack-stash round trip preserves one identity and uses first available space', () => {
  const inventory = backpack([item('quilted_armor', 'armor')]);
  const camp = new CampServicesState({ catalog });
  camp.transferToStash({ itemId: 'armor', inventory });
  assert.equal(inventory.items.has('armor'), false);
  assert.equal(camp.stash.items.get('armor').id, 'armor');
  assert.deepEqual(camp.stash.items.get('armor').position, { x: 0, y: 0 });
  camp.transferFromStash({ itemId: 'armor', inventory });
  assert.equal(camp.stash.items.has('armor'), false);
  assert.equal(inventory.items.get('armor').id, 'armor');
  assert.equal(camp.validateUniqueOwnership(inventory).has('armor'), true);
});

test('full stash and full backpack both roll back every involved state', () => {
  const inventory = backpack([item('wand', 'wand')]);
  const camp = new CampServicesState({
    catalog,
    stash: { width: 10, height: 8, items: [{ id: 'stash-full', width: 10, height: 8, position: { x: 0, y: 0 } }] },
  });
  let before = graph(camp, inventory);
  assert.throws(() => camp.transferToStash({ itemId: 'wand', inventory }), /Brak miejsca w schowku/);
  assert.equal(graph(camp, inventory), before);

  const storedCamp = new CampServicesState({
    catalog,
    stash: { width: 10, height: 8, items: [item('cap', 'stored-cap')] },
  });
  const full = backpack([{ id: 'bag-full', width: 10, height: 4, position: { x: 0, y: 0 } }]);
  before = graph(storedCamp, full);
  assert.throws(() => storedCamp.transferFromStash({ itemId: 'stored-cap', inventory: full }), /Brak miejsca w plecaku/);
  assert.equal(graph(storedCamp, full), before);
});

test('ownership audit rejects the same ID in backpacks, stash or vendor stock', () => {
  const camp = new CampServicesState({ catalog });
  const a = backpack([item('short_sword', 'shared')]);
  const b = backpack([item('hand_axe', 'shared')]);
  assert.throws(() => camp.validateUniqueOwnership(new Map([['a', a], ['b', b]])), /wielu właścicieli: shared/);

  const forged = camp.snapshot();
  const vendorItem = forged.vendors[0].offers[0].item;
  forged.stash.items.push({ ...vendorItem, position: { x: 0, y: 0 } });
  assert.throws(() => CampServicesState.restore(forged, { catalog }), /wielu właścicieli/);
});

test('restore rejects malformed gold, wrong stash size, changed offer and future schema', () => {
  const camp = new CampServicesState({ catalog });
  for (const edit of [
    state => { state.gold = -1; },
    state => { state.gold = 0.5; },
    state => { state.stash.height = 4; },
    state => { state.vendors[0].offers[0].displayName = 'Wand'; },
    state => { state.vendors[0].offers[0].buyPrice += 1; },
    state => { state.schemaVersion = 99; },
  ]) {
    const snapshot = camp.snapshot();
    edit(snapshot);
    assert.throws(() => CampServicesState.restore(snapshot, { catalog }));
  }
});

test('failed sell and duplicate target state are atomic', () => {
  const camp = new CampServicesState({ catalog });
  const unsupported = backpack([{ id: 'potion', width: 1, height: 1, position: { x: 0, y: 0 } }]);
  let before = graph(camp, unsupported);
  assert.throws(() => camp.sell({ vendorId: 'akara', itemId: 'potion', inventory: unsupported }), /Brak obsługi wyposażenia/);
  assert.equal(graph(camp, unsupported), before);

  const duplicated = backpack([{ ...camp.offers('akara')[0].item, position: { x: 0, y: 0 } }]);
  before = graph(camp, duplicated);
  assert.throws(() => camp.buy({ vendorId: 'akara', offerId: camp.offers('akara')[0].offerId, inventory: duplicated }), /wielu właścicieli/);
  assert.equal(graph(camp, duplicated), before);
});
