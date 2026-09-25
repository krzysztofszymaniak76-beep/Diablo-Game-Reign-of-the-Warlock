// Shared, deterministic geometry for the Blood Moor's illustrated ground and
// its walkable surface. Rendering and navigation consume the same placements.
export const BLOOD_MOOR = 'act1.blood_moor';
export const DEN_OF_EVIL = 'act1.den_of_evil';
const CELL = 24;
const STEP = 8;
const EPS = 1e-7;
const cachedObstacles = new WeakMap();

export function explorationPoint(areaId, sector) {
  if (areaId !== BLOOD_MOOR && areaId !== DEN_OF_EVIL) return { x: sector.x * 76, y: sector.y * 58 };
  return {
    x: sector.x * 168 + (sector.id ? Math.round(Math.sin(sector.x * 3.7 + sector.y * 2.1) * 23) : 0),
    y: sector.y * 132 + (sector.id ? Math.round(Math.cos(sector.x * 2.7 - sector.y * 1.3) * 19) : 0),
  };
}

export function terrainRandomFor(key) {
  let n = 2166136261;
  for (const c of key) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return (n >>> 0) / 4294967296; };
}

export function fieldDecorations(map, sector) {
  if (map.areaId !== BLOOD_MOOR) return null;
  const center = explorationPoint(map.areaId, sector);
  const rng = terrainRandomFor(`${map.layoutSignature}:${sector.id}:landscape-v1`);
  const bushes = [];
  for (let index = 0; index < 4; index += 1) {
    const angle = rng() * Math.PI * 2;
    const distance = 57 + rng() * 42;
    const size = 9 + rng() * 12;
    bushes.push({
      x: center.x + Math.cos(angle) * distance,
      y: center.y + Math.sin(angle) * distance * .78,
      size,
      mirror: rng() > .5 ? -1 : 1,
      tree: index === 0 && sector.variant === 0,
    });
  }
  const rock = sector.variant === 2
    ? { x: center.x + 51, y: center.y - 35, size: 12, rotation: rng() * 80 - 40 }
    : null;
  const fence = sector.variant === 3
    ? { x1: center.x - 63, y1: center.y + 35, x2: center.x - 34, y2: center.y + 42 }
    : null;
  return { bushes, rock, fence };
}

export function openTerrainObstacles(map) {
  if (map.areaId !== BLOOD_MOOR) return [];
  if (cachedObstacles.has(map)) return cachedObstacles.get(map);
  const obstacles = [];
  for (const sector of map.sectors) {
    const details = fieldDecorations(map, sector);
    const tree = details.bushes.find(bush => bush.tree);
    if (tree) obstacles.push({ id: `tree:${sector.id}`, kind: 'tree', x: tree.x, y: tree.y,
      radius: Math.max(14, tree.size * 1.15) });
    if (details.rock) obstacles.push({ id: `rock:${sector.id}`, kind: 'rock', x: details.rock.x,
      y: details.rock.y, radius: 15 });
    if (details.fence) obstacles.push({ id: `fence:${sector.id}`, kind: 'fence',
      ...details.fence, radius: 10 });
  }
  const byCell = new Map(map.sectors.map(sector => [`${sector.x},${sector.y}`, sector]));
  const linked = new Set(map.edges.map(edge => [edge.a, edge.b].sort().join('|')));
  for (const sector of map.sectors) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const other = byCell.get(`${sector.x + dx},${sector.y + dy}`);
    if (!other || linked.has([sector.id, other.id].sort().join('|'))) continue;
    const a = explorationPoint(map.areaId, sector), b = explorationPoint(map.areaId, other);
    // The hedge is drawn by the landscape renderer at this shared midpoint.
    obstacles.push({ id: `hedge:${sector.id}:${other.id}`, kind: 'hedge',
      x1: (a.x + b.x) / 2 - (dy ? 49 : 0), y1: (a.y + b.y) / 2 - (dx ? 40 : 0),
      x2: (a.x + b.x) / 2 + (dy ? 49 : 0), y2: (a.y + b.y) / 2 + (dx ? 40 : 0), radius: 13 });
  }
  cachedObstacles.set(map, obstacles);
  return obstacles;
}

function distanceSquaredToSegment(x, y, obstacle) {
  const dx = obstacle.x2 - obstacle.x1, dy = obstacle.y2 - obstacle.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((x - obstacle.x1) * dx + (y - obstacle.y1) * dy) / lengthSquared));
  const ox = x - (obstacle.x1 + t * dx), oy = y - (obstacle.y1 + t * dy);
  return ox * ox + oy * oy;
}

export function isOpenTerrainPointPassable(map, point) {
  if (map.areaId !== BLOOD_MOOR || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  // Identical ellipses form the non-fogged ground mask in the renderer.
  let onGround = false;
  for (const sector of map.sectors) {
    const center = explorationPoint(map.areaId, sector);
    const dx = (point.x - center.x) / 144, dy = (point.y - center.y) / 112;
    if (dx * dx + dy * dy <= 1 + EPS) { onGround = true; break; }
  }
  if (!onGround) return false;
  for (const obstacle of openTerrainObstacles(map)) {
    const distanceSquared = obstacle.kind === 'tree' || obstacle.kind === 'rock'
      ? (point.x - obstacle.x) ** 2 + (point.y - obstacle.y) ** 2
      : distanceSquaredToSegment(point.x, point.y, obstacle);
    if (distanceSquared <= obstacle.radius * obstacle.radius) return false;
  }
  return true;
}

export function openTerrainSectorAt(map, point) {
  if (!isOpenTerrainPointPassable(map, point)) return null;
  let best = null, bestDistance = Infinity;
  for (const sector of map.sectors) {
    const center = explorationPoint(map.areaId, sector);
    const distance = ((point.x - center.x) / 144) ** 2 + ((point.y - center.y) / 112) ** 2;
    if (distance < bestDistance - EPS || (Math.abs(distance - bestDistance) <= EPS && sector.id < best?.id)) {
      best = sector; bestDistance = distance;
    }
  }
  return best?.id ?? null;
}

export function isOpenTerrainSegmentPassable(map, from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const parts = Math.max(1, Math.ceil(distance / STEP));
  for (let index = 0; index <= parts; index += 1) {
    const t = index / parts;
    if (!isOpenTerrainPointPassable(map, { x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t })) return false;
  }
  return true;
}

class MinHeap {
  #items = [];
  push(value) {
    const a = this.#items; let index = a.length; a.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (a[parent].score <= value.score) break;
      a[index] = a[parent]; index = parent;
    }
    a[index] = value;
  }
  pop() {
    const a = this.#items, first = a[0], last = a.pop();
    if (a.length && last) {
      let index = 0;
      while (index * 2 + 1 < a.length) {
        let child = index * 2 + 1;
        if (child + 1 < a.length && a[child + 1].score < a[child].score) child += 1;
        if (last.score <= a[child].score) break;
        a[index] = a[child]; index = child;
      }
      a[index] = last;
    }
    return first;
  }
  get size() { return this.#items.length; }
}

function densify(path) {
  const points = [{ ...path[0] }];
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1], to = path[index];
    const parts = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / CELL));
    for (let step = 1; step <= parts; step += 1) {
      const t = step / parts;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      if (Math.hypot(point.x - points.at(-1).x, point.y - points.at(-1).y) > EPS) points.push(point);
    }
  }
  return points;
}

// A long segment and its <=24-unit movement steps sample the terrain at
// different positions. Validate the exact steps that advanceAct1OpenTerrain
// will commit, otherwise a planned path can fail midway at an obstacle edge.
function canTraverseAsMovementSteps(map, from, to) {
  if (!isOpenTerrainSegmentPassable(map, from, to)) return false;
  const steps = densify([from, to]);
  for (let index = 1; index < steps.length; index += 1) {
    if (!isOpenTerrainSegmentPassable(map, steps[index - 1], steps[index])) return false;
  }
  return true;
}

export function findOpenTerrainPath(map, from, target) {
  if (map.areaId !== BLOOD_MOOR || !isOpenTerrainPointPassable(map, from)
    || !isOpenTerrainPointPassable(map, target)) return null;
  if (from.x === target.x && from.y === target.y) return [{ ...from }];
  if (canTraverseAsMovementSteps(map, from, target)) return densify([from, target]);
  const originX = Math.floor((map.bounds.minX * 168 - 160) / CELL) * CELL;
  const originY = Math.floor((map.bounds.minY * 132 - 128) / CELL) * CELL;
  const width = Math.ceil(((map.bounds.maxX - map.bounds.minX) * 168 + 320) / CELL) + 2;
  const height = Math.ceil(((map.bounds.maxY - map.bounds.minY) * 132 + 256) / CELL) + 2;
  const pointAt = key => ({ x: originX + (key % width) * CELL,
    y: originY + Math.floor(key / width) * CELL });
  const adjacentNodes = point => {
    const cx = Math.round((point.x - originX) / CELL), cy = Math.round((point.y - originY) / CELL);
    const list = [];
    for (let radius = 0; radius <= 4 && !list.length; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const key = y * width + x, candidate = pointAt(key);
        if (canTraverseAsMovementSteps(map, point, candidate)) list.push(key);
      }
    }
    return list;
  };
  const starts = adjacentNodes(from), goals = new Set(adjacentNodes(target));
  if (!starts.length || !goals.size) return null;
  const open = new MinHeap(), previous = new Map(), cost = new Map(), settled = new Set();
  for (const key of starts) {
    const point = pointAt(key), distance = Math.hypot(point.x - from.x, point.y - from.y);
    cost.set(key, distance); previous.set(key, null);
    open.push({ key, score: distance + Math.hypot(point.x - target.x, point.y - target.y) });
  }
  const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let winner = null;
  while (open.size) {
    const { key } = open.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    if (goals.has(key)) { winner = key; break; }
    const x = key % width, y = Math.floor(key / width), fromNode = pointAt(key);
    for (const [dx, dy] of directions) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (settled.has(next)) continue;
      const nextPoint = pointAt(next);
      if (!canTraverseAsMovementSteps(map, fromNode, nextPoint)) continue;
      const candidate = cost.get(key) + Math.hypot(dx, dy) * CELL;
      if (candidate + EPS >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, candidate); previous.set(next, key);
      open.push({ key: next, score: candidate + Math.hypot(nextPoint.x - target.x, nextPoint.y - target.y) });
    }
  }
  if (winner === null) return null;
  const route = [];
  for (let key = winner; key !== null; key = previous.get(key)) route.unshift(pointAt(key));
  route.unshift({ ...from }); route.push({ ...target });
  // Remove grid points that are no longer needed while preserving exact ends.
  const simple = [route[0]];
  let anchor = 0;
  while (anchor < route.length - 1) {
    let next = route.length - 1;
    while (next > anchor + 1 && !canTraverseAsMovementSteps(map, route[anchor], route[next])) next -= 1;
    simple.push(route[next]); anchor = next;
  }
  return densify(simple);
}
