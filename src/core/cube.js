import { InventoryGrid } from './inventory-grid.js';
import { findInventorySpace } from './equipment.js';

export const HORADRIC_CUBE_SCHEMA_VERSION = 1;
export const HORADRIC_CUBE_SIZE = Object.freeze({ width: 4, height: 3 });

const clone = value => structuredClone(value);

function requireInventory(inventory, cubeGrid) {
  if (!(inventory instanceof InventoryGrid) || inventory === cubeGrid) {
    throw new TypeError('Operacja Kostki wymaga osobnego plecaka InventoryGrid');
  }
}

function requireItemId(itemId) {
  if (typeof itemId !== 'string' || itemId.trim() !== itemId || !itemId) {
    throw new TypeError('Przedmiot wymaga identyfikatora');
  }
}

/** Persistent 4 × 3 container; recipes remain independent of its storage UI. */
export class HoradricCubeState {
  constructor({ grid = null } = {}) {
    this.grid = grid === null
      ? new InventoryGrid(HORADRIC_CUBE_SIZE)
      : InventoryGrid.fromJSON(grid instanceof InventoryGrid ? grid.toJSON() : clone(grid));
    if (this.grid.width !== HORADRIC_CUBE_SIZE.width || this.grid.height !== HORADRIC_CUBE_SIZE.height) {
      throw new Error('Kostka Horadrimów musi mieć siatkę 4 × 3');
    }
  }

  snapshot() {
    return { schemaVersion: HORADRIC_CUBE_SCHEMA_VERSION, grid: this.grid.toJSON() };
  }

  static restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || Object.keys(snapshot).sort().join('|') !== 'grid|schemaVersion'
      || snapshot.schemaVersion !== HORADRIC_CUBE_SCHEMA_VERSION) {
      throw new Error('Nieobsługiwany zapis Kostki Horadrimów');
    }
    return new HoradricCubeState({ grid: snapshot.grid });
  }

  /** Rejects a duplicated ID before any transfer or save is committed. */
  validateUniqueOwnership(inventories = []) {
    const grids = inventories instanceof InventoryGrid ? [inventories]
      : inventories instanceof Map ? [...inventories.values()]
      : Array.isArray(inventories) ? inventories : null;
    if (!grids || grids.some(grid => !(grid instanceof InventoryGrid) || grid === this.grid)) {
      throw new TypeError('Audyt Kostki wymaga osobnych siatek InventoryGrid');
    }
    const seen = new Set();
    for (const grid of [this.grid, ...grids]) {
      for (const { id } of grid.toJSON().items) {
        if (seen.has(id)) throw new Error(`Przedmiot ma wielu właścicieli: ${id}`);
        seen.add(id);
      }
    }
    return seen;
  }

  transferToCube({ itemId, inventory, position = null } = {}) {
    return this.#transfer({ itemId, inventory, position, from: inventory, to: this.grid,
      missing: 'Przedmiotu nie ma w plecaku', full: 'Brak miejsca w Kostce Horadrimów' });
  }

  transferFromCube({ itemId, inventory, position = null } = {}) {
    return this.#transfer({ itemId, inventory, position, from: this.grid, to: inventory,
      missing: 'Przedmiotu nie ma w Kostce Horadrimów', full: 'Brak miejsca w plecaku' });
  }

  #transfer({ itemId, inventory, position, from, to, missing, full }) {
    requireInventory(inventory, this.grid);
    requireItemId(itemId);
    this.validateUniqueOwnership(inventory);
    const stagedFrom = InventoryGrid.fromJSON(from.toJSON());
    const stagedTo = InventoryGrid.fromJSON(to.toJSON());
    const item = stagedFrom.remove(itemId);
    if (!item) throw new Error(missing);
    delete item.position;
    const target = position ?? findInventorySpace(stagedTo, item);
    if (!target || !stagedTo.place(item, target)) throw new Error(`${full} — niczego nie zmieniono`);
    const stagedCube = from === this.grid ? stagedFrom : stagedTo;
    const stagedInventory = from === inventory ? stagedFrom : stagedTo;
    const ids = new Set();
    for (const grid of [stagedCube, stagedInventory]) {
      for (const entry of grid.toJSON().items) {
        if (ids.has(entry.id)) throw new Error(`Przedmiot ma wielu właścicieli: ${entry.id}`);
        ids.add(entry.id);
      }
    }
    // All validation is complete before either live container changes.
    this.grid.items = stagedCube.items;
    inventory.items = stagedInventory.items;
    return clone((from === this.grid ? inventory : this.grid).items.get(itemId));
  }
}

function normalizedCounts(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.baseId, (counts.get(item.baseId) ?? 0) + 1);
  return counts;
}

export class HoradricCube {
  constructor(items = []) {
    this.items = items.map((item) => structuredClone(item));
  }

  transmute(recipe, createResult, canPlaceResult = () => true) {
    const before = structuredClone(this.items);
    const required = new Map(Object.entries(recipe.ingredients));
    const present = normalizedCounts(this.items);
    const exactCount = [...required.values()].reduce((total, value) => total + value, 0);
    const matches = this.items.length === exactCount && [...required].every(([baseId, count]) => present.get(baseId) === count);
    if (!matches) return { ok: false, reason: "NO_RECIPE", items: structuredClone(this.items) };
    let result;
    try {
      result = createResult(structuredClone(this.items));
      if (!result?.id || !result?.baseId) throw new TypeError("Recipe result must be an item");
      if (!canPlaceResult(result)) return { ok: false, reason: "NO_SPACE", items: structuredClone(this.items) };
      this.items = [structuredClone(result)];
      return { ok: true, result: structuredClone(result), items: structuredClone(this.items) };
    } catch (error) {
      this.items = before;
      throw error;
    }
  }
}
