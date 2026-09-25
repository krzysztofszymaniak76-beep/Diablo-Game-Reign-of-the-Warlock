function key(x, y) { return `${x},${y}`; }

export function generateArea({ width, height, rng, obstacleChance = 0.18, requiredObjects = [] }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4) throw new RangeError("Area must be at least 4x4");
  const entrance = { x: 0, y: 1 };
  const exit = { x: width - 1, y: height - 2 };
  const blocked = new Set();
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (rng.float() < obstacleChance) blocked.add(key(x, y));
  }
  // A deterministic L-shaped safety spine guarantees the required route. This
  // is a generator contract, not a claim that D2R uses this algorithm.
  for (let x = entrance.x; x <= exit.x; x += 1) blocked.delete(key(x, entrance.y));
  for (let y = entrance.y; y <= exit.y; y += 1) blocked.delete(key(exit.x, y));
  blocked.delete(key(entrance.x, entrance.y));
  blocked.delete(key(exit.x, exit.y));
  for (const object of requiredObjects) blocked.delete(key(object.position.x, object.position.y));
  return {
    width,
    height,
    entrance,
    exit,
    blocked: [...blocked].sort(),
    requiredObjects: structuredClone(requiredObjects),
    generationStatus: "ADAPTATION_PLACEHOLDER",
  };
}

export function validateArea(area) {
  const blocked = new Set(area.blocked);
  const visited = new Set([key(area.entrance.x, area.entrance.y)]);
  const queue = [area.entrance];
  const reachable = (position) => visited.has(key(position.x, position.y));
  while (queue.length) {
    const current = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx; const y = current.y + dy; const id = key(x, y);
      if (x < 0 || y < 0 || x >= area.width || y >= area.height || blocked.has(id) || visited.has(id)) continue;
      visited.add(id); queue.push({ x, y });
    }
  }
  const unreachableObjects = area.requiredObjects.filter((object) => !reachable(object.position)).map((object) => object.id);
  return { valid: reachable(area.exit) && unreachableObjects.length === 0, exitReachable: reachable(area.exit), unreachableObjects };
}
