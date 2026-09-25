const ORIGIN = Object.freeze({ q: 0, r: 0 });

export const HEX_DIRECTIONS = Object.freeze([
  Object.freeze({ q: 1, r: 0 }),
  Object.freeze({ q: 1, r: -1 }),
  Object.freeze({ q: 0, r: -1 }),
  Object.freeze({ q: -1, r: 0 }),
  Object.freeze({ q: -1, r: 1 }),
  Object.freeze({ q: 0, r: 1 }),
]);

export const SINGLE_HEX_FOOTPRINT = Object.freeze([ORIGIN]);

function requireHex(value, label = "Hex") {
  if (!value || !Number.isInteger(value.q) || !Number.isInteger(value.r)) {
    throw new TypeError(`${label} must be an axial { q, r } position`);
  }
  return value;
}

function requireBudget(value, label) {
  if ((value !== Infinity && !Number.isFinite(value)) || value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

function compareHexes(a, b) {
  return a.q - b.q || a.r - b.r;
}

function addHexes(a, b) {
  return axial(a.q + b.q, a.r + b.r);
}

function cubeRound(q, r, s) {
  let roundedQ = Math.round(q);
  let roundedR = Math.round(r);
  let roundedS = Math.round(s);
  const qDelta = Math.abs(roundedQ - q);
  const rDelta = Math.abs(roundedR - r);
  const sDelta = Math.abs(roundedS - s);
  if (qDelta > rDelta && qDelta > sDelta) roundedQ = -roundedR - roundedS;
  else if (rDelta > sDelta) roundedR = -roundedQ - roundedS;
  else roundedS = -roundedQ - roundedR;
  return axial(roundedQ, roundedR);
}

function normalizeFootprint(footprint) {
  const source = Number.isInteger(footprint) ? hexDisk(ORIGIN, footprint) : footprint;
  if (!source || typeof source[Symbol.iterator] !== "function") {
    throw new TypeError("Footprint must be an iterable of axial offsets or a radius");
  }

  const offsets = [];
  const seen = new Set();
  for (const rawOffset of source) {
    const offset = requireHex(rawOffset, "Footprint offset");
    const id = hexKey(offset);
    if (seen.has(id)) throw new Error(`Duplicate footprint offset: ${id}`);
    seen.add(id);
    offsets.push(axial(offset.q, offset.r));
  }

  if (!seen.has(hexKey(ORIGIN))) {
    throw new Error("Footprint must contain the anchor offset 0,0");
  }

  offsets.sort((a, b) => hexDistance(ORIGIN, a) - hexDistance(ORIGIN, b) || compareHexes(a, b));
  return Object.freeze(offsets);
}

function asTileKey(value, label) {
  if (typeof value === "string") return value;
  return hexKey(requireHex(value, label));
}

function entriesOf(value, label) {
  if (value == null) return [];
  if (value instanceof Map || Array.isArray(value) || typeof value[Symbol.iterator] === "function") return value;
  if (typeof value === "object") return Object.entries(value);
  throw new TypeError(`${label} must be a Map, entry iterable, or keyed object`);
}

export function axial(q, r) {
  if (!Number.isInteger(q) || !Number.isInteger(r)) {
    throw new TypeError("Axial coordinates q and r must be integers");
  }
  return Object.freeze({ q, r });
}

// Converts the row-offset coordinates used by the battlefield reference into
// canonical axial coordinates. Keeping this conversion in the grid layer lets
// rendering, hit-testing and deployment rules describe the same physical tile.
export function oddRowOffsetToAxial(column, row) {
  if (!Number.isInteger(column) || !Number.isInteger(row)) {
    throw new TypeError("Odd-row offset column and row must be integers");
  }
  return axial(column - Math.floor(row / 2), row);
}

export function axialToOddRowColumn(position) {
  const normalized = requireHex(position, "Odd-row axial position");
  return normalized.q + Math.floor(normalized.r / 2);
}

export function hexKey(position) {
  const { q, r } = requireHex(position);
  return `${q},${r}`;
}

export function hexNeighbors(position) {
  const center = requireHex(position);
  return HEX_DIRECTIONS.map((direction) => addHexes(center, direction));
}

export function hexDistance(a, b) {
  const from = requireHex(a, "First hex");
  const to = requireHex(b, "Second hex");
  const dq = from.q - to.q;
  const dr = from.r - to.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

export function hexDisk(center, radius = 0) {
  const anchor = requireHex(center, "Disk center");
  if (!Number.isInteger(radius) || radius < 0) throw new RangeError("Hex radius must be a non-negative integer");

  const cells = [];
  for (let dq = -radius; dq <= radius; dq += 1) {
    const firstR = Math.max(-radius, -dq - radius);
    const lastR = Math.min(radius, -dq + radius);
    for (let dr = firstR; dr <= lastR; dr += 1) cells.push(axial(anchor.q + dq, anchor.r + dr));
  }
  cells.sort((a, b) => hexDistance(anchor, a) - hexDistance(anchor, b) || compareHexes(a, b));
  return cells;
}

export function hexLine(from, to) {
  const start = requireHex(from, "Line origin");
  const end = requireHex(to, "Line destination");
  const distance = hexDistance(start, end);
  if (distance === 0) return [axial(start.q, start.r)];
  const startS = -start.q - start.r;
  const endS = -end.q - end.r;
  return Array.from({ length: distance + 1 }, (_, index) => {
    const amount = index / distance;
    return cubeRound(
      start.q + (end.q - start.q) * amount,
      start.r + (end.r - start.r) * amount,
      startS + (endS - startS) * amount,
    );
  });
}

export class HexGrid {
  #tiles = new Map();
  #blockedTerrain = new Set();
  #lineOfSightBlockers = new Set();
  #projectileBlockers = new Set();
  #movementCosts = new Map();
  #minimumMovementCost = 1;
  #units = new Map();
  #occupancy = new Map();
  #worldVersion = 0;
  #reservations = new Map();
  #reservationCells = new Map();

  constructor({
    tiles,
    blockedTerrain = [],
    lineOfSightBlockers = null,
    projectileBlockers = null,
    movementCosts = new Map(),
  } = {}) {
    if (!tiles || typeof tiles[Symbol.iterator] !== "function") {
      throw new TypeError("HexGrid requires an iterable of axial tiles");
    }

    for (const rawTile of tiles) {
      const tile = requireHex(rawTile, "Grid tile");
      this.#tiles.set(hexKey(tile), axial(tile.q, tile.r));
    }
    if (this.#tiles.size === 0) throw new RangeError("HexGrid requires at least one tile");

    for (const rawTile of blockedTerrain) {
      const id = asTileKey(rawTile, "Blocked terrain tile");
      if (!this.#tiles.has(id)) throw new RangeError(`Blocked terrain is outside the grid: ${id}`);
      this.#blockedTerrain.add(id);
    }

    for (const [rawTile, blockers, label] of [
      [lineOfSightBlockers ?? this.#blockedTerrain, this.#lineOfSightBlockers, "Line-of-sight blocker"],
      [projectileBlockers ?? this.#blockedTerrain, this.#projectileBlockers, "Projectile blocker"],
    ]) {
      if (!rawTile || typeof rawTile[Symbol.iterator] !== "function") throw new TypeError(`${label}s must be iterable`);
      for (const rawBlocker of rawTile) {
        const id = asTileKey(rawBlocker, label);
        if (!this.#tiles.has(id)) throw new RangeError(`${label} is outside the grid: ${id}`);
        blockers.add(id);
      }
    }

    for (const [rawTile, cost] of entriesOf(movementCosts, "Movement costs")) {
      const id = asTileKey(rawTile, "Movement-cost tile");
      if (!this.#tiles.has(id)) throw new RangeError(`Movement cost is outside the grid: ${id}`);
      if (!Number.isFinite(cost) || cost <= 0) throw new RangeError(`Movement cost for ${id} must be positive`);
      this.#movementCosts.set(id, cost);
      this.#minimumMovementCost = Math.min(this.#minimumMovementCost, cost);
    }
  }

  has(position) {
    return this.#tiles.has(hexKey(position));
  }

  tiles() {
    return [...this.#tiles.values()];
  }

  isTerrainBlocked(position) {
    const id = hexKey(position);
    return !this.#tiles.has(id) || this.#blockedTerrain.has(id);
  }

  blocksLineOfSight(position) {
    return this.#lineOfSightBlockers.has(hexKey(position));
  }

  blocksProjectile(position) {
    return this.#projectileBlockers.has(hexKey(position));
  }

  hasLineOfSight(from, to, { blockUnits = false, ignoreUnitIds = [] } = {}) {
    return this.#hasClearLine(from, to, this.#lineOfSightBlockers, { blockUnits, ignoreUnitIds });
  }

  hasProjectilePath(from, to, {
    blockTerrain = true,
    blockUnits = true,
    ignoreUnitIds = [],
    includeDestination = false,
    unitBlocks = null,
  } = {}) {
    if (unitBlocks !== null && typeof unitBlocks !== "function") {
      throw new TypeError("unitBlocks must be a function or null");
    }
    return this.#hasClearLine(from, to, blockTerrain ? this.#projectileBlockers : new Set(), {
      blockUnits,
      ignoreUnitIds,
      includeDestination,
      unitBlocks,
    });
  }

  projectileStepIsClear(from, to, options = {}) {
    const origin = requireHex(from, "Projectile step origin");
    const destination = requireHex(to, "Projectile step destination");
    if (hexDistance(origin, destination) !== 1) {
      throw new RangeError("A projectile step must connect adjacent hexes");
    }
    return this.hasProjectilePath(origin, destination, { ...options, includeDestination: true });
  }

  occupantAt(position) {
    return this.#occupancy.get(hexKey(position)) ?? null;
  }

  isBlocked(position, { ignoreUnitId = null } = {}) {
    const id = hexKey(position);
    if (!this.#tiles.has(id) || this.#blockedTerrain.has(id)) return true;
    const occupantId = this.#occupancy.get(id);
    return occupantId != null && occupantId !== ignoreUnitId;
  }

  canOccupy(position, { footprint = SINGLE_HEX_FOOTPRINT, ignoreUnitId = null } = {}) {
    const anchor = requireHex(position, "Unit position");
    const offsets = normalizeFootprint(footprint);
    return this.#canOccupyWithOffsets(anchor, offsets, ignoreUnitId);
  }

  addUnit({ id, position, footprint = SINGLE_HEX_FOOTPRINT } = {}) {
    if (typeof id !== "string" || !id.trim()) throw new TypeError("Unit id is required");
    if (this.#units.has(id)) throw new Error(`Duplicate unit: ${id}`);

    const anchor = requireHex(position, "Unit position");
    const normalizedFootprint = normalizeFootprint(footprint);
    if (!this.#canOccupyWithOffsets(anchor, normalizedFootprint)) {
      throw new Error(`Unit ${id} cannot occupy ${hexKey(anchor)}`);
    }
    this.#assertWorldVersionCanAdvance();

    const unit = Object.freeze({
      id,
      position: axial(anchor.q, anchor.r),
      footprint: normalizedFootprint,
    });
    this.#units.set(id, unit);
    this.#writeOccupancy(unit);
    this.#incrementWorldVersion();
    return unit;
  }

  removeUnit(unitId) {
    const unit = this.#units.get(unitId);
    if (!unit) return false;
    this.#assertWorldVersionCanAdvance();
    this.#clearOccupancy(unit);
    this.#units.delete(unitId);
    for (const reservation of [...this.#reservations.values()]) {
      if (reservation.unitId === unitId) this.#releaseReservation(reservation.eventId);
    }
    this.#incrementWorldVersion();
    return true;
  }

  positionOf(unitId) {
    return this.#requireUnit(unitId).position;
  }

  footprintOf(unitId) {
    return this.#requireUnit(unitId).footprint;
  }

  occupiedHexes(unitId) {
    const unit = this.#requireUnit(unitId);
    return unit.footprint.map((offset) => addHexes(unit.position, offset));
  }

  findPath(unitId, exactGoal, { maxCost = Infinity } = {}) {
    requireBudget(maxCost, "Maximum path cost");
    const unit = this.#requireUnit(unitId);
    const goal = requireHex(exactGoal, "Path goal");
    const start = unit.position;
    const startId = hexKey(start);
    const goalId = hexKey(goal);

    if (startId === goalId) return [start];
    if (!this.#canOccupyWithOffsets(goal, unit.footprint, unitId)) return null;

    let sequence = 0;
    const frontier = [{
      position: start,
      cost: 0,
      heuristic: hexDistance(start, goal) * this.#minimumMovementCost,
      sequence: sequence++,
    }];
    const bestCost = new Map([[startId, 0]]);
    const cameFrom = new Map();

    while (frontier.length > 0) {
      frontier.sort((a, b) =>
        (a.cost + a.heuristic) - (b.cost + b.heuristic)
        || a.heuristic - b.heuristic
        || a.sequence - b.sequence);
      const current = frontier.shift();
      const currentId = hexKey(current.position);
      if (current.cost !== bestCost.get(currentId)) continue;
      if (currentId === goalId) return this.#reconstructPath(cameFrom, goalId);

      for (const neighbor of hexNeighbors(current.position)) {
        const neighborId = hexKey(neighbor);
        if (!this.#canOccupyWithOffsets(neighbor, unit.footprint, unitId)) continue;
        const nextCost = current.cost + this.#placementCost(neighbor, unit.footprint);
        if (nextCost > maxCost || nextCost >= (bestCost.get(neighborId) ?? Infinity)) continue;
        bestCost.set(neighborId, nextCost);
        cameFrom.set(neighborId, currentId);
        frontier.push({
          position: this.#tiles.get(neighborId),
          cost: nextCost,
          heuristic: hexDistance(neighbor, goal) * this.#minimumMovementCost,
          sequence: sequence++,
        });
      }
    }
    return null;
  }

  reachable(unitId, cost) {
    requireBudget(cost, "Reachable cost");
    const unit = this.#requireUnit(unitId);
    const start = unit.position;
    const startId = hexKey(start);
    let sequence = 0;
    const frontier = [{ position: start, cost: 0, sequence: sequence++ }];
    const discoveryOrder = new Map([[startId, 0]]);
    const bestCost = new Map([[startId, 0]]);
    const cameFrom = new Map();

    while (frontier.length > 0) {
      frontier.sort((a, b) => a.cost - b.cost || a.sequence - b.sequence);
      const current = frontier.shift();
      const currentId = hexKey(current.position);
      if (current.cost !== bestCost.get(currentId)) continue;

      for (const neighbor of hexNeighbors(current.position)) {
        const neighborId = hexKey(neighbor);
        if (!this.#canOccupyWithOffsets(neighbor, unit.footprint, unitId)) continue;
        const nextCost = current.cost + this.#placementCost(neighbor, unit.footprint);
        if (nextCost > cost || nextCost >= (bestCost.get(neighborId) ?? Infinity)) continue;
        if (!discoveryOrder.has(neighborId)) discoveryOrder.set(neighborId, sequence);
        bestCost.set(neighborId, nextCost);
        cameFrom.set(neighborId, currentId);
        frontier.push({ position: this.#tiles.get(neighborId), cost: nextCost, sequence: sequence++ });
      }
    }

    return [...bestCost.entries()]
      .map(([id, totalCost]) => ({
        position: this.#tiles.get(id),
        cost: totalCost,
        path: this.#reconstructPath(cameFrom, id),
      }))
      .sort((a, b) => a.cost - b.cost || discoveryOrder.get(hexKey(a.position)) - discoveryOrder.get(hexKey(b.position)));
  }

  moveUnit(unitId, exactGoal, { maxCost = Infinity } = {}) {
    const path = this.findPath(unitId, exactGoal, { maxCost });
    if (path == null) return null;

    const previous = this.#requireUnit(unitId);
    const destination = path.at(-1);
    this.#assertWorldVersionCanAdvance();
    this.#clearOccupancy(previous);
    const moved = Object.freeze({
      id: previous.id,
      position: axial(destination.q, destination.r),
      footprint: previous.footprint,
    });
    this.#units.set(unitId, moved);
    this.#writeOccupancy(moved);
    this.#incrementWorldVersion();
    return path;
  }

  moveUnitStep(unitId, exactNeighbor, { expectedFrom = null } = {}) {
    const previous = this.#requireUnit(unitId);
    const destination = requireHex(exactNeighbor, "Step destination");
    if (expectedFrom && hexKey(requireHex(expectedFrom, "Expected step origin")) !== hexKey(previous.position)) {
      return null;
    }
    if (hexDistance(previous.position, destination) !== 1) {
      throw new RangeError("A movement step must target one adjacent hex");
    }
    if (!this.#canOccupyWithOffsets(destination, previous.footprint, unitId)) return null;
    this.#assertWorldVersionCanAdvance();

    const from = previous.position;
    this.#clearOccupancy(previous);
    const moved = Object.freeze({
      id: previous.id,
      position: axial(destination.q, destination.r),
      footprint: previous.footprint,
    });
    this.#units.set(unitId, moved);
    this.#writeOccupancy(moved);
    this.#incrementWorldVersion();
    return Object.freeze({ from, to: moved.position });
  }

  worldVersion() {
    return this.#worldVersion;
  }

  reserveStep({ commandId, eventId, unitId, at, from, to } = {}, { allowCurrentlyBlocked = false } = {}) {
    for (const [value, label] of [[commandId, "Command id"], [eventId, "Event id"], [unitId, "Unit id"]]) {
      if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
    }
    if (this.#reservations.has(eventId)) throw new Error(`Duplicate step reservation: ${eventId}`);
    if (!Number.isSafeInteger(at) || at < 0) throw new RangeError("Reservation time must be a non-negative safe integer");
    const unit = this.#requireUnit(unitId);
    const origin = requireHex(from, "Reserved step origin");
    const destination = requireHex(to, "Reserved step destination");
    if (hexDistance(origin, destination) !== 1) throw new RangeError("A reserved movement step must connect adjacent hexes");
    if (!this.#terrainSupportsFootprint(origin, unit.footprint)
      || !this.#terrainSupportsFootprint(destination, unit.footprint)) {
      throw new Error("Reserved movement step crosses missing or blocked terrain");
    }
    if (!allowCurrentlyBlocked && !this.#canOccupyWithOffsets(destination, unit.footprint, unitId)) {
      throw new Error(`Reserved destination is currently blocked: ${hexKey(destination)}`);
    }
    const cells = unit.footprint.map((offset) => addHexes(destination, offset));
    for (const cell of cells) {
      const cellId = `${at}|${hexKey(cell)}`;
      const existing = this.#reservationCells.get(cellId);
      if (existing) {
        throw new Error(`Reservation conflict at ${hexKey(cell)} in T=${at}`);
      }
    }

    const reservation = Object.freeze({
      commandId,
      eventId,
      unitId,
      at,
      from: axial(origin.q, origin.r),
      to: axial(destination.q, destination.r),
      cells: Object.freeze(cells),
    });
    this.#reservations.set(eventId, reservation);
    for (const cell of cells) this.#reservationCells.set(`${at}|${hexKey(cell)}`, eventId);
    return reservation;
  }

  commitReservedStep(eventId) {
    const reservation = this.#reservations.get(eventId);
    if (!reservation) throw new Error(`Unknown step reservation: ${eventId}`);
    this.#releaseReservation(eventId);
    return this.moveUnitStep(reservation.unitId, reservation.to, { expectedFrom: reservation.from });
  }

  releaseReservationsByCommand(commandId) {
    if (typeof commandId !== "string" || !commandId.trim()) throw new TypeError("Command id is required");
    const released = [];
    for (const reservation of [...this.#reservations.values()]) {
      if (reservation.commandId !== commandId) continue;
      released.push(this.#releaseReservation(reservation.eventId));
    }
    return Object.freeze(released.filter(Boolean));
  }

  reservationForEvent(eventId) {
    const reservation = this.#reservations.get(eventId);
    return reservation ? structuredClone(reservation) : null;
  }

  reservations() {
    return structuredClone([...this.#reservations.values()]);
  }

  snapshot() {
    return structuredClone({
      schemaVersion: 1,
      worldVersion: this.#worldVersion,
      tiles: [...this.#tiles.values()],
      blockedTerrain: [...this.#blockedTerrain],
      lineOfSightBlockers: [...this.#lineOfSightBlockers],
      projectileBlockers: [...this.#projectileBlockers],
      movementCosts: [...this.#movementCosts.entries()],
      units: [...this.#units.values()],
      reservations: [...this.#reservations.values()],
    });
  }

  static restore(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1) throw new TypeError("HexGrid snapshot schema 1 is required");
    if (!Array.isArray(snapshot.tiles) || !Array.isArray(snapshot.units) || !Array.isArray(snapshot.reservations)) {
      throw new TypeError("HexGrid snapshot is incomplete");
    }
    const grid = new HexGrid({
      tiles: snapshot.tiles,
      blockedTerrain: snapshot.blockedTerrain ?? [],
      lineOfSightBlockers: snapshot.lineOfSightBlockers ?? snapshot.blockedTerrain ?? [],
      projectileBlockers: snapshot.projectileBlockers ?? snapshot.blockedTerrain ?? [],
      movementCosts: snapshot.movementCosts ?? [],
    });
    for (const unit of snapshot.units) grid.addUnit(unit);
    // A blocker may have appeared after a future step was reserved. Restoring
    // must preserve that valid in-flight state; execution will revalidate and
    // interrupt the step instead of refusing to load the save.
    for (const reservation of snapshot.reservations) {
      grid.reserveStep(reservation, { allowCurrentlyBlocked: true });
    }
    if (!Number.isSafeInteger(snapshot.worldVersion)
      || snapshot.worldVersion < grid.#worldVersion
      || snapshot.worldVersion >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Invalid HexGrid world version");
    }
    grid.#worldVersion = snapshot.worldVersion;
    return grid;
  }

  #requireUnit(unitId) {
    const unit = this.#units.get(unitId);
    if (!unit) throw new Error(`Unknown unit: ${unitId}`);
    return unit;
  }

  #incrementWorldVersion() {
    this.#assertWorldVersionCanAdvance();
    this.#worldVersion += 1;
    return this.#worldVersion;
  }

  #assertWorldVersionCanAdvance() {
    if (!Number.isSafeInteger(this.#worldVersion)
      || this.#worldVersion < 0
      || this.#worldVersion >= Number.MAX_SAFE_INTEGER - 1) {
      throw new RangeError("HexGrid world version is exhausted or invalid");
    }
  }

  #placementCost(anchor, footprint) {
    return Math.max(...footprint.map((offset) => this.#movementCosts.get(hexKey(addHexes(anchor, offset))) ?? 1));
  }

  #canOccupyWithOffsets(anchor, footprint, ignoreUnitId = null) {
    return footprint.every((offset) => !this.isBlocked(addHexes(anchor, offset), { ignoreUnitId }));
  }

  #terrainSupportsFootprint(anchor, footprint) {
    return footprint.every((offset) => {
      const id = hexKey(addHexes(anchor, offset));
      return this.#tiles.has(id) && !this.#blockedTerrain.has(id);
    });
  }

  #reconstructPath(cameFrom, destinationId) {
    const ids = [destinationId];
    while (cameFrom.has(ids.at(-1))) ids.push(cameFrom.get(ids.at(-1)));
    ids.reverse();
    return ids.map((id) => this.#tiles.get(id));
  }

  #writeOccupancy(unit) {
    for (const position of unit.footprint.map((offset) => addHexes(unit.position, offset))) {
      this.#occupancy.set(hexKey(position), unit.id);
    }
  }

  #clearOccupancy(unit) {
    for (const position of unit.footprint.map((offset) => addHexes(unit.position, offset))) {
      const id = hexKey(position);
      if (this.#occupancy.get(id) === unit.id) this.#occupancy.delete(id);
    }
  }

  #hasClearLine(from, to, blockers, {
    blockUnits,
    ignoreUnitIds,
    includeDestination = false,
    unitBlocks = null,
  }) {
    const ignored = new Set(ignoreUnitIds);
    const line = hexLine(from, to);
    if (!line.every((cell) => this.#tiles.has(hexKey(cell)))) return false;
    const traversed = includeDestination ? line.slice(1) : line.slice(1, -1);
    for (const cell of traversed) {
      const id = hexKey(cell);
      if (blockers.has(id)) return false;
      const occupant = this.#occupancy.get(id);
      if (blockUnits && occupant && !ignored.has(occupant)
        && (unitBlocks === null || unitBlocks(occupant, structuredClone(cell)))) return false;
    }
    return true;
  }

  #releaseReservation(eventId) {
    const reservation = this.#reservations.get(eventId);
    if (!reservation) return null;
    for (const cell of reservation.cells) {
      const cellId = `${reservation.at}|${hexKey(cell)}`;
      if (this.#reservationCells.get(cellId) === eventId) this.#reservationCells.delete(cellId);
    }
    this.#reservations.delete(eventId);
    return structuredClone(reservation);
  }
}
