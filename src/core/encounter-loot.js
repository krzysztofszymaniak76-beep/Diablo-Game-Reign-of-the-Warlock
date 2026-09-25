import { InventoryGrid } from './inventory-grid.js';
import { createEquipmentItem, validateEquipmentItem, validateEquipmentWorld, findInventorySpace } from './equipment.js';

export const ENCOUNTER_SCHEMA_VERSION = 1;
export const ENCOUNTER_INSTANCE_ID = 'BM-01';
// A small, explicit prototype reward sequence, NOT Diablo TreasureClass/MF/NoDrop.
// Base statistics and inventory dimensions still come from the pinned equipment catalogue.
export const ENCOUNTER_LOOT_BASES = Object.freeze([
  'short_sword', 'leather_gloves', 'boots', 'sash', 'cap', 'buckler', 'quilted_armor', 'hand_axe', 'scepter', 'wand',
]);
const clone = value => structuredClone(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value,min=0) => Number.isSafeInteger(value) && value >= min;
export function encounterEnemyId(number) {
  if (!integer(number,1) || number > 10000) throw new Error('Nieprawidłowy numer starcia (1–10000)');
  return `fallen-${number}`;
}
export function encounterItemId(number) {
  encounterEnemyId(number);
  return number === 1 ? 'short-sword-1' : `bm-01.loot.${number}`;
}
export function encounterLootBase(number) {
  encounterEnemyId(number);
  return ENCOUNTER_LOOT_BASES[(number-1) % ENCOUNTER_LOOT_BASES.length];
}
export function createEncounterProgress() {
  return { schemaVersion: ENCOUNTER_SCHEMA_VERSION, encounterNumber: 1, rewardedCount: 0, drops: [] };
}
export function groundDrops(progress) { return progress.drops.filter(drop => drop.status === 'ground').map(clone); }
export function currentLootMarker(progress) {
  const drop = progress.drops.find(drop => drop.encounterNumber === progress.encounterNumber && drop.status === 'ground');
  return drop ? { id: drop.id, instanceId: drop.instanceId, hex: clone(drop.hex) } : null;
}

/** Validate all drop identities, including collected ones. No re-rolls on save/load. */
export function validateLootRecords(progress, catalog) {
  if (!record(progress) || progress.schemaVersion !== ENCOUNTER_SCHEMA_VERSION) throw new Error('Nieobsługiwany stan łupu/starć');
  encounterEnemyId(progress.encounterNumber);
  if (!integer(progress.rewardedCount) || ![progress.encounterNumber-1,progress.encounterNumber].includes(progress.rewardedCount)
    || !Array.isArray(progress.drops) || progress.drops.length !== progress.rewardedCount) {
    throw new Error('Niespójny rejestr nagród starć');
  }
  const ids = new Set();
  for (let i=0;i<progress.drops.length;i+=1) {
    const d=progress.drops[i], n=i+1;
    if (!record(d) || d.encounterNumber!==n || d.id!==encounterItemId(n) || d.enemyId!==encounterEnemyId(n)
      || d.instanceId!==ENCOUNTER_INSTANCE_ID || !record(d.hex) || !Number.isSafeInteger(d.hex.q) || !Number.isSafeInteger(d.hex.r)
      || !record(d.item) || d.item.id!==d.id || Object.hasOwn(d.item,'position') || ids.has(d.id)
      || !['ground','collected'].includes(d.status)
      || (d.status==='ground' ? d.collectorId!==null : typeof d.collectorId!=='string' || !d.collectorId.trim())) {
      throw new Error(`Nieprawidłowy rekord łupu starcia ${n}`);
    }
    validateEquipmentItem(d.item,catalog);
    const expected=createEquipmentItem(catalog,encounterLootBase(n),d.id);
    // Only ordinary, fully defined items are awarded in this milestone.
    for (const [key,value] of Object.entries(expected)) {
      if (d.item[key]!==value) throw new Error(`Zmieniony wynik łupu: ${d.id} / ${key}`);
    }
    ids.add(d.id);
  }
  return true;
}

export function validateEncounterWorld(progress,{catalog,roster,inventories,hexGrid,enemy,preparation,otherOwnedItems=[]}) {
  validateLootRecords(progress,catalog);
  if (preparation.encounterNumber!==progress.encounterNumber || enemy.id!==encounterEnemyId(progress.encounterNumber)) {
    throw new Error('Numer starcia, przeciwnik i przygotowanie nie zgadzają się');
  }
  const completed=preparation.phase==='completed';
  if (completed ? enemy.hp!==0 || enemy.rewardsGranted!==true || progress.rewardedCount!==progress.encounterNumber
    : enemy.hp<=0 || enemy.rewardsGranted!==false || progress.rewardedCount!==progress.encounterNumber-1) {
    throw new Error('Stan przeciwnika i jednorazowe nagrody są niespójne');
  }
  const ownedIds=validateEquipmentWorld(roster,inventories,catalog);
  const owned=new Map();
  for(const h of roster.toJSON()) {
    for(const item of [...inventories.get(h.id).toJSON().items,...Object.values(h.equipment)]) owned.set(item.id,item);
  }
  if(!Array.isArray(otherOwnedItems)) throw new TypeError('Dodatkowe przedmioty muszą być tablicą');
  for(const item of otherOwnedItems) {
    if(catalog.get(item.canonicalId)) validateEquipmentItem(item,catalog);
    if(ownedIds.has(item.id)) throw new Error(`Przedmiot ma wielu właścicieli: ${item.id}`);
    ownedIds.add(item.id);
    owned.set(item.id,item);
  }
  for(const d of progress.drops) {
    if(!hexGrid.has(d.hex)) throw new Error(`Łup poza planszą: ${d.id}`);
    if(d.status==='ground' && ownedIds.has(d.id)) throw new Error(`Łup jednocześnie na ziemi i w ekwipunku: ${d.id}`);
    if(d.status==='collected') {
      if(!roster.has(d.collectorId) || !ownedIds.has(d.id)) throw new Error(`Zebrany łup nie ma właściciela: ${d.id}`);
      const actual=owned.get(d.id);
      for(const key of ['canonicalId','baseCode','defense']) if(actual[key]!==d.item[key]) throw new Error(`Zmieniona tożsamość zebranego łupu: ${d.id}`);
    }
  }
  // Reserved reward namespace must not appear in a bag without a corresponding receipt.
  const receipts=new Set(progress.drops.filter(d=>d.status==='collected').map(d=>d.id));
  for(const id of ownedIds) if((id==='short-sword-1' || id.startsWith('bm-01.loot.')) && !receipts.has(id)) {
    throw new Error(`Przedmiot bez potwierdzenia zebrania: ${id}`);
  }
  return true;
}

/** Staging only. The caller grants EXP and publishes the graph in one synchronous transaction. */
export function stageVictoryLoot(progress,{enemy,hex,catalog}) {
  validateLootRecords(progress,catalog);
  if(enemy.id!==encounterEnemyId(progress.encounterNumber) || enemy.hp!==0) throw new Error('Łup wymaga pokonania bieżącego przeciwnika');
  if(progress.rewardedCount===progress.encounterNumber) return clone(progress); // repeated reconciliation is harmless
  if(enemy.rewardsGranted) throw new Error('Nagroda przeciwnika była już rozliczona bez potwierdzenia łupu');
  const n=progress.encounterNumber, id=encounterItemId(n);
  const result=clone(progress);
  result.drops.push({id,enemyId:enemy.id,encounterNumber:n,instanceId:ENCOUNTER_INSTANCE_ID,
    hex:clone(hex),item:createEquipmentItem(catalog,encounterLootBase(n),id),status:'ground',collectorId:null});
  result.rewardedCount=n;
  validateLootRecords(result,catalog);
  return result;
}

/** A failed or repeated pickup cannot alter either input. Pickup is a post-combat convenience. */
export function stageLootPickup({progress,dropId,character,inventory,catalog,phase,onField,ownedIds=[]}) {
  validateLootRecords(progress,catalog);
  if(phase!=='completed') throw new Error('Łup można zebrać po zakończeniu starcia');
  if(!onField || character.lifeState!=='alive' || character.resources.hp<=0) throw new Error('Wybierz żywego bohatera obecnego na polu');
  const drop=progress.drops.find(d=>d.id===dropId);
  if(!drop || drop.status!=='ground') throw new Error('Ten przedmiot został już zebrany albo nie istnieje');
  if(new Set(ownedIds).has(drop.id) || inventory.items.has(drop.id) || Object.values(character.equipment).some(i=>i.id===drop.id)) {
    throw new Error('Powielony identyfikator łupu');
  }
  const stagedInventory=InventoryGrid.fromJSON(inventory.toJSON());
  const position=findInventorySpace(stagedInventory,drop.item);
  if(!position || !stagedInventory.place(drop.item,position)) throw new Error('Brak miejsca w plecaku — przedmiot pozostaje na ziemi');
  const stagedProgress=clone(progress);
  const updated=stagedProgress.drops.find(d=>d.id===dropId);
  updated.status='collected';updated.collectorId=character.id;
  validateLootRecords(stagedProgress,catalog);
  return {progress:stagedProgress,inventory:stagedInventory,inventoryItemIds:[...stagedInventory.items.keys()],item:clone(drop.item)};
}

/** Upgrade only the real old marker; never award EXP during migration. */
export function migrateLegacyEncounter({legacyLoot,enemy,preparation,catalog}) {
  if(preparation.encounterNumber!==1 || enemy.id!=='fallen-1') throw new Error('Starszy zapis zawiera nieobsługiwane starcia');
  const progress=createEncounterProgress();
  if(enemy.hp>0) {
    if(legacyLoot!==null || enemy.rewardsGranted!==false) throw new Error('Nieprawidłowy stary stan łupu');
    return progress;
  }
  if(preparation.phase!=='completed' || enemy.rewardsGranted!==true || legacyLoot?.id!=='short-sword-1'
    || legacyLoot.instanceId!==ENCOUNTER_INSTANCE_ID) throw new Error('Nieprawidłowy stary znacznik łupu');
  return stageVictoryLoot(progress,{enemy:{...enemy,rewardsGranted:false},hex:legacyLoot.hex,catalog});
}
