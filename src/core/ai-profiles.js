import {
  isMeleeContact,
  perceiveHostiles,
  perceptionRejection,
  reachableMeleeApproaches,
} from "./spatial-query.js";

export const AI_PROFILE_IDS = Object.freeze({
  MELEE_PRESSURE: "MELEE_PRESSURE",
});

/**
 * Explicit adaptation profile. These are project rules, not a claim about the
 * original Diablo II monster-AI implementation.
 */
export const MELEE_PRESSURE = Object.freeze({
  id: AI_PROFILE_IDS.MELEE_PRESSURE,
  ruleset: "ADAPTATION",
  perceptionRange: 8,
  meleeRange: 1,
  maxPursuitCost: Infinity,
  targetSwitchCostMargin: 1,
});

function requireProfile(profile) {
  if (!profile || profile.id !== AI_PROFILE_IDS.MELEE_PRESSURE) {
    throw new TypeError("MELEE_PRESSURE profile is required");
  }
  for (const [key, value] of [
    ["perceptionRange", profile.perceptionRange],
    ["meleeRange", profile.meleeRange],
    ["targetSwitchCostMargin", profile.targetSwitchCostMargin],
  ]) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${key} must be a non-negative integer`);
  }
  if (profile.maxPursuitCost !== Infinity
    && (!Number.isFinite(profile.maxPursuitCost) || profile.maxPursuitCost < 0)) {
    throw new RangeError("maxPursuitCost must be non-negative or Infinity");
  }
  return profile;
}

function requireOptionalId(value, label) {
  if (value != null && (typeof value !== "string" || !value.trim())) {
    throw new TypeError(`${label} must be null or a non-empty string`);
  }
  return value;
}

function freezeCandidate(candidate) {
  return Object.freeze({
    targetId: candidate.targetId,
    status: candidate.status,
    inMelee: candidate.inMelee,
    pathCost: candidate.pathCost,
    attackPosition: candidate.attackPosition,
    path: candidate.path,
  });
}

function decisionResult({ type, actorId, targetId = null, destination = null, path = null, reason, diagnostics }) {
  return Object.freeze({
    profileId: AI_PROFILE_IDS.MELEE_PRESSURE,
    type,
    actorId,
    targetId,
    destination,
    path,
    reason,
    diagnostics: Object.freeze(diagnostics),
  });
}

function currentTargetLossReason(currentTargetId, perception, detectedIds) {
  if (currentTargetId == null) return "NO_CURRENT_TARGET";
  if (detectedIds.has(currentTargetId)) return null;
  const rejection = perceptionRejection(perception, currentTargetId);
  if (rejection === "DEAD") return "CURRENT_TARGET_DEAD";
  if (rejection === "NO_LINE_OF_SIGHT") return "CURRENT_TARGET_NOT_VISIBLE";
  if (rejection === "OUT_OF_PERCEPTION") return "CURRENT_TARGET_OUT_OF_PERCEPTION";
  if (rejection === "NOT_ON_GRID") return "CURRENT_TARGET_NOT_ON_GRID";
  return "CURRENT_TARGET_NOT_HOSTILE";
}

function baseDiagnostics({ currentTargetId, perception, candidates, retainedCurrentTarget, targetChangeReason }) {
  return {
    currentTargetId,
    detectedTargetIds: Object.freeze(perception.detected.map((entry) => entry.targetId)),
    perceptionRejected: perception.rejected,
    candidates: Object.freeze(candidates.map(freezeCandidate)),
    retainedCurrentTarget,
    targetChangeReason,
  };
}

function cheapestCandidate(candidates) {
  return [...candidates].sort((a, b) =>
    a.pathCost - b.pathCost
    || a.path.length - b.path.length
    || a.targetId.localeCompare(b.targetId, "en"))[0];
}

/**
 * Decide one MELEE_PRESSURE command without mutating combat or grid state.
 *
 * hostileIds intentionally contains only ids. Liveness and LOS are supplied as
 * narrow callbacks; no target HP, class, defence, equipment or build enters the
 * scoring model. Effects such as Taunt/Fear are expected to be resolved before
 * this ordinary-profile decision, or supplied as a prevalidated controlDecision.
 */
export function decideMeleePressure({
  grid,
  actorId,
  hostileIds,
  currentTargetId = null,
  isAlive,
  hasLineOfSight,
  canAttackFrom = () => true,
  profile = MELEE_PRESSURE,
  controlDecision = null,
} = {}) {
  requireProfile(profile);
  if (typeof actorId !== "string" || !actorId.trim()) throw new TypeError("Actor id is required");
  requireOptionalId(currentTargetId, "Current target id");
  if (controlDecision != null) {
    if (!Object.isFrozen(controlDecision)) {
      throw new TypeError("controlDecision must be prevalidated and frozen");
    }
    return decisionResult({
      ...controlDecision,
      actorId,
      reason: controlDecision.reason ?? "EFFECTIVE_CONTROL",
      diagnostics: {
        currentTargetId,
        detectedTargetIds: Object.freeze([]),
        perceptionRejected: Object.freeze([]),
        candidates: Object.freeze([]),
        retainedCurrentTarget: false,
        targetChangeReason: "CONTROL_OVERRIDE",
      },
    });
  }

  const perception = perceiveHostiles({
    grid,
    observerId: actorId,
    hostileIds,
    isAlive,
    hasLineOfSight,
    maxDistance: profile.perceptionRange,
  });
  const detectedIds = new Set(perception.detected.map((entry) => entry.targetId));
  const lossReason = currentTargetLossReason(currentTargetId, perception, detectedIds);

  const meleeCandidates = perception.detected
    .filter(({ targetId }) => isMeleeContact({
      grid,
      attackerId: actorId,
      targetId,
      attackRange: profile.meleeRange,
      canAttackFrom,
    }))
    .map(({ targetId }) => ({
      targetId,
      status: "ATTACK_NOW",
      inMelee: true,
      pathCost: 0,
      attackPosition: grid.positionOf(actorId),
      path: Object.freeze([grid.positionOf(actorId)]),
    }));

  const currentMelee = meleeCandidates.find(({ targetId }) => targetId === currentTargetId);
  if (currentMelee) {
    const diagnostics = baseDiagnostics({
      currentTargetId,
      perception,
      candidates: meleeCandidates,
      retainedCurrentTarget: true,
      targetChangeReason: null,
    });
    return decisionResult({
      type: "attack",
      actorId,
      targetId: currentMelee.targetId,
      reason: "CONTINUE_CURRENT_MELEE_TARGET",
      diagnostics,
    });
  }

  if (meleeCandidates.length > 0) {
    meleeCandidates.sort((a, b) => a.targetId.localeCompare(b.targetId, "en"));
    const selected = meleeCandidates[0];
    const diagnostics = baseDiagnostics({
      currentTargetId,
      perception,
      candidates: meleeCandidates,
      retainedCurrentTarget: false,
      targetChangeReason: lossReason ?? "LEGAL_MELEE_TARGET_AVAILABLE",
    });
    return decisionResult({
      type: "attack",
      actorId,
      targetId: selected.targetId,
      reason: "ATTACK_LEGAL_MELEE_TARGET",
      diagnostics,
    });
  }

  // This single reachability query is shared by every target comparison. Its
  // costs are authoritative HexGrid movement costs, not straight-line distance.
  const reachable = grid.reachable(actorId, profile.maxPursuitCost);
  const movementCandidates = perception.detected.map(({ targetId }) => {
    const approaches = reachableMeleeApproaches({
      grid,
      attackerId: actorId,
      targetId,
      attackRange: profile.meleeRange,
      maxCost: profile.maxPursuitCost,
      canAttackFrom,
      reachable,
    });
    const best = approaches[0] ?? null;
    return {
      targetId,
      status: best ? "REACHABLE" : "NO_LEGAL_APPROACH",
      inMelee: false,
      pathCost: best?.cost ?? Infinity,
      attackPosition: best?.position ?? null,
      path: best?.path ?? null,
    };
  });
  const reachableCandidates = movementCandidates.filter(({ status }) => status === "REACHABLE");

  if (reachableCandidates.length === 0) {
    const reason = perception.detected.length === 0 ? "NO_DETECTED_TARGET" : "NO_REACHABLE_ATTACK_POSITION";
    const diagnostics = baseDiagnostics({
      currentTargetId,
      perception,
      candidates: movementCandidates,
      retainedCurrentTarget: false,
      targetChangeReason: lossReason ?? reason,
    });
    return decisionResult({ type: "hold", actorId, reason, diagnostics });
  }

  const cheapest = cheapestCandidate(reachableCandidates);
  const currentCandidate = reachableCandidates.find(({ targetId }) => targetId === currentTargetId);
  const keepCurrent = currentCandidate != null
    && currentCandidate.pathCost <= cheapest.pathCost + profile.targetSwitchCostMargin;
  const selected = keepCurrent ? currentCandidate : cheapest;
  const targetChangeReason = keepCurrent
    ? null
    : (lossReason ?? (currentTargetId == null ? "ACQUIRE_REACHABLE_TARGET" : "LOWER_REAL_PATH_COST"));
  const diagnostics = baseDiagnostics({
    currentTargetId,
    perception,
    candidates: movementCandidates,
    retainedCurrentTarget: keepCurrent,
    targetChangeReason,
  });

  return decisionResult({
    type: "move",
    actorId,
    targetId: selected.targetId,
    destination: selected.attackPosition,
    path: selected.path,
    reason: keepCurrent ? "CONTINUE_CURRENT_PURSUIT" : "MOVE_TO_LOWEST_COST_ATTACK_POSITION",
    diagnostics,
  });
}
