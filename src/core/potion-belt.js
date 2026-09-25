import { CAMP_SUPPLY_DEFINITIONS } from './camp-services.js';
import { InventoryGrid } from './inventory-grid.js';

export const BELT_SLOT_COUNT = 4;

const potionDefinitions = new Map(CAMP_SUPPLY_DEFINITIONS
  .filter(({ id }) => id.startsWith('potion_health') || id.startsWith('potion_mana'))
  .map((definition) => [definition.id, definition]));

const legacyPotionIds = Object.freeze({
  'Mikstura Leczenia': 'potion_health_lesser',
  'Mikstura Many': 'potion_mana_lesser',
});

function requireSlot(belt, index) {
  if (!Array.isArray(belt) || belt.length !== BELT_SLOT_COUNT
    || !Number.isInteger(index) || index < 0 || index >= BELT_SLOT_COUNT) {
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

export function emptyPotionBelt() {
  return Array(BELT_SLOT_COUNT).fill(null);
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
  return Array.isArray(belt) && belt.length === BELT_SLOT_COUNT
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
  return { name: slot.name, kind: potionKind(slot) };
}
