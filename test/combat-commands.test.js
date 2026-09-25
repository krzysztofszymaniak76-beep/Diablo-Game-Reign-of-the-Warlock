import test from "node:test";
import assert from "node:assert/strict";
import { createCharacter, Roster } from "../src/core/characters.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting } from "../src/core/players.js";
import { ACTION_TIME, CombatState } from "../src/core/combat.js";

function combatWithHero() {
  const roster = new Roster([createCharacter({ id: "hero", name: "Hero", classId: "amazon" })]);
  return new CombatState({ party: new Party(roster, ["hero"]), playersSetting: new PlayersSetting(1) });
}

test("portal opening and traversal use explicit costs in the common scheduler", () => {
  const combat = combatWithHero();
  assert.equal(combat.nextReady(["hero"]).id, "hero");
  assert.equal(combat.submitAction("hero", "portalOpen").readyAt, ACTION_TIME.portalOpen);
  assert.equal(combat.nextReady(["hero"]).id, "hero");
  assert.equal(combat.scheduler.time, 1000);
  assert.equal(combat.submitAction("hero", "portalEnter").readyAt, 1000 + ACTION_TIME.portalEnter);
  assert.equal(combat.nextReady(["hero"]).id, "hero");
  assert.equal(combat.scheduler.time, 1500);
});

test("equipment changes have an explicit configured combat cost", () => {
  const combat = combatWithHero();
  combat.nextReady(["hero"]);
  const command = combat.submitAction("hero", "equipmentChange", { slot: "weapon" });
  assert.equal(command.readyAt, ACTION_TIME.equipmentChange);
  assert.ok(combat.timelinePreview().some((event) => event.kind === "actor:ready" && event.at === ACTION_TIME.equipmentChange));
});

test("belt item use is a distinct command with one scheduler cost", () => {
  const combat = combatWithHero();
  combat.nextReady(["hero"]);
  const command = combat.submitAction("hero", "itemUse", { beltSlot: 1 });
  assert.equal(command.readyAt, ACTION_TIME.itemUse);
  combat.nextReady(["hero"]);
  assert.equal(combat.scheduler.time, ACTION_TIME.itemUse);
});
