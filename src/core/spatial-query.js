import { axial, hexDistance, hexKey } from "./hex-grid.js";

function requireGrid(grid) {
  const required = ["tiles", "positionOf", "footprintOf", "occupiedHexes", "canOccupy", "reachable"];
  if (!grid || required.some((method) => typeof grid[method] !== "function")) {
    throw new TypeError("Spatial queries require a HexGrid-compatible object");
  }
  return grid;
}

function requireUnitId(value, label = "Unit id") {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function requireCallback(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} callback is required`);
  return value;
}

function requireRange(value, label) {
  if (value !== Infinity && (!Number.isInteger(value) || value < 0)) {
    throw new RangeError(`${label} must be a non-negative integer or Infinity`);
  }
  return value;
}

function copyHex(position) {
  return axial(position.q, position.r);
}

function compareIds(a, b) {
  return a.localeCompare(b, "en");
}

function compareHexes(a, b) {
  return a.q - b.q || a.r - b.r;
}

function freezePath(path) {
  return Object.freeze(path.map(copyHex));
}

function uniqueSortedIds(ids, observerId) {
  if (!ids || typeof ids[Symbol.iterator] !== "function") {
    throw new TypeError("hostileIds must be iterable");
  }
  const result = new Set();
  for (const rawId of ids) {
    const id = requireUnitId(rawId, "Hostile id");
    if (id !== observerId) result.add(id);
  }
  return [...result].sort(compareIds);
}

function positionOrNull(grid, unitId) {
  try {
    return grid.positionOf(unitId);
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown unit: ${unitId}`) return null;
    throw error;
  }
}

function occupiedAtAnchor(anchor, footprint) {
  return footprint.map((offset) => axial(anchor.q + offset.q, anchor.r + offset.r));
}

function minimumDistance(left, right) {
  let result = Infinity;
  for (const a of left) {
    for (const b of right) result = Math.min(result, hexDistance(a, b));
  }
  return result;
}

/**
 * Pure perception query. The caller owns the line-of-sight model; there is no
 * omniscient default. Only ids, positions and topological distance are exposed
 * to that callback, so target HP, class and equipment cannot affect selection.
 */
export function perceiveHostiles({
  grid,
  observerId,
  hostileIds,
  isAlive,
  hasLineOfSight,
  maxDistance,
} = {}) {
  requireGrid(grid);
  requireUnitId(observerId, "Observer id");
  requireCallback(isAlive, "isAlive");
  requireCallback(hasLineOfSight, "hasLineOfSight");
  requireRange(maxDistance, "Perception distance");

  const observerPosition = positionOrNull(grid, observerId);
  if (!observerPosition) throw new Error(`Unknown observer: ${observerId}`);

  const detected = [];
  const rejected = [];
  for (const targetId of uniqueSortedIds(hostileIds, observerId)) {
    if (isAlive(targetId) !== true) {
      rejected.push(Object.freeze({ targetId, reason: "DEAD" }));
      continue;
    }

    const targetPosition = positionOrNull(grid, targetId);
    if (!targetPosition) {
      rejected.push(Object.freeze({ targetId, reason: "NOT_ON_GRID" }));
      continue;
    }

    const distance = hexDistance(observerPosition, targetPosition);
    if (distance > maxDistance) {
      rejected.push(Object.freeze({ targetId, reason: "OUT_OF_PERCEPTION" }));
      continue;
    }

    const visible = hasLineOfSight(Object.freeze({
      observerId,
      targetId,
      observerPosition: copyHex(observerPosition),
      targetPosition: copyHex(targetPosition),
      distance,
    }));
    if (visible !== true) {
      rejected.push(Object.freeze({ targetId, reason: "NO_LINE_OF_SIGHT" }));
      continue;
    }

    detected.push(Object.freeze({
      targetId,
      position: copyHex(targetPosition),
      distance,
    }));
  }

  return Object.freeze({
    observerId,
    observerPosition: copyHex(observerPosition),
    detected: Object.freeze(detected),
    rejected: Object.freeze(rejected),
  });
}

/** Return whether two footprints are in legal melee contact. */
export function isMeleeContact({
  grid,
  attackerId,
  targetId,
  attackRange = 1,
  canAttackFrom = () => true,
} = {}) {
  requireGrid(grid);
  requireUnitId(attackerId, "Attacker id");
  requireUnitId(targetId, "Target id");
  requireRange(attackRange, "Melee range");
  requireCallback(canAttackFrom, "canAttackFrom");

  const attackerPosition = positionOrNull(grid, attackerId);
  const targetPosition = positionOrNull(grid, targetId);
  if (!attackerPosition || !targetPosition) return false;
  const distance = minimumDistance(grid.occupiedHexes(attackerId), grid.occupiedHexes(targetId));
  if (distance > attackRange) return false;

  return canAttackFrom(Object.freeze({
    attackerId,
    targetId,
    attackerPosition: copyHex(attackerPosition),
    targetPosition: copyHex(targetPosition),
    distance,
  })) === true;
}

/**
 * Enumerate legal positions from which the attacker could make a melee attack.
 * Costs and paths come directly from HexGrid.reachable, so terrain weights,
 * footprints and occupied cells are identical to ordinary pathfinding.
 */
export function reachableMeleeApproaches({
  grid,
  attackerId,
  targetId,
  attackRange = 1,
  maxCost = Infinity,
  canAttackFrom = () => true,
  reachable = null,
} = {}) {
  requireGrid(grid);
  requireUnitId(attackerId, "Attacker id");
  requireUnitId(targetId, "Target id");
  requireRange(attackRange, "Melee range");
  if (maxCost !== Infinity && (!Number.isFinite(maxCost) || maxCost < 0)) {
    throw new RangeError("Maximum approach cost must be non-negative or Infinity");
  }
  requireCallback(canAttackFrom, "canAttackFrom");

  const attackerPosition = positionOrNull(grid, attackerId);
  const targetPosition = positionOrNull(grid, targetId);
  if (!attackerPosition || !targetPosition) return Object.freeze([]);

  const attackerFootprint = grid.footprintOf(attackerId);
  const targetFootprint = grid.occupiedHexes(targetId);
  const reachableRows = reachable ?? grid.reachable(attackerId, maxCost);
  if (!Array.isArray(reachableRows)) throw new TypeError("reachable must be an array returned by HexGrid.reachable");

  const approaches = [];
  for (const row of reachableRows) {
    if (!row || !row.position || !Array.isArray(row.path) || !Number.isFinite(row.cost)) {
      throw new TypeError("Malformed reachable row");
    }
    if (row.cost > maxCost) continue;
    const anchor = row.position;
    if (!grid.canOccupy(anchor, { footprint: attackerFootprint, ignoreUnitId: attackerId })) continue;
    const distance = minimumDistance(occupiedAtAnchor(anchor, attackerFootprint), targetFootprint);
    if (distance > attackRange) continue;
    if (canAttackFrom(Object.freeze({
      attackerId,
      targetId,
      attackerPosition: copyHex(anchor),
      targetPosition: copyHex(targetPosition),
      distance,
    })) !== true) continue;

    approaches.push(Object.freeze({
      position: copyHex(anchor),
      cost: row.cost,
      path: freezePath(row.path),
      distance,
    }));
  }

  approaches.sort((a, b) =>
    a.cost - b.cost
    || a.path.length - b.path.length
    || compareHexes(a.position, b.position));
  return Object.freeze(approaches);
}

/** Find a rejection reason produced by perceiveHostiles without leaking state. */
export function perceptionRejection(perception, targetId) {
  requireUnitId(targetId, "Target id");
  return perception?.rejected?.find((entry) => entry.targetId === targetId)?.reason ?? null;
}

export function pathHexKeys(path) {
  if (!Array.isArray(path)) throw new TypeError("Path must be an array");
  return Object.freeze(path.map(hexKey));
}
