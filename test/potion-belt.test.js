import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import {
  emptyPotionBelt, beltSlotCount, potionKind, isPotionItem, validPotionBelt,
  putPotionInBelt, takePotionFromBelt, consumePotionFromBelt,
} from '../src/core/potion-belt.js';

function potion(id = 'potion-1', canonicalId = 'potion_health_lesser') {
  const health = canonicalId.startsWith('potion_health');
  return {
    id, canonicalId, name: health ? 'Słaba mikstura zdrowia' : 'Słaba mikstura many',
    width: 1, height: 1, quality: 'normal', quantity: 1, maxQuantity: 1,
    supplyVersion: 1, position: { x: 0, y: 0 },
  };
}

test('a new belt is empty until a real backpack potion is placed in a chosen slot', () => {
  const inventory = new InventoryGrid({ items: [potion()] });
  const belt = emptyPotionBelt();
  assert.deepEqual(belt, [null, null, null, null]);
  assert.equal(consumePotionFromBelt(belt, 0), null);
  const moved = putPotionInBelt(inventory, belt, 'potion-1', 2);
  assert.equal(inventory.items.has('potion-1'), false);
  assert.equal(moved.id, 'potion-1');
  assert.equal(Object.hasOwn(moved, 'position'), false);
  assert.equal(belt[2].canonicalId, 'potion_health_lesser');
  assert.equal(beltSlotCount(belt[2]), 1);
  assert.equal(validPotionBelt(belt), true);
  assert.throws(() => putPotionInBelt(inventory, belt, 'potion-1', 2), /zajęte/);
});

test('taking a potion from the belt restores the same item to the backpack', () => {
  const inventory = new InventoryGrid({ items: [potion('mana-1', 'potion_mana_lesser')] });
  const belt = emptyPotionBelt();
  putPotionInBelt(inventory, belt, 'mana-1', 0);
  const savedBelt = structuredClone(belt);
  const restoredBelt = structuredClone(savedBelt);
  const restoredInventory = InventoryGrid.fromJSON(inventory.toJSON());
  const taken = takePotionFromBelt(restoredInventory, restoredBelt, 0, 'hero');
  assert.equal(taken.id, 'mana-1');
  assert.equal(taken.canonicalId, 'potion_mana_lesser');
  assert.deepEqual(restoredInventory.items.get('mana-1').position, { x: 0, y: 0 });
  assert.deepEqual(restoredBelt, emptyPotionBelt());
});

test('a full backpack and a non-potion cannot move items or mutate the belt', () => {
  const inventory = new InventoryGrid({ width: 1, height: 1, items: [potion()] });
  const belt = emptyPotionBelt();
  putPotionInBelt(inventory, belt, 'potion-1', 0);
  inventory.place({ id: 'filler', width: 1, height: 1 }, { x: 0, y: 0 });
  assert.throws(() => takePotionFromBelt(inventory, belt, 0, 'hero'), /Brak miejsca/);
  assert.equal(belt[0].id, 'potion-1');
  assert.equal(inventory.items.has('potion-1'), false);
  assert.throws(() => putPotionInBelt(inventory, belt, 'filler', 1), /tylko miksturę/);
  assert.equal(inventory.items.has('filler'), true);
});

test('using a real potion consumes its item and clears the occupied slot', () => {
  const inventory = new InventoryGrid({ items: [potion()] });
  const belt = emptyPotionBelt();
  putPotionInBelt(inventory, belt, 'potion-1', 3);
  assert.deepEqual(consumePotionFromBelt(belt, 3), { name: 'Słaba mikstura zdrowia', kind: 'health' });
  assert.equal(belt[3], null);
  assert.equal(consumePotionFromBelt(belt, 3), null);
  assert.equal(inventory.items.has('potion-1'), false);
});

test('old saved belt counts remain usable and can be moved out one item at a time', () => {
  const belt = [{ name: 'Mikstura Leczenia', count: 2 }, { name: 'Mikstura Many', count: 1 }, null, null];
  const inventory = new InventoryGrid();
  assert.equal(validPotionBelt(belt), true);
  assert.equal(potionKind(belt[0]), 'health');
  const taken = takePotionFromBelt(inventory, belt, 0, 'hero');
  assert.equal(isPotionItem(taken), true);
  assert.equal(belt[0].count, 1);
  assert.equal(inventory.items.has(taken.id), true);
  assert.equal(consumePotionFromBelt(belt, 0)?.kind, 'health');
  assert.equal(belt[0], null);
  assert.equal(consumePotionFromBelt(belt, 1)?.kind, 'mana');
  assert.equal(belt[1], null);
});
