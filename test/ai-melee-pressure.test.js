import test from "node:test";
import assert from "node:assert/strict";
import { AI_PROFILE_IDS, MELEE_PRESSURE, decideMeleePressure } from "../src/core/ai-profiles.js";
import { HexGrid, axial, hexDisk, hexDistance, hexKey } from "../src/core/hex-grid.js";
import { perceiveHostiles, reachableMeleeApproaches } from "../src/core/spatial-query.js";

const alwaysVisible = () => true;

function line(qFrom, qTo, r = 0) {
  const result = [];
  for (let q = qFrom; q <= qTo; q += 1) result.push(axial(q, r));
  return result;
}

function rectangle(qFrom, qTo, rFrom, rTo) {
  const result = [];
  for (let q = qFrom; q <= qTo; q += 1) {
    for (let r = rFrom; r <= rTo; r += 1) result.push(axial(q, r));
  }
  return result;
}

function decision(grid, overrides = {}) {
  const alive = overrides.alive ?? new Set(["warrior", "sorceress"]);
  return decideMeleePressure({
    grid,
    actorId: "fallen",
    hostileIds: ["warrior", "sorceress"],
    currentTargetId: null,
    isAlive: (id) => alive.has(id),
    hasLineOfSight: alwaysVisible,
    ...overrides,
  });
}

test("profile is explicitly identified as the MELEE_PRESSURE adaptation", () => {
  assert.equal(MELEE_PRESSURE.id, AI_PROFILE_IDS.MELEE_PRESSURE);
  assert.equal(MELEE_PRESSURE.ruleset, "ADAPTATION");
  assert.equal(MELEE_PRESSURE.meleeRange, 1);
  assert.ok(MELEE_PRESSURE.perceptionRange > 0);
  assert.ok(MELEE_PRESSURE.targetSwitchCostMargin >= 0);
  assert.ok(Object.isFrozen(MELEE_PRESSURE));
});

test("scenario A: a defender physically holds a one-hex passage", () => {
  const grid = new HexGrid({ tiles: line(-2, 3) });
  grid.addUnit({ id: "fallen", position: axial(-1, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 0) });
  grid.addUnit({ id: "sorceress", position: axial(2, 0) });

  // Even an old intent aimed at the rear does not make the mob walk past a
  // legal melee target or phase through the occupied choke point.
  const result = decision(grid, { currentTargetId: "sorceress" });

  assert.equal(result.type, "attack");
  assert.equal(result.targetId, "warrior");
  assert.equal(result.reason, "ATTACK_LEGAL_MELEE_TARGET");
  assert.equal(result.diagnostics.targetChangeReason, "LEGAL_MELEE_TARGET_AVAILABLE");
  assert.equal(grid.findPath("fallen", axial(1, 0)), null);
  assert.deepEqual(grid.positionOf("fallen"), axial(-1, 0));
  assert.equal(grid.occupantAt(axial(0, 0)), "warrior");
});

test("scenario B: an open flank remains legal and current pursuit has bounded hysteresis", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 5) });
  grid.addUnit({ id: "fallen", position: axial(-3, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 0) });
  grid.addUnit({ id: "sorceress", position: axial(-1, 2) });

  const before = Object.fromEntries(["fallen", "warrior", "sorceress"]
    .map((id) => [id, grid.positionOf(id)]));
  const result = decision(grid, { currentTargetId: "sorceress" });

  assert.equal(result.type, "move");
  assert.equal(result.targetId, "sorceress");
  assert.equal(result.reason, "CONTINUE_CURRENT_PURSUIT");
  assert.equal(result.diagnostics.retainedCurrentTarget, true);
  assert.equal(hexDistance(result.destination, grid.positionOf("sorceress")), 1);
  assert.ok(result.path.length > 1);
  assert.ok(result.path.every((cell) => hexKey(cell) !== hexKey(grid.positionOf("warrior"))));
  assert.ok(result.path.slice(1).every((cell) => grid.occupantAt(cell) == null));

  // The evaluator describes a command and diagnostics; it does not execute it.
  assert.deepEqual(Object.fromEntries(["fallen", "warrior", "sorceress"]
    .map((id) => [id, grid.positionOf(id)])), before);
});

test("target comparison uses weighted path cost rather than straight-line distance", () => {
  const costlyWarriorApproaches = new Map([
    ["-1,0", 9], ["-1,1", 9], ["0,-1", 9],
    ["0,1", 9], ["1,-1", 9], ["1,0", 9],
  ]);
  const grid = new HexGrid({
    tiles: hexDisk(axial(0, 0), 5),
    movementCosts: costlyWarriorApproaches,
  });
  grid.addUnit({ id: "fallen", position: axial(-3, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 0) });
  grid.addUnit({ id: "sorceress", position: axial(-1, 2) });

  const result = decision(grid);
  const byId = Object.fromEntries(result.diagnostics.candidates.map((row) => [row.targetId, row]));

  assert.equal(result.type, "move");
  assert.equal(result.targetId, "sorceress");
  assert.ok(byId.sorceress.pathCost < byId.warrior.pathCost);
  assert.ok(hexDistance(grid.positionOf("fallen"), grid.positionOf("warrior"))
    < hexDistance(grid.positionOf("fallen"), grid.positionOf("sorceress")));
});

test("scenario C: defender death removes occupancy and immediately causes reevaluation", () => {
  const grid = new HexGrid({ tiles: line(-2, 3) });
  grid.addUnit({ id: "fallen", position: axial(-1, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 0) });
  grid.addUnit({ id: "sorceress", position: axial(2, 0) });

  const first = decision(grid, { currentTargetId: "warrior" });
  assert.equal(first.type, "attack");
  assert.equal(first.targetId, "warrior");

  assert.equal(grid.removeUnit("warrior"), true);
  const second = decision(grid, {
    currentTargetId: "warrior",
    alive: new Set(["sorceress"]),
  });

  assert.equal(second.type, "move");
  assert.equal(second.targetId, "sorceress");
  assert.equal(second.diagnostics.targetChangeReason, "CURRENT_TARGET_DEAD");
  assert.ok(second.path.some((cell) => hexKey(cell) === "0,0"));
  assert.deepEqual(grid.positionOf("fallen"), axial(-1, 0));
});

test("LOS callback and perception radius prevent UUID-based omniscience through a wall", () => {
  const grid = new HexGrid({
    tiles: rectangle(-1, 10, -1, 2),
    blockedTerrain: [axial(1, 0)],
  });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 1) });
  grid.addUnit({ id: "sorceress", position: axial(2, 0) });
  grid.addUnit({ id: "far-target", position: axial(10, 0) });

  const callbackContexts = [];
  const perception = perceiveHostiles({
    grid,
    observerId: "fallen",
    hostileIds: ["far-target", "sorceress", "warrior"],
    isAlive: () => true,
    maxDistance: MELEE_PRESSURE.perceptionRange,
    hasLineOfSight: (context) => {
      callbackContexts.push(context);
      return context.targetId !== "sorceress";
    },
  });

  assert.deepEqual(perception.detected.map(({ targetId }) => targetId), ["warrior"]);
  assert.deepEqual(Object.fromEntries(perception.rejected.map((row) => [row.targetId, row.reason])), {
    "far-target": "OUT_OF_PERCEPTION",
    sorceress: "NO_LINE_OF_SIGHT",
  });
  assert.ok(callbackContexts.every((context) => {
    const keys = Object.keys(context).sort();
    return assert.deepEqual(keys, [
      "distance", "observerId", "observerPosition", "targetId", "targetPosition",
    ]), true;
  }));

  const result = decision(grid, {
    hostileIds: ["sorceress", "warrior"],
    currentTargetId: "sorceress",
    hasLineOfSight: ({ targetId }) => targetId !== "sorceress",
  });
  assert.equal(result.type, "attack");
  assert.equal(result.targetId, "warrior");
  assert.equal(result.diagnostics.targetChangeReason, "CURRENT_TARGET_NOT_VISIBLE");
});

test("legal attack positions use the same footprint-aware collision rules as HexGrid", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 4) });
  grid.addUnit({ id: "fallen", position: axial(-3, 0) });
  grid.addUnit({ id: "blocker", position: axial(-1, 0) });
  grid.addUnit({ id: "warrior", position: axial(0, 0) });

  const approaches = reachableMeleeApproaches({
    grid,
    attackerId: "fallen",
    targetId: "warrior",
  });

  assert.ok(approaches.length > 0);
  assert.ok(approaches.every(({ position, path }) => hexKey(position) !== "-1,0"
    && path.every((cell) => hexKey(cell) !== "-1,0")));
  assert.equal(grid.occupantAt(axial(-1, 0)), "blocker");
  assert.deepEqual(grid.positionOf("fallen"), axial(-3, 0));
});
