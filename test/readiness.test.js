import test from "node:test";
import assert from "node:assert/strict";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { ACTION_TIME, CombatState, actionDuration } from "../src/core/combat.js";

function recoveryCombat(heroIds = ["hero"]) {
  const roster = new Roster(heroIds.map((id) => createCharacter({ id, name: id, classId: "amazon" })));
  const party = new Party(roster, heroIds);
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, seed: 91 });
  combat.spawnMonster({ id: "enemy", name: "Enemy", baseHp: 100, baseExperience: 1 });
  combat.units.get("enemy").readyAt = 100;
  return { combat, roster, party, playersSetting };
}

test("recovery timeline: a 500 ms wait becomes ready before a 900 ms enemy attack", () => {
  const { combat } = recoveryCombat();
  const legalIds = ["hero", "enemy"];

  assert.equal(combat.nextReady(legalIds).id, "hero");
  const heroAction = combat.submitAction("hero", "wait");
  assert.equal(heroAction.readyAt, ACTION_TIME.wait);

  assert.equal(combat.nextReady(legalIds).id, "enemy");
  const enemyAction = combat.submitAction("enemy", "attack", { targetId: "hero", damage: 1 });
  assert.equal(enemyAction.readyAt, 100 + ACTION_TIME.attack);

  const next = combat.nextReady(legalIds);
  assert.equal(next.id, "hero");
  assert.equal(combat.scheduler.time, ACTION_TIME.wait);
});

test("recovery timeline: a 1050 ms move lets a 900 ms enemy recover first", () => {
  const { combat } = recoveryCombat();
  const legalIds = ["hero", "enemy"];

  assert.equal(combat.nextReady(legalIds).id, "hero");
  const move = combat.submitAction("hero", "move", { distance: 3, to: { x: 3, y: 0 } });
  assert.equal(move.readyAt, ACTION_TIME.movePerTile * 3);

  assert.equal(combat.nextReady(legalIds).id, "enemy");
  combat.submitAction("enemy", "attack", { targetId: "hero", damage: 1 });

  const next = combat.nextReady(legalIds);
  assert.equal(next.id, "enemy");
  assert.equal(combat.scheduler.time, 100 + ACTION_TIME.attack);
});

test("readiness ties use persisted faction-neutral stable keys, not caller order", () => {
  const { combat } = recoveryCombat(["zeta", "alpha"]);
  const reversedLegalIds = ["enemy", "alpha", "zeta"];

  assert.deepEqual(combat.readinessQueue(reversedLegalIds).map(({ id }) => id), ["alpha", "zeta", "enemy"]);
  assert.equal(combat.nextReady(reversedLegalIds).id, "alpha");
  combat.submitAction("alpha", "wait");
  assert.equal(combat.nextReady(reversedLegalIds).id, "zeta");
});

test("only the authoritative readiness head can submit a recovery action", () => {
  const { combat } = recoveryCombat(["first", "second"]);
  const legalIds = ["first", "second", "enemy"];
  assert.equal(combat.nextReady(legalIds).id, "first");

  const before = combat.snapshot();
  assert.throws(
    () => combat.submitAction("second", "wait"),
    /not the authoritative readiness head/,
  );
  assert.equal(combat.currentActorId, "first");
  assert.equal(combat.scheduler.time, before.scheduler.time);
  assert.equal(combat.units.get("first").readyAt, before.units.find(({ id }) => id === "first").readyAt);
});

test("readiness queue keeps an open command window at the visible head when legal units expand", () => {
  const { combat } = recoveryCombat(["first", "second"]);
  assert.equal(combat.nextReady(["second", "enemy"]).id, "second");
  assert.deepEqual(
    combat.readinessQueue(["first", "second", "enemy"]).map(({ id }) => id),
    ["second", "first", "enemy"],
  );
});

test("a throwing domain resolver leaves timing, phase and readiness unchanged", () => {
  const { combat } = recoveryCombat();
  const legalIds = ["hero", "enemy"];
  combat.nextReady(legalIds);
  const before = combat.snapshot();

  assert.throws(
    () => combat.submitAction("hero", "portalOpen", {}, { resolve: () => { throw new Error("illegal hex"); } }),
    /illegal hex/,
  );
  const after = combat.snapshot();
  assert.equal(after.scheduler.time, before.scheduler.time);
  assert.equal(after.readiness.sequence, before.readiness.sequence);
  assert.equal(after.readiness.commandSequence, before.readiness.commandSequence);
  assert.equal(after.readiness.currentActorId, "hero");
  assert.equal(after.readiness.phase, "awaiting-action");
  assert.deepEqual(after.units, before.units);
});

test("combat snapshot restores deterministic readiness continuation", () => {
  const original = recoveryCombat();
  const legalIds = ["hero", "enemy"];
  original.combat.nextReady(legalIds);
  original.combat.submitAction("hero", "wait");
  original.combat.nextReady(legalIds);
  original.combat.submitAction("enemy", "attack", { targetId: "hero", damage: 0 });

  const snapshot = original.combat.snapshot();
  const restoredRoster = new Roster(original.roster.toJSON());
  const restoredParty = new Party(restoredRoster, [...original.party.slots]);
  const restored = CombatState.restore(snapshot, {
    party: restoredParty,
    playersSetting: new PlayersSetting(original.playersSetting.value),
  });

  function continueTimeline(combat, count) {
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const head = combat.nextReady(legalIds);
      result.push([head.id, combat.scheduler.time]);
      if (head.id === "enemy") combat.submitAction("enemy", "attack", { targetId: "hero", damage: 0 });
      else combat.submitAction("hero", "wait");
    }
    return result;
  }

  assert.deepEqual(continueTimeline(restored, 6), continueTimeline(original.combat, 6));
  assert.deepEqual(restored.readinessQueue(legalIds), original.combat.readinessQueue(legalIds));
});

test("combat snapshot restores an in-progress authoritative command window", () => {
  const original = recoveryCombat(["first", "second"]);
  const legalIds = ["first", "second", "enemy"];
  assert.equal(original.combat.nextReady(legalIds).id, "first");

  const restoredRoster = new Roster(original.roster.toJSON());
  const restored = CombatState.restore(original.combat.snapshot(), {
    party: new Party(restoredRoster, [...original.party.slots]),
    playersSetting: new PlayersSetting(1),
  });

  assert.equal(restored.currentActorId, "first");
  assert.equal(restored.readinessPhase, "awaiting-action");
  assert.equal(restored.canAct("first"), true);
  assert.equal(restored.canAct("second"), false);
  assert.equal(restored.nextReady(legalIds).id, "first");
});

test("action duration rejects non-finite values before mutating the unified command window", () => {
  const { combat } = recoveryCombat();
  assert.throws(() => actionDuration("move", { distance: Infinity }), /finite and positive/);
  combat.nextReady(["hero", "enemy"]);
  const before = combat.snapshot();
  assert.throws(() => combat.submitSequence("hero", "move", { distance: Infinity }, {
    events: [{ offset: 1, kind: "move:step", payload: { to: { q: 1, r: 0 } } }],
  }), /finite and positive/);
  assert.deepEqual(combat.snapshot(), before);
});
