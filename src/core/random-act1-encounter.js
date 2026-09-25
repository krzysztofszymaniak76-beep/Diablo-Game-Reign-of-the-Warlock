const BLOOD_MOOR_MONSTERS = Object.freeze(['fallen1', 'zombie1']);
const ENEMY_POSITIONS = Object.freeze([
  Object.freeze({ q: 10, r: 0 }), Object.freeze({ q: 12, r: 0 }),
  Object.freeze({ q: 14, r: 0 }), Object.freeze({ q: 10, r: 1 }),
  Object.freeze({ q: 12, r: 1 }), Object.freeze({ q: 14, r: 1 }),
]);

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
  pick(values) { return values[Math.floor(this.next() * values.length)]; }
}

function sectorNumber(sectorId) {
  const match = /^sector-(\d{3})$/.exec(sectorId);
  if (!match) throw new Error('Nieprawidłowy sektor losowego spotkania');
  return Number(match[1]);
}

/**
 * Each eligible Blood Moor sector gets one deterministic 50/50 roll on first
 * entry. The world seed makes the result reproducible after saving/loading;
 * the caller persists the roll itself so an explored cell is never rerolled.
 */
export function rollBloodMoorEncounter({ worldSeed, difficulty = 'normal', sectorId }) {
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffffffff
    || difficulty !== 'normal') throw new Error('Nieprawidłowe dane losowania spotkania');
  const number = sectorNumber(sectorId);
  const seedBase = `${worldSeed >>> 0}|act1.blood_moor|${sectorId}|${difficulty}|exploration-encounter-v1`;
  const roll = new Stream(hash32(`${seedBase}|chance`));
  if (roll.next() >= 0.5) return { result: { outcome: 'empty' }, config: null };

  const champion = roll.next() < 0.1;
  const count = champion ? 6 : 3;
  const id = `act1.blood_moor.random.${sectorId}`;
  const members = new Stream(hash32(`${seedBase}|members`));
  const monsters = Array.from({ length: count }, (_, index) => ({
    id: `${id}.monster.${String(index + 1).padStart(2, '0')}`,
    profileId: members.pick(BLOOD_MOOR_MONSTERS),
    position: { ...ENEMY_POSITIONS[index] },
  }));
  const encounterKind = champion ? 'champion' : 'normal';
  return {
    result: { outcome: 'encounter', encounterId: id, encounterKind },
    config: {
      id,
      areaId: 'act1.blood_moor',
      sectorId,
      encounterNumber: 9 + number,
      label: champion ? 'Krwawe Wrzosowisko · Champion' : 'Krwawe Wrzosowisko · spotkanie',
      scenarioStatus: 'SEEDED_EXPLORATION_ADAPTATION',
      encounterKind,
      monsters,
    },
  };
}

export function isGeneratedBloodMoorEncounter(input) {
  if (!input || input.areaId !== 'act1.blood_moor' || input.scenarioStatus !== 'SEEDED_EXPLORATION_ADAPTATION'
    || !['normal', 'champion'].includes(input.encounterKind)) return false;
  let generated;
  try {
    const match = /^act1\.blood_moor\.random\.(sector-\d{3})$/.exec(input.id);
    if (!match) return false;
    const sectorId = match[1], number = sectorNumber(sectorId);
    if (input.sectorId !== sectorId || input.encounterNumber !== 9 + number) return false;
    const count = input.encounterKind === 'champion' ? 6 : 3;
    if (!Array.isArray(input.monsters) || input.monsters.length !== count) return false;
    const seenIds = new Set();
    for (const [index, monster] of input.monsters.entries()) {
      if (!monster || monster.id !== `${input.id}.monster.${String(index + 1).padStart(2, '0')}`
        || !BLOOD_MOOR_MONSTERS.includes(monster.profileId)
        || monster.position?.q !== ENEMY_POSITIONS[index].q
        || monster.position?.r !== ENEMY_POSITIONS[index].r
        || seenIds.has(monster.id)) return false;
      seenIds.add(monster.id);
    }
    generated = true;
  } catch { return false; }
  return generated;
}
