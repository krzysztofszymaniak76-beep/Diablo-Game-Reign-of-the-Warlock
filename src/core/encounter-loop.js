import { CombatState } from './combat.js';
import { HexGrid } from './hex-grid.js';
import { BattlePreparationState, UNIT_PRESENCE } from './battle-preparation.js';
import { PortalSystem } from './portals.js';
import { encounterEnemyId, validateLootRecords, ENCOUNTER_INSTANCE_ID } from './encounter-loot.js';

/** Presence change outside combat, without pretending to take a combat turn. */
export function postBattlePresence(preparation,unitId,position,deploymentColumnOf) {
  if(preparation.phase!=='completed' || !preparation.heroIds.includes(unitId)) throw new Error('Zmiana obecności wymaga zakończonego starcia i bohatera');
  const s=preparation.snapshot();
  s.positions=s.positions.filter(p=>p.unitId!==unitId);
  if(position) s.positions.push({unitId,...position});
  s.positions.sort((a,b)=>a.unitId.localeCompare(b.unitId,'en'));
  s.heroPresence=s.heroPresence.map(p=>p.heroId===unitId?{heroId:unitId,state:position?UNIT_PRESENCE.ON_FIELD:UNIT_PRESENCE.OFF_FIELD}:p);
  s.actionSequence+=1;
  return BattlePreparationState.restore(s,{deploymentColumnOf});
}

/** Build the next encounter on a separate graph. Never touch inventory, HP, XP or RNG. */
export function stageNextEncounter({progress,expectedEncounter,catalog,roster,party,players,combat,enemy,
  preparation,hexGrid,portals,initialPositions,deploymentColumnOf,areaId}) {
  validateLootRecords(progress,catalog);
  if(expectedEncounter!==progress.encounterNumber) throw new Error('To polecenie dotyczy poprzedniego starcia');
  if(preparation.phase!=='completed' || enemy.hp!==0 || !enemy.rewardsGranted
    || progress.rewardedCount!==progress.encounterNumber || preparation.encounterNumber!==progress.encounterNumber) {
    throw new Error('Najpierw zakończ bieżące starcie');
  }
  const snapshot=combat.snapshot();
  if(snapshot.commands.active.length || snapshot.projectiles.active.length || snapshot.scheduler.queue.length
    || snapshot.readiness.currentActorId || hexGrid.reservations().length) throw new Error('Najpierw rozlicz pozostałe zdarzenia walki');
  const living=party.activeCharacters().filter(h=>h.lifeState==='alive' && h.resources.hp>0);
  if(!living.length) throw new Error('Brak żywych bohaterów — nie można rozpocząć kolejnego starcia');
  for(const h of living) {
    const location=portals.locationOf(h.id);
    if(location?.kind!=='area' || location.area_id!==areaId || location.instance_id!==ENCOUNTER_INSTANCE_ID
      || !preparation.isUnitOnField(h.id)) throw new Error(`Najpierw sprowadź ${h.name} z miasta na pole`);
  }
  const nextProgress=structuredClone(progress);nextProgress.encounterNumber+=1;
  validateLootRecords(nextProgress,catalog);
  const nextGrid=HexGrid.restore({...hexGrid.snapshot(), units:[], reservations:[]});
  const available=nextGrid.tiles().filter(tile=>preparation.isDeploymentHex(tile));
  const used=new Set(), positions={}, summonPositions={};
  function take(preferred) {
    const free=p=>p && nextGrid.has(p) && preparation.isDeploymentHex(p) && !nextGrid.isBlocked(p) && !used.has(`${p.q},${p.r}`);
    const result=free(preferred)?preferred:available.find(free);
    if(!result) throw new Error('Brak miejsca na rozstawienie drużyny i zachowanych przywołań');
    used.add(`${result.q},${result.r}`);return {...result};
  }
  for(const id of party.slots) positions[id]=take(initialPositions.get(id));
  for(const s of preparation.listSummons()) summonPositions[s.id]=take(s.position);
  let nextPreparation=BattlePreparationState.restore(preparation.snapshot(),{deploymentColumnOf});
  nextPreparation.beginNextBattle({heroPositions:positions,summonPositions});
  // beginNextBattle is already tested for full parties. Keep defeated heroes OFF_FIELD
  // by constructing a canonical snapshot before publication, never reviving their records.
  const dead=new Set(party.slots.filter(id=>!living.some(h=>h.id===id)));
  if(dead.size) {
    const s=nextPreparation.snapshot();
    s.positions=s.positions.filter(p=>!dead.has(p.unitId));
    s.heroPresence=s.heroPresence.map(p=>dead.has(p.heroId)?{heroId:p.heroId,state:UNIT_PRESENCE.OFF_FIELD}:p);
    nextPreparation=BattlePreparationState.restore(s,{deploymentColumnOf});
  }
  const nextCombat=new CombatState({
    party,
    playersSetting:players,
    seed:combat.seed,
    battleId: `${combat.battleId ?? 'combat'}:encounter-${nextProgress.encounterNumber}`,
    encounterId: String(nextProgress.encounterNumber),
  });
  const nextEnemy=nextCombat.spawnMonster({id:encounterEnemyId(nextProgress.encounterNumber),name:'Upadły',
    baseHp:42,baseExperience:24,position:initialPositions.get('fallen-1')});
  nextGrid.addUnit({id:nextEnemy.id,position:nextEnemy.position});
  const nextPortals=PortalSystem.fromJSON(portals.toJSON());
  // All living travelers are back; old endpoints must not offer a free ride into a new encounter.
  for(const p of nextPortals.listActivePortals()) nextPortals.closePortal(p.portal_id,'next_encounter');
  for(const h of living) {
    nextGrid.addUnit({id:h.id,position:positions[h.id]});
    nextCombat.units.get(h.id).position=positions[h.id];
    nextPortals.setCharacterLocation(h.id,{kind:'area',area_id:areaId,instance_id:ENCOUNTER_INSTANCE_ID,hex:positions[h.id]});
  }
  for(const s of nextPreparation.listSummons()) {
    const previousRuntime = combat.units.get(s.id);
    nextGrid.addUnit({id:s.id,position:s.position});
    nextCombat.spawnSummon({
      id: s.id,
      ownerId: s.ownerId,
      sourceSkillId: previousRuntime?.sourceSkillId ?? s.skillId ?? 'SOURCE_DATA_NOT_FOUND',
      summonType: s.kind,
      petType: previousRuntime?.petType ?? s.kind,
      sourceMonsterCode: previousRuntime?.sourceMonsterCode ?? 'SOURCE_DATA_NOT_FOUND',
      position: s.position,
      encounterId: String(nextProgress.encounterNumber),
      hp: previousRuntime?.hp ?? null,
      maxHp: previousRuntime?.maxHp ?? previousRuntime?.hp ?? null,
      aiProfile: previousRuntime?.aiProfile ?? 'melee_random',
      statInputs: previousRuntime?.statInputs ?? null,
      sourceData: previousRuntime?.sourceData ?? null,
    });
  }
  const endTime=Math.max(combat.scheduler.time,...[...combat.units.values()].map(u=>u.readyAt));
  nextCombat.scheduler.advanceTo(endTime);
  nextCombat.scheduler.sequence=combat.scheduler.sequence;
  // Command/transaction IDs are local to CombatState and its complete history.
  // A new encounter owns a fresh history; do not copy counters without that history.
  // Persistent reward/item identities are separately namespaced by encounter number.
  nextCombat.readinessSequence=Math.max(nextCombat.readinessSequence,combat.readinessSequence);
  for(const u of nextCombat.units.values()) u.readyAt=endTime;
  nextCombat.log=[...combat.log,`Starcie ${nextProgress.encounterNumber}: przygotuj drużynę. Życie, mana, EXP, przedmioty i zapasy nie zostały odnowione.`];
  return {progress:nextProgress,combat:nextCombat,enemy:nextEnemy,hexGrid:nextGrid,
    preparation:nextPreparation,portals:nextPortals,actingUnitId:living[0].id};
}
