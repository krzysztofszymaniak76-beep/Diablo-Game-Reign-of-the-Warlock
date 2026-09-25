import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CombatState } from "../src/core/combat.js";
import { CorpseRegistry, isCorpseTarget } from "../src/core/corpses.js";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { SkillTarget, validateSkillTarget } from "../src/core/skill-execution.js";
import { EquipmentCatalog } from "../src/core/equipment.js";
import { createEncounterProgress, validateLootRecords } from "../src/core/encounter-loot.js";

function fixture({ battleId = "battle-1", sourceMonsterCode = "fallen" } = {}) {
  const roster = new Roster([createCharacter({ id: "hero", name: "Hero", classId: "barbarian" })]);
  const party = new Party(roster, ["hero"]);
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, battleId });
  const enemy = combat.spawnMonster({
    id: "fallen-1",
    name: "Fallen",
    sourceMonsterCode,
    baseHp: 10,
    baseExperience: 2,
    position: { q: 2, r: 3 },
  });
  return { roster, party, playersSetting, combat, enemy };
}

function deadCorpse(options = {}) {
  const f = fixture(options);
  f.enemy.hp = 0;
  const corpse = f.combat.recordMonsterDeath(f.enemy.id);
  return { ...f, corpse };
}

test("1. a dead monster creates exactly one corpse", () => {
  const f = fixture();
  f.combat.nextReady(["hero"]);
  f.combat.submitAction("hero", "attack", { targetId: f.enemy.id, damage: 999 });
  assert.equal(f.combat.corpses.size(), 1);
});

test("2. processing the same death twice does not duplicate a corpse", () => {
  const f = deadCorpse();
  const second = f.combat.recordMonsterDeath(f.enemy.id);
  assert.equal(second.id, f.corpse.id);
  assert.equal(f.combat.corpses.size(), 1);
});

test("3. corpse preserves the monster death hex", () => {
  const f = deadCorpse();
  assert.equal(f.corpse.hexId, "2,3");
  assert.deepEqual(f.combat.corpses.get(f.corpse.id).hexId, "2,3");
});

test("4. a corpse receives no scheduler turn", () => {
  const f = deadCorpse();
  assert.equal(f.combat.units.has(f.corpse.id), false);
  assert.equal(f.combat.scheduler.queue.some((event) => event.actorId === f.corpse.id), false);
  assert.equal(f.combat.readinessQueue().some((entry) => entry.id === f.corpse.id), false);
});

test("5. a corpse cannot attack because it is not a combat unit", () => {
  const f = deadCorpse();
  assert.equal(f.combat.units.has(f.corpse.id), false);
  assert.throws(() => f.combat.submitAction(f.corpse.id, "attack", { targetId: "hero", damage: 1 }), /authoritative readiness head|Unknown actor/);
});

test("6. basic Attack rejects a corpse target", () => {
  const f = deadCorpse();
  f.combat.nextReady(["hero"]);
  assert.throws(
    () => f.combat.submitAction("hero", "attack", { targetId: f.corpse.id, damage: 999 }),
    /cannot target corpse/,
  );
});

test("7. corpse target validation recognizes an available runtime corpse", () => {
  const f = deadCorpse();
  assert.equal(isCorpseTarget(f.corpse), true);
  assert.equal(validateSkillTarget(SkillTarget.CORPSE, { corpse: f.corpse }), true);
  assert.throws(() => validateSkillTarget(SkillTarget.CORPSE, { corpse: { id: f.corpse.id, state: "available" } }), /dostępnych zwłok/);
});

test("8. consuming a fresh corpse succeeds once", () => {
  const f = deadCorpse();
  const consumed = f.combat.corpses.consumeCorpse(f.corpse.id, "hero", "test-consumer");
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.state, "consumed");
});

test("9. consuming the same corpse a second time is rejected", () => {
  const f = deadCorpse();
  f.combat.corpses.consumeCorpse(f.corpse.id, "hero", "first");
  assert.throws(() => f.combat.corpses.consumeCorpse(f.corpse.id, "hero", "second"), /already consumed/);
});

test("10. consumed state survives CombatState save/load", () => {
  const f = deadCorpse();
  f.combat.corpses.consumeCorpse(f.corpse.id, "hero", "save-test");
  const restored = CombatState.restore(f.combat.snapshot(), { party: f.party, playersSetting: f.playersSetting });
  assert.equal(restored.corpses.get(f.corpse.id).consumed, true);
});

test("11. fresh state survives CombatState save/load", () => {
  const f = deadCorpse();
  const restored = CombatState.restore(f.combat.snapshot(), { party: f.party, playersSetting: f.playersSetting });
  assert.equal(restored.corpses.get(f.corpse.id).consumed, false);
  assert.equal(restored.corpses.get(f.corpse.id).hexId, f.corpse.hexId);
});

test("12. duplicate corpse ids in a save are rejected", () => {
  const f = deadCorpse();
  const snapshot = f.combat.corpses.snapshot();
  snapshot.corpses.push(structuredClone(snapshot.corpses[0]));
  assert.throws(() => CorpseRegistry.restore(snapshot), /Duplicate corpse id/);
});

test("13. invalid corpse structure in a save is rejected", () => {
  const f = deadCorpse();
  const snapshot = f.combat.corpses.snapshot();
  snapshot.corpses[0].consumed = "false";
  assert.throws(() => CorpseRegistry.restore(snapshot), /consumed must be boolean/);
});

test("14. an old combat save without corpse data loads safely", () => {
  const f = deadCorpse();
  const snapshot = f.combat.snapshot();
  delete snapshot.corpses;
  const restored = CombatState.restore(snapshot, { party: f.party, playersSetting: f.playersSetting });
  assert.equal(restored.corpses.size(), 0);
});

test("15. a next encounter starts with no foreign corpses", () => {
  const old = deadCorpse({ battleId: "encounter-1" });
  const next = new CombatState({ party: old.party, playersSetting: old.playersSetting, battleId: "encounter-2" });
  assert.equal(old.combat.corpses.size(), 1);
  assert.equal(next.corpses.size(), 0);
  assert.notEqual(next.battleId, old.combat.battleId);
});

test("16. a new CombatState starts with an empty corpse registry", () => {
  const f = fixture({ battleId: "new-game" });
  assert.deepEqual(f.combat.corpses.list(), []);
});

test("17. sourceMonsterCode is preserved in the corpse record", () => {
  const f = deadCorpse({ sourceMonsterCode: "fallen_shaman" });
  assert.equal(f.corpse.sourceMonsterCode, "fallen_shaman");
});

test("18. corpses do not affect the living enemy count", () => {
  const f = deadCorpse();
  assert.equal(f.combat.livingEnemyCount(), 0);
  const living = f.combat.spawnMonster({ id: "fallen-2", name: "Fallen", baseHp: 10, baseExperience: 1 });
  assert.equal(f.combat.livingEnemyCount(), 1);
  living.hp = 0;
  f.combat.recordMonsterDeath(living.id);
  assert.equal(f.combat.livingEnemyCount(), 0);
});

test("19. victory-style living-enemy check ignores corpses", () => {
  const f = deadCorpse();
  assert.equal(f.combat.corpses.size(), 1);
  assert.equal(f.combat.livingEnemyCount() === 0, true);
});

test("20. loot validation does not confuse a corpse with a loot item", () => {
  const f = deadCorpse();
  const progress = createEncounterProgress();
  progress.rewardedCount = 1;
  progress.drops.push(f.corpse);
  const catalog = new EquipmentCatalog(JSON.parse(readFileSync(new URL("../data/equipment.v051.json", import.meta.url), "utf8")));
  assert.equal(f.corpse.item, undefined);
  assert.throws(() => validateLootRecords(progress, catalog), /Nieprawidłowy rekord łupu/);
});

test("21. explicit no-corpse monster data is respected", () => {
  const f = fixture();
  f.enemy.canLeaveCorpse = false;
  f.enemy.hp = 0;
  assert.equal(f.combat.recordMonsterDeath(f.enemy.id), null);
  assert.equal(f.combat.corpses.size(), 0);
});

test("22. malformed corpse hex data is rejected", () => {
  const f = deadCorpse();
  const snapshot = f.combat.corpses.snapshot();
  snapshot.corpses[0].hexId = "not-a-hex";
  assert.throws(() => CorpseRegistry.restore(snapshot), /canonical axial hex id/);
});

test("23. missing monster provenance remains an explicit marker", () => {
  const f = fixture();
  const noCode = f.combat.spawnMonster({ id: "unknown-monster", name: "Unknown", baseHp: 1, baseExperience: 0 });
  noCode.hp = 0;
  const corpse = f.combat.recordMonsterDeath(noCode.id);
  assert.equal(corpse.sourceMonsterCode, "SOURCE_DATA_NOT_FOUND");
});
