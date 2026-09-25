import { axial, hexDistance, hexKey } from './hex-grid.js';

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function addHex(a, b) {
  return axial(a.q + b.q, a.r + b.r);
}

function footprintAt(grid, unitId, anchor) {
  return grid.footprintOf(unitId).map((offset) => addHex(anchor, offset));
}

function footprintDistanceAt(grid, actorId, actorAnchor, targetId) {
  const actorCells = footprintAt(grid, actorId, actorAnchor);
  const targetCells = grid.occupiedHexes(targetId);
  return Math.min(...actorCells.flatMap((left) => targetCells.map((right) => hexDistance(left, right))));
}

function lineOfSightAt(grid, actorId, actorAnchor, targetId) {
  const targetAnchor = grid.positionOf(targetId);
  return grid.hasLineOfSight(actorAnchor, targetAnchor, { ignoreUnitIds: [actorId, targetId] });
}

/**
 * Deterministically choose the cheapest legal position from which actorId can
 * attack targetId. This never mutates the grid. maxMoveCost deliberately uses
 * the same reachability budget as the existing manual movement UI.
 */
export function planApproachAttack({
  grid,
  actorId,
  targetId,
  range = 1,
  maxMoveCost = 3,
  requireLineOfSight = true,
} = {}) {
  if (!grid || typeof grid.positionOf !== 'function') throw new TypeError('grid is required');
  if (typeof actorId !== 'string' || !actorId) throw new TypeError('actorId is required');
  if (typeof targetId !== 'string' || !targetId) throw new TypeError('targetId is required');
  positiveInteger(range, 'range');
  if (!Number.isFinite(maxMoveCost) || maxMoveCost < 0) throw new RangeError('maxMoveCost must be a non-negative finite number');

  const actorStart = grid.positionOf(actorId);
  const targetAnchor = grid.positionOf(targetId);
  const startDistance = footprintDistanceAt(grid, actorId, actorStart, targetId);
  const startHasLos = !requireLineOfSight || lineOfSightAt(grid, actorId, actorStart, targetId);
  if (startDistance <= range && startHasLos) {
    return Object.freeze({
      type: 'in-range',
      path: Object.freeze([actorStart]),
      moveCost: 0,
      moveSteps: 0,
      actorStart,
      attackAnchor: actorStart,
      targetAnchor,
      worldVersion: grid.worldVersion(),
    });
  }

  const candidates = grid.reachable(actorId, maxMoveCost)
    .filter(({ cost, path }) => cost > 0 && Array.isArray(path) && path.length > 1)
    .filter(({ position }) => footprintDistanceAt(grid, actorId, position, targetId) <= range)
    .filter(({ position }) => !requireLineOfSight || lineOfSightAt(grid, actorId, position, targetId))
    .map((choice) => ({ ...choice, moveSteps: choice.path.length - 1 }))
    .sort((left, right) =>
      left.cost - right.cost
      || left.moveSteps - right.moveSteps
      || hexKey(left.position).localeCompare(hexKey(right.position)));

  const best = candidates[0];
  if (!best) {
    return Object.freeze({
      type: 'unreachable',
      path: null,
      moveCost: null,
      moveSteps: null,
      actorStart,
      attackAnchor: null,
      targetAnchor,
      worldVersion: grid.worldVersion(),
    });
  }

  return Object.freeze({
    type: 'approach',
    path: Object.freeze(best.path.map((cell) => axial(cell.q, cell.r))),
    moveCost: best.cost,
    moveSteps: best.moveSteps,
    actorStart,
    attackAnchor: axial(best.position.q, best.position.r),
    targetAnchor,
    worldVersion: grid.worldVersion(),
  });
}
