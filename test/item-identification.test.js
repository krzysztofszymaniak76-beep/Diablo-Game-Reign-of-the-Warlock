import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { identifyBackpackItems, unidentifiedItems } from '../src/core/item-identification.js';

test('Cain identifies only explicitly unidentified items, preserving identity and position', () => {
  const inventory = new InventoryGrid({ width: 10, height: 4, items: [
    { id: 'unknown-wand', width: 1, height: 2, position: { x: 1, y: 0 }, identified: false },
    { id: 'known-cap', width: 2, height: 2, position: { x: 4, y: 0 }, identified: true },
    { id: 'legacy-axe', width: 1, height: 3, position: { x: 8, y: 0 } },
  ] });
  const before = inventory.toJSON();
  assert.deepEqual(unidentifiedItems(inventory).map(item => item.id), ['unknown-wand']);
  assert.deepEqual(identifyBackpackItems(inventory), {
    identifiedCount: 1, itemIds: ['unknown-wand'],
  });
  const after = inventory.toJSON();
  assert.equal(after.items[0].identified, true);
  assert.deepEqual(after.items[0].position, before.items[0].position);
  assert.deepEqual(after.items.slice(1), before.items.slice(1));
  assert.deepEqual(unidentifiedItems(InventoryGrid.fromJSON(after)), []);
  assert.deepEqual(identifyBackpackItems(inventory), { identifiedCount: 0, itemIds: [] });
});

test('invalid input cannot mutate any inventory', () => {
  assert.throws(() => identifyBackpackItems(null), /plecaka/);
  const inventory = new InventoryGrid({ width: 10, height: 4 });
  assert.deepEqual(identifyBackpackItems(inventory), { identifiedCount: 0, itemIds: [] });
});
