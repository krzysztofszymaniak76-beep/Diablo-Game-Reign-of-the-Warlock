import { InventoryGrid } from './inventory-grid.js';

function requireBackpack(inventory) {
  if (!(inventory instanceof InventoryGrid)) throw new TypeError('Identyfikacja wymaga plecaka');
}

export function unidentifiedItems(inventory) {
  requireBackpack(inventory);
  return inventory.toJSON().items.filter(item => item.identified === false);
}

/** Cain reveals explicitly unidentified backpack items without changing their
 * identity, placement or equipment stats. Legacy items remain identified. */
export function identifyBackpackItems(inventory) {
  requireBackpack(inventory);
  const snapshot = inventory.toJSON();
  const itemIds = [];
  for (const item of snapshot.items) {
    if (item.identified !== false) continue;
    item.identified = true;
    itemIds.push(item.id);
  }
  if (itemIds.length) {
    const staged = InventoryGrid.fromJSON(snapshot);
    inventory.items = staged.items;
  }
  return Object.freeze({ identifiedCount: itemIds.length, itemIds: Object.freeze(itemIds) });
}
