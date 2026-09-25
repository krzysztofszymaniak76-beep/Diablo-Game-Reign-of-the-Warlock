import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_RULESET,
  ControlEffectRegistry,
  TAUNT_IMMUNITY_TAGS,
  resolveTauntControlDecision,
} from "../src/core/control-effects.js";
import { decideMeleePressure } from "../src/core/ai-profiles.js";
import { HexGrid, axial, hexDisk, hexDistance, hexKey } from "../src/core/hex-grid.js";

function addTaunt(registry, overrides = {}, options = {}) {
  return registry.applyTaunt({
    id: "taunt-1",
    sourceId: "provoker",
    targetId: "fallen",
    startsAt: 10,
    expiresAt: 100,
    ...overrides,
  }, options);
}

function resolve(registry, grid, overrides = {}) {
  const alive = overrides.alive ?? new Set(["fallen", "provoker"]);
  return resolveTauntControlDecision({
    registry,
    simTime: 25,
    grid,
    actorId: "fallen",
    isAlive: (id) => alive.has(id),
    isVisible: () => true,
    hasLineOfSight: () => true,
    ...overrides,
  });
}

test("vulnerable ordinary target attacks an adjacent Taunt source through the controlDecision contract", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "provoker", position: axial(1, 0) });
  grid.addUnit({ id: "other-hero", position: axial(0, 2) });
  const registry = new ControlEffectRegistry();
  const application = addTaunt(registry);

  assert.equal(application.applied, true);
  assert.equal(application.effect.ruleset, CONTROL_RULESET);
  const controlDecision = resolve(registry, grid);
  assert.deepEqual(controlDecision, {
    type: "attack",
    targetId: "provoker",
    destination: null,
    path: null,
    reason: "TAUNT_ATTACK_SOURCE",
  });
  assert.ok(Object.isFrozen(controlDecision));

  const decision = decideMeleePressure({
    grid,
    actorId: "fallen",
    hostileIds: ["other-hero"],
    isAlive: () => true,
    hasLineOfSight: () => true,
    controlDecision,
  });
  assert.equal(decision.type, "attack");
  assert.equal(decision.targetId, "provoker");
  assert.equal(decision.reason, "TAUNT_ATTACK_SOURCE");
  assert.equal(decision.diagnostics.targetChangeReason, "CONTROL_OVERRIDE");
});

test("distant Taunt creates a legal occupied-cell-aware path without teleporting", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 5) });
  grid.addUnit({ id: "fallen", position: axial(-3, 0) });
  grid.addUnit({ id: "blocker", position: axial(-1, 0) });
  grid.addUnit({ id: "provoker", position: axial(1, 0) });
  const registry = new ControlEffectRegistry();
  addTaunt(registry);
  const before = grid.positionOf("fallen");

  const controlDecision = resolve(registry, grid);

  assert.equal(controlDecision.type, "move");
  assert.equal(controlDecision.targetId, "provoker");
  assert.equal(controlDecision.reason, "TAUNT_MOVE_TOWARD_SOURCE");
  assert.deepEqual(controlDecision.path[0], before);
  assert.deepEqual(controlDecision.path.at(-1), controlDecision.destination);
  assert.equal(hexDistance(controlDecision.destination, grid.positionOf("provoker")), 1);
  assert.ok(controlDecision.path.every((cell) => hexKey(cell) !== "-1,0"));
  assert.ok(Object.isFrozen(controlDecision));
  assert.ok(Object.isFrozen(controlDecision.path));
  assert.ok(controlDecision.path.every(Object.isFrozen));
  assert.deepEqual(grid.positionOf("fallen"), before);
  assert.equal(grid.occupantAt(axial(-1, 0)), "blocker");
});

test("Taunt immunity tag rejects application and a later immunity tag suppresses an active effect", () => {
  assert.deepEqual(TAUNT_IMMUNITY_TAGS, ["CONTROL_IMMUNE", "TAUNT_IMMUNE"]);
  const immuneRegistry = new ControlEffectRegistry();
  const rejected = addTaunt(immuneRegistry, {}, { targetTags: ["TAUNT_IMMUNE"] });
  assert.deepEqual(rejected, { applied: false, reason: "TARGET_IMMUNE", effect: null });
  assert.equal(immuneRegistry.snapshot().effects.length, 0);

  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "provoker", position: axial(1, 0) });
  const activeRegistry = new ControlEffectRegistry();
  addTaunt(activeRegistry);
  assert.equal(resolve(activeRegistry, grid, { tagsFor: () => ["CONTROL_IMMUNE"] }), null);
});

test("Taunt is active only in its half-open simulation-time interval", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "provoker", position: axial(1, 0) });
  const registry = new ControlEffectRegistry();
  addTaunt(registry, { startsAt: 20, expiresAt: 50 });

  assert.equal(resolve(registry, grid, { simTime: 19 }), null);
  assert.equal(resolve(registry, grid, { simTime: 20 }).type, "attack");
  assert.equal(resolve(registry, grid, { simTime: 49 }).type, "attack");
  assert.equal(resolve(registry, grid, { simTime: 50 }), null);
});

test("dead, invisible, absent, or unreachable Taunt source never becomes a forced command", async (context) => {
  await context.test("dead source", () => {
    const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
    grid.addUnit({ id: "fallen", position: axial(0, 0) });
    grid.addUnit({ id: "provoker", position: axial(1, 0) });
    const registry = new ControlEffectRegistry();
    addTaunt(registry);
    assert.equal(resolve(registry, grid, { alive: new Set(["fallen"]) }), null);
  });

  await context.test("invisible or outside line of sight", () => {
    const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
    grid.addUnit({ id: "fallen", position: axial(0, 0) });
    grid.addUnit({ id: "provoker", position: axial(1, 0) });
    const registry = new ControlEffectRegistry();
    addTaunt(registry);
    assert.equal(resolve(registry, grid, { isVisible: () => false }), null);
    assert.equal(resolve(registry, grid, { hasLineOfSight: () => false }), null);
  });

  await context.test("source absent from grid", () => {
    const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
    grid.addUnit({ id: "fallen", position: axial(0, 0) });
    const registry = new ControlEffectRegistry();
    addTaunt(registry, { sourceId: "provoker" });
    assert.equal(resolve(registry, grid), null);
  });

  await context.test("source has no reachable melee approach", () => {
    const tiles = Array.from({ length: 5 }, (_, index) => axial(index - 2, 0));
    const grid = new HexGrid({
      tiles,
      blockedTerrain: [axial(0, 0)],
      lineOfSightBlockers: [],
    });
    grid.addUnit({ id: "fallen", position: axial(-2, 0) });
    grid.addUnit({ id: "provoker", position: axial(2, 0) });
    const registry = new ControlEffectRegistry();
    addTaunt(registry);
    assert.equal(resolve(registry, grid), null);
    assert.deepEqual(grid.positionOf("fallen"), axial(-2, 0));
  });
});

test("multiple Taunts have insertion-independent precedence and snapshot restore preserves the decision", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "provoker-a", position: axial(1, 0) });
  grid.addUnit({ id: "provoker-b", position: axial(0, 1) });
  const registry = new ControlEffectRegistry();
  addTaunt(registry, {
    id: "taunt-b",
    sourceId: "provoker-b",
    priority: 7,
    startsAt: 10,
  });
  addTaunt(registry, {
    id: "taunt-a",
    sourceId: "provoker-a",
    priority: 7,
    startsAt: 10,
  });
  const alive = new Set(["fallen", "provoker-a", "provoker-b"]);

  const before = resolve(registry, grid, { alive });
  const snapshot = registry.snapshot();
  const restored = ControlEffectRegistry.restore(structuredClone(snapshot));
  const after = resolve(restored, grid, { alive });

  assert.equal(before.targetId, "provoker-a");
  assert.deepEqual(after, before);
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.effects));
});

test("an invalid higher-priority source falls through to the next legal active Taunt", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 2) });
  grid.addUnit({ id: "fallen", position: axial(0, 0) });
  grid.addUnit({ id: "dead-provoker", position: axial(1, 0) });
  grid.addUnit({ id: "live-provoker", position: axial(0, 1) });
  const registry = new ControlEffectRegistry();
  addTaunt(registry, { id: "highest", sourceId: "dead-provoker", priority: 99 });
  addTaunt(registry, { id: "fallback", sourceId: "live-provoker", priority: 1 });

  const decision = resolve(registry, grid, { alive: new Set(["fallen", "live-provoker"]) });
  assert.equal(decision.type, "attack");
  assert.equal(decision.targetId, "live-provoker");
});
