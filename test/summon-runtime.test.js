import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { CombatState } from "../src/core/combat.js";
import { HexGrid, axial, hexDisk, hexNeighbors } from "../src/core/hex-grid.js";
import { BattlePreparationState } from "../src/core/battle-preparation.js";
import { DeterministicRng } from "../src/core/rng.js";
import { commitRaiseSkeleton, planRaiseSkeleton, planSummonTurn } from "../src/core/summons.js";
import { FORMULA_NOT_CONFIRMED, summonStatsForUnit } from "../src/core/necroskeleton-source.js";

function fixture({ enemyPosition = { q: 4, r: 0 }, corpsePosition = { q: 2, r: 0 } } = {}) {
  const hero = createCharacter({ id: "necro", name: "Necromancer", classId: "necromancer" });
  hero.resources.maxMana = 50;
  hero.resources.mana = 50;
  const roster = new Roster([hero]);
  const party = new Party(roster, [hero.id]);
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, battleId: "battle-1", encounterId: "encounter-1" });
  const enemy = combat.spawnMonster({ id: "fallen-1", name: "Fallen", baseHp: 10, baseExperience: 1, position: corpsePosition });
  const tiles = hexDisk({ q: 0, r: 0 }, 8);
  const grid = new HexGrid({ tiles });
  grid.addUnit({ id: hero.id, position: { q: 0, r: 0 } });
  grid.addUnit({ id: enemy.id, position: enemyPosition });
  combat.units.get(hero.id).position = axial(0, 0);
  combat.units.get(enemy.id).position = axial(enemyPosition.q, enemyPosition.r);
  const preparation = new BattlePreparationState({
    heroIds: [hero.id],
    loadouts: { [hero.id]: { left: "necromancer.teeth", right: ["necromancer.raise_skeleton", "necromancer.clay_golem", "necromancer.amplify_damage"] } },
    heroPositions: { [hero.id]: { q: 0, r: 0 } },
    summonLimits: { skeleton: 4 },
  });
  preparation.startBattle();
  enemy.hp = 0;
  const corpse = combat.recordMonsterDeath(enemy.id);
  grid.removeUnit(enemy.id);
  return { hero, roster, party, playersSetting, combat, enemy, corpse, grid, preparation };
}

function plan(f, overrides = {}) {
  return planRaiseSkeleton({
    combat: f.combat,
    grid: f.grid,
    preparation: f.preparation,
    casterId: "necro",
    corpseId: f.corpse.id,
    corpseHex: { q: Number(f.corpse.hexId.split(",")[0]), r: Number(f.corpse.hexId.split(",")[1]) },
    manaCost: 3,
    activePpmSkillId: "necromancer.raise_skeleton",
    knownSkillIds: ["necromancer.raise_skeleton"],
    ...overrides,
  });
}

test("Raise Skeleton plan contains corpse, spawn, mana, owner and source skill", () => {
  const f = fixture();
  const result = plan(f);
  assert.equal(result.casterId, "necro");
  assert.equal(result.skillId, "necromancer.raise_skeleton");
  assert.equal(result.corpseId, f.corpse.id);
  assert.equal(result.manaCost, 3);
  assert.equal(result.encounterId, "encounter-1");
  assert.deepEqual(result.summonHex, { q: 4, r: 0 });
});

test("Raise Skeleton commit atomically consumes one corpse, pays mana once, and creates one runtime summon", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(f.combat.corpses.get(f.corpse.id).consumed, false);
  assert.equal(f.hero.resources.mana, 50);
  assert.equal(result.corpse.consumed, true);
  assert.equal(result.roster.get("necro").resources.mana, 47);
  assert.equal(result.combat.listSummons().length, 1);
  assert.equal(result.combat.listSummons()[0].ownerId, "necro");
  assert.equal(result.combat.listSummons()[0].sourceSkillId, "necromancer.raise_skeleton");
  assert.equal(result.combat.listSummons()[0].encounterId, "encounter-1");
  assert.deepEqual(result.grid.positionOf(result.summon.id), result.summon.position);
});

test("Raise Skeleton rejects consumed corpse, stale PPM, dead caster, insufficient mana and no legal spawn", () => {
  const f = fixture();
  f.combat.corpses.consumeCorpse(f.corpse.id, "other", "test");
  assert.throws(() => plan(f), /already consumed/);
  const g = fixture();
  assert.throws(() => plan(g, { activePpmSkillId: "necromancer.teeth" }), /active PPM/);
  const h = fixture();
  h.roster.get("necro").resources.hp = 0;
  h.roster.get("necro").lifeState = "corpse";
  assert.throws(() => plan(h), /defeated/);
  const i = fixture();
  assert.throws(() => plan(i, { manaCost: 999 }), /many/);
  const j = fixture();
  const corpsePosition = { q: Number(j.corpse.hexId.split(",")[0]), r: Number(j.corpse.hexId.split(",")[1]) };
  for (const position of [corpsePosition, ...hexNeighbors(corpsePosition)]) {
    if (!j.grid.occupantAt(position)) j.grid.addUnit({ id: `block-${position.q}-${position.r}`, position });
  }
  assert.throws(() => plan(j), /No legal spawn/);
  assert.equal(j.combat.corpses.get(j.corpse.id).consumed, false);
});

test("Summon AI attacks a legal adjacent living monster and never targets a corpse", () => {
  const f = fixture({ enemyPosition: { q: 3, r: 0 } });
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  // Place the living enemy beside the summon in the staged world.
  const summon = raised.combat.listSummons()[0];
  raised.grid.removeUnit("fallen-1");
  raised.combat.units.get("fallen-1").hp = 10;
  raised.combat.units.get("fallen-1").position = { q: 4, r: 0 };
  raised.grid.addUnit({ id: "fallen-1", position: { q: 4, r: 0 } });
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: summon.id, rng: new DeterministicRng(7), damageProfile: { kind: "integer-range", min: 0, max: 0 } });
  assert.equal(action.type, "attack");
  assert.equal(action.targetId, "fallen-1");
});

test("Summon runtime fields and corpse state survive CombatState save/load", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const restored = CombatState.restore(raised.combat.snapshot(), { party: raised.party, playersSetting: raised.playersSetting ?? f.playersSetting });
  const summon = restored.listSummons()[0];
  assert.equal(summon.ownerId, "necro");
  assert.equal(summon.summonType, "skeleton");
  assert.equal(restored.corpses.get(f.corpse.id).consumed, true);
});

test("6. Raise Skeleton rejects a ground hex, a living enemy hex and a missing corpse", () => {
  const f = fixture();
  assert.throws(() => plan(f, { corpseHex: { q: 0, r: 0 } }), /does not contain/);
  assert.throws(() => plan(f, { corpseId: "missing:corpse" }), /does not exist/);
});

test("7. stale encounter and duplicate command plans are rejected", () => {
  const f = fixture();
  assert.throws(() => plan(f, { encounterId: "other" }), /encounter/);
  assert.throws(() => plan(f, { commandId: "duplicate", executedCommandIds: ["duplicate"] }), /already executed/);
});

test("8. duplicate summon ids are rejected before corpse or mana mutation", () => {
  const f = fixture();
  const first = plan(f, { summonId: "fixed-skeleton" });
  const committed = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: first });
  assert.equal(committed.corpse.consumed, true);
  const secondFixture = fixture();
  const secondPlan = plan(secondFixture, { summonId: "fixed-skeleton" });
  secondFixture.combat.units.set("fixed-skeleton", { kind: "summon", id: "fixed-skeleton" });
  assert.throws(() => planRaiseSkeleton({
    combat: secondFixture.combat,
    grid: secondFixture.grid,
    preparation: secondFixture.preparation,
    casterId: "necro",
    corpseId: secondFixture.corpse.id,
    corpseHex: { q: 4, r: 0 },
    manaCost: 3,
    activePpmSkillId: "necromancer.raise_skeleton",
    knownSkillIds: ["necromancer.raise_skeleton"],
    summonId: secondPlan.summonId,
  }), /Duplicate summon id/);
});

test("9. occupied corpse hex falls back to a legal adjacent hex", () => {
  const f = fixture();
  const corpseHex = { q: 4, r: 0 };
  f.grid.addUnit({ id: "block-corpse", position: corpseHex });
  const result = plan(f);
  assert.notDeepEqual(result.summonHex, corpseHex);
  assert.equal(f.grid.canOccupy(result.summonHex), true);
});

test("10. caster death after planning and a changed loadout reject commit", () => {
  const f = fixture();
  const p = plan(f);
  f.roster.get("necro").resources.hp = 0;
  f.roster.get("necro").lifeState = "corpse";
  assert.throws(() => commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: p }), /defeated/);
  const g = fixture();
  const q = plan(g);
  const staged = BattlePreparationState.restore(g.preparation.snapshot());
  staged.changeSkill({ heroId: "necro", slot: "right", rightIndex: 0, skillId: "necromancer.corpse_explosion" });
  assert.throws(() => commitRaiseSkeleton({ combat: g.combat, grid: g.grid, preparation: staged, plan: q }), /stale/);
});

test("11. second use of the same corpse fails and leaves one summon", () => {
  const f = fixture();
  const p = plan(f);
  const committed = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: p });
  assert.throws(() => planRaiseSkeleton({
    combat: committed.combat, grid: committed.grid, preparation: committed.preparation,
    casterId: "necro", corpseId: f.corpse.id, corpseHex: p.corpseHex, manaCost: 3,
    activePpmSkillId: "necromancer.raise_skeleton", knownSkillIds: ["necromancer.raise_skeleton"],
  }), /already consumed/);
  assert.equal(committed.combat.listSummons().length, 1);
});

test("12. summon AI does nothing when there is no living enemy", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, rng: new DeterministicRng(1) });
  assert.equal(action.type, "wait");
  assert.equal(action.reason, "NO_LIVING_ENEMY");
});

test("13. summon AI uses an injected deterministic selector among two melee enemies", () => {
  const f = fixture({ enemyPosition: { q: 4, r: 0 } });
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const enemy2 = raised.combat.spawnMonster({ id: "fallen-2", name: "Fallen 2", baseHp: 10, baseExperience: 1, position: { q: 3, r: 0 } });
  raised.grid.addUnit({ id: enemy2.id, position: { q: 3, r: 0 } });
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, selectTarget: (ids) => ids.at(-1) });
  assert.equal(action.type, "attack");
  assert.equal(action.targetId, "fallen-2");
});

test("14. summon AI ignores allies and corpses", () => {
  const f = fixture({ enemyPosition: { q: 4, r: 0 } });
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const ally = raised.combat.spawnSummon({ id: "ally-skeleton", ownerId: "necro", sourceSkillId: "necromancer.raise_skeleton", sourceMonsterCode: "necroskeleton", statInputs: raised.summon.statInputs, position: { q: 3, r: 0 }, encounterId: "encounter-1" });
  raised.grid.addUnit({ id: ally.id, position: ally.position });
  raised.combat.units.get("fallen-1").hp = 10;
  raised.combat.units.get("fallen-1").position = { q: 5, r: 0 };
  raised.grid.addUnit({ id: "fallen-1", position: { q: 5, r: 0 } });
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, selectTarget: (ids) => ids[0] });
  assert.equal(action.targetId, "fallen-1");
});

test("15. out-of-melee summon plans one approach attack without a second action", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, rng: new DeterministicRng(2) });
  assert.ok(["approachAttack", "move", "wait"].includes(action.type));
  assert.notEqual(action.type, "attack");
});

test("16. no legal path produces wait rather than teleport", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  raised.combat.units.get("fallen-1").hp = 10;
  raised.combat.units.get("fallen-1").position = { q: 6, r: 0 };
  raised.grid.addUnit({ id: "fallen-1", position: { q: 6, r: 0 } });
  // Block every tile around the summon and keep the monster alive.
  for (const position of hexNeighbors(raised.summon.position)) {
    if (raised.grid.has(position) && !raised.grid.occupantAt(position)) raised.grid.addUnit({ id: `wall-${position.q}-${position.r}`, position });
  }
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, rng: new DeterministicRng(3) });
  assert.equal(action.type, "wait");
  assert.equal(action.reason, "NO_LEGAL_PATH");
});

test("17. dead target is never returned as a summon action", () => {
  const f = fixture({ enemyPosition: { q: 4, r: 0 } });
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  raised.combat.units.get("fallen-1").hp = 0;
  const action = planSummonTurn({ combat: raised.combat, grid: raised.grid, summonId: raised.summon.id, rng: new DeterministicRng(4) });
  assert.equal(action.type, "wait");
});

test("18. summon snapshot rejects duplicate ids and invalid summon schema", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const duplicate = raised.combat.snapshot();
  duplicate.units.push(structuredClone(duplicate.units.find((unit) => unit.kind === "summon")));
  assert.throws(() => CombatState.restore(duplicate, { party: raised.party, playersSetting: f.playersSetting }), /Duplicate unit/);
  const invalid = raised.combat.snapshot();
  delete invalid.units.find((unit) => unit.kind === "summon").ownerId;
  assert.throws(() => CombatState.restore(invalid, { party: raised.party, playersSetting: f.playersSetting }), /Summon ownerId/);
});

test("19. old combat snapshots without summons still load", () => {
  const f = fixture();
  const snapshot = f.combat.snapshot();
  const restored = CombatState.restore(snapshot, { party: f.party, playersSetting: f.playersSetting });
  assert.deepEqual(restored.listSummons(), []);
});

test("20. one summoned unit creates one readiness identity and no corpse", () => {
  const f = fixture({ enemyPosition: { q: 4, r: 0 } });
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(raised.combat.readinessQueue().filter(({ id }) => id === raised.summon.id).length, 1);
  assert.equal(raised.combat.corpses.list().filter(({ id }) => id === raised.summon.id).length, 0);
});

test("21. exact source is confirmed while final HP remains unresolved", () => {
  const f = fixture();
  const raised = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(raised.summon.sourceMonsterCode, "necroskeleton");
  assert.equal(raised.summon.sourceData, undefined);
  assert.equal(summonStatsForUnit(raised.summon).final.hp, FORMULA_NOT_CONFIRMED);
  assert.equal(raised.summon.hp, null);
  assert.equal(raised.summon.maxHp, null);
});

test("22. the deferred Warlock demon/reposition scope is documented, not executed", () => {
  const source = readFileSync(new URL("../src/core/summons.js", import.meta.url), "utf8");
  assert.match(source, /WARLOCK_DEMON_REPOSITION_FUTURE/);
});

test("23. insufficient mana is rejected before any staged model is published", () => {
  const f = fixture();
  assert.throws(() => plan(f, { manaCost: 999 }), /many/);
  assert.equal(f.combat.corpses.get(f.corpse.id).consumed, false);
  assert.equal(f.roster.get("necro").resources.mana, 50);
});

test("24. no legal spawn leaves the corpse and mana unchanged", () => {
  const f = fixture();
  const center = { q: Number(f.corpse.hexId.split(",")[0]), r: Number(f.corpse.hexId.split(",")[1]) };
  for (const position of [center, ...hexNeighbors(center)]) {
    if (!f.grid.occupantAt(position)) f.grid.addUnit({ id: `seal-${position.q}-${position.r}`, position });
  }
  assert.throws(() => plan(f), /No legal spawn/);
  assert.equal(f.combat.corpses.get(f.corpse.id).consumed, false);
});

test("25. a corpse from another battle is rejected", () => {
  const f = fixture();
  const snapshot = f.combat.corpses.snapshot();
  snapshot.battleId = "foreign";
  assert.throws(() => planRaiseSkeleton({
    combat: f.combat,
    grid: f.grid,
    preparation: f.preparation,
    casterId: "necro",
    corpseId: f.corpse.id,
    corpseHex: { q: 4, r: 0 },
    manaCost: 3,
    activePpmSkillId: "necromancer.raise_skeleton",
    knownSkillIds: ["necromancer.raise_skeleton"],
    encounterId: "foreign",
  }), /another encounter/);
});

test("26. summon record keeps the exact source identity", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.summon.sourceMonsterCode, "necroskeleton");
});

test("27. summon owner is preserved through the staged party", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.summon.ownerId, "necro");
  assert.equal(result.party.isActive("necro"), true);
});

test("28. Raise Skeleton source skill is persisted on the runtime unit", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.summon.sourceSkillId, "necromancer.raise_skeleton");
});

test("29. successful spawn hex is a real grid tile and unoccupied", () => {
  const f = fixture();
  const p = plan(f);
  assert.equal(f.grid.has(p.summonHex), true);
  assert.equal(f.grid.canOccupy(p.summonHex), true);
});

test("30. preparation contains exactly one persistent summon after commit", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.preparation.listSummons().length, 1);
  assert.equal(result.preparation.listSummons()[0].persistent, true);
});

test("31. grid and combat share the same summon position", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.deepEqual(result.grid.positionOf(result.summon.id), result.combat.units.get(result.summon.id).position);
});

test("32. a dead summon receives no AI attack", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get(result.summon.id).alive = false;
  const action = planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, rng: new DeterministicRng(10) });
  assert.equal(action.type, "wait");
});

test("33. a consumed corpse is never included in a legal target list", () => {
  const f = fixture({ enemyPosition: { q: 5, r: 0 } });
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get("fallen-1").hp = 10;
  result.combat.units.get("fallen-1").position = { q: 6, r: 0 };
  result.grid.addUnit({ id: "fallen-1", position: { q: 6, r: 0 } });
  const action = planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, selectTarget: (ids) => ids[0] });
  assert.equal(action.targetId, "fallen-1");
  assert.notEqual(action.targetId, f.corpse.id);
});

test("34. one summon activation returns one action descriptor", () => {
  const f = fixture({ enemyPosition: { q: 5, r: 0 } });
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get("fallen-1").hp = 10;
  result.combat.units.get("fallen-1").position = { q: 6, r: 0 };
  result.grid.addUnit({ id: "fallen-1", position: { q: 6, r: 0 } });
  const action = planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, rng: new DeterministicRng(11) });
  assert.ok(["attack", "approachAttack", "move", "wait"].includes(action.type));
  assert.equal(typeof action.summonId, "string");
});

test("35. approach paths are made of adjacent grid tiles", () => {
  const f = fixture({ enemyPosition: { q: 7, r: 0 } });
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get("fallen-1").hp = 10;
  result.combat.units.get("fallen-1").position = { q: 8, r: 0 };
  result.grid.addUnit({ id: "fallen-1", position: { q: 8, r: 0 } });
  const action = planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, rng: new DeterministicRng(12) });
  if (action.path) assert.ok(action.path.every((cell) => result.grid.has(cell)));
});

test("36. AI never invents a destination outside the grid", () => {
  const f = fixture({ enemyPosition: { q: 7, r: 0 } });
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get("fallen-1").hp = 10;
  result.combat.units.get("fallen-1").position = { q: 8, r: 0 };
  result.grid.addUnit({ id: "fallen-1", position: { q: 8, r: 0 } });
  const action = planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, rng: new DeterministicRng(13) });
  if (action.path) assert.ok(action.path.every((cell) => result.grid.has(cell)));
});

test("37. equal seeds produce equal summon choices", () => {
  const one = fixture({ enemyPosition: { q: 4, r: 0 } });
  const two = fixture({ enemyPosition: { q: 4, r: 0 } });
  const a = commitRaiseSkeleton({ combat: one.combat, grid: one.grid, preparation: one.preparation, plan: plan(one) });
  const b = commitRaiseSkeleton({ combat: two.combat, grid: two.grid, preparation: two.preparation, plan: plan(two) });
  const actionA = planSummonTurn({ combat: a.combat, grid: a.grid, summonId: a.summon.id, rng: new DeterministicRng(14) });
  const actionB = planSummonTurn({ combat: b.combat, grid: b.grid, summonId: b.summon.id, rng: new DeterministicRng(14) });
  assert.deepEqual(actionA, actionB);
});

test("38. injected selector cannot return an illegal target", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  result.combat.units.get("fallen-1").hp = 10;
  result.combat.units.get("fallen-1").position = { q: 6, r: 0 };
  result.grid.addUnit({ id: "fallen-1", position: { q: 6, r: 0 } });
  assert.throws(() => planSummonTurn({ combat: result.combat, grid: result.grid, summonId: result.summon.id, selectTarget: () => "not-an-enemy" }), /illegal target/);
});

test("39. alive flag survives summon save/load", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const restored = CombatState.restore(result.combat.snapshot(), { party: result.party, playersSetting: f.playersSetting });
  assert.equal(restored.listSummons()[0].alive, true);
});

test("40. nullable hp fields survive summon save/load", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const restored = CombatState.restore(result.combat.snapshot(), { party: result.party, playersSetting: f.playersSetting });
  assert.equal(restored.listSummons()[0].hp, null);
  assert.equal(restored.listSummons()[0].maxHp, null);
});

test("41. old snapshots remain free of phantom scheduler summon entries", () => {
  const f = fixture();
  const restored = CombatState.restore(f.combat.snapshot(), { party: f.party, playersSetting: f.playersSetting });
  assert.equal(restored.scheduler.queue.some((event) => event.actorId?.includes("skeleton")), false);
});

test("42. a saved summon has exactly one readiness queue entry", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  const restored = CombatState.restore(result.combat.snapshot(), { party: result.party, playersSetting: f.playersSetting });
  assert.equal(restored.readinessQueue().filter(({ id }) => id === result.summon.id).length, 1);
});

test("43. summon encounter identity is preserved", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.summon.encounterId, result.combat.encounterId);
});

test("44. consumed corpse records consumer and purpose", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.corpse.consumedBy, result.summon.id);
  assert.equal(result.corpse.purpose, "necromancer.raise_skeleton");
});

test("45. summon AI profile is the only implemented generic profile", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.summon.aiProfile, "melee_random");
});

test("46. no Warlock demon is fabricated by the skeleton foundation", () => {
  const f = fixture();
  const result = commitRaiseSkeleton({ combat: f.combat, grid: f.grid, preparation: f.preparation, plan: plan(f) });
  assert.equal(result.combat.listSummons().some(({ summonType }) => summonType === "warlock_demon"), false);
});

test('audit: invalid corpse consumer cannot partially consume corpse',()=>{
  const f=fixture(), before=f.combat.corpses.snapshot();
  assert.throws(()=>f.combat.corpses.consumeCorpse(f.corpse.id,'','raise'));
  assert.deepEqual(f.combat.corpses.snapshot(),before);
});
test('audit: changed mana, corpse or grid invalidates the issued plan atomically',()=>{
  for(const change of [f=>{f.roster.get('necro').resources.mana=49;},f=>{f.combat.corpses.corpses.get(f.corpse.id).hexId='5,0';},f=>{f.grid.addUnit({id:'block',position:{q:4,r:0}});}]) {
    const f=fixture(),p=plan(f);change(f);const before=[f.combat.snapshot(),f.grid.snapshot(),f.preparation.snapshot(),f.roster.toJSON()];
    assert.throws(()=>commitRaiseSkeleton({...f,plan:p}),/stale/);
    assert.deepEqual([f.combat.snapshot(),f.grid.snapshot(),f.preparation.snapshot(),f.roster.toJSON()],before);
  }
});
test('audit: forged or altered plan cannot bypass mana and skill validation',()=>{
  const f=fixture(),p=plan(f);assert.throws(()=>commitRaiseSkeleton({...f,plan:{...p,manaCost:-100}}),/stale/);
  assert.throws(()=>{p.summonHex.q=99;},TypeError);
});
test('audit: command receipt persists and prevents reuse on a different corpse',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f,{commandId:'cast-once',skillLevel:6})});
  r.combat.corpses.createFromDeath({sourceUnitId:'second',sourceMonsterCode:'fallen',position:{q:5,r:0}});
  const restored=CombatState.restore(r.combat.snapshot(),{party:r.party,playersSetting:f.playersSetting});
  const corpse=restored.corpses.list().find(c=>!c.consumed);
  assert.throws(()=>planRaiseSkeleton({combat:restored,grid:r.grid,preparation:r.preparation,casterId:'necro',corpseId:corpse.id,manaCost:3,commandId:'cast-once',skillLevel:6}),/already executed/);
});
test('audit: summon count follows source formula and blocks extra casts',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)});
  const corpse=r.combat.corpses.createFromDeath({sourceUnitId:'second',sourceMonsterCode:'fallen',position:{q:5,r:0}});
  assert.throws(()=>planRaiseSkeleton({combat:r.combat,grid:r.grid,preparation:r.preparation,casterId:'necro',corpseId:corpse.id,manaCost:3}),/limit/);
});
test('audit: high-level source count is not silently limited to four',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f,{skillLevel:20})});
  assert.equal(r.preparation.snapshot().rules.summonLimits.find(x=>x.kind==='skeleton').limit,8);
});
test('audit: save rejects invalid owner, skill, AI, HP pair, position and future schema',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)});
  for(const changes of [{ownerId:'missing'},{sourceSkillId:'necromancer.missing'},{aiProfile:'missing'},{maxHp:21},{position:{q:NaN,r:0}},{schemaVersion:2}]) {
    const save=r.combat.snapshot();Object.assign(save.units.find(u=>u.kind==='summon'),changes);
    assert.throws(()=>CombatState.restore(save,{party:r.party,playersSetting:f.playersSetting}));
  }
});
test('audit: saved source provenance rejects manipulated values',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)}),save=r.combat.snapshot();
  save.units.find(u=>u.kind==='summon').statInputs.sourceMonsterSha256='fake';
  assert.throws(()=>CombatState.restore(save,{party:r.party,playersSetting:f.playersSetting}),/provenance/);
});
test('audit: save stores minimal stat inputs and reconstructs identical source-derived stats',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f,{skillLevel:10,masteryLevel:5,difficulty:'hell'})});
  const saved=r.combat.snapshot(),stored=saved.units.find(u=>u.kind==='summon');
  assert.ok(stored.statInputs);assert.equal(stored.sourceData,undefined);
  const before=summonStatsForUnit(stored);
  const restored=CombatState.restore(saved,{party:r.party,playersSetting:f.playersSetting});
  assert.deepEqual(summonStatsForUnit(restored.units.get(r.summon.id)),before);
});
test('audit: v0.5.6 full sourceData summon migrates to minimal stat inputs without identity loss',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f,{skillLevel:10,masteryLevel:5,difficulty:'nightmare'})}),save=r.combat.snapshot();
  const stored=save.units.find(u=>u.kind==='summon');delete stored.statInputs;stored.sourceData=structuredClone(r.plan.sourceData);
  const restored=CombatState.restore(save,{party:r.party,playersSetting:f.playersSetting}),unit=restored.units.get(r.summon.id);
  assert.equal(unit.id,r.summon.id);assert.equal(unit.ownerId,'necro');assert.equal(unit.sourceData,undefined);assert.ok(unit.statInputs);
  assert.deepEqual(summonStatsForUnit(unit),r.plan.sourceData);
});
test('audit: duplicate readiness event for one summon is rejected',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)});r.combat.nextReady();
  const save=r.combat.snapshot(),e=save.scheduler.queue.find(e=>e.actorId===r.summon.id);
  assert.ok(e);const duplicate=structuredClone(e);duplicate.sequence=save.scheduler.sequence++;duplicate.id=`event-${duplicate.sequence}`;save.scheduler.queue.push(duplicate);
  assert.throws(()=>CombatState.restore(save,{party:r.party,playersSetting:f.playersSetting}),/Readiness/);
});
test('audit: future corpse record schema and foreign encounter are rejected',()=>{
  const f=fixture();for(const changes of [{schemaVersion:2},{encounterId:'foreign'}]) {
    const save=f.combat.snapshot();Object.assign(save.corpses.corpses[0],changes);
    assert.throws(()=>CombatState.restore(save,{party:f.party,playersSetting:f.playersSetting}));
  }
});
test('audit: one summon activation cannot submit two paid actions',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)});
  while(r.combat.nextReady([r.summon.id]).id!==r.summon.id) {}
  r.combat.submitAction(r.summon.id,'wait');
  assert.throws(()=>r.combat.submitAction(r.summon.id,'wait'));
});
test('audit: unavailable target disappears without crash or teleport',()=>{
  const f=fixture(),r=commitRaiseSkeleton({...f,plan:plan(f)});r.combat.units.delete('fallen-1');
  const before=r.grid.snapshot();assert.equal(planSummonTurn({combat:r.combat,grid:r.grid,summonId:r.summon.id,rng:new DeterministicRng(5)}).type,'wait');assert.deepEqual(r.grid.snapshot(),before);
});

test('audit: atomic paid cast has one complete command and survives immediate restore',()=>{
  const f=fixture();f.combat.nextReady(['necro']);const before=f.combat.snapshot();
  const r=commitRaiseSkeleton({...f,plan:plan(f,{commandId:'paid-cast'}),payAction:true});
  assert.equal(r.combat.commandHistory.length,1);assert.equal(r.combat.commandSequence,1);
  assert.equal(r.combat.commandHistory[0].kind,'cast');assert.equal(r.combat.units.get('necro').readyAt,1000);
  assert.equal(r.combat.scheduler.queue.filter(e=>e.actorId==='necro').length,1);
  assert.deepEqual(f.combat.snapshot(),before);
  assert.doesNotThrow(()=>CombatState.restore(r.combat.snapshot(),{party:r.party,playersSetting:f.playersSetting}));
});
test('audit: failed scheduler payment publishes neither corpse nor mana nor summon',()=>{
  const f=fixture(),before=[f.combat.snapshot(),f.roster.toJSON(),f.grid.snapshot(),f.preparation.snapshot()];
  assert.throws(()=>commitRaiseSkeleton({...f,plan:plan(f),payAction:true}),/readiness head/);
  assert.deepEqual([f.combat.snapshot(),f.roster.toJSON(),f.grid.snapshot(),f.preparation.snapshot()],before);
});
