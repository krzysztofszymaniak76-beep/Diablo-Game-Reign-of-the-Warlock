import test from "node:test";
import assert from "node:assert/strict";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { CombatState } from "../src/core/combat.js";
import { HexGrid, axial, hexDisk, hexKey } from "../src/core/hex-grid.js";
import { DeterministicRng } from "../src/core/rng.js";

function makeProjectileWorld({ twoHeroes = false, targetPosition = axial(3, 0) } = {}) {
  const characters = [createCharacter({ id: "archer", name: "Archer", classId: "amazon" })];
  if (twoHeroes) characters.push(createCharacter({ id: "killer", name: "Killer", classId: "paladin" }));
  const roster = new Roster(characters);
  const party = new Party(roster, characters.map(({ id }) => id));
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, seed: 23 });
  const enemy = combat.spawnMonster({
    id: "enemy",
    name: "Enemy",
    baseHp: 100,
    baseExperience: 1,
    position: targetPosition,
  });
  enemy.readyAt = 5000;
  combat.units.get("archer").position = axial(0, 0);
  if (twoHeroes) combat.units.get("killer").position = axial(0, 1);

  const grid = new HexGrid({ tiles: hexDisk(axial(1, 0), 7) });
  grid.addUnit({ id: "archer", position: axial(0, 0) });
  if (twoHeroes) grid.addUnit({ id: "killer", position: axial(0, 1) });
  grid.addUnit({ id: "enemy", position: targetPosition });
  return { roster, party, playersSetting, combat, grid, enemy };
}

function projectileResolver({ combat, grid, rng = null, damage = 9 }) {
  return (event, resolveCore) => {
    if (event.kind !== "projectile:step" && event.kind !== "projectile:impact") return resolveCore();
    const mask = event.payload.collisionMask;
    const clear = grid.projectileStepIsClear(event.payload.from, event.payload.to, {
      blockTerrain: mask.terrain,
      blockUnits: mask.units && !mask.piercing,
      ignoreUnitIds: [event.actorId, event.payload.targetId],
      unitBlocks: (unitId) => {
        const source = combat.units.get(event.actorId);
        const blocker = combat.units.get(unitId);
        if (!source || !blocker) return true;
        return source.kind === blocker.kind ? mask.allies : mask.enemies;
      },
    });
    if (!clear) throw new Error(`projectile path blocked at ${hexKey(event.payload.to)}`);
    combat.validateProjectileEvent(event);
    if (event.kind === "projectile:impact") {
      if (grid.occupantAt(event.payload.to) !== event.payload.targetId) {
        throw new Error("projectile target left its impact footprint");
      }
      const resolvedDamage = rng ? rng.integer(7, 11) : damage;
      return resolveCore({ damage: resolvedDamage });
    }
    return resolveCore();
  };
}

test("a projectile crosses axial hexes as events in the one combat scheduler", () => {
  const world = makeProjectileWorld();
  assert.equal(world.combat.nextReady(["archer", "enemy"]).id, "archer");
  const command = world.combat.submitProjectile("archer", {
    targetId: "enemy",
    attackType: "ranged",
  }, {
    from: axial(0, 0),
    to: axial(3, 0),
    stepTime: 100,
    transactionId: "arrow-1",
  });

  assert.deepEqual(command.events.map(({ at, kind }) => [at, kind]), [
    [100, "projectile:step"],
    [200, "projectile:step"],
    [300, "projectile:impact"],
  ]);
  assert.equal(world.combat.projectiles().length, 1);
  assert.deepEqual(world.combat.units.get("archer").position, axial(0, 0));

  const resolve = projectileResolver(world);
  const first = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(first.event.kind, "projectile:step");
  assert.deepEqual(world.combat.projectile(command.projectileId).position, axial(1, 0));
  const second = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(second.event.kind, "projectile:step");
  assert.deepEqual(world.combat.projectile(command.projectileId).position, axial(2, 0));
  const impact = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(impact.event.kind, "projectile:impact");
  assert.equal(world.enemy.hp, 91);
  assert.equal(world.combat.projectile(command.projectileId), null);
  assert.deepEqual(world.combat.units.get("archer").position, axial(0, 0));
  assert.deepEqual(world.grid.positionOf("archer"), axial(0, 0));
});

test("a new obstacle interrupts the projectile before RNG or impact damage", () => {
  const world = makeProjectileWorld();
  const rng = new DeterministicRng(99);
  world.combat.nextReady(["archer", "enemy"]);
  const command = world.combat.submitProjectile("archer", {
    targetId: "enemy",
    attackType: "ranged",
  }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "blocked-arrow",
  });
  const resolve = projectileResolver({ ...world, rng });
  assert.equal(world.combat.advanceTimeline(["archer", "enemy"], { resolve }).event.kind, "projectile:step");
  const rngBeforeBlock = rng.snapshot();
  world.grid.addUnit({ id: "interceptor", position: axial(2, 0) });

  const blocked = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(blocked.type, "interrupted");
  assert.equal(blocked.event.kind, "projectile:step");
  assert.match(blocked.error.message, /projectile path blocked/);
  assert.equal(world.enemy.hp, 100);
  assert.deepEqual(rng.snapshot(), rngBeforeBlock);
  assert.equal(world.combat.projectile(command.projectileId), null);
  assert.ok(!world.combat.timelinePreview(20).some((event) => event.payload?.commandId === command.commandId));
});

test("scenario E: a full projectile wall blocks the travelled path, not just the endpoint", () => {
  const world = makeProjectileWorld();
  world.grid = new HexGrid({
    tiles: hexDisk(axial(1, 0), 7),
    projectileBlockers: [axial(2, 0)],
  });
  world.grid.addUnit({ id: "archer", position: axial(0, 0) });
  world.grid.addUnit({ id: "enemy", position: axial(3, 0) });
  world.combat.nextReady(["archer", "enemy"]);
  const projectile = world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "wall-arrow",
  });
  const resolve = projectileResolver(world);

  assert.equal(world.combat.advanceTimeline(["archer", "enemy"], { resolve }).event.kind, "projectile:step");
  const wall = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(wall.type, "interrupted");
  assert.match(wall.error.message, /blocked at 2,0/);
  assert.equal(world.enemy.hp, 100);
  assert.equal(world.combat.projectile(projectile.projectileId), null);
});

test("a target leaving the planned impact hex makes the shot miss before RNG is consumed", () => {
  const world = makeProjectileWorld();
  const rng = new DeterministicRng(1234);
  world.combat.nextReady(["archer", "enemy"]);
  const projectile = world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "dodged-arrow",
  });
  const resolve = projectileResolver({ ...world, rng });
  world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  const rngBeforeDodge = rng.snapshot();
  world.grid.moveUnitStep("enemy", axial(3, -1), { expectedFrom: axial(3, 0) });
  world.combat.units.get("enemy").position = axial(3, -1);
  world.combat.advanceTimeline(["archer", "enemy"], { resolve });

  const missed = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(missed.type, "interrupted");
  assert.equal(missed.event.kind, "projectile:impact");
  assert.equal(world.enemy.hp, 100);
  assert.deepEqual(rng.snapshot(), rngBeforeDodge);
  assert.equal(world.combat.projectile(projectile.projectileId), null);
});

test("a projectile can legally hit an occupied edge hex of an explicit large footprint", () => {
  const world = makeProjectileWorld();
  world.grid = new HexGrid({ tiles: hexDisk(axial(1, 0), 7) });
  world.grid.addUnit({ id: "archer", position: axial(0, 0) });
  world.grid.addUnit({
    id: "enemy",
    position: axial(3, 0),
    footprint: [axial(0, 0), axial(-1, 0)],
  });
  world.combat.nextReady(["archer", "enemy"]);
  world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(2, 0),
    targetAnchor: axial(3, 0),
    transactionId: "large-target-edge",
  });
  const resolve = projectileResolver(world);

  world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  const impact = world.combat.advanceTimeline(["archer", "enemy"], { resolve });
  assert.equal(impact.event.kind, "projectile:impact");
  assert.equal(world.enemy.hp, 91);
});

test("the per-projectile ally collision bit changes intermediate-unit blocking", () => {
  const blocked = makeProjectileWorld({ twoHeroes: true });
  blocked.grid.removeUnit("killer");
  blocked.grid.addUnit({ id: "killer", position: axial(2, 0) });
  blocked.combat.units.get("killer").position = axial(2, 0);
  blocked.combat.nextReady(["archer", "enemy"]);
  blocked.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    collisionMask: { units: true, allies: true, enemies: true },
    transactionId: "ally-blocks",
  });
  const blockedResolve = projectileResolver(blocked);
  blocked.combat.advanceTimeline(["archer", "enemy"], { resolve: blockedResolve });
  const collision = blocked.combat.advanceTimeline(["archer", "enemy"], { resolve: blockedResolve });
  assert.equal(collision.type, "interrupted");

  const passing = makeProjectileWorld({ twoHeroes: true });
  passing.grid.removeUnit("killer");
  passing.grid.addUnit({ id: "killer", position: axial(2, 0) });
  passing.combat.units.get("killer").position = axial(2, 0);
  passing.combat.nextReady(["archer", "enemy"]);
  passing.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    collisionMask: { units: true, allies: false, enemies: true },
    transactionId: "ally-pass",
  });
  const passingResolve = projectileResolver(passing);
  passing.combat.advanceTimeline(["archer", "enemy"], { resolve: passingResolve });
  const secondStep = passing.combat.advanceTimeline(["archer", "enemy"], { resolve: passingResolve });
  assert.equal(secondStep.event.kind, "projectile:step");
  const impact = passing.combat.advanceTimeline(["archer", "enemy"], { resolve: passingResolve });
  assert.equal(impact.event.kind, "projectile:impact");
  assert.equal(passing.enemy.hp, 91);
});

test("target death cancels an already flying projectile and only its future events", () => {
  const world = makeProjectileWorld({ twoHeroes: true });
  const legal = ["archer", "killer", "enemy"];
  assert.equal(world.combat.nextReady(legal).id, "archer");
  const projectile = world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "too-late-arrow",
  });
  assert.equal(world.combat.nextReady(legal).id, "killer");
  world.combat.submitSequence("killer", "attack", { targetId: "enemy", damage: 500 }, {
    transactionId: "lethal-hit",
    events: [{ offset: 50, kind: "attack:impact", payload: { targetId: "enemy", damage: 500 } }],
  });

  const lethal = world.combat.advanceTimeline(legal);
  assert.equal(lethal.event.kind, "attack:impact");
  assert.equal(world.enemy.hp, 0);
  assert.ok(lethal.interruptions.some(({ command }) => command.commandId === projectile.commandId));
  assert.equal(world.combat.projectile(projectile.projectileId), null);
  assert.ok(!world.combat.timelinePreview(20).some((event) => event.payload?.projectileId === projectile.projectileId));
  assert.ok(world.combat.timelinePreview(20).some((event) => event.kind === "actor:ready"));
});

test("a launched projectile can outlive its defeated source under its explicit persisted policy", () => {
  const world = makeProjectileWorld();
  world.enemy.readyAt = 0;
  const legal = ["archer", "enemy"];
  assert.equal(world.combat.nextReady(legal).id, "archer");
  const projectile = world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "posthumous-arrow",
    persistsAfterSourceDeath: true,
  });
  assert.equal(world.combat.nextReady(legal).id, "enemy");
  world.combat.submitSequence("enemy", "attack", { targetId: "archer", damage: 999 }, {
    transactionId: "kill-archer",
    events: [{ offset: 50, kind: "attack:impact", payload: { targetId: "archer", damage: 999 } }],
  });

  const lethal = world.combat.advanceTimeline(legal);
  assert.equal(lethal.event.kind, "attack:impact");
  assert.equal(world.roster.get("archer").resources.hp, 0);
  assert.ok(world.combat.projectile(projectile.projectileId));
  world.grid.removeUnit("archer");

  const resolve = projectileResolver(world);
  assert.equal(world.combat.advanceTimeline(["enemy"], { resolve }).event.kind, "projectile:step");
  assert.equal(world.combat.advanceTimeline(["enemy"], { resolve }).event.kind, "projectile:step");
  assert.equal(world.combat.advanceTimeline(["enemy"], { resolve }).event.kind, "projectile:impact");
  assert.equal(world.enemy.hp, 91);
  assert.equal(world.combat.projectile(projectile.projectileId), null);
});

test("a projectile configured to depend on its source is interrupted when that source dies", () => {
  const world = makeProjectileWorld();
  world.enemy.readyAt = 0;
  const legal = ["archer", "enemy"];
  world.combat.nextReady(legal);
  const projectile = world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    from: axial(0, 0),
    to: axial(3, 0),
    transactionId: "source-bound-arrow",
    persistsAfterSourceDeath: false,
  });
  world.combat.nextReady(legal);
  world.combat.submitSequence("enemy", "attack", { targetId: "archer", damage: 999 }, {
    transactionId: "kill-source-bound-archer",
    events: [{ offset: 50, kind: "attack:impact", payload: { targetId: "archer", damage: 999 } }],
  });

  const lethal = world.combat.advanceTimeline(legal);
  assert.ok(lethal.interruptions.some(({ command }) => command.commandId === projectile.commandId));
  assert.equal(world.combat.projectile(projectile.projectileId), null);
  assert.ok(!world.combat.timelinePreview(20).some((event) => event.payload?.projectileId === projectile.projectileId));
});

test("save during flight restores identical projectile, event and RNG traces", () => {
  const original = makeProjectileWorld({ targetPosition: axial(4, 0) });
  const originalRng = new DeterministicRng(0xd2);
  original.combat.nextReady(["archer", "enemy"]);
  const launched = original.combat.submitProjectile("archer", {
    targetId: "enemy",
    attackType: "ranged",
    damageProfile: { kind: "integer-range", min: 7, max: 11 },
  }, {
    from: axial(0, 0),
    to: axial(4, 0),
    transactionId: "save-arrow",
  });
  original.combat.advanceTimeline(["archer", "enemy"], {
    resolve: projectileResolver({ ...original, rng: originalRng }),
  });
  assert.deepEqual(original.combat.projectile(launched.projectileId).position, axial(1, 0));
  assert.equal(original.combat.snapshot().projectiles.active.length, 1);

  const restoredRoster = new Roster(original.roster.toJSON());
  const restoredParty = new Party(restoredRoster, ["archer"]);
  const restored = {
    roster: restoredRoster,
    party: restoredParty,
    playersSetting: new PlayersSetting(1),
    combat: CombatState.restore(original.combat.snapshot(), {
      party: restoredParty,
      playersSetting: new PlayersSetting(1),
    }),
    grid: HexGrid.restore(original.grid.snapshot()),
    enemy: null,
  };
  restored.enemy = restored.combat.units.get("enemy");
  const restoredRng = DeterministicRng.restore(originalRng.snapshot());

  function finish(world, rng) {
    const trace = [];
    for (let count = 0; count < 8; count += 1) {
      const boundary = world.combat.advanceTimeline(["archer", "enemy"], {
        resolve: projectileResolver({ ...world, rng }),
      });
      trace.push(boundary.type === "ready"
        ? [boundary.type, boundary.entry.id, world.combat.scheduler.time]
        : [boundary.type, boundary.event.kind, world.combat.scheduler.time,
          world.combat.projectile(launched.projectileId)?.position ?? null]);
      if (boundary.type === "ready") break;
    }
    return trace;
  }

  assert.deepEqual(finish(restored, restoredRng), finish(original, originalRng));
  assert.deepEqual(restored.combat.snapshot(), original.combat.snapshot());
  assert.deepEqual(restored.grid.snapshot(), original.grid.snapshot());
  assert.deepEqual(restoredRng.snapshot(), originalRng.snapshot());
  assert.deepEqual(restored.roster.toJSON(), original.roster.toJSON());
});

test("projectile transaction retry is idempotent and restore rejects orphaned flight state", () => {
  const world = makeProjectileWorld();
  world.combat.nextReady(["archer", "enemy"]);
  const options = {
    from: axial(0, 0),
    to: axial(3, 0),
    stepTime: 100,
    transactionId: "idempotent-arrow",
  };
  const first = world.combat.submitProjectile("archer", { targetId: "enemy" }, options);
  const replay = world.combat.submitProjectile("archer", { targetId: "enemy" }, options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.commandId, first.commandId);
  assert.equal(replay.projectileId, first.projectileId);
  assert.equal(world.combat.projectiles().length, 1);
  assert.throws(() => world.combat.submitProjectile("archer", { targetId: "enemy" }, {
    ...options,
    stepTime: 101,
  }), /different command/);

  const broken = world.combat.snapshot();
  broken.projectiles.active = [];
  assert.throws(() => CombatState.restore(broken, {
    party: world.party,
    playersSetting: world.playersSetting,
  }), /projectile state is missing/);
});

test("unsafe late sequence time is rejected before any event is scheduled", () => {
  const world = makeProjectileWorld();
  world.combat.scheduler.advanceTo(500);
  world.combat.nextReady(["archer", "enemy"]);
  const before = world.combat.snapshot();
  assert.throws(() => world.combat.submitSequence("archer", "attack", { targetId: "enemy" }, {
    transactionId: "unsafe-sequence",
    events: [
      { offset: 1, kind: "projectile:step", payload: {} },
      { offset: Number.MAX_SAFE_INTEGER, kind: "projectile:impact", payload: {} },
    ],
  }), /safe integer/);
  assert.deepEqual(world.combat.snapshot(), before);
});
