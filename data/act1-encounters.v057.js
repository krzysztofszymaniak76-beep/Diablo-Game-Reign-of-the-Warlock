// A small authored turn-based route, not Diablo II's original map generator.
// Monster values below are the verified Normal baseline. /players scaling is
// deliberately absent: CombatState applies the selected value at spawn once.
const SNAPSHOT_ID = 'pinkufairy-D2R-Excel-1f16064e09b97e3e65abd6943662207cff00b07f-partial-candidate';

export const ACT1_AREAS = Object.freeze({
  'act1.rogue_encampment': Object.freeze({
    id: 'act1.rogue_encampment', label: 'Obozowisko Łotrzyc', type: 'town',
    environment: 'town', sourceAreaId: 1, questId: 'act1.den_of_evil',
    connections: Object.freeze(['act1.blood_moor']),
  }),
  'act1.blood_moor': Object.freeze({
    id: 'act1.blood_moor', label: 'Krwawe Wrzosowisko', type: 'combat',
    environment: 'overworld', sourceAreaId: 2, questId: null,
    connections: Object.freeze(['act1.rogue_encampment', 'act1.den_of_evil']),
  }),
  'act1.den_of_evil': Object.freeze({
    id: 'act1.den_of_evil', label: 'Siedlisko Zła', type: 'combat',
    environment: 'dungeon', sourceAreaId: 8, questId: 'act1.den_of_evil',
    connections: Object.freeze(['act1.blood_moor']),
  }),
});

function monsterProfile({ id, name, englishName, level, minHp, maxHp, baseExperience,
  damageMin, damageMax, sourceUrl, monstatsLine, monlvlLine }) {
  return Object.freeze({
    id, name, englishName, level, difficulty: 'normal', minHp, maxHp,
    // Choosing the top of the verified HP range is an explicit scenario policy.
    // It does not claim to reproduce the original random HP roll.
    baseHp: maxHp, baseExperience, damageMin, damageMax, sourceUrl,
    hpSelection: 'source-range-maximum',
    source: Object.freeze({
      status: 'HISTORICAL_OFFICIAL_BASELINE_MATCHES_LOCAL_SNAPSHOT',
      url: sourceUrl, snapshotId: SNAPSHOT_ID,
      monstats: Object.freeze({ key: id, line: monstatsLine }),
      monlvl: Object.freeze({ level, line: monlvlLine }),
    }),
  });
}

export const ACT1_MONSTERS = Object.freeze({
  fallen1: monsterProfile({
    id: 'fallen1', name: 'Upadły', englishName: 'Fallen', level: 1,
    minHp: 1, maxHp: 4, baseExperience: 18, damageMin: 1, damageMax: 2,
    sourceUrl: 'https://classic.battle.net/diablo2exp/monsters/act1-fallen.shtml',
    monstatsLine: 21, monlvlLine: 3,
  }),
  zombie1: monsterProfile({
    id: 'zombie1', name: 'Zombie', englishName: 'Zombie', level: 1,
    minHp: 7, maxHp: 12, baseExperience: 33, damageMin: 1, damageMax: 3,
    sourceUrl: 'https://classic.battle.net/diablo2exp/monsters/act1-zombie.shtml',
    monstatsLine: 7, monlvlLine: 3,
  }),
  brute1: monsterProfile({
    id: 'brute1', name: 'Olbrzymia bestia', englishName: 'Gargantuan Beast', level: 2,
    minHp: 11, maxHp: 19, baseExperience: 48, damageMin: 2, damageMax: 3,
    sourceUrl: 'https://classic.battle.net/diablo2exp/monsters/act1-wendigo.shtml',
    monstatsLine: 30, monlvlLine: 4,
  }),
});

// Odd-row offsets (10,0), (12,0), (14,0), (10,1), (12,1), (14,1)
// produce these axial coordinates. All six satisfy the existing battlefield
// bounds (-19 <= 11q+r <= 203, -11 <= 3q+7r <= 50), outside deployment.
// In particular, offset (12,3)/(14,3) would be outside the current board.
const ENEMY_POSITIONS = Object.freeze([
  Object.freeze({ q: 10, r: 0 }), Object.freeze({ q: 12, r: 0 }),
  Object.freeze({ q: 14, r: 0 }), Object.freeze({ q: 10, r: 1 }),
  Object.freeze({ q: 12, r: 1 }), Object.freeze({ q: 14, r: 1 }),
]);

function encounter(areaId, number, profileIds) {
  const id = `${areaId}.encounter.${String(number).padStart(2, '0')}`;
  return Object.freeze({
    id, areaId, label: `${ACT1_AREAS[areaId].label} · starcie ${number}`,
    scenarioStatus: 'AUTHORED_TURN_BASED_ADAPTATION',
    monsters: Object.freeze(profileIds.map((profileId, index) => Object.freeze({
      id: `${id}.monster.${String(index + 1).padStart(2, '0')}`,
      profileId, position: ENEMY_POSITIONS[index],
    }))),
  });
}

const MOOR_GROUP = Object.freeze(['fallen1', 'fallen1', 'fallen1', 'zombie1', 'zombie1', 'zombie1']);
const DEN_GROUP = Object.freeze(['zombie1', 'zombie1', 'zombie1', 'brute1', 'brute1', 'brute1']);

export const ACT1_ENCOUNTERS = Object.freeze([
  ...[1, 2, 3].map(number => encounter('act1.blood_moor', number, MOOR_GROUP)),
  ...[1, 2, 3, 4, 5].map(number => encounter('act1.den_of_evil', number, DEN_GROUP)),
]);
