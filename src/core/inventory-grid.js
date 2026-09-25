function clone(value) {
  return structuredClone(value);
}

const MAX_GRID_DIMENSION = 100;
const MAX_GRID_CELLS = 10_000;

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
}

export class InventoryGrid {
  constructor({ width = 10, height = 4, items = [] } = {}) {
    requirePositiveInteger(width, "width");
    requirePositiveInteger(height, "height");
    if (width > MAX_GRID_DIMENSION || height > MAX_GRID_DIMENSION || width * height > MAX_GRID_CELLS) {
      throw new RangeError("Inventory grid dimensions exceed the bounded model");
    }
    if (!Array.isArray(items)) throw new TypeError("Inventory items must be an array");
    this.width = width;
    this.height = height;
    this.items = new Map();
    for (const item of items) {
      if (!this.place(item, item.position)) throw new Error(`Item does not fit: ${item.id}`);
    }
  }

  cellsFor(item, position = item.position) {
    if (typeof item?.id !== "string" || !item.id) throw new TypeError("Item id is required");
    requirePositiveInteger(item.width ?? 1, "item width");
    requirePositiveInteger(item.height ?? 1, "item height");
    if ((item.width ?? 1) > MAX_GRID_DIMENSION
      || (item.height ?? 1) > MAX_GRID_DIMENSION
      || (item.width ?? 1) * (item.height ?? 1) > MAX_GRID_CELLS) {
      throw new RangeError("Inventory item dimensions exceed the bounded model");
    }
    if (!Number.isSafeInteger(position?.x) || !Number.isSafeInteger(position?.y)) throw new TypeError("Grid position requires safe integer x/y");
    const cells = [];
    for (let y = 0; y < (item.height ?? 1); y += 1) {
      for (let x = 0; x < (item.width ?? 1); x += 1) cells.push({ x: position.x + x, y: position.y + y });
    }
    return cells;
  }

  canPlace(item, position, ignoreId = null) {
    const cells = this.cellsFor(item, position);
    if (cells.some(({ x, y }) => x < 0 || y < 0 || x >= this.width || y >= this.height)) return false;
    for (const existing of this.items.values()) {
      if (existing.id === ignoreId) continue;
      const occupied = new Set(this.cellsFor(existing).map(({ x, y }) => `${x},${y}`));
      if (cells.some(({ x, y }) => occupied.has(`${x},${y}`))) return false;
    }
    return true;
  }

  place(item, position) {
    if (this.items.has(item?.id)) throw new Error(`Duplicate inventory item: ${item?.id}`);
    const normalized = { ...clone(item), width: item.width ?? 1, height: item.height ?? 1, position: clone(position) };
    if (!this.canPlace(normalized, position)) return false;
    this.items.set(normalized.id, normalized);
    return true;
  }

  move(itemId, position) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Unknown inventory item: ${itemId}`);
    if (!this.canPlace(item, position, itemId)) return false;
    item.position = clone(position);
    return true;
  }

  remove(itemId) {
    const item = this.items.get(itemId);
    if (!item) return null;
    this.items.delete(itemId);
    return clone(item);
  }

  itemAt(x, y) {
    for (const item of this.items.values()) {
      if (this.cellsFor(item).some((cell) => cell.x === x && cell.y === y)) return clone(item);
    }
    return null;
  }

  toJSON() {
    return { width: this.width, height: this.height, items: clone([...this.items.values()]) };
  }

  static fromJSON(data) {
    return new InventoryGrid(data);
  }
}
