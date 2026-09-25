import { ACT1_ENCOUNTERS, ACT1_MONSTERS } from '../../data/act1-encounters.v057.js';
import { CombatState } from './combat.js';
import { HexGrid } from './hex-grid.js';
import { BattlePreparationState, UNIT_PRESENCE } from './battle-preparation.js';
import { PortalSystem } from './portals.js';
import { AI_PROFILE_IDS } from './ai-profiles.js';
import { isGeneratedBloodMoorEncounter } from './random-act1-encounter.js';

const key = p => `${p.q},${p.r}`;
const sortIds = (a, b) => a.localeCompare(b, 'en');

function approvedConfig(input) {
  const index = ACT1_ENCOUNTERS.findIndex(config => config.id === input?.id);
  const config = ACT1_ENCOUNTERS[index];
  if (index < 0 && isGeneratedBloodMoorEncounter(input)) {
    return { config: structuredClone(input), encounterNumber: input.encounterNumber };
  }
  if (!config || input.areaId !== config.areaId || !Array.isArray(input.monsters)
    || input.monsters.length !== config.monsters.length
    || input.monsters.some((monster, i) => monster.id !== config.monsters[i].id
      || monster.profileId !== config.monsters[i].profileId
      || monster.position?.q !== config.monsters[i].position.q
      || monster.position?.r !== config.monsters[i].position.r)) {
    throw new Error('Nieznana lub zmieniona konfiguracja starcia Aktu I');
  }
  // Internal encounter 1 belongs to the dormant legacy training field. Campaign
  // encounters start at 2, preserving preparation's established dead-hero rules.
  return { config, encounterNumber: index + 2 };
}

/** Stages an entire encounter graph. The caller owns campaign/visited/reward gating.
 * Character records, inventory, resources, XP, source geometry and the old graph are untouched.
 */
export function stageAct1Encounter({ config: input, roster, party, players, combat, preparation,
  hexGrid, portals, initialPositions, deploymentColumnOf }) {
  const { config, encounterNumber } = approvedConfig(input);
  if (combat.encounterId === config.id) throw new Error('To starcie jest już bieżącym starciem');
  if (roster !== party.roster || JSON.stringify(party.slots) !== JSON.stringify(preparation.heroIds)) {
    throw new Error('Niezgodny skład drużyny i przygotowania');
  }
  const snapshot = combat.snapshot();
  if (snapshot.commands.active.length || snapshot.projectiles.active.length || snapshot.scheduler.queue.length
    || snapshot.readiness.currentActorId || hexGrid.reservations().length) {
    throw new Error('Najpierw rozlicz pozostałe zdarzenia walki');
  }
  const oldMonsters = [...combat.units.values()].filter(unit => unit.kind === 'monster');
  const untouchedTraining = preparation.phase === 'preparation' && preparation.encounterNumber === 1
    && combat.encounterId === 'combat' && combat.commandSequence === 0 && combat.transactionSequence === 0
    && oldMonsters.length === 1 && oldMonsters[0].id === 'fallen-1'
    && oldMonsters[0].hp === oldMonsters[0].maxHp && !oldMonsters[0].rewardsGranted;
  if (preparation.phase !== 'completed' && !untouchedTraining) throw new Error('Najpierw zakończ bieżące starcie');
  if (preparation.phase === 'completed' && oldMonsters.some(unit => unit.hp > 0 || !unit.rewardsGranted)) {
    throw new Error('Poprzednie starcie nie ma rozliczonego zwycięstwa');
  }
  const living = party.activeCharacters().filter(hero => hero.lifeState === 'alive' && hero.resources.hp > 0);
  if (!living.length) throw new Error('Brak żywych bohaterów — nie można rozpocząć starcia');
  const livingIds = new Set(living.map(hero => hero.id));
  const nextGrid = HexGrid.restore({ ...hexGrid.snapshot(), units: [], reservations: [] });
  const available = nextGrid.tiles().filter(tile => preparation.isDeploymentHex(tile) && !nextGrid.isBlocked(tile));
  const used = new Set();
  const take = preferred => {
    const free = p => p && nextGrid.has(p) && preparation.isDeploymentHex(p) && !nextGrid.isBlocked(p) && !used.has(key(p));
    const tile = free(preferred) ? preferred : available.find(free);
    if (!tile) throw new Error('Brak legalnych pól do rozstawienia drużyny');
    used.add(key(tile));
    return { q: tile.q, r: tile.r };
  };
  const positions = new Map(living.map(hero => [hero.id, take(initialPositions?.get(hero.id))]));
  const survivingSummons = preparation.listSummons().filter(summon => {
    const unit = combat.units.get(summon.id);
    return summon.persistent && unit?.alive !== false && unit?.hp !== 0;
  }).map(summon => ({ ...summon, position: take(summon.position) }));
  for (const summon of survivingSummons) positions.set(summon.id, summon.position);
  const prepSnapshot = preparation.snapshot();
  if (!Number.isSafeInteger(prepSnapshot.actionSequence + 1)) throw new Error('Przekroczony licznik przygotowania');
  prepSnapshot.phase = 'preparation';
  prepSnapshot.activation = null;
  prepSnapshot.encounterNumber = encounterNumber;
  prepSnapshot.actionSequence += 1;
  prepSnapshot.heroPresence = prepSnapshot.heroIds.map(heroId => ({
    heroId, state: livingIds.has(heroId) ? UNIT_PRESENCE.ON_FIELD : UNIT_PRESENCE.OFF_FIELD,
  }));
  prepSnapshot.positions = [...positions].sort(([a], [b]) => sortIds(a, b)).map(([unitId, p]) => ({ unitId, ...p }));
  prepSnapshot.summons = survivingSummons.sort((a, b) => sortIds(a.id, b.id));
  prepSnapshot.buffs = [];
  const nextPreparation = BattlePreparationState.restore(prepSnapshot, { deploymentColumnOf });
  const nextCombat = new CombatState({ party, playersSetting: players, seed: combat.seed, battleId: config.id, encounterId: config.id });
  const nextPortals = PortalSystem.fromJSON(portals.toJSON());
  for (const portal of nextPortals.listActivePortals()) nextPortals.closePortal(portal.portal_id, 'next_encounter');
  for (const hero of living) {
    const position = positions.get(hero.id);
    nextGrid.addUnit({ id: hero.id, position });
    nextCombat.units.get(hero.id).position = { ...position };
    nextPortals.setCharacterLocation(hero.id, { kind: 'area', area_id: config.areaId, instance_id: config.id, hex: position });
  }
  // Dead active heroes travel with the campaign party but stay off-field. The
  // location identity must still belong to this encounter for native save validation.
  for (const id of party.slots.filter(id => !livingIds.has(id))) {
    const previousHex = portals.locationOf(id)?.hex;
    const preferred = initialPositions?.get(id) ?? previousHex;
    const hex = preferred && nextGrid.has(preferred) ? preferred : nextGrid.tiles()[0];
    nextPortals.setCharacterLocation(id, { kind: 'area', area_id: config.areaId, instance_id: config.id, hex });
  }
  for (const summon of survivingSummons) {
    const prior = combat.units.get(summon.id);
    nextGrid.addUnit({ id: summon.id, position: summon.position });
    nextCombat.spawnSummon({
      id: summon.id, ownerId: summon.ownerId,
      sourceSkillId: prior?.sourceSkillId ?? summon.skillId ?? 'SOURCE_DATA_NOT_FOUND',
      summonType: summon.kind, petType: prior?.petType ?? summon.kind,
      sourceMonsterCode: prior?.sourceMonsterCode ?? 'SOURCE_DATA_NOT_FOUND',
      position: summon.position, encounterId: config.id,
      hp: prior?.hp ?? null, maxHp: prior?.maxHp ?? prior?.hp ?? null,
      aiProfile: prior?.aiProfile ?? 'melee_random',
      statInputs: prior?.statInputs ?? null, sourceData: prior?.sourceData ?? null,
    });
  }
  const enemyAiById = {};
  let enemy = null;
  for (const entry of config.monsters) {
    const profile = ACT1_MONSTERS[entry.profileId];
    if (!profile || !nextGrid.has(entry.position) || nextGrid.isBlocked(entry.position)
      || nextPreparation.isDeploymentHex(entry.position)) throw new Error('Nielegalne rozstawienie przeciwnika');
    const unit = nextCombat.spawnMonster({
      id: entry.id, name: profile.name, sourceMonsterCode: profile.id,
      baseHp: profile.baseHp, baseExperience: profile.baseExperience, position: entry.position,
    });
    nextGrid.addUnit({ id: unit.id, position: unit.position });
    enemyAiById[unit.id] = { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null };
    enemy ??= unit;
  }
  const endTime = Math.max(combat.scheduler.time, ...[...combat.units.values()].map(unit => unit.readyAt));
  nextCombat.scheduler.advanceTo(endTime);
  nextCombat.scheduler.sequence = combat.scheduler.sequence;
  nextCombat.readinessSequence = Math.max(nextCombat.readinessSequence, combat.readinessSequence);
  for (const unit of nextCombat.units.values()) unit.readyAt = endTime;
  nextCombat.log = [...combat.log, `${config.label}: przygotuj drużynę.`];
  return { combat: nextCombat, enemy, enemyAiById, hexGrid: nextGrid, preparation: nextPreparation,
    portals: nextPortals, actingUnitId: living[0].id };
}
