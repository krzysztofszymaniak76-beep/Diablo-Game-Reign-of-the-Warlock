import { InventoryGrid } from './inventory-grid.js';

export const EQUIPMENT_SCHEMA_VERSION = 1;
export const EQUIPMENT_CATALOG_ID = 'equipment-v0.5.1-source-subset-1';
export const EQUIPMENT_SLOTS = Object.freeze(['weapon','offhand','head','chest','hands','belt','feet']);
const clone = value => structuredClone(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`Nieprawidłowe ${label}`);
}
function range(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`Nieprawidłowe ${label}`);
  value.forEach(n => integer(n,label));
  if (value[1] < value[0]) throw new RangeError(`Nieprawidłowy zakres ${label}`);
}

/** Immutable definitions; instance rolls are stored on items, never rerolled on load. */
export class EquipmentCatalog {
  #bases;
  #classes;
  constructor(data) {
    if (data?.schemaVersion !== 1 || data.catalogId !== EQUIPMENT_CATALOG_ID
      || !Array.isArray(data.bases) || !Array.isArray(data.classes) || !nonEmpty(data.snapshotId)) {
      throw new Error('Niezgodny katalog wyposażenia');
    }
    this.id = data.catalogId;
    this.snapshotId = data.snapshotId;
    this.#bases = new Map(); this.#classes = new Map();
    const codes = new Set();
    for (const raw of data.bases) {
      const d = clone(raw);
      if (!nonEmpty(d.id) || !nonEmpty(d.code) || !nonEmpty(d.name) || !nonEmpty(d.displayName)
        || !EQUIPMENT_SLOTS.includes(d.slot) || !['weapon','armor'].includes(d.kind)
        || (d.kind === 'weapon') !== (d.slot === 'weapon')
        || typeof d.twoHanded !== 'boolean' || typeof d.barbarianOneHand !== 'boolean'
        || (d.classOnly !== null && !nonEmpty(d.classOnly))
        || d.source?.snapshotId !== data.snapshotId || !nonEmpty(d.source?.sha256)) {
        throw new Error(`Nieprawidłowa definicja wyposażenia: ${d.id}`);
      }
      if (this.#bases.has(d.id) || codes.has(d.code)) throw new Error(`Powielona baza: ${d.id}`);
      for (const k of ['requiredLevel','requiredStrength','requiredDexterity','durability','strengthBonus','dexterityBonus']) integer(d[k],k);
      integer(d.width,'szerokość',1); integer(d.height,'wysokość',1);
      if (typeof d.stackable !== 'boolean') throw new Error(`Nieprawidłowa flaga stosu: ${d.id}`);
      for (const key of ['minStack','maxStack','spawnStack']) integer(d[key],key);
      if (d.stackable && (d.minStack < 1 || d.maxStack < d.minStack || d.spawnStack < d.minStack || d.spawnStack > d.maxStack)) {
        throw new Error(`Nieprawidłowe ilości stosu: ${d.id}`);
      }
      if (!d.stackable && (d.minStack || d.maxStack || d.spawnStack)) throw new Error(`Baza niestosowalna ma dane stosu: ${d.id}`);
      if (d.width > 10 || d.height > 4) throw new Error('Baza nie mieści się w plecaku 10 × 4');
      range(d.oneHandDamage,'obrażenia jednoręczne'); range(d.twoHandDamage,'obrażenia dwuręczne'); range(d.defenseRange,'obrona');
      this.#bases.set(d.id,freeze(d)); codes.add(d.code);
    }
    for (const raw of data.classes) {
      const c = clone(raw);
      if (!nonEmpty(c.classId) || !plain(c.stats) || this.#classes.has(c.classId)
        || c.source?.snapshotId !== data.snapshotId) throw new Error('Nieprawidłowy profil atrybutów');
      for (const k of ['strength','dexterity','vitality','energy']) integer(c.stats[k],k);
      this.#classes.set(c.classId,freeze(c));
    }
    Object.freeze(this);
  }
  get(id) { return this.#bases.get(id) ?? null; }
  all() { return [...this.#bases.values()]; }
  classProfile(id) { return this.#classes.get(id) ?? null; }
}

function stableRoll(id, min, max) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0),16777619) >>> 0;
  return min + hash % (max - min + 1);
}

export function createEquipmentItem(catalog, canonicalId, id, { position, defense } = {}) {
  const d = catalog.get(canonicalId);
  if (!d) throw new Error(`Brak bazy przedmiotu: ${canonicalId}`);
  if (!nonEmpty(id)) throw new TypeError('Przedmiot wymaga identyfikatora');
  const rolledDefense = defense ?? stableRoll(`${id}:defense`,...d.defenseRange);
  integer(rolledDefense,'obrona');
  if (rolledDefense < d.defenseRange[0] || rolledDefense > d.defenseRange[1]) throw new RangeError('Obrona poza zakresem bazy');
  const item = {
    id, canonicalId, name:d.displayName, width:d.width, height:d.height, quality:'normal',
    equipmentVersion:EQUIPMENT_SCHEMA_VERSION, baseCode:d.code,
    defense:rolledDefense, durability:d.durability, maxDurability:d.durability,
  };
  if (d.stackable) {
    item.quantity = d.spawnStack;
    item.maxQuantity = d.maxStack;
  }
  if (position !== undefined) item.position = clone(position);
  return item;
}

export function validateEquipmentItem(item,catalog) {
  const d = catalog.get(item?.canonicalId);
  if (!d) throw new Error(`Brak obsługi wyposażenia: ${item?.canonicalId ?? 'bez ID'}`);
  if (!nonEmpty(item.id) || item.equipmentVersion !== EQUIPMENT_SCHEMA_VERSION || item.baseCode !== d.code
    || item.quality !== 'normal' || item.width !== d.width || item.height !== d.height || item.maxDurability !== d.durability) {
    throw new Error(`Niezgodny przedmiot: ${item.id}`);
  }
  integer(item.defense,'obrona przedmiotu'); integer(item.durability,'trwałość');
  if (d.stackable) {
    integer(item.quantity,'ilość przedmiotu',1);
    integer(item.maxQuantity,'maksymalna ilość stosu',1);
    if (item.maxQuantity !== d.maxStack || item.quantity > item.maxQuantity) throw new Error(`Nieprawidłowa ilość stosu: ${item.id}`);
  } else if (Object.hasOwn(item,'quantity') || Object.hasOwn(item,'maxQuantity')) {
    throw new Error(`Baza niestosowalna nie może mieć ilości: ${item.id}`);
  }
  if (item.defense < d.defenseRange[0] || item.defense > d.defenseRange[1] || item.durability > d.durability) {
    throw new Error(`Parametry poza zakresem bazy: ${item.id}`);
  }
  // Invalid containers must not hide unsupported modifiers: an object has no .length.
  for (const key of ['sockets', 'properties']) {
    if (item[key] != null && !Array.isArray(item[key])) {
      throw new Error(`Nieprawidłowy format ${key}: ${item.id}`);
    }
  }
  if (item.ethereal != null && typeof item.ethereal !== 'boolean') {
    throw new Error(`Nieprawidłowa eteryczność: ${item.id}`);
  }
  if (Object.hasOwn(item, 'identified') && typeof item.identified !== 'boolean') {
    throw new Error(`Nieprawidłowy stan identyfikacji: ${item.id}`);
  }
  if (item.runewordId != null && !nonEmpty(item.runewordId)) {
    throw new Error(`Nieprawidłowe słowo runiczne: ${item.id}`);
  }
  // Affixes and socket payloads require their own resolver; never silently equip them as a plain base.
  if (item.ethereal || item.runewordId || (item.sockets?.length ?? 0) || (item.properties?.length ?? 0)) {
    throw new Error('Ta wersja obsługuje wyłącznie zwykłe bazy bez modyfikatorów i gniazd');
  }
  return d;
}

export function initializeEquipmentAttributes(character,catalog) {
  const profile = catalog.classProfile(character.classId);
  if (!profile) return false;
  if (character.level === 1 && Object.values(character.stats).every(value => value === 0)) {
    character.stats = clone(profile.stats);
    character.attributeSource = { catalogId:catalog.id, table:'charstats.txt', classId:character.classId };
    return true;
  }
  return false;
}

export function requirementsFor(character,definition) {
  const errors = [];
  if (definition.classOnly && definition.classOnly !== character.classId) errors.push('Przedmiot przeznaczony dla innej klasy');
  if (character.level < definition.requiredLevel) errors.push(`Wymagany poziom ${definition.requiredLevel} (masz ${character.level})`);
  if (character.stats.strength < definition.requiredStrength) errors.push(`Wymagana siła ${definition.requiredStrength} (masz ${character.stats.strength})`);
  if (character.stats.dexterity < definition.requiredDexterity) errors.push(`Wymagana zręczność ${definition.requiredDexterity} (masz ${character.stats.dexterity})`);
  return errors;
}

export function occupiesBothHands(character,definition) {
  return Boolean(definition?.twoHanded && !(definition.barbarianOneHand && character.classId === 'barbarian'));
}

/** No automatic rearrangement: a failed placement leaves the live inventory intact. */
export function findInventorySpace(grid,item) {
  for (let y=0; y<=grid.height-item.height; y+=1) {
    for (let x=0; x<=grid.width-item.width; x+=1) if (grid.canPlace(item,{x,y})) return {x,y};
  }
  return null;
}

export function validateOwnerEquipment(character,inventory,catalog) {
  if (!plain(character.equipment)) throw new Error('Nieprawidłowe wyposażenie postaci');
  const ids = new Set();
  for (const item of inventory.toJSON().items) {
    if (catalog.get(item.canonicalId)) validateEquipmentItem(item,catalog);
    if (ids.has(item.id)) throw new Error(`Powielony przedmiot: ${item.id}`);
    ids.add(item.id);
  }
  for (const [slot,item] of Object.entries(character.equipment)) {
    if (!EQUIPMENT_SLOTS.includes(slot) || !item) throw new Error(`Nieprawidłowy slot: ${slot}`);
    const d = validateEquipmentItem(item,catalog);
    if (slot !== d.slot || Object.hasOwn(item,'position')) throw new Error(`Przedmiot w nieprawidłowym miejscu: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`Powielony przedmiot: ${item.id}`);
    if (requirementsFor(character,d).length) throw new Error(`Niespełnione wymagania: ${item.id}`);
    ids.add(item.id);
  }
  const weapon = character.equipment.weapon;
  if (weapon && character.equipment.offhand && occupiesBothHands(character,catalog.get(weapon.canonicalId))) {
    throw new Error('Broń dwuręczna blokuje drugą dłoń');
  }
  return ids;
}

export function validateEquipmentWorld(roster,inventories,catalog) {
  const ids = new Set();
  for (const character of roster.toJSON()) {
    const grid = inventories.get(character.id);
    if (!grid) throw new Error(`Brak plecaka: ${character.id}`);
    for (const id of validateOwnerEquipment(character,grid,catalog)) {
      if (ids.has(id)) throw new Error(`Przedmiot ma wielu właścicieli: ${id}`);
      ids.add(id);
    }
    const expected = grid.toJSON().items.map(item=>item.id).sort();
    if (JSON.stringify([...character.inventoryItemIds].sort()) !== JSON.stringify(expected)) {
      throw new Error(`Niezgodny indeks plecaka: ${character.id}`);
    }
  }
  return ids;
}

const ownerFingerprint = (character,inventory) => JSON.stringify({
  id:character.id, level:character.level, classId:character.classId, stats:character.stats,
  lifeState:character.lifeState, equipment:character.equipment, inventory:inventory.toJSON(),
});

export function planEquipmentChange({character,inventory,catalog,itemId,slot}) {
  if (character.lifeState !== 'alive' || character.resources.hp <= 0) throw new Error('Martwa postać nie może zmieniać wyposażenia');
  validateOwnerEquipment(character,inventory,catalog);
  if ((itemId == null) === (slot == null)) throw new Error('Wskaż przedmiot do założenia ALBO slot do zdjęcia');
  const grid = InventoryGrid.fromJSON(inventory.toJSON());
  const equipment = clone(character.equipment);
  const returned = [];
  let changedItem;
  const removeSlot = key => {
    if (equipment[key]) { returned.push(equipment[key]); delete equipment[key]; }
  };
  if (itemId != null) {
    changedItem = grid.remove(itemId);
    if (!changedItem) throw new Error('Przedmiotu nie ma w plecaku tego bohatera');
    const d = validateEquipmentItem(changedItem,catalog);
    const requirements = requirementsFor(character,d);
    if (requirements.length) throw new Error(requirements.join(' · '));
    removeSlot(d.slot);
    if (d.slot === 'weapon' && occupiesBothHands(character,d)) removeSlot('offhand');
    if (d.slot === 'offhand' && occupiesBothHands(character,catalog.get(equipment.weapon?.canonicalId))) removeSlot('weapon');
    delete changedItem.position;
    equipment[d.slot] = clone(changedItem);
  } else {
    if (!EQUIPMENT_SLOTS.includes(slot) || !equipment[slot]) throw new Error('Ten slot jest pusty');
    changedItem = clone(equipment[slot]);
    removeSlot(slot);
  }
  returned.sort((a,b)=>(b.width*b.height-a.width*a.height)||(a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // At most two displaced items (weapon + shield). First-fit alone can report
  // a full bag even when a different placement fits. Search only free cells;
  // existing backpack items are never moved or rearranged.
  function placeReturned(index) {
    if (index === returned.length) return true;
    const item = returned[index];
    for (let y = 0; y <= grid.height - item.height; y += 1) {
      for (let x = 0; x <= grid.width - item.width; x += 1) {
        if (!grid.canPlace(item, {x, y})) continue;
        grid.place(item, {x, y});
        if (placeReturned(index + 1)) return true;
        grid.remove(item.id);
      }
    }
    return false;
  }
  if (!placeReturned(0)) throw new Error('Brak miejsca w plecaku — niczego nie zmieniono');
  validateOwnerEquipment({...character,equipment},grid,catalog);
  return freeze({
    ownerId:character.id, before:ownerFingerprint(character,inventory),
    inventory:grid.toJSON(), equipment, changedItem:clone(changedItem),
    action:itemId != null ? 'equip' : 'unequip', returnedIds:returned.map(item=>item.id),
  });
}

/** Synchronous commit; validates again and never exposes an intermediate transfer. */
export function commitEquipmentChange(character,inventory,catalog,plan) {
  if (character.lifeState !== 'alive' || character.resources.hp <= 0) throw new Error('Martwa postać nie może zmieniać wyposażenia');
  if (plan.ownerId !== character.id || plan.before !== ownerFingerprint(character,inventory)) throw new Error('Stan wyposażenia zmienił się — wybierz przedmiot ponownie');
  const staged = InventoryGrid.fromJSON(plan.inventory);
  const equipment = clone(plan.equipment);
  validateOwnerEquipment({...character,equipment},staged,catalog);
  character.equipment = equipment;
  inventory.items = staged.items;
  character.inventoryItemIds = staged.toJSON().items.map(item=>item.id);
  return plan.changedItem.id;
}

/** Idempotent import of old v0.5.0 items. Source saves are not overwritten. */
export function migrateLegacyEquipment(roster,inventories,catalog) {
  for (const character of roster.characters.values()) {
    initializeEquipmentAttributes(character,catalog);
    const original = inventories.get(character.id);
    if (!original) throw new Error(`Brak plecaka: ${character.id}`);
    const data = original.toJSON();
    const normalize = item => {
      if (!catalog.get(item.canonicalId)) return clone(item);
      if (item.equipmentVersion === EQUIPMENT_SCHEMA_VERSION) { validateEquipmentItem(item,catalog); return clone(item); }
      if (item.equipmentVersion !== undefined) throw new Error('Nieobsługiwana wersja przedmiotu');
      if (item.quality !== 'normal') throw new Error('Nie można bezstratnie przenieść jakości tego przedmiotu');
      const normalized = createEquipmentItem(catalog,item.canonicalId,item.id,{position:item.position});
      return {...clone(item),...normalized};
    };
    const migrated = new InventoryGrid({width:data.width,height:data.height});
    for (const originalItem of data.items) {
      const item = normalize(originalItem);
      const position = migrated.canPlace(item,item.position) ? item.position : findInventorySpace(migrated,item);
      if (!position || !migrated.place(item,position)) throw new Error('Migracja nie mieści wszystkich przedmiotów — stary zapis pozostaje bez zmian');
    }
    character.equipment = Object.fromEntries(Object.entries(character.equipment).map(([slot,item]) => {
      const normalized = normalize(item); delete normalized.position;
      return [slot,normalized];
    }));
    inventories.set(character.id,migrated);
    character.inventoryItemIds = migrated.toJSON().items.map(item=>item.id);
  }
  validateEquipmentWorld(roster,inventories,catalog);
}

export function equipmentStats(character,catalog) {
  const weaponItem = character.equipment.weapon;
  const d = weaponItem ? validateEquipmentItem(weaponItem,catalog) : null;
  const inTwoHands = Boolean(d?.twoHanded && !(d.barbarianOneHand && character.classId === 'barbarian' && character.equipment.offhand));
  const rawDamage = d ? (inTwoHands ? d.twoHandDamage : d.oneHandDamage) : [1,2];
  // Source coefficients are hundredths. Keep integer math and truncate once per specified stage.
  const attributePercent = d
    ? Math.floor((character.stats.strength*d.strengthBonus + character.stats.dexterity*d.dexterityBonus)/100)
    : character.stats.strength;
  const weaponDamage = rawDamage.map(value=>Math.floor(value*(100+attributePercent)/100));
  const armorDefense = Object.values(character.equipment).reduce((sum,item) => sum + (catalog.get(item.canonicalId)?.kind === 'armor' ? item.defense : 0),0);
  return {
    weaponName:d?.displayName ?? 'Bez broni', baseDamage:[...rawDamage], weaponDamage,
    attributePercent, defense:Math.floor(character.stats.dexterity/4)+armorDefense, armorDefense,
    sourceCode:d?.code ?? null, twoHanded:inTwoHands,
  };
}

const weaponSkills = new Set([
  'basic.attack',
  'barbarian.bash',
  'barbarian.whirlwind',
  'barbarian.leap_attack',
  'paladin.zeal',
  'druid.maul',
  'amazon.jab',
  'assassin.tiger_strike',
  'assassin.dragon_talon',
]);
export function equipmentSkillProfile(character,skill,catalog) {
  if (!skill || !Array.isArray(skill.damage)) return null;
  let damage = [...skill.damage], origin = 'skill-placeholder', sourceCode = null, error = null;
  if (weaponSkills.has(skill.id)) {
    const stats = equipmentStats(character,catalog);
    damage = stats.weaponDamage; sourceCode = stats.sourceCode; origin = 'equipment';
  } else if (skill.id === 'paladin.smite') {
    const shield = character.equipment.offhand;
    const def = shield && catalog.get(shield.canonicalId);
    if (!def) { error = 'Smite wymaga założonej tarczy'; damage = [0,0]; }
    else { damage = def.oneHandDamage.map(value=>Math.floor(value*(100+character.stats.strength)/100)); sourceCode = def.code; }
    origin = 'shield';
  }
  return {
    label:skill.name, glyph:skill.glyph, range:skill.range,
    weaponMin:damage[0], weaponMax:damage[1], offWeaponFlat:0,
    status:skill.status, damageOrigin:origin, sourceCode, error,
  };
}
