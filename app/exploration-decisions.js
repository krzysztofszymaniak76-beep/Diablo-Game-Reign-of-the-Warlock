// Presentation only: consume the public fog-filtered view.  Edges may be passed
// by the map renderer, but a route is allowed to use only sectors already
// visible to the player (plus the one immediately reachable fog frontier).
export const MAX_TRAVEL_SEGMENT_STEPS = 3;

export function hasTravelDecisions(areaId) {
  return areaId === 'act1.blood_moor' || areaId === 'act1.den_of_evil';
}

/** Ordinary movement belongs to the map. Cards appear only at a real fork. */
export function isTravelFork(areaId, sectors, edges = []) {
  if (!hasTravelDecisions(areaId)) return false;
  const current = sectors.find(sector => sector.current);
  if (!current) return false;
  const reachable = sectors.filter(sector => sector.reachable && !sector.current);
  if (reachable.length < 2) return false;
  const neighbors = topologyGraph(sectors, edges).get(current.id) ?? [];
  return neighbors.length >= 3 || reachable.filter(sector => !sector.discovered).length >= 2
    || current.exits?.length > 0;
}

function topologyGraph(sectors, edges) {
  const graph = new Map(sectors.map(sector => [sector.id, []]));
  for (const edge of edges ?? []) {
    if (!graph.has(edge?.a) || !graph.has(edge?.b)) continue;
    graph.get(edge.a).push(edge.b);
    graph.get(edge.b).push(edge.a);
  }
  for (const neighbors of graph.values()) neighbors.sort();
  return graph;
}

function stopReason(sector) {
  if (!sector.discovered) return 'fog';
  if (sector.encounter?.status === 'available') return 'encounter';
  if (sector.exits?.length) return 'exit';
  return null;
}

/**
 * A card may cover a small, already-known stretch of a road.  It never looks
 * through fog: a hidden frontier is always the final step, and a known branch
 * is left for a separate card instead of being chosen automatically.
 */
export function travelSegment(current, firstSector, sectors, edges, maxSteps = MAX_TRAVEL_SEGMENT_STEPS) {
  const byId = new Map(sectors.map(sector => [sector.id, sector]));
  const graph = topologyGraph(sectors, edges);
  const route = [firstSector.id];
  let previousId = current.id, cursor = firstSector, reason = stopReason(cursor);

  while (!reason && route.length < maxSteps) {
    // Hidden branches still count as branches: otherwise a card can silently
    // drive past an unexplored turn and later force the party back.  Their IDs,
    // labels and contents never enter the returned route or card markup.
    const forwardIds = (graph.get(cursor.id) ?? [])
      .filter(id => id !== previousId && !route.includes(id));
    if (forwardIds.length !== 1) { reason = 'branch'; break; }
    const forward = byId.get(forwardIds[0]);
    if (!forward?.discovered) { reason = 'fog'; break; }
    previousId = cursor.id;
    cursor = forward;
    route.push(cursor.id);
    reason = stopReason(cursor);
  }

  return { routeSectorIds: route, stopReason: reason ?? (route.length >= maxSteps ? 'distance' : 'branch') };
}

function segmentDetail(length) {
  return `Krótki odcinek: ${length} ${length === 1 ? 'obszar' : length < 5 ? 'obszary' : 'obszarów'}`;
}

export function travelDecisions(areaId, sectors, edges = []) {
  if (!hasTravelDecisions(areaId)) return [];
  const current = sectors.find(sector => sector.current);
  if (!current) return [];
  const compass = ['Wschód','Południowy wschód','Południe','Południowy zachód','Zachód','Północny zachód','Północ','Północny wschód'];
  return sectors.filter(sector => sector.reachable && !sector.current).map((sector, index) => {
    const segment = travelSegment(current, sector, sectors, edges);
    const angle = Math.atan2(sector.y-current.y, sector.x-current.x);
    const direction = compass[(Math.round(angle/(Math.PI/4))+8)%8];
    const known = sector.discovered;
    const entrance = known && sector.exits.some(exit => exit.targetAreaId === 'act1.den_of_evil');
    const onward = known && sector.exits.some(exit => exit.targetAreaId === 'act1.cold_plains');
    return {
      sectorId: sector.id, number: index+1, direction,
      title: entrance ? 'Wejście do Siedliska Zła' : onward ? 'Przejście do Zimnej Równiny' : known ? 'Odkryty obszar' : areaId === 'act1.den_of_evil' ? 'Zbadaj przejście' : 'Nieodkryty obszar',
      detail: !known ? 'Nieodkryty obszar' : sector.encounter?.status === 'available' ? 'Znane spotkanie' : 'Odkryty obszar',
      ...segment,
      segmentDetail: segmentDetail(segment.routeSectorIds.length),
    };
  });
}
