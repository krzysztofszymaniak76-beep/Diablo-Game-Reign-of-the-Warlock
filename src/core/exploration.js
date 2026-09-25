import {
  ACT1_EXPLORATION_AREAS,
  ACT1_EXPLORATION_GENERATOR_VERSION,
  ACT1_LOCKED_TRANSITIONS,
  act1Area,
} from '../../data/act1-exploration.v058.js';
import { ACT1_ENCOUNTERS } from '../../data/act1-encounters.v057.js';
import { explorationPoint, isOpenTerrainPointPassable, openTerrainSectorAt } from './open-terrain.js';
import { rollBloodMoorEncounter } from './random-act1-encounter.js';

export { explorationPoint, fieldDecorations, findOpenTerrainPath,
  isOpenTerrainPointPassable, isOpenTerrainSegmentPassable, openTerrainObstacles,
  openTerrainSectorAt } from './open-terrain.js';
export const EXPLORATION_SCHEMA_VERSION = 3;
const clone = value => structuredClone(value);
const generatedAreaCache = new Map();
const cellKey = (x, y) => `${x},${y}`;
const edgeKey = (a, b) => [a, b].sort().join('|');
const DIRS = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);

function hash32(text) {
  let value = 0x811c9dc5;
  for (const char of String(text)) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

class Stream {
  constructor(seed) { this.state = seed >>> 0 || 0x9e3779b9; }
  next() {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }
  integer(max) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('Nieprawidłowy zakres RNG eksploracji');
    return Math.floor(this.next() * max);
  }
  pick(values) { return values[this.integer(values.length)]; }
}

function streamSeed({ worldSeed, areaId, difficulty, generatorVersion, channel, fixed = false }) {
  return hash32(`${fixed ? 'fixed' : worldSeed >>> 0}|${areaId}|${difficulty}|${generatorVersion}|${channel}`);
}

function isDungeon(profile) {
  return ['cave', 'crypt', 'tower', 'monastery', 'jail', 'catacombs'].includes(profile);
}

function candidateCells(cells) {
  const candidates = new Map();
  for (const cell of cells.values()) for (const [dx, dy] of DIRS) {
    const x = cell.x + dx, y = cell.y + dy, key = cellKey(x, y);
    if (cells.has(key)) continue;
    const entry = candidates.get(key) ?? { x, y, adjacent: 0 };
    entry.adjacent += 1;
    candidates.set(key, entry);
  }
  return [...candidates.values()];
}

function chooseCandidate(candidates, profile, rng, index) {
  const dungeon = isDungeon(profile);
  const scored = candidates.map(candidate => {
    const distance = Math.abs(candidate.x) + Math.abs(candidate.y);
    const branchBias = dungeon
      ? (candidate.adjacent === 1 ? 4 : candidate.adjacent === 2 ? -.5 : -4)
      : (candidate.adjacent === 1 ? 3.8 : candidate.adjacent === 2 ? 1.1 : -3.5);
    const directionBias = profile === 'jail' ? (Math.abs(candidate.y) % 2 ? 1.8 : 0)
      : profile === 'tower' ? -distance * .04
        : profile === 'forest' ? -Math.abs(candidate.x - candidate.y) * .025
          : profile === 'marsh' ? Math.sin((candidate.x + candidate.y) * .8) : 0;
    return { candidate, score: branchBias + directionBias + rng.next() * 5 + Math.min(index / 45, 1) * distance * .025 };
  });
  scored.sort((a, b) => b.score - a.score || a.candidate.x - b.candidate.x || a.candidate.y - b.candidate.y);
  return scored[0].candidate;
}

function growCells(count, profile, rng) {
  const cells = new Map([[cellKey(0, 0), { x: 0, y: 0 }]]);
  for (let index = 1; index < count; index += 1) {
    const candidates = candidateCells(cells);
    if (!candidates.length) throw new Error('Generator utracił granicę wzrostu');
    const selected = chooseCandidate(candidates, profile, rng, index);
    cells.set(cellKey(selected.x, selected.y), { x: selected.x, y: selected.y });
  }
  return [...cells.values()];
}

function fixedCells(count, profile) {
  const width = Math.max(4, Math.ceil(Math.sqrt(count * (profile === 'camp' ? 1.4 : 1))));
  const cells = [];
  for (let y = 0; cells.length < count; y += 1) for (let x = 0; x < width && cells.length < count; x += 1) {
    if (profile === 'ruins' && x > 1 && x < width - 2 && y > 1 && (x + y) % 7 === 0) continue;
    cells.push({ x, y });
  }
  const minX = Math.min(...cells.map(c => c.x)), maxX = Math.max(...cells.map(c => c.x));
  const minY = Math.min(...cells.map(c => c.y)), maxY = Math.max(...cells.map(c => c.y));
  return cells.map(({ x, y }) => ({ x: x - Math.floor((minX + maxX) / 2), y: y - Math.floor((minY + maxY) / 2) }));
}

function makeSectors(cells, profile, decorationRng) {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  return sorted.map((cell, index) => ({
    id: `sector-${String(index + 1).padStart(3, '0')}`,
    x: cell.x,
    y: cell.y,
    terrain: profile,
    variant: decorationRng.integer(4),
  }));
}

function makeEdges(sectors, profile, layoutRng) {
  const byCell = new Map(sectors.map(sector => [cellKey(sector.x, sector.y), sector]));
  const candidates = [];
  for (const sector of sectors) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const other = byCell.get(cellKey(sector.x + dx, sector.y + dy));
    if (other) candidates.push({ a: sector.id, b: other.id });
  }
  const start = sectors.reduce((best, sector) => Math.abs(sector.x) + Math.abs(sector.y) < Math.abs(best.x) + Math.abs(best.y) ? sector : best, sectors[0]);
  const seen = new Set([start.id]), edges = [], pending = [...candidates];
  while (seen.size < sectors.length) {
    const available = pending.filter(edge => seen.has(edge.a) !== seen.has(edge.b));
    if (!available.length) throw new Error('Wygenerowana geometria nie tworzy spójnej mapy');
    const edge = layoutRng.pick(available);
    edges.push({ ...edge, kind: isDungeon(profile) ? 'corridor' : 'path' });
    seen.add(edge.a); seen.add(edge.b);
    pending.splice(pending.findIndex(item => edgeKey(item.a, item.b) === edgeKey(edge.a, edge.b)), 1);
  }
  const loopChance = isDungeon(profile) ? .12 : .25;
  for (const edge of pending) if (layoutRng.next() < loopChance) edges.push({ ...edge, kind: isDungeon(profile) ? 'corridor' : 'path' });
  return edges.sort((a, b) => edgeKey(a.a, a.b).localeCompare(edgeKey(b.a, b.b), 'en'));
}

function adjacency(sectors, edges) {
  const result = new Map(sectors.map(sector => [sector.id, []]));
  for (const edge of edges) { result.get(edge.a).push(edge.b); result.get(edge.b).push(edge.a); }
  for (const list of result.values()) list.sort();
  return result;
}

function distancesFrom(startId, graph) {
  const distances = new Map([[startId, 0]]), queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    for (const next of graph.get(id) ?? []) if (!distances.has(next)) {
      distances.set(next, distances.get(id) + 1); queue.push(next);
    }
  }
  return distances;
}

function selectSeparated(candidates, occupied, graph, count, rng) {
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    const ranked = candidates.filter(id => !occupied.has(id)).map(id => {
      const fromExisting = [...occupied, ...selected].map(other => distancesFrom(other, graph).get(id) ?? 0);
      return { id, distance: fromExisting.length ? Math.min(...fromExisting) : 0, noise: rng.next() };
    }).sort((a, b) => b.distance - a.distance || b.noise - a.noise || a.id.localeCompare(b.id, 'en'));
    const pick = ranked[0];
    if (!pick) throw new Error('Brak miejsca na wymagane punkty mapy');
    selected.push(pick.id); occupied.add(pick.id);
  }
  return selected;
}

function transitionRule(areaId, targetAreaId) {
  return ACT1_LOCKED_TRANSITIONS[`${areaId}>${targetAreaId}`] ?? 'open';
}

function signatureOf(value) {
  return hash32(JSON.stringify(value)).toString(16).padStart(8, '0');
}

function mapBounds(sectors) {
  const xs = sectors.map(s => s.x), ys = sectors.map(s => s.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Visibility follows actual passages, not a circular distance on the image.
// Open field variants see one passage farther; scrub, forest and cave rooms do
// not reveal the area behind the next bend or wall.
export function visibleSectorIds(map, sectorId) {
  const byId = new Map(map.sectors.map(sector => [sector.id, sector]));
  const current = byId.get(sectorId);
  if (!current) throw new Error('Nieznany sektor obserwacji');
  const graph = adjacency(map.sectors, map.edges);
  const visible = new Set([sectorId]);
  const neighbors = graph.get(sectorId) ?? [];
  for (const id of neighbors) visible.add(id);
  if (map.profile === 'field' && current.variant <= 1) {
    for (const id of neighbors) {
      if (byId.get(id)?.variant === 3) continue;
      for (const next of graph.get(id) ?? []) visible.add(next);
    }
  }
  return [...visible].sort();
}

export function revealAroundSector(exploration, map, sectorId) {
  const areaState = exploration.areaStates[map.areaId];
  if (!areaState) throw new Error('Brak stanu obszaru do odkrycia');
  areaState.discoveredSectorIds = [...new Set([
    ...areaState.discoveredSectorIds,
    ...visibleSectorIds(map, sectorId),
  ])].sort();
}

export function generateAreaMap({ worldSeed, areaId, difficulty = 'normal', generatorVersion = ACT1_EXPLORATION_GENERATOR_VERSION }) {
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffffffff) throw new RangeError('Nieprawidłowe ziarno świata');
  if (generatorVersion !== ACT1_EXPLORATION_GENERATOR_VERSION) throw new Error(`Nieobsługiwana wersja generatora: ${generatorVersion}`);
  const cacheKey = `${worldSeed >>> 0}|${areaId}|${difficulty}|${generatorVersion}`;
  if (generatedAreaCache.has(cacheKey)) return generatedAreaCache.get(cacheKey);
  const config = act1Area(areaId), fixed = config.generationMode === 'fixed';
  const layoutRng = new Stream(streamSeed({ worldSeed, areaId, difficulty, generatorVersion, channel: 'layout', fixed }));
  const encounterRng = new Stream(streamSeed({ worldSeed, areaId, difficulty, generatorVersion, channel: 'encounters', fixed: false }));
  const decorationRng = new Stream(streamSeed({ worldSeed, areaId, difficulty, generatorVersion, channel: 'decorations', fixed }));
  let fallbackUsed=false,failureReason=null,cells;
  try {
    cells = fixed ? fixedCells(config.sectorCount, config.profile) : growCells(config.sectorCount, config.profile, layoutRng);
  } catch(error) {
    // One constructive attempt is enough under normal rules.  This bounded,
    // deterministic fallback prevents a damaged future profile from looping.
    fallbackUsed=true;failureReason=error.message;cells=fixedCells(config.sectorCount,config.profile);
  }
  const sectors = makeSectors(cells, config.profile, decorationRng);
  const edges = makeEdges(sectors, config.profile, layoutRng);
  const graph = adjacency(sectors, edges);
  const startSectorId = sectors.reduce((best, sector) => {
    const d = Math.abs(sector.x) + Math.abs(sector.y), bd = Math.abs(best.x) + Math.abs(best.y);
    return d < bd || (d === bd && sector.id < best.id) ? sector : best;
  }, sectors[0]).id;
  const distance = distancesFrom(startSectorId, graph);
  const candidates = sectors.map(s => s.id).sort((a, b) => distance.get(b) - distance.get(a) || a.localeCompare(b, 'en'));
  const occupied = new Set([startSectorId]);
  const exitSectorIds = selectSeparated(candidates, occupied, graph, config.connections.length, layoutRng);
  const exits = config.connections.map((targetAreaId, index) => ({
    id: `exit:${targetAreaId}`,
    sectorId: exitSectorIds[index],
    targetAreaId,
    accessRule: transitionRule(areaId, targetAreaId),
  }));
  const points = [];
  if (config.waypoint) {
    const [sectorId] = selectSeparated(candidates, occupied, graph, 1, layoutRng);
    points.push({ id: `waypoint:${areaId}`, kind: 'waypoint', sectorId, implementation: 'activation-ready' });
  }
  for (const point of config.guaranteedPoints) {
    const [sectorId] = selectSeparated(candidates, occupied, graph, 1, layoutRng);
    points.push({ ...point, sectorId });
  }
  const areaEncounters = ACT1_ENCOUNTERS.filter(encounter => encounter.areaId === areaId);
  const encounterSectorIds = selectSeparated(candidates, occupied, graph, areaEncounters.length, encounterRng);
  const encounters = areaEncounters.map((encounter, index) => ({ encounterId: encounter.id, sectorId: encounterSectorIds[index] }));
  const map = {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    generatorVersion,
    areaId,
    difficulty,
    profile: config.profile,
    generationMode: config.generationMode,
    startSectorId,
    sectors,
    edges,
    exits,
    points,
    encounters,
    bounds: mapBounds(sectors),
    generation: { attemptLimit: 1, attempts: 1, fallbackUsed, failureReason },
  };
  map.layoutSignature = signatureOf({ areaId, profile: map.profile, sectors, edges, exits, points });
  validateGeneratedArea(map);
  generatedAreaCache.set(cacheKey, map);
  return map;
}

export function shortestSectorPath(map, fromId, toId, allowedSectorIds = null) {
  const allowed = allowedSectorIds === null ? null : new Set(allowedSectorIds);
  if (allowed && (!allowed.has(fromId) || !allowed.has(toId))) return null;
  const graph = adjacency(map.sectors, map.edges), previous = new Map(), queue = [fromId], seen = new Set([fromId]);
  while (queue.length) {
    const id = queue.shift();
    if (id === toId) break;
    for (const next of graph.get(id) ?? []) if (!seen.has(next) && (!allowed || allowed.has(next))) {
      seen.add(next); previous.set(next, id); queue.push(next);
    }
  }
  if (!seen.has(toId)) return null;
  const path = [toId];
  while (path[0] !== fromId) path.unshift(previous.get(path[0]));
  return path;
}

export function validateGeneratedArea(map) {
  if (!map || map.schemaVersion !== EXPLORATION_SCHEMA_VERSION) throw new Error('Nieprawidłowa mapa eksploracji');
  const config = act1Area(map.areaId), ids = new Set(map.sectors.map(s => s.id));
  if (!map.generation || map.generation.attemptLimit !== 1 || map.generation.attempts !== 1
    || typeof map.generation.fallbackUsed !== 'boolean'
    || (map.generation.fallbackUsed ? typeof map.generation.failureReason !== 'string' : map.generation.failureReason !== null)) {
    throw new Error(`Niespójna diagnostyka generatora: ${map.areaId}`);
  }
  if (map.generatorVersion !== ACT1_EXPLORATION_GENERATOR_VERSION || map.sectors.length !== config.sectorCount
    || ids.size !== map.sectors.length || !ids.has(map.startSectorId)) throw new Error(`Niespójna geometria mapy: ${map.areaId}`);
  const seenEdges = new Set();
  for (const edge of map.edges) {
    const key = edgeKey(edge.a, edge.b);
    if (!ids.has(edge.a) || !ids.has(edge.b) || edge.a === edge.b || seenEdges.has(key)) throw new Error(`Nielegalne przejście: ${map.areaId}`);
    seenEdges.add(key);
  }
  const reachable = distancesFrom(map.startSectorId, adjacency(map.sectors, map.edges));
  if (reachable.size !== map.sectors.length) throw new Error(`Nieosiągalny sektor: ${map.areaId}`);
  if (map.exits.length !== config.connections.length
    || new Set(map.exits.map(e => e.targetAreaId)).size !== map.exits.length
    || map.exits.some(exit => !ids.has(exit.sectorId) || !config.connections.includes(exit.targetAreaId))) {
    throw new Error(`Niespójne wyjścia: ${map.areaId}`);
  }
  const pointIds = new Set();
  for (const point of map.points) {
    if (!ids.has(point.sectorId) || pointIds.has(point.id)) throw new Error(`Niespójny punkt mapy: ${map.areaId}`);
    pointIds.add(point.id);
  }
  const expectedEncounters = ACT1_ENCOUNTERS.filter(e => e.areaId === map.areaId).map(e => e.id).sort();
  const actualEncounters = map.encounters.map(e => e.encounterId).sort();
  if (JSON.stringify(expectedEncounters) !== JSON.stringify(actualEncounters)
    || map.encounters.some(e => !ids.has(e.sectorId))) throw new Error(`Niespójne spotkania mapy: ${map.areaId}`);
  if (map.layoutSignature !== signatureOf({ areaId: map.areaId, profile: map.profile,
    sectors: map.sectors, edges: map.edges, exits: map.exits, points: map.points })) throw new Error(`Zmieniona sygnatura mapy: ${map.areaId}`);
  return true;
}

export function createExplorationState({ worldSeed, difficulty = 'normal', areaId = 'act1.rogue_encampment' }) {
  const map = generateAreaMap({ worldSeed, areaId, difficulty });
  const start = map.sectors.find(sector => sector.id === map.startSectorId);
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    worldId: `world-${(worldSeed >>> 0).toString(16).padStart(8, '0')}-g${ACT1_EXPLORATION_GENERATOR_VERSION}`,
    generatorVersion: ACT1_EXPLORATION_GENERATOR_VERSION,
    currentSectorId: map.startSectorId,
    currentPosition: explorationPoint(areaId, start),
    movementSequence: 0,
    activeBattle: null,
    areaStates: {
      [areaId]: { layoutSignature: map.layoutSignature, discoveredSectorIds: visibleSectorIds(map, map.startSectorId), activatedWaypointIds: [], randomEncounterRolls: {} },
    },
  };
}

/** A v1 save had one sector as its only position; preserve that sector's ID. */
export function migrateExplorationState(input, { worldSeed, difficulty, currentAreaId }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Nieprawidłowy stan eksploracji');
  if (input.schemaVersion === EXPLORATION_SCHEMA_VERSION) return clone(input);
  if (![1, 2].includes(input.schemaVersion)) throw new Error(`Nieobsługiwany schemat eksploracji: ${input.schemaVersion}`);
  if (input.generatorVersion !== ACT1_EXPLORATION_GENERATOR_VERSION
    || input.worldId !== `world-${(worldSeed >>> 0).toString(16).padStart(8, '0')}-g${input.generatorVersion}`) {
    throw new Error('Nieprawidłowa tożsamość dawnej mapy');
  }
  if (input.schemaVersion === 2) {
    const next = clone(input);
    next.schemaVersion = EXPLORATION_SCHEMA_VERSION;
    migrateRandomEncounterRolls(next, { worldSeed, difficulty });
    return next;
  }
  const map = generateAreaMap({ worldSeed, areaId: currentAreaId, difficulty,
    generatorVersion: input.generatorVersion });
  const sector = map.sectors.find(item => item.id === input.currentSectorId);
  if (!sector) throw new Error('Dawna pozycja drużyny nie istnieje na mapie');
  const next = clone(input);
  next.schemaVersion = EXPLORATION_SCHEMA_VERSION;
  next.currentPosition = explorationPoint(currentAreaId, sector);
  migrateRandomEncounterRolls(next, { worldSeed, difficulty });
  return next;
}

/** Older saves had no random encounters. Previously discovered sectors are
 * sealed as empty during migration so loading an old world cannot surprise the
 * player with a retroactive roll. Newly entered sectors still roll normally. */
export function migrateRandomEncounterRolls(state, { worldSeed, difficulty }) {
  for (const [areaId, areaState] of Object.entries(state.areaStates ?? {})) {
    if (areaState.randomEncounterRolls !== undefined) continue;
    areaState.randomEncounterRolls = {};
    const map = generateAreaMap({ worldSeed, areaId, difficulty, generatorVersion: state.generatorVersion });
    for (const sectorId of areaState.discoveredSectorIds ?? []) {
      if (map.encounters.some(encounter => encounter.sectorId === sectorId)) continue;
      areaState.randomEncounterRolls[sectorId] = { outcome: 'legacy-empty' };
    }
  }
  return state;
}

export function ensureExplorationArea(state, { worldSeed, difficulty, areaId }) {
  const map = generateAreaMap({ worldSeed, areaId, difficulty, generatorVersion: state.generatorVersion });
  if (!state.areaStates[areaId]) state.areaStates[areaId] = {
    layoutSignature: map.layoutSignature,
    discoveredSectorIds: [],
    activatedWaypointIds: [],
    randomEncounterRolls: {},
  };
  if (state.areaStates[areaId].layoutSignature !== map.layoutSignature) throw new Error(`Mapa ${areaId} nie odpowiada zapisanej wersji generatora`);
  return map;
}

export function validateExplorationState(state, { worldSeed, difficulty, currentAreaId, encounters }) {
  if (!state || state.schemaVersion !== EXPLORATION_SCHEMA_VERSION
    || state.generatorVersion !== ACT1_EXPLORATION_GENERATOR_VERSION
    || state.worldId !== `world-${(worldSeed >>> 0).toString(16).padStart(8, '0')}-g${state.generatorVersion}`
    || !Number.isSafeInteger(state.movementSequence) || state.movementSequence < 0
    || !state.areaStates || typeof state.areaStates !== 'object' || Array.isArray(state.areaStates)) {
    throw new Error('Niespójny stan eksploracji');
  }
  for (const [areaId, areaState] of Object.entries(state.areaStates)) {
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) throw new Error(`Nieznany zapisany obszar: ${areaId}`);
    const map = generateAreaMap({ worldSeed, areaId, difficulty, generatorVersion: state.generatorVersion });
    const ids = new Set(map.sectors.map(s => s.id));
    if (!areaState || areaState.layoutSignature !== map.layoutSignature
      || !Array.isArray(areaState.discoveredSectorIds) || new Set(areaState.discoveredSectorIds).size !== areaState.discoveredSectorIds.length
      || areaState.discoveredSectorIds.some(id => !ids.has(id))
      || !Array.isArray(areaState.activatedWaypointIds) || new Set(areaState.activatedWaypointIds).size !== areaState.activatedWaypointIds.length
      || areaState.activatedWaypointIds.some(id => !map.points.some(point => point.kind === 'waypoint' && point.id === id))
      || !areaState.randomEncounterRolls || typeof areaState.randomEncounterRolls !== 'object' || Array.isArray(areaState.randomEncounterRolls)) {
      throw new Error(`Niespójny stan obszaru: ${areaId}`);
    }
    for (const [sectorId, result] of Object.entries(areaState.randomEncounterRolls)) {
      if (!ids.has(sectorId) || !result || typeof result !== 'object' || Array.isArray(result)
        || map.encounters.some(encounter => encounter.sectorId === sectorId)) {
        throw new Error(`Niespójny wynik losowania spotkania: ${areaId}/${sectorId}`);
      }
      if (result.outcome === 'legacy-empty') {
        if (!areaState.discoveredSectorIds.includes(sectorId) || Object.keys(result).length !== 1) {
          throw new Error(`Nieprawidłowy znacznik migracji spotkania: ${areaId}/${sectorId}`);
        }
        continue;
      }
      if (!areaState.discoveredSectorIds.includes(sectorId)) {
        throw new Error(`Losowanie przypisano do nieodkrytego sektora: ${areaId}/${sectorId}`);
      }
      if (result.outcome === 'safe-entry') {
        if (areaId !== 'act1.blood_moor' || Object.keys(result).length !== 1
          || !map.exits.some(exit => exit.sectorId === sectorId)) {
          throw new Error(`Nieprawidłowy bezpieczny sektor wejściowy: ${areaId}/${sectorId}`);
        }
        continue;
      }
      if (areaId !== 'act1.blood_moor') throw new Error(`Nieobsługiwany obszar losowych spotkań: ${areaId}`);
      const expected = rollBloodMoorEncounter({ worldSeed, difficulty, sectorId }).result;
      if (JSON.stringify(result) !== JSON.stringify(expected)
        || (result.outcome === 'encounter' && !encounters?.[result.encounterId])) {
        throw new Error(`Zmieniony wynik losowania spotkania: ${areaId}/${sectorId}`);
      }
    }
  }
  const current = state.areaStates[currentAreaId];
  if (!current) throw new Error('Bieżący obszar nie został wygenerowany');
  const currentMap = generateAreaMap({ worldSeed, areaId: currentAreaId, difficulty, generatorVersion: state.generatorVersion });
  if (!current.discoveredSectorIds.includes(state.currentSectorId)
    || !currentMap.sectors.some(s => s.id === state.currentSectorId)) throw new Error('Bieżący sektor nie jest odkryty');
  const position = state.currentPosition;
  if (!position || typeof position !== 'object' || Array.isArray(position)
    || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Brak precyzyjnej pozycji drużyny');
  const sector = currentMap.sectors.find(item => item.id === state.currentSectorId);
  const center = explorationPoint(currentAreaId, sector);
  if (currentAreaId === 'act1.blood_moor') {
    if (!isOpenTerrainPointPassable(currentMap, position)
      || openTerrainSectorAt(currentMap, position) !== state.currentSectorId) {
      throw new Error('Pozycja drużyny nie zgadza się z przechodnim sektorem');
    }
  } else if (Math.abs(position.x - center.x) > 1e-7 || Math.abs(position.y - center.y) > 1e-7) {
    throw new Error('Pozycja w obszarze korytarzowym nie zgadza się z sektorem');
  }
  if (state.activeBattle !== null) {
    const battle = state.activeBattle;
    const randomEncounter = current.randomEncounterRolls[battle.sectorId];
    const staticEncounter = currentMap.encounters.some(item => item.encounterId === battle.encounterId && item.sectorId === battle.sectorId);
    if (!battle || battle.areaId !== currentAreaId || battle.sectorId !== state.currentSectorId
      || (!staticEncounter && randomEncounter?.outcome !== 'encounter')
      || (!staticEncounter && randomEncounter?.encounterId !== battle.encounterId)
      || encounters?.[battle.encounterId]?.status !== 'active') throw new Error('Walka nie odpowiada sektorowi eksploracji');
  }
  return true;
}

export function areaMapForWorld(world, { worldSeed, difficulty }) {
  return generateAreaMap({ worldSeed, areaId: world.currentAreaId, difficulty, generatorVersion: world.exploration.generatorVersion });
}

export function revealPathToSector(exploration, map, sectorId) {
  const areaState = exploration.areaStates[map.areaId];
  const path = shortestSectorPath(map, map.startSectorId, sectorId);
  if (!path) throw new Error('Brak ścieżki migracji');
  areaState.discoveredSectorIds = [...new Set([...areaState.discoveredSectorIds, ...path])].sort();
  revealAroundSector(exploration, map, sectorId);
}

export function explorationSectorView({ map, state, encounters, extraEncounters = [] }) {
  const areaState = state.areaStates[map.areaId], discovered = new Set(areaState.discoveredSectorIds);
  const graph = adjacency(map.sectors, map.edges), adjacent = new Set(graph.get(state.currentSectorId) ?? []);
  const visible = new Set(visibleSectorIds(map, state.currentSectorId));
  const placements = [...map.encounters, ...extraEncounters];
  const waitingEncounter = placements.some(item => item.sectorId === state.currentSectorId
    && encounters[item.encounterId]?.status === 'unvisited');
  return map.sectors.map(sector => {
    const isDiscovered = discovered.has(sector.id), isAdjacent = adjacent.has(sector.id);
    const encounter = placements.find(item => item.sectorId === sector.id);
    const points = isDiscovered ? map.points.filter(point => point.sectorId === sector.id) : [];
    const exits = isDiscovered ? map.exits.filter(exit => exit.sectorId === sector.id) : [];
    return {
      ...clone(sector),
      discovered: isDiscovered,
      visible: isDiscovered && visible.has(sector.id),
      current: sector.id === state.currentSectorId,
      reachable: isAdjacent && state.activeBattle === null && !waitingEncounter,
      encounter: isDiscovered && encounter ? {
        encounterId: encounter.encounterId,
        status: encounters[encounter.encounterId].status === 'unvisited' ? 'available' : encounters[encounter.encounterId].status,
        encounterKind: encounter.encounterKind ?? 'authored',
        label: encounter.label ?? null,
      } : null,
      points: clone(points),
      exits: clone(exits),
    };
  });
}

export function unlockedTransition(areaId, targetAreaId) {
  return transitionRule(areaId, targetAreaId) === 'open';
}
