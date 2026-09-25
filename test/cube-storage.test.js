import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HoradricCubeState, HORADRIC_CUBE_SIZE } from '../src/core/cube.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { EquipmentCatalog, createEquipmentItem } from '../src/core/equipment.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const item = (base, id, position) => createEquipmentItem(catalog, base, id, { position });
const backpack = items => new InventoryGrid({ width: 10, height: 4, items });
const stateOf = (cube, inventory) => JSON.stringify({ cube: cube.snapshot(), inventory: inventory.toJSON() });

test('Kostka has a persistent 4×3 grid and moves the same item identity both ways', () => {
  const original = item('short_sword', 'loot.sword.1', { x: 3, y: 1 });
  const inventory = backpack([original]);
  const cube = new HoradricCubeState();
  assert.deepEqual({ width: cube.grid.width, height: cube.grid.height }, HORADRIC_CUBE_SIZE);

  const inserted = cube.transferToCube({ itemId: original.id, inventory });
  assert.equal(inserted.id, original.id);
  assert.equal(inventory.items.has(original.id), false);
  assert.deepEqual(cube.grid.items.get(original.id).position, { x: 0, y: 0 });
  assert.equal(cube.validateUniqueOwnership(inventory).size, 1);

  const restored = HoradricCubeState.restore(JSON.parse(JSON.stringify(cube.snapshot())));
  assert.deepEqual(restored.snapshot(), cube.snapshot());
  const removed = restored.transferFromCube({ itemId: original.id, inventory });
  assert.equal(removed.id, original.id);
  assert.equal(restored.grid.items.has(original.id), false);
  assert.equal(inventory.items.get(original.id).canonicalId, original.canonicalId);
  assert.equal(inventory.items.get(original.id).defense, original.defense);
  assert.equal(restored.validateUniqueOwnership(inventory).size, 1);
});

test('full cube, full backpack and occupied target leave both inventories unchanged', () => {
  const inventory = backpack([item('cap', 'cap', { x: 0, y: 0 })]);
  const cube = new HoradricCubeState({ grid: {
    width: 4, height: 3, items: [{ id: 'filled', width: 4, height: 3, position: { x: 0, y: 0 } }],
  } });
  const before = stateOf(cube, inventory);
  assert.throws(() => cube.transferToCube({ itemId: 'cap', inventory }), /Brak miejsca w Kostce/);
  assert.equal(stateOf(cube, inventory), before);

  const partlyFilledCube = new HoradricCubeState({ grid: {
    width: 4, height: 3, items: [item('cap', 'stored', { x: 0, y: 0 })],
  } });
  const fullBackpack = backpack([{ id: 'bag.full', width: 10, height: 4, position: { x: 0, y: 0 } }]);
  const fullBefore = stateOf(partlyFilledCube, fullBackpack);
  assert.throws(() => partlyFilledCube.transferFromCube({ itemId: 'stored', inventory: fullBackpack }), /Brak miejsca w plecaku/);
  assert.equal(stateOf(partlyFilledCube, fullBackpack), fullBefore);

  const collisionBefore = stateOf(partlyFilledCube, inventory);
  assert.throws(() => partlyFilledCube.transferToCube({ itemId: 'cap', inventory, position: { x: 0, y: 0 } }), /Brak miejsca w Kostce/);
  assert.equal(stateOf(partlyFilledCube, inventory), collisionBefore);
});

test('duplicate IDs and malformed save are rejected before any transfer', () => {
  const original = item('cap', 'same.id', { x: 0, y: 0 });
  const inventory = backpack([original]);
  const cube = new HoradricCubeState({ grid: { width: 4, height: 3, items: [original] } });
  const before = stateOf(cube, inventory);
  assert.throws(() => cube.validateUniqueOwnership(inventory), /wielu właścicieli: same.id/);
  assert.throws(() => cube.transferToCube({ itemId: 'same.id', inventory }), /wielu właścicieli: same.id/);
  assert.equal(stateOf(cube, inventory), before);

  const valid = new HoradricCubeState().snapshot();
  assert.throws(() => HoradricCubeState.restore({ ...valid, schemaVersion: 99 }), /Nieobsługiwany zapis/);
  assert.throws(() => HoradricCubeState.restore({ ...valid, grid: { ...valid.grid, width: 5 } }), /4 × 3/);
  assert.throws(() => HoradricCubeState.restore({ ...valid, extra: true }), /Nieobsługiwany zapis/);
});
