// Act I exploration topology for the turn-based sector adaptation.
// Canonical ids and sourceLevelId values follow the local area manifest and
// the certified levels.txt snapshot.  Polish labels are used only where the
// existing project already supplied them; other names remain source English
// rather than inventing an unsupported localization.

export const ACT1_EXPLORATION_GENERATOR_VERSION = 1;
export const ACT1_SOURCE_SNAPSHOT_ID =
  'pinkufairy-D2R-Excel-1f16064e09b97e3e65abd6943662207cff00b07f-partial-candidate';
export const ACT1_LEVELS_SHA256 = '67b99ee9c928d758c25a08f3fbc8d2e02acf57f98e5d351567e20a0fdf37427e';

const area = (sourceLevelId, name, options = {}) => Object.freeze({
  id: options.id,
  sourceLevelId,
  sourceName: name,
  label: options.label ?? name,
  labelLocaleStatus: options.labelLocaleStatus ?? (options.label ? 'existing-project-pl' : 'source-english-localization-missing'),
  profile: options.profile ?? 'field',
  generationMode: options.generationMode ?? 'procedural',
  sectorCount: options.sectorCount ?? 72,
  waypoint: options.waypoint ?? false,
  connections: Object.freeze(options.connections ?? []),
  guaranteedPoints: Object.freeze(options.guaranteedPoints ?? []),
  contentStatus: options.contentStatus ?? 'map-ready-content-not-implemented',
  source: Object.freeze({
    snapshotId: ACT1_SOURCE_SNAPSHOT_ID,
    table: 'levels',
    sha256: ACT1_LEVELS_SHA256,
    levelId: sourceLevelId,
  }),
});

const A = {};
const add = (id, sourceLevelId, name, options = {}) => {
  A[id] = area(sourceLevelId, name, { ...options, id });
};

add('act1.rogue_encampment', 1, 'Rogue Encampment', {
  label: 'Obozowisko Łotrzyc', profile: 'camp', generationMode: 'fixed', sectorCount: 24,
  waypoint: true, connections: ['act1.blood_moor'], contentStatus: 'map-ready-town-services-connected',
});
add('act1.blood_moor', 2, 'Blood Moor', {
  label: 'Krwawe Wrzosowisko', profile: 'field', sectorCount: 84,
  connections: ['act1.rogue_encampment', 'act1.cold_plains', 'act1.den_of_evil'],
  contentStatus: 'map-ready-three-encounters-connected',
});
add('act1.cold_plains', 3, 'Cold Plains', {
  profile: 'field', sectorCount: 92, waypoint: true,
  connections: ['act1.blood_moor', 'act1.stony_field', 'act1.burial_grounds', 'act1.cave_1'],
});
add('act1.stony_field', 4, 'Stony Field', {
  profile: 'field', sectorCount: 96, waypoint: true,
  connections: ['act1.cold_plains', 'act1.underground_passage_1', 'act1.tristram'],
  guaranteedPoints: [{ id: 'cairn-stones', kind: 'quest-gate', accessRule: 'cain-portal-unimplemented' }],
});
add('act1.dark_wood', 5, 'Dark Wood', {
  profile: 'forest', sectorCount: 88, waypoint: true,
  connections: ['act1.underground_passage_1', 'act1.black_marsh'],
  guaranteedPoints: [{ id: 'tree-of-inifuss', kind: 'quest-point', implementation: 'marker-only' }],
});
add('act1.black_marsh', 6, 'Black Marsh', {
  profile: 'marsh', sectorCount: 96, waypoint: true,
  connections: ['act1.dark_wood', 'act1.tamoe_highland', 'act1.forgotten_tower', 'act1.hole_1'],
});
add('act1.tamoe_highland', 7, 'Tamoe Highland', {
  profile: 'field', sectorCount: 94,
  connections: ['act1.black_marsh', 'act1.pit_1', 'act1.monastery_gate'],
});
add('act1.den_of_evil', 8, 'Den of Evil', {
  label: 'Siedlisko Zła', profile: 'cave', sectorCount: 48,
  connections: ['act1.blood_moor'], contentStatus: 'map-ready-five-encounters-and-quest-connected',
});
add('act1.cave_1', 9, 'Cave Level 1', {
  profile: 'cave', sectorCount: 46, connections: ['act1.cold_plains', 'act1.cave_2'],
});
add('act1.underground_passage_1', 10, 'Underground Passage Level 1', {
  profile: 'cave', sectorCount: 58,
  connections: ['act1.stony_field', 'act1.dark_wood', 'act1.underground_passage_2'],
});
add('act1.hole_1', 11, 'Hole Level 1', {
  profile: 'cave', sectorCount: 50, connections: ['act1.black_marsh', 'act1.hole_2'],
});
add('act1.pit_1', 12, 'Pit Level 1', {
  profile: 'cave', sectorCount: 58, connections: ['act1.tamoe_highland', 'act1.pit_2'],
});
add('act1.cave_2', 13, 'Cave Level 2', {
  profile: 'cave', generationMode: 'variant', sectorCount: 28, connections: ['act1.cave_1'],
});
add('act1.underground_passage_2', 14, 'Underground Passage Level 2', {
  profile: 'cave', generationMode: 'variant', sectorCount: 30, connections: ['act1.underground_passage_1'],
});
add('act1.hole_2', 15, 'Hole Level 2', {
  profile: 'cave', generationMode: 'variant', sectorCount: 30, connections: ['act1.hole_1'],
});
add('act1.pit_2', 16, 'Pit Level 2', {
  profile: 'cave', generationMode: 'variant', sectorCount: 32, connections: ['act1.pit_1'],
});
add('act1.burial_grounds', 17, 'Burial Grounds', {
  profile: 'cemetery', generationMode: 'variant', sectorCount: 32,
  connections: ['act1.cold_plains', 'act1.crypt', 'act1.mausoleum'],
  guaranteedPoints: [{ id: 'blood-raven-site', kind: 'boss-point', implementation: 'marker-only' }],
});
add('act1.crypt', 18, 'Crypt', { profile: 'crypt', sectorCount: 40, connections: ['act1.burial_grounds'] });
add('act1.mausoleum', 19, 'Mausoleum', { profile: 'crypt', sectorCount: 42, connections: ['act1.burial_grounds'] });
add('act1.forgotten_tower', 20, 'Forgotten Tower', {
  profile: 'tower', generationMode: 'fixed', sectorCount: 18,
  connections: ['act1.black_marsh', 'act1.tower_cellar_1'],
});
add('act1.tower_cellar_1', 21, 'Tower Cellar Level 1', { profile: 'tower', sectorCount: 38, connections: ['act1.forgotten_tower', 'act1.tower_cellar_2'] });
add('act1.tower_cellar_2', 22, 'Tower Cellar Level 2', { profile: 'tower', sectorCount: 42, connections: ['act1.tower_cellar_1', 'act1.tower_cellar_3'] });
add('act1.tower_cellar_3', 23, 'Tower Cellar Level 3', { profile: 'tower', sectorCount: 46, connections: ['act1.tower_cellar_2', 'act1.tower_cellar_4'] });
add('act1.tower_cellar_4', 24, 'Tower Cellar Level 4', { profile: 'tower', sectorCount: 50, connections: ['act1.tower_cellar_3', 'act1.tower_cellar_5'] });
add('act1.tower_cellar_5', 25, 'Tower Cellar Level 5', {
  profile: 'tower', generationMode: 'variant', sectorCount: 28, connections: ['act1.tower_cellar_4'],
  guaranteedPoints: [{ id: 'countess-room', kind: 'boss-point', implementation: 'marker-only' }],
});
add('act1.monastery_gate', 26, 'Monastery Gate', {
  profile: 'monastery', generationMode: 'fixed', sectorCount: 22,
  connections: ['act1.tamoe_highland', 'act1.outer_cloister'],
});
add('act1.outer_cloister', 27, 'Outer Cloister', {
  profile: 'monastery', generationMode: 'variant', sectorCount: 30, waypoint: true,
  connections: ['act1.monastery_gate', 'act1.barracks'],
});
add('act1.barracks', 28, 'Barracks', {
  profile: 'monastery', sectorCount: 54, connections: ['act1.outer_cloister', 'act1.jail_1'],
  guaranteedPoints: [{ id: 'horadric-malus-room', kind: 'quest-point', implementation: 'marker-only' }],
});
add('act1.jail_1', 29, 'Jail Level 1', { profile: 'jail', sectorCount: 54, waypoint: true, connections: ['act1.barracks', 'act1.jail_2'] });
add('act1.jail_2', 30, 'Jail Level 2', { profile: 'jail', sectorCount: 58, connections: ['act1.jail_1', 'act1.jail_3'] });
add('act1.jail_3', 31, 'Jail Level 3', { profile: 'jail', sectorCount: 62, connections: ['act1.jail_2', 'act1.inner_cloister'] });
add('act1.inner_cloister', 32, 'Inner Cloister', {
  profile: 'monastery', generationMode: 'fixed', sectorCount: 20, waypoint: true,
  connections: ['act1.jail_3', 'act1.cathedral'],
});
add('act1.cathedral', 33, 'Cathedral', {
  profile: 'monastery', generationMode: 'fixed', sectorCount: 26,
  connections: ['act1.inner_cloister', 'act1.catacombs_1'],
});
add('act1.catacombs_1', 34, 'Catacombs Level 1', { profile: 'catacombs', sectorCount: 58, connections: ['act1.cathedral', 'act1.catacombs_2'] });
add('act1.catacombs_2', 35, 'Catacombs Level 2', { profile: 'catacombs', sectorCount: 62, waypoint: true, connections: ['act1.catacombs_1', 'act1.catacombs_3'] });
add('act1.catacombs_3', 36, 'Catacombs Level 3', { profile: 'catacombs', sectorCount: 66, connections: ['act1.catacombs_2', 'act1.catacombs_4'] });
add('act1.catacombs_4', 37, 'Catacombs Level 4', {
  profile: 'catacombs', generationMode: 'variant', sectorCount: 30, connections: ['act1.catacombs_3'],
  guaranteedPoints: [{ id: 'andariel-room', kind: 'boss-point', implementation: 'marker-only' }],
});
add('act1.tristram', 38, 'Tristram', {
  profile: 'ruins', generationMode: 'fixed', sectorCount: 30, connections: ['act1.stony_field'],
  guaranteedPoints: [{ id: 'cain-cage', kind: 'quest-point', implementation: 'marker-only' }],
});
add('endgame.secret_cow_level', 39, 'Moo Moo Farm', {
  label: 'Secret Cow Level', labelLocaleStatus: 'existing-manifest-en', profile: 'field', generationMode: 'variant', sectorCount: 78,
  connections: ['act1.rogue_encampment'], contentStatus: 'locked-profile-unimplemented-access-rule',
  guaranteedPoints: [{ id: 'cow-king-site', kind: 'boss-point', implementation: 'marker-only' }],
});

export const ACT1_EXPLORATION_AREAS = Object.freeze(A);

export const ACT1_LOCKED_TRANSITIONS = Object.freeze({
  'act1.stony_field>act1.tristram': 'cain-portal-unimplemented',
  'act1.tristram>act1.stony_field': 'cain-portal-unimplemented',
  'act1.rogue_encampment>endgame.secret_cow_level': 'cow-portal-unimplemented',
  'endgame.secret_cow_level>act1.rogue_encampment': 'cow-portal-unimplemented',
});

export function act1Area(id) {
  const value = ACT1_EXPLORATION_AREAS[id];
  if (!value) throw new Error(`Nieznany obszar Aktu I: ${id}`);
  return value;
}
