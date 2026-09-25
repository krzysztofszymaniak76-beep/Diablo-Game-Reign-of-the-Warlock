import test from "node:test";
import assert from "node:assert/strict";
import {
  BATTLE_ACTIVATION_REASON,
  BATTLE_PHASE,
  BATTLE_PREPARATION_SCHEMA_VERSION,
  BattlePreparationState,
  DEPLOYMENT_COLUMN_COUNT,
  MAX_MAIN_HEROES,
  SKILL_CATEGORY,
  UNIT_PRESENCE,
  durationSecondsToTurns,
} from "../src/core/battle-preparation.js";

const HERO_IDS = Object.freeze(["barbarian", "paladin", "necromancer"]);

function defaultLoadouts() {
  return {
    barbarian: { left: "bash", right: ["shout", "battle-orders", "whirlwind"] },
    paladin: { left: "sacrifice", right: ["might", "holy-fire", "zeal"] },
    necromancer: { left: "teeth", right: ["raise-skeleton", "clay-golem", "amplify-damage"] },
  };
}

function defaultPositions() {
  return {
    barbarian: { q: 2, r: 0 },
    paladin: { q: 1, r: 1 },
    necromancer: { q: 0, r: 2 },
  };
}

function makeBattle(overrides = {}) {
  return new BattlePreparationState({
    heroIds: HERO_IDS,
    loadouts: defaultLoadouts(),
    heroPositions: defaultPositions(),
    summonLimits: { skeleton: 2, golem: 1 },
    maxSummonsPerOwner: 4,
    defaultSummonLimit: 3,
    ...overrides,
  });
}

test("preparation is fixed to at most three heroes and exactly three deployment columns", () => {
  const battle = makeBattle();
  assert.equal(MAX_MAIN_HEROES, 3);
  assert.equal(DEPLOYMENT_COLUMN_COUNT, 3);
  assert.equal(battle.phase, BATTLE_PHASE.PREPARATION);
  assert.equal(battle.enemyTurnsEnabled, false);
  assert.equal(battle.enemyAwarenessEnabled, false);
  assert.equal(battle.isDeploymentHex({ q: 0, r: -100 }), true);
  assert.equal(battle.isDeploymentHex({ q: 2, r: 100 }), true);
  assert.equal(battle.isDeploymentHex({ q: 3, r: 0 }), false);
  assert.throws(() => makeBattle({
    heroIds: [...HERO_IDS, "druid"],
    loadouts: { ...defaultLoadouts(), druid: { left: "raven", right: ["wolf", "bear", "oak"] } },
    heroPositions: { ...defaultPositions(), druid: { q: 0, r: 3 } },
  }), /1 to 3 main heroes/);
  assert.throws(() => makeBattle({ heroPositions: { ...defaultPositions(), paladin: { q: 3, r: 1 } } }), /three-column deployment zone/);
});

test("one- and two-hero preparations preserve their exact active roster on restore", () => {
  for (const count of [1, 2]) {
    const heroIds = HERO_IDS.slice(0, count);
    const loadouts = Object.fromEntries(heroIds.map((id) => [id, defaultLoadouts()[id]]));
    const heroPositions = Object.fromEntries(heroIds.map((id) => [id, defaultPositions()[id]]));
    const battle = makeBattle({ heroIds, loadouts, heroPositions });
    const restored = BattlePreparationState.restore(battle.snapshot());
    assert.deepEqual(restored.heroIds, heroIds);
    assert.deepEqual(restored.snapshot(), battle.snapshot());
  }
});

test("deployment can share an odd-row visual column mapping without changing its three-column rule", () => {
  const deploymentColumnOf = ({ q, r }) => q + Math.floor(r / 2);
  const battle = makeBattle({
    deploymentColumnOf,
    heroPositions: {
      barbarian: { q: 1, r: 3 },
      paladin: { q: -1, r: 4 },
      necromancer: { q: -2, r: 5 },
    },
  });
  assert.equal(battle.isDeploymentHex({ q: -4, r: 9 }), true);
  assert.equal(battle.isDeploymentHex({ q: -2, r: 9 }), true);
  assert.equal(battle.isDeploymentHex({ q: -1, r: 9 }), false);
  const restored = BattlePreparationState.restore(battle.snapshot(), { deploymentColumnOf });
  assert.equal(restored.isDeploymentHex({ q: -4, r: 9 }), true);
});

test("movement is free inside preparation and leaving it activates combat exactly once", () => {
  const battle = makeBattle();
  const freeMove = battle.moveUnit({ unitId: "barbarian", to: { q: 2, r: -1 } });
  assert.equal(freeMove.freePreparationAction, true);
  assert.equal(freeMove.consumesTurn, false);
  assert.equal(battle.phase, BATTLE_PHASE.PREPARATION);

  const exit = battle.moveUnit({ unitId: "barbarian", to: { q: 3, r: -1 } });
  assert.equal(exit.activated, true);
  assert.equal(exit.activationReason, BATTLE_ACTIVATION_REASON.LEFT_DEPLOYMENT_ZONE);
  assert.equal(exit.consumesTurn, true);
  assert.equal(battle.enemyTurnsEnabled, true);
  assert.deepEqual(battle.activation, {
    reason: BATTLE_ACTIVATION_REASON.LEFT_DEPLOYMENT_ZONE,
    actorId: "barbarian",
    skillId: null,
    actionSequence: 2,
  });

  const activeMove = battle.moveUnit({ unitId: "barbarian", to: { q: 4, r: -1 } });
  assert.equal(activeMove.activated, false);
  assert.equal(activeMove.consumesTurn, true);
  assert.equal(battle.activation.actionSequence, 2, "later actions must not replace the activation boundary");
});

test("an offensive equipped skill activates enemies; non-offensive preparation does not", () => {
  const buffBattle = makeBattle();
  const prepSkill = buffBattle.useSkill({
    actorId: "barbarian",
    skillId: "shout",
    category: SKILL_CATEGORY.BUFF,
  });
  assert.equal(prepSkill.freePreparationAction, true);
  assert.equal(buffBattle.phase, BATTLE_PHASE.PREPARATION);

  const offensiveBattle = makeBattle();
  const result = offensiveBattle.useSkill({
    actorId: "paladin",
    skillId: "zeal",
    category: SKILL_CATEGORY.OFFENSIVE,
  });
  assert.equal(result.activated, true);
  assert.equal(result.consumesTurn, true);
  assert.deepEqual(offensiveBattle.activation, {
    reason: BATTLE_ACTIVATION_REASON.OFFENSIVE_SKILL,
    actorId: "paladin",
    skillId: "zeal",
    actionSequence: 1,
  });

  const before = buffBattle.snapshot();
  assert.throws(() => buffBattle.useSkill({
    actorId: "barbarian",
    skillId: "leap-attack",
    category: SKILL_CATEGORY.OFFENSIVE,
  }), /not active/);
  assert.deepEqual(buffBattle.snapshot(), before);
});

test("source-backed generic Attack is universally usable without occupying a class loadout slot", () => {
  const battle = makeBattle();
  const result = battle.useSkill({
    actorId: "barbarian",
    skillId: "basic.attack",
    category: SKILL_CATEGORY.OFFENSIVE,
  });
  assert.equal(result.activated, true);
  assert.equal(result.consumesTurn, true);
  assert.equal(battle.activation.skillId, "basic.attack");

  const rejected = makeBattle();
  const before = rejected.snapshot();
  assert.throws(() => rejected.useSkill({
    actorId: "barbarian",
    skillId: "basic.fake",
    category: SKILL_CATEGORY.OFFENSIVE,
  }), /not active/);
  assert.deepEqual(rejected.snapshot(), before);
});

test("explicit start activates combat without spending a hero turn and is idempotent", () => {
  const battle = makeBattle();
  const started = battle.startBattle();
  assert.equal(started.activated, true);
  assert.equal(started.consumesTurn, false);
  assert.equal(battle.phase, BATTLE_PHASE.ACTIVE);
  assert.deepEqual(battle.activation, {
    reason: BATTLE_ACTIVATION_REASON.EXPLICIT_START,
    actorId: null,
    skillId: null,
    actionSequence: 1,
  });
  const again = battle.startBattle();
  assert.equal(again.changed, false);
  assert.equal(battle.actionSequence, 1);
});

test("timed Diablo effects convert through configurable balance and grow with skill level", () => {
  assert.equal(durationSecondsToTurns({ baseDurationSeconds: 12 }), 2);
  assert.equal(durationSecondsToTurns({ baseDurationSeconds: 12, perLevelSeconds: 3, skillLevel: 5 }), 4);
  assert.equal(durationSecondsToTurns(
    { baseDurationSeconds: 13 },
    { secondsPerTurn: 5, minimumTurns: 1, maximumTurns: 20, rounding: "floor" },
  ), 2);
  assert.equal(durationSecondsToTurns(
    { baseDurationSeconds: 600 },
    { secondsPerTurn: 5, minimumTurns: 1, maximumTurns: 7, rounding: "nearest" },
  ), 7);
  assert.throws(() => durationSecondsToTurns({ baseDurationSeconds: 0 }), /greater than 0/);
  assert.throws(() => durationSecondsToTurns({ baseDurationSeconds: 12 }, { rounding: "random" }), /rounding/);
});

test("preparation buffs are free, retain their full duration until combat, then expire by turns", () => {
  const battle = makeBattle({ balance: { secondsPerTurn: 5, minimumTurns: 1, maximumTurns: 20, rounding: "ceil" } });
  const application = battle.applyBuff({
    id: "barbarian-shout",
    skillId: "shout",
    sourceId: "barbarian",
    targetIds: ["paladin", "barbarian"],
    baseDurationSeconds: 11,
  });
  assert.equal(application.freePreparationAction, true);
  assert.equal(application.buff.remainingTurns, 3);
  assert.deepEqual(application.buff.targetIds, ["barbarian", "paladin"]);
  assert.throws(() => battle.advanceTurn(), /only during active combat/);
  assert.equal(battle.listBuffs()[0].remainingTurns, 3);

  battle.startBattle();
  assert.deepEqual(battle.advanceTurn(2).expiredBuffIds, []);
  assert.equal(battle.listBuffs()[0].remainingTurns, 1);
  assert.deepEqual(battle.advanceTurn().expiredBuffIds, ["barbarian-shout"]);
  assert.deepEqual(battle.listBuffs(), []);
});

test("permanent auras use exclusive groups and replacing them costs only in active combat", () => {
  const battle = makeBattle();
  const might = battle.applyBuff({
    id: "might-aura",
    skillId: "might",
    sourceId: "paladin",
    targetIds: HERO_IDS,
    permanent: true,
    exclusiveGroup: "paladin-aura",
  });
  assert.equal(might.consumesTurn, false);
  assert.equal(might.buff.remainingTurns, null);
  battle.changeSkill({ heroId: "paladin", slot: "right", rightIndex: 0, skillId: "concentration" });
  battle.startBattle();
  const concentration = battle.applyBuff({
    id: "concentration-aura",
    skillId: "concentration",
    sourceId: "paladin",
    targetIds: HERO_IDS,
    permanent: true,
    exclusiveGroup: "paladin-aura",
  });
  assert.equal(concentration.consumesTurn, true);
  assert.deepEqual(battle.listBuffs().map(({ id }) => id), ["concentration-aura"]);
  battle.advanceTurn(10);
  assert.equal(battle.listBuffs()[0].remainingTurns, null);
});

test("loadouts require one left plus three unique right skills; swaps cost only active queue", () => {
  assert.throws(() => makeBattle({
    loadouts: { ...defaultLoadouts(), paladin: { left: "sacrifice", right: ["might", "zeal"] } },
  }), /exactly three/);
  assert.throws(() => makeBattle({
    loadouts: { ...defaultLoadouts(), paladin: { left: "zeal", right: ["might", "holy-fire", "zeal"] } },
  }), /must be unique/);

  const battle = makeBattle();
  const freeSwap = battle.changeSkill({ heroId: "necromancer", slot: "right", rightIndex: 2, skillId: "corpse-explosion" });
  assert.equal(freeSwap.consumesTurn, false);
  assert.deepEqual(battle.getLoadout("necromancer").right, ["raise-skeleton", "clay-golem", "corpse-explosion"]);
  battle.startBattle();
  const paidSwap = battle.changeSkill({ heroId: "necromancer", slot: "left", skillId: "bone-spear" });
  assert.equal(paidSwap.consumesTurn, true);
  const unchanged = battle.changeSkill({ heroId: "necromancer", slot: "left", skillId: "bone-spear" });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.consumesTurn, false);
});

test("summons are free in deployment, obey per-owner caps, and cost an action in combat", () => {
  const battle = makeBattle();
  const first = battle.summonUnit({
    id: "skeleton-1",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    position: { q: 0, r: 3 },
  });
  assert.equal(first.freePreparationAction, true);
  assert.equal(first.summon.factionId, "party");
  battle.summonUnit({
    id: "skeleton-2",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    position: { q: 1, r: 3 },
  });
  const beforeRejected = battle.snapshot();
  assert.throws(() => battle.summonUnit({
    id: "skeleton-3",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    position: { q: 2, r: 3 },
  }), /reached its owner limit/);
  assert.deepEqual(battle.snapshot(), beforeRejected);
  assert.throws(() => battle.summonUnit({
    id: "golem-outside",
    ownerId: "necromancer",
    kind: "golem",
    skillId: "clay-golem",
    position: { q: 3, r: 3 },
  }), /inside the deployment zone/);

  battle.startBattle();
  const golem = battle.summonUnit({
    id: "golem-1",
    ownerId: "necromancer",
    kind: "golem",
    skillId: "clay-golem",
    position: { q: 3, r: 3 },
  });
  assert.equal(golem.consumesTurn, true);
  assert.equal(battle.listSummons({ ownerId: "necromancer" }).length, 3);
});

test("only surviving persistent summons carry into the next preparation encounter", () => {
  const battle = makeBattle();
  battle.summonUnit({
    id: "skeleton-1",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    persistent: true,
    position: { q: 0, r: 3 },
  });
  battle.summonUnit({
    id: "temporary-golem",
    ownerId: "necromancer",
    kind: "golem",
    skillId: "clay-golem",
    persistent: false,
    position: { q: 1, r: 3 },
  });
  battle.startBattle();
  const completed = battle.completeBattle({ survivingSummonIds: ["skeleton-1", "temporary-golem"] });
  assert.equal(battle.phase, BATTLE_PHASE.COMPLETED);
  assert.deepEqual(completed.persistentSummons.map(({ id }) => id), ["skeleton-1"]);
  assert.equal(battle.enemyTurnsEnabled, false);

  const beforeInvalidPlacement = battle.snapshot();
  assert.throws(() => battle.beginNextBattle({
    heroPositions: defaultPositions(),
    summonPositions: { "skeleton-1": { q: 3, r: 0 } },
  }), /three-column deployment zone/);
  assert.deepEqual(battle.snapshot(), beforeInvalidPlacement, "a rejected next encounter must be atomic");

  const next = battle.beginNextBattle({
    heroPositions: defaultPositions(),
    summonPositions: { "skeleton-1": { q: 2, r: 3 } },
  });
  assert.equal(next.encounterNumber, 2);
  assert.equal(battle.phase, BATTLE_PHASE.PREPARATION);
  assert.equal(battle.activation, null);
  assert.equal(battle.enemyAwarenessEnabled, false);
  assert.deepEqual(battle.positionOf("skeleton-1"), { q: 2, r: 3 });
});

test("a defeated summon is removed and party effects retain only their surviving targets", () => {
  const battle = makeBattle();
  battle.summonUnit({
    id: "skeleton-1",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    position: { q: 0, r: 3 },
  });
  battle.applyBuff({
    id: "orders",
    skillId: "battle-orders",
    sourceId: "barbarian",
    targetIds: ["barbarian", "skeleton-1"],
    baseDurationSeconds: 12,
  });
  assert.equal(battle.defeatSummon("skeleton-1"), true);
  assert.equal(battle.defeatSummon("skeleton-1"), false);
  assert.deepEqual(battle.listSummons(), []);
  assert.deepEqual(battle.listBuffs()[0].targetIds, ["barbarian"]);
});

test("an active hero can withdraw, survive a canonical round trip, and return without ghost occupancy", () => {
  const battle = makeBattle();
  battle.startBattle();
  const actionSequence = battle.actionSequence;
  const withdrawn = battle.withdrawUnit("paladin");
  assert.equal(withdrawn.consumesTurn, false);
  assert.equal(withdrawn.presence, UNIT_PRESENCE.OFF_FIELD);
  assert.equal(withdrawn.position, null);
  assert.equal(battle.actionSequence, actionSequence + 1);
  assert.equal(battle.presenceOf("paladin"), UNIT_PRESENCE.OFF_FIELD);
  assert.equal(battle.isUnitOnField("paladin"), false);
  assert.equal(battle.positionOf("paladin"), null);
  assert.equal(battle.isUnitOnField("barbarian"), true);

  const snapshot = battle.snapshot();
  assert.deepEqual(snapshot.heroPresence, [
    { heroId: "barbarian", state: UNIT_PRESENCE.ON_FIELD },
    { heroId: "paladin", state: UNIT_PRESENCE.OFF_FIELD },
    { heroId: "necromancer", state: UNIT_PRESENCE.ON_FIELD },
  ]);
  assert.equal(snapshot.positions.some(({ unitId }) => unitId === "paladin"), false);
  const restored = BattlePreparationState.restore(structuredClone(snapshot));
  assert.deepEqual(restored.snapshot(), snapshot);
  const returned = restored.returnUnit({ unitId: "paladin", to: { q: 4, r: 2 } });
  assert.equal(returned.consumesTurn, false);
  assert.equal(returned.presence, UNIT_PRESENCE.ON_FIELD);
  assert.deepEqual(restored.positionOf("paladin"), { q: 4, r: 2 });
  assert.equal(restored.isUnitOnField("paladin"), true);
});

test("withdrawing a buff target preserves the effect for remaining units while withdrawing its source removes it", () => {
  const battle = makeBattle();
  battle.applyBuff({
    id: "battle-orders",
    skillId: "battle-orders",
    sourceId: "barbarian",
    targetIds: HERO_IDS,
    baseDurationSeconds: 18,
  });
  battle.startBattle();

  const targetWithdrawal = battle.withdrawUnit("paladin");
  assert.deepEqual(targetWithdrawal.removedBuffIds, []);
  assert.deepEqual(targetWithdrawal.updatedBuffIds, ["battle-orders"]);
  assert.deepEqual(battle.listBuffs()[0].targetIds, ["barbarian", "necromancer"]);

  const sourceWithdrawal = battle.withdrawUnit("barbarian");
  assert.deepEqual(sourceWithdrawal.removedBuffIds, ["battle-orders"]);
  assert.deepEqual(sourceWithdrawal.updatedBuffIds, []);
  assert.deepEqual(battle.listBuffs(), []);
});

test("return conflicts and invalid presence transitions are atomic", () => {
  const battle = makeBattle();
  battle.startBattle();
  battle.withdrawUnit("paladin");
  const beforeConflict = battle.snapshot();
  assert.throws(() => battle.returnUnit({ unitId: "paladin", to: { q: 2, r: 0 } }), /occupied by barbarian/);
  assert.deepEqual(battle.snapshot(), beforeConflict);
  assert.throws(() => battle.withdrawUnit("not-a-hero"), /Unknown main hero/);
  assert.deepEqual(battle.snapshot(), beforeConflict);

  battle.summonUnit({
    id: "golem-1",
    ownerId: "necromancer",
    kind: "golem",
    skillId: "clay-golem",
    position: { q: 1, r: 1 },
  });
  assert.deepEqual(battle.positionOf("golem-1"), { q: 1, r: 1 }, "the withdrawn hero's old hex is free");
  const beforeSummonTransition = battle.snapshot();
  assert.throws(() => battle.withdrawUnit("golem-1"), /Unknown main hero/);
  assert.throws(() => battle.returnUnit({ unitId: "golem-1", to: { q: 5, r: 0 } }), /Unknown main hero/);
  assert.deepEqual(battle.snapshot(), beforeSummonTransition, "summons retain their dedicated lifecycle");

  battle.returnUnit({ unitId: "paladin", to: { q: 5, r: 1 } });
  const beforeTeleport = battle.snapshot();
  assert.throws(() => battle.returnUnit({ unitId: "paladin", to: { q: 6, r: 1 } }), /already on the field/);
  assert.deepEqual(battle.snapshot(), beforeTeleport);
});

test("off-field state is active-combat-only and preparation snapshots require all heroes deployed", () => {
  const preparation = makeBattle();
  const initial = preparation.snapshot();
  assert.throws(() => preparation.withdrawUnit("paladin"), /only during active combat/);
  assert.throws(() => preparation.returnUnit({ unitId: "paladin", to: { q: 1, r: 1 } }), /only during active combat/);
  assert.deepEqual(preparation.snapshot(), initial);

  const invalidPreparation = structuredClone(initial);
  invalidPreparation.heroPresence[1].state = UNIT_PRESENCE.OFF_FIELD;
  invalidPreparation.positions.splice(invalidPreparation.positions.findIndex(({ unitId }) => unitId === "paladin"), 1);
  assert.throws(() => BattlePreparationState.restore(invalidPreparation), /requires every main hero on the field/);

  preparation.startBattle();
  preparation.withdrawUnit("paladin");
  preparation.completeBattle();
  const completed = preparation.snapshot();
  assert.throws(() => preparation.withdrawUnit("barbarian"), /only during active combat/);
  assert.throws(() => preparation.returnUnit({ unitId: "paladin", to: { q: 1, r: 1 } }), /only during active combat/);
  assert.deepEqual(preparation.snapshot(), completed);
});

test("filtered turn advance ticks only buffs that existed before the action", () => {
  const battle = makeBattle();
  battle.startBattle();
  battle.applyBuff({
    id: "older-orders",
    skillId: "battle-orders",
    sourceId: "barbarian",
    targetIds: ["barbarian"],
    baseDurationSeconds: 12,
  });
  const eligibleBuffIds = battle.listBuffs().map(({ id }) => id);
  battle.applyBuff({
    id: "fresh-shout",
    skillId: "shout",
    sourceId: "barbarian",
    targetIds: ["barbarian"],
    baseDurationSeconds: 6,
  });
  battle.advanceTurn(1, { eligibleBuffIds: [...eligibleBuffIds, "already-gone"] });
  assert.deepEqual(battle.listBuffs().map(({ id, remainingTurns }) => [id, remainingTurns]), [
    ["fresh-shout", 1],
    ["older-orders", 1],
  ]);

  const beforeInvalidFilter = battle.snapshot();
  assert.throws(() => battle.advanceTurn(1, { eligibleBuffIds: ["older-orders", "older-orders"] }), /must be unique/);
  assert.deepEqual(battle.snapshot(), beforeInvalidFilter);
  assert.deepEqual(battle.advanceTurn().expiredBuffIds, ["fresh-shout", "older-orders"]);
});

test("schema-one snapshots migrate explicitly with every legacy hero on field", () => {
  const current = makeBattle().snapshot();
  const { heroPresence: ignoredPresence, ...legacyFields } = current;
  const legacy = { ...legacyFields, schemaVersion: 1 };
  assert.equal(ignoredPresence.length, HERO_IDS.length);
  assert.throws(() => BattlePreparationState.restore(legacy), /Unsupported/);
  const migrated = BattlePreparationState.migrateSnapshot(legacy);
  assert.deepEqual(migrated, current);
  assert.notEqual(migrated, legacy);

  const malformedLegacy = structuredClone(legacy);
  malformedLegacy.positions.pop();
  assert.throws(() => BattlePreparationState.migrateSnapshot(malformedLegacy), /positions must contain every on-field hero/);
});

test("snapshot and restore are exact, isolated, canonical, and valid in all phases", () => {
  const battle = makeBattle();
  battle.applyBuff({
    id: "orders",
    skillId: "battle-orders",
    sourceId: "barbarian",
    targetIds: HERO_IDS,
    baseDurationSeconds: 18,
  });
  battle.summonUnit({
    id: "golem-1",
    ownerId: "necromancer",
    kind: "golem",
    skillId: "clay-golem",
    position: { q: 1, r: 3 },
  });
  battle.useSkill({ actorId: "paladin", skillId: "zeal", category: SKILL_CATEGORY.OFFENSIVE });
  battle.moveUnit({ unitId: "golem-1", to: { q: 3, r: 3 } });
  const snapshot = battle.snapshot();
  const restored = BattlePreparationState.restore(structuredClone(snapshot));
  assert.deepEqual(restored.snapshot(), snapshot);
  restored.moveUnit({ unitId: "golem-1", to: { q: 4, r: 3 } });
  assert.notDeepEqual(restored.snapshot(), snapshot);
  assert.deepEqual(battle.snapshot(), snapshot, "the restored instance must not alias the source");
  assert.ok(Object.isFrozen(restored.getLoadout("paladin")));
  assert.ok(Object.isFrozen(restored.listBuffs()));

  battle.completeBattle({ survivingSummonIds: ["golem-1"] });
  const completedSnapshot = battle.snapshot();
  assert.deepEqual(BattlePreparationState.restore(completedSnapshot).snapshot(), completedSnapshot);
});

test("restore rejects malformed, inconsistent, non-canonical, and future snapshots", () => {
  const battle = makeBattle();
  battle.startBattle();
  const clean = battle.snapshot();

  const future = structuredClone(clean);
  future.schemaVersion = BATTLE_PREPARATION_SCHEMA_VERSION + 1;
  assert.throws(() => BattlePreparationState.restore(future), /Unsupported/);

  const noActivation = structuredClone(clean);
  noActivation.activation = null;
  assert.throws(() => BattlePreparationState.restore(noActivation), /requires an activation/);

  const duplicatePosition = structuredClone(clean);
  duplicatePosition.positions[1].q = duplicatePosition.positions[0].q;
  duplicatePosition.positions[1].r = duplicatePosition.positions[0].r;
  assert.throws(() => BattlePreparationState.restore(duplicatePosition), /positions must be unique/);

  const shuffled = structuredClone(clean);
  shuffled.positions.reverse();
  assert.throws(() => BattlePreparationState.restore(shuffled), /canonical id order/);

  const extra = structuredClone(clean);
  extra.debug = true;
  assert.throws(() => BattlePreparationState.restore(extra), /invalid shape/);
});

test("exhausted persisted counters fail before mutation", () => {
  const battle = makeBattle();
  const exhaustedSnapshot = battle.snapshot();
  exhaustedSnapshot.actionSequence = Number.MAX_SAFE_INTEGER;
  const exhausted = BattlePreparationState.restore(exhaustedSnapshot);
  const before = exhausted.snapshot();
  assert.throws(() => exhausted.changeSkill({
    heroId: "barbarian",
    slot: "left",
    skillId: "double-swing",
  }), /exhausted/);
  assert.deepEqual(exhausted.snapshot(), before);
});

test("completed battle rejects gameplay actions and clears encounter-only buffs", () => {
  const battle = makeBattle();
  battle.summonUnit({
    id: "skeleton-1",
    ownerId: "necromancer",
    kind: "skeleton",
    skillId: "raise-skeleton",
    position: { q: 0, r: 3 },
  });
  battle.applyBuff({
    id: "might",
    skillId: "might",
    sourceId: "paladin",
    targetIds: HERO_IDS,
    permanent: true,
    exclusiveGroup: "paladin-aura",
  });
  battle.startBattle();
  battle.completeBattle();
  assert.deepEqual(battle.listBuffs(), []);
  const completed = battle.snapshot();
  assert.throws(() => battle.defeatSummon("skeleton-1"), /accepts no actions/);
  assert.deepEqual(battle.snapshot(), completed);
  assert.throws(() => battle.moveUnit({ unitId: "barbarian", to: { q: 3, r: 0 } }), /accepts no actions/);
  assert.throws(() => battle.useSkill({
    actorId: "barbarian",
    skillId: "bash",
    category: SKILL_CATEGORY.OFFENSIVE,
  }), /accepts no actions/);
  assert.throws(() => battle.startBattle(), /accepts no actions/);
});
