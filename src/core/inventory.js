export class ItemLedger {
  constructor(items = []) {
    this.items = new Map();
    for (const item of items) this.register(item);
  }

  register(item) {
    if (typeof item?.id !== "string" || !item.id
      || typeof item?.location?.ownerId !== "string" || !item.location.ownerId
      || typeof item.location.container !== "string" || !item.location.container) {
      throw new TypeError("Item requires string id and owner/container location");
    }
    for (const coordinate of ["x", "y"]) {
      if (item.location[coordinate] !== undefined && !Number.isSafeInteger(item.location[coordinate])) {
        throw new TypeError(`Item location ${coordinate} must be a safe integer`);
      }
    }
    if (this.items.has(item.id)) throw new Error(`Duplicate item id: ${item.id}`);
    this.items.set(item.id, structuredClone(item));
  }

  transfer(itemId, expectedFrom, to, canPlace = () => true) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Unknown item: ${itemId}`);
    if (JSON.stringify(item.location) !== JSON.stringify(expectedFrom)) throw new Error("Stale item location");
    if (!canPlace(item, to)) return false;
    const previous = structuredClone(item.location);
    try {
      item.location = structuredClone(to);
      return true;
    } catch (error) {
      item.location = previous;
      throw error;
    }
  }

  ownerOf(itemId) {
    return this.items.get(itemId)?.location.ownerId ?? null;
  }

  toJSON() {
    return structuredClone([...this.items.values()]);
  }
}
