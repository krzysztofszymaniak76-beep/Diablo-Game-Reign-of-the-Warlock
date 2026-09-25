import { hexDistance } from "./hex-grid.js";
import { isMeleeContact, reachableMeleeApproaches } from "./spatial-query.js";

export const CONTROL_RULESET = "ADAPTATION";
export const CONTROL_EFFECT_TYPES = Object.freeze({
  TAUNT: "TAUNT",
});
export const TAUNT_IMMUNITY_TAGS = Object.freeze(["CONTROL_IMMUNE", "TAUNT_IMMUNE"]);

function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function requireTime(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireRange(value, label) {
  if (value !== Infinity && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${label} must be non-negative or Infinity`);
  }
  return value;
}

function normalizedTags(value, label = "Tags") {
  if (value == null || typeof value[Symbol.iterator] !== "function") {
    throw new TypeError(`${label} must be iterable`);
  }
  const tags = new Set();
  for (const tag of value) tags.add(requireId(tag, "Tag"));
  return Object.freeze([...tags].sort((a, b) => a.localeCompare(b, "en")));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFrozen(value) {
  return deepFreeze(structuredClone(value));
}

function hasAnyTag(tags, blockedByTags) {
  const present = new Set(normalizedTags(tags));
  return blockedByTags.some((tag) => present.has(tag));
}

function normalizedTaunt(effect) {
  if (!effect || typeof effect !== "object") throw new TypeError("Taunt effect is required");
  if (effect.type != null && effect.type !== CONTROL_EFFECT_TYPES.TAUNT) {
    throw new TypeError("Only TAUNT control effects are supported");
  }
  if (effect.ruleset != null && effect.ruleset !== CONTROL_RULESET) {
    throw new TypeError("Control effect must use the ADAPTATION ruleset");
  }
  const id = requireId(effect.id, "Effect id");
  const sourceId = requireId(effect.sourceId, "Effect source id");
  const targetId = requireId(effect.targetId, "Effect target id");
  if (sourceId === targetId) throw new RangeError("Taunt source and target must be different units");
  const startsAt = requireTime(effect.startsAt, "Effect start time");
  const expiresAt = requireTime(effect.expiresAt, "Effect expiry time");
  if (expiresAt <= startsAt) throw new RangeError("Effect expiry must be later than its start");
  const priority = effect.priority ?? 0;
  if (!Number.isSafeInteger(priority)) throw new RangeError("Effect priority must be a safe integer");
  const blockedByTags = normalizedTags(effect.blockedByTags ?? TAUNT_IMMUNITY_TAGS, "Blocked tags");

  return deepFreeze({
    id,
    type: CONTROL_EFFECT_TYPES.TAUNT,
    ruleset: CONTROL_RULESET,
    sourceId,
    targetId,
    startsAt,
    expiresAt,
    priority,
    blockedByTags,
  });
}

function comparePrecedence(left, right) {
  // Explicit project adaptation: higher priority wins; equal-priority effects
  // prefer the most recently started effect, then lexical effect identity.
  return right.priority - left.priority
    || right.startsAt - left.startsAt
    || left.id.localeCompare(right.id, "en");
}

function positionOrNull(grid, unitId) {
  try {
    return grid.positionOf(unitId);
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown unit: ${unitId}`) return null;
    throw error;
  }
}

function requireRegistry(registry) {
  if (!(registry instanceof ControlEffectRegistry)) {
    throw new TypeError("ControlEffectRegistry is required");
  }
  return registry;
}

function requireGrid(grid) {
  const methods = ["positionOf", "reachable", "occupiedHexes", "footprintOf", "canOccupy"];
  if (!grid || methods.some((method) => typeof grid[method] !== "function")) {
    throw new TypeError("A HexGrid-compatible object is required");
  }
  return grid;
}

function requireCallback(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} callback is required`);
  return value;
}

function frozenControlDecision({ type, targetId, destination = null, path = null, reason }) {
  const copiedPath = path == null
    ? null
    : Object.freeze(path.map((position) => Object.freeze({ q: position.q, r: position.r })));
  const copiedDestination = destination == null
    ? null
    : Object.freeze({ q: destination.q, r: destination.r });
  return deepFreeze({ type, targetId, destination: copiedDestination, path: copiedPath, reason });
}

/**
 * Serializable registry for deterministic control effects.
 *
 * This is an explicit project ADAPTATION. Its duration, precedence and
 * immunity tags are not asserted to reproduce Diablo II: Resurrected values.
 */
export class ControlEffectRegistry {
  #effects = new Map();

  applyTaunt(effect, { targetTags = [] } = {}) {
    const normalized = normalizedTaunt(effect);
    if (this.#effects.has(normalized.id)) throw new Error(`Duplicate control effect: ${normalized.id}`);
    if (hasAnyTag(targetTags, normalized.blockedByTags)) {
      return deepFreeze({ applied: false, reason: "TARGET_IMMUNE", effect: null });
    }
    this.#effects.set(normalized.id, normalized);
    return deepFreeze({ applied: true, reason: "APPLIED", effect: cloneFrozen(normalized) });
  }

  remove(effectId) {
    return this.#effects.delete(requireId(effectId, "Effect id"));
  }

  removeByUnit(unitId) {
    requireId(unitId, "Unit id");
    const removed = [];
    for (const [effectId, effect] of this.#effects) {
      if (effect.sourceId !== unitId && effect.targetId !== unitId) continue;
      removed.push(cloneFrozen(effect));
      this.#effects.delete(effectId);
    }
    return Object.freeze(removed);
  }

  activeTauntsFor(targetId, simTime, { targetTags = [] } = {}) {
    requireId(targetId, "Effect target id");
    requireTime(simTime, "Simulation time");
    const tags = normalizedTags(targetTags);
    return Object.freeze([...this.#effects.values()]
      .filter((effect) => effect.targetId === targetId
        && effect.startsAt <= simTime
        && simTime < effect.expiresAt
        && !hasAnyTag(tags, effect.blockedByTags))
      .sort(comparePrecedence)
      .map(cloneFrozen));
  }

  snapshot() {
    return cloneFrozen({
      schemaVersion: 1,
      ruleset: CONTROL_RULESET,
      effects: [...this.#effects.values()]
        .sort((a, b) => a.id.localeCompare(b.id, "en"))
        .map((effect) => structuredClone(effect)),
    });
  }

  static restore(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.ruleset !== CONTROL_RULESET) {
      throw new TypeError("Control-effect snapshot schema 1 with ADAPTATION ruleset is required");
    }
    if (!Array.isArray(snapshot.effects)) throw new TypeError("Control-effect snapshot is incomplete");
    const registry = new ControlEffectRegistry();
    for (const effect of snapshot.effects) registry.applyTaunt(effect);
    return registry;
  }
}

/**
 * Resolve the highest-precedence legal Taunt into the frozen controlDecision
 * contract consumed by decideMeleePressure. This function is pure: it never
 * moves a unit or mutates the effect registry/grid.
 */
export function resolveTauntControlDecision({
  registry,
  simTime,
  grid,
  actorId,
  isAlive,
  isVisible = () => true,
  hasLineOfSight,
  tagsFor = () => [],
  canAttackFrom = () => true,
  meleeRange = 1,
  maxPursuitCost = Infinity,
} = {}) {
  requireRegistry(registry);
  requireTime(simTime, "Simulation time");
  requireGrid(grid);
  requireId(actorId, "Controlled actor id");
  requireCallback(isAlive, "isAlive");
  requireCallback(isVisible, "isVisible");
  requireCallback(hasLineOfSight, "hasLineOfSight");
  requireCallback(tagsFor, "tagsFor");
  requireCallback(canAttackFrom, "canAttackFrom");
  if (!Number.isInteger(meleeRange) || meleeRange < 0) {
    throw new RangeError("Melee range must be a non-negative integer");
  }
  requireRange(maxPursuitCost, "Maximum pursuit cost");

  if (isAlive(actorId) !== true) return null;
  const actorPosition = positionOrNull(grid, actorId);
  if (!actorPosition) return null;
  const effects = registry.activeTauntsFor(actorId, simTime, { targetTags: tagsFor(actorId) });

  for (const effect of effects) {
    if (isAlive(effect.sourceId) !== true) continue;
    const sourcePosition = positionOrNull(grid, effect.sourceId);
    if (!sourcePosition) continue;
    const visibilityContext = Object.freeze({
      effectId: effect.id,
      observerId: actorId,
      targetId: effect.sourceId,
      observerPosition: actorPosition,
      targetPosition: sourcePosition,
      distance: hexDistance(actorPosition, sourcePosition),
    });
    if (isVisible(effect.sourceId, visibilityContext) !== true) continue;
    if (hasLineOfSight(visibilityContext) !== true) continue;

    if (isMeleeContact({
      grid,
      attackerId: actorId,
      targetId: effect.sourceId,
      attackRange: meleeRange,
      canAttackFrom,
    })) {
      return frozenControlDecision({
        type: "attack",
        targetId: effect.sourceId,
        reason: "TAUNT_ATTACK_SOURCE",
      });
    }

    const approaches = reachableMeleeApproaches({
      grid,
      attackerId: actorId,
      targetId: effect.sourceId,
      attackRange: meleeRange,
      maxCost: maxPursuitCost,
      canAttackFrom,
      reachable: grid.reachable(actorId, maxPursuitCost),
    });
    const selected = approaches[0] ?? null;
    if (!selected) continue;
    return frozenControlDecision({
      type: "move",
      targetId: effect.sourceId,
      destination: selected.position,
      path: selected.path,
      reason: "TAUNT_MOVE_TOWARD_SOURCE",
    });
  }

  return null;
}
