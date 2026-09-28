import { CAMP_SUPPLY_DEFINITIONS } from './camp-services.js';
import { InventoryGrid } from './inventory-grid.js';

export const BELT_SLOT_COUNT = 4;
export const MAX_BELT_SLOT_COUNT = 16;
// Arreat Summit, Normal / Exceptional / Elite Belts: number of boxes.
const beltRowsByCode = Object.freeze({ lbl:2, vbl:2, mbl:3, tbl:3, hbl:4,
  zlb:4, zvb:4, zmb:4, ztb:4, zhb:4, ulc:4, uvc:4, umc:4, utc:4, uhc:4 });
export function potionBeltCapacity(character, catalog) {
  const item = character.equipment?.belt;
  if (!item) return BELT_SLOT_COUNT;
  const definition = catalog.get(item.canonicalId);
  const rows = beltRowsByCode[definition?.code];
  if (!rows) throw new Error('Nieznana pojemność założonego pasa');
  return rows * BELT_SLOT_COUNT;
}

export function resizePotionBelt(belt, capacity) {
  if (![4, 8, 12, 16].includes(capacity) || !validPotionBelt(belt)) throw new Error('Nieprawidłowa pojemność pasa');
  if (belt.slice(capacity).some(slot => beltSlotCount(slot) > 0)) {
    throw new Error('Przenieś mikstury z dodatkowych rzędów do plecaka przed zdjęciem lub zmianą na mniejszy pas');
  }
  return Array.from({ length: capacity }, (_, index) => structuredClone(belt[index] ?? null));
}

const potionDefinitions = new Map(CAMP_SUPPLY_DEFINITIONS
  .filter(({ id }) => id.startsWith('potion_health') || id.startsWith('potion_mana'))
  .map((definition) => [definition.id, definition]));

const legacyPotionIds = Object.freeze({
  'Mikstura Leczenia': 'potion_health_lesser',
  'Mikstura Many': 'potion_mana_lesser',
});

function requireSlot(belt, index) {
  if (!Array.isArray(belt) || ![4, 8, 12, 16].includes(belt.length)
    || !Number.isInteger(index) || index < 0 || index >= belt.length) {
    throw new RangeError('Nieprawidłowe miejsce pasa');
  }
}

function requireInventory(inventory) {
  if (!(inventory instanceof InventoryGrid)) throw new TypeError('Brak plecaka postaci');
}

function firstFreePosition(inventory, item) {
  for (let y = 0; y <= inventory.height - item.height; y += 1) {
    for (let x = 0; x <= inventory.width - item.width; x += 1) {
      if (inventory.canPlace(item, { x, y })) return { x, y };
    }
  }
  return null;
}

export function emptyPotionBelt(capacity = BELT_SLOT_COUNT) {
  if (![4, 8, 12, 16].includes(capacity)) throw new RangeError('Nieprawidłowa pojemność pasa');
  return Array(capacity).fill(null);
}

/** Fresh-game supplies only; saved belts are restored unchanged. */
export function starterHealthPotionBelt(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('Brak właściciela pasa');
  const definition = potionDefinitions.get('potion_health_lesser');
  return Array.from({ length: BELT_SLOT_COUNT }, (_, index) => ({
    id: `starter-belt:${ownerId}:${index + 1}`,
    canonicalId: definition.id,
    name: definition.displayName,
    width: definition.width,
    height: definition.height,
    quality: 'normal',
    quantity: 1,
    maxQuantity: 1,
    supplyVersion: 1,
  }));
}

export function potionKind(slot) {
  const id = slot?.canonicalId ?? legacyPotionIds[slot?.name];
  if (typeof id !== 'string' || !potionDefinitions.has(id)) return null;
  return id.startsWith('potion_health') ? 'health' : 'mana';
}

export function potionIconId(slot) {
  const id = slot?.canonicalId ?? legacyPotionIds[slot?.name];
  return potionDefinitions.has(id) ? id : null;
}

export function beltSlotCount(slot) {
  if (!slot) return 0;
  return Object.hasOwn(slot, 'canonicalId') ? slot.quantity : slot.count;
}

export function isPotionItem(item) {
  const definition = potionDefinitions.get(item?.canonicalId);
  return Boolean(definition
    && typeof item.id === 'string' && item.id.length > 0
    && item.name === definition.displayName
    && item.width === 1 && item.height === 1
    && item.quality === 'normal' && item.quantity === 1
    && item.maxQuantity === 1 && item.supplyVersion === 1);
}

export function validPotionBelt(belt) {
  return Array.isArray(belt) && [4, 8, 12, 16].includes(belt.length)
    && belt.every((slot) => slot === null || (isPotionItem(slot)
      && !Object.hasOwn(slot, 'position')) || (
      slot && !Object.hasOwn(slot, 'canonicalId')
      && Object.hasOwn(legacyPotionIds, slot.name)
      && Number.isSafeInteger(slot.count) && slot.count >= 0
    ));
}

export function putPotionInBelt(inventory, belt, itemId, index) {
  requireInventory(inventory);
  requireSlot(belt, index);
  if (belt[index] !== null && beltSlotCount(belt[index]) > 0) throw new Error('To miejsce pasa jest zajęte');
  const item = inventory.items.get(itemId);
  if (!isPotionItem(item)) throw new Error('Do pasa można włożyć tylko miksturę z plecaka');
  const moved = inventory.remove(itemId);
  delete moved.position;
  belt[index] = moved;
  return structuredClone(moved);
}

export function takePotionFromBelt(inventory, belt, index, ownerId) {
  requireInventory(inventory);
  requireSlot(belt, index);
  const slot = belt[index];
  if (!slot || beltSlotCount(slot) <= 0) throw new Error('To miejsce pasa jest puste');
  let item;
  if (Object.hasOwn(slot, 'canonicalId')) {
    if (!isPotionItem(slot)) throw new Error('Nieprawidłowa mikstura w pasie');
    item = structuredClone(slot);
  } else {
    const definition = potionDefinitions.get(legacyPotionIds[slot.name]);
    if (!definition || !Number.isSafeInteger(slot.count)) throw new Error('Nieprawidłowa mikstura w pasie');
    if (typeof ownerId !== 'string' || !ownerId) throw new Error('Brak właściciela pasa');
    const baseId = `legacy-belt:${encodeURIComponent(ownerId)}:${index}:${slot.count}`;
    let itemId = baseId;
    for (let suffix = 1; inventory.items.has(itemId) || belt.some((entry) => entry?.id === itemId); suffix += 1) {
      itemId = `${baseId}:${suffix}`;
    }
    item = {
      id: itemId, canonicalId: definition.id, name: definition.displayName,
      width: 1, height: 1, quality: 'normal', quantity: 1,
      maxQuantity: 1, supplyVersion: 1,
    };
  }
  const position = firstFreePosition(inventory, item);
  if (!position) throw new Error('Brak miejsca w plecaku na miksturę');
  if (!inventory.place(item, position)) throw new Error('Nie udało się przenieść mikstury do plecaka');
  if (Object.hasOwn(slot, 'canonicalId') || slot.count === 1) belt[index] = null;
  else slot.count -= 1;
  return structuredClone(item);
}

export function consumePotionFromBelt(belt, index) {
  requireSlot(belt, index);
  const slot = belt[index];
  if (!slot || beltSlotCount(slot) <= 0 || !potionKind(slot)) return null;
  if (Object.hasOwn(slot, 'canonicalId')) {
    if (!isPotionItem(slot)) return null;
    belt[index] = null;
  } else if (slot.count === 1) belt[index] = null;
  else slot.count -= 1;
  // Potions above the consumed cell fall down within the SAME column.
  if (belt[index] === null) {
    for (let next = index + BELT_SLOT_COUNT; next < belt.length; next += BELT_SLOT_COUNT) {
      belt[next - BELT_SLOT_COUNT] = belt[next];
      belt[next] = null;
    }
  }
  return { name: slot.name, kind: potionKind(slot) };
}
