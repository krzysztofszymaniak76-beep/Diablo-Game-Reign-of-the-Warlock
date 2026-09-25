import test from "node:test";
import assert from "node:assert/strict";
import { InventoryGrid } from "../src/core/inventory-grid.js";

test("inventory dimensions are bounded before any cell-expansion loop", () => {
  assert.throws(
    () => new InventoryGrid({ width: Number.MAX_SAFE_INTEGER, height: 1 }),
    /bounded model/,
  );
  assert.throws(() => new InventoryGrid({
    width: 10,
    height: 4,
    items: [{ id: "oversized", width: Number.MAX_SAFE_INTEGER, height: 1, position: { x: 0, y: 0 } }],
  }), /bounded model/);
});

test("inventory grid gives large items their full rectangular footprint", () => {
  const grid = new InventoryGrid({ width: 10, height: 4 });
  assert.equal(grid.place({ id: "armor", width: 2, height: 3 }, { x: 0, y: 0 }), true);
  assert.equal(grid.itemAt(1, 2).id, "armor");
  assert.equal(grid.place({ id: "rune", width: 1, height: 1 }, { x: 1, y: 2 }), false);
  assert.equal(grid.place({ id: "rune", width: 1, height: 1 }, { x: 3, y: 2 }), true);
});

test("inventory movement is atomic when destination is blocked or outside the grid", () => {
  const grid = new InventoryGrid({
    width: 4,
    height: 4,
    items: [
      { id: "shield", width: 2, height: 3, position: { x: 0, y: 0 } },
      { id: "potion", width: 1, height: 1, position: { x: 3, y: 3 } },
    ],
  });
  assert.equal(grid.move("shield", { x: 2, y: 2 }), false);
  assert.deepEqual(grid.toJSON().items.find(({ id }) => id === "shield").position, { x: 0, y: 0 });
  assert.equal(grid.move("potion", { x: 2, y: 0 }), true);
  assert.deepEqual(grid.toJSON().items.find(({ id }) => id === "potion").position, { x: 2, y: 0 });
});

test("inventory snapshot restores one copy of every item", () => {
  const grid = new InventoryGrid({ width: 10, height: 4, items: [{ id: "tome", width: 2, height: 2, position: { x: 4, y: 1 } }] });
  const restored = InventoryGrid.fromJSON(grid.toJSON());
  assert.equal(restored.toJSON().items.length, 1);
  assert.equal(restored.itemAt(5, 2).id, "tome");
});
