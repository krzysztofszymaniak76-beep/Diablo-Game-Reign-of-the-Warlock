import { Party } from "./party.js";
import { Roster } from "./characters.js";
import { axial, hexDistance, hexKey, hexNeighbors } from "./hex-grid.js";
import { isMeleeContact } from "./spatial-query.js";
import { planApproachAttack } from "./approach-attack.js";
import { BattlePreparationState } from "./battle-preparation.js";
import { CombatState } from "./combat.js";
import { createNecroskeletonStatInputs, resolveNecroskeletonStatInputs } from "./necroskeleton-source.js";

export const SUMMON_RUNTIME_SCHEMA_VERSION = 1;
export const SUMMON_AI_PROFILE = Object.freeze({ MELEE_RANDOM: "melee_random" });
export const RAISE_SKELETON_SKILL_ID = "necromancer.raise_skeleton";
export const SOURCE_DATA_NOT_FOUND = "SOURCE_DATA_NOT_FOUND";
const issuedPlans = new WeakMap();
function worldStamp(combat, grid, preparation) {
  return JSON.stringify([combat.snapshot(), combat.party.roster.toJSON(), grid.snapshot(), preparation.snapshot()]);
}

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function copyHex(value, label = "Hex") {
  if (!value || !Number.isInteger(value.q) || !Number.isInteger(value.r)) throw new TypeError(`${label} must be an axial hex`);
  return axial(value.q, value.r);
}

function parseHexId(value) {
  const [q, r] = requireId(value, "Hex id").split(",").map(Number);
  return copyHex({ q, r }, "Hex id");
}

function aliveCombatUnit(combat, id) {
  const unit = combat.units.get(id);
  if (!unit) return false;
  if (unit.kind === "hero") {
    const character = combat.party.roster.get(id);
    return character.lifeState === "alive" && character.resources.hp > 0;
  }
  if (unit.kind === "summon") return unit.alive !== false && (unit.hp === null || unit.hp > 0);
  return unit.kind === "monster" && unit.hp > 0;
}

function selectDeterministically(ids, rng, selectTarget = null) {
  const sorted = [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en"));
  if (!sorted.length) return null;
  if (selectTarget !== null) {
    if (typeof selectTarget !== "function") throw new TypeError("selectTarget must be a function");
    const selected = selectTarget(Object.freeze(sorted));
    if (!sorted.includes(selected)) throw new Error("Injected summon target selector returned an illegal target");
    return selected;
  }
  if (!rng || typeof rng.integer !== "function") throw new TypeError("A deterministic rng or selector is required");
  return sorted[rng.integer(0, sorted.length - 1)];
}

function legalSpawnHex({ grid, corpseHex }) {
  const candidates = [copyHex(corpseHex), ...hexNeighbors(corpseHex)]
    .filter((candidate, index, all) => all.findIndex((other) => hexKey(other) === hexKey(candidate)) === index)
    .sort((left, right) => hexDistance(corpseHex, left) - hexDistance(corpseHex, right) || hexKey(left).localeCompare(hexKey(right)));
  return candidates.find((candidate) => grid.has(candidate) && grid.canOccupy(candidate)) ?? null;
}

function summonCount(preparation, combat, ownerId, kind) {
  const prepCount = preparation.listSummons({ ownerId }).filter((summon) => summon.kind === kind).length;
  const runtimeCount = [...combat.units.values()].filter((unit) => unit.kind === "summon" && unit.ownerId === ownerId && unit.summonType === kind).length;
  return Math.max(prepCount, runtimeCount);
}

/**
 * Pure validation/planning for the one implemented corpse spell.  The plan is
 * deliberately separate from commit so a failed click cannot consume a corpse,
 * spend mana, or create a half-published summon.
 */
export function planRaiseSkeleton({
  combat,
  grid,
  preparation,
  casterId,
  skillId = RAISE_SKELETON_SKILL_ID,
  activePpmSkillId = skillId,
  knownSkillIds = null,
  corpseId,
  corpseHex = null,
  manaCost,
  summonId = null,
  commandId = null,
  executedCommandIds = null,
  summonType = "skeleton",
  encounterId = combat?.encounterId,
  skillLevel = 1,
  masteryLevel = 0,
  difficulty = "normal",
} = {}) {
  if (!(combat instanceof CombatState) && (!combat?.units || !combat?.corpses)) throw new TypeError("combat is required");
  if (!grid || typeof grid.has !== "function" || typeof grid.canOccupy !== "function") throw new TypeError("grid is required");
  if (!preparation || typeof preparation.listSummons !== "function") throw new TypeError("preparation is required");
  const caster = requireId(casterId, "Raise Skeleton casterId");
  const skill = requireId(skillId, "Raise Skeleton skillId");
  if (skill !== RAISE_SKELETON_SKILL_ID) throw new Error(`Unsupported summon skill: ${skill}`);
  if (activePpmSkillId !== skill) throw new Error("Raise Skeleton is not the active PPM skill");
  if (knownSkillIds !== null && ![...knownSkillIds].includes(skill)) throw new Error("Raise Skeleton is not a known skill");
  const casterUnit = combat.units.get(caster);
  if (!casterUnit || casterUnit.kind !== "hero") throw new Error("Raise Skeleton caster does not exist");
  const character = combat.party.roster.get(caster);
  if (character.classId !== "necromancer" || summonType !== "skeleton") throw new Error("Raise Skeleton requires a Necromancer and skeleton type");
  if (character.lifeState !== "alive" || character.resources.hp <= 0) throw new Error("Raise Skeleton caster is defeated");
  if (preparation.phase !== "active") throw new Error("Raise Skeleton requires active combat");
  if (!Number.isFinite(manaCost) || manaCost < 0) throw new RangeError("Raise Skeleton manaCost must be non-negative");
  if (character.resources.mana < manaCost) throw new Error("Za mało many dla Raise Skeleton");
  if (commandId !== null) {
    const id = requireId(commandId, "Raise Skeleton commandId");
    if (executedCommandIds && [...executedCommandIds].includes(id)) throw new Error("Raise Skeleton command was already executed");
    if (combat.corpses.list().some(corpse => corpse.commandId === id)) throw new Error("Raise Skeleton command was already executed");
  }
  const requestedCorpseId = requireId(corpseId, "Raise Skeleton corpseId");
  if (encounterId !== combat.encounterId) throw new Error("Raise Skeleton plan belongs to another encounter");
  const corpse = combat.corpses.get(requestedCorpseId);
  if (!corpse || corpse.kind !== "corpse") throw new Error("Corpse does not exist");
  if (corpse.consumed || corpse.state !== "available") throw new Error("Corpse is already consumed");
  if (corpse.battleId !== combat.battleId || corpse.encounterId !== combat.encounterId) throw new Error("Corpse belongs to another encounter");
  const requestedHex = parseHexId(corpse.hexId);
  if (corpseHex && hexKey(copyHex(corpseHex, "Raise Skeleton corpseHex")) !== corpse.hexId) {
    throw new Error("Selected hex does not contain the requested corpse");
  }
  const spawnHex = legalSpawnHex({ grid, corpseHex: requestedHex });
  if (!spawnHex) throw new Error("No legal spawn hex for Raise Skeleton");
  const statInputs = createNecroskeletonStatInputs({ skillLevel, masteryLevel, difficulty });
  const sourceData = resolveNecroskeletonStatInputs(statInputs);
  const livingCount = combat.listSummons({ ownerId: caster, aliveOnly: true }).filter(s => s.summonType === summonType).length;
  if (livingCount >= sourceData.maxCount) throw new Error("Raise Skeleton source summon limit reached");
  let sequence = summonCount(preparation, combat, caster, summonType) + 1;
  while (combat.units.has(`${caster}.skeleton.${sequence}`) || preparation.listSummons().some(s=>s.id===`${caster}.skeleton.${sequence}`)) sequence++;
  const nextId = summonId === null ? `${caster}.skeleton.${sequence}` : requireId(summonId, "Raise Skeleton summonId");
  if (combat.units.has(nextId) || preparation.listSummons().some((summon) => summon.id === nextId)) {
    throw new Error(`Duplicate summon id: ${nextId}`);
  }
  const result = Object.freeze({
    schemaVersion: SUMMON_RUNTIME_SCHEMA_VERSION,
    casterId: caster,
    skillId: skill,
    corpseId: requestedCorpseId,
    corpseHex: Object.freeze(requestedHex),
    summonHex: Object.freeze(spawnHex),
    manaCost,
    summonType: requireId(summonType, "Raise Skeleton summonType"),
    encounterId: requireId(encounterId, "Raise Skeleton encounterId"),
    summonId: nextId,
    sourceMonsterCode: sourceData.sourceMonsterCode,
    statInputs,
    sourceData,
    commandId: commandId === null ? null : requireId(commandId, "Raise Skeleton commandId"),
  });
  issuedPlans.set(result, worldStamp(combat, grid, preparation));
  return result;
}

/**
 * Stage every authoritative model, then return the staged world.  Callers
 * publish all returned references together; no live object is changed before
 * every validation, corpse consumption, placement, and mana payment succeeds.
 */
export function commitRaiseSkeleton({
  combat,
  grid,
  preparation,
  plan,
  deploymentColumnOf,
  sourceMonsterCode = plan?.sourceMonsterCode ?? SOURCE_DATA_NOT_FOUND,
  hp = null,
  maxHp = hp,
  aiProfile = SUMMON_AI_PROFILE.MELEE_RANDOM,
  payAction = false,
} = {}) {
  if (!plan || plan.schemaVersion !== SUMMON_RUNTIME_SCHEMA_VERSION) throw new TypeError("A valid Raise Skeleton plan is required");
  const liveCaster = combat.party.roster.get(plan.casterId);
  if (liveCaster.lifeState !== "alive" || liveCaster.resources.hp <= 0) throw new Error("Raise Skeleton caster is defeated");
  if (preparation.phase !== "active") throw new Error("Raise Skeleton requires active combat");
  if (!preparation.getLoadout(plan.casterId) || ![preparation.getLoadout(plan.casterId).left, ...preparation.getLoadout(plan.casterId).right].includes(plan.skillId)) {
    throw new Error("Raise Skeleton plan is stale because the skill is no longer equipped");
  }
  if (combat.encounterId !== plan.encounterId) throw new Error("Raise Skeleton plan belongs to another encounter");
  if (!issuedPlans.has(plan) || issuedPlans.get(plan) !== worldStamp(combat, grid, preparation)) throw new Error("Raise Skeleton plan is stale or was not issued by validation");
  if (sourceMonsterCode !== plan.sourceMonsterCode || hp !== null || maxHp !== null) throw new Error("Unconfirmed skeleton final stats cannot override source data");
  const originalParty = combat.party;
  const stagedRoster = new Roster(originalParty.roster.toJSON());
  const stagedParty = new Party(stagedRoster, originalParty.slots);
  const stagedCombat = CombatState.restore(combat.snapshot(), {
    party: stagedParty,
    playersSetting: combat.playersSetting,
  });
  const stagedGrid = grid.constructor.restore(grid.snapshot());
  const prepSnapshot = preparation.snapshot();
  prepSnapshot.rules.summonLimits = prepSnapshot.rules.summonLimits.filter(row=>row.kind!=="skeleton");
  prepSnapshot.rules.summonLimits.push({ kind: "skeleton", limit: plan.sourceData.maxCount });
  prepSnapshot.rules.maxSummonsPerOwner = Math.max(prepSnapshot.rules.maxSummonsPerOwner, plan.sourceData.maxCount);
  prepSnapshot.rules.summonLimits.sort((a,b)=>a.kind.localeCompare(b.kind,"en"));
  const stagedPreparation = BattlePreparationState.restore(prepSnapshot, { deploymentColumnOf });
  stagedCombat.corpses.consumeCorpse(plan.corpseId, plan.summonId, RAISE_SKELETON_SKILL_ID, plan.commandId);
  stagedPreparation.summonUnit({
    id: plan.summonId,
    ownerId: plan.casterId,
    kind: plan.summonType,
    skillId: plan.skillId,
    persistent: true,
    position: plan.summonHex,
  });
  stagedGrid.addUnit({ id: plan.summonId, position: plan.summonHex });
  const summon = stagedCombat.spawnSummon({
    id: plan.summonId,
    ownerId: plan.casterId,
    sourceSkillId: plan.skillId,
    summonType: plan.summonType,
    petType: plan.summonType,
    sourceMonsterCode,
    position: plan.summonHex,
    encounterId: plan.encounterId,
    hp,
    maxHp,
    aiProfile,
    statInputs: plan.statInputs,
  });
  const caster = stagedRoster.get(plan.casterId);
  if (caster.resources.mana < plan.manaCost) throw new Error("Za mało many dla Raise Skeleton");
  caster.resources.mana = Math.round((caster.resources.mana - plan.manaCost) * 256) / 256;
  // Resolve and pay the cast on the staged graph, before any live references
  // are published. Never restore an in-flight, half-registered command.
  if (payAction) stagedCombat.submitAction(plan.casterId, "cast", {
    skillId: plan.skillId, corpseId: plan.corpseId, summonId: plan.summonId, manaCost: plan.manaCost,
  }, plan.commandId ? { transactionId: plan.commandId } : {});
  return Object.freeze({
    plan,
    summon: structuredClone(summon),
    combat: stagedCombat,
    grid: stagedGrid,
    preparation: stagedPreparation,
    party: stagedParty,
    roster: stagedRoster,
    corpse: stagedCombat.corpses.get(plan.corpseId),
  });
}

function nearestMovementPlan({ grid, summonId, enemyIds, maxMoveCost }) {
  const reachable = grid.reachable(summonId, maxMoveCost)
    .filter((row) => row.cost > 0 && row.path?.length > 1);
  if (!reachable.length) return null;
  return reachable.map((row) => ({
    ...row,
    score: Math.min(...enemyIds.map((id) => hexDistance(row.position, grid.positionOf(id)))),
  })).sort((left, right) => left.score - right.score || left.cost - right.cost || hexKey(left.position).localeCompare(hexKey(right.position)))[0];
}

/** Plan exactly one AI activation for a summon; it never mutates combat/grid. */
export function planSummonTurn({
  combat,
  grid,
  summonId,
  maxMoveCost = 3,
  rng,
  selectTarget = null,
  damageProfile = null,
} = {}) {
  const id = requireId(summonId, "Summon id");
  const summon = combat.units.get(id);
    if (!summon || summon.kind !== "summon") throw new Error(`Unknown summon: ${id}`);
  if (!aliveCombatUnit(combat, id)) return Object.freeze({ type: "wait", summonId: id, reason: "SUMMON_NOT_ALIVE" });
  const enemyIds = [...combat.units.values()]
    .filter((unit) => unit.kind === "monster" && aliveCombatUnit(combat, unit.id))
    .filter((unit) => { try { return grid.positionOf(unit.id) != null; } catch { return false; } })
    .map((unit) => unit.id)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!enemyIds.length) return Object.freeze({ type: "wait", summonId: id, reason: "NO_LIVING_ENEMY" });
  const meleeTargets = enemyIds.filter((targetId) => isMeleeContact({
    grid,
    attackerId: id,
    targetId,
    attackRange: 1,
  }));
  if (meleeTargets.length) {
    const targetId = selectDeterministically(meleeTargets, rng, selectTarget);
    return Object.freeze({
      type: "attack",
      summonId: id,
      targetId,
      range: 1,
      attackType: "melee",
      ...(damageProfile ? { damageProfile: structuredClone(damageProfile) } : {}),
      aiProfile: summon.aiProfile,
    });
  }
  const approaches = enemyIds.map((targetId) => ({
    targetId,
    plan: planApproachAttack({ grid, actorId: id, targetId, range: 1, maxMoveCost, requireLineOfSight: true }),
  })).filter(({ plan }) => plan.type === "approach");
  if (approaches.length) {
    const approachIds = approaches.map(({ targetId }) => targetId);
    const chosenTarget = selectDeterministically(approachIds, rng, selectTarget);
    const finalChoice = approaches.find(({ targetId }) => targetId === chosenTarget) ?? approaches[0];
    return Object.freeze({
      type: "approachAttack",
      summonId: id,
      targetId: finalChoice.targetId,
      path: finalChoice.plan.path,
      distance: finalChoice.plan.moveSteps,
      range: 1,
      attackType: "melee",
      ...(damageProfile ? { damageProfile: structuredClone(damageProfile) } : {}),
      aiProfile: summon.aiProfile,
    });
  }
  const movement = nearestMovementPlan({ grid, summonId: id, enemyIds, maxMoveCost });
  if (!movement) return Object.freeze({ type: "wait", summonId: id, reason: "NO_LEGAL_PATH" });
  return Object.freeze({
    type: "move",
    summonId: id,
    path: Object.freeze(movement.path.map((cell) => copyHex(cell))),
    distance: movement.path.length - 1,
    aiProfile: summon.aiProfile,
  });
}

// TODO: WARLOCK_DEMON_REPOSITION_FUTURE — no Warlock demon or reposition skill in v0.5.6.
// Demon normally uses AI. A future Warlock skill may atomically update its legal
// position in HexGrid, preparation and CombatState; its next activation returns to AI.
