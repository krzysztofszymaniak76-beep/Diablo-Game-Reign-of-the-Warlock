import test from "node:test";
import assert from "node:assert/strict";
import {
  HexGrid,
  axial,
  axialToOddRowColumn,
  hexDisk,
  hexDistance,
  hexKey,
  hexNeighbors,
  oddRowOffsetToAxial,
} from "../src/core/hex-grid.js";

function rectangle(qFrom, qTo, rFrom, rTo) {
  const result = [];
  for (let q = qFrom; q <= qTo; q += 1) {
    for (let r = rFrom; r <= rTo; r += 1) result.push(axial(q, r));
  }
  return result;
}

test("axial hex primitives use q,r as the only position model", () => {
  const center = axial(2, -1);
  assert.equal(hexKey(center), "2,-1");
  assert.equal(hexNeighbors(center).length, 6);
  assert.ok(hexNeighbors(center).every((neighbor) => hexDistance(center, neighbor) === 1));
  assert.equal(hexDistance(axial(-2, 1), axial(3, -2)), 5);
  assert.throws(() => hexKey({ x: 2, y: -1 }), /axial \{ q, r \}/);
});

test("odd-row reference columns round-trip without changing axial adjacency", () => {
  for (let row = 0; row < 10; row += 1) {
    const columns = row % 2 === 0 ? 18 : 17;
    for (let column = 0; column < columns; column += 1) {
      const position = oddRowOffsetToAxial(column, row);
      assert.equal(axialToOddRowColumn(position), column);
    }
  }
  const origin = oddRowOffsetToAxial(4, 4);
  assert.ok(hexNeighbors(origin).every((neighbor) => hexDistance(origin, neighbor) === 1));
});

test("movement reaches the exact selected hex along a deterministic legal path", () => {
  const grid = new HexGrid({
    tiles: rectangle(0, 5, -2, 2),
    blockedTerrain: [axial(2, 0)],
    movementCosts: new Map([["1,0", 2]]),
  });
  grid.addUnit({ id: "hero", position: axial(0, 0) });

  const selected = axial(4, 0);
  const firstPath = grid.findPath("hero", selected);
  const repeatedPath = grid.findPath("hero", selected);
  assert.deepEqual(repeatedPath, firstPath);
  assert.deepEqual(firstPath.at(0), axial(0, 0));
  assert.deepEqual(firstPath.at(-1), selected);
  assert.ok(firstPath.every((cell) => hexKey(cell) !== "2,0"));
  assert.ok(firstPath.slice(1).every((cell, index) => hexDistance(firstPath[index], cell) === 1));

  const reachableForTwo = grid.reachable("hero", 2);
  assert.ok(reachableForTwo.some(({ position, cost }) => hexKey(position) === "1,0" && cost === 2));
  assert.ok(!reachableForTwo.some(({ position }) => hexKey(position) === hexKey(selected)));

  const travelled = grid.moveUnit("hero", selected);
  assert.deepEqual(travelled, firstPath);
  assert.deepEqual(grid.positionOf("hero"), selected);
  assert.equal(Object.hasOwn(grid.positionOf("hero"), "x"), false);
});

test("terrain and every occupied boss-footprint hex block movement", () => {
  const grid = new HexGrid({
    tiles: rectangle(-5, 5, -4, 4),
    blockedTerrain: [axial(-3, 1)],
  });
  grid.addUnit({ id: "hero", position: axial(-4, 0) });
  grid.addUnit({ id: "boss", position: axial(0, 0), footprint: hexDisk(axial(0, 0), 1) });

  const bossCells = new Set(grid.occupiedHexes("boss").map(hexKey));
  assert.equal(bossCells.size, 7);
  assert.ok([...bossCells].every((id) => grid.occupantAt(grid.tiles().find((tile) => hexKey(tile) === id)) === "boss"));
  assert.equal(grid.canOccupy(axial(0, 1)), false);
  assert.throws(() => grid.addUnit({ id: "minion", position: axial(1, -1) }), /cannot occupy/);

  const routeAroundBoss = grid.findPath("hero", axial(4, 0));
  assert.deepEqual(routeAroundBoss.at(-1), axial(4, 0));
  assert.ok(routeAroundBoss.every((cell) => !bossCells.has(hexKey(cell))));
  assert.ok(routeAroundBoss.every((cell) => hexKey(cell) !== "-3,1"));

  const beforeIllegalMove = grid.positionOf("hero");
  assert.equal(grid.findPath("hero", axial(0, 1)), null);
  assert.equal(grid.moveUnit("hero", axial(0, 1)), null);
  assert.deepEqual(grid.positionOf("hero"), beforeIllegalMove);
});
