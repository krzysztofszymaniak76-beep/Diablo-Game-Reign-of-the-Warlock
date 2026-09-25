import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACTION_TIME,
  ATTACK_IMPACT_OFFSET,
  PROJECTILE_HEX_TIME,
  TIMELINE_EVENT_PRIORITY,
} from "../src/core/combat.js";
import {
  BATTLE_PHASE,
  DEFAULT_PREPARATION_BALANCE,
  DEPLOYMENT_COLUMN_COUNT,
  MAX_MAIN_HEROES,
} from "../src/core/battle-preparation.js";

test("adaptation manifest mirrors the authoritative action costs", async () => {
  const config = JSON.parse(await readFile(new URL("../data/adaptation_config.json", import.meta.url), "utf8"));
  assert.equal(config.timelineModel, "deterministic-event-recovery-time");
  assert.equal(config.basicAttackImpactOffset, ATTACK_IMPACT_OFFSET);
  assert.equal(config.projectileTimePerHex, PROJECTILE_HEX_TIME);
  assert.deepEqual(config.sameTickOrder, [
    "control",
    "attack-impact/projectile-impact",
    "projectile-step",
    "move-step",
    "actor-ready",
  ]);
  assert.ok(TIMELINE_EVENT_PRIORITY.CONTROL < TIMELINE_EVENT_PRIORITY.ATTACK_IMPACT);
  assert.equal(TIMELINE_EVENT_PRIORITY.ATTACK_IMPACT, TIMELINE_EVENT_PRIORITY.PROJECTILE_IMPACT);
  assert.ok(TIMELINE_EVENT_PRIORITY.PROJECTILE_IMPACT < TIMELINE_EVENT_PRIORITY.PROJECTILE_STEP);
  assert.ok(TIMELINE_EVENT_PRIORITY.PROJECTILE_STEP < TIMELINE_EVENT_PRIORITY.MOVE_STEP);
  assert.ok(TIMELINE_EVENT_PRIORITY.MOVE_STEP < TIMELINE_EVENT_PRIORITY.ACTOR_READY);
  assert.equal(config.movementResolution, "one-reserved-hex-per-event");
  assert.equal(config.enemyAiProfile, "MELEE_PRESSURE");
  assert.deepEqual({
    attack: config.basicAttackTime,
    cast: config.castTime,
    movePerTile: config.moveTimePerHex,
    wait: config.waitTime,
    swap: config.combatSwapTime,
    portalOpen: config.townPortalOpenTime,
    portalEnter: config.townPortalEnterTime,
    itemUse: config.combatItemUseTime,
    equipmentChange: config.combatEquipmentChangeTime,
  }, ACTION_TIME);
  assert.equal(config.gameRulesetVersion, "rotw-hex-combat-v0.5.0-preparation-adaptation");
  assert.equal(config.partySizeMax, MAX_MAIN_HEROES);
  assert.equal(config.mainHeroLimitExcludesSummons, true);
  assert.equal(config.deploymentColumns, DEPLOYMENT_COLUMN_COUNT);
  assert.deepEqual(config.battlePhaseModel, Object.values(BATTLE_PHASE));
  assert.deepEqual(config.activeSkillSlots, { left: 1, right: 3 });
  assert.equal(config.loadoutChangeCostPreparation, "free");
  assert.equal(config.loadoutChangeCostActive, "one-actor-turn");
  assert.equal(config.weaponSetCount, 1);
  assert.equal(config.buffDurationSecondsPerTurn, DEFAULT_PREPARATION_BALANCE.secondsPerTurn);
  assert.equal(config.preparationEnemyTurns, false);
  assert.equal(config.preparationEnemyAwareness, false);
  assert.equal(config.persistentSummonsBetweenBattles, true);
  assert.equal(config.battleGridColumns * config.battleGridRows, 96);
});
