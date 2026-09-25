import { InventoryGrid } from './inventory-grid.js';
import { createEquipmentItem, findInventorySpace, validateEquipmentItem, validateOwnerEquipment } from './equipment.js';

export const CAMP_SERVICES_SCHEMA_VERSION = 1;
export const CAMP_STASH_SIZE = Object.freeze({ width: 10, height: 8 });
export const DEFAULT_CAMP_GOLD = 500;

const clone = value => structuredClone(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0 && value.trim() === value;
const safeInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min;

function freeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

/**
 * The first town stock is deliberately explicit. These are persistent item
 * instances, not templates rerolled whenever a panel is opened.
 */
export const CAMP_VENDOR_DEFINITIONS = freeze([
  { id: 'akara', displayName: 'Akara', canonicalId: 'wand', itemId: 'camp.vendor.akara.wand' },
  { id: 'charsi', displayName: 'Charsi', canonicalId: 'hand_axe', itemId: 'camp.vendor.charsi.hand_axe' },
  { id: 'gheed', displayName: 'Gheed', canonicalId: 'cap', itemId: 'camp.vendor.gheed.cap' },
]);

/** Scroll, tome and potion supply sold by Akara; prices are this game's stable adaptation values. */
export const CAMP_SUPPLY_DEFINITIONS = freeze([
  { id: 'scroll_identify', displayName: 'Zwój identyfikacji', width: 1, height: 1, stackSize: 20, stockQuantity: 20, buyPrice: 80 },
  { id: 'scroll_town_portal', displayName: 'Zwój portalu miejskiego', width: 1, height: 1, stackSize: 20, stockQuantity: 20, buyPrice: 80 },
  { id: 'tome_identify', displayName: 'Tom identyfikacji', width: 1, height: 2, stackSize: 20, stockQuantity: 20, buyPrice: 450 },
  { id: 'tome_town_portal', displayName: 'Tom portalu miejskiego', width: 1, height: 2, stackSize: 20, stockQuantity: 20, buyPrice: 450 },
  { id: 'potion_health_lesser', displayName: 'Słaba mikstura zdrowia', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 30 },
  { id: 'potion_health_light', displayName: 'Lekka mikstura zdrowia', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 50 },
  { id: 'potion_health', displayName: 'Mikstura zdrowia', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 100 },
  { id: 'potion_mana_lesser', displayName: 'Słaba mikstura many', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 30 },
  { id: 'potion_mana_light', displayName: 'Lekka mikstura many', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 50 },
  { id: 'potion_mana', displayName: 'Mikstura many', width: 1, height: 1, stackSize: 1, stockQuantity: 1, buyPrice: 100 },
]);

const supplyById = new Map(CAMP_SUPPLY_DEFINITIONS.map(item => [item.id, item]));

// Offers are split by merchant role and use only supported, source-extracted
// Diablo II item art. Akara's supplies use the generic 1×1/1×2 inventory items
// below; they remain storable/tradeable without claiming a use effect exists.
export const CAMP_VENDOR_POOLS = freeze({
  akara: ['scroll_identify', 'scroll_town_portal', 'tome_identify', 'tome_town_portal',
    'potion_health_lesser', 'potion_mana_lesser', 'wand', 'scepter', 'dagger'],
  charsi: ['hand_axe', 'great_axe', 'short_sword', 'two_handed_sword', 'great_sword', 'dagger', 'war_hammer', 'flail', 'spear', 'war_staff', 'hunters_bow', 'light_crossbow', 'throwing_axe', 'club', 'katar',
    'quilted_armor', 'cap', 'buckler', 'leather_gloves', 'boots', 'sash'],
  gheed: ['cap', 'quilted_armor', 'buckler', 'leather_gloves', 'boots', 'sash',
    'dagger', 'throwing_axe', 'hunters_bow', 'light_crossbow', 'short_sword', 'club'],
});

// Akara is the camp's dependable source of basic magical supplies. A random
// draw must not hide the scrolls, tomes, minor potions, wand or scepter.
// The local D2R weapons/misc tables list these bases for Akara. Short/long
// staves are in that table but have no supported catalog entry or item art yet.
export const CAMP_AKARA_CORE_STOCK = freeze([
  'scroll_identify', 'scroll_town_portal', 'tome_identify', 'tome_town_portal',
  'potion_health_lesser', 'potion_mana_lesser', 'wand', 'scepter',
]);

const CAMP_VENDOR_STOCK_SIZE = freeze({ akara: 9, charsi: 15, gheed: 8 });
const CAMP_VENDOR_RARE_OFFERS = freeze({ akara: ['dagger'], charsi: [], gheed: [] });

const vendorDefinitionById = new Map(CAMP_VENDOR_DEFINITIONS.map(vendor => [vendor.id, vendor]));

function requireCatalog(catalog) {
  if (!catalog || typeof catalog.get !== 'function' || typeof catalog.all !== 'function') {
    throw new TypeError('Usługi obozu wymagają katalogu wyposażenia');
  }
  for (const vendor of CAMP_VENDOR_DEFINITIONS) {
    if (!catalog.get(vendor.canonicalId)) throw new Error(`Brak bazy oferty obozu: ${vendor.canonicalId}`);
    for (const canonicalId of CAMP_VENDOR_POOLS[vendor.id]) {
      if (!catalog.get(canonicalId) && !supplyById.has(canonicalId)) {
        throw new Error(`Brak bazy oferty ${vendor.displayName}: ${canonicalId}`);
      }
    }
  }
}

function exactKeys(value, keys, label) {
  if (!record(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Nieprawidłowy schemat: ${label}`);
  }
}

function equipmentBuyPrice(definition) {
  const footprint = definition.width * definition.height;
  const damage = Math.max(definition.oneHandDamage[1], definition.twoHandDamage[1]);
  const defense = definition.defenseRange[1];
  const price = 25 + footprint * 12 + definition.requiredLevel * 20
    + definition.requiredStrength + definition.requiredDexterity + damage * 3 + defense * 2;
  if (!safeInteger(price, 1)) throw new Error(`Nie można wycenić bazy: ${definition.id}`);
  return price;
}

function equipmentSellPrice(definition) {
  return Math.max(1, Math.floor(equipmentBuyPrice(definition) / 4));
}

function createSupplyItem(canonicalId, id) {
  const definition = supplyById.get(canonicalId);
  if (!definition) throw new Error(`Brak bazy zapasu: ${canonicalId}`);
  return {
    id, canonicalId, name: definition.displayName, width: definition.width, height: definition.height,
    quality: 'normal', quantity: definition.stockQuantity, maxQuantity: definition.stackSize,
    supplyVersion: 1,
  };
}

function validateSupplyItem(item) {
  const definition = supplyById.get(item?.canonicalId);
  if (!definition) throw new Error(`Nieobsługiwany towar użytkowy: ${item?.canonicalId ?? 'bez ID'}`);
  const copy = { ...item };
  delete copy.position;
  exactKeys(copy, ['id', 'canonicalId', 'name', 'width', 'height', 'quality', 'quantity', 'maxQuantity', 'supplyVersion'], 'zapas handlarza');
  if (!nonEmpty(item.id) || item.name !== definition.displayName || item.width !== definition.width
    || item.height !== definition.height || item.quality !== 'normal' || item.supplyVersion !== 1
    || item.maxQuantity !== definition.stackSize || !safeInteger(item.quantity, 1)
    || item.quantity > definition.stackSize) {
    throw new Error(`Nieprawidłowy zapas: ${item.id ?? ''}`);
  }
  return definition;
}

function createVendorItem(catalog, canonicalId, id) {
  return catalog.get(canonicalId)
    ? createEquipmentItem(catalog, canonicalId, id)
    : createSupplyItem(canonicalId, id);
}

function offerForItem(item, catalog) {
  if (Object.hasOwn(item, 'position')) throw new Error(`Oferta nie może zajmować pola plecaka: ${item.id}`);
  const equipment = catalog.get(item?.canonicalId);
  const definition = equipment ? validateEquipmentItem(item, catalog) : validateSupplyItem(item);
  if (equipment && item.name !== definition.displayName) throw new Error(`Nieprawidłowa polska nazwa przedmiotu: ${item.id}`);
  return {
    offerId: item.id,
    displayName: definition.displayName,
    buyPrice: equipment ? equipmentBuyPrice(definition) : definition.buyPrice,
    item: clone(item),
  };
}

function freshVendors(catalog) {
  return CAMP_VENDOR_DEFINITIONS.map(vendor => {
    const item = createVendorItem(catalog, vendor.canonicalId, vendor.itemId);
    return { id: vendor.id, displayName: vendor.displayName, offers: [offerForItem(item, catalog)] };
  });
}

function validateGridItems(grid, catalog, label) {
  if (!(grid instanceof InventoryGrid)) throw new TypeError(`${label} musi być siatką InventoryGrid`);
  for (const item of grid.toJSON().items) {
    if (catalog.get(item.canonicalId)) validateEquipmentItem(item, catalog);
    else if (supplyById.has(item.canonicalId)) validateSupplyItem(item);
  }
}

function normalizeInventories(inventories) {
  if (inventories == null) return [];
  if (inventories instanceof InventoryGrid) return [['backpack', inventories]];
  if (inventories instanceof Map) return [...inventories.entries()];
  if (Array.isArray(inventories)) {
    return inventories.map((entry, index) => (Array.isArray(entry) && entry.length === 2
      ? entry
      : [`backpack-${index + 1}`, entry]));
  }
  if (record(inventories)) return Object.entries(inventories);
  throw new TypeError('Plecaki do audytu muszą być siatką, mapą, tablicą albo obiektem');
}

function addUnique(seen, item, owner) {
  if (seen.has(item.id)) {
    throw new Error(`Przedmiot ma wielu właścicieli: ${item.id} (${seen.get(item.id)} / ${owner})`);
  }
  seen.set(item.id, owner);
}

export class CampServicesState {
  #catalog;
  #vendors;
  #sessionStockReady = false;

  constructor({ catalog, gold = DEFAULT_CAMP_GOLD, stash = null, vendors = null } = {}) {
    requireCatalog(catalog);
    if (!safeInteger(gold)) throw new TypeError('Złoto obozu musi być nieujemną bezpieczną liczbą całkowitą');
    this.#catalog = catalog;
    this.gold = gold;
    this.stash = stash === null
      ? new InventoryGrid(CAMP_STASH_SIZE)
      : InventoryGrid.fromJSON(stash instanceof InventoryGrid ? stash.toJSON() : clone(stash));
    this.#vendors = vendors === null ? freshVendors(catalog) : clone(vendors);
    this.#validateInternal();
  }

  listVendors() {
    this.#validateInternal();
    return clone(this.#vendors);
  }

  vendor(vendorId) {
    this.#validateInternal();
    const vendor = this.#requireVendor(vendorId);
    return clone(vendor);
  }

  offers(vendorId) {
    return this.vendor(vendorId).offers;
  }

  /**
   * Start one play session. This marker is intentionally not saved: restoring
   * the same character in a later process starts a new session with new stock,
   * while repeatedly opening a merchant within this session does not reroll it.
   * A failed rotation leaves the session unstarted, so it can be retried.
   */
  beginSession(options = {}) {
    if (this.#sessionStockReady) return this.listVendors();
    return this.rotateOffers(options);
  }

  /**
   * Rebuild finite shop stock once per game entry, never on panel render. A
   * supplied random function makes pool selection reproducible in tests; item
   * identities remain globally fresh so an item bought before relogging cannot
   * collide with a replacement offer in the same save.
   */
  rotateOffers({ inventories = [], random = Math.random } = {}) {
    if (typeof random !== 'function') throw new TypeError('Losowanie ofert wymaga funkcji random');
    this.validateUniqueOwnership(inventories);
    const stagedSnapshot = this.snapshot();
    for (const vendor of stagedSnapshot.vendors) {
      const pool = [...CAMP_VENDOR_POOLS[vendor.id]];
      for (const rareId of CAMP_VENDOR_RARE_OFFERS[vendor.id]) {
        const roll = random();
        if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError('Losowanie oferty musi zwracać liczbę z zakresu [0, 1)');
        if (roll >= 0.15) pool.splice(pool.indexOf(rareId), 1);
      }
      const guaranteed = vendor.id === 'akara' ? CAMP_AKARA_CORE_STOCK : [];
      for (const canonicalId of guaranteed) {
        const index = pool.indexOf(canonicalId);
        if (index < 0) throw new Error(`Brak obowiązkowego towaru ${vendor.displayName}: ${canonicalId}`);
        pool.splice(index, 1);
      }
      const count = Math.min(CAMP_VENDOR_STOCK_SIZE[vendor.id], pool.length + guaranteed.length);
      const selected = [...guaranteed];
      for (let index = guaranteed.length; index < count; index += 1) {
        const roll = random();
        if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError('Losowanie oferty musi zwracać liczbę z zakresu [0, 1)');
        const [canonicalId] = pool.splice(Math.floor(roll * pool.length), 1);
        selected.push(canonicalId);
      }
      const offers = [];
      for (const canonicalId of selected) {
        const itemId = `camp.vendor.${vendor.id}.${canonicalId}.${globalThis.crypto.randomUUID()}`;
        offers.push(offerForItem(createVendorItem(this.#catalog, canonicalId, itemId), this.#catalog));
      }
      vendor.offers = offers;
    }
    const staged = CampServicesState.restore(stagedSnapshot, { catalog: this.#catalog });
    staged.validateUniqueOwnership(inventories);
    this.#vendors = staged.#vendors;
    this.#sessionStockReady = true;
    return this.listVendors();
  }

  snapshot() {
    this.#validateInternal();
    return {
      schemaVersion: CAMP_SERVICES_SCHEMA_VERSION,
      gold: this.gold,
      stash: this.stash.toJSON(),
      vendors: clone(this.#vendors),
    };
  }

  static restore(snapshot, options = {}) {
    exactKeys(snapshot, ['schemaVersion', 'gold', 'stash', 'vendors'], 'usługi obozu');
    if (snapshot.schemaVersion !== CAMP_SERVICES_SCHEMA_VERSION) {
      throw new Error(`Nieobsługiwany schemat usług obozu: ${snapshot.schemaVersion}`);
    }
    const catalog = options?.catalog ?? options;
    return new CampServicesState({
      catalog,
      gold: snapshot.gold,
      stash: snapshot.stash,
      vendors: snapshot.vendors,
    });
  }

  /**
   * Includes the stash and all vendor stock in the same audit as the supplied
   * backpacks. The returned Set is useful when composing the camp with the
   * wider equipment-world audit.
   */
  validateUniqueOwnership(inventories = []) {
    this.#validateInternal();
    const seen = new Map();
    for (const item of this.stash.toJSON().items) addUnique(seen, item, 'stash');
    for (const vendor of this.#vendors) {
      for (const offer of vendor.offers) addUnique(seen, offer.item, `vendor:${vendor.id}`);
    }
    for (const [ownerId, inventory] of normalizeInventories(inventories)) {
      if (!nonEmpty(ownerId)) throw new Error('Właściciel plecaka wymaga identyfikatora');
      if (inventory === this.stash) throw new Error('Schowek nie może być jednocześnie plecakiem');
      validateGridItems(inventory, this.#catalog, `Plecak ${ownerId}`);
      for (const item of inventory.toJSON().items) addUnique(seen, item, `backpack:${ownerId}`);
    }
    return new Set(seen.keys());
  }

  buy({ vendorId, offerId, inventory } = {}) {
    this.#requireBackpack(inventory);
    this.validateUniqueOwnership(inventory);
    const vendor = this.#requireVendor(vendorId);
    if (!nonEmpty(offerId)) throw new TypeError('Oferta wymaga identyfikatora');
    const offer = vendor.offers.find(candidate => candidate.offerId === offerId);
    if (!offer) throw new Error('Ta oferta nie jest już dostępna');
    if (this.gold < offer.buyPrice) throw new Error('Za mało złota — niczego nie zmieniono');

    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const position = findInventorySpace(stagedInventory, offer.item);
    if (!position || !stagedInventory.place(offer.item, position)) {
      throw new Error('Brak miejsca w plecaku — niczego nie zmieniono');
    }
    const stagedSnapshot = this.snapshot();
    stagedSnapshot.gold -= offer.buyPrice;
    const stagedVendor = stagedSnapshot.vendors.find(candidate => candidate.id === vendorId);
    stagedVendor.offers = stagedVendor.offers.filter(candidate => candidate.offerId !== offerId);
    const staged = CampServicesState.restore(stagedSnapshot, { catalog: this.#catalog });
    staged.validateUniqueOwnership(stagedInventory);
    this.#commit(staged, inventory, stagedInventory);
    return freeze({ item: clone(stagedInventory.items.get(offer.item.id)), price: offer.buyPrice, gold: this.gold });
  }

  quoteSell({ item } = {}) {
    const isEquipment = Boolean(this.#catalog.get(item?.canonicalId));
    const definition = isEquipment
      ? validateEquipmentItem(item, this.#catalog)
      : supplyById.has(item?.canonicalId)
        ? validateSupplyItem(item)
        : validateEquipmentItem(item, this.#catalog);
    return isEquipment
      ? equipmentSellPrice(definition)
      : Math.max(1, Math.floor(definition.buyPrice / 4));
  }

  sell({ vendorId, itemId, inventory } = {}) {
    this.#requireBackpack(inventory);
    this.validateUniqueOwnership(inventory);
    this.#requireVendor(vendorId);
    if (!nonEmpty(itemId)) throw new TypeError('Przedmiot wymaga identyfikatora');

    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const item = stagedInventory.remove(itemId);
    if (!item) throw new Error('Przedmiotu nie ma w tym plecaku');
    const price = this.quoteSell({ item });
    delete item.position;
    if (!Number.isSafeInteger(this.gold + price)) throw new Error('Stan złota przekracza bezpieczny zakres');

    const stagedSnapshot = this.snapshot();
    stagedSnapshot.gold += price;
    const stagedVendor = stagedSnapshot.vendors.find(candidate => candidate.id === vendorId);
    stagedVendor.offers.push(offerForItem(item, this.#catalog));
    const staged = CampServicesState.restore(stagedSnapshot, { catalog: this.#catalog });
    staged.validateUniqueOwnership(stagedInventory);
    this.#commit(staged, inventory, stagedInventory);
    return freeze({ item: clone(item), price, gold: this.gold });
  }

  #repairTarget({ itemId, inventory, character }) {
    this.#requireBackpack(inventory);
    const occupiedIds = this.validateUniqueOwnership(inventory);
    if (!record(character) || !record(character.equipment)) {
      throw new TypeError('Naprawa wymaga właściciela wyposażenia');
    }
    validateOwnerEquipment(character, inventory, this.#catalog);
    for (const equipped of Object.values(character.equipment)) {
      if (occupiedIds.has(equipped.id)) throw new Error(`Przedmiot ma wielu właścicieli: ${equipped.id}`);
      occupiedIds.add(equipped.id);
    }
    if (!nonEmpty(itemId)) throw new TypeError('Naprawa wymaga identyfikatora przedmiotu');
    const backpackItem = inventory.items.get(itemId);
    const equippedEntry = Object.entries(character.equipment).find(([, item]) => item.id === itemId);
    const target = backpackItem ?? equippedEntry?.[1];
    if (!target) throw new Error('Przedmiotu nie ma w plecaku ani w wyposażeniu tej postaci');
    const definition = validateEquipmentItem(target, this.#catalog);
    return { item: target, definition, source: backpackItem ? 'backpack' : 'equipment', slot: equippedEntry?.[0] ?? null };
  }

  /** A quote never changes the item or gold; only missing durability has a price. */
  repairQuote({ itemId, inventory, character } = {}) {
    const { item, definition, source, slot } = this.#repairTarget({ itemId, inventory, character });
    const missingDurability = item.maxDurability - item.durability;
    const price = missingDurability === 0 ? 0 : Math.max(1,
      Math.ceil(equipmentBuyPrice(definition) * missingDurability / (4 * item.maxDurability)));
    if (!safeInteger(price)) throw new Error('Nie można wycenić naprawy');
    return freeze({ itemId, source, slot, durability: item.durability,
      maxDurability: item.maxDurability, missingDurability, price });
  }

  /** Repair one owned item and charge only after the repaired graph validates. */
  repair({ itemId, inventory, character } = {}) {
    const quote = this.repairQuote({ itemId, inventory, character });
    if (quote.missingDurability === 0) throw new Error('Przedmiot nie wymaga naprawy — nie pobrano złota');
    if (this.gold < quote.price) throw new Error('Za mało złota na naprawę — niczego nie zmieniono');

    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const stagedEquipment = clone(character.equipment);
    const repairedItem = quote.source === 'backpack'
      ? stagedInventory.items.get(itemId)
      : stagedEquipment[quote.slot];
    repairedItem.durability = repairedItem.maxDurability;
    const stagedSnapshot = this.snapshot();
    stagedSnapshot.gold -= quote.price;
    const staged = CampServicesState.restore(stagedSnapshot, { catalog: this.#catalog });
    validateOwnerEquipment({ ...character, equipment: stagedEquipment }, stagedInventory, this.#catalog);
    const occupiedIds = staged.validateUniqueOwnership(stagedInventory);
    for (const equipped of Object.values(stagedEquipment)) {
      if (occupiedIds.has(equipped.id)) throw new Error(`Przedmiot ma wielu właścicieli: ${equipped.id}`);
      occupiedIds.add(equipped.id);
    }
    if (quote.source === 'equipment' && !Object.getOwnPropertyDescriptor(character, 'equipment')?.writable) {
      throw new Error('Nie można zmienić wyposażenia postaci — niczego nie zmieniono');
    }
    this.#commit(staged, inventory, stagedInventory);
    if (quote.source === 'equipment') character.equipment = stagedEquipment;
    return freeze({ item: clone(repairedItem), price: quote.price, gold: this.gold, source: quote.source });
  }

  transferToStash({ itemId, inventory } = {}) {
    this.#requireBackpack(inventory);
    this.validateUniqueOwnership(inventory);
    if (!nonEmpty(itemId)) throw new TypeError('Przedmiot wymaga identyfikatora');
    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const stagedStash = InventoryGrid.fromJSON(this.stash.toJSON());
    const item = stagedInventory.remove(itemId);
    if (!item) throw new Error('Przedmiotu nie ma w tym plecaku');
    delete item.position;
    const position = findInventorySpace(stagedStash, item);
    if (!position || !stagedStash.place(item, position)) {
      throw new Error('Brak miejsca w schowku — niczego nie zmieniono');
    }
    return this.#commitTransfer({ item, inventory, stagedInventory, stagedStash });
  }

  transferFromStash({ itemId, inventory } = {}) {
    this.#requireBackpack(inventory);
    this.validateUniqueOwnership(inventory);
    if (!nonEmpty(itemId)) throw new TypeError('Przedmiot wymaga identyfikatora');
    const stagedInventory = InventoryGrid.fromJSON(inventory.toJSON());
    const stagedStash = InventoryGrid.fromJSON(this.stash.toJSON());
    const item = stagedStash.remove(itemId);
    if (!item) throw new Error('Przedmiotu nie ma w schowku');
    delete item.position;
    const position = findInventorySpace(stagedInventory, item);
    if (!position || !stagedInventory.place(item, position)) {
      throw new Error('Brak miejsca w plecaku — niczego nie zmieniono');
    }
    return this.#commitTransfer({ item, inventory, stagedInventory, stagedStash });
  }

  #commitTransfer({ item, inventory, stagedInventory, stagedStash }) {
    const stagedSnapshot = this.snapshot();
    stagedSnapshot.stash = stagedStash.toJSON();
    const staged = CampServicesState.restore(stagedSnapshot, { catalog: this.#catalog });
    staged.validateUniqueOwnership(stagedInventory);
    this.#commit(staged, inventory, stagedInventory);
    return freeze({ item: clone(stagedInventory.items.get(item.id) ?? staged.stash.items.get(item.id)), gold: this.gold });
  }

  #requireBackpack(inventory) {
    if (!(inventory instanceof InventoryGrid) || inventory === this.stash) {
      throw new TypeError('Operacja wymaga osobnego plecaka InventoryGrid');
    }
    validateGridItems(inventory, this.#catalog, 'Plecak');
  }

  #requireVendor(vendorId) {
    if (!nonEmpty(vendorId) || !vendorDefinitionById.has(vendorId)) throw new Error(`Nieznany handlarz: ${vendorId ?? ''}`);
    const vendor = this.#vendors.find(candidate => candidate.id === vendorId);
    if (!vendor) throw new Error(`Brak stanu handlarza: ${vendorId}`);
    return vendor;
  }

  #validateInternal() {
    if (!safeInteger(this.gold)) throw new TypeError('Złoto obozu musi być nieujemną bezpieczną liczbą całkowitą');
    if (!(this.stash instanceof InventoryGrid)
      || this.stash.width !== CAMP_STASH_SIZE.width || this.stash.height !== CAMP_STASH_SIZE.height) {
      throw new Error('Wspólny schowek musi mieć rozmiar 10 × 8');
    }
    validateGridItems(this.stash, this.#catalog, 'Schowek');
    if (!Array.isArray(this.#vendors) || this.#vendors.length !== CAMP_VENDOR_DEFINITIONS.length) {
      throw new Error('Nieprawidłowy rejestr handlarzy');
    }
    const vendorIds = new Set();
    const offerIds = new Set();
    for (const vendor of this.#vendors) {
      exactKeys(vendor, ['id', 'displayName', 'offers'], 'handlarz obozu');
      const expected = vendorDefinitionById.get(vendor.id);
      if (!expected || vendor.displayName !== expected.displayName || vendorIds.has(vendor.id) || !Array.isArray(vendor.offers)) {
        throw new Error(`Nieprawidłowy handlarz obozu: ${vendor.id ?? ''}`);
      }
      vendorIds.add(vendor.id);
      for (const offer of vendor.offers) {
        exactKeys(offer, ['offerId', 'displayName', 'buyPrice', 'item'], 'oferta handlarza');
        if (!nonEmpty(offer.offerId) || offer.offerId !== offer.item?.id || offerIds.has(offer.offerId)) {
          throw new Error(`Powielona albo nieprawidłowa oferta: ${offer.offerId ?? ''}`);
        }
        const expectedOffer = offerForItem(offer.item, this.#catalog);
        if (offer.displayName !== expectedOffer.displayName || offer.buyPrice !== expectedOffer.buyPrice) {
          throw new Error(`Zmieniona oferta handlarza: ${offer.offerId}`);
        }
        offerIds.add(offer.offerId);
      }
    }
    if (vendorIds.size !== CAMP_VENDOR_DEFINITIONS.length
      || CAMP_VENDOR_DEFINITIONS.some(vendor => !vendorIds.has(vendor.id))) {
      throw new Error('Niepełny rejestr handlarzy');
    }
    const seen = new Map();
    for (const item of this.stash.toJSON().items) addUnique(seen, item, 'stash');
    for (const vendor of this.#vendors) {
      for (const offer of vendor.offers) addUnique(seen, offer.item, `vendor:${vendor.id}`);
    }
    return true;
  }

  #commit(staged, inventory, stagedInventory) {
    // All potentially throwing work happens before these plain synchronous assignments.
    this.gold = staged.gold;
    this.#vendors = staged.#vendors;
    this.stash.items = staged.stash.items;
    inventory.items = stagedInventory.items;
  }
}
