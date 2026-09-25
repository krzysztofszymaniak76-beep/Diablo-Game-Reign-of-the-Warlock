import test from "node:test";
import assert from "node:assert/strict";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { ACTION_TIME, CombatState } from "../src/core/combat.js";
import { HexGrid, axial, hexDisk, hexKey } from "../src/core/hex-grid.js";

function makeWorld({ enemyReadyAt = 500, enemyPosition = axial(5, 0) } = {}) {
  const roster = new Roster([createCharacter({ id: "hero", name: "Hero", classId: "paladin" })]);
  const party = new Party(roster, ["hero"]);
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, seed: 17 });
  const enemy = combat.spawnMonster({
    id: "enemy",
    name: "Enemy",
    baseHp: 100,
    baseExperience: 1,
    position: enemyPosition,
  });
  enemy.readyAt = enemyReadyAt;
  combat.units.get("hero").position = axial(0, 0);
  const grid = new HexGrid({ tiles: hexDisk(axial(2, 0), 6) });
  grid.addUnit({ id: "hero", position: axial(0, 0) });
  grid.addUnit({ id: "enemy", position: enemyPosition });
  return { roster, party, playersSetting, combat, grid, enemy };
}

function ownedState({ roster, party, combat }) {
  return {
    combat: combat.snapshot(),
    partySlots: structuredClone(party.slots),
    roster: roster.toJSON(),
    playersSettingValue: combat.playersSetting.value,
  };
}

function moveDescriptors(path) {
  return path.slice(1).map((to, index) => ({
    offset: (index + 1) * ACTION_TIME.movePerTile,
    kind: "move:step",
    payload: { from: path[index], to, stepIndex: index + 1 },
  }));
}

function submitReservedMove(combat, grid, actorId, path, transactionId) {
  const distance = path.length - 1;
  const result = combat.submitSequence(actorId, "move", {
    distance,
    path,
    to: path.at(-1),
  }, {
    transactionId,
    events: moveDescriptors(path),
  });
  result.events.forEach((event, index) => {
    grid.reserveStep({
      commandId: result.commandId,
      eventId: event.id,
      unitId: actorId,
      at: event.at,
      from: path[index],
      to: path[index + 1],
    });
  });
  return result;
}

function advanceWorld(combat, grid, legalIds) {
  return combat.advanceTimeline(legalIds, {
    resolve: (event, resolveCore) => {
      if (event.kind === "move:step") {
        const moved = grid.commitReservedStep(event.id);
        if (!moved) throw new Error("movement step became blocked");
      }
      return resolveCore();
    },
    onInterrupt: ({ command }) => grid.releaseReservationsByCommand(command.commandId),
  });
}

test("combat snapshot owns Taunt control state and rejects effects that reference absent units", () => {
  const { party, playersSetting, combat } = makeWorld();
  combat.controlEffects.applyTaunt({
    id: "taunt-save-1",
    sourceId: "hero",
    targetId: "enemy",
    startsAt: 10,
    expiresAt: 1010,
    priority: 2,
  });

  const snapshot = combat.snapshot();
  const restored = CombatState.restore(structuredClone(snapshot), { party, playersSetting });
  assert.deepEqual(restored.controlEffects.snapshot(), snapshot.controlEffects);

  const corrupt = structuredClone(snapshot);
  corrupt.controlEffects.effects[0].sourceId = "missing-provoker";
  assert.throws(
    () => CombatState.restore(corrupt, { party, playersSetting }),
    /Control effect references a missing unit/,
  );
});

test("three-step movement exposes every intermediate position on the common timeline", () => {
  const { combat, grid } = makeWorld();
  assert.equal(combat.nextReady(["hero", "enemy"]).id, "hero");
  const path = [axial(0, 0), axial(1, 0), axial(2, 0), axial(3, 0)];
  submitReservedMove(combat, grid, "hero", path, "move-three");

  const first = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(first.type, "event");
  assert.equal(first.event.kind, "move:step");
  assert.equal(combat.scheduler.time, 350);
  assert.deepEqual(grid.positionOf("hero"), axial(1, 0));
  assert.deepEqual(combat.units.get("hero").position, axial(1, 0));

  const enemyWindow = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(enemyWindow.type, "ready");
  assert.equal(enemyWindow.entry.id, "enemy");
  assert.equal(combat.scheduler.time, 500);
  assert.deepEqual(grid.positionOf("hero"), axial(1, 0));
});

test("an enemy impact resolves between later movement steps", () => {
  const { roster, combat, grid } = makeWorld();
  combat.nextReady(["hero", "enemy"]);
  submitReservedMove(combat, grid, "hero", [axial(0, 0), axial(1, 0), axial(2, 0), axial(3, 0)], "march");
  advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(advanceWorld(combat, grid, ["hero", "enemy"]).entry.id, "enemy");

  const hpBefore = roster.get("hero").resources.hp;
  combat.submitSequence("enemy", "attack", { targetId: "hero", damage: 7 }, {
    transactionId: "enemy-hit",
    events: [{ offset: 100, kind: "attack:impact", payload: { targetId: "hero", damage: 7 } }],
  });
  const impact = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(impact.event.kind, "attack:impact");
  assert.equal(combat.scheduler.time, 600);
  assert.equal(roster.get("hero").resources.hp, hpBefore - 7);
  assert.deepEqual(grid.positionOf("hero"), axial(1, 0));

  const secondStep = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(secondStep.event.kind, "move:step");
  assert.equal(combat.scheduler.time, 700);
  assert.deepEqual(grid.positionOf("hero"), axial(2, 0));
});

test("a dynamic blocker interrupts only future steps and preserves elapsed recovery", () => {
  const { combat, grid } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero"]);
  const command = submitReservedMove(
    combat,
    grid,
    "hero",
    [axial(0, 0), axial(1, 0), axial(2, 0), axial(3, 0)],
    "blocked-march",
  );
  advanceWorld(combat, grid, ["hero"]);
  grid.addUnit({ id: "new-blocker", position: axial(2, 0) });

  const interrupted = advanceWorld(combat, grid, ["hero"]);
  assert.equal(interrupted.type, "interrupted");
  assert.equal(interrupted.event.at, 700);
  assert.equal(interrupted.interruption.command.commandId, command.commandId);
  assert.deepEqual(grid.positionOf("hero"), axial(1, 0));
  assert.equal(grid.reservations().length, 0);
  assert.ok(!combat.timelinePreview(20).some((event) => event.payload?.commandId === command.commandId));

  const ready = advanceWorld(combat, grid, ["hero"]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.entry.id, "hero");
  assert.equal(combat.scheduler.time, 1050);
});

test("death cancels only the defeated actor's remaining action events", () => {
  const { combat, grid, enemy } = makeWorld({ enemyReadyAt: 0, enemyPosition: axial(3, 0) });
  combat.units.get("enemy").readinessTieKey = "z-enemy";
  combat.nextReady(["hero", "enemy"]);
  combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 500 }, {
    events: [{ offset: 400, kind: "attack:impact", payload: { targetId: "enemy", damage: 500 } }],
  });
  assert.equal(advanceWorld(combat, grid, ["hero", "enemy"]).entry.id, "enemy");
  const enemyMove = submitReservedMove(
    combat,
    grid,
    "enemy",
    [axial(3, 0), axial(2, 0), axial(1, 0)],
    "enemy-march",
  );

  assert.equal(advanceWorld(combat, grid, ["hero", "enemy"]).event.at, 350);
  assert.deepEqual(grid.positionOf("enemy"), axial(2, 0));
  const lethal = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(lethal.event.kind, "attack:impact");
  assert.equal(enemy.hp, 0);
  assert.ok(lethal.interruptions.some(({ command }) => command.commandId === enemyMove.commandId));
  assert.equal(grid.reservations().length, 0);
  assert.ok(!combat.timelinePreview(20).some((event) => event.payload?.commandId === enemyMove.commandId));
});

test("same-time reservations have one deterministic winner", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 3) });
  grid.addUnit({ id: "left", position: axial(-1, 0) });
  grid.addUnit({ id: "right", position: axial(1, 0) });
  const winner = grid.reserveStep({
    commandId: "command-left",
    eventId: "event-left",
    unitId: "left",
    at: 350,
    from: axial(-1, 0),
    to: axial(0, 0),
  });
  assert.equal(winner.eventId, "event-left");
  assert.throws(() => grid.reserveStep({
    commandId: "command-right",
    eventId: "event-right",
    unitId: "right",
    at: 350,
    from: axial(1, 0),
    to: axial(0, 0),
  }), /Reservation conflict/);
});

test("manual readiness is a real scheduler event and pauses without wall-time progress", () => {
  const { combat } = makeWorld();
  const first = combat.advanceTimeline(["hero", "enemy"]);
  assert.equal(first.type, "ready");
  assert.equal(first.event.kind, "actor:ready");
  assert.equal(combat.scheduler.time, 0);
  const repeated = combat.advanceTimeline(["hero", "enemy"]);
  assert.equal(repeated.type, "ready");
  assert.equal(repeated.entry.id, "hero");
  assert.equal(combat.scheduler.time, 0);
});

test("same-tick readiness does not grant blanket priority to the whole party", () => {
  const roster = new Roster([
    createCharacter({ id: "cassia", name: "Cassia", classId: "amazon" }),
    createCharacter({ id: "hadriel", name: "Hadriel", classId: "paladin" }),
  ]);
  const combat = new CombatState({
    party: new Party(roster, ["cassia", "hadriel"]),
    playersSetting: new PlayersSetting(1),
  });
  combat.spawnMonster({ id: "fallen", name: "Fallen", baseHp: 10, baseExperience: 1 });
  const legal = ["hadriel", "fallen", "cassia"];
  assert.equal(combat.nextReady(legal).id, "cassia");
  combat.submitAction("cassia", "wait");
  assert.equal(combat.nextReady(legal).id, "fallen");
  combat.submitAction("fallen", "wait");
  assert.equal(combat.nextReady(legal).id, "hadriel");
});

test("a save between movement steps restores the identical future trace", () => {
  const original = makeWorld({ enemyReadyAt: 5000 });
  original.combat.nextReady(["hero"]);
  submitReservedMove(
    original.combat,
    original.grid,
    "hero",
    [axial(0, 0), axial(1, 0), axial(2, 0), axial(3, 0)],
    "save-mid-march",
  );
  advanceWorld(original.combat, original.grid, ["hero"]);

  const restoredRoster = new Roster(original.roster.toJSON());
  const restoredParty = new Party(restoredRoster, ["hero"]);
  const restoredCombat = CombatState.restore(original.combat.snapshot(), {
    party: restoredParty,
    playersSetting: new PlayersSetting(1),
  });
  const restoredGrid = HexGrid.restore(original.grid.snapshot());

  function finish(combat, grid) {
    const trace = [];
    for (let index = 0; index < 4; index += 1) {
      const boundary = advanceWorld(combat, grid, ["hero"]);
      trace.push(boundary.type === "ready"
        ? [boundary.type, boundary.entry.id, combat.scheduler.time]
        : [boundary.type, boundary.event.kind, combat.scheduler.time, hexKey(grid.positionOf("hero"))]);
      if (boundary.type === "ready") break;
    }
    return trace;
  }

  assert.deepEqual(finish(restoredCombat, restoredGrid), finish(original.combat, original.grid));
  assert.deepEqual(restoredCombat.snapshot(), original.combat.snapshot());
  assert.deepEqual(restoredGrid.snapshot(), original.grid.snapshot());
});

test("transaction retries are idempotent but cannot change a sequence", () => {
  const { combat, grid } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero"]);
  const path = [axial(0, 0), axial(1, 0)];
  const first = submitReservedMove(combat, grid, "hero", path, "stable-transaction");
  const replay = combat.submitSequence("hero", "move", { distance: 1, path, to: path.at(-1) }, {
    transactionId: "stable-transaction",
    events: moveDescriptors(path),
  });
  assert.equal(replay.commandId, first.commandId);
  assert.equal(replay.replayed, true);
  assert.throws(() => combat.submitSequence("hero", "move", { distance: 1, path, to: path.at(-1) }, {
    transactionId: "stable-transaction",
    events: [{ offset: 200, kind: "move:step", payload: { from: path[0], to: path[1] } }],
  }), /different command/);
});

test("automatic transaction ids cannot overwrite an explicit transaction", () => {
  const { combat } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero"]);
  const explicit = combat.submitAction("hero", "wait", {}, { transactionId: "transaction-auto-0" });
  combat.nextReady(["hero"]);
  const automatic = combat.submitAction("hero", "wait");
  assert.equal(automatic.transactionId, "transaction-auto-1");
  assert.notEqual(automatic.transactionId, explicit.transactionId);

  const replay = combat.submitAction("hero", "wait", {}, { transactionId: "transaction-auto-0" });
  assert.equal(replay.commandId, explicit.commandId);
  assert.equal(replay.replayed, true);
});

test("a save can restore a future reservation that became dynamically blocked", () => {
  const { combat, grid } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero"]);
  submitReservedMove(combat, grid, "hero", [axial(0, 0), axial(1, 0), axial(2, 0)], "future-block");
  advanceWorld(combat, grid, ["hero"]);
  grid.addUnit({ id: "late-blocker", position: axial(2, 0) });

  const restoredGrid = HexGrid.restore(grid.snapshot());
  assert.equal(restoredGrid.reservations().length, 1);
  assert.deepEqual(restoredGrid.positionOf("hero"), axial(1, 0));
  assert.deepEqual(restoredGrid.positionOf("late-blocker"), axial(2, 0));

  const restoredCombat = CombatState.restore(combat.snapshot(), {
    party: combat.party,
    playersSetting: combat.playersSetting,
  });
  const interrupted = advanceWorld(restoredCombat, restoredGrid, ["hero"]);
  assert.equal(interrupted.type, "interrupted");
  assert.match(interrupted.error.message, /blocked/);
  assert.equal(restoredGrid.reservations().length, 0);
  assert.deepEqual(restoredGrid.positionOf("hero"), axial(1, 0));
});

test("restore never treats static or missing terrain as a valid future reservation", () => {
  const grid = new HexGrid({
    tiles: [axial(0, 0), axial(1, 0), axial(2, 0)],
    blockedTerrain: [axial(2, 0)],
  });
  grid.addUnit({ id: "hero", position: axial(0, 0) });
  grid.reserveStep({
    commandId: "command-safe",
    eventId: "event-safe",
    unitId: "hero",
    at: 350,
    from: axial(0, 0),
    to: axial(1, 0),
  });
  const snapshot = grid.snapshot();

  const staticBlock = structuredClone(snapshot);
  staticBlock.reservations[0].from = axial(1, 0);
  staticBlock.reservations[0].to = axial(2, 0);
  assert.throws(() => HexGrid.restore(staticBlock), /missing or blocked terrain/);

  const outside = structuredClone(snapshot);
  outside.reservations[0].from = axial(1, 0);
  outside.reservations[0].to = axial(1, 1);
  assert.throws(() => HexGrid.restore(outside), /missing or blocked terrain/);
});

test("restore rejects a timeline event reassigned to another actor or transaction", () => {
  const { combat, party, playersSetting } = makeWorld({ enemyReadyAt: 0, enemyPosition: axial(3, 0) });
  combat.units.get("enemy").readinessTieKey = "z-enemy";
  combat.nextReady(["hero", "enemy"]);
  combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 3 }, {
    transactionId: "restore-integrity",
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 3 } }],
  });
  const clean = combat.snapshot();

  const wrongActor = structuredClone(clean);
  wrongActor.scheduler.queue.find(({ kind }) => kind === "attack:impact").actorId = "enemy";
  assert.throws(() => CombatState.restore(wrongActor, { party, playersSetting }), /disagrees with active command/);

  const wrongTransaction = structuredClone(clean);
  wrongTransaction.scheduler.queue.find(({ kind }) => kind === "attack:impact").payload.transactionId = "other";
  assert.throws(() => CombatState.restore(wrongTransaction, { party, playersSetting }), /disagrees with active command/);

  const wrongKind = structuredClone(clean);
  wrongKind.scheduler.queue.find(({ kind }) => kind === "attack:impact").kind = "move:step";
  assert.throws(() => CombatState.restore(wrongKind, { party, playersSetting }), /disagrees with active command/);

  const wrongTick = structuredClone(clean);
  wrongTick.scheduler.queue.find(({ kind }) => kind === "attack:impact").at += 1;
  assert.throws(() => CombatState.restore(wrongTick, { party, playersSetting }), /disagrees with active command/);

  const wrongPayload = structuredClone(clean);
  wrongPayload.scheduler.queue.find(({ kind }) => kind === "attack:impact").payload.damage = 999;
  assert.throws(() => CombatState.restore(wrongPayload, { party, playersSetting }), /transaction is inconsistent/);

  const staleCommandSequence = structuredClone(clean);
  staleCommandSequence.readiness.commandSequence = 0;
  assert.throws(() => CombatState.restore(staleCommandSequence, { party, playersSetting }), /commandSequence/);

  const staleReadinessSequence = structuredClone(clean);
  staleReadinessSequence.readiness.sequence = 0;
  assert.throws(() => CombatState.restore(staleReadinessSequence, { party, playersSetting }), /readiness.sequence/);

  const automatic = makeWorld({ enemyReadyAt: 5000, enemyPosition: axial(3, 0) });
  automatic.combat.nextReady(["hero", "enemy"]);
  automatic.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 1 }, {
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 1 } }],
  });
  const staleTransactionSequence = automatic.combat.snapshot();
  staleTransactionSequence.readiness.transactionSequence = 0;
  assert.throws(() => CombatState.restore(staleTransactionSequence, {
    party: automatic.party,
    playersSetting: automatic.playersSetting,
  }), /transactionSequence/);
});

test("walkability, sight and projectile blockers are separate queries", () => {
  const grid = new HexGrid({
    tiles: hexDisk(axial(0, 0), 3),
    blockedTerrain: [axial(0, 1)],
    lineOfSightBlockers: [axial(1, 0)],
    projectileBlockers: [axial(1, -1)],
  });
  assert.equal(grid.isTerrainBlocked(axial(0, 1)), true);
  assert.equal(grid.blocksLineOfSight(axial(0, 1)), false);
  assert.equal(grid.blocksProjectile(axial(0, 1)), false);
  assert.equal(grid.hasLineOfSight(axial(0, 0), axial(2, 0)), false);
  assert.equal(grid.hasProjectilePath(axial(0, 0), axial(2, 0)), true);
  assert.equal(grid.hasProjectilePath(axial(0, 0), axial(2, -2)), false);
});

test("an ordinary unit occupies one hex while an explicit large footprint occupies seven", () => {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 4) });
  grid.addUnit({ id: "fallen", position: axial(-2, 0) });
  grid.addUnit({ id: "boss", position: axial(1, 0), footprint: hexDisk(axial(0, 0), 1) });
  assert.equal(grid.occupiedHexes("fallen").length, 1);
  assert.equal(grid.occupiedHexes("boss").length, 7);
});

test("submitAction applies core at most once even when a resolver calls it twice", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const { combat, enemy } = world;
  combat.nextReady(["hero", "enemy"]);
  const enemyReference = enemy;
  let first;
  let second;

  combat.submitAction("hero", "attack", { targetId: "enemy", damage: 7 }, {
    resolve: (_event, resolveCore) => {
      first = resolveCore();
      second = resolveCore();
      return "resolved";
    },
  });

  assert.equal(first, second);
  assert.equal(enemy.hp, 93);
  assert.equal(combat.units.get("enemy"), enemyReference);
  assert.equal(combat.log.filter((entry) => entry === "hero zadaje 7 obrażeń enemy.").length, 1);
});

test("submitAction rejects declared async before invocation and rolls back a sync thenable after core", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const { combat, enemy } = world;
  combat.nextReady(["hero", "enemy"]);
  const baseline = ownedState(world);
  const enemyReference = enemy;
  let asyncInvoked = false;

  assert.throws(() => combat.submitAction("hero", "attack", { targetId: "enemy", damage: 9 }, {
    resolve: async () => {
      asyncInvoked = true;
    },
  }), /resolve must be synchronous/);
  assert.equal(asyncInvoked, false);
  assert.deepEqual(ownedState(world), baseline);

  assert.throws(() => combat.submitAction("hero", "attack", { targetId: "enemy", damage: 9 }, {
    resolve: (_event, resolveCore) => {
      resolveCore();
      combat.log.push("resolver mutation that must roll back");
      return Promise.resolve("late result");
    },
  }), /resolve must be synchronous/);
  assert.deepEqual(ownedState(world), baseline);
  assert.equal(combat.units.get("enemy"), enemyReference);
  assert.equal(enemy.hp, 100);
});

test("submitAction rolls back engine, party and roster state when a resolver throws after core", () => {
  const world = makeWorld({ enemyReadyAt: 0 });
  const { combat, roster } = world;
  assert.equal(combat.nextReady(["hero", "enemy"]).id, "enemy");
  const baseline = ownedState(world);
  const heroReference = roster.get("hero");

  assert.throws(() => combat.submitAction("enemy", "attack", { targetId: "hero", damage: 11 }, {
    resolve: (_event, resolveCore) => {
      resolveCore();
      combat.playersSetting.set(8);
      throw new Error("domain commit failed");
    },
  }), /domain commit failed/);

  assert.deepEqual(ownedState(world), baseline);
  assert.equal(roster.get("hero"), heroReference);
  assert.equal(heroReference.resources.hp, heroReference.resources.maxHp);
});

test("submitSequence rolls back resolveStart and every partial scheduler commit", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const { combat, enemy } = world;
  combat.nextReady(["hero", "enemy"]);
  const baseline = ownedState(world);
  const enemyReference = enemy;
  const inheritedSchedule = combat.scheduler.schedule;
  let scheduleCalls = 0;
  combat.scheduler.schedule = function scheduleWithSecondWriteFailure(descriptor) {
    scheduleCalls += 1;
    if (scheduleCalls === 2) throw new Error("scheduler commit failed");
    return inheritedSchedule.call(this, descriptor);
  };

  try {
    assert.throws(() => combat.submitSequence("hero", "move", {
      distance: 2,
      path: [axial(0, 0), axial(1, 0), axial(2, 0)],
      to: axial(2, 0),
    }, {
      events: moveDescriptors([axial(0, 0), axial(1, 0), axial(2, 0)]),
      resolveStart: () => {
        enemy.hp -= 30;
        combat.log.push("start mutation that must roll back");
        return "started";
      },
    }), /scheduler commit failed/);
  } finally {
    delete combat.scheduler.schedule;
  }

  assert.deepEqual(ownedState(world), baseline);
  assert.equal(combat.units.get("enemy"), enemyReference);
  assert.equal(enemy.hp, 100);
});

test("submitSequence rejects async resolveStart before invocation and rolls back a thenable", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const { combat } = world;
  combat.nextReady(["hero", "enemy"]);
  const baseline = ownedState(world);
  const events = [{ offset: 350, kind: "move:step", payload: { to: axial(1, 0) } }];
  let asyncInvoked = false;

  assert.throws(() => combat.submitSequence("hero", "move", { distance: 1, to: axial(1, 0) }, {
    events,
    resolveStart: async () => {
      asyncInvoked = true;
    },
  }), /resolveStart must be synchronous/);
  assert.equal(asyncInvoked, false);
  assert.deepEqual(ownedState(world), baseline);

  assert.throws(() => combat.submitSequence("hero", "move", { distance: 1, to: axial(1, 0) }, {
    events,
    resolveStart: () => {
      combat.log.push("thenable start mutation");
      return { then() {} };
    },
  }), /resolveStart must be synchronous/);
  assert.deepEqual(ownedState(world), baseline);
});

test("advanceTimeline applies core once and rolls it back before interrupting a thenable resolver", () => {
  const once = makeWorld({ enemyReadyAt: 5000 });
  once.combat.nextReady(["hero", "enemy"]);
  once.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 6 }, {
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 6 } }],
  });
  once.combat.advanceTimeline(["hero", "enemy"], {
    resolve: (_event, resolveCore) => {
      const first = resolveCore();
      const second = resolveCore();
      assert.equal(second, first);
      return first;
    },
  });
  assert.equal(once.enemy.hp, 94);
  assert.equal(once.combat.log.filter((entry) => entry === "hero zadaje 6 obrażeń enemy.").length, 1);

  const rolledBack = makeWorld({ enemyReadyAt: 5000 });
  rolledBack.combat.nextReady(["hero", "enemy"]);
  rolledBack.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 13 }, {
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 13 } }],
  });
  const enemyReference = rolledBack.enemy;
  const boundary = rolledBack.combat.advanceTimeline(["hero", "enemy"], {
    resolve: (_event, resolveCore) => {
      resolveCore();
      rolledBack.combat.log.push("timeline mutation that must roll back");
      return Promise.resolve("late timeline result");
    },
  });

  assert.equal(boundary.type, "interrupted");
  assert.match(boundary.error.message, /resolve must be synchronous/);
  assert.equal(rolledBack.combat.units.get("enemy"), enemyReference);
  assert.equal(rolledBack.enemy.hp, 100);
  assert.equal(rolledBack.combat.log.includes("timeline mutation that must roll back"), false);
  assert.equal(rolledBack.combat.log.some((entry) => entry.includes("przerwano attack")), true);
});

test("a repeated final impact cannot spend mana or deal damage after its command completed", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const { combat, roster, enemy } = world;
  const hero = roster.get("hero");
  hero.resources.mana = 10;
  combat.nextReady(["hero", "enemy"]);
  const payload = { targetId: "enemy", damage: 7 };
  const options = {
    transactionId: "one-player-click",
    events: [{ offset: 450, kind: "attack:impact", payload }],
  };
  const submitted = combat.submitSequence("hero", "attack", payload, options);
  combat.scheduler.queue.unshift(structuredClone(submitted.events[0]));
  let resolutions = 0;
  const resolve = (_event, resolveCore) => {
    resolutions += 1;
    hero.resources.mana -= 2;
    return resolveCore();
  };

  assert.equal(combat.advanceTimeline(["hero", "enemy"], { resolve }).type, "event");
  const repeated = combat.advanceTimeline(["hero", "enemy"], { resolve });
  assert.equal(repeated.type, "interrupted");
  assert.equal(repeated.interruption, null);
  assert.match(repeated.error.message, /no pending active command/);
  assert.equal(resolutions, 1);
  assert.equal(enemy.hp, 93);
  assert.equal(hero.resources.mana, 8);
  assert.equal(combat.commandHistory.length, 1);

  const beforeReplay = ownedState(world);
  const replay = combat.submitSequence("hero", "attack", payload, options);
  assert.equal(replay.commandId, submitted.commandId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(ownedState(world), beforeReplay);
  assert.doesNotThrow(() => CombatState.restore(combat.snapshot(), world));
});

test("a duplicate consumed step does not re-resolve or cancel the remaining legal command", () => {
  const { combat, grid } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero", "enemy"]);
  const path = [axial(0, 0), axial(1, 0), axial(2, 0)];
  const submitted = submitReservedMove(combat, grid, "hero", path, "one-march");
  combat.scheduler.queue.unshift(structuredClone(submitted.events[0]));

  assert.equal(advanceWorld(combat, grid, ["hero", "enemy"]).type, "event");
  const repeated = advanceWorld(combat, grid, ["hero", "enemy"]);
  assert.equal(repeated.type, "interrupted");
  assert.equal(repeated.interruption, null);
  assert.deepEqual(grid.positionOf("hero"), path[1]);
  assert.equal(combat.activeCommands.has(submitted.commandId), true);
  assert.equal(grid.reservations().length, 1);

  assert.equal(advanceWorld(combat, grid, ["hero", "enemy"]).type, "event");
  assert.deepEqual(grid.positionOf("hero"), path[2]);
  assert.equal(grid.reservations().length, 0);
  assert.equal(combat.commandHistory.length, 1);
  assert.equal(combat.commandHistory[0].status, "effects-complete");
});

test("live impacts must still match the accepted actor, payload and transaction before callbacks", () => {
  const mutations = [
    (event) => { event.actorId = "enemy"; },
    (event) => { event.payload.damage = 99; },
    (event) => { event.payload.transactionId = "other-click"; },
  ];
  for (const mutate of mutations) {
    const { combat, enemy, roster } = makeWorld({ enemyReadyAt: 5000 });
    combat.nextReady(["hero", "enemy"]);
    const manaBefore = roster.get("hero").resources.mana;
    const payload = { targetId: "enemy", damage: 7 };
    const submitted = combat.submitSequence("hero", "attack", payload, {
      events: [{ offset: 450, kind: "attack:impact", payload }],
    });
    mutate(combat.scheduler.queue.find(({ id }) => id === submitted.events[0].id));
    let resolved = false;
    const rejected = combat.advanceTimeline(["hero", "enemy"], {
      resolve: (_event, resolveCore) => { resolved = true; return resolveCore(); },
    });
    assert.equal(rejected.type, "interrupted");
    assert.equal(rejected.interruption.command.commandId, submitted.commandId);
    assert.equal(resolved, false);
    assert.equal(enemy.hp, 100);
    assert.equal(roster.get("hero").resources.mana, manaBefore);
    assert.equal(combat.activeCommands.size, 0);
  }
});

test("an attack with a revoked recovery budget cannot execute an old free impact", () => {
  const mutations = [
    (combat, command) => { command.recoveryEnd -= 100; },
    (combat) => { combat.units.get("hero").readyAt = 0; },
    (combat, command) => { combat.transactionLedger.get(command.transactionId).result.duration = 0; },
  ];
  for (const mutate of mutations) {
    const { combat, enemy } = makeWorld({ enemyReadyAt: 5000 });
    combat.nextReady(["hero", "enemy"]);
    const payload = { targetId: "enemy", damage: 7 };
    const submitted = combat.submitSequence("hero", "attack", payload, {
      events: [{ offset: 450, kind: "attack:impact", payload }],
    });
    mutate(combat, combat.activeCommands.get(submitted.commandId));
    let resolved = false;
    const rejected = combat.advanceTimeline(["hero", "enemy"], {
      resolve: (_event, resolveCore) => { resolved = true; return resolveCore(); },
    });
    assert.equal(rejected.type, "interrupted");
    assert.match(rejected.error.message, /recovery budget/);
    assert.equal(resolved, false);
    assert.equal(enemy.hp, 100);
  }
});

test("an edited skill command cannot reuse its previously accepted attack event", () => {
  const { combat, enemy } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero", "enemy"]);
  const payload = { targetId: "enemy", damage: 7, skillId: "basic.attack" };
  const submitted = combat.submitSequence("hero", "attack", payload, {
    events: [{ offset: 450, kind: "attack:impact", payload }],
  });
  combat.activeCommands.get(submitted.commandId).payload.skillId = "paladin.smite";
  const rejected = combat.advanceTimeline(["hero", "enemy"]);
  assert.equal(rejected.type, "interrupted");
  assert.match(rejected.error.message, /payload disagrees/);
  assert.equal(enemy.hp, 100);
});

test("advanceTimeline rejects declared async before touching the scheduler", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  world.combat.nextReady(["hero", "enemy"]);
  world.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 4 }, {
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 4 } }],
  });
  const baseline = ownedState(world);
  let invoked = false;

  assert.throws(() => world.combat.advanceTimeline(["hero", "enemy"], {
    resolve: async () => {
      invoked = true;
    },
  }), /resolve must be synchronous/);
  assert.equal(invoked, false);
  assert.deepEqual(ownedState(world), baseline);
});

test("death removes source auras, target buffs and control effects atomically", () => {
  const { combat, enemy } = makeWorld({ enemyReadyAt: 5000 });
  combat.effects.add({
    id: "enemy-aura",
    sourceId: "enemy",
    targetId: "hero",
    kind: "aura",
    persistsWhenSourceWithdrawn: true,
  });
  combat.effects.add({ id: "hero-mark-on-enemy", sourceId: "hero", targetId: "enemy", kind: "mark" });
  combat.controlEffects.applyTaunt({
    id: "enemy-taunt",
    sourceId: "enemy",
    targetId: "hero",
    startsAt: 0,
    expiresAt: 1000,
  });
  combat.nextReady(["hero", "enemy"]);
  combat.submitAction("hero", "attack", { targetId: "enemy", damage: 999 });
  assert.equal(enemy.hp, 0);
  assert.deepEqual(combat.effects.snapshot(), []);
  assert.deepEqual(combat.controlEffects.snapshot().effects, []);
});

test("a self-lethal impact completes as a controlled boundary after interrupting its own command", () => {
  const { combat, roster } = makeWorld({ enemyReadyAt: 5000 });
  combat.nextReady(["hero"]);
  const submitted = combat.submitSequence("hero", "attack", { targetId: "hero", damage: 999 }, {
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "hero", damage: 999 } }],
  });
  const boundary = combat.advanceTimeline(["hero"]);
  assert.equal(boundary.type, "event");
  assert.equal(roster.get("hero").resources.hp, 0);
  assert.equal(roster.get("hero").lifeState, "corpse");
  assert.equal(boundary.interruptions.some(({ command }) => command.commandId === submitted.commandId), true);
  assert.equal(combat.activeCommands.has(submitted.commandId), false);
});

test("monster reward is finalized exactly once even when no hero can receive EXP", () => {
  const { combat, enemy } = makeWorld();
  enemy.hp = 0;
  assert.deepEqual(combat.grantMonsterExperience("enemy", []), []);
  assert.equal(enemy.rewardsGranted, true);
  assert.deepEqual(combat.grantMonsterExperience("enemy", ["hero"]), []);
});

test("restore rejects malformed logs, orphan effects and phantom ledger aliases", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  world.combat.nextReady(["hero", "enemy"]);
  world.combat.submitAction("hero", "wait", {}, { transactionId: "tx-original" });
  const clean = world.combat.snapshot();

  const malformedLog = structuredClone(clean);
  malformedLog.log = [null];
  assert.throws(() => CombatState.restore(malformedLog, world), /Combat log/);

  const orphanTarget = structuredClone(clean);
  orphanTarget.effects.push({ id: "orphan-target", sourceId: "hero", targetId: "ghost" });
  assert.throws(() => CombatState.restore(orphanTarget, world), /missing unit/);

  const orphanSource = structuredClone(clean);
  orphanSource.effects.push({ id: "orphan-source", sourceId: "ghost", targetId: "hero" });
  assert.throws(() => CombatState.restore(orphanSource, world), /persistence policy/);

  const persistentOrphanSource = structuredClone(clean);
  persistentOrphanSource.effects.push({
    id: "persistent-orphan-source",
    sourceId: "withdrawn-hero",
    targetId: "hero",
    persistsWhenSourceWithdrawn: true,
  });
  assert.doesNotThrow(() => CombatState.restore(persistentOrphanSource, world));

  const phantom = structuredClone(clean);
  const cloned = structuredClone(phantom.commands.transactions[0]);
  cloned[0] = "tx-phantom";
  cloned[1].result.transactionId = "tx-phantom";
  phantom.commands.transactions.push(cloned);
  assert.throws(() => CombatState.restore(phantom, world), /Multiple transactions|exact command/);
});

test("restore rejects a structurally complete ledger that erased generated command history", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  world.combat.nextReady(["hero", "enemy"]);
  world.combat.submitAction("hero", "wait", {}, { transactionId: "tx-erased" });
  const erased = world.combat.snapshot();
  assert.equal(erased.readiness.commandSequence, 1);
  erased.commands = { active: [], history: [], transactions: [] };

  assert.throws(
    () => CombatState.restore(erased, world),
    /complete generated command sequence/,
  );

  const untouched = makeWorld({ enemyReadyAt: 5000 });
  const commandless = untouched.combat.snapshot();
  assert.equal(commandless.readiness.commandSequence, 0);
  assert.doesNotThrow(() => CombatState.restore(commandless, untouched));
});

test("restore accepts only null or P1-P8 as the pending players value", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  const clean = world.combat.snapshot();

  for (const value of [99, "8", false]) {
    const forged = structuredClone(clean);
    forged.pendingPlayersValue = value;
    assert.throws(() => CombatState.restore(forged, world), /pendingPlayersValue/);
  }

  const pendingP8 = structuredClone(clean);
  pendingP8.pendingPlayersValue = 8;
  assert.equal(CombatState.restore(pendingP8, world).pendingPlayersValue, 8);
});

test("fixed phase priorities cannot be overridden or forged in a restored queue", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  world.combat.nextReady(["hero", "enemy"]);
  assert.throws(() => world.combat.submitSequence("hero", "move", {
    distance: 1,
    to: axial(1, 0),
  }, {
    events: [{ offset: 350, kind: "move:step", priority: -100, payload: { to: axial(1, 0) } }],
  }), /priority disagrees/);

  world.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 1 }, {
    transactionId: "priority-restore",
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 1 } }],
  });
  const clean = world.combat.snapshot();
  const badImpact = structuredClone(clean);
  badImpact.scheduler.queue.find(({ kind }) => kind === "attack:impact").priority = -20;
  assert.throws(() => CombatState.restore(badImpact, world), /priority|disagrees/);

  const badReady = structuredClone(clean);
  badReady.scheduler.queue.find(({ kind }) => kind === "actor:ready").priority = -20;
  assert.throws(() => CombatState.restore(badReady, world), /Readiness event state/);
});

test("restore rejects a decision boundary that skipped an earlier same-tick impact", () => {
  const world = makeWorld({ enemyReadyAt: 0, enemyPosition: axial(3, 0) });
  world.combat.units.get("enemy").readinessTieKey = "z-enemy";
  assert.equal(world.combat.nextReady(["hero", "enemy"]).id, "hero");
  world.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 5 }, {
    transactionId: "same-tick-forgery",
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 5 } }],
  });
  assert.equal(world.combat.nextReady(["hero", "enemy"]).id, "enemy");
  const forged = world.combat.snapshot();
  const impact = forged.scheduler.queue.find(({ kind }) => kind === "attack:impact");
  impact.at = forged.scheduler.time;
  forged.commands.active[0].impactTicks = [forged.scheduler.time];
  forged.commands.transactions[0][1].result.events.find(({ kind }) => kind === "attack:impact").at = forged.scheduler.time;
  assert.throws(() => CombatState.restore(forged, world), /skipped an earlier same-tick event/);
});

test("restore cannot forge the winner of a same-tick readiness tie", () => {
  const world = makeWorld({ enemyReadyAt: 0 });
  assert.equal(world.combat.nextReady(["hero", "enemy"]).id, "enemy");
  const forged = world.combat.snapshot();
  const hero = forged.units.find(({ id }) => id === "hero");
  const enemy = forged.units.find(({ id }) => id === "enemy");
  const queuedReady = forged.scheduler.queue.find(({ kind }) => kind === "actor:ready");
  forged.readiness.currentActorId = "hero";
  hero.readinessEventId = null;
  enemy.readinessEventId = queuedReady.id;
  queuedReady.actorId = "enemy";
  queuedReady.tieKey = enemy.readinessTieKey;
  queuedReady.payload = { readySequence: enemy.readySequence, tieKey: enemy.readinessTieKey };
  assert.throws(() => CombatState.restore(forged, world), /skipped an earlier same-tick event/);
});

test("restore derives command-event tie keys instead of trusting a jointly edited ledger", () => {
  const world = makeWorld({ enemyReadyAt: 0 });
  assert.equal(world.combat.nextReady(["hero", "enemy"]).id, "enemy");
  world.combat.submitSequence("enemy", "attack", { targetId: "hero", damage: 999 }, {
    transactionId: "enemy-lethal",
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "hero", damage: 999 } }],
  });
  assert.equal(world.combat.nextReady(["hero", "enemy"]).id, "hero");
  world.combat.submitSequence("hero", "attack", { targetId: "enemy", damage: 999 }, {
    transactionId: "hero-lethal",
    events: [{ offset: 450, kind: "attack:impact", payload: { targetId: "enemy", damage: 999 } }],
  });
  const forged = world.combat.snapshot();
  const impacts = forged.scheduler.queue.filter(({ kind }) => kind === "attack:impact");
  assert.equal(impacts.length, 2);
  [impacts[0].tieKey, impacts[1].tieKey] = [impacts[1].tieKey, impacts[0].tieKey];
  for (const [, transaction] of forged.commands.transactions) {
    const queued = impacts.find(({ id }) => id === transaction.result.events?.[0]?.id);
    if (queued) transaction.result.events[0].tieKey = queued.tieKey;
  }
  assert.throws(() => CombatState.restore(forged, world), /Sequenced transaction events/);
});

test("restored combat generators reject exhausted safe-integer sequences", () => {
  const world = makeWorld({ enemyReadyAt: 5000 });
  world.combat.nextReady(["hero", "enemy"]);
  const clean = world.combat.snapshot();
  for (const field of ["sequence", "commandSequence", "transactionSequence"]) {
    const forged = structuredClone(clean);
    forged.readiness[field] = Number.MAX_SAFE_INTEGER;
    assert.throws(() => CombatState.restore(forged, world), /exhausted|non-exhausted/);
  }

  for (const field of ["sequence", "commandSequence", "transactionSequence"]) {
    const exhausted = structuredClone(clean);
    exhausted.readiness[field] = Number.MAX_SAFE_INTEGER - 1;
    if (field === "commandSequence") {
      assert.throws(
        () => CombatState.restore(exhausted, world),
        /complete generated command sequence/,
      );
      continue;
    }
    const restored = CombatState.restore(exhausted, world);
    const before = restored.snapshot();
    assert.throws(() => restored.submitAction("hero", "wait"), /exhausted/);
    assert.deepEqual(restored.snapshot(), before);
  }
});

test("HexGrid restore rejects an exhausted world-version counter", () => {
  const grid = new HexGrid({ tiles: [axial(0, 0), axial(1, 0)] });
  grid.addUnit({ id: "hero", position: axial(0, 0) });
  const snapshot = grid.snapshot();
  snapshot.worldVersion = Number.MAX_SAFE_INTEGER;
  assert.throws(() => HexGrid.restore(snapshot), /world version/);
  snapshot.worldVersion = Number.MAX_SAFE_INTEGER - 1;
  const exhausted = HexGrid.restore(snapshot);
  const before = exhausted.snapshot();
  assert.throws(() => exhausted.moveUnitStep("hero", axial(1, 0)), /exhausted/);
  assert.deepEqual(exhausted.snapshot(), before);
  assert.doesNotThrow(() => HexGrid.restore(exhausted.snapshot()));
});
