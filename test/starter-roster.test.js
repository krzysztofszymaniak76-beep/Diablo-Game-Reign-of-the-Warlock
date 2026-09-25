import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { EquipmentCatalog, validateEquipmentItem } from "../src/core/equipment.js";
import { InventoryGrid } from "../src/core/inventory-grid.js";
import {
  STARTER_ROSTER_DEFINITIONS,
  starterRosterDefinitionById,
  defaultActiveIds,
  createStarterRosterCharacters,
  createStarterInventoryItems,
  migrateMissingStarterRoster,
} from "../src/core/starter-roster.js";

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(
  new URL("../data/equipment.v051.json", import.meta.url),
  "utf8",
)));

const EXPECTED_IDENTITIES = Object.freeze([
  ["korgan", "Korgan", "barbarian"],
  ["hadriel", "Hadriel", "paladin"],
  ["ormus", "Ormus", "necromancer"],
  ["mael", "Mael", "druid"],
  ["cassia", "Cassia", "amazon"],
  ["natalya", "Natalya", "assassin"],
  ["isendra", "Isendra", "sorceress"],
  ["veyran", "Veyran", "warlock"],
]);

function recursivelyFrozen(value) {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(recursivelyFrozen);
}

test("starter definitions contain exactly one immutable entry for every class", () => {
  assert.deepEqual(
    STARTER_ROSTER_DEFINITIONS.map(({ id, name, classId }) => [id, name, classId]),
    EXPECTED_IDENTITIES,
  );
  assert.equal(new Set(STARTER_ROSTER_DEFINITIONS.map(({ classId }) => classId)).size, 8);
  assert.equal(new Set(STARTER_ROSTER_DEFINITIONS.map(({ id }) => id)).size, 8);
  assert.equal(recursivelyFrozen(STARTER_ROSTER_DEFINITIONS), true);
  assert.equal(recursivelyFrozen(starterRosterDefinitionById), true);
  for (const definition of STARTER_ROSTER_DEFINITIONS) {
    assert.equal(starterRosterDefinitionById[definition.id], definition);
    assert.match(definition.role, /\S/);
  }
});

test("the established three heroes remain the exact default active party", () => {
  assert.deepEqual(defaultActiveIds, ["korgan", "hadriel", "ormus"]);
  assert.equal(Object.isFrozen(defaultActiveIds), true);
  assert.equal(defaultActiveIds.every((id) => starterRosterDefinitionById[id]), true);
});

test("fresh starter characters use createCharacter resources and deterministic identities", () => {
  const first = createStarterRosterCharacters();
  const second = createStarterRosterCharacters();
  assert.deepEqual(first, second);
  assert.notEqual(first[0], second[0]);
  assert.deepEqual(first.map(({ id, name, classId }) => [id, name, classId]), EXPECTED_IDENTITIES);

  for (const character of first) {
    const definition = starterRosterDefinitionById[character.id];
    assert.equal(character.level, 1);
    assert.equal(character.experience, 0);
    assert.deepEqual(character.skills, {});
    assert.equal(character.unspentSkillPoints, 0);
    assert.equal(character.lifeState, "alive");
    assert.equal(character.resources.hp, character.resources.maxHp);
    assert.equal(character.resources.mana, character.resources.maxMana);
    assert.ok(Number.isSafeInteger(character.resources.hp * 256));
    assert.ok(Number.isSafeInteger(character.resources.mana * 256));
    assert.ok(character.resources.maxHp > 0);
    assert.ok(character.resources.maxMana > 0);
    assert.deepEqual(character.inventoryItemIds, definition.starterItems.map(({ id }) => id));
  }
});

test("sprites, attack profiles and four-slot loadouts reference complete stable resources", () => {
  for (const definition of STARTER_ROSTER_DEFINITIONS) {
    assert.match(definition.spritePath, /^\/app\/assets\/unit-[a-z0-9-]+\.png$/);
    assert.equal(existsSync(new URL(`..${definition.spritePath}`, import.meta.url)), true, definition.spritePath);
    assert.equal(definition.attackProfile.skillId, definition.loadout.left);
    assert.match(definition.attackProfile.label, /\S/);
    assert.match(definition.attackProfile.glyph, /\S/);
    assert.ok(Number.isSafeInteger(definition.attackProfile.range));
    assert.ok(definition.attackProfile.range >= 1);
    const skillIds = [definition.loadout.left, ...definition.loadout.right];
    assert.equal(skillIds.length, 4);
    assert.equal(new Set(skillIds).size, 4, `${definition.id} must have four unique actions`);
    assert.equal(skillIds.every((id) => typeof id === "string" && id.length > 0), true);
  }
  assert.equal(starterRosterDefinitionById.veyran.loadout.left, "basic.attack");
});

test("starter items use existing catalog bases, retain legacy IDs and never collide", () => {
  const expectedLegacyIds = [
    "korgan.hand_axe",
    "korgan.starter.short_sword",
    "korgan.starter.quilted_armor",
    "korgan.starter.cap",
    "hadriel.scepter",
    "hadriel.targe",
    "hadriel.starter.quilted_armor",
    "hadriel.starter.buckler",
    "ormus.wand",
    "ormus.starter.quilted_armor",
    "ormus.starter.cap",
    "mael.club",
  ];
  const definitionItems = STARTER_ROSTER_DEFINITIONS.flatMap(({ starterItems }) => starterItems);
  const ids = definitionItems.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of expectedLegacyIds) assert.equal(ids.includes(id), true, id);
  for (const { canonicalId } of definitionItems) assert.ok(catalog.get(canonicalId), canonicalId);

  const first = createStarterInventoryItems(catalog);
  const second = createStarterInventoryItems(catalog);
  assert.deepEqual([...first], [...second]);
  assert.equal(first.size, 8);
  for (const [ownerId, items] of first) {
    assert.equal(starterRosterDefinitionById[ownerId] !== undefined, true);
    for (const created of items) validateEquipmentItem(created, catalog);
    assert.doesNotThrow(() => new InventoryGrid({ width: 10, height: 4, items }));
  }
});

test("missing-roster migration is non-mutating, complete and idempotent", () => {
  const allCharacters = createStarterRosterCharacters();
  const allItems = createStarterInventoryItems(catalog);
  const legacyCharacters = allCharacters.slice(0, 4);
  legacyCharacters[0].level = 7;
  legacyCharacters[0].experience = 1234;
  const legacyInventories = legacyCharacters.map(({ id }) => [
    id,
    new InventoryGrid({ width: 10, height: 4, items: allItems.get(id) }).toJSON(),
  ]);
  const original = structuredClone({ roster: legacyCharacters, inventories: legacyInventories });

  const migrated = migrateMissingStarterRoster({
    roster: legacyCharacters,
    inventories: legacyInventories,
    catalog,
  });
  assert.deepEqual({ roster: legacyCharacters, inventories: legacyInventories }, original);
  assert.deepEqual(migrated.roster.map(({ id }) => id), EXPECTED_IDENTITIES.map(([id]) => id));
  assert.deepEqual(migrated.inventories.map(([id]) => id), EXPECTED_IDENTITIES.map(([id]) => id));
  assert.deepEqual(migrated.addedIds, ["cassia", "natalya", "isendra", "veyran"]);
  assert.equal(migrated.roster[0].level, 7);
  assert.equal(migrated.roster[0].experience, 1234);

  const repeated = migrateMissingStarterRoster({
    roster: migrated.roster,
    inventories: migrated.inventories,
    catalog,
  });
  assert.deepEqual(repeated.roster, migrated.roster);
  assert.deepEqual(repeated.inventories, migrated.inventories);
  assert.deepEqual(repeated.addedIds, []);
});

test("migration repairs a missing starter inventory without replacing character progress", () => {
  const characters = createStarterRosterCharacters();
  const cassia = characters.find(({ id }) => id === "cassia");
  cassia.level = 3;
  cassia.experience = 500;
  cassia.inventoryItemIds = [];

  const migrated = migrateMissingStarterRoster({ roster: [cassia], inventories: [], catalog });
  const restored = migrated.roster.find(({ id }) => id === "cassia");
  const inventory = new Map(migrated.inventories).get("cassia");
  assert.equal(restored.level, 3);
  assert.equal(restored.experience, 500);
  assert.deepEqual(restored.inventoryItemIds, inventory.items.map(({ id }) => id));
  assert.doesNotThrow(() => InventoryGrid.fromJSON(inventory));
});
