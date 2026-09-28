import { createCharacter } from "./characters.js";
import { createEquipmentItem, planEquipmentChange, commitEquipmentChange, requirementsFor } from "./equipment.js";
import { InventoryGrid } from "./inventory-grid.js";
import { canonicalHeroSpritePath } from "./hero-visuals.js";

const clone = (value) => structuredClone(value);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function item(id, canonicalId, x, y) {
  return { id, canonicalId, position: { x, y } };
}

function attackProfile(skillId, label, glyph, range, status = "SOURCE_BACKED_RUNTIME") {
  return { skillId, label, glyph, range, status };
}

function loadout(left, ...right) {
  return { left, right };
}

/**
 * Canonical, deterministic roster used by a fresh game and by save migration.
 *
 * Only bases present in data/equipment.v051.json are referenced here.  The
 * definitions contain no rolled item values: createStarterInventoryItems()
 * derives those through the equipment catalog, so there is one authoritative
 * validation path for fresh games and migrated saves.
 */
export const STARTER_ROSTER_DEFINITIONS = deepFreeze([
  {
    id: "korgan",
    name: "Korgan",
    classId: "barbarian",
    role: "Wojownik pierwszej linii",
    spritePath: canonicalHeroSpritePath("barbarian"),
    starterItems: [
      item("korgan.hand_axe", "hand_axe", 0, 0),
      item("korgan.starter.short_sword", "short_sword", 1, 0),
      item("korgan.starter.quilted_armor", "quilted_armor", 2, 0),
      item("korgan.starter.cap", "cap", 4, 0),
    ],
    attackProfile: attackProfile("barbarian.bash", "BASH", "⚒", 1, "ADAPTATION_PLACEHOLDER"),
    loadout: loadout(
      "barbarian.bash",
      "barbarian.battle_orders",
      "barbarian.shout",
      "barbarian.whirlwind",
    ),
  },
  {
    id: "hadriel",
    name: "Hadriel",
    classId: "paladin",
    role: "Obrońca i wsparcie drużyny",
    spritePath: canonicalHeroSpritePath("paladin"),
    starterItems: [
      item("hadriel.scepter", "scepter", 0, 0),
      item("hadriel.targe", "targe", 1, 0),
      item("hadriel.starter.quilted_armor", "quilted_armor", 3, 0),
      item("hadriel.starter.buckler", "buckler", 5, 0),
    ],
    attackProfile: attackProfile("paladin.zeal", "ZEAL", "✥", 1, "ADAPTATION_PLACEHOLDER"),
    loadout: loadout(
      "paladin.zeal",
      "paladin.might",
      "paladin.holy_fire",
      "paladin.blessed_hammer",
    ),
  },
  {
    id: "ormus",
    name: "Ormus",
    classId: "necromancer",
    role: "Przywoływacz i kontroler pola walki",
    spritePath: canonicalHeroSpritePath("necromancer"),
    starterItems: [
      item("ormus.wand", "wand", 0, 0),
      item("ormus.starter.quilted_armor", "quilted_armor", 1, 0),
      item("ormus.starter.cap", "cap", 3, 0),
    ],
    attackProfile: attackProfile("necromancer.teeth", "TEETH", "⋔", 5, "ADAPTATION_PLACEHOLDER"),
    loadout: loadout(
      "necromancer.teeth",
      "necromancer.raise_skeleton",
      "necromancer.clay_golem",
      "necromancer.amplify_damage",
    ),
  },
  {
    id: "mael",
    name: "Mael",
    classId: "druid",
    role: "Zmiennokształtny i przywoływacz",
    spritePath: canonicalHeroSpritePath("druid"),
    starterItems: [
      item("mael.club", "club", 0, 0),
      item("mael.starter.quilted_armor", "quilted_armor", 1, 0),
      item("mael.starter.cap", "cap", 3, 0),
    ],
    attackProfile: attackProfile("druid.maul", "MAUL", "爪", 1, "ADAPTATION_PLACEHOLDER"),
    loadout: loadout(
      "druid.maul",
      "druid.spirit_wolf",
      "druid.oak_sage",
      "druid.grizzly",
    ),
  },
  {
    id: "cassia",
    name: "Cassia",
    classId: "amazon",
    role: "Wszechstronna wojowniczka dystansowa",
    spritePath: canonicalHeroSpritePath("amazon"),
    starterItems: [
      item("cassia.short_sword", "short_sword", 0, 0),
      item("cassia.starter.quilted_armor", "quilted_armor", 1, 0),
      item("cassia.starter.cap", "cap", 3, 0),
    ],
    attackProfile: attackProfile("amazon.jab", "JAB", "⚔", 1),
    loadout: loadout(
      "amazon.jab",
      "amazon.magic_arrow",
      "amazon.fire_arrow",
      "amazon.inner_sight",
    ),
  },
  {
    id: "natalya",
    name: "Natalya",
    classId: "assassin",
    role: "Szybka wojowniczka i specjalistka pułapek",
    spritePath: canonicalHeroSpritePath("assassin"),
    starterItems: [
      item("natalya.short_sword", "short_sword", 0, 0),
      item("natalya.starter.quilted_armor", "quilted_armor", 1, 0),
      item("natalya.starter.cap", "cap", 3, 0),
    ],
    attackProfile: attackProfile("assassin.tiger_strike", "TIGER STRIKE", "◆", 1),
    loadout: loadout(
      "assassin.tiger_strike",
      "assassin.dragon_talon",
      "assassin.fire_trauma",
      "assassin.psychic_hammer",
    ),
  },
  {
    id: "isendra",
    name: "Isendra",
    classId: "sorceress",
    role: "Magini żywiołów i ataków dystansowych",
    spritePath: canonicalHeroSpritePath("sorceress"),
    starterItems: [
      item("isendra.wand", "wand", 0, 0),
      item("isendra.starter.cap", "cap", 1, 0),
    ],
    attackProfile: attackProfile("sorceress.fire_bolt", "FIRE BOLT", "✦", 5),
    loadout: loadout(
      "sorceress.fire_bolt",
      "sorceress.charged_bolt",
      "sorceress.ice_bolt",
      "sorceress.frozen_armor",
    ),
  },
  {
    id: "veyran",
    name: "Veyran",
    classId: "warlock",
    role: "Mag chaosu i władca demonów",
    spritePath: canonicalHeroSpritePath("warlock"),
    starterItems: [
      item("veyran.wand", "wand", 0, 0),
      item("veyran.starter.quilted_armor", "quilted_armor", 1, 0),
      item("veyran.starter.cap", "cap", 3, 0),
    ],
    attackProfile: attackProfile("basic.attack", "ATAK", "⚔", 1, "SOURCE_BACKED_CONTROL_SKILL"),
    loadout: loadout(
      "basic.attack",
      "warlock.miasma_bolt",
      "warlock.hex_bane",
      "warlock.summon_goatman",
    ),
  },
]);

export const starterRosterDefinitionById = deepFreeze(Object.fromEntries(
  STARTER_ROSTER_DEFINITIONS.map((definition) => [definition.id, definition]),
));

/** The established three-hero party remains the default after roster expansion. */
export const defaultActiveIds = Object.freeze(["korgan", "hadriel", "ormus"]);

/** Create fresh character state through the normal, validated character factory. */
export function createStarterRosterCharacters() {
  return STARTER_ROSTER_DEFINITIONS.map((definition) => {
    const character = createCharacter({
      id: definition.id,
      name: definition.name,
      classId: definition.classId,
    });
    character.inventoryItemIds = definition.starterItems.map(({ id }) => id);
    return character;
  });
}

/**
 * Materialize stable item rolls grouped by owner.  Every invocation returns
 * fresh mutable item objects suitable for InventoryGrid.
 */
export function createStarterInventoryItems(catalog) {
  if (!catalog || typeof catalog.get !== "function") {
    throw new TypeError("Starter inventory requires an equipment catalog");
  }
  return new Map(STARTER_ROSTER_DEFINITIONS.map((definition) => [
    definition.id,
    definition.starterItems.map(({ id, canonicalId, position }) => createEquipmentItem(
      catalog,
      canonicalId,
      id,
      { position },
    )),
  ]));
}

/** Equip only the eligible gear already in a fresh hero's starter backpack.
 * A level-three Targe stays in Hadriel's pack; his usable Buckler is equipped. */
export function equipFreshStarterGear(roster, inventories, catalog) {
  for (const definition of STARTER_ROSTER_DEFINITIONS) {
    const character = roster.get(definition.id);
    const inventory = inventories.get(definition.id);
    for (const slot of ['weapon', 'chest', 'head', 'offhand']) {
      const starter = definition.starterItems.find(({ id, canonicalId }) =>
        inventory.items.has(id) && catalog.get(canonicalId)?.slot === slot
          && requirementsFor(character, catalog.get(canonicalId)).length === 0);
      if (!starter) continue;
      const plan = planEquipmentChange({ character, inventory, catalog, itemId: starter.id });
      commitEquipmentChange(character, inventory, catalog, plan);
    }
  }
}

function jsonEntryMap(entries, label) {
  if (!Array.isArray(entries)) throw new TypeError(`${label} must be a JSON entry array`);
  const result = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]) {
      throw new TypeError(`${label} contains an invalid owner entry`);
    }
    if (result.has(entry[0])) throw new Error(`${label} contains duplicate owner: ${entry[0]}`);
    result.set(entry[0], clone(entry[1]));
  }
  return result;
}

/**
 * Add starter heroes absent from a v3 JSON snapshot without changing existing
 * heroes or inventories.  The input is never mutated.  Missing inventories are
 * generated from the same canonical definitions, including for a starter hero
 * that was already present in an incomplete snapshot.
 */
export function migrateMissingStarterRoster({ roster, inventories, catalog } = {}) {
  if (!Array.isArray(roster)) throw new TypeError("roster must be a JSON array");
  const migratedRoster = clone(roster);
  const rosterById = new Map();
  for (const character of migratedRoster) {
    if (!character || typeof character !== "object" || Array.isArray(character)
      || typeof character.id !== "string" || !character.id) {
      throw new TypeError("roster contains an invalid character");
    }
    if (rosterById.has(character.id)) throw new Error(`roster contains duplicate character: ${character.id}`);
    rosterById.set(character.id, character);
  }

  const inventoryByOwner = jsonEntryMap(inventories, "inventories");
  const starterItems = createStarterInventoryItems(catalog);
  const freshCharacters = new Map(createStarterRosterCharacters().map((character) => [character.id, character]));
  const addedIds = [];

  for (const definition of STARTER_ROSTER_DEFINITIONS) {
    const existing = rosterById.get(definition.id);
    if (existing && existing.classId !== definition.classId) {
      throw new Error(`Starter id ${definition.id} belongs to class ${definition.classId}`);
    }

    if (!inventoryByOwner.has(definition.id)) {
      const grid = new InventoryGrid({ width: 10, height: 4, items: starterItems.get(definition.id) });
      inventoryByOwner.set(definition.id, grid.toJSON());
    }

    if (!existing) {
      const character = freshCharacters.get(definition.id);
      character.inventoryItemIds = inventoryByOwner.get(definition.id).items.map(({ id }) => id);
      migratedRoster.push(character);
      rosterById.set(character.id, character);
      addedIds.push(character.id);
    } else if (!Array.isArray(existing.inventoryItemIds)
      || existing.inventoryItemIds.length === 0) {
      existing.inventoryItemIds = inventoryByOwner.get(definition.id).items.map(({ id }) => id);
    }
  }

  return {
    roster: migratedRoster,
    inventories: [...inventoryByOwner.entries()].map(([id, inventory]) => [id, clone(inventory)]),
    addedIds,
  };
}
