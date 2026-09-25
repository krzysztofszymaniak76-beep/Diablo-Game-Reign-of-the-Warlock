import { DIFFICULTIES } from "./constants.js";
import { ACT1_ENCOUNTERS } from '../../data/act1-encounters.v057.js';
import { ENCOUNTER_LOOT_BASES } from './encounter-loot.js';
import { InventoryGrid } from './inventory-grid.js';
import { createEquipmentItem, validateEquipmentItem, validateEquipmentWorld, findInventorySpace } from './equipment.js';
import { validateCharacterProgression } from './progression.js';
import { ACT1_EXPLORATION_AREAS, act1Area } from '../../data/act1-exploration.v058.js';
import {
  areaMapForWorld,
  createExplorationState,
  ensureExplorationArea,
  explorationPoint,
  explorationSectorView,
  findOpenTerrainPath,
  generateAreaMap,
  isOpenTerrainSegmentPassable,
  migrateExplorationState,
  migrateRandomEncounterRolls,
  openTerrainSectorAt,
  revealAroundSector,
  revealPathToSector,
  shortestSectorPath,
  unlockedTransition,
  validateExplorationState,
} from './exploration.js';
import { rollBloodMoorEncounter } from './random-act1-encounter.js';

export const ACT1_WORLD_SCHEMA_VERSION = 3;
const CAMP = 'act1.rogue_encampment';
const DEN = 'act1.den_of_evil';
const DEN_REWARD_KEY = `normal:${DEN}`;
const LEGACY_DEN_REWARD_KEY = 'normal:den_of_evil';
const clone = value => structuredClone(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const encounterById = new Map(ACT1_ENCOUNTERS.map(e => [e.id, e]));
const monsterById = new Map();
let monsterIndex = 0;
ACT1_ENCOUNTERS.forEach((encounter, index) => encounter.monsters.forEach(monster => {
  monsterById.set(monster.id, { monster, encounter, encounterNumber: index + 1,
    lootBase: ENCOUNTER_LOOT_BASES[monsterIndex++ % ENCOUNTER_LOOT_BASES.length] });
}));

function exactKeys(value, keys, label) {
  if (!record(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Nieprawidłowy schemat: ${label}`);
}

function newAct1World(worldSeed, difficulty) {
  return { schemaVersion: ACT1_WORLD_SCHEMA_VERSION, currentAreaId: CAMP,
    visitedAreaIds: [CAMP], currentEncounterId: null,
    encounters: Object.fromEntries(ACT1_ENCOUNTERS.map(e => [e.id,
      { status: 'unvisited', defeatedIds: [], drops: [] }])),
    exploration: createExplorationState({ worldSeed, difficulty, areaId: CAMP }),
  };
}

function stableIndex(text, length) {
  let value = 0x811c9dc5;
  for (const char of String(text)) { value ^= char.codePointAt(0); value = Math.imul(value, 0x01000193) >>> 0; }
  return length ? value % length : 0;
}

function randomEncounterConfigs(world, worldSeed, difficulty) {
  const configs = [];
  for (const [areaId, areaState] of Object.entries(world.exploration.areaStates ?? {})) {
    for (const [sectorId, savedRoll] of Object.entries(areaState.randomEncounterRolls ?? {})) {
      if (savedRoll?.outcome !== 'encounter') continue;
      const generated = rollBloodMoorEncounter({ worldSeed, difficulty, sectorId });
      if (areaId !== 'act1.blood_moor' || JSON.stringify(savedRoll) !== JSON.stringify(generated.result) || !generated.config) {
        throw new Error(`Niespójny zapis losowego spotkania: ${areaId}/${sectorId}`);
      }
      configs.push(generated.config);
    }
  }
  return configs.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function encounterConfigsForWorld(world, worldSeed, difficulty) {
  return [...ACT1_ENCOUNTERS, ...randomEncounterConfigs(world, worldSeed, difficulty)];
}

function encounterInfoForWorld(world, worldSeed, difficulty) {
  const result = new Map(monsterById);
  for (const config of randomEncounterConfigs(world, worldSeed, difficulty)) {
    for (const monster of config.monsters) result.set(monster.id, {
      monster, encounter: config, encounterNumber: config.encounterNumber - 1,
      lootBase: ENCOUNTER_LOOT_BASES[stableIndex(monster.id, ENCOUNTER_LOOT_BASES.length)],
    });
  }
  return result;
}

function rollFirstEntryEncounter(world, map, sectorId, worldSeed, difficulty) {
  if (map.areaId !== 'act1.blood_moor') return null;
  const state = world.exploration.areaStates[map.areaId];
  if (state.randomEncounterRolls[sectorId] !== undefined
    || map.encounters.some(item => item.sectorId === sectorId)) return null;
  const sampled = rollBloodMoorEncounter({ worldSeed, difficulty, sectorId });
  state.randomEncounterRolls[sectorId] = clone(sampled.result);
  if (sampled.config) world.encounters[sampled.config.id] = { status: 'unvisited', defeatedIds: [], drops: [] };
  return sampled.config;
}

function markSafeEntrySector(world, map, sectorId) {
  if (map.areaId !== 'act1.blood_moor') return;
  const state = world.exploration.areaStates[map.areaId];
  if (state.randomEncounterRolls[sectorId] !== undefined
    || map.encounters.some(item => item.sectorId === sectorId)
    || !map.exits.some(exit => exit.sectorId === sectorId)) return;
  // Portals are transition points, not newly explored field fragments. Keep
  // the arrival sector safe and stable; rolls begin when the party walks on.
  state.randomEncounterRolls[sectorId] = { outcome: 'safe-entry' };
}

function dynamicEncounterAtSector(world, map, sectorId, worldSeed, difficulty) {
  return randomEncounterConfigs(world, worldSeed, difficulty)
    .find(config => config.areaId === map.areaId && config.sectorId === sectorId) ?? null;
}

function encounterAtSector(world, map, sectorId, worldSeed, difficulty) {
  return map.encounters.find(item => item.sectorId === sectorId)
    ?? dynamicEncounterAtSector(world, map, sectorId, worldSeed, difficulty);
}

function migrateAct1World(input, { worldSeed, difficulty }) {
  if (!record(input)) throw new Error('Nieprawidłowy świat Aktu I');
  if (input.schemaVersion === ACT1_WORLD_SCHEMA_VERSION) return clone(input);
  if (input.schemaVersion === 2) {
    exactKeys(input, ['schemaVersion', 'currentAreaId', 'visitedAreaIds', 'currentEncounterId', 'encounters', 'exploration'], 'świat Aktu I v2');
    const next = clone(input);
    next.schemaVersion = ACT1_WORLD_SCHEMA_VERSION;
    return next;
  }
  if (input.schemaVersion !== 1) throw new Error(`Nieobsługiwany schemat świata Aktu I: ${input.schemaVersion}`);
  exactKeys(input, ['schemaVersion', 'currentAreaId', 'visitedAreaIds', 'currentEncounterId', 'encounters'], 'dawny świat Aktu I');
  const next = clone(input);
  next.schemaVersion = ACT1_WORLD_SCHEMA_VERSION;
  next.exploration = createExplorationState({ worldSeed, difficulty, areaId: CAMP });
  for (const areaId of input.visitedAreaIds ?? []) {
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) continue;
    const map = ensureExplorationArea(next.exploration, { worldSeed, difficulty, areaId });
    const state = next.exploration.areaStates[areaId];
    if (!state.discoveredSectorIds.includes(map.startSectorId)) state.discoveredSectorIds.push(map.startSectorId);
    revealAroundSector(next.exploration, map, map.startSectorId);
  }
  if (Object.hasOwn(ACT1_EXPLORATION_AREAS, input.currentAreaId)) {
    const map = ensureExplorationArea(next.exploration, { worldSeed, difficulty, areaId: input.currentAreaId });
    const placement = map.encounters.find(item => item.encounterId === input.currentEncounterId);
    next.exploration.currentSectorId = placement?.sectorId ?? map.startSectorId;
    revealPathToSector(next.exploration, map, next.exploration.currentSectorId);
    if (placement && input.encounters?.[placement.encounterId]?.status === 'active') {
      next.exploration.activeBattle = { encounterId: placement.encounterId, areaId: input.currentAreaId, sectorId: placement.sectorId };
    }
  }
  for (const [areaId, state] of Object.entries(next.exploration.areaStates)) {
    const map = generateAreaMap({ worldSeed, areaId, difficulty, generatorVersion: next.exploration.generatorVersion });
    for (const sectorId of state.discoveredSectorIds) {
      if (!map.encounters.some(item => item.sectorId === sectorId)) state.randomEncounterRolls[sectorId] = { outcome: 'legacy-empty' };
    }
  }
  return next;
}

function validateDrop(drop, info, catalog) {
  exactKeys(drop, ['id', 'enemyId', 'encounterId', 'areaId', 'instanceId', 'encounterNumber',
    'hex', 'item', 'status', 'collectorId'], 'łup Aktu I');
  const id = `act1.loot.${info.monster.id}`;
  if (drop.id !== id || drop.enemyId !== info.monster.id || drop.encounterId !== info.encounter.id
    || drop.areaId !== info.encounter.areaId || drop.instanceId !== info.encounter.id
    || drop.encounterNumber !== info.encounterNumber || !['ground', 'collected'].includes(drop.status)
    || (drop.status === 'ground' ? drop.collectorId !== null : !nonEmpty(drop.collectorId))) {
    throw new Error(`Niespójna tożsamość łupu: ${id}`);
  }
  exactKeys(drop.hex, ['q', 'r'], 'heks łupu');
  if (!Number.isSafeInteger(drop.hex.q) || !Number.isSafeInteger(drop.hex.r)) throw new Error('Nieprawidłowy heks łupu');
  const item = drop.item;
  exactKeys(item, ['id', 'canonicalId', 'name', 'width', 'height', 'quality', 'equipmentVersion',
    'baseCode', 'defense', 'durability', 'maxDurability'], 'przedmiot łupu');
  if (item.id !== id || item.canonicalId !== info.lootBase || !nonEmpty(item.name) || !nonEmpty(item.baseCode)
    || item.quality !== 'normal' || item.equipmentVersion !== 1
    || !Number.isSafeInteger(item.width) || item.width < 1 || item.width > 10
    || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 4
    || ['defense', 'durability', 'maxDurability'].some(key => !Number.isSafeInteger(item[key]) || item[key] < 0)
    || item.durability !== item.maxDurability) throw new Error(`Nieprawidłowy przedmiot łupu: ${id}`);
  if (catalog) {
    validateEquipmentItem(item, catalog);
    const expected = createEquipmentItem(catalog, info.lootBase, id);
    for (const [key, value] of Object.entries(expected)) {
      if (item[key] !== value) throw new Error(`Zmieniony wynik łupu: ${id} / ${key}`);
    }
  }
}

function validateAct1(world, catalog, { worldSeed, difficulty } = {}) {
  exactKeys(world, ['schemaVersion', 'currentAreaId', 'visitedAreaIds', 'currentEncounterId', 'encounters', 'exploration'], 'świat Aktu I');
  if (world.schemaVersion !== ACT1_WORLD_SCHEMA_VERSION) throw new Error(`Nieobsługiwany schemat świata Aktu I: ${world.schemaVersion}`);
  if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, world.currentAreaId) || !Array.isArray(world.visitedAreaIds)
    || world.visitedAreaIds.some(id => !Object.hasOwn(ACT1_EXPLORATION_AREAS, id))
    || new Set(world.visitedAreaIds).size !== world.visitedAreaIds.length
    || !world.visitedAreaIds.includes(CAMP) || !world.visitedAreaIds.includes(world.currentAreaId)
    || (world.visitedAreaIds.includes('act1.den_of_evil') && !world.visitedAreaIds.includes('act1.blood_moor'))) {
    throw new Error('Niespójny rejestr odwiedzonych lokacji');
  }
  const encounterConfigs = encounterConfigsForWorld(world, worldSeed, difficulty);
  const configById = new Map(encounterConfigs.map(config => [config.id, config]));
  exactKeys(world.encounters, encounterConfigs.map(e => e.id), 'rejestr starć Aktu I');
  const infoByMonsterId = encounterInfoForWorld(world, worldSeed, difficulty);
  const active = [];
  for (const config of encounterConfigs) {
    const state = world.encounters[config.id];
    exactKeys(state, ['status', 'defeatedIds', 'drops'], 'stan starcia');
    const legal = new Set(config.monsters.map(m => m.id));
    if (!['unvisited', 'active', 'completed'].includes(state.status) || !Array.isArray(state.defeatedIds)
      || state.defeatedIds.some(id => !legal.has(id)) || new Set(state.defeatedIds).size !== state.defeatedIds.length
      || !Array.isArray(state.drops) || state.drops.length !== state.defeatedIds.length) {
      throw new Error(`Niespójny rejestr przeciwników: ${config.id}`);
    }
    if ((state.status === 'unvisited' && state.defeatedIds.length !== 0)
      || (state.status === 'completed' && state.defeatedIds.length !== config.monsters.length)
      || (state.status === 'active' && state.defeatedIds.length >= config.monsters.length)
      || (state.status !== 'unvisited' && !world.visitedAreaIds.includes(config.areaId))) {
      throw new Error(`Niespójny stan starcia: ${config.id}`);
    }
    const dropsSeen = new Set();
    for (const drop of state.drops) {
      if (!record(drop) || !state.defeatedIds.includes(drop.enemyId) || dropsSeen.has(drop.enemyId)) {
        throw new Error(`Łup bez jednoznacznego pokonania przeciwnika: ${config.id}`);
      }
      validateDrop(drop, infoByMonsterId.get(drop.enemyId), catalog);
      dropsSeen.add(drop.enemyId);
    }
    if (state.status === 'active') active.push(config.id);
  }
  if (world.currentEncounterId !== null && (!configById.has(world.currentEncounterId)
    || world.encounters[world.currentEncounterId].status === 'unvisited')) {
    throw new Error('Nieprawidłowa tożsamość bieżącego starcia');
  }
  if (active.length > 1 || (active.length === 1 && (world.currentEncounterId !== active[0]
    || configById.get(active[0]).areaId !== world.currentAreaId))) throw new Error('Niespójne aktywne starcie');
  if (world.currentEncounterId === null && encounterConfigs.some(e => world.encounters[e.id].status !== 'unvisited')) {
    throw new Error('Brak tożsamości ostatniego starcia');
  }
  validateExplorationState(world.exploration, { worldSeed, difficulty, currentAreaId: world.currentAreaId, encounters: world.encounters });
  if (active.length === 0 && world.exploration.activeBattle !== null) throw new Error('Eksploracja przechowuje nieaktywną walkę');
  return true;
}

function requireNormalAct1(campaign) {
  if (campaign.act !== 1 || campaign.difficulty !== 'normal') throw new Error('Ta trasa obsługuje obecnie Akt I na Normal');
}

function pendingEncounterAtCurrentSector(world, map) {
  const sectorId = world.exploration.currentSectorId;
  const authored = map.encounters.find(item => item.sectorId === sectorId);
  if (authored && world.encounters[authored.encounterId]?.status === 'unvisited') return authored;
  const roll = world.exploration.areaStates[map.areaId]?.randomEncounterRolls?.[sectorId];
  if (roll?.outcome === 'encounter' && world.encounters[roll.encounterId]?.status === 'unvisited') {
    return { encounterId: roll.encounterId, sectorId };
  }
  return null;
}

function requireNoPendingEncounter(world, map) {
  if (pendingEncounterAtCurrentSector(world, map)) throw new Error('Najpierw rozpocznij odkryte starcie');
}

function denCounts(world) {
  const encounters = ACT1_ENCOUNTERS.filter(e => e.areaId === DEN);
  const total = encounters.reduce((sum, e) => sum + e.monsters.length, 0);
  const killed = encounters.reduce((sum, e) => sum + world.encounters[e.id].defeatedIds.length, 0);
  return { total, killed, remaining: total - killed };
}

function validatePartyIds(partyIds) {
  if (!Array.isArray(partyIds) || partyIds.length < 1 || partyIds.length > 3
    || partyIds.some(id => !nonEmpty(id)) || new Set(partyIds).size !== partyIds.length) {
    throw new Error('Wymagane są identyfikatory 1–3 różnych aktywnych bohaterów');
  }
  return [...partyIds];
}

function denRewardReceipt(hero) {
  if (!record(hero.questRewards)) throw new Error('Nieprawidłowy rejestr nagród bohatera');
  const receipts = [DEN_REWARD_KEY, LEGACY_DEN_REWARD_KEY].filter(key => Object.hasOwn(hero.questRewards, key))
    .map(key => ({ key, value: hero.questRewards[key] }));
  for (const { value } of receipts) {
    if (!record(value) || value.skillPoints !== 1) throw new Error('Nieprawidłowe potwierdzenie nagrody Siedliska Zła');
    if (Object.hasOwn(value, 'schemaVersion')) {
      exactKeys(value, ['schemaVersion', 'skillPoints', 'respecAvailable', 'respecUsable'], 'nagroda Siedliska Zła');
      if (value.schemaVersion !== 1 || value.respecAvailable !== true || value.respecUsable !== false) {
        throw new Error('Nieobsługiwany schemat nagrody Siedliska Zła');
      }
    } else if (Object.hasOwn(value, 'respecAvailable') && typeof value.respecAvailable !== 'boolean') {
      throw new Error('Nieprawidłowe dawne uprawnienie do resetu');
    }
  }
  return receipts.find(receipt => receipt.key === DEN_REWARD_KEY) ?? receipts[0] ?? null;
}

function validateDenQuest(world, questState, { roster = null, allowPendingCompletion = false } = {}) {
  if (!record(questState)) throw new Error('Nieprawidłowy rejestr zadań');
  const present = Object.hasOwn(questState, DEN), quest = present ? questState[DEN] : null;
  if (present) {
    exactKeys(quest, ['schemaVersion', 'status', 'eligibleHeroIds', 'claimedHeroIds', 'completionEvidence'], 'zadanie Siedlisko Zła');
    if (quest.schemaVersion !== 1) throw new Error(`Nieobsługiwany schemat zadania Siedlisko Zła: ${quest.schemaVersion}`);
    if (!['active', 'objective-complete', 'reward-claimed'].includes(quest.status)
      || !['none', 'final-kill-party', 'legacy-party-unavailable'].includes(quest.completionEvidence)
      || !Array.isArray(quest.eligibleHeroIds) || quest.eligibleHeroIds.length > 3
      || quest.eligibleHeroIds.some(id => !nonEmpty(id)) || new Set(quest.eligibleHeroIds).size !== quest.eligibleHeroIds.length
      || !Array.isArray(quest.claimedHeroIds) || new Set(quest.claimedHeroIds).size !== quest.claimedHeroIds.length
      || quest.claimedHeroIds.some(id => !quest.eligibleHeroIds.includes(id))) throw new Error('Niespójne uprawnienia zadania Siedlisko Zła');
    const { remaining } = denCounts(world);
    if (quest.status === 'active') {
      if (quest.completionEvidence !== 'none' || quest.eligibleHeroIds.length || quest.claimedHeroIds.length
        || (remaining === 0 && !allowPendingCompletion)) throw new Error('Aktywne zadanie nie zgadza się ze stanem Siedliska Zła');
    } else {
      if (remaining !== 0 || quest.completionEvidence === 'none') throw new Error('Cel Siedliska Zła nie został wykonany');
      if (quest.completionEvidence === 'legacy-party-unavailable') {
        if (quest.status !== 'objective-complete' || quest.eligibleHeroIds.length || quest.claimedHeroIds.length) {
          throw new Error('Brak dawnego składu nie pozwala przypisać nagrody nowym bohaterom');
        }
      } else if (!quest.eligibleHeroIds.length
        || (quest.status === 'reward-claimed') !== (quest.claimedHeroIds.length === quest.eligibleHeroIds.length)) {
        throw new Error('Stan odbioru nagrody nie zgadza się z uprawnieniami');
      }
    }
  }
  if (roster) {
    const heroes = roster.toJSON(), byId = new Map(heroes.map(hero => [hero.id, hero]));
    if (present) for (const id of quest.eligibleHeroIds) if (!byId.has(id)) throw new Error('Uprawniony bohater nie istnieje w rosterze');
    for (const hero of heroes) {
      const receipt = denRewardReceipt(hero);
      const claimed = present && quest.claimedHeroIds.includes(hero.id);
      if (claimed && !receipt) throw new Error('Odebrana nagroda nie ma osobistego potwierdzenia');
      if (receipt?.value.schemaVersion === 1 && (!claimed || !quest.eligibleHeroIds.includes(hero.id))) {
        throw new Error('Osobista nagroda nie ma uprawnienia w zadaniu');
      }
    }
  }
  return true;
}

function requireCamp(campaign) {
  requireNormalAct1(campaign);
  const world = campaign.ensureAct1();
  validateDenQuest(world, campaign.questState);
  if (world.currentAreaId !== CAMP || Object.values(world.encounters).some(e => e.status === 'active')) {
    throw new Error('Ta rozmowa z Akarą wymaga bezpiecznego obozu');
  }
  return world;
}

export class CampaignState {
  #pendingDenCompletion = false;
  constructor({ act = 1, difficulty = "normal", worldSeed = 0x5a17c9e3 } = {}) {
    if (!Number.isInteger(act) || act < 1 || act > 5) throw new RangeError("Act must be 1-5");
    if (!DIFFICULTIES.includes(difficulty)) throw new RangeError(`Unknown difficulty: ${difficulty}`);
    this.act = act;
    this.difficulty = difficulty;
    this.worldSeed = worldSeed >>> 0;
    this.unlockedActs = [1];
    this.unlockedDifficulties = ["normal"];
    this.waypoints = {};
    this.questState = {};
    this.act1 = newAct1World(this.worldSeed, this.difficulty);
  }

  /** Only a missing legacy field is migrated. Malformed/future data is never reset. */
  ensureAct1() {
    if (!Object.hasOwn(this, 'act1')) this.act1 = newAct1World(this.worldSeed, this.difficulty);
    else if ([1, 2].includes(this.act1?.schemaVersion)) this.act1 = migrateAct1World(this.act1, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    if ([1, 2].includes(this.act1?.exploration?.schemaVersion)) this.act1.exploration = migrateExplorationState(
      this.act1.exploration, { worldSeed: this.worldSeed, difficulty: this.difficulty, currentAreaId: this.act1.currentAreaId });
    migrateRandomEncounterRolls(this.act1.exploration, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    validateAct1(this.act1, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    return this.act1;
  }

  travelAct1(areaId) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    requireNoPendingEncounter(world, areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty }));
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)
      || !act1Area(world.currentAreaId).connections.includes(areaId)
      || !unlockedTransition(world.currentAreaId, areaId)) throw new Error('Brak legalnego połączenia między lokacjami');
    if (Object.values(world.encounters).some(e => e.status === 'active')) throw new Error('Najpierw zakończ aktywne starcie');
    const staged = clone(world);
    const previousAreaId = staged.currentAreaId;
    staged.currentAreaId = areaId;
    if (!staged.visitedAreaIds.includes(areaId)) staged.visitedAreaIds.push(areaId);
    const map = ensureExplorationArea(staged.exploration, { worldSeed: this.worldSeed, difficulty: this.difficulty, areaId });
    const returnExit = map.exits.find(exit => exit.targetAreaId === previousAreaId);
    staged.exploration.currentSectorId = returnExit?.sectorId ?? map.startSectorId;
    staged.exploration.currentPosition = explorationPoint(areaId,
      map.sectors.find(sector => sector.id === staged.exploration.currentSectorId));
    revealAroundSector(staged.exploration, map, staged.exploration.currentSectorId);
    markSafeEntrySector(staged, map, staged.exploration.currentSectorId);
    staged.exploration.movementSequence += 1;
    // Keep the last completed battle identity: its runtime graph can remain
    // dormant while the player visits town or another area.
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    return clone(act1Area(areaId));
  }

  act1ExplorationMap(areaId = this.ensureAct1().currentAreaId) {
    const world = this.ensureAct1();
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) throw new Error('Nieznana lokacja');
    return generateAreaMap({ worldSeed: this.worldSeed, areaId, difficulty: this.difficulty,
      generatorVersion: world.exploration.generatorVersion });
  }

  act1ExplorationView() {
    const world = this.ensureAct1(), map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    const extraEncounters = randomEncounterConfigs(world, this.worldSeed, this.difficulty)
      .filter(config => config.areaId === world.currentAreaId)
      .map(config => ({ encounterId: config.id, sectorId: config.sectorId,
        encounterKind: config.encounterKind, label: config.label }));
    return { map, sectors: explorationSectorView({ map, state: world.exploration, encounters: world.encounters, extraEncounters }) };
  }

  act1Encounter(id = this.ensureAct1().currentEncounterId) {
    const world = this.ensureAct1();
    const config = encounterConfigsForWorld(world, this.worldSeed, this.difficulty).find(entry => entry.id === id);
    return config ? clone(config) : null;
  }

  act1EncounterNumber(id = this.ensureAct1().currentEncounterId) {
    const config = this.act1Encounter(id);
    if (!config) return null;
    const authoredIndex = ACT1_ENCOUNTERS.findIndex(entry => entry.id === id);
    return authoredIndex >= 0 ? authoredIndex + 2 : config.encounterNumber;
  }

  moveAct1Sector(sectorId, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (world.exploration.activeBattle || Object.values(world.encounters).some(e => e.status === 'active')) {
      throw new Error('Podczas aktywnej walki mapa jest tylko podglądem');
    }
    if ((expectedAreaId !== undefined && expectedAreaId !== world.currentAreaId)
      || (expectedSectorId !== undefined && expectedSectorId !== world.exploration.currentSectorId)
      || (expectedSequence !== undefined && expectedSequence !== world.exploration.movementSequence)) {
      throw new Error('Nieaktualne polecenie ruchu');
    }
    const map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    requireNoPendingEncounter(world, map);
    const path = shortestSectorPath(map, world.exploration.currentSectorId, sectorId);
    if (!path || path.length !== 2) throw new Error('Można przejść tylko do połączonego sąsiedniego sektora');
    const staged = clone(world);
    rollFirstEntryEncounter(staged, map, sectorId, this.worldSeed, this.difficulty);
    staged.exploration.currentSectorId = sectorId;
    staged.exploration.currentPosition = explorationPoint(world.currentAreaId,
      map.sectors.find(sector => sector.id === sectorId));
    staged.exploration.movementSequence += 1;
    revealAroundSector(staged.exploration, map, sectorId);
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    const encounter = encounterAtSector(staged, map, sectorId, this.worldSeed, this.difficulty);
    const encounterId = encounter?.encounterId ?? encounter?.id ?? null;
    return { areaId: staged.currentAreaId, sectorId, encounterId,
      encounterStatus: encounterId ? staged.encounters[encounterId].status : null,
      encounterKind: encounter?.encounterKind ?? 'authored',
      exits: clone(map.exits.filter(exit => exit.sectorId === sectorId)),
      points: clone(map.points.filter(point => point.sectorId === sectorId)) };
  }

  /**
   * Applies a short presentation-selected route as the same sequence of
   * ordinary, adjacent sector moves.  The command is atomic: an invalid or
   * stale later step never leaves an earlier step committed.  An unvisited
   * encounter or an exit is a hard stop, so a card can never jump past either.
   */
  moveAct1Route(sectorIds, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    if (!Array.isArray(sectorIds) || sectorIds.length < 1 || sectorIds.some(id => !nonEmpty(id))) {
      throw new Error('Nieprawidłowy odcinek podróży');
    }
    const staged = CampaignState.restoreAct1(this.toJSON());
    const traversedSectorIds = [];
    let identity = { expectedAreaId, expectedSectorId, expectedSequence };
    let result = null;
    let stoppedBy = 'route-end';

    for (const sectorId of sectorIds) {
      result = staged.moveAct1Sector(sectorId, identity);
      traversedSectorIds.push(sectorId);
      if (result.encounterId && result.encounterStatus === 'unvisited') {
        stoppedBy = 'encounter';
        break;
      }
      if (result.exits.length) {
        stoppedBy = 'exit';
        break;
      }
      identity = {
        expectedAreaId: result.areaId,
        expectedSectorId: result.sectorId,
        expectedSequence: staged.act1.exploration.movementSequence,
      };
    }

    this.act1 = staged.act1;
    return { ...result, traversedSectorIds, stoppedBy };
  }

  /** Follow only the route known before departure, stopping at anything needing a decision. */
  moveAct1KnownRoute(targetSectorId, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (expectedAreaId !== world.currentAreaId
      || expectedSectorId !== world.exploration.currentSectorId
      || expectedSequence !== world.exploration.movementSequence) {
      throw new Error('Nieaktualne polecenie ruchu');
    }
    if (world.exploration.activeBattle || Object.values(world.encounters).some(e => e.status === 'active')) {
      throw new Error('Podczas aktywnej walki mapa jest tylko podglądem');
    }
    const map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    requireNoPendingEncounter(world, map);
    const known = world.exploration.areaStates[world.currentAreaId].discoveredSectorIds;
    const path = shortestSectorPath(map, world.exploration.currentSectorId, targetSectorId, known);
    if (!path || path.length < 2) throw new Error('Brak odkrytej legalnej trasy do celu');

    const staged = CampaignState.restoreAct1(this.toJSON());
    const degree = new Map(map.sectors.map(sector => [sector.id, 0]));
    for (const edge of map.edges) {
      degree.set(edge.a, degree.get(edge.a) + 1);
      degree.set(edge.b, degree.get(edge.b) + 1);
    }
    const traversedSectorIds = [];
    let result = null, stoppedBy = 'route-end';
    for (const sectorId of path.slice(1)) {
      const identity = {
        expectedAreaId: staged.act1.currentAreaId,
        expectedSectorId: staged.act1.exploration.currentSectorId,
        expectedSequence: staged.act1.exploration.movementSequence,
      };
      result = staged.moveAct1Sector(sectorId, identity);
      traversedSectorIds.push(sectorId);
      if (result.encounterId && result.encounterStatus === 'unvisited') stoppedBy = 'encounter';
      else if (result.exits.length) stoppedBy = 'exit';
      else if (result.points.length) stoppedBy = 'point';
      else if (sectorId !== targetSectorId && degree.get(sectorId) > 2) stoppedBy = 'branch';
      if (stoppedBy !== 'route-end') break;
    }
    this.act1 = staged.act1;
    return { ...result, traversedSectorIds, stoppedBy };
  }

  /** Plan a walk over the actual open ground, not the old one-dimensional route graph. */
  planAct1OpenTerrain(target, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (world.currentAreaId !== 'act1.blood_moor') throw new Error('Swobodny ruch dotyczy otwartego Wrzosowiska');
    if (expectedAreaId !== world.currentAreaId || expectedSectorId !== world.exploration.currentSectorId
      || expectedSequence !== world.exploration.movementSequence) throw new Error('Nieaktualne polecenie ruchu');
    if (world.exploration.activeBattle || Object.values(world.encounters).some(e => e.status === 'active')) {
      throw new Error('Podczas aktywnej walki mapa jest tylko podglądem');
    }
    const map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    requireNoPendingEncounter(world, map);
    const points = findOpenTerrainPath(map, world.exploration.currentPosition, target);
    if (!points) throw new Error('Cel leży poza przechodnim terenem lub za nieprzechodnią przeszkodą');
    let stopIndex = points.length - 1;
    for (let index = 1; index < points.length; index += 1) {
      const sectorId = openTerrainSectorAt(map, points[index]);
      if (map.encounters.some(item => item.sectorId === sectorId
        && world.encounters[item.encounterId].status === 'unvisited')
        || (sectorId !== world.exploration.currentSectorId
          && (map.exits.some(item => item.sectorId === sectorId)
            || map.points.some(item => item.sectorId === sectorId)))) {
        stopIndex = index;
        break;
      }
    }
    return { areaId: world.currentAreaId, from: clone(world.exploration.currentPosition),
      pathPoints: points.slice(0, stopIndex + 1), movementSequence: world.exploration.movementSequence };
  }

  /** Commit exactly one planned walk step so position, fog and battle trigger advance together. */
  advanceAct1OpenTerrain(nextPoint, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (world.currentAreaId !== 'act1.blood_moor') throw new Error('Swobodny ruch dotyczy otwartego Wrzosowiska');
    if (expectedAreaId !== world.currentAreaId || expectedSectorId !== world.exploration.currentSectorId
      || expectedSequence !== world.exploration.movementSequence) throw new Error('Nieaktualne polecenie ruchu');
    if (world.exploration.activeBattle || Object.values(world.encounters).some(e => e.status === 'active')) {
      throw new Error('Podczas aktywnej walki mapa jest tylko podglądem');
    }
    const map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    requireNoPendingEncounter(world, map);
    const from = world.exploration.currentPosition;
    if (!nextPoint || !Number.isFinite(nextPoint.x) || !Number.isFinite(nextPoint.y)) throw new Error('Nieprawidłowy punkt ruchu');
    const distance = Math.hypot(nextPoint.x - from.x, nextPoint.y - from.y);
    if (distance < 1e-7 || distance > 24 + 1e-7 || !isOpenTerrainSegmentPassable(map, from, nextPoint)) {
      throw new Error('Krok przecina przeszkodę lub jest zbyt długi');
    }
    const sectorId = openTerrainSectorAt(map, nextPoint);
    if (!sectorId) throw new Error('Nieprzechodni punkt ruchu');
    const staged = clone(world);
    const before = new Set(staged.exploration.areaStates[world.currentAreaId].discoveredSectorIds);
    const enteredNewSector = sectorId !== world.exploration.currentSectorId;
    if (enteredNewSector) rollFirstEntryEncounter(staged, map, sectorId, this.worldSeed, this.difficulty);
    staged.exploration.currentPosition = { x: nextPoint.x, y: nextPoint.y };
    staged.exploration.currentSectorId = sectorId;
    staged.exploration.movementSequence += 1;
    revealAroundSector(staged.exploration, map, sectorId);
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    const encountered = encounterAtSector(staged, map, sectorId, this.worldSeed, this.difficulty);
    const encounterId = encountered?.encounterId ?? encountered?.id ?? null;
    const encounterStatus = encounterId ? staged.encounters[encounterId].status : null;
    const exits = map.exits.filter(item => item.sectorId === sectorId);
    const points = map.points.filter(item => item.sectorId === sectorId);
    return { areaId: staged.currentAreaId, position: clone(staged.exploration.currentPosition),
      sectorId, movementSequence: staged.exploration.movementSequence,
      newlyDiscoveredSectorIds: staged.exploration.areaStates[world.currentAreaId].discoveredSectorIds
        .filter(id => !before.has(id)),
      encounterId, encounterStatus, encounterKind: encountered?.encounterKind ?? 'authored', exits: clone(exits), points: clone(points),
      stoppedBy: encounterStatus === 'unvisited' ? 'encounter'
        : enteredNewSector && exits.length ? 'exit' : enteredNewSector && points.length ? 'point' : null };
  }

  travelThroughAct1Exit(targetAreaId, { expectedAreaId, expectedSectorId, expectedSequence } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (world.exploration.activeBattle || Object.values(world.encounters).some(e => e.status === 'active')) {
      throw new Error('Najpierw zakończ aktywne starcie');
    }
    if ((expectedAreaId !== undefined && expectedAreaId !== world.currentAreaId)
      || (expectedSectorId !== undefined && expectedSectorId !== world.exploration.currentSectorId)
      || (expectedSequence !== undefined && expectedSequence !== world.exploration.movementSequence)) {
      throw new Error('Nieaktualne przejście między obszarami');
    }
    const sourceMap = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    requireNoPendingEncounter(world, sourceMap);
    const exit = sourceMap.exits.find(item => item.sectorId === world.exploration.currentSectorId && item.targetAreaId === targetAreaId);
    if (!exit) throw new Error('W bieżącym sektorze nie ma takiego wyjścia');
    if (!unlockedTransition(world.currentAreaId, targetAreaId)) throw new Error('To przejście wymaga mechaniki zadania, która nie jest jeszcze wdrożona');
    const staged = clone(world), previousAreaId = world.currentAreaId;
    staged.currentAreaId = targetAreaId;
    if (!staged.visitedAreaIds.includes(targetAreaId)) staged.visitedAreaIds.push(targetAreaId);
    const targetMap = ensureExplorationArea(staged.exploration, { worldSeed: this.worldSeed, difficulty: this.difficulty, areaId: targetAreaId });
    const returnExit = targetMap.exits.find(item => item.targetAreaId === previousAreaId);
    staged.exploration.currentSectorId = returnExit?.sectorId ?? targetMap.startSectorId;
    staged.exploration.currentPosition = explorationPoint(targetAreaId,
      targetMap.sectors.find(sector => sector.id === staged.exploration.currentSectorId));
    revealAroundSector(staged.exploration, targetMap, staged.exploration.currentSectorId);
    markSafeEntrySector(staged, targetMap, staged.exploration.currentSectorId);
    staged.exploration.movementSequence += 1;
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    return { area: clone(act1Area(targetAreaId)), sectorId: staged.exploration.currentSectorId };
  }

  activateCurrentWaypoint() {
    requireNormalAct1(this);
    const world = this.ensureAct1(), map = areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    const point = map.points.find(item => item.kind === 'waypoint' && item.sectorId === world.exploration.currentSectorId);
    if (!point) throw new Error('W bieżącym sektorze nie ma waypointu');
    const staged = clone(world), state = staged.exploration.areaStates[world.currentAreaId];
    if (!state.activatedWaypointIds.includes(point.id)) state.activatedWaypointIds.push(point.id);
    const stagedWaypoints = clone(this.waypoints);
    stagedWaypoints[world.currentAreaId] = true;
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged; this.waypoints = stagedWaypoints;
    return clone(point);
  }

  /** Travel only between two already activated, source-backed Act I waypoints. */
  travelViaWaypoint(areaId) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    if (world.exploration.activeBattle || Object.values(world.encounters).some(encounter => encounter.status === 'active')) {
      throw new Error('Najpierw zakończ aktywne starcie');
    }
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) throw new Error('Nieznany cel waypointu');
    if (areaId === world.currentAreaId) throw new Error('Waypoint celu musi prowadzić do innej lokacji');
    requireNoPendingEncounter(world, areaMapForWorld(world, { worldSeed: this.worldSeed, difficulty: this.difficulty }));

    const activatedWaypoint = candidateAreaId => {
      const area = act1Area(candidateAreaId);
      if (area.waypoint !== true || !world.visitedAreaIds.includes(candidateAreaId)
        || this.waypoints[candidateAreaId] !== true) return null;
      const areaState = world.exploration.areaStates[candidateAreaId];
      if (!areaState) return null;
      const map = generateAreaMap({ worldSeed: this.worldSeed, areaId: candidateAreaId, difficulty: this.difficulty,
        generatorVersion: world.exploration.generatorVersion });
      const point = map.points.find(candidate => candidate.kind === 'waypoint');
      if (!point || !areaState.activatedWaypointIds.includes(point.id)
        || !areaState.discoveredSectorIds.includes(point.sectorId)) return null;
      return { area, point };
    };

    const source = activatedWaypoint(world.currentAreaId);
    if (!source) throw new Error('Waypoint bieżącej lokacji nie jest aktywowany');
    if (world.exploration.currentSectorId !== source.point.sectorId) {
      throw new Error('Podróż wymaga obecności w sektorze aktywowanego waypointu');
    }
    const target = activatedWaypoint(areaId);
    if (!target) throw new Error('Waypoint celu nie jest aktywowany');

    const staged = clone(world);
    staged.currentAreaId = areaId;
    staged.exploration.currentSectorId = target.point.sectorId;
    const targetMap = generateAreaMap({ worldSeed: this.worldSeed, areaId, difficulty: this.difficulty,
      generatorVersion: staged.exploration.generatorVersion });
    staged.exploration.currentPosition = explorationPoint(areaId,
      targetMap.sectors.find(sector => sector.id === target.point.sectorId));
    staged.exploration.movementSequence += 1;
    revealAroundSector(staged.exploration, targetMap, target.point.sectorId);
    rollFirstEntryEncounter(staged, targetMap, target.point.sectorId, this.worldSeed, this.difficulty);
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    return { area: clone(target.area), sectorId: target.point.sectorId, waypoint: clone(target.point) };
  }

  nextAct1Encounter(areaId = this.ensureAct1().currentAreaId) {
    const world = this.ensureAct1();
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) throw new Error('Nieznana lokacja');
    const config = encounterConfigsForWorld(world, this.worldSeed, this.difficulty)
      .find(e => e.areaId === areaId && world.encounters[e.id].status === 'unvisited');
    return config ? clone(config) : null;
  }

  beginAct1Encounter(id, { sectorId } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1(), config = encounterConfigsForWorld(world, this.worldSeed, this.difficulty).find(entry => entry.id === id);
    if (!config || config.areaId !== world.currentAreaId || world.encounters[id].status !== 'unvisited') {
      throw new Error('Nie można rozpocząć tego starcia w bieżącej lokacji');
    }
    if (Object.values(world.encounters).some(e => e.status === 'active')) throw new Error('Inne starcie nadal trwa');
    const staged = clone(world);
    const map = areaMapForWorld(staged, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    const placement = map.encounters.find(item => item.encounterId === id)
      ?? (config.sectorId ? { encounterId: config.id, sectorId: config.sectorId } : null);
    if (!placement) throw new Error('Spotkanie nie ma sektora na mapie');
    if (sectorId !== undefined && (sectorId !== placement.sectorId || sectorId !== staged.exploration.currentSectorId)) {
      throw new Error('Spotkanie nie należy do bieżącego sektora');
    }
    // Calls without sectorId are the explicit v0.5.7 compatibility route used
    // by old tests/saves.  The UI always supplies the current sector identity.
    if (sectorId === undefined && staged.exploration.currentSectorId !== placement.sectorId) {
      staged.exploration.currentSectorId = placement.sectorId;
      staged.exploration.currentPosition = explorationPoint(config.areaId,
        map.sectors.find(sector => sector.id === placement.sectorId));
      revealPathToSector(staged.exploration, map, placement.sectorId);
    }
    staged.currentEncounterId = id;
    staged.encounters[id].status = 'active';
    staged.exploration.activeBattle = { encounterId: id, areaId: config.areaId, sectorId: placement.sectorId };
    validateAct1(staged, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    return clone(config);
  }

  /** Caller verifies combat HP=0 and publishes this staged campaign with EXP atomically. */
  recordAct1Defeat(monsterId, { hex, catalog } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1(), info = encounterInfoForWorld(world, this.worldSeed, this.difficulty).get(monsterId);
    if (!info || !catalog) throw new Error('Pokonanie wymaga znanego przeciwnika i katalogu łupu');
    validateAct1(world, catalog, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    const previous = world.encounters[info.encounter.id];
    if (previous.defeatedIds.includes(monsterId)) return { recorded: false,
      drop: clone(previous.drops.find(d => d.enemyId === monsterId)),
      completed: previous.status === 'completed', encounterId: info.encounter.id };
    if (world.currentEncounterId !== info.encounter.id || world.currentAreaId !== info.encounter.areaId
      || previous.status !== 'active') throw new Error('Przeciwnik nie należy do aktywnego starcia');
    const staged = clone(world), state = staged.encounters[info.encounter.id], id = `act1.loot.${monsterId}`;
    const drop = { id, enemyId: monsterId, encounterId: info.encounter.id, areaId: info.encounter.areaId,
      instanceId: info.encounter.id, encounterNumber: info.encounterNumber, hex: clone(hex),
      item: createEquipmentItem(catalog, info.lootBase, id), status: 'ground', collectorId: null };
    state.defeatedIds.push(monsterId);
    state.drops.push(drop);
    if (state.defeatedIds.length === info.encounter.monsters.length) {
      state.status = 'completed';
      staged.exploration.activeBattle = null;
    }
    validateAct1(staged, catalog, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    this.act1 = staged;
    if (info.encounter.areaId === DEN && denCounts(staged).remaining === 0) this.#pendingDenCompletion = true;
    return { recorded: true, drop: clone(drop), completed: state.status === 'completed', encounterId: info.encounter.id };
  }

  /** Rendering never accepts/completes a quest or infers its historical party. */
  denQuestView() {
    const world = Object.hasOwn(this, 'act1') ? this.act1 : newAct1World(this.worldSeed, this.difficulty);
    validateAct1(world, undefined, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    validateDenQuest(world, this.questState);
    const counts = denCounts(world), quest = this.questState[DEN];
    return { status: quest?.status ?? (counts.remaining === 0 ? 'objective-complete' : 'available'),
      ...counts, eligibleHeroIds: [...(quest?.eligibleHeroIds ?? [])], claimedHeroIds: [...(quest?.claimedHeroIds ?? [])],
      completionEvidence: quest?.completionEvidence ?? (counts.remaining === 0 ? 'legacy-party-unavailable' : 'none') };
  }

  acceptDenQuest(partyIds) {
    const world = requireCamp(this);
    validatePartyIds(partyIds);
    if (Object.hasOwn(this.questState, DEN)) return this.denQuestView();
    const complete = denCounts(world).remaining === 0;
    const staged = clone(this.questState);
    staged[DEN] = { schemaVersion: 1, status: complete ? 'objective-complete' : 'active',
      eligibleHeroIds: [], claimedHeroIds: [], completionEvidence: complete ? 'legacy-party-unavailable' : 'none' };
    validateDenQuest(world, staged);
    this.questState = staged;
    return this.denQuestView();
  }

  /** Call immediately after the actual defeat transaction, on this same instance. */
  reconcileDenQuest(partyIds) {
    requireNormalAct1(this);
    const world = this.ensureAct1(), ids = validatePartyIds(partyIds), counts = denCounts(world);
    validateDenQuest(world, this.questState, { allowPendingCompletion: this.#pendingDenCompletion });
    const previous = this.questState[DEN];
    if (previous && previous.status !== 'active') return this.denQuestView();
    // Killing monsters is world progress, not an implicit conversation with
    // Akara.  Without an accepted quest there is no active quest record and no
    // party entitlement to infer.
    if (!previous) return this.denQuestView();
    const staged = clone(this.questState);
    staged[DEN] = counts.remaining === 0
      ? { schemaVersion: 1, status: 'objective-complete',
        eligibleHeroIds: this.#pendingDenCompletion ? ids : [], claimedHeroIds: [],
        completionEvidence: this.#pendingDenCompletion ? 'final-kill-party' : 'legacy-party-unavailable' }
      : { schemaVersion: 1, status: 'active', eligibleHeroIds: [], claimedHeroIds: [], completionEvidence: 'none' };
    validateDenQuest(world, staged);
    this.questState = staged;
    this.#pendingDenCompletion = false;
    return this.denQuestView();
  }

  /** One atomic conversation distributes only recorded personal entitlements. */
  claimDenReward(roster) {
    const world = requireCamp(this);
    validateDenQuest(world, this.questState, { roster });
    const quest = this.questState[DEN];
    if (!quest || quest.status === 'active') throw new Error('Najpierw oczyść Siedlisko Zła');
    if (quest.completionEvidence === 'legacy-party-unavailable') return [];
    if (quest.status === 'reward-claimed') return [];
    const stagedQuestState = clone(this.questState), stagedQuest = stagedQuestState[DEN], heroes = roster.toJSON();
    const stagedHeroes = new Map(heroes.map(hero => [hero.id, hero])), awards = [];
    for (const id of stagedQuest.eligibleHeroIds) {
      if (stagedQuest.claimedHeroIds.includes(id)) continue;
      const hero = stagedHeroes.get(id);
      if (!hero) throw new Error('Uprawniony bohater nie istnieje w rosterze');
      validateCharacterProgression(hero);
      // Legacy receipts remain authoritative: do not infer that their old point
      // was missing, and do not silently reissue it through a renamed quest key.
      if (!denRewardReceipt(hero)) {
        if (!Number.isSafeInteger(hero.unspentSkillPoints + 1)) throw new Error('Pula punktów umiejętności przekracza bezpieczny zakres');
        const reward = { schemaVersion: 1, skillPoints: 1, respecAvailable: true, respecUsable: false };
        if (this.grantPersonalReward(hero, DEN, reward)) {
          hero.unspentSkillPoints += 1;
          awards.push({ heroId: id, skillPoints: 1, respecAvailable: true });
        }
      }
      stagedQuest.claimedHeroIds.push(id);
    }
    stagedQuest.status = 'reward-claimed';
    validateDenQuest(world, stagedQuestState, { roster: { toJSON: () => [...stagedHeroes.values()] } });
    // All candidates were checked before publishing any hero's reward or point.
    for (const id of stagedQuest.eligibleHeroIds) {
      const actual = roster.get(id), staged = stagedHeroes.get(id);
      actual.questRewards = staged.questRewards;
      actual.unspentSkillPoints = staged.unspentSkillPoints;
    }
    this.questState = stagedQuestState;
    return awards;
  }

  healAtAkara(roster, partyIds) {
    requireCamp(this);
    const ids = validatePartyIds(partyIds), changes = [];
    for (const id of ids) {
      const hero = clone(roster.get(id));
      validateCharacterProgression(hero);
      if (!['alive', 'corpse', 'dead'].includes(hero.lifeState)
        || (hero.lifeState === 'alive') !== (hero.resources.hp > 0) || hero.resources.maxHp < 1) {
        throw new Error('Stan życia bohatera nie zgadza się z zasobami');
      }
      if (hero.lifeState !== 'alive') continue;
      const hpRestored = hero.resources.maxHp - hero.resources.hp, manaRestored = hero.resources.maxMana - hero.resources.mana;
      if (hpRestored > 0 || manaRestored > 0) changes.push({ heroId: id, hpRestored, manaRestored,
        hp: hero.resources.maxHp, mana: hero.resources.maxMana });
    }
    for (const change of changes) {
      const hero = roster.get(change.heroId);
      hero.resources.hp = change.hp;
      hero.resources.mana = change.mana;
    }
    // There is no stamina runtime in this milestone; no invented stamina field.
    return changes.map(({ heroId, hpRestored, manaRestored }) => ({ heroId, hpRestored, manaRestored }));
  }

  groundAct1Drops(areaId = this.ensureAct1().currentAreaId) {
    const world = this.ensureAct1();
    if (!Object.hasOwn(ACT1_EXPLORATION_AREAS, areaId)) throw new Error('Nieznana lokacja');
    if (areaId !== world.currentAreaId) return [];
    return encounterConfigsForWorld(world, this.worldSeed, this.difficulty).filter(e => e.areaId === areaId)
      .flatMap(e => world.encounters[e.id].drops.filter(d => d.status === 'ground')).map(clone);
  }

  stageAct1Pickup({ dropId, character, inventory, catalog, ownedIds = [], phase } = {}) {
    requireNormalAct1(this);
    const world = this.ensureAct1();
    validateAct1(world, catalog, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    if (!catalog || phase !== 'completed' || act1Area(world.currentAreaId).profile === 'camp'
      || Object.values(world.encounters).some(e => e.status === 'active')) throw new Error('Łup można zebrać po zakończeniu starcia w jego lokacji');
    if (!nonEmpty(character?.id) || character.lifeState !== 'alive' || !(character.resources?.hp > 0)) {
      throw new Error('Łup może zebrać tylko żywy bohater');
    }
    const drop = this.groundAct1Drops().find(d => d.id === dropId);
    if (!drop) throw new Error('Przedmiot nie leży w bieżącej lokacji albo został już zebrany');
    if (new Set(ownedIds).has(dropId) || inventory.items.has(dropId)
      || Object.values(character.equipment).some(item => item.id === dropId)) throw new Error('Powielony identyfikator łupu');
    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const position = findInventorySpace(stagedInventory, drop.item);
    if (!position || !stagedInventory.place(drop.item, position)) throw new Error('Brak miejsca w plecaku — przedmiot pozostaje na ziemi');
    const stagedCampaign = CampaignState.restoreAct1(this.toJSON(), { catalog });
    const updated = stagedCampaign.act1.encounters[drop.encounterId].drops.find(d => d.id === dropId);
    updated.status = 'collected';
    updated.collectorId = character.id;
    validateAct1(stagedCampaign.act1, catalog, { worldSeed: stagedCampaign.worldSeed, difficulty: stagedCampaign.difficulty });
    return { campaign: stagedCampaign, inventory: stagedInventory,
      inventoryItemIds: [...stagedInventory.items.keys()], item: clone(drop.item) };
  }

  validateAct1World({ roster, inventories, catalog, otherOwnedItems = [] }) {
    const world = this.ensureAct1();
    if (!catalog) throw new Error('Walidacja łupu wymaga katalogu wyposażenia');
    validateAct1(world, catalog, { worldSeed: this.worldSeed, difficulty: this.difficulty });
    validateDenQuest(world, this.questState, { roster });
    const ownedIds = validateEquipmentWorld(roster, inventories, catalog), owned = new Map();
    for (const hero of roster.toJSON()) {
      for (const item of [...inventories.get(hero.id).toJSON().items, ...Object.values(hero.equipment)]) owned.set(item.id, item);
    }
    if (!Array.isArray(otherOwnedItems)) throw new TypeError('Dodatkowe przedmioty muszą być tablicą');
    for (const item of otherOwnedItems) {
      if (catalog.get(item.canonicalId)) validateEquipmentItem(item, catalog);
      if (ownedIds.has(item.id)) throw new Error(`Przedmiot ma wielu właścicieli: ${item.id}`);
      ownedIds.add(item.id);
      owned.set(item.id, item);
    }
    const receipts = new Set();
    for (const state of Object.values(world.encounters)) for (const drop of state.drops) {
      if (drop.status === 'ground' && ownedIds.has(drop.id)) throw new Error(`Łup jednocześnie na ziemi i u bohatera: ${drop.id}`);
      if (drop.status === 'collected') {
        if (!roster.has(drop.collectorId) || !ownedIds.has(drop.id)) throw new Error(`Zebrany łup nie ma właściciela: ${drop.id}`);
        const actual = owned.get(drop.id);
        for (const key of ['canonicalId', 'baseCode', 'defense', 'width', 'height', 'quality', 'equipmentVersion', 'maxDurability']) {
          if (actual[key] !== drop.item[key]) throw new Error(`Zmieniona tożsamość zebranego łupu: ${drop.id}`);
        }
        receipts.add(drop.id);
      }
    }
    for (const id of ownedIds) if (id.startsWith('act1.loot.') && !receipts.has(id)) throw new Error(`Przedmiot bez potwierdzenia zebrania: ${id}`);
    return true;
  }

  static restoreAct1(data, { catalog } = {}) {
    if (!record(data)) throw new Error('Nieprawidłowy zapis kampanii');
    const baseKeys = ['act', 'difficulty', 'worldSeed', 'unlockedActs', 'unlockedDifficulties', 'waypoints', 'questState'];
    exactKeys(data, Object.hasOwn(data, 'act1') ? [...baseKeys, 'act1'] : baseKeys, 'kampania');
    if (!Number.isSafeInteger(data.worldSeed) || data.worldSeed < 0 || data.worldSeed > 0xffffffff
      || !Array.isArray(data.unlockedActs) || data.unlockedActs.some(act => !Number.isInteger(act) || act < 1 || act > 5)
      || new Set(data.unlockedActs).size !== data.unlockedActs.length
      || !Array.isArray(data.unlockedDifficulties) || data.unlockedDifficulties.some(d => !DIFFICULTIES.includes(d))
      || new Set(data.unlockedDifficulties).size !== data.unlockedDifficulties.length
      || !record(data.waypoints) || !record(data.questState)) throw new Error('Nieprawidłowy postęp kampanii');
    const campaign = new CampaignState({ act: data.act, difficulty: data.difficulty, worldSeed: data.worldSeed });
    Object.assign(campaign, clone(data));
    campaign.act1 = migrateAct1World(campaign.act1, { worldSeed: campaign.worldSeed, difficulty: campaign.difficulty });
    campaign.act1.exploration = migrateExplorationState(campaign.act1.exploration,
      { worldSeed: campaign.worldSeed, difficulty: campaign.difficulty, currentAreaId: campaign.act1.currentAreaId });
    migrateRandomEncounterRolls(campaign.act1.exploration, { worldSeed: campaign.worldSeed, difficulty: campaign.difficulty });
    validateAct1(campaign.act1, catalog, { worldSeed: campaign.worldSeed, difficulty: campaign.difficulty });
    validateDenQuest(campaign.act1, campaign.questState);
    return campaign;
  }

  static fromJSON(data, options) { return CampaignState.restoreAct1(data, options); }

  grantPersonalReward(character, questId, reward) {
    const key = `${this.difficulty}:${questId}`;
    if (character.questRewards[key]) return false;
    character.questRewards[key] = structuredClone(reward);
    return true;
  }

  toJSON() {
    return structuredClone({ ...this });
  }
}
