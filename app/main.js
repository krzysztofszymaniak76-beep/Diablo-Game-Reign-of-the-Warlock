import { ENCOUNTER_SCHEMA_VERSION, createEncounterProgress, currentLootMarker, groundDrops,
  validateLootRecords, validateEncounterWorld, stageVictoryLoot, stageLootPickup,
  migrateLegacyEncounter, encounterEnemyId } from "/src/core/encounter-loot.js";
import { stageNextEncounter, postBattlePresence } from "/src/core/encounter-loop.js";
import { CampaignState } from "/src/core/campaign.js";
import { stageAct1Encounter } from "/src/core/act1-encounter.js";
import { ACT1_ENCOUNTERS } from "/data/act1-encounters.v057.js";
import { ACT1_EXPLORATION_AREAS, act1Area } from "/data/act1-exploration.v058.js";
import { shortestSectorPath } from "/src/core/exploration.js";
import { hasLandscape, landscapePoint, renderExplorationLandscape } from "/app/exploration-landscape.js";
import { explorationWalkerMarkup, updateExplorationWalker } from "/app/exploration-walker.js";
import { act1DisplayText } from "/app/act1-display-text.js";
import { isTravelFork, travelDecisions } from "/app/exploration-decisions.js";
import { hasTradeItemArtwork, tradeItemArtworkMarkup } from "/app/trade-item-art-v0518.js";
import { attachItemTooltip, hideItemTooltip } from "/app/item-tooltip-v0518.js";
import { GameMusic } from "/app/game-music.js";
import { BARBARIAN_ATLASES, BARBARIAN_UNARMED_ATLASES, BattleAnimationPlayer, barbarianWalkVariant, supportsBarbarianAnimation,
  measureAtlas, drawBarbarianFrame, walkStepDuration, WINDUP_MS, RECOVERY_MS } from '/app/barbarian-animation.js';
import { PALADIN_ATLASES, paladinAnimationVariant, drawPaladinFrame } from '/app/paladin-animation.js';
import { SORCERESS_ATLASES, sorceressAnimationVariant, drawSorceressFrame } from '/app/sorceress-animation.js';
import { HERO_BODY_ATLASES, heroAnimationLoadout, drawHeroAnimationFrame } from '/app/hero-animation.js';
import { createMainMenu } from "/app/main-menu.js";
import { createSaveBridge } from "/app/save-bridge.js";
import { createCharacterCreation, normalizeCreationProfile } from "/app/character-creation.js";
import { HERO_VISUALS, canonicalHeroPortraitPath } from "/src/core/hero-visuals.js";
import { identifyBackpackItems, unidentifiedItems } from "/src/core/item-identification.js";
import { planApproachAttack } from "/src/core/approach-attack.js";
import {
  MOUSE_SKILL_SCHEMA_VERSION,
  MouseSkillBindings,
  MouseSkillCatalog,
  defaultMouseBindingsFromLoadouts,
} from "/src/core/mouse-skills.js";
import { SkillTreeCatalog } from "/src/core/skill-trees.js";
import { SkillHotkeys, SKILL_HOTKEYS } from '/src/core/skill-hotkeys.js';
import { PALETTE_PILOT_CLASS, stylePilotPalette, watchPaletteAsset } from '/app/skill-palette-visual.js';
import { sourceSkillLevel, learnedSourceSkill, nativeSkillSources, fireBoltValues, bashValues, runtimeSkillStatus } from '/src/core/audited-skill-rules.js';
import {barbarianSwordProfile, resolveBarbarianStrike, knockbackHex} from '/src/core/barbarian-melee.js';
import { canPaySkillMana, formatMana, skillManaProfile, spendSkillMana } from "/src/core/skill-mana.js";
import {
  ACTIVE_AURA_SAVE_SCHEMA_VERSION, buildActiveAuraSnapshot, validateActiveAuraSnapshot,
  migrateMouseSkillSnapshot, validatePendingSkillCommands,
} from "/src/core/hero-control-save.js";
import { SkillTarget, skillTargetMode, validateSkillTarget, createSkillExecution, checkSkillExecution, WorldInputGuard } from "/src/core/skill-execution.js";
import {
  EquipmentCatalog, EQUIPMENT_SCHEMA_VERSION, EQUIPMENT_CATALOG_ID, EQUIPMENT_SLOTS,
  createEquipmentItem, initializeEquipmentAttributes, migrateLegacyEquipment,
  planEquipmentChange, commitEquipmentChange, validateEquipmentWorld,
  requirementsFor, findInventorySpace, equipmentStats, equipmentSkillProfile,
} from "/src/core/equipment.js";

// Versioned, tiny runtime data set: source tables are never fetched or edited by the UI.
const equipmentCatalog = await (async () => {
  try {
    const response = await fetch("/data/equipment.v051.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new EquipmentCatalog(await response.json());
  } catch (error) {
    const warning = document.createElement("p");
    warning.setAttribute("role", "alert");
    warning.textContent = `Nie udało się wczytać katalogu wyposażenia: ${error.message}. Sprawdź, czy rozpakowano całą paczkę v0.5.11.`;
    document.body.prepend(warning);
    throw error;
  }
})();

const mouseSkillCatalog = await (async () => {
  try {
    const response = await fetch("/data/skill-mouse-bindings.v055.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new MouseSkillCatalog(await response.json());
  } catch (error) {
    const warning = document.createElement("p");
    warning.setAttribute("role", "alert");
    warning.textContent = `Nie udało się wczytać reguł LPM/PPM: ${error.message}.`;
    document.body.prepend(warning);
    throw error;
  }
})();

const skillTreeCatalog = await (async () => {
  try {
    const response = await fetch("/data/skill-tree-audit.d2r-3.3.93847.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new SkillTreeCatalog(await response.json());
  } catch (error) {
    const warning = document.createElement("p");
    warning.setAttribute("role", "alert");
    warning.textContent = `Nie udało się wczytać zweryfikowanych drzewek umiejętności D2R: ${error.message}.`;
    document.body.prepend(warning);
    throw error;
  }
})();
const SKILL_TREE_SAVE_SCHEMA_VERSION = 1;
const SKILL_TREE_CATALOG_ID = `d2r-skill-tree-audit-${skillTreeCatalog.installedBuild}`;
const SKILL_ICON_SLUG_OVERRIDES = new Map([
  ['barbarian:Blade Mastery', 'sword_mastery'],
]);
const skillIconSlug = (classId, skill) => SKILL_ICON_SLUG_OVERRIDES.get(`${classId}:${skill.internalName}`)
  || String(skill.localizedName?.enUS || skill.internalName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const skillIconUrl = (classId, skill) => `/app/assets/skill-icons/${classId}/${skillIconSlug(classId, skill)}.webp`;

// Runtime combat definitions are intentionally smaller than the full
// source-backed tree. Resolve their exact D2R/D2DB node when one exists so
// the action bar and chooser use the same real tile art as the skill panel.
function skillTreeSkillForDefinition(classId, definition) {
  if (!classId || !definition || classId === 'basic' || definition.id === 'basic.attack') return null;
  try { return skillTreeCatalog.skill(classId, definition.id); } catch { /* name fallback below */ }
  const normalizedName = String(definition.name ?? '').trim().toLowerCase();
  if (!normalizedName) return null;
  return skillTreeCatalog.skillsForClass(classId).find((skill) => [skill.internalName, skill.localizedName?.enUS, skill.localizedName?.plPL]
    .some((name) => String(name ?? '').trim().toLowerCase() === normalizedName)) ?? null;
}

function combatSkillIconUrl(character, skill) {
  const sourceSkill = skillTreeSkillForDefinition(character?.classId, skill);
  return sourceSkill ? skillIconUrl(character.classId, sourceSkill) : '';
}

import { createCharacter, Roster } from "/src/core/characters.js";
import {
  STARTER_ROSTER_DEFINITIONS,
  starterRosterDefinitionById,
  defaultActiveIds,
  createStarterRosterCharacters,
  createStarterInventoryItems,
  equipFreshStarterGear,
  migrateMissingStarterRoster,
} from "/src/core/starter-roster.js";
import { CampServicesState, CAMP_AKARA_CORE_STOCK, CAMP_SERVICES_SCHEMA_VERSION, CAMP_SUPPLY_DEFINITIONS } from "/src/core/camp-services.js";
import {
  BELT_SLOT_COUNT, emptyPotionBelt, starterHealthPotionBelt, potionKind, potionIconId, beltSlotCount,
  isPotionItem, validPotionBelt, putPotionInBelt, takePotionFromBelt, consumePotionFromBelt,
  potionBeltCapacity, resizePotionBelt,
} from "/src/core/potion-belt.js";
import { HoradricCubeState, HORADRIC_CUBE_SCHEMA_VERSION } from "/src/core/cube.js";
import { renderCubePanel } from "/app/cube-panel-v0518.js";
import { characterProgressionView, characterExperienceSegments, spendCharacterStatPoints } from "/src/core/progression.js";
import { PROGRESSION_DATA } from "/data/progression.v057.js";
import { Party } from "/src/core/party.js";
import { PlayersSetting } from "/src/core/players.js";
import {
  CombatState,
  ACTION_TIME,
  ATTACK_IMPACT_OFFSET,
  PROJECTILE_HEX_TIME,
  READINESS_PHASE,
  TIMELINE_MODE,
} from "/src/core/combat.js";
import { DeterministicRng } from "/src/core/rng.js";
import { DamageEngine } from "/src/core/damage.js";
import { InventoryGrid } from "/src/core/inventory-grid.js";
import {
  HexGrid,
  SINGLE_HEX_FOOTPRINT,
  axial,
  hexDisk,
  hexDistance,
  hexKey,
  hexNeighbors,
  oddRowOffsetToAxial,
} from "/src/core/hex-grid.js";
import { AI_PROFILE_IDS, decideMeleePressure } from "/src/core/ai-profiles.js";
import { ACT1_MONSTERS } from "/data/act1-encounters.v057.js";
import { resolveTauntControlDecision } from "/src/core/control-effects.js";
import { commitRaiseSkeleton, planRaiseSkeleton, planSummonTurn, RAISE_SKELETON_SKILL_ID, SUMMON_AI_PROFILE } from "/src/core/summons.js";
import { necroskeletonStats } from "/src/core/necroskeleton-source.js";
import { EncounterRules, PortalSystem, TownPortalScrollSupply } from "/src/core/portals.js";
import {
  BATTLE_PHASE,
  BATTLE_PREPARATION_SCHEMA_VERSION,
  SKILL_CATEGORY,
  UNIT_PRESENCE,
  BattlePreparationState,
} from "/src/core/battle-preparation.js";
import {
  DEFAULT_KEYBINDINGS,
  KeybindingAction,
  KeybindingConflictError,
  KeybindingManager,
} from "/src/core/keybindings.js";

const SAVE_KEY = "rotw-prototype-save-v3-equipment-v1-encounters-v1";
const LEGACY_EQUIPMENT_SAVE_KEY = "rotw-prototype-save-v3-equipment-v1";
const LEGACY_ITEM_SAVE_KEY = "rotw-prototype-save-v3";
const SAVE_BACKUP_KEY = `${SAVE_KEY}-backup`;
const saveBridge = createSaveBridge();
let preserveDiskPrimaryUntilSaved = false;
let preserveDiskBackupUntilSaved = false;
let lastLoadedSaveKind = null;
const GAME_RULESET_VERSION = "rotw-hex-combat-v0.5.0-preparation-adaptation";
const SOURCE_SNAPSHOT_ID = "pinkufairy-D2R-Excel-1f16064e09b97e3e65abd6943662207cff00b07f-partial-candidate";
const LEGACY_MOUSE_SKILL_CATALOG_IDS = new Set([
  "d2r-mouse-skill-bindings-v0.5.4",
  "d2r-mouse-skill-bindings-v0.5.5",
]);
let AREA_ID = "act1.blood_moor";
let INSTANCE_ID = "BM-01";
const TOWN_ID = "act1.rogue_encampment";
const DATA_PROFILE = "d2r-rotw-3.3-private-offline-audit-2026-09-12-v1";
const GRID_DIAGNOSTIC = new URLSearchParams(window.location.search).get("grid-debug") === "1";
document.documentElement.classList.toggle("grid-diagnostic", GRID_DIAGNOSTIC);

const classNames = {
  amazon: "Amazonka",
  assassin: "Zabójczyni",
  barbarian: "Barbarzyńca",
  druid: "Druid",
  necromancer: "Nekromanta",
  paladin: "Paladyn",
  sorceress: "Czarodziejka",
  warlock: "Czarnoksiężnik",
};

const classAccents = {
  amazon: "#c59446",
  assassin: "#8c557c",
  barbarian: "#ad573e",
  druid: "#8c7246",
  necromancer: "#6d9874",
  paladin: "#d0a953",
  sorceress: "#5385bc",
  warlock: "#865497",
};

const spritePaths = {
  ...Object.fromEntries(Object.entries(HERO_VISUALS).map(([classId, visual]) => [classId, visual.spritePath])),
  enemy: "/app/assets/unit-demon-red-v1.png",
  fallen: "/app/assets/unit-fallen-d2r-v1.png",
  zombie: "/app/assets/unit-zombie-d2r-v1.png",
};

// A read-only, in-game visual acceptance view. The normal inventory and its
// saved items remain untouched until the empty Diablo-style template is approved.
const EMPTY_INVENTORY_TEMPLATE = new URLSearchParams(window.location.search).get('inventory-template') === '1';

const LEGACY_BATTLEFIELD_FRAME = Object.freeze({ left: 0.2, right: 0.05, top: 0.05, bottom: 0.25 });
const LEGACY_BATTLEFIELD_GRID = Object.freeze({
  selection: "orthogonal-lattice-strong",
  columns: 21,
  totalTiles: 187,
  horizontalCoordinateQ: 11,
  horizontalCoordinateR: 1,
  horizontalCoordinateMin: -19,
  horizontalCoordinateMax: 203,
  horizontalLineQ: 3,
  horizontalLineR: 7,
  horizontalLineMin: -11,
  horizontalLineMax: 50,
  deploymentColumnStep: 11,
  enumerationRadius: 32,
  deploymentColumns: 3,
  hexWidthToHeight: Math.sqrt(3) / 2,
  shoulderYToHeight: 0.25,
  rowStepToHeight: 0.75,
  rotationDegrees: 25.284996046051784,
  diagnosticFrame: LEGACY_BATTLEFIELD_FRAME,
  corners: Object.freeze([
    Object.freeze({ x: 0, y: -0.5 }),
    Object.freeze({ x: 0.5, y: -0.25 }),
    Object.freeze({ x: 0.5, y: 0.25 }),
    Object.freeze({ x: 0, y: 0.5 }),
    Object.freeze({ x: -0.5, y: 0.25 }),
    Object.freeze({ x: -0.5, y: -0.25 }),
  ]),
});

// The approved v3 artwork uses flat-top hexes in odd columns. The same axial
// coordinates own both the rendered polygons and the HexGrid's gameplay cells.
const BATTLEFIELD_GRID = Object.freeze({
  selection: "approved-v3-odd-column",
  columns: 25,
  totalTiles: 213,
  deploymentColumns: 3,
  stageWidth: 1672,
  stageHeight: 941,
  left: 93,
  top: 67,
  radius: 39.1,
  rotationDegrees: 0,
});
const BATTLEFIELD_HEX_HEIGHT = Math.sqrt(3) * BATTLEFIELD_GRID.radius;
const BATTLEFIELD_CORNERS = Object.freeze([
  Object.freeze({ x: -BATTLEFIELD_GRID.radius / 2, y: -BATTLEFIELD_HEX_HEIGHT / 2 }),
  Object.freeze({ x: BATTLEFIELD_GRID.radius / 2, y: -BATTLEFIELD_HEX_HEIGHT / 2 }),
  Object.freeze({ x: BATTLEFIELD_GRID.radius, y: 0 }),
  Object.freeze({ x: BATTLEFIELD_GRID.radius / 2, y: BATTLEFIELD_HEX_HEIGHT / 2 }),
  Object.freeze({ x: -BATTLEFIELD_GRID.radius / 2, y: BATTLEFIELD_HEX_HEIGHT / 2 }),
  Object.freeze({ x: -BATTLEFIELD_GRID.radius, y: 0 }),
]);
let battlefieldGeometryMode = "approved-v3";

const BATTLEFIELD_ROTATION_RADIANS = LEGACY_BATTLEFIELD_GRID.rotationDegrees * Math.PI / 180;
const BATTLEFIELD_ROTATION_COS = Math.cos(BATTLEFIELD_ROTATION_RADIANS);
const BATTLEFIELD_ROTATION_SIN = Math.sin(BATTLEFIELD_ROTATION_RADIANS);

function rotateBattlefieldPoint(x, y) {
  return {
    x: x * BATTLEFIELD_ROTATION_COS - y * BATTLEFIELD_ROTATION_SIN,
    y: x * BATTLEFIELD_ROTATION_SIN + y * BATTLEFIELD_ROTATION_COS,
  };
}

function battlefieldNormalizedCenter(position, mode = battlefieldGeometryMode) {
  if (mode === "approved-v3") {
    return {
      x: BATTLEFIELD_GRID.left + BATTLEFIELD_GRID.radius + position.q * 1.5 * BATTLEFIELD_GRID.radius,
      y: BATTLEFIELD_GRID.top + BATTLEFIELD_HEX_HEIGHT / 2
        + (position.r + position.q / 2) * BATTLEFIELD_HEX_HEIGHT,
    };
  }
  return rotateBattlefieldPoint(
    (position.q + position.r / 2) * LEGACY_BATTLEFIELD_GRID.hexWidthToHeight,
    position.r * LEGACY_BATTLEFIELD_GRID.rowStepToHeight,
  );
}

function deploymentColumnForMode(mode) {
  return mode === "approved-v3" ? (position) => position.q : legacyDeploymentColumnOf;
}

function legacyDeploymentColumnOf(position) {
  const horizontalCoordinate = LEGACY_BATTLEFIELD_GRID.horizontalCoordinateQ * position.q
    + LEGACY_BATTLEFIELD_GRID.horizontalCoordinateR * position.r;
  return Math.max(0, Math.floor(
    (horizontalCoordinate - LEGACY_BATTLEFIELD_GRID.horizontalCoordinateMin)
      / (LEGACY_BATTLEFIELD_GRID.deploymentColumnStep + 1e-7),
  ));
}

function deploymentColumnOf(position) {
  return deploymentColumnForMode(battlefieldGeometryMode)(position);
}

function battlefieldRowOf(position) {
  return battlefieldGeometryMode === "approved-v3"
    ? position.r + Math.floor(position.q / 2)
    : LEGACY_BATTLEFIELD_GRID.horizontalLineQ * position.q
      + LEGACY_BATTLEFIELD_GRID.horizontalLineR * position.r
      - LEGACY_BATTLEFIELD_GRID.horizontalLineMin;
}

const attackProfiles = Object.freeze(Object.fromEntries(
  STARTER_ROSTER_DEFINITIONS.map(({ classId, attackProfile }) => [classId, Object.freeze({ ...attackProfile })]),
));

const heroes = createStarterRosterCharacters();

for (const hero of heroes) initializeEquipmentAttributes(hero, equipmentCatalog);
let roster = new Roster(heroes);
let party = new Party(roster, defaultActiveIds);
let players = new PlayersSetting(1);
let combatRng = new DeterministicRng(0xd2);
let damageEngine = new DamageEngine(combatRng);
let combat = new CombatState({ party, playersSetting: players, seed: 0xd2 });
const startupParams = new URLSearchParams(location.search);
const requestedExplorationTestSeed = startupParams.get('exploration-test-seed');
const explorationTestSeed = startupParams.get('exploration-test') === '1'
  && requestedExplorationTestSeed !== null
  && /^\d{1,10}$/.test(requestedExplorationTestSeed)
  && Number(requestedExplorationTestSeed) <= 0xffffffff
  ? Number(requestedExplorationTestSeed)
  : null;
let campaign = startupParams.get('training') === '1' ? null
  : new CampaignState(explorationTestSeed === null ? undefined : { worldSeed: explorationTestSeed });
let creationProfile = normalizeCreationProfile(null);

function spriteKeyForCharacter(character) {
  // Keep legacy gender data readable in saves, but render only the original class art.
  return character.classId;
}
function campaignEncounter(campaignRef = campaign) {
  return campaignRef?.act1Encounter?.() ?? ACT1_ENCOUNTERS.find(entry => entry.id === campaignRef?.act1?.currentEncounterId) ?? null;
}
function campaignBattleAvailable() {
  return !campaign || Boolean(campaign.act1.exploration.activeBattle
    && campaignEncounter()?.areaId === campaign.act1.currentAreaId);
}
function visibleGroundDrops(campaignRef = campaign, progressRef = encounterProgress) {
  return campaignRef ? campaignRef.groundAct1Drops() : groundDrops(progressRef);
}
function visibleLootMarker(campaignRef = campaign, progressRef = encounterProgress) {
  if (!campaignRef) return currentLootMarker(progressRef);
  const drop = campaignRef.groundAct1Drops()[0];
  return drop ? {id:drop.id,instanceId:drop.instanceId,hex:structuredClone(drop.hex)} : null;
}
let enemy = combat.spawnMonster({
  id: "fallen-1",
  name: "Upadły",
  baseHp: 42,
  baseExperience: 24,
  position: axial(7, 3),
});
let enemyAi = { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null };
let enemyAiById = { [enemy.id]: enemyAi };

function battleMonsters() {
  return [...combat.units.values()].filter(unit => unit.kind === "monster");
}

function livingMonsterAt(hex) {
  const unit = hex && hexGrid.has(hex) ? combat.units.get(hexGrid.occupantAt(hex)) : null;
  return unit?.kind === "monster" && unit.hp > 0 ? unit : null;
}

function selectTargetMonsterAt(hex) {
  const selected = livingMonsterAt(hex);
  if (!selected) return null;
  enemy = selected;
  enemyAi = enemyAiById[selected.id] ??= { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null };
  return selected;
}

function oddColumnOffsetToAxial(column, row) {
  return axial(column, row - Math.floor(column / 2));
}

function buildTiles(mode = "approved-v3") {
  if (mode === "approved-v3") {
    const tiles = [];
    for (let column = 0; column < BATTLEFIELD_GRID.columns; column += 1) {
      const rows = column % 2 ? 8 : 9;
      for (let row = 0; row < rows; row += 1) {
        tiles.push(oddColumnOffsetToAxial(column, row));
      }
    }
    return tiles;
  }
  if (mode !== "legacy-187") throw new Error(`Nieznana geometria pola walki: ${mode}`);
  const tiles = [];
  const limit = LEGACY_BATTLEFIELD_GRID.enumerationRadius;
  for (let q = -limit; q <= limit; q += 1) {
    for (let r = -limit; r <= limit; r += 1) {
      const horizontalLine = LEGACY_BATTLEFIELD_GRID.horizontalLineQ * q
        + LEGACY_BATTLEFIELD_GRID.horizontalLineR * r;
      if (horizontalLine < LEGACY_BATTLEFIELD_GRID.horizontalLineMin
        || horizontalLine > LEGACY_BATTLEFIELD_GRID.horizontalLineMax) continue;
      const position = axial(q, r);
      const horizontalCoordinate = LEGACY_BATTLEFIELD_GRID.horizontalCoordinateQ * q
        + LEGACY_BATTLEFIELD_GRID.horizontalCoordinateR * r;
      if (horizontalCoordinate < LEGACY_BATTLEFIELD_GRID.horizontalCoordinateMin
        || horizontalCoordinate > LEGACY_BATTLEFIELD_GRID.horizontalCoordinateMax) continue;
      tiles.push(position);
    }
  }
  return tiles.sort((left, right) => {
    const leftCenter = battlefieldNormalizedCenter(left, "legacy-187");
    const rightCenter = battlefieldNormalizedCenter(right, "legacy-187");
    return leftCenter.x - rightCenter.x || leftCenter.y - rightCenter.y;
  });
}

function battlefieldModeForTiles(tiles) {
  if (!Array.isArray(tiles)) throw new TypeError("Zapis nie zawiera pól planszy");
  const keys = new Set(tiles.map(hexKey));
  if (keys.size !== tiles.length) throw new Error("Zapis zawiera powielone heksy planszy");
  for (const mode of ["approved-v3", "legacy-187"]) {
    const expected = buildTiles(mode);
    const expectedKeys = new Set(expected.map(hexKey));
    if (keys.size === expected.length && [...keys].every((key) => expectedKeys.has(key))) return mode;
  }
  throw new Error("Zapis używa niezgodnej geometrii pola walki");
}

function relocateLegacyDropHexes(drops, nextGrid) {
  const tiles = nextGrid.tiles();
  for (const drop of drops) {
    if (nextGrid.has(drop.hex)) continue;
    // A completed 187-cell fight can leave receipts on cells that the new
    // topology does not contain. Keep every receipt and item; move only its
    // location in the newly staged battle, never in the stored old save.
    const nearest = tiles.reduce((best, tile) => (
      !best || hexDistance(drop.hex, tile) < hexDistance(drop.hex, best) ? tile : best
    ), null);
    drop.hex = { q: nearest.q, r: nearest.r };
  }
}

const blockedTerrain = [];
const partySlotPositions = Object.freeze([
  oddColumnOffsetToAxial(2, 3),
  oddColumnOffsetToAxial(1, 4),
  oddColumnOffsetToAxial(0, 5),
]);
const legacyPartySlotPositions = Object.freeze([
  oddRowOffsetToAxial(2, 3),
  oddRowOffsetToAxial(1, 4),
  oddRowOffsetToAxial(0, 5),
]);
const initialPositions = new Map([[enemy.id, oddColumnOffsetToAxial(10, 3)]]);

function assignInitialPartyPositions(heroIds = party.slots) {
  heroIds.forEach((id, index) => initialPositions.set(id, structuredClone(partySlotPositions[index])));
}

assignInitialPartyPositions();
STARTER_ROSTER_DEFINITIONS.forEach(({ id }, index) => {
  if (!initialPositions.has(id)) initialPositions.set(id, structuredClone(partySlotPositions[index % partySlotPositions.length]));
});

const skillDefinitions = Object.freeze({
  "basic.attack": { id: "basic.attack", name: "Atak", glyph: "⚔", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [1, 2], copy: "Zwykły atak aktualnie założoną bronią", status: "SOURCE_BACKED_CONTROL_SKILL" },
  "barbarian.bash": { id: "barbarian.bash", name: "Bash", glyph: "⚒", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [9, 13], copy: "Cios wręcz · sąsiedni heks", status: "ADAPTATION_PLACEHOLDER" },
  "barbarian.battle_orders": { id: "barbarian.battle_orders", name: "Battle Orders", glyph: "◉", category: SKILL_CATEGORY.BUFF, turns: 4, copy: "+życie i mana · 4 kolejki", status: "ADAPTATION_PLACEHOLDER" },
  "barbarian.shout": { id: "barbarian.shout", name: "Shout", glyph: "◖", category: SKILL_CATEGORY.BUFF, turns: 5, copy: "+obrona · 5 kolejek", status: "ADAPTATION_PLACEHOLDER" },
  "barbarian.whirlwind": { id: "barbarian.whirlwind", name: "Whirlwind", glyph: "↻", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [8, 12], copy: "Wir · cel na sąsiednim heksie", status: "ADAPTATION_PLACEHOLDER" },
  "barbarian.leap_attack": { id: "barbarian.leap_attack", name: "Leap Attack", glyph: "⌁", category: SKILL_CATEGORY.OFFENSIVE, range: 3, damage: [8, 13], copy: "Skok ofensywny · zasięg 3", status: "ADAPTATION_PLACEHOLDER" },
  "paladin.zeal": { id: "paladin.zeal", name: "Zeal", glyph: "✥", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [8, 12], copy: "Atak wręcz · sąsiedni heks", status: "ADAPTATION_PLACEHOLDER" },
  "paladin.might": { id: "paladin.might", name: "Might", glyph: "✦", category: SKILL_CATEGORY.AURA, turns: null, copy: "Aura: +obrażenia · drużyna", status: "ADAPTATION_PLACEHOLDER" },
  "paladin.holy_fire": { id: "paladin.holy_fire", name: "Holy Fire", glyph: "♨", category: SKILL_CATEGORY.AURA, turns: null, copy: "Aura: ogień · drużyna", status: "ADAPTATION_PLACEHOLDER" },
  "paladin.blessed_hammer": { id: "paladin.blessed_hammer", name: "Blessed Hammer", glyph: "✣", category: SKILL_CATEGORY.OFFENSIVE, range: 4, damage: [7, 11], copy: "Magiczny pocisk · zasięg 4", status: "ADAPTATION_PLACEHOLDER" },
  "paladin.smite": { id: "paladin.smite", name: "Smite", glyph: "▣", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [7, 10], copy: "Uderzenie tarczą · sąsiedni heks", status: "ADAPTATION_PLACEHOLDER" },
  "necromancer.teeth": { id: "necromancer.teeth", name: "Teeth", glyph: "⋔", category: SKILL_CATEGORY.OFFENSIVE, range: 5, damage: [6, 9], copy: "Kościany pocisk · zasięg 5", status: "ADAPTATION_PLACEHOLDER" },
  "necromancer.raise_skeleton": { id: "necromancer.raise_skeleton", name: "Raise Skeleton", glyph: "☠", category: SKILL_CATEGORY.SUMMON, summonKind: "skeleton", copy: "Przywołanie · limit armii 4", status: "ADAPTATION_PLACEHOLDER" },
  "necromancer.clay_golem": { id: "necromancer.clay_golem", name: "Clay Golem", glyph: "♟", category: SKILL_CATEGORY.SUMMON, summonKind: "clay_golem", copy: "Golem trwa między walkami", status: "ADAPTATION_PLACEHOLDER" },
  "necromancer.amplify_damage": { id: "necromancer.amplify_damage", name: "Amplify Damage", glyph: "☽", category: SKILL_CATEGORY.OFFENSIVE, visualCategory: "curse", range: 12, damage: [0, 0], copy: "Klątwa ofensywna · zasięg 12", status: "ADAPTATION_PLACEHOLDER" },
  "necromancer.corpse_explosion": { id: "necromancer.corpse_explosion", name: "Corpse Explosion", glyph: "✹", category: SKILL_CATEGORY.OFFENSIVE, range: 5, damage: [8, 14], copy: "Wymaga zwłok · profil jeszcze uproszczony", status: "ADAPTATION_PLACEHOLDER" },
  "druid.maul": { id: "druid.maul", name: "Maul", glyph: "爪", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [9, 13], copy: "Atak wręcz", status: "ADAPTATION_PLACEHOLDER" },
  "druid.spirit_wolf": { id: "druid.spirit_wolf", name: "Summon Spirit Wolf", glyph: "狼", category: SKILL_CATEGORY.SUMMON, summonKind: "spirit_wolf", copy: "Wilk utrzymywany między walkami", status: "ADAPTATION_PLACEHOLDER" },
  "druid.oak_sage": { id: "druid.oak_sage", name: "Oak Sage", glyph: "♧", category: SKILL_CATEGORY.SUMMON, summonKind: "oak_sage", copy: "Duch wspierający drużynę", status: "ADAPTATION_PLACEHOLDER" },
  "druid.grizzly": { id: "druid.grizzly", name: "Summon Grizzly", glyph: "熊", category: SKILL_CATEGORY.SUMMON, summonKind: "grizzly", copy: "Niedźwiedź · limit builda", status: "ADAPTATION_PLACEHOLDER" },
  "amazon.jab": { id: "amazon.jab", name: "Jab", glyph: "⚔", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [3, 6], copy: "Szybki atak aktualnie założoną bronią", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "amazon.magic_arrow": { id: "amazon.magic_arrow", name: "Magic Arrow", glyph: "➶", category: SKILL_CATEGORY.OFFENSIVE, range: 6, damage: [4, 7], copy: "Magiczny pocisk · zasięg 6", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "amazon.fire_arrow": { id: "amazon.fire_arrow", name: "Fire Arrow", glyph: "♨", category: SKILL_CATEGORY.OFFENSIVE, range: 6, damage: [5, 8], copy: "Ognisty pocisk · zasięg 6", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "amazon.inner_sight": { id: "amazon.inner_sight", name: "Inner Sight", glyph: "◉", category: SKILL_CATEGORY.BUFF, turns: 3, copy: "Oznacza i odsłania przeciwników · 3 kolejki", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "assassin.tiger_strike": { id: "assassin.tiger_strike", name: "Tiger Strike", glyph: "◆", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [4, 8], copy: "Atak wręcz aktualnie założoną bronią", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "assassin.dragon_talon": { id: "assassin.dragon_talon", name: "Dragon Talon", glyph: "爪", category: SKILL_CATEGORY.OFFENSIVE, range: 1, damage: [4, 7], copy: "Kopnięcie · sąsiedni heks", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "assassin.fire_trauma": { id: "assassin.fire_trauma", name: "Fire Trauma", glyph: "✹", category: SKILL_CATEGORY.OFFENSIVE, range: 5, damage: [5, 9], copy: "Ognista pułapka · zasięg 5", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "assassin.psychic_hammer": { id: "assassin.psychic_hammer", name: "Psychic Hammer", glyph: "✦", category: SKILL_CATEGORY.OFFENSIVE, range: 4, damage: [4, 8], copy: "Psychiczny pocisk · zasięg 4", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "sorceress.fire_bolt": { id: "sorceress.fire_bolt", name: "Fire Bolt", glyph: "♨", category: SKILL_CATEGORY.OFFENSIVE, range: 6, damage: [4, 8], copy: "Ognisty pocisk · zasięg 6", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "sorceress.charged_bolt": { id: "sorceress.charged_bolt", name: "Charged Bolt", glyph: "ϟ", category: SKILL_CATEGORY.OFFENSIVE, range: 5, damage: [3, 7], copy: "Pocisk błyskawic · zasięg 5", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "sorceress.ice_bolt": { id: "sorceress.ice_bolt", name: "Ice Bolt", glyph: "❄", category: SKILL_CATEGORY.OFFENSIVE, range: 6, damage: [4, 7], copy: "Lodowy pocisk · zasięg 6", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "sorceress.frozen_armor": { id: "sorceress.frozen_armor", name: "Frozen Armor", glyph: "◇", category: SKILL_CATEGORY.BUFF, turns: 5, copy: "Lodowa osłona · 5 kolejek", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "warlock.miasma_bolt": { id: "warlock.miasma_bolt", name: "Miasma Bolt", glyph: "◈", category: SKILL_CATEGORY.OFFENSIVE, range: 6, damage: [4, 8], copy: "Pocisk miazmy · zasięg 6", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "warlock.hex_bane": { id: "warlock.hex_bane", name: "Hex Bane", glyph: "☽", category: SKILL_CATEGORY.OFFENSIVE, range: 5, damage: [4, 7], copy: "Klątwa ofensywna · zasięg 5", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
  "warlock.summon_goatman": { id: "warlock.summon_goatman", name: "Summon Goatman", glyph: "♟", category: SKILL_CATEGORY.SUMMON, summonKind: "goatman", copy: "Przywołuje sługę · limit builda", status: "SOURCE_BACKED_RUNTIME_ADAPTER" },
});

const defaultLoadouts = Object.freeze(Object.fromEntries(STARTER_ROSTER_DEFINITIONS.map(({ id, loadout }) => [
  id,
  Object.freeze({ left: loadout.left, right: Object.freeze([...loadout.right]) }),
])));

for (const definition of Object.values(skillDefinitions)) {
  const source = skillTreeSkillForDefinition(definition.id.split('.')[0], definition);
  if (source) definition.name = source.localizedName.plPL || source.localizedName.enUS;
}

const reserveLoadouts = defaultLoadouts;

const alternateSkills = Object.freeze({
  barbarian: "barbarian.leap_attack",
  paladin: "paladin.smite",
  necromancer: "necromancer.corpse_explosion",
});

function runtimeLoadoutForHero(heroId, { partyRef = party, preparationRef = battlePreparation } = {}) {
  if (partyRef?.isActive?.(heroId)) return preparationRef.getLoadout(heroId);
  const fallback = reserveLoadouts[heroId];
  if (!fallback) throw new Error(`Brak loadoutu dla ${heroId}`);
  return fallback;
}

function knownMouseSkillsForHero(heroId, { rosterRef = roster, partyRef = party, preparationRef = battlePreparation } = {}) {
  const character = rosterRef.get(heroId);
  return ['basic.attack', ...nativeSkillSources(character, skillTreeCatalog)
    .map(entry => entry.skillId).filter(id => skillDefinitions[id] && mouseSkillCatalog.has(id))];
}

function refreshHeroSkillAvailability(heroId) {
  const changed = mouseSkills.refreshKnown(heroId, knownMouseSkillsForHero(heroId));
  skillHotkeys.retainAvailable(heroId, (id,side) => mouseSkills.available(heroId,side).includes(id));
  if (changed) { primaryHoverPlan = null; hoveredHex = null; }
}

function createMouseSkillState({ rosterRef = roster, partyRef = party, preparationRef = battlePreparation, snapshot = null } = {}) {
  const heroIds = rosterRef.toJSON().map(({ id }) => id);
  const knownSkillsByHero = Object.fromEntries(heroIds.map((heroId) => [
    heroId,
    knownMouseSkillsForHero(heroId, { rosterRef, partyRef, preparationRef }),
  ]));
  if (snapshot) {
    const migrated = structuredClone(snapshot);
    // Previous builds bound class loadout skills without checking learned ranks.
    // Preserve all progress; replace only those now-illegal mouse assignments.
    for (const entry of migrated.bindings ?? []) {
      for (const side of ['left', 'right']) {
        if (skillDefinitions[entry[side]] && !knownSkillsByHero[entry.heroId]?.includes(entry[side])) entry[side] = 'basic.attack';
      }
    }
    return MouseSkillBindings.restore(migrated, { heroIds, knownSkillsByHero, catalog: mouseSkillCatalog });
  }
  const loadoutDefaults = defaultMouseBindingsFromLoadouts(
    heroIds,
    (heroId) => runtimeLoadoutForHero(heroId, { partyRef, preparationRef }),
    mouseSkillCatalog,
  );
  // Fresh characters use the source-backed generic Attack on LPM, matching the
  // classic Diablo control baseline. Existing saves keep their persisted LPM.
  const initialBindings = Object.freeze(Object.fromEntries(heroIds.map((heroId) => [
    heroId,
    Object.freeze({ left: "basic.attack", right: knownSkillsByHero[heroId].includes(loadoutDefaults[heroId].right) ? loadoutDefaults[heroId].right : 'basic.attack' }),
  ])));
  return new MouseSkillBindings({ heroIds, knownSkillsByHero, initialBindings, catalog: mouseSkillCatalog });
}

function newPreparationState(heroIds = party.slots) {
  return new BattlePreparationState({
    heroIds,
    loadouts: Object.fromEntries(heroIds.map((id) => [id, defaultLoadouts[id]])),
    heroPositions: Object.fromEntries(heroIds.map((id) => [id, initialPositions.get(id)])),
    persistentSummons: [],
    summonLimits: { skeleton: 3, clay_golem: 1, goatman: 2 },
    defaultSummonLimit: 4,
    deploymentColumnOf: deploymentColumnForMode("approved-v3"),
  });
}

let battlePreparation = newPreparationState();
let mouseSkills = createMouseSkillState();
let skillHotkeys = new SkillHotkeys(roster.toJSON().map(({id}) => id));
let hoveredSkillChoice = null;

function createHexGrid(units = null, {
  rosterRef = roster,
  partyRef = party,
  enemyRef = enemy,
} = {}) {
  const grid = new HexGrid({ tiles: buildTiles(), blockedTerrain });
  const source = units ?? [
    ...partyRef.slots.map((id) => ({ id, position: initialPositions.get(id), footprint: 0 })),
    { id: enemyRef.id, position: initialPositions.get(enemyRef.id), footprint: SINGLE_HEX_FOOTPRINT },
  ];
  for (const unit of source) {
    const character = rosterRef.has(unit.id) ? rosterRef.get(unit.id) : null;
    if (!units && character && (character.lifeState !== "alive" || character.resources.hp <= 0)) continue;
    if (unit.id === enemyRef.id && enemyRef.hp <= 0) continue;
    grid.addUnit({
      id: unit.id,
      position: axial(unit.position.q, unit.position.r),
      footprint: unit.footprint ?? SINGLE_HEX_FOOTPRINT,
    });
  }
  return grid;
}

let hexGrid = createHexGrid();
for (const id of party.slots) combat.units.get(id).position = hexGrid.positionOf(id);
enemy.position = hexGrid.positionOf(enemy.id);

let portalSystem = new PortalSystem();
for (const hero of heroes) {
  portalSystem.setCharacterLocation(hero.id, {
    kind: "area",
    area_id: AREA_ID,
    instance_id: INSTANCE_ID,
    hex: initialPositions.get(hero.id),
  });
}

const encounterRules = EncounterRules.standard({
  id: "blood_moor_standard",
  allowTownPortal: true,
  allHeroesLeave: "suspend",
  closeOnOwnerReturn: true,
});

let portalScrolls = new Map(heroes.map(({ id }) => [id, new TownPortalScrollSupply({ tomeScrolls: 3 })]));

function makeInventory(items) {
  return new InventoryGrid({ width: 10, height: 4, items });
}

const starterInventoryItems = createStarterInventoryItems(equipmentCatalog);
let inventories = new Map([...starterInventoryItems].map(([id, items]) => [id, makeInventory(items)]));
equipFreshStarterGear(roster, inventories, equipmentCatalog);
for (const hero of heroes) hero.inventoryItemIds = inventories.get(hero.id).toJSON().items.map(({ id }) => id);
validateEquipmentWorld(roster, inventories, equipmentCatalog);
let campServices = new CampServicesState({ catalog: equipmentCatalog });
let horadricCube = new HoradricCubeState();

let belts = new Map(heroes.map(({ id }) => [id, starterHealthPotionBelt(id)]));
let weaponSets = new Map(heroes.map(({ id }) => [id, 1]));
const hirelingsByOwner = new Map();

let actingUnitId = party.slots[0];
let inspectedCharacterId = party.slots[0];
let activePanel = null;
let selectedSkillTreePage = 1;
const gameMusic = new GameMusic();
let mainMenuOpen = true;
let pendingTarget = null;
let pendingTargetActorId = null;
let pendingSkillId = null;
let pendingSkillSide = null;
let pendingSkillUseCommitted = false;
let mouseSkillChooserSide = null;
let hoveredHex = null;
let primaryHoverPlan = null;
let movementChoices = new Map();
let portalChoices = new Set();
let pendingReturns = new Set();
let loot = null;
let encounterProgress = createEncounterProgress();
let lootNotice = "";
let logCutoff = 0;
let viewport = { width: 1, height: 1, ratio: 1 };
let battlefieldLayoutCache = null;
let toastTimer = null;
let shortcutManager = null;
let focusBeforePause = null;
let pausedBackgroundState = new Map();
let focusBeforePanel = null;
let panelBackgroundState = null;
let selectedInventoryItem = null;
let inventoryNotice = "";
const explorationCameraByArea = new Map();
let explorationGesture = null;
let explorationCommandLocked = false;
let explorationReturnQueued = false;
let explorationSuppressClick = false;

const canvas = document.querySelector("#scene");
const context = canvas.getContext("2d", { alpha: true });
let battleAnimationBusy = false;
let battleAnimationEpoch = 0;
let battleImpactVisual = null;
let prioritizedBarbarianWalk = null;
const deferredWalkReadiness = new Map();
const barbarianAtlases = {};
const paladinAtlases = {};
const sorceressAtlases = {};
const heroAnimationAtlases = {};
const heroAnimationItems = {};
const battleAnimation = new BattleAnimationPlayer({
  paused: () => isPaused() || mainMenuOpen || document.hidden,
  draw: () => drawScene(),
});
for (const [clip, url] of [...Object.entries(BARBARIAN_ATLASES), ...Object.entries(BARBARIAN_UNARMED_ATLASES)]) {
  const image = new Image();
  image.addEventListener('load', () => {
    barbarianAtlases[clip] = {image, frames: measureAtlas(image, document, clip.includes('diagonal') ? 8 : 4)};
    drawScene();
  });
  image.addEventListener('error', () => console.error(`Brak atlasu animacji: ${url}`));
  image.src = url;
}
for (const [variant, url] of Object.entries(PALADIN_ATLASES)) {
  const image = new Image();
  image.addEventListener('load', () => {
    paladinAtlases[variant] = {image, frames: measureAtlas(image, document, 8)};
    drawScene();
  });
  image.addEventListener('error', () => console.error(`Brak atlasu animacji: ${url}`));
  image.src = url;
}
for (const [variant, url] of Object.entries(SORCERESS_ATLASES)) {
  const image = new Image();
  image.addEventListener('load', () => {
    sorceressAtlases[variant] = {image, frames: measureAtlas(image, document, 8)};
    drawScene();
  });
  image.addEventListener('error', () => console.error(`Brak atlasu animacji: ${url}`));
  image.src = url;
}
for (const [classId, url] of Object.entries(HERO_BODY_ATLASES)) {
  const image = new Image();
  image.addEventListener('load', () => {
    heroAnimationAtlases[classId] = {image, frames: measureAtlas(image, document, 8)};
    drawScene();
  });
  image.addEventListener('error', () => console.error(`Brak atlasu animacji: ${url}`));
  image.src = url;
}
for (const item of equipmentCatalog.all()) {
  if (!['weapon', 'offhand'].includes(item.slot) || !hasTradeItemArtwork(item.id)) continue;
  const image = new Image();
  image.addEventListener('load', () => { heroAnimationItems[item.id] = image; drawScene(); });
  image.addEventListener('error', () => console.error(`Brak grafiki broni: ${item.id}`));
  image.src = `/app/assets/items/${item.id}.png`;
}
function animatedBarbarian(id) {
  return roster.has(id) && supportsBarbarianAnimation(roster.get(id))
    && barbarianAtlases.walk?.frames && barbarianAtlases.attack?.frames && barbarianAtlases.diagonal?.frames;
}
function barbarianWalkAnimationAvailable(id) {
  if (!roster.has(id)) return false;
  const variant = barbarianWalkVariant(roster.get(id));
  if (!variant) return false;
  const atlasKeys = variant === 'unarmed' ? ['walkUnarmed', 'diagonalUnarmed']
    : variant === 'hand_axe' ? ['diagonalHandAxe'] : ['walk', 'diagonal'];
  return atlasKeys.every(key => barbarianAtlases[key]?.frames);
}
function barbarianAttackAnimationAvailable(id) {
  if (!roster.has(id)) return false;
  const variant = barbarianWalkVariant(roster.get(id));
  return variant === 'unarmed' || variant === 'hand_axe' ? barbarianWalkAnimationAvailable(id)
    : variant === 'short_sword' && Boolean(animatedBarbarian(id));
}
function paladinAnimationAvailable(id) {
  if (!roster.has(id)) return false;
  const variant = paladinAnimationVariant(roster.get(id));
  return Boolean(variant && paladinAtlases[variant]?.frames);
}
function sorceressAnimationAvailable(id) {
  if (!roster.has(id)) return false;
  const variant = sorceressAnimationVariant(roster.get(id));
  return Boolean(variant && sorceressAtlases[variant]?.frames);
}
function genericHeroAnimationAvailable(id) {
  if (!roster.has(id)) return false;
  const loadout = heroAnimationLoadout(roster.get(id), equipmentCatalog);
  return Boolean(loadout && heroAnimationAtlases[loadout.classId]?.frames
    && (!loadout.weaponId || heroAnimationItems[loadout.weaponId]?.naturalWidth > 0)
    && (!loadout.offhandId || heroAnimationItems[loadout.offhandId]?.naturalWidth > 0));
}
function heroWalkAnimationAvailable(id) {
  return barbarianWalkAnimationAvailable(id) || paladinAnimationAvailable(id)
    || sorceressAnimationAvailable(id) || genericHeroAnimationAvailable(id);
}
function heroAttackAnimationAvailable(id) {
  return barbarianAttackAnimationAvailable(id) || paladinAnimationAvailable(id)
    || sorceressAnimationAvailable(id) || genericHeroAnimationAvailable(id);
}
function presentedPoint(id) {
  return battleAnimation.point(id, hexToScreen(hexGrid.positionOf(id)));
}
// Prevent a second order during playback. Escape/pause remains usable.
for (const type of ['click', 'dblclick', 'contextmenu', 'keydown', 'drop']) {
  window.addEventListener(type, event => {
    if (!battleAnimationBusy || isPaused() || mainMenuOpen || event.key === 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
}
let idleAnimationFrame = 0;
function scheduleBarbarianIdle() {
  if (idleAnimationFrame) return;
  idleAnimationFrame = requestAnimationFrame(() => {
    idleAnimationFrame = 0;
    if (!battleAnimationBusy && !isPaused() && !mainMenuOpen && !document.hidden
      && campaignBattleAvailable() && party.slots.some(animatedBarbarian)) drawScene();
  });
}
const partyRoot = document.querySelector("#party");
const logRoot = document.querySelector("#combat-log");
const emptyLog = document.querySelector("#empty-log");
const panelLayer = document.querySelector("#panel-layer");
const panelBody = document.querySelector("#panel-body");
const pauseOverlay = document.querySelector("#pause-overlay");
const gameShell = document.querySelector("#app");
const campLayer = document.querySelector("#camp-layer");
const campScene = campLayer.querySelector(".camp-scene");
// Coordinates are measured on the 1659 x 948 camp painting. The painting uses
// background-size: cover, so percentage positions drift whenever the crop changes.
const CAMP_PAINTING = Object.freeze({ width: 1659, height: 948 });
const CAMP_HOTSPOTS = Object.freeze({
  akara: [1385, 535, 140, 174],
  charsi: [539, 370, 140, 174],
  kashya: [1170, 550, 140, 174],
  gheed: [390, 535, 140, 174],
  warriv: [191, 515, 140, 174],
  cain: [1030, 410, 140, 174],
  stash: [730, 365, 88, 68],
  waypoint: [1260, 185, 210, 112],
  gate: [1395, 720, 155, 82],
});
let campWaypointWasActive = null;
let campWaypointFlashTimeout;
function positionCampHotspots() {
  const { width, height } = campScene.getBoundingClientRect();
  if (!width || !height) return;
  const scale = Math.max(width / CAMP_PAINTING.width, height / CAMP_PAINTING.height);
  const cropLeft = (width - CAMP_PAINTING.width * scale) / 2;
  const cropTop = (height - CAMP_PAINTING.height * scale) / 2;
  for (const [action, [x, y, w, h]] of Object.entries(CAMP_HOTSPOTS)) {
    const hotspot = campScene.querySelector(`[data-camp-action="${action}"]`);
    hotspot.style.left = `${cropLeft + x * scale}px`;
    hotspot.style.top = `${cropTop + y * scale}px`;
    hotspot.style.width = `${w * scale}px`;
    hotspot.style.height = `${h * scale}px`;
  }
}
new ResizeObserver(positionCampHotspots).observe(campScene);
const teamSelectionLayer = document.querySelector("#team-selection-layer");
const teamSelectionGrid = document.querySelector("#team-selection-grid");
const SKIP_TEAM_SELECTION = new URLSearchParams(location.search).get("skip-team-selection") === "1";
const CAIN_RESCUED_PREVIEW = new URLSearchParams(location.search).get("cain-rescued") === "1";
let teamSelectionIds = [...party.slots];
let teamSelectionMandatory = false;
let teamSelectionBackgroundState = null;

function isPaused() {
  return !pauseOverlay.classList.contains("hidden");
}

function isSafeCamp() {
  return Boolean(campaign
    && campaign.act1.currentAreaId === TOWN_ID
    && campaign.act1.exploration.activeBattle === null
    && !Object.values(campaign.act1.encounters).some(({ status }) => status === "active"));
}

function syncMusicScene() {
  const scene = mainMenuOpen ? "menu"
    : campaignBattleAvailable() && battlePreparation.phase !== BATTLE_PHASE.COMPLETED ? "battle"
    : activePanel === "map" ? "map"
    : isSafeCamp() ? "camp" : "exploration";
  gameMusic.setScene(scene);
}

function syncCampScene() {
  const visible = isSafeCamp();
  gameShell.classList.toggle("camp-mode", visible);
  campLayer.classList.toggle("hidden", !visible);
  campLayer.setAttribute("aria-hidden", String(!visible));
  document.querySelector("#camp-gold").textContent = String(campServices.gold);
  document.querySelector("#camp-party strong").textContent = party.activeCharacters().map(({ name }) => name).join(" · ");
  const campHeroes = campLayer.querySelector('#camp-party-heroes');
  const activeHeroes = party.activeCharacters();
  const heroSignature = JSON.stringify(activeHeroes.map(({ id, name, classId }) => [id, name, classId]));
  if (campHeroes.dataset.signature !== heroSignature) {
    const positions = {
      1: [[53, 33]],
      2: [[48.5, 33], [57.5, 33]],
      3: [[44, 33], [53, 33], [62, 33]],
    }[activeHeroes.length] ?? [];
    campHeroes.replaceChildren(...activeHeroes.map((character, index) => {
      const figure = make('figure', 'camp-party-hero');
      figure.style.setProperty('--camp-hero-x', `${positions[index][0]}%`);
      figure.style.setProperty('--camp-hero-y', `${positions[index][1]}%`);
      const portrait = make('img');
      portrait.src = spritePaths[spriteKeyForCharacter(character)];
      portrait.alt = '';
      portrait.draggable = false;
      figure.append(portrait, make('figcaption', '', character.name));
      return figure;
    }));
    campHeroes.dataset.signature = heroSignature;
  }
  const cain = campLayer.querySelector('[data-camp-action="cain"]');
  cain.classList.toggle("hidden", !CAIN_RESCUED_PREVIEW);
  cain.setAttribute("aria-hidden", String(!CAIN_RESCUED_PREVIEW));
  const waypoint = campLayer.querySelector('[data-camp-action="waypoint"]');
  const waypointActive = campaign?.waypoints[TOWN_ID] === true;
  waypoint.classList.toggle("is-active", waypointActive);
  waypoint.setAttribute("aria-label", waypointActive
    ? "Aktywny punkt nawigacyjny — otwórz odkryte lokacje"
    : "Odkryty punkt nawigacyjny — otwórz i aktywuj");
  if (visible && campWaypointWasActive === false && waypointActive) {
    waypoint.classList.remove("is-activating");
    void waypoint.offsetWidth;
    waypoint.classList.add("is-activating");
    clearTimeout(campWaypointFlashTimeout);
    campWaypointFlashTimeout = setTimeout(() => waypoint.classList.remove("is-activating"), 1100);
  }
  campWaypointWasActive = waypointActive;
}

const backgroundImage = new Image();
backgroundImage.decoding = "async";
backgroundImage.src = "/app/assets/battlefield-blood-moor-v1.png";
backgroundImage.addEventListener("load", drawScene);
const dungeonImage = new Image();
dungeonImage.src = '/app/assets/battlefield-gothic-v1.png';
dungeonImage.addEventListener('load', drawScene);
const cleanGroundImage = new Image();
cleanGroundImage.decoding = "async";
cleanGroundImage.src = "/app/assets/battlefield-blood-moor-clean-ground-v2.png";
cleanGroundImage.addEventListener("load", drawScene);
let cleanGroundLayerCache = null;

const spriteUsable = new Map();
const spriteAssets = Object.fromEntries(Object.entries(spritePaths).filter(([, source]) => Boolean(source)).map(([key, source]) => {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  image.addEventListener("load", () => {
    spriteUsable.set(key, hasTransparentCorners(image));
    render();
  });
  image.addEventListener("error", render);
  return [key, image];
}));

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatSeconds(milliseconds) {
  return (milliseconds / 1000).toFixed(2).replace(".", ",");
}

function hasTransparentCorners(image) {
  try {
    const sample = document.createElement("canvas");
    sample.width = 4;
    sample.height = 1;
    const sampleContext = sample.getContext("2d", { willReadFrequently: true });
    const corners = [[0, 0], [image.naturalWidth - 1, 0], [0, image.naturalHeight - 1], [image.naturalWidth - 1, image.naturalHeight - 1]];
    corners.forEach(([sourceX, sourceY], index) => sampleContext.drawImage(image, sourceX, sourceY, 1, 1, index, 0, 1, 1));
    const pixels = sampleContext.getImageData(0, 0, 4, 1).data;
    return [3, 7, 11, 15].every((index) => pixels[index] < 24);
  } catch {
    return false;
  }
}

function battlefieldFrame() {
  if (battlefieldGeometryMode === "legacy-187") {
    if (!GRID_DIAGNOSTIC) {
      const canvasRect = canvas.getBoundingClientRect();
      const edgeInsetX = 1;
      const edgeInsetY = 1;
      const left = Math.max(edgeInsetX, window.innerWidth * 0.2 - canvasRect.left);
      const top = Math.max(edgeInsetY, window.innerHeight * 0.05 - canvasRect.top);
      const right = Math.min(viewport.width - edgeInsetX, window.innerWidth * 0.95 - canvasRect.left);
      const bottom = Math.min(viewport.height - edgeInsetY, window.innerHeight * 0.75 - canvasRect.top);
      return {
        left: Math.min(left, right - 1),
        top: Math.min(top, bottom - 1),
        right,
        bottom: Math.max(top + 1, bottom),
      };
    }
    const frame = LEGACY_BATTLEFIELD_GRID.diagnosticFrame;
    return {
      left: viewport.width * frame.left,
      top: viewport.height * frame.top,
      right: viewport.width * (1 - frame.right),
      bottom: viewport.height * (1 - frame.bottom),
    };
  }

  const canvasRect = canvas.getBoundingClientRect();
  const fit = Math.min(window.innerWidth / BATTLEFIELD_GRID.stageWidth,
    window.innerHeight / BATTLEFIELD_GRID.stageHeight);
  const stageLeft = (window.innerWidth - BATTLEFIELD_GRID.stageWidth * fit) / 2;
  const stageTop = (window.innerHeight - BATTLEFIELD_GRID.stageHeight * fit) / 2;
  const desired = {
    left: stageLeft + BATTLEFIELD_GRID.left * fit - canvasRect.left,
    top: stageTop + BATTLEFIELD_GRID.top * fit - canvasRect.top,
    right: stageLeft + (BATTLEFIELD_GRID.left + BATTLEFIELD_GRID.radius * (2 + 1.5 * (BATTLEFIELD_GRID.columns - 1))) * fit - canvasRect.left,
    bottom: stageTop + (BATTLEFIELD_GRID.top + 9 * BATTLEFIELD_HEX_HEIGHT) * fit - canvasRect.top,
  };
  if (desired.left >= 1 && desired.top >= 1
    && desired.right <= viewport.width - 1 && desired.bottom <= viewport.height - 1) return desired;
  // Existing partial-canvas UI needs the same complete topology inside its
  // actual click surface until the approved full-stage composition is installed.
  return { left: 1, top: 1, right: viewport.width - 1, bottom: viewport.height - 1 };
}

function layoutMetrics() {
  const frame = battlefieldFrame();
  const cacheKey = [
    viewport.width,
    viewport.height,
    frame.left,
    frame.top,
    frame.right,
    frame.bottom,
    GRID_DIAGNOSTIC ? 1 : 0,
  ].map((value) => Number(value).toFixed(3)).join(":");
  const modeCacheKey = `${battlefieldGeometryMode}:${cacheKey}`;
  if (battlefieldLayoutCache?.key === modeCacheKey) {
    return battlefieldLayoutCache.metrics;
  }

  const corners = battlefieldGeometryMode === "approved-v3"
    ? BATTLEFIELD_CORNERS
    : LEGACY_BATTLEFIELD_GRID.corners.map((corner) => rotateBattlefieldPoint(
      corner.x * LEGACY_BATTLEFIELD_GRID.hexWidthToHeight, corner.y,
    ));
  const normalizedVertices = [];
  for (const tile of hexGrid.tiles()) {
    const center = battlefieldNormalizedCenter(tile);
    for (const corner of corners) {
      normalizedVertices.push({ x: center.x + corner.x, y: center.y + corner.y });
    }
  }
  const minimumX = Math.min(...normalizedVertices.map(({ x }) => x));
  const maximumX = Math.max(...normalizedVertices.map(({ x }) => x));
  const minimumY = Math.min(...normalizedVertices.map(({ y }) => y));
  const maximumY = Math.max(...normalizedVertices.map(({ y }) => y));
  const horizontalSpan = maximumX - minimumX;
  const verticalSpan = maximumY - minimumY;
  const fitX = (frame.right - frame.left) / horizontalSpan;
  const fitY = (frame.bottom - frame.top) / verticalSpan;
  const uniform = battlefieldGeometryMode === "approved-v3";
  const scaleX = uniform ? Math.min(fitX, fitY) : fitX;
  const scaleY = uniform ? scaleX : fitY;
  const gridWidth = horizontalSpan * scaleX;
  const gridHeight = verticalSpan * scaleY;
  const left = frame.left + (frame.right - frame.left - gridWidth) / 2;
  const top = frame.top + (frame.bottom - frame.top - gridHeight) / 2;
  const origin = battlefieldNormalizedCenter(axial(0, 0));
  const qCenter = battlefieldNormalizedCenter(axial(1, 0));
  const rCenter = battlefieldNormalizedCenter(axial(0, 1));
  const hexWidth = uniform ? 2 * BATTLEFIELD_GRID.radius * scaleX
    : Math.min(scaleX, scaleY) * LEGACY_BATTLEFIELD_GRID.hexWidthToHeight;
  const hexHeight = uniform ? BATTLEFIELD_HEX_HEIGHT * scaleY : Math.min(scaleX, scaleY);
  const metrics = {
    size: uniform ? BATTLEFIELD_GRID.radius * scaleX : hexHeight / 2,
    originX: left + (origin.x - minimumX) * scaleX,
    originY: top + (origin.y - minimumY) * scaleY,
    qx: (qCenter.x - origin.x) * scaleX,
    qy: (qCenter.y - origin.y) * scaleY,
    rx: (rCenter.x - origin.x) * scaleX,
    ry: (rCenter.y - origin.y) * scaleY,
    scaleX,
    scaleY,
    hexWidth,
    hexHeight,
    gridWidth,
    gridHeight,
    left,
    top,
    right: left + gridWidth,
    bottom: top + gridHeight,
    frame,
    corners,
  };
  battlefieldLayoutCache = { key: modeCacheKey, metrics };
  return metrics;
}

function hexToScreen(position, z = 0, metrics = layoutMetrics()) {
  return {
    x: metrics.originX + position.q * metrics.qx + position.r * metrics.rx,
    y: metrics.originY + position.q * metrics.qy + position.r * metrics.ry - z * metrics.size,
  };
}

function roundAxial(q, r) {
  let x = Math.round(q);
  let z = Math.round(r);
  let y = Math.round(-q - r);
  const xDifference = Math.abs(x - q);
  const yDifference = Math.abs(y + q + r);
  const zDifference = Math.abs(z - r);
  if (xDifference > yDifference && xDifference > zDifference) x = -y - z;
  else if (yDifference > zDifference) y = -x - z;
  else z = -x - y;
  return axial(x, z);
}

function screenToHex(x, y) {
  const metrics = layoutMetrics();
  const dx = x - metrics.originX;
  const dy = y - metrics.originY;
  const determinant = metrics.qx * metrics.ry - metrics.rx * metrics.qy;
  const q = (dx * metrics.ry - metrics.rx * dy) / determinant;
  const r = (metrics.qx * dy - dx * metrics.qy) / determinant;
  const rounded = roundAxial(q, r);
  const candidates = [rounded, ...hexNeighbors(rounded)]
    .filter((candidate, index, source) => hexGrid.has(candidate)
      && source.findIndex((entry) => hexKey(entry) === hexKey(candidate)) === index)
    .filter((candidate) => pointInsideConvexPolygon({ x, y }, hexVertices(candidate, metrics)));
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const leftPoint = hexToScreen(left, 0, metrics);
    const rightPoint = hexToScreen(right, 0, metrics);
    return Math.hypot(x - leftPoint.x, y - leftPoint.y)
      - Math.hypot(x - rightPoint.x, y - rightPoint.y);
  });
  return candidates[0];
}

function clientToHex(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return screenToHex(
    (clientX - rect.left) * viewport.width / rect.width,
    (clientY - rect.top) * viewport.height / rect.height,
  );
}

function pointInsideConvexPolygon(point, vertices) {
  let windingSign = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const cross = (end.x - start.x) * (point.y - start.y)
      - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) <= 0.0001) continue;
    const edgeSign = Math.sign(cross);
    if (windingSign && edgeSign !== windingSign) return false;
    windingSign = edgeSign;
  }
  return true;
}

function resizeCanvas() {
  const box = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  viewport = { width: Math.max(1, box.width), height: Math.max(1, box.height), ratio };
  battlefieldLayoutCache = null;
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawScene();
}

function drawImageCover(image) {
  const scale = Math.max(viewport.width / image.naturalWidth, viewport.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (viewport.width - width) / 2, (viewport.height - height) / 2, width, height);
}

function drawCleanBattlefieldGround() {
  const metrics = layoutMetrics();
  const footprint = new Path2D();
  for (const tile of hexGrid.tiles()) {
    hexVertices(tile, metrics).forEach(({ x, y }, index) => {
      if (index === 0) footprint.moveTo(x, y);
      else footprint.lineTo(x, y);
    });
    footprint.closePath();
  }

  // Until the ground texture is decoded, opaque earth still keeps scenery
  // out of every playable field. This mask never changes the logical grid.
  context.save();
  context.fillStyle = "#4b4935";
  context.fill(footprint);
  context.restore();
  if (campaign?.act1.currentAreaId === 'act1.den_of_evil' && dungeonImage.complete && dungeonImage.naturalWidth) {
    // Reuse only the clear stone floor of the existing asset; all masonry stays outside legal tiles.
    context.save(); context.clip(footprint);
    context.drawImage(dungeonImage, dungeonImage.naturalWidth*.32, dungeonImage.naturalHeight*.30,
      dungeonImage.naturalWidth*.35, dungeonImage.naturalHeight*.26, 0,0,viewport.width,viewport.height);
    context.fillStyle='rgba(8,8,15,.14)';context.fillRect(0,0,viewport.width,viewport.height);
    context.restore(); return;
  }
  if (!cleanGroundImage.complete || !cleanGroundImage.naturalWidth) return;

  const cacheKey = [battlefieldGeometryMode, viewport.width, viewport.height, viewport.ratio,
    metrics.originX, metrics.originY, metrics.scaleX, metrics.scaleY].join(":");
  if (cleanGroundLayerCache?.key !== cacheKey) {
    const layer = document.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    const groundContext = layer.getContext("2d");
    const mask = document.createElement("canvas");
    mask.width = layer.width;
    mask.height = layer.height;
    const maskContext = mask.getContext("2d");
    maskContext.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    maskContext.fillStyle = "#fff";
    maskContext.strokeStyle = "#fff";
    maskContext.lineWidth = 18;
    maskContext.lineJoin = "round";
    maskContext.shadowColor = "#fff";
    maskContext.shadowBlur = 16 * viewport.ratio;
    maskContext.fill(footprint);
    maskContext.stroke(footprint);
    // The feather extends OUTSIDE the cells only. Their interiors are opaque.
    maskContext.shadowBlur = 0;
    maskContext.fill(footprint);

    const cover = Math.max(viewport.width / cleanGroundImage.naturalWidth,
      viewport.height / cleanGroundImage.naturalHeight);
    const width = cleanGroundImage.naturalWidth * cover;
    const height = cleanGroundImage.naturalHeight * cover;
    groundContext.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
    groundContext.drawImage(cleanGroundImage, (viewport.width - width) / 2,
      (viewport.height - height) / 2, width, height);
    groundContext.setTransform(1, 0, 0, 1, 0, 0);
    groundContext.globalCompositeOperation = "destination-in";
    groundContext.drawImage(mask, 0, 0);
    cleanGroundLayerCache = { key: cacheKey, layer };
  }
  context.drawImage(cleanGroundLayerCache.layer, 0, 0,
    viewport.width, viewport.height);
}

function hexVertices(position, metrics = layoutMetrics()) {
  const point = hexToScreen(position, 0, metrics);
  return metrics.corners.map((corner) => ({
    x: point.x + corner.x * metrics.scaleX,
    y: point.y + corner.y * metrics.scaleY,
  }));
}

function traceHex(position, metrics = layoutMetrics()) {
  const points = hexVertices(position, metrics);
  context.beginPath();
  points.forEach(({ x, y }, index) => {
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.closePath();
}

function drawHexOverlay({ diagnostic = GRID_DIAGNOSTIC } = {}) {
  const metrics = layoutMetrics();
  const tiles = hexGrid.tiles();
  const readyHeroId = battlePreparation.phase === BATTLE_PHASE.ACTIVE
    && actingUnitId && party.isActive(actingUnitId) && combat.canAct(actingUnitId)
    && characterOnBattlefield(actingUnitId) ? actingUnitId : null;
  const readyMovementKeys = readyHeroId && !pendingTarget && !activePanel && !isPaused()
    ? new Set(hexGrid.reachable(readyHeroId, 3)
      .filter(({ cost }) => cost > 0).map(({ position }) => hexKey(position)))
    : new Set();
  const previewPath = primaryHoverPlan?.path ?? (hoveredHex ? movementChoices.get(hexKey(hoveredHex))?.path ?? [] : []);
  const routeKeys = diagnostic
    ? new Set()
    : new Set(previewPath.map(hexKey));
  const enemyFootprint = diagnostic
    ? new Set()
    : new Set(battleMonsters().filter(unit => unit.hp > 0 && optionalGridPosition(hexGrid, unit.id))
      .flatMap(unit => hexGrid.occupiedHexes(unit.id).map(hexKey)));
  const hoverEnemy = livingMonsterAt(hoveredHex);
  const hoveredEnemyFootprint = diagnostic || !hoverEnemy
    ? new Set()
    : new Set(hexGrid.occupiedHexes(hoverEnemy.id).map(hexKey));

  const visualStyle = (tile) => {
    const key = hexKey(tile);
    const deployment = deploymentColumnOf(tile) < BATTLEFIELD_GRID.deploymentColumns;
    if (diagnostic) {
      return {
        fill: deployment ? "rgba(45,69,31,.72)" : "rgba(0,0,0,0)",
        stroke: deployment ? "#92c478" : "#a5a7a6",
        lineWidth: Math.max(1.35, metrics.hexHeight * 0.018),
      };
    }
    let lineWidth = 1.15;
    let stroke = null;
    let fill = deployment ? "rgba(76,117,48,.23)" : "rgba(8,7,6,.02)";
    if (readyMovementKeys.has(key)) {
      fill = "rgba(67,115,133,.16)";
      stroke = "rgba(114,162,176,.53)";
    }
    if (pendingTarget === "move" && movementChoices.has(key)) {
      fill = routeKeys.has(key) ? "rgba(185,151,78,.26)" : "rgba(67,115,133,.20)";
      stroke = routeKeys.has(key) ? "rgba(223,188,111,.82)" : "rgba(114,162,176,.70)";
    }
    if (pendingTarget === "portal" && portalChoices.has(key)) {
      fill = "rgba(101,66,132,.27)";
      stroke = "rgba(169,132,204,.80)";
    }
    if ((pendingTarget === "skill" && enemyFootprint.has(key)) || hoveredEnemyFootprint.has(key)) {
      fill = "rgba(133,47,33,.29)";
      stroke = "rgba(209,105,76,.84)";
    }
    if (hoveredHex && key === hexKey(hoveredHex)) {
      lineWidth = 1.75;
      stroke = "rgba(232,201,139,.92)";
    }
    return { fill, stroke, lineWidth, deployment };
  };

  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";
  if (diagnostic) {
    // Keep the high-contrast diagnostic view independent of terrain styling.
    for (const tile of tiles) {
      const style = visualStyle(tile);
      traceHex(tile, metrics);
      context.fillStyle = style.fill;
      context.fill();
    }
    for (const tile of tiles) {
      const style = visualStyle(tile);
      traceHex(tile, metrics);
      context.lineWidth = style.lineWidth;
      context.strokeStyle = style.stroke;
      context.stroke();
    }
  } else {
    const styledTiles = tiles.map((tile) => ({ tile, style: visualStyle(tile) }));
    const edges = new Map();
    for (const { tile, style } of styledTiles) {
      traceHex(tile, metrics);
      if (style.deployment) {
        // Tint the existing ground texture like moss, without a flat green wash.
        context.globalCompositeOperation = "soft-light";
        context.fillStyle = "rgba(115,152,78,.56)";
        context.fill();
      }
      context.globalCompositeOperation = "source-over";
      context.fillStyle = style.fill;
      context.fill();

      const points = hexVertices(tile, metrics);
      points.forEach((start, index) => {
        const end = points[(index + 1) % points.length];
        const startKey = `${start.x.toFixed(3)},${start.y.toFixed(3)}`;
        const endKey = `${end.x.toFixed(3)},${end.y.toFixed(3)}`;
        const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
        const shared = edges.get(key);
        if (shared) shared.deployment ||= style.deployment;
        else edges.set(key, { start, end, deployment: style.deployment });
      });
    }

    // Shared borders are painted once: neighbouring hexes must not accumulate
    // opacity and turn a shallow ground seam into a bright wire outline.
    const seams = new Path2D();
    const terrainLips = new Path2D();
    const mossLips = new Path2D();
    for (const { start, end, deployment } of edges.values()) {
      seams.moveTo(start.x, start.y);
      seams.lineTo(end.x, end.y);
      const lip = deployment ? mossLips : terrainLips;
      lip.moveTo(start.x, start.y);
      lip.lineTo(end.x, end.y);
    }

    // A soft contact shade and a subpixel lower-right lip read as an inset
    // groove lit from the upper left. All passes retain the original vertices.
    context.globalCompositeOperation = "multiply";
    context.lineWidth = 3.0;
    context.strokeStyle = "rgba(28,29,20,.30)";
    context.stroke(seams);
    context.save();
    context.translate(-0.20, -0.30);
    context.lineWidth = 1.20;
    context.strokeStyle = "rgba(12,17,12,.54)";
    context.stroke(seams);
    context.restore();

    context.save();
    context.translate(0.40, 0.65);
    context.globalCompositeOperation = "soft-light";
    context.lineWidth = 1.60;
    context.strokeStyle = "rgba(232,213,174,.30)";
    context.stroke(seams);
    // Use the same normal-blend relief on every row. Its contrast must remain
    // readable even where the ground is darker, including the entire top edge.
    context.globalCompositeOperation = "source-over";
    context.lineWidth = 1.25;
    context.strokeStyle = "rgba(198,181,145,.68)";
    context.stroke(terrainLips);
    context.strokeStyle = "rgba(165,192,125,.74)";
    context.stroke(mossLips);
    context.restore();

    context.globalCompositeOperation = "source-over";
    for (const { tile, style } of styledTiles) {
      if (!style.stroke) continue;
      traceHex(tile, metrics);
      context.lineWidth = style.lineWidth;
      context.strokeStyle = style.stroke;
      context.stroke();
    }
  }
  context.restore();

  if (routeKeys.size > 1) {
    const path = primaryHoverPlan?.path ?? movementChoices.get(hexKey(hoveredHex))?.path ?? [];
    context.beginPath();
    path.forEach((hex, index) => {
      const point = hexToScreen(hex);
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.strokeStyle = "#edc772";
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.stroke();
    context.setLineDash([]);
  }
}

function drawAmbient() {
  context.save();
  // Atmosphere belongs to the scenery outside the battlefield. Exclude every
  // complete tile so neither the upper row nor any other field is veiled.
  const exterior = new Path2D();
  exterior.rect(0, 0, viewport.width, viewport.height);
  const metrics = layoutMetrics();
  for (const tile of hexGrid.tiles()) {
    const points = hexVertices(tile, metrics);
    points.forEach(({ x, y }, index) => {
      if (index === 0) exterior.moveTo(x, y);
      else exterior.lineTo(x, y);
    });
    exterior.closePath();
  }
  context.clip(exterior, "evenodd");
  const shade = context.createLinearGradient(0, 0, 0, viewport.height);
  shade.addColorStop(0, "rgba(3,6,9,.14)");
  shade.addColorStop(0.55, "rgba(6,8,7,.02)");
  shade.addColorStop(1, "rgba(1,1,1,.26)");
  context.fillStyle = shade;
  context.fillRect(0, 0, viewport.width, viewport.height);
  for (let index = 0; index < 24; index += 1) {
    const x = ((index * 127 + 43) % 997) / 997 * viewport.width;
    const y = (0.1 + ((index * 71 + 19) % 829) / 829 * 0.72) * viewport.height;
    context.globalAlpha = 0.07 + (index % 4) * 0.02;
    context.fillStyle = index % 3 ? "#bfc4b7" : "#d08b47";
    context.beginPath();
    context.arc(x, y, 0.5 + (index % 3) * 0.3, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawSelectionRing(point, color, { acting = false, inspected = false, hostile = false, hostileRadius = 42, mutedHostile = false } = {}) {
  context.save();
  context.translate(point.x, point.y + 4);
  context.scale(1, 0.44);
  context.lineWidth = acting ? 4 : 2;
  context.strokeStyle = acting ? "#e2bb65" : mutedHostile ? "#806457" : color;
  context.shadowColor = acting ? "#d79b3f" : mutedHostile ? "#55433a" : color;
  context.shadowBlur = acting ? 17 : mutedHostile ? 3 : 8;
  context.globalAlpha = acting ? 1 : mutedHostile ? 0.52 : 0.72;
  context.beginPath();
  context.arc(0, 0, hostile ? hostileRadius : acting ? 35 : 29, 0, Math.PI * 2);
  context.stroke();
  if (inspected && !acting) {
    context.setLineDash([4, 4]);
    context.strokeStyle = "#91c4dc";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, 35, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function drawFallbackHero(character, point, height) {
  const color = classAccents[character.classId];
  const factor = height / 120;
  context.save();
  context.translate(point.x, point.y);
  context.scale(factor, factor);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "#000";
  context.shadowBlur = 5;
  if (character.classId === "barbarian") {
    // Project-original canvas silhouette: readable at tactical scale without
    // covering the occupied hex or depending on an external character asset.
    context.strokeStyle = "#17110d";
    context.lineWidth = 9;
    context.beginPath();
    context.moveTo(22, -52);
    context.lineTo(43, -108);
    context.stroke();
    context.strokeStyle = "#8d6c42";
    context.lineWidth = 5;
    context.stroke();
    context.fillStyle = "#4b5358";
    context.strokeStyle = "#151719";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(31, -113);
    context.lineTo(47, -124);
    context.lineTo(58, -116);
    context.lineTo(48, -102);
    context.lineTo(35, -103);
    context.closePath();
    context.fill();
    context.stroke();

    context.strokeStyle = "#17110d";
    context.lineWidth = 12;
    context.beginPath();
    context.moveTo(-12, -41);
    context.lineTo(-18, -5);
    context.moveTo(12, -41);
    context.lineTo(18, -5);
    context.stroke();
    context.strokeStyle = "#6c3927";
    context.lineWidth = 7;
    context.stroke();

    context.fillStyle = "#251713";
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(-31, -83);
    context.quadraticCurveTo(0, -100, 31, -83);
    context.lineTo(23, -39);
    context.lineTo(-23, -39);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = "#7b3c29";
    context.fillRect(-25, -48, 50, 8);
    context.fillStyle = "#b39a74";
    context.fillRect(-5, -49, 10, 10);

    context.strokeStyle = "#1b120f";
    context.lineWidth = 14;
    context.beginPath();
    context.moveTo(-25, -75);
    context.lineTo(-38, -44);
    context.moveTo(25, -75);
    context.lineTo(34, -52);
    context.stroke();
    context.strokeStyle = "#95664e";
    context.lineWidth = 9;
    context.stroke();

    context.fillStyle = "#9b7058";
    context.strokeStyle = "#211713";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, -95, 14, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#2a1a14";
    context.beginPath();
    context.arc(0, -100, 13, Math.PI, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(-8, -87);
    context.lineTo(0, -78);
    context.lineTo(8, -87);
    context.closePath();
    context.fill();
    context.restore();
    return;
  }
  context.strokeStyle = "#171311";
  context.lineWidth = 9;
  context.beginPath();
  context.moveTo(-7, -35);
  context.lineTo(-12, -4);
  context.moveTo(7, -35);
  context.lineTo(12, -4);
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 5;
  context.stroke();
  context.fillStyle = "#1a1715";
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(-18, -78);
  context.lineTo(15, -78);
  context.lineTo(20, -34);
  context.lineTo(-18, -34);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = "#8b7563";
  context.beginPath();
  context.arc(0, -89, 10, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawNameplate(text, point, color, flags = {}) {
  context.save();
  const fontSize = flags.compact ? 10 : 11;
  context.font = `${flags.acting ? "600 " : ""}${fontSize}px Georgia`;
  context.textAlign = "center";
  const suffix = flags.dead ? " · ZWŁOKI" : flags.acting ? " · TURA" : flags.inspected ? " · PODGLĄD" : "";
  const label = `${text}${suffix}`;
  const width = Math.max(flags.compact ? 50 : 58, context.measureText(label).width + (flags.compact ? 15 : 18));
  const y = point.y + (flags.compact ? 19 : 21);
  const gradient = context.createLinearGradient(point.x - width / 2, 0, point.x + width / 2, 0);
  gradient.addColorStop(0, "rgba(4,3,2,0)");
  gradient.addColorStop(0.16, "rgba(4,3,2,.88)");
  gradient.addColorStop(0.84, "rgba(4,3,2,.88)");
  gradient.addColorStop(1, "rgba(4,3,2,0)");
  context.fillStyle = gradient;
  context.fillRect(point.x - width / 2, y - 12, width, 17);
  context.fillStyle = flags.acting ? "#f0d59a" : flags.inspected ? "#b9dfef" : "#c4b9a8";
  context.shadowColor = "#000";
  context.shadowBlur = 3;
  context.fillText(label, point.x, y);
  context.strokeStyle = color;
  context.globalAlpha = 0.55;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(point.x - width * 0.28, y + 5);
  context.lineTo(point.x + width * 0.28, y + 5);
  context.stroke();
  context.restore();
}

function characterOnBattlefield(characterId) {
  return portalSystem.locationOf(characterId)?.kind === "area" && (() => {
    try {
      hexGrid.positionOf(characterId);
      return true;
    } catch {
      return false;
    }
  })();
}

function characterLocationLabel(characterId) {
  if (campaign && !campaignBattleAvailable()) return act1Area(campaign.act1.currentAreaId).label;
  const location = portalSystem.locationOf(characterId);
  if (location?.kind === "town") return `Miasto · ${location.town_id}`;
  if (location?.kind === "reserve") return "Rezerwa";
  if (!characterOnBattlefield(characterId)) return "Poza polem";
  return `Heks ${hexKey(hexGrid.positionOf(characterId))}`;
}

// Keep the upper silhouette fully opaque while revealing the occupied hex
// through the feet. Clipped bands avoid changing the source artwork and keep
// selection/hit-testing entirely independent from this presentation effect.
function drawWithFootFade(drawVisual, {
  left,
  top,
  width,
  height,
  fadeStart = 0.72,
  endAlpha = 0.6,
  bands = 12,
}) {
  const safeHeight = Math.max(1, height);
  const fadeTop = top + safeHeight * fadeStart;
  const padding = 18;
  const drawBand = (bandTop, bandBottom, alpha) => {
    context.save();
    context.beginPath();
    context.rect(
      left - padding,
      bandTop,
      width + padding * 2,
      Math.max(1, bandBottom - bandTop + 0.6),
    );
    context.clip();
    context.globalAlpha *= alpha;
    drawVisual();
    context.restore();
  };

  drawBand(top - padding, fadeTop + 0.6, 1);
  for (let index = 0; index < bands; index += 1) {
    const y0 = fadeTop + safeHeight * (1 - fadeStart) * index / bands;
    const y1 = fadeTop + safeHeight * (1 - fadeStart) * (index + 1) / bands;
    const progress = (index + 0.5) / bands;
    drawBand(y0, y1, 1 - (1 - endAlpha) * progress);
  }
}

function drawHero(characterId) {
  if (!characterOnBattlefield(characterId)) return;
  const character = roster.get(characterId);
  const point = presentedPoint(characterId);
  const acting = characterId === actingUnitId;
  const inspected = characterId === inspectedCharacterId;
  const color = classAccents[character.classId];
  if (character.resources.hp <= 0 || character.lifeState !== "alive") {
    context.save();
    context.translate(point.x, point.y + 2);
    context.rotate(-0.28);
    context.fillStyle = "rgba(9,7,6,.86)";
    context.strokeStyle = "rgba(115,91,65,.72)";
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(0, 0, 34, 10, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "rgba(83,70,57,.82)";
    context.fillRect(-22, -4, 34, 8);
    context.beginPath();
    context.arc(19, 0, 7, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }
  context.save();
  context.fillStyle = "rgba(0,0,0,.22)";
  context.beginPath();
  context.ellipse(point.x, point.y + 5, 34, 11, 0, 0, Math.PI * 2);
  context.fill();
  drawSelectionRing(point, color, { acting, inspected });
  const spriteKey = spriteKeyForCharacter(character);
  const sprite = spriteAssets[spriteKey];
  const height = clamp(viewport.height * (acting ? 0.275 : 0.245), 104, acting ? 176 : 160);
  if ((barbarianWalkAnimationAvailable(characterId)
      && drawBarbarianFrame(context, barbarianAtlases, battleAnimation, characterId, point, height, character))
    || (paladinAnimationAvailable(characterId)
      && drawPaladinFrame(context, paladinAtlases, battleAnimation, characterId, point, height, character))
    || (sorceressAnimationAvailable(characterId)
      && drawSorceressFrame(context, sorceressAtlases, battleAnimation, characterId, point, height, character))
    || (genericHeroAnimationAvailable(characterId)
      && drawHeroAnimationFrame(context, heroAnimationAtlases, heroAnimationItems,
        battleAnimation, characterId, point, height, character, equipmentCatalog))) {
    // Atlas poses keep feet readable; do not fade or warp the animated legs.
  } else if (sprite?.complete && sprite.naturalWidth > 0 && spriteUsable.get(spriteKey)) {
    const width = height * sprite.naturalWidth / sprite.naturalHeight;
    const left = point.x - width / 2;
    const top = point.y - height + 8;
    context.shadowColor = "#000";
    context.shadowBlur = 10;
    drawWithFootFade(
      () => context.drawImage(sprite, left, top, width, height),
      { left, top, width, height, fadeStart: 0.72, endAlpha: 0.6 },
    );
  } else {
    const fallbackHeight = height * 0.72;
    drawWithFootFade(
      () => drawFallbackHero(character, point, fallbackHeight),
      {
        left: point.x - fallbackHeight * 0.56,
        top: point.y - fallbackHeight * 1.08,
        width: fallbackHeight * 1.12,
        height: fallbackHeight * 1.12,
        fadeStart: 0.7,
        endAlpha: 0.6,
      },
    );
  }
  context.restore();
}

function drawFallbackMonster(point, height, { fallen = false, zombie = false } = {}) {
  const factor = height / 155;
  context.save();
  context.translate(point.x, point.y);
  context.scale(factor, factor);
  if (zombie) {
    context.fillStyle = "#605d54";
    context.strokeStyle = "#898174";
    context.lineWidth = 12;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(-17, -60);
    context.lineTo(-34, -9);
    context.moveTo(14, -59);
    context.lineTo(24, -10);
    context.moveTo(-17, -104);
    context.lineTo(-36, -57);
    context.moveTo(17, -101);
    context.lineTo(35, -55);
    context.stroke();
    context.beginPath();
    context.ellipse(0, -91, 25, 42, -0.12, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.ellipse(1, -143, 16, 19, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }
  context.fillStyle = fallen ? "#342720" : "#3d0b08";
  context.strokeStyle = fallen ? "#70564a" : "#a43a26";
  context.lineWidth = 3;
  context.shadowColor = fallen ? "#4b3931" : "#c32e1f";
  context.shadowBlur = fallen ? 4 : 13;
  context.beginPath();
  context.moveTo(-30, -105);
  context.quadraticCurveTo(-62, -88, -58, -54);
  context.lineTo(-25, -69);
  context.lineTo(0, -119);
  context.lineTo(30, -69);
  context.lineTo(58, -54);
  context.quadraticCurveTo(62, -88, 30, -105);
  context.lineTo(18, -60);
  context.lineTo(23, -15);
  context.lineTo(0, -4);
  context.lineTo(-23, -15);
  context.lineTo(-18, -60);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

function drawMonster(enemyId = enemy.id) {
  const monster = combat.units.get(enemyId);
  if (!monster || monster.kind !== "monster" || monster.hp <= 0 || !optionalGridPosition(hexGrid, enemyId)) return;
  const fallen = monster.sourceMonsterCode === "fallen1" || monster.name?.toLocaleLowerCase("pl-PL") === "upadły";
  const zombie = monster.sourceMonsterCode === "zombie1" || monster.name?.toLocaleLowerCase("pl-PL") === "zombie";
  const scaleAdjustment = fallen ? 1.1 : zombie ? 0.7 : 1;
  const point = hexToScreen(hexGrid.positionOf(enemyId));
  if (battleImpactVisual?.targetId === enemyId) {
    const progress = battleAnimation.current?.progress ?? 0;
    point.x += battleImpactVisual.direction * Math.sin(progress * Math.PI) * 5;
  }
  for (const occupied of hexGrid.occupiedHexes(enemyId)) {
    traceHex(occupied);
    context.fillStyle = fallen ? "rgba(73,50,39,.10)" : zombie ? "rgba(75,73,65,.10)" : "rgba(99,18,12,.12)";
    context.fill();
  }
  context.save();
  context.fillStyle = "rgba(0,0,0,.28)";
  context.beginPath();
  context.ellipse(point.x, point.y + 8,
    (fallen ? 28 : zombie ? 38 : 54) * scaleAdjustment,
    (fallen ? 9 : zombie ? 12 : 17) * scaleAdjustment, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
  drawSelectionRing(point, zombie ? "#897e70" : "#c73c29", { hostile: true, hostileRadius: (fallen ? 27 : zombie ? 34 : 42) * scaleAdjustment, mutedHostile: fallen || zombie });
  const spriteKey = fallen ? "fallen" : zombie ? "zombie" : "enemy";
  const sprite = spriteAssets[spriteKey];
  const height = clamp(viewport.height * 0.38, 145, 245) * (fallen ? 0.5 : zombie ? 0.74 : 1) * scaleAdjustment;
  context.save();
  if (sprite?.complete && sprite.naturalWidth > 0 && spriteUsable.get(spriteKey)) {
    const width = height * sprite.naturalWidth / sprite.naturalHeight;
    const left = point.x - width / 2;
    const top = point.y - height + 12;
    const hovered = livingMonsterAt(hoveredHex)?.id === enemyId;
    context.shadowColor = hovered ? "#ffce70" : "#000";
    context.shadowBlur = hovered ? 7 : 15;
    drawWithFootFade(
      () => context.drawImage(sprite, left, top, width, height),
      { left, top, width, height, fadeStart: 0.72, endAlpha: 0.58 },
    );
  } else {
    const fallbackHeight = height * 0.78;
    drawWithFootFade(
      () => drawFallbackMonster(point, fallbackHeight, { fallen, zombie }),
      {
        left: point.x - fallbackHeight * 0.44,
        top: point.y - fallbackHeight * 0.82,
        width: fallbackHeight * 0.88,
        height: fallbackHeight * 0.86,
        fadeStart: 0.69,
        endAlpha: 0.58,
      },
    );
  }
  context.restore();
}

function drawSummon(summonId) {
  const summon = battlePreparation.listSummons().find(({ id }) => id === summonId);
  const position = optionalGridPosition(hexGrid, summonId);
  if (!summon || !position) return;
  const point = hexToScreen(position);
  const size = layoutMetrics().size;
  context.save();
  context.fillStyle = "rgba(0,0,0,.66)";
  context.beginPath();
  context.ellipse(point.x, point.y + 6, size * .4, size * .14, 0, 0, Math.PI * 2);
  context.fill();
  context.translate(point.x, point.y - size * .22);
  context.shadowColor = "#6fa883";
  context.shadowBlur = 10;
  context.fillStyle = summon.kind === "clay_golem" ? "#756650" : "#d0c8ad";
  context.strokeStyle = "#91b89a";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, -size * .22, size * .16, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillRect(-size * .14, -size * .06, size * .28, size * .34);
  context.strokeRect(-size * .14, -size * .06, size * .28, size * .34);
  context.restore();
  drawSelectionRing(point, "#6fa883");
}

function drawPortal(portal) {
  if (!portal.active || portal.source.instance_id !== INSTANCE_ID) return;
  const point = hexToScreen(portal.source.hex);
  const radius = layoutMetrics().size * 0.58;
  context.save();
  context.translate(point.x, point.y - radius * 0.35);
  context.globalCompositeOperation = "screen";
  for (let ring = 0; ring < 3; ring += 1) {
    context.strokeStyle = ring === 0 ? "#8d5ac4" : "#4d8fc2";
    context.globalAlpha = 0.68 - ring * 0.14;
    context.lineWidth = 3 - ring * 0.6;
    context.shadowColor = "#8c55c7";
    context.shadowBlur = 18;
    context.beginPath();
    context.ellipse(0, 0, radius - ring * 5, radius * 0.92 - ring * 4, -0.14, 0, Math.PI * 2);
    context.stroke();
  }
  context.fillStyle = "rgba(77,45,128,.2)";
  context.beginPath();
  context.ellipse(0, 0, radius * 0.75, radius * 0.72, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawLoot(drop, count = 1) {
  const point = hexToScreen(drop.hex);
  const definition = equipmentCatalog.get(drop.item.canonicalId);
  context.save();
  context.translate(point.x, point.y - 5);
  context.shadowColor = "#d0a24d";
  context.shadowBlur = 10;
  context.fillStyle = "rgba(20,15,7,.85)";
  context.strokeStyle = "#bb9858";
  context.lineWidth = 1.5;
  context.fillRect(-15,-19,30,32);
  context.strokeRect(-15,-19,30,32);
  context.fillStyle = "#edcf92";
  context.font = "22px Georgia";
  context.textAlign = "center";
  context.fillText(equipmentGlyphs[definition.slot] ?? "◆",0,5);
  if (count > 1) {
    context.font = "bold 11px Arial";
    context.fillText(`×${count}`,0,26);
  }
  context.restore();
}

function drawProjectiles() {
  for (const projectile of combat.projectiles()) {
    const point = hexToScreen(projectile.position);
    const previous = projectile.path[Math.max(0, projectile.pathIndex - 1)];
    const previousPoint = hexToScreen(previous);
    context.save();
    context.strokeStyle = "rgba(247,190,91,.62)";
    context.lineWidth = 3;
    context.shadowColor = "#ff8d35";
    context.shadowBlur = 15;
    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y - 20);
    context.lineTo(point.x, point.y - 20);
    context.stroke();
    context.fillStyle = "#fff0af";
    context.beginPath();
    context.arc(point.x, point.y - 20, 5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

// The terrain seam is drawn beneath sprites, but the occupied cell must stay
// identifiable even when a wide silhouette covers one or more of its edges.
// Reuse the same vertices as the click test; this adds no independent grid.
function drawOccupiedHexContours(entities) {
  if (!entities.length) return;
  const metrics = layoutMetrics();
  const edges = new Map();
  for (const { id } of entities) {
    for (const tile of hexGrid.occupiedHexes(id)) {
      const points = hexVertices(tile, metrics);
      points.forEach((start, index) => {
        const end = points[(index + 1) % points.length];
        const startKey = `${start.x.toFixed(3)},${start.y.toFixed(3)}`;
        const endKey = `${end.x.toFixed(3)},${end.y.toFixed(3)}`;
        const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
        if (!edges.has(key)) edges.set(key, { start, end });
      });
    }
  }
  const contours = new Path2D();
  for (const { start, end } of edges.values()) {
    contours.moveTo(start.x, start.y);
    contours.lineTo(end.x, end.y);
  }
  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";
  context.lineWidth = Math.max(1.7, metrics.size * 0.045);
  context.strokeStyle = "rgba(12, 13, 10, .57)";
  context.stroke(contours);
  context.lineWidth = Math.max(0.9, metrics.size * 0.022);
  context.strokeStyle = "rgba(213, 195, 148, .62)";
  context.stroke(contours);
  context.restore();
}

function drawScene() {
  if (!context) return;
  context.setTransform(viewport.ratio, 0, 0, viewport.ratio, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.save();
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.lineWidth = 1;
  context.shadowBlur = 0;
  if (GRID_DIAGNOSTIC) {
    context.fillStyle = "#191918";
    context.fillRect(0, 0, viewport.width, viewport.height);
    const frame = battlefieldFrame();
    context.fillStyle = "rgba(0, 0, 0, .08)";
    context.fillRect(frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top);
    context.strokeStyle = "rgba(210, 205, 190, .28)";
    context.lineWidth = 1;
    context.strokeRect(
      frame.left + 0.5,
      frame.top + 0.5,
      frame.right - frame.left - 1,
      frame.bottom - frame.top - 1,
    );
    drawHexOverlay({ diagnostic: true });
    context.restore();
    return;
  }
  const scenery=campaign?.act1.currentAreaId==='act1.den_of_evil' ? dungeonImage : backgroundImage;
  if (scenery.complete && scenery.naturalWidth > 0) drawImageCover(scenery);
  if (!campaignBattleAvailable()) {
    const area=act1Area(campaign.act1.currentAreaId);
    context.fillStyle='rgba(8,10,9,.40)';context.fillRect(0,0,viewport.width,viewport.height);
    context.textAlign='center';context.fillStyle='#e0cfa4';context.font='24px Georgia';
    context.fillText(area.label,viewport.width*.56,viewport.height*.39);
    context.font='14px Georgia';context.fillText(area.profile==='camp'?'Bezpieczny obóz · Akara w dzienniku zadań · podróż przez mapę':'Otwórz mapę i przemieszczaj drużynę między sektorami.',viewport.width*.56,viewport.height*.45);
    context.restore();
    return;
  }
  drawCleanBattlefieldGround();
  drawAmbient();
  drawHexOverlay();
  for (const portal of portalSystem.listActivePortals()) drawPortal(portal);
  const entities = party.slots
    .filter(characterOnBattlefield)
    .map((id) => ({ id, depth: presentedPoint(id).y, type: "hero" }));
  for (const summon of battlePreparation.listSummons()) {
    const position = optionalGridPosition(hexGrid, summon.id);
    if (position) entities.push({ id: summon.id, depth: hexToScreen(position).y, type: "summon" });
  }
  for (const monster of battleMonsters()) {
    const position = monster.hp > 0 ? optionalGridPosition(hexGrid, monster.id) : null;
    if (position) entities.push({ id: monster.id, depth: hexToScreen(position).y, type: "enemy" });
  }
  entities.sort((a, b) => a.depth - b.depth);
  const hoverEnemy = livingMonsterAt(hoveredHex);
  const hoverPoint = hoverEnemy ? hexToScreen(hexGrid.positionOf(hoverEnemy.id)) : null;
  entities.forEach((entry) => {
    context.save();
    const point = hexToScreen(hexGrid.positionOf(entry.id));
    // Selection stays hex-based; only foreground silhouettes are faded.
    if (!battleAnimationBusy && hoverPoint && entry.id !== hoverEnemy.id && point.y > hoverPoint.y
      && point.y - hoverPoint.y < 210 && Math.abs(point.x - hoverPoint.x) < 90) context.globalAlpha = .5;
    entry.type === "hero" ? drawHero(entry.id) : entry.type === "summon" ? drawSummon(entry.id) : drawMonster(entry.id);
    context.restore();
  });
  drawOccupiedHexContours(entities);
  drawProjectiles();
  entities.forEach((entry) => {
    if (entry.type === "hero") {
      const character = roster.get(entry.id);
      drawNameplate(character.name, presentedPoint(entry.id), classAccents[character.classId], {
        acting: entry.id === actingUnitId,
        inspected: entry.id === inspectedCharacterId,
        dead: character.resources.hp <= 0 || character.lifeState !== "alive",
      });
    } else if (entry.type === "summon") {
      const summon = battlePreparation.listSummons().find(({ id }) => id === entry.id);
      drawNameplate(summon?.kind?.replaceAll("_", " ") ?? "Summon", hexToScreen(hexGrid.positionOf(entry.id)), "#6fa883");
    } else {
      const monster = combat.units.get(entry.id);
      const fallen = monster?.name?.toLocaleLowerCase("pl-PL") === "upadły";
      const hovered = hoverEnemy?.id === entry.id;
      drawNameplate(hovered ? `${monster.name} · ${monster.hp}/${monster.maxHp ?? monster.hp} HP` : monster?.name ?? entry.id,
        hexToScreen(hexGrid.positionOf(entry.id)), hovered ? "#ffe2a0" : fallen ? "#806457" : "#b53a27", { compact: !hovered && fallen });
    }
  });
  const groundByHex = new Map();
  for (const drop of visibleGroundDrops()) {
    const key = hexKey(drop.hex);
    const group = groundByHex.get(key);
    if (group) group.count += 1;
    else groundByHex.set(key, { drop, count: 1 });
  }
  for (const { drop, count } of groundByHex.values()) drawLoot(drop, count);
  context.restore();
  scheduleBarbarianIdle();
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message, kind = "info") {
  const toast = document.querySelector("#game-toast");
  toast.textContent = act1DisplayText(message);
  toast.dataset.kind = kind;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

function buildHeroButton(character) {
  const button = make("button", "hero");
  button.type = "button";
  button.dataset.characterId = character.id;
  const portrait = make("span", "hero-portrait-frame");
  const image = document.createElement("img");
  image.alt = "";
  const fallback = make("span", "portrait-fallback", character.name[0]);
  portrait.append(image, fallback);
  const info = make("span", "hero-info");
  const title = make("span", "hero-title");
  title.append(make("b", "hero-name"), make("em", "hero-level"));
  const classLabel = make("span", "hero-class");
  const hp = make("span", "resource-line hp-line");
  hp.append(make("span", "", "HP"), make("span", "resource-track hp"), make("strong", "resource-value"));
  hp.querySelector(".resource-track").append(make("i"));
  const mana = make("span", "resource-line mana-line");
  mana.append(make("span", "", "MP"), make("span", "resource-track mana"), make("strong", "resource-value"));
  mana.querySelector(".resource-track").append(make("i"));
  const statuses = make("span", "hero-statuses");
  statuses.append(make("span", "turn-badge", "TURA"), make("span", "inspect-badge", "PODGLĄD"), make("span", "location-badge"));
  const buildStatus = make("span", "hero-build");
  info.append(title, classLabel, hp, mana, buildStatus, statuses);
  button.append(portrait, info);
  button.addEventListener("click", () => {
    // A target set belongs to the actor that created it. Cancelling first keeps
    // a preparation move or skill from being applied through another portrait.
    clearTargeting(false);
    closeMouseSkillChooser();
    inspectedCharacterId = button.dataset.characterId;
    if (battlePreparation.phase === BATTLE_PHASE.ACTIVE && !battleAnimationBusy
      && combat.currentActorId && combat.units.get(combat.currentActorId)?.kind === 'hero') {
      try {
        combat.chooseHeroForPlayerTurn(inspectedCharacterId, timelineLegalIds());
        actingUnitId = inspectedCharacterId;
      } catch (error) { showToast(error.message, 'warning'); }
    }
    if (battlePreparation.phase === BATTLE_PHASE.PREPARATION
      && roster.get(inspectedCharacterId).lifeState === 'alive'
      && roster.get(inspectedCharacterId).resources.hp > 0
      && characterOnBattlefield(inspectedCharacterId)) actingUnitId = inspectedCharacterId;
    render();
    if (activePanel) renderPanel(activePanel);
  });
  return button;
}

function updateHeroButton(button, character) {
  const accent = classAccents[character.classId];
  button.style.setProperty("--hero-accent", accent);
  button.classList.toggle("acting", character.id === actingUnitId);
  button.classList.toggle("inspected", character.id === inspectedCharacterId);
  button.classList.toggle("in-town", portalSystem.locationOf(character.id)?.kind === "town");
  button.setAttribute("aria-pressed", String(character.id === inspectedCharacterId));
  button.querySelector(".hero-name").textContent = character.name;
  button.querySelector(".hero-level").textContent = `POZ. ${character.level}`;
  button.querySelector(".hero-class").textContent = classNames[character.classId];
  button.dataset.heroClass = character.classId;
  const image = button.querySelector("img");
  const spriteKey = spriteKeyForCharacter(character);
  const source = canonicalHeroPortraitPath(character.classId);
  if (source && image.getAttribute("src") !== source) image.src = source;
  else if (!source) image.removeAttribute("src");
  image.hidden = !spriteUsable.get(spriteKey);
  image.onload = () => { image.hidden = !hasTransparentCorners(image); };
  image.onerror = () => { image.hidden = true; };
  button.querySelector(".portrait-fallback").textContent = character.name[0];
  const hpPercent = 100 * character.resources.hp / character.resources.maxHp;
  button.querySelector(".hp-line i").style.width = `${hpPercent}%`;
  button.querySelector(".hp-line .resource-value").textContent = `${character.resources.hp}/${character.resources.maxHp}`;
  const manaPercent = 100 * character.resources.mana / character.resources.maxMana;
  button.querySelector(".mana-line i").style.width = `${manaPercent}%`;
  button.querySelector(".mana-line .resource-value").textContent = `${formatMana(character.resources.mana)}/${formatMana(character.resources.maxMana)}`;
  const locationBadge = button.querySelector(".location-badge");
  locationBadge.textContent = portalSystem.locationOf(character.id)?.kind === "town" ? "MIASTO" : "";
  const buildStatus = button.querySelector(".hero-build");
  if (character.classId === "barbarian") {
    const warCries = battlePreparation.listBuffs().filter((buff) => buff.sourceId === character.id);
    buildStatus.textContent = warCries.length ? `OKRZYK · ${Math.max(...warCries.map((buff) => buff.remainingTurns ?? 0))} tur` : "OKRZYKI · gotowe";
    buildStatus.dataset.warcryStatus = warCries.length ? "active" : "ready";
  } else if (character.classId === "paladin") {
    const aura = battlePreparation.listBuffs().find((buff) => buff.sourceId === character.id && skillDefinitions[buff.skillId]?.category === SKILL_CATEGORY.AURA);
    buildStatus.textContent = aura ? `AURA · ${skillDefinitions[aura.skillId]?.name ?? aura.skillId}` : "AURA · niewybrana";
    buildStatus.dataset.auraStatus = aura ? "active" : "inactive";
  } else if (character.classId === "necromancer") {
    const summonCount = battlePreparation.listSummons().filter((summon) => summon.ownerId === character.id).length;
    buildStatus.textContent = `SUMMONY · ${summonCount} / ${necroskeletonStats({ skillLevel: runtimeSkillLevel(character, RAISE_SKELETON_SKILL_ID) }).maxCount}`;
    buildStatus.dataset.summonCount = String(summonCount);
  }
}

function renderParty() {
  const activeCharacters = party.activeCharacters();
  const activeIds = new Set(activeCharacters.map(({ id }) => id));
  for (const existing of partyRoot.querySelectorAll(".hero")) {
    if (!activeIds.has(existing.dataset.characterId)) existing.remove();
  }
  const ordered = [];
  for (const character of activeCharacters) {
    let button = partyRoot.querySelector(`[data-character-id="${character.id}"]`);
    if (!button) button = buildHeroButton(character);
    updateHeroButton(button, character);
    ordered.push(button);
  }
  partyRoot.replaceChildren(...ordered);
  const reserve = roster.toJSON().filter(({ id }) => !activeIds.has(id));
  const reserveHost = document.querySelector(".reserve-profile");
  if (reserveHost) {
    reserveHost.dataset.reserveClass = "all";
    reserveHost.dataset.loadout = reserve.map(({ id }) => defaultLoadouts[id].left).join(",");
    reserveHost.querySelector("b").textContent = `REZERWA · ${reserve.length} BOHATERÓW`;
    reserveHost.querySelector("small").textContent = reserve.map(({ name, classId }) => `${name} · ${classNames[classId]}`).join("  ·  ");
  }
}

function renderLog() {
  const visible = combat.log.slice(logCutoff).slice(-5).reverse();
  logRoot.replaceChildren(...visible.map((entry) => {
    const isEnemyEntry = battleMonsters().some(unit => entry.includes(unit.id) || entry.includes(unit.name));
    const item = make("li", isEnemyEntry ? "enemy-log" : entry.includes("Portal") || entry.includes("heks") ? "system-log" : "hero-log", act1DisplayText(entry));
    return item;
  }));
  emptyLog.classList.toggle("hidden", visible.length > 0);
}

function nextEligibleIds() {
  return party.slots.filter((id) => {
    const character = roster.get(id);
    return character.lifeState === "alive" && character.resources.hp > 0 && characterOnBattlefield(id);
  });
}

function pendingReturnIds() {
  const valid = [];
  for (const id of [...pendingReturns]) {
    if (!party.isActive(id) || !roster.has(id)) {
      pendingReturns.delete(id);
      continue;
    }
    const character = roster.get(id);
    const location = portalSystem.locationOf(id);
    const canReturn = character.lifeState === "alive"
      && character.resources.hp > 0
      && location?.kind === "town"
      && portalSystem.getPortal(location.via_portal_id)?.active;
    if (canReturn) valid.push(id);
    else pendingReturns.delete(id);
  }
  return valid;
}

function timelineLegalIds() {
  if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) return [];
  const fieldHeroes = nextEligibleIds();
  const heroes = [...new Set([...fieldHeroes, ...pendingReturnIds()])];
  const summons = combat.listSummons({ aliveOnly: true })
    .filter((summon) => optionalGridPosition(hexGrid, summon.id) !== null)
    .map((summon) => summon.id);
  if (!heroes.length && !summons.length) return [];
  return [
    ...heroes,
    ...(fieldHeroes.length ? battleMonsters().filter(unit => unit.hp > 0 && optionalGridPosition(hexGrid, unit.id)).map(unit => unit.id) : []),
    ...summons,
  ];
}

function movementEvents(path) {
  return path.slice(1).map((to, index) => ({
    offset: (index + 1) * ACTION_TIME.movePerTile,
    kind: "move:step",
    payload: {
      from: path[index],
      to,
      stepIndex: index + 1,
      stepCount: path.length - 1,
    },
  }));
}

function submitMovement(actorId, path, extraPayload = {}) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("Ruch wymaga co najmniej jednego kroku");
  const distance = path.length - 1;
  const result = combat.submitSequence(actorId, "move", {
    ...extraPayload,
    distance,
    path,
    to: path.at(-1),
    plannedWorldVersion: hexGrid.worldVersion(),
  }, { events: movementEvents(path) });
  try {
    result.events.forEach((event, index) => {
      hexGrid.reserveStep({
        commandId: result.commandId,
        eventId: event.id,
        unitId: actorId,
        at: event.at,
        from: path[index],
        to: path[index + 1],
      });
    });
  } catch (error) {
    const interruption = combat.interruptCommand(result.commandId, `rezerwacja ruchu: ${error.message}`);
    hexGrid.releaseReservationsByCommand(result.commandId);
    combat.log.push(`${actorId}: ruch odrzucony po konflikcie rezerwacji; zapłacony czas pozostaje.`);
    return {
      ...result,
      interrupted: true,
      interruption,
      error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
    };
  }
  return result;
}

function submitDelayedAttack(actorId, payload) {
  if (payload.attackType === "ranged") {
    const targetPosition = hexGrid.positionOf(payload.targetId);
    const impactHex = payload.impactHex ?? targetPosition;
    return combat.submitProjectile(actorId, payload, {
      from: hexGrid.positionOf(actorId),
      to: impactHex,
      targetAnchor: targetPosition,
      stepTime: PROJECTILE_HEX_TIME,
      collisionMask: {
        terrain: true,
        units: true,
        allies: true,
        enemies: true,
        piercing: false,
      },
    });
  }
  return combat.submitSequence(actorId, "attack", payload, {
    events: [{ offset: ATTACK_IMPACT_OFFSET, kind: "attack:impact", payload }],
  });
}

function submitApproachAttack(actorId, path, payload) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("Podejście do ataku wymaga co najmniej jednego kroku");
  const distance = path.length - 1;
  const moveDuration = distance * ACTION_TIME.movePerTile;
  const targetAnchor = hexGrid.positionOf(payload.targetId);
  const attackPayload = {
    ...payload,
    plannedTargetAnchor: targetAnchor,
    requireStableTargetAnchor: true,
  };
  const events = [
    ...movementEvents(path).map(event => ({ ...event, payload: {
      ...attackPayload, ...event.payload,
    } })),
    {
      offset: moveDuration + ATTACK_IMPACT_OFFSET,
      kind: "attack:impact",
      payload: attackPayload,
    },
  ];
  const result = combat.submitSequence(actorId, "approachAttack", {
    ...attackPayload,
    distance,
    path,
    to: path.at(-1),
    plannedWorldVersion: hexGrid.worldVersion(),
  }, { events });
  try {
    const moveEvents = result.events.filter((event) => event.kind === "move:step");
    moveEvents.forEach((event, index) => {
      hexGrid.reserveStep({
        commandId: result.commandId,
        eventId: event.id,
        unitId: actorId,
        at: event.at,
        from: path[index],
        to: path[index + 1],
      });
    });
  } catch (error) {
    const interruption = combat.interruptCommand(result.commandId, `rezerwacja podejścia: ${error.message}`);
    hexGrid.releaseReservationsByCommand(result.commandId);
    combat.log.push(`${actorId}: podejście do ataku odrzucone po konflikcie rezerwacji; zapłacony czas pozostaje.`);
    return {
      ...result,
      interrupted: true,
      interruption,
      error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
    };
  }
  return result;
}

function unitIsAliveOnGrid(unitId) {
  const runtimeUnit = combat.units.get(unitId);
  if (runtimeUnit?.kind === "monster") return runtimeUnit.hp > 0 && optionalGridPosition(hexGrid, unitId) !== null;
  if (runtimeUnit?.kind === "summon") {
    return runtimeUnit.alive !== false
      && (runtimeUnit.hp === null || runtimeUnit.hp > 0)
      && optionalGridPosition(hexGrid, unitId) !== null;
  }
  if (!roster.has(unitId)) return false;
  const character = roster.get(unitId);
  return character.lifeState === "alive" && character.resources.hp > 0
    && optionalGridPosition(hexGrid, unitId) !== null;
}

function footprintDistance(leftId, rightId) {
  return Math.min(...hexGrid.occupiedHexes(leftId).flatMap((left) =>
    hexGrid.occupiedHexes(rightId).map((right) => hexDistance(left, right))));
}

function reconcileDeaths() {
  for (const summon of combat.listSummons()) {
    if (summon.alive !== false && (summon.hp === null || summon.hp > 0)) continue;
    const stagedGrid = HexGrid.restore(hexGrid.snapshot());
    const removed = stagedGrid.removeUnit(summon.id);
    let stagedPreparation = battlePreparation;
    if (battlePreparation.listSummons().some(({ id }) => id === summon.id)
      && battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
      stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
      stagedPreparation.defeatSummon(summon.id);
    }
    hexGrid = stagedGrid;
    battlePreparation = stagedPreparation;
    if (removed) combat.log.push(`${summon.summonType ?? "Summon"} ginie; pole zostaje zwolnione.`);
  }
  for (const id of party.slots) {
    const character = roster.get(id);
    if (character.resources.hp > 0 && character.lifeState === "alive") continue;
    pendingReturns.delete(id);
    for (const ai of Object.values(enemyAiById)) if (ai.currentTargetId === id) ai.currentTargetId = null;
    const stagedGrid = HexGrid.restore(hexGrid.snapshot());
    const removed = stagedGrid.removeUnit(id);
    let stagedPreparation = battlePreparation;
    if (battlePreparation.isUnitOnField(id)) {
      if (battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
        stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
        stagedPreparation.withdrawUnit(id);
      } else if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) {
        stagedPreparation = postBattlePresence(battlePreparation, id, null, deploymentColumnOf);
      }
    }
    hexGrid = stagedGrid;
    battlePreparation = stagedPreparation;
    if (removed) combat.log.push(`${character.name} pada; jej/jego footprint natychmiast zwalnia pole.`);
  }
  if (campaign?.act1.currentEncounterId) {
    for (const defeated of battleMonsters().filter(unit => unit.hp <= 0 && !unit.rewardsGranted)) {
      const deathHex = optionalGridPosition(hexGrid, defeated.id) ?? defeated.position;
      const previousQuestStatus=campaign.denQuestView().status;
      const stagedCampaign = CampaignState.restoreAct1(campaign.toJSON(), {catalog:equipmentCatalog});
      stagedCampaign.recordAct1Defeat(defeated.id, {hex:deathHex,catalog:equipmentCatalog});
      stagedCampaign.reconcileDenQuest([...party.slots]);
      const awards = combat.grantMonsterExperience(defeated.id, nextEligibleIds());
      campaign = stagedCampaign;
      combat.log.push(`${defeated.name} pokonany. EXP: ${awards.map(({amount})=>amount).join(' / ') || '0'}.`);
      announceLevelUps(awards);
      if(previousQuestStatus!=='objective-complete' && campaign.denQuestView().status==='objective-complete') {
        combat.log.push('Siedlisko Zła zostało oczyszczone. Wróć do Akary po nagrodę.');
        showToast('Siedlisko Zła oczyszczone — wróć do Akary.');
      }
      hexGrid.removeUnit(defeated.id);
      if (enemyAiById[defeated.id]) enemyAiById[defeated.id].currentTargetId = null;
    }
    loot = visibleLootMarker();
    if (combat.livingEnemyCount() === 0 && battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
      battlePreparation.completeBattle({survivingSummonIds:battlePreparation.listSummons().map(({id})=>id)});
      queueMicrotask(() => autosaveGame('zakończeniu walki'));
      if(!explorationReturnQueued){
        explorationReturnQueued=true;
        queueMicrotask(()=>{if(battleAnimationBusy)return;explorationReturnQueued=false;if(campaign&&!isPaused()&&!activePanel)openPanel('map');});
      }
    }
  } else if (enemy.hp <= 0 && !enemy.rewardsGranted) {
    let deathHex = axial(5, 5);
    try { deathHex = hexGrid.positionOf(enemy.id); } catch { /* already removed */ }
    // Prepare the item before mutating rewards. Its identity and roll are never regenerated on pickup.
    const stagedProgress = stageVictoryLoot(encounterProgress, {enemy, hex:deathHex, catalog:equipmentCatalog});
    const awards = combat.grantMonsterExperience(enemy.id, nextEligibleIds());
    combat.log.push(`Upadły ginie. EXP: ${awards.map(({ amount }) => amount).join(" / ") || "0"}.`);
    announceLevelUps(awards);
    hexGrid.removeUnit(enemy.id);
    enemyAi.currentTargetId = null;
    encounterProgress = stagedProgress;
    loot = currentLootMarker(encounterProgress);
    if (battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
      battlePreparation.completeBattle({ survivingSummonIds: battlePreparation.listSummons().map(({ id }) => id) });
      queueMicrotask(() => autosaveGame('zakończeniu walki'));
    }
  }
}

function resolveTimelineEvent(event, resolveCore) {
  if (event.kind === "move:step") {
    if (event.payload.skillExecution) {
      validateHeroAttackExecution(event.actorId, event.payload);
      if (!unitIsAliveOnGrid(event.payload.targetId)
        || !sameHex(hexGrid.positionOf(event.payload.targetId), event.payload.plannedTargetAnchor)) {
        throw new Error('Cel podejścia nie jest już dostępny na zaplanowanym polu');
      }
    }
    // Stage every external spatial model first. The combat transaction invokes
    // resolveCore only after all of them accept the same step; failed validation
    // therefore cannot leave the canvas grid ahead of the saved world model.
    const stagedGrid = HexGrid.restore(hexGrid.snapshot());
    const moved = stagedGrid.commitReservedStep(event.id);
    if (!moved) throw new Error(`krok ${event.payload.stepIndex} został zablokowany`);
    let stagedPreparation = battlePreparation;
    let stagedPortals = portalSystem;
    if (roster.has(event.actorId)) {
      stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
      stagedPreparation.moveUnit({ unitId: event.actorId, to: moved.to });
      stagedPortals = PortalSystem.fromJSON(portalSystem.toJSON());
      stagedPortals.setCharacterLocation(event.actorId, {
        kind: "area",
        area_id: AREA_ID,
        instance_id: INSTANCE_ID,
        hex: moved.to,
      });
    } else if (combat.units.get(event.actorId)?.kind === "summon"
      && battlePreparation.listSummons().some((summon) => summon.id === event.actorId)) {
      stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
      stagedPreparation.moveUnit({ unitId: event.actorId, to: moved.to });
    }
    const result = resolveCore();
    hexGrid = stagedGrid;
    battlePreparation = stagedPreparation;
    portalSystem = stagedPortals;
    if (event.payload.stepIndex === event.payload.stepCount) {
      const name = combat.units.get(event.actorId)?.kind === "monster"
        ? combat.units.get(event.actorId).name
        : (roster.has(event.actorId) ? roster.get(event.actorId).name : combat.units.get(event.actorId)?.summonType ?? event.actorId);
      combat.log.push(`${name} kończy marsz na heksie ${hexKey(moved.to)}.`);
    }
    return result;
  }

  if (event.kind === "projectile:step" || event.kind === "projectile:impact") {
    const { actorId } = event;
    const { targetId, collisionMask, damageProfile } = event.payload;
    combat.validateProjectileEvent(event);
    const projectile = combat.projectile(event.payload.projectileId);
    if (!unitIsAliveOnGrid(targetId)) {
      throw new Error("cel pocisku nie jest już dostępny");
    }
    if (!unitIsAliveOnGrid(actorId) && projectile?.persistsAfterSourceDeath !== true) {
      throw new Error("źródło pocisku nie jest już dostępne");
    }
    if (!hexGrid.projectileStepIsClear(event.payload.from, event.payload.to, {
      blockTerrain: collisionMask.terrain,
      blockUnits: collisionMask.units && !collisionMask.piercing,
      ignoreUnitIds: [actorId, targetId],
      unitBlocks: (unitId) => {
        const source = combat.units.get(actorId);
        const blocker = combat.units.get(unitId);
        if (!source || !blocker) return true;
        return source.kind === blocker.kind ? collisionMask.allies : collisionMask.enemies;
      },
    })) {
      throw new Error(`tor pocisku został zablokowany na heksie ${hexKey(event.payload.to)}`);
    }
    if (event.kind === "projectile:step") return resolveCore();
    if (!hexGrid.occupiedHexes(targetId).some((occupied) => sameHex(occupied, event.payload.to))) {
      throw new Error("cel opuścił zaplanowany heks trafienia");
    }

    const execution = roster.has(actorId) ? validateHeroAttackExecution(actorId, event.payload, {
      allowDefeatedSource: projectile?.persistsAfterSourceDeath === true,
    }) : null;
    let damage = event.payload.damage;
    if (damageProfile?.kind === "basic-weapon") {
      damage = damageEngine.resolveBasicAttack(execution?.profile ?? damageProfile.profile).rolled;
    } else if (damageProfile?.kind === "integer-range") {
      damage = combatRng.integer(damageProfile.min, damageProfile.max);
    }
    // CombatState checkpoints roster resources. Any failed resolution restores
    // the payment; interrupted projectiles/approaches have never paid at all.
    if (execution) payExecutedAttack(actorId, event.payload.skillId);
    const result = resolveCore({ damage });
    reconcileDeaths();
    return result;
  }

  if (event.kind === "attack:impact") {
    const { actorId } = event;
    const { targetId, range = 1, attackType = "melee", damageProfile } = event.payload;
    if (!unitIsAliveOnGrid(actorId) || !unitIsAliveOnGrid(targetId)) throw new Error("źródło lub cel trafienia nie jest już dostępny");
    if (event.payload.requireStableTargetAnchor === true) {
      const planned = event.payload.plannedTargetAnchor;
      const current = hexGrid.positionOf(targetId);
      if (!planned || !sameHex(current, planned)) throw new Error("cel opuścił pozycję zaplanowaną dla podejścia z atakiem");
    }
    const distance = footprintDistance(actorId, targetId);
    if (distance > range) throw new Error(`cel opuścił zasięg (${distance}/${range})`);
    const from = hexGrid.positionOf(actorId);
    const to = hexGrid.positionOf(targetId);
    if (!hexGrid.hasLineOfSight(from, to, { ignoreUnitIds: [actorId, targetId] })) {
      throw new Error("linia widzenia została przerwana");
    }
    if (attackType === "ranged"
      && !hexGrid.hasProjectilePath(from, to, { ignoreUnitIds: [actorId, targetId] })) {
      throw new Error("tor pocisku został zablokowany");
    }
    const execution = roster.has(actorId) ? validateHeroAttackExecution(actorId, event.payload) : null;
    let damage = event.payload.damage;
    let strike = null, displaced = null, stagedGrid = null;
    if (execution?.profile.attackRating !== undefined) {
      strike = resolveBarbarianStrike(execution.profile, combat.units.get(targetId).sourceMonsterCode, combatRng);
      damage = strike.damage;
      if (strike.hit && execution.profile.knockback && combat.units.get(targetId).hp > damage) {
        stagedGrid = HexGrid.restore(hexGrid.snapshot());
        displaced = stagedGrid.moveUnitStep(targetId, knockbackHex(from, to));
      }
    } else if (damageProfile?.kind === "basic-weapon") {
      damage = damageEngine.resolveBasicAttack(execution?.profile ?? damageProfile.profile).rolled;
    } else if (damageProfile?.kind === "integer-range") {
      damage = combatRng.integer(damageProfile.min, damageProfile.max);
    }
    if (execution) payExecutedAttack(actorId, event.payload.skillId);
    const result = resolveCore({ damage });
    if (strike) combat.log.push(`${skillDefinitions[event.payload.skillId].name}: ${strike.hit ? 'trafienie' : strike.blocked ? 'blok' : 'pudło'} (szansa ${strike.chance}%).`);
    if (displaced && unitIsAliveOnGrid(targetId)) {
      // Interrupt the displaced unit's old route, never another party member.
      const interrupted = combat.interruptActorCommands(targetId, 'Odrzucenie');
      for (const entry of interrupted) if (entry?.command) stagedGrid.releaseReservationsByCommand(entry.command.commandId);
      combat.units.get(targetId).position = {...displaced.to};
      hexGrid = stagedGrid;
      combat.log.push(`Odrzucenie: ${targetId} przesunięty o jeden heks.`);
    }
    reconcileDeaths();
    return {...result, strike};
  }

  return resolveCore();
}

function releaseInterruptedReservations({ command }) {
  hexGrid.releaseReservationsByCommand(command.commandId);
}

function commitActiveTurn(action) {
  const eligibleBuffIds = battlePreparation.phase === BATTLE_PHASE.ACTIVE
    ? battlePreparation.listBuffs().map(({ id }) => id)
    : [];
  const result = action();
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
    // Tick only effects that existed before this action. A freshly cast
    // one-turn buff therefore survives its own casting boundary.
    battlePreparation.advanceTurn(1, { eligibleBuffIds });
  }
  return result;
}

function submitEnemyDecision() {
  if (!battlePreparation.enemyTurnsEnabled) return null;
  const enemy = combat.units.get(combat.currentActorId);
  if (!enemy || enemy.kind !== "monster" || !unitIsAliveOnGrid(enemy.id)) return null;
  const enemyAi = enemyAiById[enemy.id] ??= { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null };
  return commitActiveTurn(() => {
    const hostileIds = nextEligibleIds();
    if (!hostileIds.length) return combat.submitAction(enemy.id, "wait");
    const isAlive = (id) => {
      const unit = combat.units.get(id);
      if (!unit) return false;
      if (unit.kind === "monster") return unit.hp > 0;
      return roster.has(id)
        && roster.get(id).lifeState === "alive"
        && roster.get(id).resources.hp > 0;
    };
    const hasLineOfSight = ({ observerId, targetId, observerPosition, targetPosition }) =>
      hexGrid.hasLineOfSight(observerPosition, targetPosition, { ignoreUnitIds: [observerId, targetId] });
    const controlDecision = resolveTauntControlDecision({
      registry: combat.controlEffects,
      simTime: combat.scheduler.time,
      grid: hexGrid,
      actorId: enemy.id,
      isAlive,
      hasLineOfSight,
      tagsFor: (id) => combat.units.get(id)?.controlTags ?? [],
    });
    const decision = decideMeleePressure({
      grid: hexGrid,
      actorId: enemy.id,
      hostileIds,
      currentTargetId: enemyAi.currentTargetId,
      isAlive,
      hasLineOfSight,
      controlDecision,
    });
    enemyAi.currentTargetId = decision.targetId;
    if (decision.type === "attack") {
      const monsterProfile = ACT1_MONSTERS[enemy.sourceMonsterCode];
      combat.log.push(`${enemy.name} sygnalizuje cios wręcz przeciw ${roster.get(decision.targetId).name}.`);
      return submitDelayedAttack(enemy.id, {
        targetId: decision.targetId,
        range: 1,
        attackType: "melee",
        damageProfile: { kind: "integer-range", min: monsterProfile?.damageMin ?? 2, max: monsterProfile?.damageMax ?? 5 },
        aiProfileId: AI_PROFILE_IDS.MELEE_PRESSURE,
      });
    }
    if (decision.type === "move" && decision.path?.length > 1) {
      const path = decision.path.slice(0, 4);
      combat.log.push(`${enemy.name} naciska na ${roster.get(decision.targetId).name}: ${path.length - 1} kroków.`);
      return submitMovement(enemy.id, path, {
        targetId: decision.targetId,
        aiProfileId: AI_PROFILE_IDS.MELEE_PRESSURE,
      });
    }
    return combat.submitAction(enemy.id, "wait");
  });
}

function submitSummonDecision() {
  const summonId = combat.currentActorId;
  const summon = summonId ? combat.units.get(summonId) : null;
  if (!summon || summon.kind !== "summon") return null;
  return commitActiveTurn(() => {
    const decision = planSummonTurn({
      combat,
      grid: hexGrid,
      summonId,
      maxMoveCost: 3,
      rng: combatRng,
      damageProfile: null,
    });
    if (decision.type === "attack") {
      if (!unitIsAliveOnGrid(decision.targetId)
        || footprintDistance(summonId, decision.targetId) > (decision.range ?? 1)) {
        return combat.submitAction(summonId, "wait");
      }
      combat.log.push(`Szkielet wybiera legalny cel ${decision.targetId} i atakuje.`);
      return submitDelayedAttack(summonId, decision);
    }
    if (decision.type === "approachAttack" && decision.path?.length > 1) {
      if (!decision.damageProfile) return submitMovement(summonId, decision.path, { aiProfileId: SUMMON_AI_PROFILE.MELEE_RANDOM });
      if (!unitIsAliveOnGrid(decision.targetId)) return combat.submitAction(summonId, "wait");
      combat.log.push(`Szkielet podchodzi do ${decision.targetId} i próbuje ataku.`);
      return submitApproachAttack(summonId, decision.path, decision);
    }
    if (decision.type === "move" && decision.path?.length > 1) {
      return submitMovement(summonId, decision.path, { aiProfileId: SUMMON_AI_PROFILE.MELEE_RANDOM });
    }
    return combat.submitAction(summonId, "wait");
  });
}

function nextCommandWindow() {
  if (!campaignBattleAvailable()) return null;
  if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) return null;
  for (let step = 0; step < 1000; step += 1) {
    if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) return null;
    const boundary = combat.advanceTimeline(timelineLegalIds(), {
      resolve: resolveTimelineEvent,
      onInterrupt: releaseInterruptedReservations,
    });
    if (!boundary) return null;
    if (boundary.type !== "ready") continue;
    if (boundary.entry.kind === "monster") {
      actingUnitId = null;
      submitEnemyDecision();
      continue;
    }
    if (boundary.entry.kind === "summon") {
      actingUnitId = null;
      submitSummonDecision();
      continue;
    }
    return boundary.entry;
  }
  throw new Error("Timeline driver exceeded its deterministic safety limit");
}

function settleCompletedBattle() {
  if (battlePreparation.phase !== BATTLE_PHASE.COMPLETED) return;
  // Finish already committed effects, including projectiles that outlive their source.
  // Do not grant anyone new actions after victory or carry an old attack into a new encounter.
  combat.currentActorId = null;
  for (let step = 0; step < 10000; step += 1) {
    const boundary = combat.advanceTimeline([], {resolve:resolveTimelineEvent, onInterrupt:releaseInterruptedReservations});
    if (!boundary) {
      pendingReturns.clear();
      combat.scheduler.advanceTo(Math.max(combat.scheduler.time, ...[...combat.units.values()].map(u=>u.readyAt)));
      actingUnitId = nextEligibleIds()[0] ?? null;
      return;
    }
  }
  throw new Error("Nie udało się bezpiecznie rozliczyć końca starcia");
}

function driveTimeline() {
  if (battleAnimationBusy) return null;
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE && !combat.currentActorId
    && (party.slots.some(id => heroWalkAnimationAvailable(id) || heroAttackAnimationAvailable(id))
      || prioritizedBarbarianWalk)) {
    void driveAnimatedTimeline();
    return null;
  }
  return driveTimelineImmediately();
}

function driveTimelineImmediately() {
  if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) {
    settleCompletedBattle();
    return actingUnitId ? combat.units.get(actingUnitId) : null;
  }
  if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) {
    if (!actingUnitId || !party.isActive(actingUnitId)) actingUnitId = party.slots[0];
    return combat.units.get(actingUnitId) ?? null;
  }
  for (let step = 0; step < 1000; step += 1) {
    const head = nextCommandWindow();
    if (!head) {
      actingUnitId = null;
      if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) settleCompletedBattle();
      return null;
    }
    if (pendingReturns.has(head.id)) {
      actingUnitId = null;
      resolvePendingReturn(head.id);
      continue;
    }
    actingUnitId = head.id;
    inspectedCharacterId = head.id;
    return head;
  }
  throw new Error("Timeline driver exceeded its deterministic safety limit");
}

async function driveAnimatedTimeline() {
  if (battleAnimationBusy) return;
  const epoch = ++battleAnimationEpoch;
  const sessionCombat = combat;
  battleAnimationBusy = true;
  const stillCurrent = () => epoch === battleAnimationEpoch && sessionCombat === combat;
  try {
    for (let step = 0; step < 10000 && stillCurrent(); step++) {
      const completed = battlePreparation.phase === BATTLE_PHASE.COMPLETED;
      const legal = completed ? [] : timelineLegalIds();
      const next = combat.previewNextTimelineEvent(legal);
      const walkPilot = next && heroWalkAnimationAvailable(next.actorId);
      const attackPilot = next && heroAttackAnimationAvailable(next.actorId);
      const animatedStrike = attackPilot && next.kind === 'attack:impact'
        && unitIsAliveOnGrid(next.actorId) && unitIsAliveOnGrid(next.payload.targetId);
      const animatedCast = attackPilot && ['projectile:step', 'projectile:impact'].includes(next.kind)
        && next.payload.pathIndex === 1 && unitIsAliveOnGrid(next.actorId);
      if (walkPilot && next.kind === 'move:step') {
        await battleAnimation.play({actorId: next.actorId, clip: 'walk',
          from: hexToScreen(next.payload.from), to: hexToScreen(next.payload.to)},
        walkStepDuration(next.payload.stepCount));
      } else if (animatedStrike || animatedCast) {
        await battleAnimation.play({actorId: next.actorId, clip: 'windup',
          from: hexToScreen(hexGrid.positionOf(next.actorId)),
          to: hexToScreen(unitIsAliveOnGrid(next.payload.targetId)
            ? hexGrid.positionOf(next.payload.targetId) : next.payload.to)}, WINDUP_MS);
      }
      if (!stillCurrent()) return;
      // Only the unchanged deterministic resolver commits a hit or a hex step.
      const boundary = combat.advanceTimeline(legal, {
        resolve: resolveTimelineEvent, onInterrupt: releaseInterruptedReservations,
      });
      render();
      if (!boundary) {
        if (completed) settleCompletedBattle();
        else actingUnitId = null;
        return;
      }
      if (prioritizedBarbarianWalk
        && !combat.activeCommands.has(prioritizedBarbarianWalk.commandId)) {
        for (const [id, readyAt] of deferredWalkReadiness) {
          const unit = combat.units.get(id);
          if (unit) unit.readyAt = readyAt;
        }
        deferredWalkReadiness.clear();
        prioritizedBarbarianWalk = null;
      }
      if ((animatedStrike || animatedCast) && boundary.type === 'event' && boundary.event.id === next.id) {
        if (animatedStrike) battleImpactVisual = boundary.resolution?.strike?.hit === false ? null
          : {targetId: next.payload.targetId,
            direction: battleAnimation.facing.get(next.actorId)?.includes('west') ? -1 : 1};
        await battleAnimation.play({actorId: next.actorId, clip: 'recovery'}, RECOVERY_MS);
        battleImpactVisual = null;
      }
      if (!stillCurrent()) return;
      if (boundary.type !== 'ready') continue;
      if (prioritizedBarbarianWalk && combat.activeCommands.has(prioritizedBarbarianWalk.commandId)) {
        const unit = combat.units.get(boundary.entry.id);
        if (unit && !deferredWalkReadiness.has(unit.id)) {
          deferredWalkReadiness.set(unit.id, unit.readyAt);
          unit.readyAt = prioritizedBarbarianWalk.recoveryEnd;
        }
        combat.currentActorId = null;
        combat.readinessPhase = READINESS_PHASE.RESOLVING;
        actingUnitId = prioritizedBarbarianWalk.actorId;
        inspectedCharacterId = prioritizedBarbarianWalk.actorId;
        render();
        continue;
      }
      if (boundary.entry.kind === 'monster') { actingUnitId = null; submitEnemyDecision(); continue; }
      if (boundary.entry.kind === 'summon') { actingUnitId = null; submitSummonDecision(); continue; }
      if (pendingReturns.has(boundary.entry.id)) { actingUnitId = null; resolvePendingReturn(boundary.entry.id); continue; }
      actingUnitId = boundary.entry.id;
      inspectedCharacterId = boundary.entry.id;
      return;
    }
    if (stillCurrent()) throw new Error('Przekroczono limit odtwarzania akcji');
  } catch (error) {
    if (stillCurrent()) {
      // Playback failure must not strand a paid command. The same resolver
      // finishes pending events once; no animation callback reapplies damage.
      driveTimelineImmediately();
      if (prioritizedBarbarianWalk
        && !combat.activeCommands.has(prioritizedBarbarianWalk.commandId)) {
        for (const [id, readyAt] of deferredWalkReadiness) {
          const unit = combat.units.get(id);
          if (unit) unit.readyAt = readyAt;
        }
        deferredWalkReadiness.clear();
        prioritizedBarbarianWalk = null;
      }
      showToast(`Animacja przerwana: ${error.message}. Komenda rozliczona bez animacji.`, 'warning');
    }
  } finally {
    if (stillCurrent()) {
      battleAnimationBusy = false; battleImpactVisual = null;
      battleAnimation.playbacks.clear();
      render();
      if (explorationReturnQueued && campaign && !isPaused() && !activePanel) {
        explorationReturnQueued = false; openPanel('map');
      }
    }
  }
}

function renderQueue() {
  const row = document.querySelector("#initiative-row");
  if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) {
    row.replaceChildren(make("span", "initiative-token current", "ZWYCIĘSTWO"));
    return;
  }
  if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
    row.replaceChildren(...party.slots.flatMap((id, index) => {
      const character = roster.get(id);
      const item = make("span", `initiative-token hero-token ${id === actingUnitId ? "current" : ""}`, character.name[0]);
      item.title = `${character.name} · swobodne przygotowanie`;
      return index === party.slots.length - 1 ? [item] : [item, make("i")];
    }));
    return;
  }
  const tokens = [];
  if (combat.currentActorId) {
    const unit = combat.units.get(combat.currentActorId);
    tokens.push({ actorId: unit.id, at: combat.scheduler.time, eventKind: "manual:decision", current: true });
  }
  for (const event of combat.timelinePreview(8)) {
    if (tokens.length >= 5) break;
    tokens.push({ actorId: event.actorId, at: event.at, eventKind: event.kind, current: false, targetId: event.payload?.targetId });
  }
  row.replaceChildren(...tokens.flatMap((token, index) => {
    const runtimeUnit = combat.units.get(token.actorId);
    const isEnemy = runtimeUnit?.kind === "monster";
    const name = isEnemy ? runtimeUnit.name : (roster.has(token.actorId) ? roster.get(token.actorId).name : runtimeUnit?.summonType ?? token.actorId);
    const glyph = token.eventKind === "move:step" ? "→"
      : token.eventKind === "projectile:step" ? "•"
        : token.eventKind === "attack:impact" || token.eventKind === "projectile:impact" ? "!" : name[0];
    const label = token.eventKind === "manual:decision" ? "decyzja"
      : token.eventKind === "actor:ready" ? "gotowość"
        : token.eventKind === "move:step" ? "krok ruchu"
          : token.eventKind === "projectile:step" ? "lot pocisku" : "moment trafienia";
    const item = make("span", `initiative-token ${isEnemy ? "enemy-token" : "hero-token"} ${token.current ? "current" : ""}`, glyph);
    item.title = `${name} · ${label} w ${(token.at / 1000).toFixed(2)} s${token.targetId ? ` · cel ${token.targetId}` : ""}`;
    return index === tokens.length - 1 ? [item] : [item, make("i")];
  }));
}

function actingCharacter() {
  return actingUnitId ? roster.get(actingUnitId) : null;
}

function inspectedCharacter() {
  return roster.get(inspectedCharacterId);
}

function activeSkillCards() {
  const actor = actingCharacter();
  if (!actor) return [];
  const loadout = battlePreparation.getLoadout(actor.id);
  return [loadout.left, ...loadout.right].map((id) => skillDefinitions[id]);
}

function isOffensiveSkill(skill) {
  return skill?.category === SKILL_CATEGORY.OFFENSIVE;
}

function runtimeSkillLevel(character, skillId) {
  if (skillId === 'basic.attack') return 1;
  const source = skillTreeSkillForDefinition(character.classId, skillDefinitions[skillId]);
  return source ? Math.max(1, sourceSkillLevel(character, source)) : 1;
}

function skillManaState(character, skillId) {
  const source = currentManaSource(character, skillId);
  return canPaySkillMana(character.resources.mana, source, runtimeSkillLevel(character, skillId));
}

function paySkillMana(character, skillId) {
  const source = currentManaSource(character, skillId);
  return spendSkillMana(character, source, runtimeSkillLevel(character, skillId));
}

function currentManaSource(character, skillId) {
  const source = skillTreeSkillForDefinition(character.classId, skillDefinitions[skillId]);
  return source ? { mana: source.mana.raw } : mouseSkillCatalog.get(skillId);
}

function currentAttackProfile(character, skill) {
  const status = runtimeSkillStatus(skill.id);
  if (!status.supported) throw new Error(status.label);
  if (skill.id === 'sorceress.fire_bolt') {
    const values = fireBoltValues(character, skillTreeCatalog);
    return { label: 'Ognisty Piorun', weaponMin: values.damage[0], weaponMax: values.damage[1],
      offWeaponFlat: 0, damageOrigin: 'source-skill', damageType: 'fire', status: 'SOURCE_NUMERIC_HEX_ADAPTATION', range: skill.range };
  }
  const profile = equipmentSkillProfile(character, skill, equipmentCatalog);
  if (['equipment', 'shield'].includes(profile?.damageOrigin)) {
    for (const item of [character.equipment.weapon, character.equipment.offhand].filter(Boolean)) {
      const definition = equipmentCatalog.get(item.canonicalId);
      if (!definition) throw new Error('Nieznana broń lub tarcza');
      const errors = requirementsFor(character, definition);
      if (errors.length) throw new Error(errors.join(' · '));
    }
  }
  if (skill.id === 'barbarian.bash' || (skill.id === 'basic.attack' && supportsBarbarianAnimation(character))) {
    return barbarianSwordProfile(character, skill, equipmentCatalog, skillTreeCatalog);
  }
  return profile;
}

function validateHeroAttackExecution(actorId, payload, { allowDefeatedSource = false } = {}) {
  const character = roster.get(actorId);
  const skill = skillDefinitions[payload.skillId];
  if (!skill || !payload.skillExecution || payload.skillExecution.skillId !== payload.skillId) {
    throw new Error('Brak zgodnego opisu wykonania umiejętności');
  }
  const source = mouseSkillCatalog.get(skill.id);
  if (skillTargetMode(source, skill) !== SkillTarget.ENEMY) throw new Error('Nielegalny tryb celu ataku');
  if ((payload.range !== undefined && payload.range !== skill.range)
    || (payload.attackType !== undefined && payload.attackType !== (skill.range > 1 ? 'ranged' : 'melee'))) {
    throw new Error('Zasięg lub rodzaj zaplanowanego ataku nie odpowiada umiejętności');
  }
  return checkSkillExecution(payload.skillExecution, {
    character, skill, source,
    skillLevel: runtimeSkillLevel(character, skill.id),
    knownSkillIds: knownMouseSkillsForHero(actorId),
    profile: currentAttackProfile(character, skill),
    allowDefeatedSource,
  });
}

function payExecutedAttack(actorId, skillId) {
  const actor = roster.get(actorId);
  const spent = paySkillMana(actor, skillId);
  if (spent.cost > 0) combat.log.push(`${actor.name}: ${skillDefinitions[skillId].name} zużywa ${formatMana(spent.cost)} many (${formatMana(spent.remainingMana)} pozostało).`);
}

function setOpeningReadinessOrder(firstHeroId = party.slots[0]) {
  const ordered = [firstHeroId, ...party.slots.filter((id) => id !== firstHeroId), ...battleMonsters().filter(unit => unit.hp > 0).map(unit => unit.id)];
  ordered.forEach((id, index) => {
    const unit = combat.units.get(id);
    if (unit) unit.readinessTieKey = `opening:${String(index).padStart(2, "0")}:${id}`;
  });
}

function renderPreparationStatus() {
  const buffs = battlePreparation.listBuffs();
  const summons = battlePreparation.listSummons();
  const warCry = buffs.find((buff) => buff.sourceId === "korgan" && skillDefinitions[buff.skillId]?.category === SKILL_CATEGORY.BUFF);
  const aura = buffs.find((buff) => buff.sourceId === "hadriel" && skillDefinitions[buff.skillId]?.category === SKILL_CATEGORY.AURA);
  const necroSummons = summons.filter((summon) => summon.ownerId === "ormus");
  document.querySelector("#warcry-status").textContent = warCry
    ? `${skillDefinitions[warCry.skillId]?.name ?? warCry.skillId} · ${warCry.remainingTurns ?? "∞"} tur`
    : "nieaktywny";
  document.querySelector("#aura-status").textContent = aura
    ? `${skillDefinitions[aura.skillId]?.name ?? aura.skillId} · drużyna`
    : "nieaktywna";
  document.querySelector("#summon-status").textContent = `${necroSummons.length} / ${necroskeletonStats({ skillLevel: runtimeSkillLevel(roster.get("ormus"), RAISE_SKELETON_SKILL_ID) }).maxCount}`;
  document.querySelector("[data-summon-count]").dataset.summonCount = String(necroSummons.length);
}

function closeMouseSkillChooser({ renderNow = false } = {}) {
  mouseSkillChooserSide = null;
  hoveredSkillChoice = null;
  hideSkillTooltip();
  const chooser = document.querySelector("#mouse-skill-chooser");
  chooser?.classList.add("hidden");
  document.querySelector("#mouse-skill-left")?.setAttribute("aria-expanded", "false");
  document.querySelector("#mouse-skill-right")?.setAttribute("aria-expanded", "false");
  if (renderNow) render();
}

function skillChoiceDescription(character, skillId, source, runtime) {
  const name = source?.localizedName?.plPL || runtime?.name || 'Atak';
  const level = source ? sourceSkillLevel(character, source) : 1;
  const status = runtimeSkillStatus(runtime?.id || skillId);
  const lines = [name, source ? `Poziom umiejętności: ${level}` : 'Zwykły atak założoną bronią'];
  if (source) {
    const mana = skillManaProfile({ mana: source.mana.raw }, level);
    lines.push(`Mana: ${formatMana(mana.cost)} · wymagany poziom postaci: ${source.requirements.characterLevel}`);
    const description = source.localizedLongDescription?.plPL || source.localizedShortDescription?.plPL;
    if (description) lines.push(description);
    if (source.requirements.prerequisiteSkills.length) lines.push('Wymaga: ' + source.requirements.prerequisiteSkills.map(name => {
      const prerequisite = skillTreeCatalog.skill(character.classId, name);
      return prerequisite.localizedName.plPL || name;
    }).join(', '));
    if (source.id === 'sorceress.fire_bolt') {
      const values = fireBoltValues(character, skillTreeCatalog);
      lines.push(`Ogień: ${values.damage.join('–')} · synergie: +${values.synergyPercent}% · mistrzostwo: +${values.masteryPercent}%`);
    }
    if (source.id === 'barbarian.bash') {
      const v = bashValues(character, skillTreeCatalog);
      lines.push(`Obrażenia: +${v.damagePercent}% oraz +${v.flatDamage}; skuteczność ataku: +${v.ratingPercent}%`,
        'Synergie: Ogłuszenie +5% obrażeń/punkt; Koncentracja +5% skuteczności/punkt (tylko wydane punkty).',
        'Trafiony żywy przeciwnik: odrzut o 1 wolny heks. Ściana lub zajęte pole blokuje odrzut.');
    }
  }
  if (runtime) {
    const mana = skillManaState(character, runtime.id);
    if (!mana.affordable) lines.push(`Za mało many: potrzeba ${formatMana(mana.requiredToCast)}, masz ${formatMana(mana.currentMana)}`);
    if (isOffensiveSkill(runtime) && status.supported) {
      try { const error = currentAttackProfile(character, runtime)?.error; if (error) lines.push(error); }
      catch (error) { lines.push(error.message); }
    }
  }
  if (!status.supported) lines.push(status.label);
  return lines.join('\n');
}

function hideSkillTooltip() {
  document.querySelector('#action-skill-tooltip')?.remove();
}

function showSkillTooltip(button) {
  hideSkillTooltip();
  if (!button?.dataset.tooltip) return;
  const tooltip = make('div', 'action-skill-tooltip');
  tooltip.id = 'action-skill-tooltip'; tooltip.setAttribute('role', 'tooltip');
  for (const [i, line] of button.dataset.tooltip.split('\n').entries()) tooltip.append(make(i ? 'div' : 'strong', '', line));
  document.body.append(tooltip);
  const r = button.getBoundingClientRect(), t = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.x + r.width / 2 - t.width / 2))}px`;
  tooltip.style.top = `${Math.max(8, r.y - t.height - 12)}px`;
}

function renderMouseSkillChooser(character) {
  const chooser = document.querySelector('#mouse-skill-chooser');
  if (!chooser) return;
  hideSkillTooltip();
  if (!mouseSkillChooserSide) { chooser.classList.add('hidden'); chooser.replaceChildren(); return; }
  const side = mouseSkillChooserSide;
  chooser.dataset.visualClass = character.classId === PALETTE_PILOT_CLASS ? character.classId : '';
  const binding = mouseSkills.get(character.id);
  const entries = nativeSkillSources(character, skillTreeCatalog)
    .filter(({source}) => source.mechanicFlags[side === 'left' ? 'leftMouseAssignable' : 'rightMouseAssignable'])
    .map(entry => ({...entry, runtime:skillDefinitions[entry.skillId] ?? null}));
  entries.push({skillId:'basic.attack',runtime:skillDefinitions['basic.attack'],source:null,sourceType:'BASIC_ACTION'});
  // Source tree-page/row ordering; common Attack occupies the last row.
  entries.sort((a, b) => a.source && b.source
    ? a.source.treePage - b.source.treePage || a.source.requirements.characterLevel - b.source.requirements.characterLevel
    : a.source ? -1 : b.source ? 1 : 0);
  chooser.replaceChildren();
  const tiles = make('div', 'skill-choice-tiles');
  for (const {skillId, runtime, source, sourceType} of entries) {
    const status = runtimeSkillStatus(runtime?.id || skillId);
    if (skillId === 'barbarian.bash') {
      try { if (currentAttackProfile(character, runtime)?.error) status.supported = false; }
      catch { status.supported = false; }
    }
    const button = make('button', 'mouse-skill-choice');
    button.type = 'button'; button.dataset.mouseSide = side; button.dataset.skillId = skillId;
    button.dataset.skillSource = sourceType;
    button.dataset.usable = String(Boolean(runtime && status.supported));
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(binding[side] === skillId));
    button.setAttribute('aria-disabled', String(!runtime || !status.supported));
    button.setAttribute('aria-label', source?.localizedName?.plPL || runtime?.name || 'Atak');
    button.classList.toggle('active', binding[side] === skillId);
    button.dataset.tooltip = skillChoiceDescription(character, skillId, source, runtime);
    const glyph = make('span', 'choice-glyph');
    if (source) {
      const icon = document.createElement('img'); icon.className = 'skill-icon-image';
      icon.src = skillIconUrl(character.classId, source); icon.alt = ''; glyph.append(icon);
      if (character.classId === PALETTE_PILOT_CLASS) watchPaletteAsset(icon, button, source.localizedName?.plPL || source.internalName);
    } else glyph.classList.add('common-attack-icon');
    button.append(glyph);
    const key = skillHotkeys.label(character.id, side, skillId);
    if (key) button.append(make('kbd', 'skill-hotkey-label', key));
    if (source) button.append(make('small', 'skill-rank-label', String(sourceSkillLevel(character, source))));
    tiles.append(button);
  }
  chooser.append(tiles, make('div', 'skill-choice-instruction', 'Naciśnij F1–F8, aby przypisać umiejętność do klawisza'));
  chooser.dataset.side = side; chooser.classList.remove('hidden');
  // Fixed viewport coordinates anchor to the actual scaled hand, never a guessed HUD percentage.
  const anchor = document.querySelector(`#mouse-skill-${side}`).getBoundingClientRect();
  const size = Math.max(48, Math.min(80, anchor.width));
  chooser.style.setProperty('--skill-tile-size', `${size}px`);
  tiles.style.gridTemplateColumns = `repeat(${Math.min(7, entries.length)}, var(--skill-tile-size))`;
  const width = chooser.getBoundingClientRect().width;
  chooser.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, anchor.x))}px`;
  chooser.style.bottom = `${innerHeight - anchor.y + 8}px`;
  if (character.classId === PALETTE_PILOT_CLASS) stylePilotPalette(chooser, tiles, side, anchor);
}

function renderMouseSkillHud() {
  const character = inspectedCharacter();
  if (!character || !mouseSkills) return;
  refreshHeroSkillAvailability(character.id);
  const binding = mouseSkills.get(character.id);
  const leftSkill = skillDefinitions[binding.left];
  const rightSkill = skillDefinitions[binding.right];
  const activeAuraSkillId = battlePreparation.listBuffs().find(buff =>
    buff.sourceId === character.id && mouseSkillCatalog.has(buff.skillId) && mouseSkillCatalog.get(buff.skillId).aura)?.skillId ?? null;
  const owner = document.querySelector("#mouse-skill-owner");
  if (owner) owner.textContent = `${character.name} · ${classNames[character.classId]}`;
  const hint = document.querySelector("#mouse-skill-hint");
  if (hint) {
    const hoverSkill = primaryHoverPlan?.actorId === character.id
      ? skillDefinitions[primaryHoverPlan.skillId]
      : null;
    const hoverCopy = !primaryHoverPlan || !hoverSkill
      ? null
      : primaryHoverPlan.type === "in-range"
        ? `LPM ${hoverSkill.name}: cel jest w zasięgu · atak +${formatSeconds(ACTION_TIME.attack)} s.`
        : primaryHoverPlan.type === "approach"
          ? `LPM ${hoverSkill.name}: podejście ${primaryHoverPlan.moveSteps} heks. + atak · razem +${formatSeconds(primaryHoverPlan.totalDuration)} s.`
          : `LPM ${hoverSkill.name}: cel poza automatycznym limitem dojścia 3 — kliknij bliższy pusty heks.`;
    hint.textContent = battlePreparation.phase === BATTLE_PHASE.COMPLETED
      ? "Starcie zakończone — przypisania LPM/PPM pozostają zapisane dla postaci."
      : actingUnitId && actingUnitId !== character.id && battlePreparation.phase === BATTLE_PHASE.ACTIVE
        ? `Oglądasz ${character.name}; aktualne polecenia wykonuje ${actingCharacter()?.name ?? "inna postać"}.`
        : hoverCopy ?? "LPM: ziemia = ruch, wróg = aktywna umiejętność. PPM: aktywna prawa umiejętność.";
    if (activeAuraSkillId) hint.textContent += ` Aura: ${skillDefinitions[activeAuraSkillId]?.name ?? activeAuraSkillId}.`;
    hint.dataset.activeAuraSkillId = activeAuraSkillId ?? '';
  }

  for (const [side, skill] of [["left", leftSkill], ["right", rightSkill]]) {
    const button = document.querySelector(`#mouse-skill-${side}`);
    if (!button) continue;
    const skillId = binding[side];
    const source = mouseSkillCatalog.get(skillId);
    const mana = skillManaState(character, skillId);
    const targetMode = skillTargetMode(source, skill);
    let equipmentReason = '';
    if (isOffensiveSkill(skill)) {
      try { equipmentReason = currentAttackProfile(character, skill)?.error ?? ''; }
      catch (error) { equipmentReason = error.message; }
    }
    const unavailableReason = !runtimeSkillStatus(skillId).supported ? runtimeSkillStatus(skillId).label : !mana.affordable ? 'Za mało many' : equipmentReason;
    button.dataset.skillId = skillId;
    button.dataset.visualClass = character.classId === PALETTE_PILOT_CLASS ? character.classId : '';
    button.dataset.targetMode = targetMode;
    button.dataset.manaCost = String(mana.cost);
    button.dataset.available = String(!unavailableReason);
    button.dataset.activeAuraSkillId = activeAuraSkillId ?? '';
    button.dataset.category = skill?.visualCategory ?? skill?.category ?? "";
    button.classList.toggle("mana-unavailable", !mana.affordable);
    button.classList.toggle('skill-unavailable', Boolean(unavailableReason));
    button.classList.toggle('active-aura', activeAuraSkillId === skillId);
    const glyph = button.querySelector(`#mouse-skill-${side}-glyph`);
    const icon = button.querySelector(`#mouse-skill-${side}-icon`);
    const iconUrl = combatSkillIconUrl(character, skill);
    if (icon) {
      icon.hidden = !iconUrl;
      if (iconUrl) icon.src = iconUrl;
      else icon.removeAttribute('src');
      icon.alt = skill?.name ?? source.sourceName;
      if (iconUrl && character.classId === PALETTE_PILOT_CLASS) watchPaletteAsset(icon, button, icon.alt);
    }
    if (glyph) {
      glyph.hidden = Boolean(iconUrl);
      glyph.textContent = '';
      glyph.classList.toggle('common-attack-icon', skillId === 'basic.attack');
    }
    let hotkeyLabel = button.querySelector('.skill-hotkey-label');
    if (!hotkeyLabel) { hotkeyLabel = make('kbd', 'skill-hotkey-label'); button.append(hotkeyLabel); }
    hotkeyLabel.textContent = skillHotkeys.label(character.id, side, skillId);
    button.querySelector(`#mouse-skill-${side}-name`).textContent = skill?.name ?? source.sourceName;
    const costCopy = ` · mana ${formatMana(mana.cost)}`;
    button.querySelector(`#mouse-skill-${side}-copy`).textContent = !mana.affordable
      ? `Za mało many · ${formatMana(mana.cost)}`
      : `Mana ${formatMana(mana.cost)}${activeAuraSkillId === skillId ? ' · aktywna' : source.targeting.corpse ? ' · zwłoki' : ''}`;
    const controlCopy = side === 'left' ? 'LPM: ziemia = ruch, wróg = skill'
      : targetMode === SkillTarget.CORPSE ? 'PPM: wskaż zwłoki' : targetMode === SkillTarget.GROUND ? 'PPM: wskaż pusty heks' : source.aura ? 'PPM: aktywuj aurę' : 'PPM: użyj umiejętności';
    button.title = `${skill?.name ?? source.sourceName}${costCopy} · ${controlCopy}${unavailableReason ? ` · ${unavailableReason}` : ''}${!mana.affordable ? `: potrzeba ${formatMana(mana.requiredToCast)}, masz ${formatMana(mana.currentMana)}` : ''}${activeAuraSkillId === skillId ? ' · Aktywna aura' : ''}`;
    button.setAttribute("aria-label", `${side === "left" ? "LPM" : "PPM"}: ${skill?.name ?? source.sourceName}`);
    button.setAttribute("aria-expanded", String(mouseSkillChooserSide === side));
  }
  renderMouseSkillChooser(character);
}

function renderCards() {
  const actor = actingCharacter();
  const displayCharacter = inspectedCharacter();
  const inspectedLoadout = party.isActive(displayCharacter.id)
    ? battlePreparation.getLoadout(displayCharacter.id) : reserveLoadouts[displayCharacter.id];
  const displaySkill = skillDefinitions[inspectedLoadout?.left];
  const profile = equipmentSkillProfile(displayCharacter, displaySkill, equipmentCatalog) ?? { weaponMin: 0, weaponMax: 0 };
  const cards = [...document.querySelectorAll("#cards .skill-card")];
  const skills = actor ? activeSkillCards() : [];
  cards.forEach((card, index) => {
    const skill = skills[index];
    card.dataset.skillId = skill?.id ?? "";
    card.dataset.category = skill?.visualCategory ?? skill?.category ?? "";
    card.querySelector(".card-glyph").textContent = skill?.glyph ?? "—";
    card.querySelector(".card-name").textContent = skill?.name ?? "BRAK UMIEJĘTNOŚCI";
    const skillProfile = actor && skill ? equipmentSkillProfile(actor, skill, equipmentCatalog) : null;
    const damageCopy = skillProfile
      ? `${skillProfile.weaponMin}–${skillProfile.weaponMax} obr. · ${skillProfile.damageOrigin === "equipment" ? "z wyposażenia" : skillProfile.damageOrigin === "shield" ? "z tarczy" : "profil zaklęcia"} · `
      : "";
    card.querySelector(".card-copy").textContent = skill ? `${damageCopy}${skill.copy} · ${skill.status}` : "—";
    card.title = skillProfile?.error ?? (skillProfile?.damageOrigin === "equipment"
      ? "Baza broni + atrybuty. Specjalne mechaniki i mnożniki umiejętności są nadal uproszczone."
      : skill?.copy ?? "");
    const combatLocked = battlePreparation.phase === BATTLE_PHASE.ACTIVE
      && (!combat.canAct(actor?.id) || !characterOnBattlefield(actor?.id));
    card.disabled = !campaignBattleAvailable() || !actor || !skill || battlePreparation.phase === BATTLE_PHASE.COMPLETED
      || combatLocked || Boolean(skillProfile?.error) || (isOffensiveSkill(skill) && combat.livingEnemyCount() === 0);
    card.classList.toggle("disabled", card.disabled);
    card.classList.toggle("selected", pendingTarget === "skill" && pendingSkillId === skill?.id);
    card.setAttribute("aria-label", skill ? `${card.dataset.slotRole === "left" ? "LPM" : `PPM ${Number(card.dataset.rightIndex) + 1}`}: ${skill.name}` : "Pusty slot");
  });
  document.querySelector("#damage-stat").textContent = `${profile.weaponMin}–${profile.weaponMax}`;
  const supply = actor ? portalScrolls.get(actor.id) : null;
  const count = supply?.remaining ?? 0;
  document.querySelector("#portal-count-stat").textContent = String(count);
  const belt = actor ? belts.get(actor.id) : [];
  const healthPotionIndex = belt?.findIndex((slot) => potionKind(slot) === "health" && beltSlotCount(slot) > 0) ?? -1;
  const manaPotionIndex = belt?.findIndex((slot) => potionKind(slot) === "mana" && beltSlotCount(slot) > 0) ?? -1;
  document.querySelector("#health-potion-count").textContent = `×${belt?.reduce((total, slot) => total + (potionKind(slot) === "health" ? beltSlotCount(slot) : 0), 0) ?? 0}`;
  document.querySelector("#mana-potion-count").textContent = `×${belt?.reduce((total, slot) => total + (potionKind(slot) === "mana" ? beltSlotCount(slot) : 0), 0) ?? 0}`;
  document.querySelector("#loadout-cost").textContent = battlePreparation.phase === BATTLE_PHASE.PREPARATION ? "bez kosztu" : "kosztuje kolejkę";
  const utilityLocked = !campaignBattleAvailable() || !actor || battlePreparation.phase === BATTLE_PHASE.COMPLETED
    || (battlePreparation.phase === BATTLE_PHASE.ACTIVE && !combat.canAct(actor.id));
  document.querySelector("#move-command").disabled = utilityLocked;
  document.querySelector("#potion-health").disabled = utilityLocked || healthPotionIndex < 0;
  document.querySelector("#potion-mana").disabled = utilityLocked || manaPotionIndex < 0;
  document.querySelector("#change-loadout").disabled = utilityLocked;
  document.querySelector("#end-turn").disabled = battlePreparation.phase !== BATTLE_PHASE.ACTIVE || utilityLocked;
  renderMouseSkillHud();
}

function beltGlyph(slot) {
  if (potionKind(slot) === "health") return "♥";
  if (potionKind(slot) === "mana") return "◆";
  return "";
}

function renderD2HudResources() {
  const inspected = inspectedCharacter();
  const actor = actingCharacter();
  const hpRatio = inspected.resources.maxHp > 0
    ? Math.max(0, Math.min(1, inspected.resources.hp / inspected.resources.maxHp))
    : 0;
  const manaRatio = inspected.resources.maxMana > 0
    ? Math.max(0, Math.min(1, inspected.resources.mana / inspected.resources.maxMana))
    : 0;

  const lifeOrb = document.querySelector("#life-orb");
  const manaOrb = document.querySelector("#mana-orb");
  lifeOrb?.style.setProperty("--orb-fill", `${(hpRatio * 100).toFixed(2)}%`);
  manaOrb?.style.setProperty("--orb-fill", `${(manaRatio * 100).toFixed(2)}%`);
  document.querySelector("#life-orb-value").textContent = `${inspected.resources.hp} / ${inspected.resources.maxHp}`;
  document.querySelector("#mana-orb-value").textContent = `${formatMana(inspected.resources.mana)} / ${formatMana(inspected.resources.maxMana)}`;
  document.querySelector("#life-orb-detail").textContent = `${classNames[inspected.classId]} · poziom ${inspected.level}`;
  document.querySelector("#mana-orb-detail").textContent = `EXP ${inspected.experience}`;
  const xp = characterExperienceSegments(inspected);
  const xpRail = document.querySelector('.d2-xp-rail');
  xpRail.setAttribute('aria-valuenow', String(Math.round(xp.percent)));
  xpRail.title = xp.isMaxLevel ? 'EXP MAX' : `EXP ${Math.round(xp.percent)}% · ${xp.filledSegments}/10 pól · ${xp.currentExp}/${xp.expRequiredForNextLevel}`;
  document.querySelector('#hud-xp-label').textContent = xp.isMaxLevel ? 'EXP MAX' : `EXP ${Math.round(xp.percent)}%`;
  document.querySelector('#hud-xp-fill').style.width = `${xp.percent}%`;

  const belt = belts.get(inspected.id) ?? [];
  const canUseSelectedBelt = campaignBattleAvailable() && inspected.lifeState === "alive"
    && inspected.resources.hp > 0
    && battlePreparation.phase !== BATTLE_PHASE.COMPLETED
    && (battlePreparation.phase === BATTLE_PHASE.PREPARATION
      ? inspected.id === actingUnitId
      : actor?.id === inspected.id && combat.canAct(inspected.id));
  const beltHost = document.querySelector('#hud-belt');
  let extraRows = beltHost.querySelector('.belt-extra-rows');
  if (!extraRows) {
    extraRows = make('div', 'belt-extra-rows');
    extraRows.setAttribute('aria-label', 'Dodatkowe rzędy pasa');
    beltHost.append(extraRows);
  }
  if (beltHost.dataset.rows !== String(belt.length / 4)) {
    extraRows.replaceChildren();
    for (let index = BELT_SLOT_COUNT; index < belt.length; index += 1) {
    const button = make('button', 'd2-belt-slot');
    button.type = 'button'; button.dataset.beltIndex = String(index);
    button.id = `hud-belt-slot-${index + 1}`;
    button.style.gridRow = String(Math.floor(belt.length / 4) - Math.floor(index / 4));
    button.style.gridColumn = String(index % 4 + 1);
    button.innerHTML = `<i></i><b id="hud-belt-count-${index + 1}"></b><small id="hud-belt-name-${index + 1}"></small>`;
      extraRows.append(button);
    }
  }
  beltHost.dataset.rows = String(belt.length / 4);
  for (let index = 0; index < belt.length; index += 1) {
    const slot = belt[index] ?? null;
    const button = document.querySelector(`#hud-belt-slot-${index + 1}`);
    const count = document.querySelector(`#hud-belt-count-${index + 1}`);
    const name = document.querySelector(`#hud-belt-name-${index + 1}`);
    if (!button || !count || !name) continue;
    const amount = beltSlotCount(slot);
    const filled = amount > 0 && Boolean(potionIconId(slot));
    const iconId = filled ? potionIconId(slot) : null;
    const oldArt = button.querySelector(".d2-belt-item-art");
    if (!iconId) oldArt?.remove();
    else {
      const art = oldArt ?? document.createElement("img");
      art.className = "d2-belt-item-art";
      art.alt = "";
      art.setAttribute("aria-hidden", "true");
      art.src = `/app/assets/items/${iconId}.png`;
      if (!oldArt) button.append(art);
    }
    button.dataset.filled = String(filled);
    button.querySelector("i").textContent = beltGlyph(slot);
    count.textContent = filled && amount > 1 ? `×${amount}` : "";
    name.textContent = filled ? slot.name : "Puste";
    button.title = filled ? `${slot.name} · ${potionKind(slot) === 'health' ? 'Przywraca 8 punktów zdrowia' : 'Przywraca 8 punktów many'} · kolumna ${index % 4 + 1}, rząd ${Math.floor(index / 4) + 1}` : `Puste miejsce pasa ${index + 1}`;
    button.setAttribute("aria-label", button.title);
    button.disabled = !filled || !canUseSelectedBelt;
  }
}

function useHudBeltSlot(index) {
  const inspected = inspectedCharacter();
  const actor = actingCharacter();
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE && actor?.id !== inspected.id) {
    showToast(`${inspected.name} nie ma teraz okna działania. Pas należy do wybranej postaci i nie zostanie użyty przez ${actor?.name ?? "inną jednostkę"}.`, "warning");
    return true;
  }
  return useBeltSlot(index);
}

function render() {
  syncMusicScene();
  syncCampScene();
  if (enemy.hp <= 0) {
    enemy = battleMonsters().find(unit=>unit.hp > 0) ?? enemy;
    enemyAi = enemyAiById[enemy.id] ?? enemyAi;
  }
  const inspected = inspectedCharacter();
  const actor = actingCharacter();
  renderParty();
  renderLog();
  renderQueue();
  renderCards();
  renderPreparationStatus();
  const preparing = battlePreparation.phase === BATTLE_PHASE.PREPARATION;
  const activeCombat = battlePreparation.phase === BATTLE_PHASE.ACTIVE;
  const completed = battlePreparation.phase === BATTLE_PHASE.COMPLETED;
  const battleState = document.querySelector(".battle-state");
  battleState.dataset.battlePhase = battlePreparation.phase;
  document.body.dataset.battlePhase = battlePreparation.phase;
  document.body.dataset.enemyTurnsEnabled = String(battlePreparation.enemyTurnsEnabled);
  document.querySelector("#phase-label").textContent = preparing ? "PRZYGOTOWANIE" : activeCombat ? "WALKA AKTYWNA" : "STARCIE ZAKOŃCZONE";
  document.querySelector("#command-mode").textContent = preparing ? "AI UŚPIONE" : activeCombat ? "KOLEJKA AKTYWNA" : "KONIEC";
  document.querySelector("#start-battle").classList.toggle("hidden", !preparing);
  document.querySelector(".deployment-legend").classList.toggle("hidden", !preparing);
  document.querySelector("#party-size").textContent = `${party.slots.length} / 3`;
  document.querySelector("#sim-time").textContent = `${formatSeconds(combat.scheduler.time)} s`;
  document.querySelector("#active-name").textContent = `${inspected.name} · ${classNames[inspected.classId]}`;
  const progression = characterProgressionView(inspected);
  document.querySelector("#active-resource").textContent = `Poziom ${inspected.level} · Życie ${inspected.resources.hp}/${inspected.resources.maxHp} · Mana ${formatMana(inspected.resources.mana)}/${formatMana(inspected.resources.maxMana)} · EXP ${inspected.experience}${progression.isMaxLevel ? ' · MAX' : ` / ${progression.nextLevelExperience}`} · Punkty ${inspected.unspentStatPoints} / ${inspected.unspentSkillPoints}`;
  renderD2HudResources();
  document.querySelector("#acting-caption").textContent = preparing ? "PRZYGOTOWUJESZ" : completed ? "WYNIK STARCIA" : "ROZKAZY WYKONUJE";
  document.querySelector("#acting-summary").textContent = actor ? `${actor.name} · ${classNames[actor.classId]}` : "BRAK JEDNOSTKI NA POLU";
  document.querySelector("#acting-name").textContent = actor?.name ?? "—";
  document.querySelector("#inspected-name-side").textContent = inspected.name;
  document.querySelector("#mechanical-permission").textContent = completed
    ? "Starcie zakończone. Łup i wynik zostały rozliczone."
    : preparing
    ? "Wybierz bohatera, ustaw go w zielonej strefie i przygotuj aurę, okrzyk lub summon."
    : actor?.id === inspected.id
      ? "Aktywna postać wykonuje kolejkę — użycie skilla kosztuje działanie; samo przełączenie LPM/PPM jest bez kosztu."
      : `Oglądasz ${inspected.name}, ale polecenia wykonuje ${actor?.name ?? "nikt"}. LPM/PPM wybranej postaci można zmienić bez kosztu.`;
  document.querySelector("#phase-detail").textContent = preparing
    ? "Wrogowie nie wykonują tur i nie widzą drużyny"
    : completed ? "Przeciwnik pokonany — starcie zakończone"
      : battleAnimationBusy ? 'Odtwarzanie zatwierdzonej akcji'
      : actor ? `${actor.name} wybiera umiejętność` : "Oczekiwanie na następne legalne okno gotowości";
  const turnGuide = document.querySelector('#battle-turn-guide');
  const showTurnGuide = campaignBattleAvailable() && !completed;
  turnGuide.classList.toggle('hidden', !showTurnGuide);
  if (showTurnGuide) {
    const binding = actor ? mouseSkills.get(actor.id) : null;
    const left = binding ? skillDefinitions[binding.left]?.name ?? 'Brak' : 'Brak';
    const right = binding ? skillDefinitions[binding.right]?.name ?? 'Brak' : 'Brak';
    document.querySelector('#battle-guide-hero').textContent = preparing
      ? `PRZYGOTOWANIE · ${actor?.name ?? 'DRUŻYNA'}` : `TURA · ${actor?.name ?? 'OCZEKIWANIE'}`;
    document.querySelector('#battle-guide-copy').textContent = battleAnimationBusy
      ? 'Trwa ruch lub cios. Następne polecenie po zakończeniu animacji.' : preparing
      ? 'Kliknij bohatera i zielony heks. Potem rozpocznij starcie u góry po prawej.'
      : 'Wybierz portret dowolnego żywego bohatera, potem kliknij niebieski heks lub cel.';
    document.querySelector('#battle-guide-skills').textContent = `LPM: ${left} · PPM: ${right}`;
  }
  const activePortrait = document.querySelector("#active-portrait");
  const activePortraitFallback = document.querySelector("#active-portrait-fallback");
  const activeSpriteKey = spriteKeyForCharacter(inspected);
  const activePortraitSource = canonicalHeroPortraitPath(inspected.classId);
  if (activePortraitSource && activePortrait.getAttribute("src") !== activePortraitSource) activePortrait.src = activePortraitSource;
  else if (!activePortraitSource) activePortrait.removeAttribute("src");
  const showActiveSprite = Boolean(spriteUsable.get(activeSpriteKey));
  activePortrait.hidden = !showActiveSprite;
  activePortraitFallback.hidden = showActiveSprite;
  activePortraitFallback.textContent = inspected.name[0];
  activePortraitFallback.style.color = classAccents[inspected.classId];
  activePortrait.onerror = () => {
    activePortrait.hidden = true;
    activePortraitFallback.hidden = false;
  };
  activePortrait.onload = () => {
    const usable = hasTransparentCorners(activePortrait);
    activePortrait.hidden = !usable;
    activePortraitFallback.hidden = usable;
  };
  document.querySelector("#enemy-hp").textContent = enemy.hp > 0 ? `${enemy.hp} / ${enemy.maxHp}` : "POKONANY";
  document.querySelector("#enemy-name").textContent = enemy.name.toUpperCase();
  document.querySelector("#enemy-hp-bar").style.width = `${100 * enemy.hp / enemy.maxHp}%`;
  document.querySelector(".enemy-plate").classList.toggle("defeated", enemy.hp <= 0);
  renderEncounterControls();
  document.querySelector("#players-badge")?.remove();
  document.querySelector("#queue-state").textContent = preparing ? "AI UŚPIONE" : completed ? "ZAKOŃCZONE" : actor && combat.canAct(actor.id) ? "GOTOWY" : "OCZEKIWANIE";
  const nextEvent = combat.timelinePreview(1)[0];
  const nextEventCopy = nextEvent
    ? `${nextEvent.kind === "move:step" ? "Następny krok" : nextEvent.kind === "projectile:step" ? "Lot pocisku" : nextEvent.kind === "attack:impact" || nextEvent.kind === "projectile:impact" ? "Nadchodzi trafienie" : "Następna gotowość"}: T=${formatSeconds(nextEvent.at)}`
    : `Czekanie: +${formatSeconds(ACTION_TIME.wait)} s`;
  const targetedSkill = skillDefinitions[pendingSkillId];
  let attackTargetingCopy = targetedSkill
    ? `${targetedSkill.name}: zasięg ${targetedSkill.range} · trafienie +${formatSeconds(ATTACK_IMPACT_OFFSET)} s`
    : `Trafienie: +${formatSeconds(ATTACK_IMPACT_OFFSET)} s · gotowość +${formatSeconds(ACTION_TIME.attack)} s`;
  if (actor && targetedSkill?.range > 1 && enemy.hp > 0) {
    const previewEnemy=livingMonsterAt(hoveredHex) ?? enemy;
    const impactHex = hexGrid.positionOf(previewEnemy.id);
    const distance = hexDistance(hexGrid.positionOf(actor.id), impactHex);
    attackTargetingCopy = `Pocisk: ${distance} heks. × ${formatSeconds(PROJECTILE_HEX_TIME)} s = +${formatSeconds(distance * PROJECTILE_HEX_TIME)} s · gotowość +${formatSeconds(ACTION_TIME.attack)} s`;
  }
  document.querySelector("#queue-preview").textContent = completed
    ? "Walka została rozstrzygnięta — kolejka nie przyjmuje dalszych rozkazów"
    : preparing && !pendingTarget
    ? "Przygotowanie nie przesuwa zegara walki"
    : pendingTarget === "move" && hoveredHex && movementChoices.has(hexKey(hoveredHex))
    ? `Trasa: ${movementChoices.get(hexKey(hoveredHex)).cost} pól · +${formatSeconds(movementChoices.get(hexKey(hoveredHex)).cost * ACTION_TIME.movePerTile)} s`
    : pendingTarget === "portal" ? `Otwarcie: +${formatSeconds(ACTION_TIME.portalOpen)} s`
      : pendingTarget === "skill" ? attackTargetingCopy
        : nextEventCopy;
  if (campaign) {
    const area = act1Area(campaign.act1.currentAreaId);
    document.body.dataset.campaignArea = area.id;
    document.querySelector('.location-block > strong').textContent=area.label.toUpperCase();
    document.querySelector('.enemy-plate').classList.toggle('hidden', !campaignBattleAvailable());
    if (!campaignBattleAvailable()) {
      document.body.dataset.enemyTurnsEnabled = 'false';
      document.querySelector('#phase-label').textContent = area.profile === 'camp' ? 'OBOZOWISKO' : 'EKSPLORACJA';
      document.querySelector('#command-mode').textContent = 'SPOKÓJ';
      document.querySelector('#phase-detail').textContent = `${area.label} · wybierz mapę lub dziennik zadań`;
      document.querySelector('#start-battle').classList.add('hidden');
      document.querySelector('.deployment-legend').classList.add('hidden');
      document.querySelector('#mechanical-permission').textContent = 'Bezpieczny odpoczynek poza walką. Leczenie wyłącznie przez usługę Akary.';
    }
  }
  drawScene();
}

function partySelectionGraph(selectedIds) {
  const nextParty = new Party(roster, selectedIds);
  assignInitialPartyPositions(selectedIds);
  let nextPreparation = newPreparationState(selectedIds);
  const nextPortals = PortalSystem.fromJSON(portalSystem.toJSON());
  for (const portal of nextPortals.listActivePortals()) nextPortals.closePortal(portal.portal_id, "camp_party_change");
  const currentConfig = campaignEncounter();
  let nextCombat;
  let nextEnemy;
  let nextEnemyAiById;
  let nextGrid;

  if (currentConfig) {
    const ledger = campaign.act1.encounters[currentConfig.id];
    if (ledger.status !== "completed") throw new Error("Skład można zmienić dopiero po zakończeniu starcia");
    const prepSnapshot = nextPreparation.snapshot();
    prepSnapshot.encounterNumber = ACT1_ENCOUNTERS.indexOf(currentConfig) + 2;
    nextPreparation = BattlePreparationState.restore(prepSnapshot,
      { deploymentColumnOf: deploymentColumnForMode("approved-v3") });
    nextPreparation.startBattle();
    nextPreparation.completeBattle({ survivingSummonIds: [] });
    nextCombat = new CombatState({
      party: nextParty,
      playersSetting: players,
      seed: combat.seed,
      battleId: currentConfig.id,
      encounterId: currentConfig.id,
    });
    nextEnemyAiById = {};
    for (const entry of currentConfig.monsters) {
      const previousUnit = combat.units.get(entry.id);
      if (!previousUnit || previousUnit.kind !== "monster" || previousUnit.hp !== 0 || previousUnit.rewardsGranted !== true) {
        throw new Error(`Brak rozliczonego przeciwnika poprzedniego starcia: ${entry.id}`);
      }
      nextCombat.units.set(entry.id, structuredClone(previousUnit));
      nextCombat.readinessSequence = Math.max(nextCombat.readinessSequence, previousUnit.readySequence + 1);
      nextEnemyAiById[entry.id] = { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null };
    }
    nextEnemy = nextCombat.units.get(currentConfig.monsters[0].id);
    nextGrid = createHexGrid(
      selectedIds.map((id) => ({ id, position: initialPositions.get(id), footprint: SINGLE_HEX_FOOTPRINT })),
      { rosterRef: roster, partyRef: nextParty, enemyRef: nextEnemy },
    );
    for (const id of selectedIds) {
      nextCombat.units.get(id).position = nextGrid.positionOf(id);
      nextPortals.setCharacterLocation(id, {
        kind: "area",
        area_id: currentConfig.areaId,
        instance_id: currentConfig.id,
        hex: nextGrid.positionOf(id),
      });
    }
  } else {
    nextCombat = new CombatState({ party: nextParty, playersSetting: players, seed: combat.seed });
    nextEnemy = nextCombat.spawnMonster({
      id: "fallen-1",
      name: "Upadły",
      baseHp: 42,
      baseExperience: 24,
      position: axial(7, 3),
    });
    nextEnemyAiById = { [nextEnemy.id]: { profileId: AI_PROFILE_IDS.MELEE_PRESSURE, currentTargetId: null } };
    initialPositions.set(nextEnemy.id, oddColumnOffsetToAxial(10, 3));
    nextGrid = createHexGrid(null, { rosterRef: roster, partyRef: nextParty, enemyRef: nextEnemy });
    for (const id of selectedIds) {
      nextCombat.units.get(id).position = nextGrid.positionOf(id);
      nextPortals.setCharacterLocation(id, {
        kind: "area",
        area_id: AREA_ID,
        instance_id: INSTANCE_ID,
        hex: nextGrid.positionOf(id),
      });
    }
    nextEnemy.position = nextGrid.positionOf(nextEnemy.id);
  }

  nextCombat.scheduler.advanceTo(combat.scheduler.time);
  nextCombat.scheduler.sequence = Math.max(nextCombat.scheduler.sequence, combat.scheduler.sequence);
  nextCombat.commandSequence = Math.max(nextCombat.commandSequence, combat.commandSequence);
  nextCombat.transactionSequence = Math.max(nextCombat.transactionSequence, combat.transactionSequence);
  nextCombat.log = [...combat.log, `Obozowisko: aktywna drużyna — ${selectedIds.map((id) => roster.get(id).name).join(", ")}.`];
  return { nextParty, nextPreparation, nextPortals, nextCombat, nextEnemy, nextEnemyAiById, nextGrid };
}

function applyCampPartySelection(selectedIds, { creation = null } = {}) {
  if (!isSafeCamp()) throw new Error("Skład drużyny można zmienić wyłącznie w bezpiecznym Obozowisku Łotrzyc");
  if (!Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > 3
    || new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("Wybierz od jednej do trzech różnych postaci");
  }
  for (const id of selectedIds) {
    const character = roster.get(id);
    if (character.lifeState !== "alive" || character.resources.hp <= 0) throw new Error(`${character.name} nie może teraz dołączyć do aktywnej drużyny`);
  }
  const previous = captureLiveSession();
  try {
    const graph = partySelectionGraph(selectedIds);
    const candidate = buildSaveSnapshot();
    if (creation) {
      candidate.creationProfile = normalizeCreationProfile(creation.profile);
      for (const hero of candidate.roster) {
        if (Object.hasOwn(creation.names, hero.id)) hero.name = creation.names[hero.id];
      }
    }
    candidate.partyIds = [...selectedIds];
    candidate.combat = graph.nextCombat.snapshot();
    candidate.battlePreparation = graph.nextPreparation.snapshot();
    candidate.activeAuras = buildActiveAuraSnapshot({
      heroIds: roster.toJSON().map(({ id }) => id),
      buffs: graph.nextPreparation.listBuffs(),
      catalog: mouseSkillCatalog,
    });
    candidate.hexGrid = graph.nextGrid.snapshot();
    candidate.hexUnits = candidate.hexGrid.units.map(({ id, position, footprint }) => ({ id, position, footprint }));
    candidate.portals = graph.nextPortals.toJSON();
    candidate.pendingReturns = [];
    candidate.actingUnitId = graph.nextPreparation.phase === BATTLE_PHASE.PREPARATION ? selectedIds[0] : null;
    candidate.inspectedCharacterId = selectedIds[0];
    candidate.enemyAiById = graph.nextEnemyAiById;
    candidate.enemyAi = graph.nextEnemyAiById[graph.nextEnemy.id];
    candidate.selectedEnemyId = graph.nextEnemy.id;
    if (battlefieldGeometryMode === "legacy-187") {
      relocateLegacyDropHexes(candidate.encounterProgress.drops, graph.nextGrid);
    }
    if (battlefieldGeometryMode === "legacy-187" && candidate.campaign) {
      for (const encounter of Object.values(candidate.campaign.act1.encounters)) {
        relocateLegacyDropHexes(encounter.drops, graph.nextGrid);
      }
      candidate.loot = visibleLootMarker(CampaignState.restoreAct1(candidate.campaign,
        { catalog: equipmentCatalog }));
    }
    const staged = stageGameState(validateSaveEnvelope(candidate));
    if (creation) beginCampTradingSession(staged);
    installLiveSession(staged);
    assignInitialPartyPositions(selectedIds);
    publishSaveSnapshot(buildSaveSnapshot());
    clearTargeting(false);
    render();
    return true;
  } catch (error) {
    installLiveSession(previous);
    assignInitialPartyPositions(previous.party.slots);
    render();
    throw error;
  }
}

function renderTeamSelection() {
  const selected = new Set(teamSelectionIds);
  teamSelectionGrid.replaceChildren(...STARTER_ROSTER_DEFINITIONS.map((definition) => {
    const character = roster.get(definition.id);
    const available = character.lifeState === "alive" && character.resources.hp > 0;
    const button = make("button", "team-selection-card");
    button.type = "button";
    button.dataset.heroId = definition.id;
    button.style.setProperty("--team-accent", classAccents[definition.classId]);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(selected.has(definition.id)));
    button.setAttribute("aria-pressed", String(selected.has(definition.id)));
    button.classList.toggle("selected", selected.has(definition.id));
    button.disabled = !available;
    const portrait = make("img", "team-selection-portrait");
    portrait.src = canonicalHeroPortraitPath(character.classId);
    portrait.alt = `${definition.name}, ${classNames[definition.classId]}`;
    portrait.draggable = false;
    const fallback = make("span", "team-card-fallback", definition.name[0]);
    const copy = make("span", "team-card-copy");
    const inventoryWeapon = inventories.get(definition.id)?.toJSON().items.find((item) =>
      equipmentCatalog.get(item.canonicalId)?.kind === "weapon");
    const weapon = character.equipment?.weapon ?? inventoryWeapon;
    const weaponName = weapon ? equipmentCatalog.get(weapon.canonicalId)?.displayName ?? weapon.name : "bez broni";
    const assigned = mouseSkills?.get(character.id) ?? definition.loadout;
    const leftSkillName = skillDefinitions[assigned.left]?.name ?? "atak";
    const rightSkillId = typeof assigned.right === "string" ? assigned.right : assigned.right[0];
    const rightSkillName = skillDefinitions[rightSkillId]?.name ?? "zdolność";
    const knownSkills = mouseSkills?.knownSkills(character.id) ?? [];
    const previewSkillId = (definition.classId === "warlock"
      ? definition.loadout.right
      : [definition.attackProfile.skillId, ...definition.loadout.right])
      .find((skillId) => knownSkills.includes(skillId) && skillDefinitions[skillId]);
    const previewSkillName = previewSkillId ? skillDefinitions[previewSkillId].name : leftSkillName;
    copy.append(make("strong", "team-card-name", definition.name));
    copy.append(make("small", "team-card-class", `${classNames[definition.classId]} · ${available ? definition.role : "postać poległa"}`));
    copy.append(make("small", "team-card-kit", `Broń: ${weaponName} · Zdolność: ${previewSkillName}`));
    button.title = `${definition.name}, ${classNames[definition.classId]}. ${definition.role}. Broń: ${weaponName}. Dostępna zdolność: ${previewSkillName}. Obecne przypisanie LPM: ${leftSkillName}, PPM: ${rightSkillName}.`;
    button.append(portrait, fallback, copy);
    button.addEventListener("click", () => {
      const index = teamSelectionIds.indexOf(definition.id);
      if (index >= 0) teamSelectionIds.splice(index, 1);
      else if (teamSelectionIds.length < 3) teamSelectionIds.push(definition.id);
      else document.querySelector("#team-selection-status").textContent = "Najpierw usuń jedną z trzech wybranych postaci.";
      renderTeamSelection();
    });
    return button;
  }));
  for (let index = 0; index < 3; index += 1) {
    const host = document.querySelector(`#team-slot-${index + 1}`);
    const character = teamSelectionIds[index] ? roster.get(teamSelectionIds[index]) : null;
    host.querySelector("strong").textContent = character ? `${character.name} · ${classNames[character.classId]}` : "Wolne miejsce";
  }
  const complete = teamSelectionIds.length >= 1 && teamSelectionIds.length <= 3;
  document.querySelector("#team-selection-confirm").disabled = !complete;
  document.querySelector("#team-selection-status").textContent = complete
    ? `Gotowi: ${teamSelectionIds.map((id) => roster.get(id).name).join(", ")}.`
    : "Wybierz od jednej do trzech postaci.";
  document.querySelector(".team-selection-rule b").textContent = `${teamSelectionIds.length} / 8`;
}

function openTeamSelection({ mandatory = false } = {}) {
  if (!isSafeCamp()) {
    showToast("Drużynę można zmienić wyłącznie w bezpiecznym obozie.", "warning");
    return false;
  }
  teamSelectionMandatory = mandatory;
  teamSelectionIds = [...party.slots];
  document.querySelector("#team-selection-cancel").hidden = mandatory;
  renderTeamSelection();
  teamSelectionBackgroundState = { inert: gameShell.inert, ariaHidden: gameShell.getAttribute("aria-hidden") };
  gameShell.inert = true;
  gameShell.setAttribute("aria-hidden", "true");
  teamSelectionLayer.classList.remove("hidden");
  teamSelectionLayer.setAttribute("aria-hidden", "false");
  teamSelectionGrid.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
  return true;
}

function closeTeamSelection() {
  if (teamSelectionMandatory) return false;
  teamSelectionLayer.classList.add("hidden");
  teamSelectionLayer.setAttribute("aria-hidden", "true");
  if (teamSelectionBackgroundState) {
    gameShell.inert = teamSelectionBackgroundState.inert;
    if (teamSelectionBackgroundState.ariaHidden === null) gameShell.removeAttribute("aria-hidden");
    else gameShell.setAttribute("aria-hidden", teamSelectionBackgroundState.ariaHidden);
  }
  teamSelectionBackgroundState = null;
  document.querySelector("#camp-open-team")?.focus({ preventScroll: true });
  return true;
}

function confirmTeamSelection() {
  try {
    applyCampPartySelection([...teamSelectionIds]);
    teamSelectionMandatory = false;
    closeTeamSelection();
    showToast("Skład aktywnej drużyny zapisano.", "success");
    return true;
  } catch (error) {
    document.querySelector("#team-selection-status").textContent = error.message;
    return false;
  }
}

function completePlayerAction(kind, payload = {}, options = {}) {
  if (battleAnimationBusy) return false;
  if (!campaignBattleAvailable()) throw new Error('W tej lokacji nie trwa starcie. Otwórz mapę.');
  if (isPaused() || (activePanel && options.allowPanel !== activePanel)) {
    throw new Error("Polecenie bojowe jest zablokowane przez pauzę lub otwarty panel");
  }
  const actorId = options.actorId ?? actingUnitId;
  if (!actorId) return false;
  const actor = roster.get(actorId);
  if (actorId !== actingUnitId || !combat.canAct(actorId)) {
    throw new Error(`${actorId} nie jest jednostką w autorytatywnym oknie gotowości`);
  }
  if (actor.resources.hp <= 0 || !characterOnBattlefield(actorId)) {
    combat.log.push(`${actor.name} nie może wykonać tego polecenia.`);
    render();
    return false;
  }
  let walkCommand = null;
  commitActiveTurn(() => {
    if (kind === "move") {
      const movement = submitMovement(actorId, payload.path, { groupPortal: payload.groupPortal === true });
      if (movement.interrupted) showToast(`Ruch przerwany: ${movement.error.message}`, "warning");
      else if (heroWalkAnimationAvailable(actorId)) walkCommand = movement;
    } else if (kind === "attack") {
      submitDelayedAttack(actorId, payload);
    } else if (kind === "approachAttack") {
      const combined = submitApproachAttack(actorId, payload.path, payload);
      if (combined.interrupted) showToast(`Podejście do ataku przerwane: ${combined.error.message}`, "warning");
    } else {
      const resolver = options.resolve;
      combat.submitAction(actorId, kind, payload, resolver ? { resolve: resolver } : {});
    }
  });
  if (walkCommand?.commandId) {
    prioritizedBarbarianWalk = {commandId:walkCommand.commandId,actorId,recoveryEnd:walkCommand.recoveryEnd};
    deferredWalkReadiness.clear();
  }
  clearTargeting(false);
  if (options.drive !== false) driveTimeline(actorId);
  render();
  return true;
}

function clearTargeting(shouldRender = true) {
  if (!pendingTarget) return false;
  pendingTarget = null;
  pendingTargetActorId = null;
  pendingSkillId = null;
  pendingSkillSide = null;
  pendingSkillUseCommitted = false;
  hoveredHex = null;
  primaryHoverPlan = null;
  movementChoices = new Map();
  portalChoices = new Set();
  document.querySelector("#targeting-banner").classList.add("hidden");
  canvas.dataset.keyboardHex = "";
  canvas.setAttribute("aria-label", "Taktyczne pole walki na siatce heksagonalnej");
  if (shouldRender) render();
  return true;
}

function beginTargeting(kind, skillId = null, { skillUseCommitted = false, side = null } = {}) {
  if (battleAnimationBusy) return false;
  if (!campaignBattleAvailable()) return false;
  if (kind === 'skill' && !runtimeSkillStatus(skillId).supported) {
    showToast(runtimeSkillStatus(skillId).label, 'warning'); return false;
  }
  if (kind === "portal" && battlePreparation.phase !== BATTLE_PHASE.ACTIVE) {
    showToast("Miejski Portal jest dostępny po rozpoczęciu walki.", "warning");
    return false;
  }
  const actor = actingCharacter();
  if (!actor || !characterOnBattlefield(actor.id)) return false;
  closeMouseSkillChooser();
  closePanel();
  pendingTarget = kind;
  pendingTargetActorId = actor.id;
  pendingSkillId = kind === "skill" ? skillId : null;
  pendingSkillSide = kind === "skill" ? side : null;
  pendingSkillUseCommitted = kind === "skill" && skillUseCommitted;
  hoveredHex = null;
  primaryHoverPlan = null;
  movementChoices = new Map();
  portalChoices = new Set();
  if (kind === "move") {
    movementChoices = new Map(hexGrid.reachable(actor.id, 3)
      .filter(({ cost }) => cost > 0)
      .map((choice) => [hexKey(choice.position), choice]));
  }
  if (kind === "portal") {
    for (const neighbor of hexNeighbors(hexGrid.positionOf(actor.id))) {
      if (hexGrid.has(neighbor) && !hexGrid.isBlocked(neighbor)) portalChoices.add(hexKey(neighbor));
    }
  }
  const skill = skillDefinitions[pendingSkillId];
  const copy = kind === "move"
    ? battlePreparation.phase === BATTLE_PHASE.PREPARATION
      ? "ZIELONE HEKSY: darmowe ustawienie. Wyjście poza 3 kolumny NATYCHMIAST rozpoczyna walkę."
      : "NIEBIESKIE HEKSY SĄ OSIĄGALNE — najedź, aby zobaczyć trasę i koszt."
    : kind === "skill"
      ? `${skill?.name ?? "Umiejętność"}: ZASIĘG ${skill?.range ?? 1}. Sąsiedni cel wręcz jest legalny przy dystansie 1.`
      : "FIOLETOWE POLA SĄ LEGALNE. Zwój zostanie zużyty dopiero po zatwierdzeniu pola.";
  document.querySelector("#targeting-title").textContent = kind === "move" ? "WYBIERZ HEKS RUCHU" : kind === "skill" ? "WYBIERZ CEL" : "WYBIERZ HEKS";
  document.querySelector("#targeting-copy").textContent = copy;
  document.querySelector("#targeting-banner").classList.remove("hidden");
  canvas.setAttribute("aria-label", `${document.querySelector("#targeting-title").textContent}. ${copy} Użyj strzałek lub W A S D, zatwierdź Enterem albo spacją.`);
  render();
  canvas.focus({ preventScroll: true });
  return true;
}

function attackSelectedHex(hex) {
  if (!campaignBattleAvailable()) return;
  const targetedSkill = skillDefinitions[pendingSkillId];
  if (targetedSkill?.id === RAISE_SKELETON_SKILL_ID) {
    const corpse = corpseAtHex(hex);
    if (!corpse) {
      showToast("Raise Skeleton: wskaż dostępne zwłoki.", "warning");
      return;
    }
    useSupportSkill(targetedSkill, { targetHex: hex });
    return;
  }
  const targetEnemy = livingMonsterAt(hex);
  if (!targetEnemy) {
    showToast("To pole nie zawiera wskazanego przeciwnika.", "warning");
    return;
  }
  const actor = actingCharacter();
  const skill = skillDefinitions[pendingSkillId];
  if (!skill || !isOffensiveSkill(skill)) {
    showToast("Wybrana karta nie jest ofensywną umiejętnością.", "warning");
    return;
  }
  const profile = currentAttackProfile(actor, skill);
  if (profile?.error) { showToast(profile.error, "warning"); return; }
  const manaState = skillManaState(actor, skill.id);
  if (!manaState.affordable) {
    showToast(`${skill.name}: za mało many — potrzeba ${formatMana(manaState.requiredToCast)}, masz ${formatMana(manaState.currentMana)}.`, "warning");
    return;
  }
  const skillExecution = createSkillExecution({ character: actor, skill,
    skillLevel: runtimeSkillLevel(actor, skill.id), side: pendingSkillSide, profile });
  validateHeroAttackExecution(actor.id, { skillId: skill.id, skillExecution });
  const targetId = targetEnemy.id;
  const distance = Math.min(...hexGrid.occupiedHexes(targetId).map((occupied) => hexDistance(hexGrid.positionOf(actor.id), occupied)));
  let approachPlan = null;
  if (distance > skill.range) {
    // v0.5.6: Diablo-style primary click for melee. One click on an enemy may
    // become ONE authoritative command containing movement + the final hit.
    // Keep the existing three-cost movement envelope: if no legal attack hex
    // is reachable inside it, do not move the hero behind the player's back.
    if (skill.range === 1) {
      approachPlan = planApproachAttack({
        grid: hexGrid,
        actorId: actor.id,
        targetId,
        range: skill.range,
        maxMoveCost: 3,
        requireLineOfSight: true,
      });
    }
    if (!approachPlan || approachPlan.type !== "approach") {
      document.querySelector("#targeting-title").textContent = "CEL POZA ZASIĘGIEM";
      document.querySelector("#targeting-copy").textContent = skill.range === 1
        ? `${skill.name}: nie ma legalnej pozycji ataku osiągalnej w limicie ruchu 3. Kliknij bliższy pusty heks albo wybierz innego bohatera.`
        : `${skill.name}: dystans ${distance}, wymagany zasięg ${skill.range}. Podejdź bliżej albo wybierz inny skill.`;
      showToast(`CEL POZA ZASIĘGIEM — ${distance}/${skill.range}.`, "warning");
      return;
    }
  }
  if (!approachPlan) {
    const from = hexGrid.positionOf(actor.id);
    const to = hexGrid.positionOf(targetId);
    if (!hexGrid.hasLineOfSight(from, to, { ignoreUnitIds: [actor.id, targetId] })
      || (skill.range > 1 && !hexGrid.hasProjectilePath(from, to, { ignoreUnitIds: [actor.id, targetId] }))) {
      showToast('Brak legalnej linii ataku — polecenie nie zostało wykonane.', 'warning');
      return;
    }
  }
  selectTargetMonsterAt(hex);
  if (!pendingSkillUseCommitted && battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
    const openingActorId = actor.id;
    const activation = battlePreparation.useSkill({ actorId: actor.id, skillId: skill.id, category: skill.category });
    combat.log.push(`${actor.name} potwierdza ofensywny cel dla ${skill.name}; przygotowanie kończy się (${activation.activationReason}).`);
    setOpeningReadinessOrder(openingActorId);
    actingUnitId = null;
    driveTimeline();
    if (actingUnitId !== openingActorId) {
      clearTargeting(false);
      showToast(`${skill.name} rozpoczął walkę. Pierwszą kolej otrzymuje ${actingCharacter()?.name ?? "następna jednostka"}.`, "warning");
      render();
      return;
    }
  } else if (!pendingSkillUseCommitted) {
    battlePreparation.useSkill({ actorId: actor.id, skillId: skill.id, category: skill.category });
  }
  const attackPayload = {
    targetId,
    impactHex: hex,
    skillId: skill.id,
    range: skill.range,
    attackType: skill.range > 1 ? "ranged" : "melee",
    damageProfile: { kind: "basic-weapon", profile },
    dataStatus: skill.status,
    skillExecution,
  };
  if (approachPlan?.type === "approach") {
    combat.log.push(`${actor.name}: ${skill.name} — podejście ${approachPlan.moveSteps} heks. i atak są jednym rozkazem.`);
    completePlayerAction("approachAttack", {
      ...attackPayload,
      path: approachPlan.path,
      approachMoveCost: approachPlan.moveCost,
      approachWorldVersion: approachPlan.worldVersion,
    });
    return;
  }
  completePlayerAction("attack", attackPayload);
}

function buffTargets() {
  return [
    ...party.slots.filter((id) => battlePreparation.isUnitOnField(id)),
    ...battlePreparation.listSummons().map(({ id }) => id),
  ].sort();
}

function corpseAtHex(position) {
  if (!position) return null;
  const id = hexKey(position);
  return combat.corpses.list().find((corpse) => corpse.consumed === false && corpse.hexId === id) ?? null;
}

function applyRaiseSkeletonRuntime(actor, skill, { targetHex = null, corpseId = null } = {}) {
  if (skill.id !== RAISE_SKELETON_SKILL_ID) return null;
  const corpse = corpseId ? combat.corpses.get(corpseId) : corpseAtHex(targetHex);
  if (!corpse) throw new Error("Wskaż dostępne zwłoki na heksie");
  const binding = mouseSkills.get(actor.id);
  const plan = planRaiseSkeleton({
    combat,
    grid: hexGrid,
    preparation: battlePreparation,
    casterId: actor.id,
    skillId: skill.id,
    activePpmSkillId: binding.right === skill.id ? skill.id : null,
    knownSkillIds: knownMouseSkillsForHero(actor.id),
    corpseId: corpse.id,
    corpseHex: targetHex,
    manaCost: skillManaState(actor, skill.id).cost,
    commandId: `raise-skeleton:${combat.battleId}:${combat.commandSequence}`,
    skillLevel: runtimeSkillLevel(actor, skill.id),
    masteryLevel: actor.skills?.["necromancer.skeleton_mastery"]?.effectiveLevel ?? actor.skills?.["necromancer.skeleton_mastery"]?.hardPoints ?? 0,
  });
  const staged = commitRaiseSkeleton({
    combat,
    grid: hexGrid,
    preparation: battlePreparation,
    plan,
    deploymentColumnOf,
    payAction: true,
  });
  const enemyId = enemy.id;
  roster = staged.roster;
  party = staged.party;
  combat.adoptFrom(staged.combat);
  hexGrid = staged.grid;
  battlePreparation = staged.preparation;
  enemy = combat.units.get(enemyId) ?? enemy;
  battlefieldLayoutCache = null;
  combat.log.push(`${actor.name} przyzywa Szkielet z ${corpse.id}; zwłoki zużyte atomowo.`);
  return staged;
}

function applySupportSkill(actor, skill, { targetHex = null } = {}) {
  if (skill.category === SKILL_CATEGORY.BUFF || skill.category === SKILL_CATEGORY.AURA) {
    const aura = skill.category === SKILL_CATEGORY.AURA;
    const id = aura ? `aura:${actor.id}` : `warcry:${actor.id}:${skill.id}`;
    const result = battlePreparation.applyBuff({
      id,
      skillId: skill.id,
      sourceId: actor.id,
      targetIds: buffTargets(),
      ...(aura ? { permanent: true, exclusiveGroup: `aura:${actor.id}` } : {
        baseDurationSeconds: skill.turns * 6,
        permanent: false,
      }),
    });
    combat.log.push(`${actor.name} aktywuje ${skill.name}${aura ? " — aura obejmuje drużynę" : ` na ${result.buff.remainingTurns} kolejek`} [ADAPTATION].`);
    return result;
  }
  if (skill.category === SKILL_CATEGORY.SUMMON) {
    if (skill.id === RAISE_SKELETON_SKILL_ID) return applyRaiseSkeletonRuntime(actor, skill, { targetHex });
    const origin = hexGrid.positionOf(actor.id);
    const legalDestination = (position) => (
      position
      && hexGrid.has(position)
      && hexDistance(origin, position) <= 2
      && !hexGrid.isBlocked(position)
      && (battlePreparation.phase !== BATTLE_PHASE.PREPARATION || battlePreparation.isDeploymentHex(position))
    );
    const destination = targetHex
      ? (legalDestination(targetHex) ? structuredClone(targetHex) : null)
      : hexDisk(origin, 2).find(legalDestination);
    if (!destination) {
      throw new Error(targetHex
        ? "Wskazany heks przywołania jest zajęty, poza zasięgiem 2 albo poza strefą rozstawienia"
        : "Brak wolnego legalnego heksa dla przywołania");
    }
    const sameKindCount = battlePreparation.listSummons({ ownerId: actor.id }).filter(({ kind }) => kind === skill.summonKind).length;
    const summonId = `${actor.id}.${skill.summonKind}.${sameKindCount + 1}`;

    // Publish preparation and grid placement atomically. A failed placement
    // must never leave a summon in only one authoritative spatial model.
    const stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
    const stagedGrid = HexGrid.restore(hexGrid.snapshot());
    const result = stagedPreparation.summonUnit({
      id: summonId,
      ownerId: actor.id,
      kind: skill.summonKind,
      skillId: skill.id,
      persistent: true,
      position: destination,
    });
    stagedGrid.addUnit({ id: summonId, position: destination, footprint: SINGLE_HEX_FOOTPRINT });
    battlePreparation = stagedPreparation;
    hexGrid = stagedGrid;
    battlefieldLayoutCache = null;
    combat.log.push(`${actor.name} przyzywa ${skill.name} na wskazanym heksie; summon ${summonId} pozostaje między walkami [ADAPTATION].`);
    return result;
  }
  throw new Error("Ta umiejętność wymaga wskazania przeciwnika");
}

function useSupportSkill(skill, { targetHex = null } = {}) {
  if (!campaignBattleAvailable()) return false;
  if (!runtimeSkillStatus(skill.id).supported) {
    showToast(runtimeSkillStatus(skill.id).label, 'warning'); return false;
  }
  const actor = actingCharacter();
  if (!actor) return false;
  const manaState = skillManaState(actor, skill.id);
  if (!manaState.affordable) {
    showToast(`${skill.name}: za mało many — potrzeba ${formatMana(manaState.requiredToCast)}, masz ${formatMana(manaState.currentMana)}.`, "warning");
    return false;
  }
  try {
    clearTargeting(false);
    if (skill.id === RAISE_SKELETON_SKILL_ID) {
      if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) throw new Error("Raise Skeleton wymaga aktywnego starcia");
      if (isPaused() || activePanel || !combat.canAct(actor.id) || !characterOnBattlefield(actor.id)) throw new Error("Brak legalnego okna działania Raise Skeleton");
      commitActiveTurn(() => applyRaiseSkeletonRuntime(actor, skill, { targetHex }));
      driveTimeline(actor.id);
      showToast(`${skill.name}: zwłoki zużyte, Szkielet dołączył do kolejki AI.`, "success");
      render();
      return true;
    }
    if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
      const manaBefore = actor.resources.mana;
      try {
        const spent = paySkillMana(actor, skill.id);
        applySupportSkill(actor, skill, { targetHex });
        if (spent.cost > 0) combat.log.push(`${actor.name}: ${skill.name} zużywa ${formatMana(spent.cost)} many (${formatMana(spent.remainingMana)} pozostało).`);
      } catch (error) {
        actor.resources.mana = manaBefore;
        throw error;
      }
      showToast(`${skill.name}: przygotowanie wykonane bez aktywacji przeciwników.`, "success");
      render();
      return true;
    }
    completePlayerAction("cast", { skillId: skill.id, category: skill.category, manaCost: manaState.cost }, {
      resolve: (_event, resolveCore) => {
        const manaBefore = actor.resources.mana;
        try {
          const spent = paySkillMana(actor, skill.id);
          applySupportSkill(actor, skill, { targetHex });
          if (spent.cost > 0) combat.log.push(`${actor.name}: ${skill.name} zużywa ${formatMana(spent.cost)} many (${formatMana(spent.remainingMana)} pozostało).`);
          return resolveCore();
        } catch (error) {
          actor.resources.mana = manaBefore;
          throw error;
        }
      },
    });
    showToast(`${skill.name}: wykorzystano kolejkę ${actor.name}.`, "success");
    render();
    return true;
  } catch (error) {
    showToast(`${skill.name}: ${error.message}`, "warning");
    render();
    return false;
  }
}

function activateSkillCard(skillId) {
  if (!campaignBattleAvailable()) return false;
  const actor = actingCharacter();
  const skill = skillDefinitions[skillId];
  if (!actor || !skill) return false;
  let mode;
  try {
    const source = mouseSkillCatalog.get(skillId);
    mode = skillTargetMode(source, skill);
    if (mode === SkillTarget.CORPSE && !combat.corpses.list().some((corpse) => corpse.consumed === false)) {
      throw new Error("Wymaga dostępnych zwłok");
    }
    if (!knownMouseSkillsForHero(actor.id).includes(skillId) || !skillManaState(actor, skillId).affordable) {
      throw new Error('Umiejętność niedostępna lub za mało many');
    }
  } catch (error) { showToast(error.message, 'warning'); return false; }
  if (mode === SkillTarget.CORPSE) return beginTargeting("skill", skill.id);
  if (!isOffensiveSkill(skill)) return useSupportSkill(skill);
  if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
    // Merely arming a card is not an offensive use. Preparation ends only
    // after the player confirms an enemy hex, so ESC remains a true cancel.
    return beginTargeting("skill", skill.id);
  }
  return beginTargeting("skill", skill.id);
}

function inspectedHeroCanIssueWorldCommand() {
  if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) return true;
  if (!actingUnitId || inspectedCharacterId === actingUnitId) return true;
  const inspected = inspectedCharacter();
  const actor = actingCharacter();
  showToast(`Oglądasz ${inspected.name}, ale teraz działa ${actor?.name ?? "inna jednostka"}. Nie wykonano polecenia inną postacią niż pokazuje HUD.`, "warning");
  return false;
}

function activateBoundMouseSkillAtHex(side, selectedHex) {
  if (!campaignBattleAvailable()) return false;
  if (!inspectedHeroCanIssueWorldCommand()) return false;
  const actor = actingCharacter();
  if (!actor || !characterOnBattlefield(actor.id)) return false;
  const binding = mouseSkills.get(actor.id);
  const skillId = binding[side];
  const skill = skillDefinitions[skillId];
  if (!skill) {
    showToast(`Brak definicji aktywnego skilla ${side === "left" ? "LPM" : "PPM"}.`, "warning");
    return false;
  }
  const sourceRule = mouseSkillCatalog.get(skillId);
  const mode = skillTargetMode(sourceRule, skill);
  // All rejection checks precede beginTargeting: lack of mana cannot change
  // the selected target, preparation phase, movement or recovery budget.
  try {
    if (!mouseSkillCatalog.allows(skillId, side) || !knownMouseSkillsForHero(actor.id).includes(skillId)) {
      throw new Error('Umiejętność nie jest legalna na tym przycisku');
    }
    if (!runtimeSkillStatus(skillId).supported) throw new Error(runtimeSkillStatus(skillId).label);
    if (!skillManaState(actor, skillId).affordable) throw new Error('Za mało many');
    // An offensive mouse tile may be clicked first to arm targeting. Only
    // validate the target once a battlefield hex was actually supplied;
    // support/summon skills still validate their target immediately.
    if (selectedHex || !isOffensiveSkill(skill)) {
      validateSkillTarget(mode, {
        hasHex: Boolean(selectedHex && hexGrid.has(selectedHex)),
        enemy: Boolean(livingMonsterAt(selectedHex)),
        freeGround: Boolean(selectedHex && hexGrid.has(selectedHex) && !hexGrid.isBlocked(selectedHex)),
        corpse: selectedHex ? corpseAtHex(selectedHex) : null,
      });
    }
  } catch (error) {
    showToast(`${skill.name}: ${error.message}`, 'warning');
    return false;
  }
  if (!isOffensiveSkill(skill)) {
    if (mode === SkillTarget.CORPSE) {
      if (!selectedHex) return beginTargeting("skill", skill.id, { side });
      return useSupportSkill(skill, { targetHex: selectedHex });
    }
    if (skill.category === SKILL_CATEGORY.SUMMON) {
      if (!selectedHex) {
        showToast(`${skill.name}: wskaż pusty heks przywołania.`, "warning");
        return false;
      }
      return useSupportSkill(skill, { targetHex: selectedHex });
    }
    return useSupportSkill(skill);
  }
  if (!selectedHex) return beginTargeting("skill", skill.id, { side });
  if (!livingMonsterAt(selectedHex)) {
    showToast(`${skill.name}: wskaż przeciwnika.`, "warning");
    return false;
  }
  if (!beginTargeting("skill", skill.id, { side })) return false;
  selectTargetHex(selectedHex);
  // A direct Diablo-style mouse click is one attempt, not a sticky targeting
  // mode. If the click was rejected (too far, wrong target, etc.), return the
  // battlefield immediately to normal LPM semantics so the next empty-ground
  // click means movement again.
  if (pendingTarget === "skill" && pendingTargetActorId === actor.id) {
    clearTargeting(false);
    render();
  }
  return true;
}

function selectHeroFromBattlefield(heroId) {
  if (!party.isActive(heroId) || !roster.has(heroId)) return false;
  clearTargeting(false);
  closeMouseSkillChooser();
  inspectedCharacterId = heroId;
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE && !battleAnimationBusy
    && combat.currentActorId && combat.units.get(combat.currentActorId)?.kind === 'hero') {
    try {
      combat.chooseHeroForPlayerTurn(heroId, timelineLegalIds());
      actingUnitId = heroId;
    } catch (error) { showToast(error.message, 'warning'); }
  }
  if (battlePreparation.phase === BATTLE_PHASE.PREPARATION
    && roster.get(heroId).lifeState === "alive"
    && roster.get(heroId).resources.hp > 0
    && characterOnBattlefield(heroId)) {
    actingUnitId = heroId;
  }
  render();
  return true;
}

function startBattleExplicitly() {
  if (!campaignBattleAvailable()) return false;
  if (isPaused() || activePanel || battlePreparation.phase !== BATTLE_PHASE.PREPARATION) return false;
  const result = battlePreparation.startBattle();
  combat.log.push(`Starcie rozpoczęte jawnym rozkazem (${result.activationReason}). AI i wspólna kolejka są aktywne.`);
  setOpeningReadinessOrder(actingUnitId ?? party.slots[0]);
  actingUnitId = null;
  driveTimeline();
  render();
  showToast("WALKA ROZPOCZĘTA — przeciwnicy są aktywni.", "warning");
  return true;
}

function cycleLoadoutSkill() {
  if (!campaignBattleAvailable()) return false;
  clearTargeting(false);
  const actor = actingCharacter();
  if (!actor) return false;
  const current = battlePreparation.getLoadout(actor.id);
  const alternate = alternateSkills[actor.classId];
  const defaultSkill = defaultLoadouts[actor.id].right[2];
  const replacement = current.right[2] === alternate ? defaultSkill : alternate;
  if (!replacement) {
    showToast("Ten profil nie ma jeszcze alternatywnej karty.", "warning");
    return false;
  }
  const change = () => battlePreparation.changeSkill({ heroId: actor.id, slot: "right", rightIndex: 2, skillId: replacement });
  try {
    if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
      change();
      combat.log.push(`${actor.name} zmienia PPM 3 na ${skillDefinitions[replacement].name} bez kosztu w przygotowaniu.`);
      render();
    } else {
      completePlayerAction("cast", { skillChange: { slot: "right", rightIndex: 2, skillId: replacement } }, {
        resolve: (_event, resolveCore) => {
          change();
          combat.log.push(`${actor.name} zmienia PPM 3 na ${skillDefinitions[replacement].name}; zużywa kolejkę.`);
          return resolveCore();
        },
      });
    }
    showToast(`PPM 3: ${skillDefinitions[replacement].name}${battlePreparation.phase === BATTLE_PHASE.PREPARATION ? " · bez kosztu" : " · koszt kolejki"}.`, "success");
    return true;
  } catch (error) {
    showToast(`Zmiana loadoutu odrzucona: ${error.message}`, "warning");
    return false;
  }
}

function openPortalAt(hex) {
  if (!campaignBattleAvailable()) return false;
  if (battlePreparation.phase !== BATTLE_PHASE.ACTIVE) {
    clearTargeting(false);
    showToast("Miejski Portal jest dostępny po rozpoczęciu walki.", "warning");
    render();
    return false;
  }
  const actor = actingCharacter();
  if (!actor || !combat.canAct(actor.id)) {
    showToast("Portal można otworzyć tylko w gotowym oknie polecenia właściciela.", "warning");
    return;
  }
  const supply = portalScrolls.get(actor.id);
  try {
    completePlayerAction("portalOpen", { at: hex }, {
      resolve: () => {
        const result = portalSystem.openPortal({
          owner: actor,
          owner_character_id: actor.id,
          acting_character_id: actor.id,
          commandWindow: true,
          actionResolving: false,
          source: {
            area_id: AREA_ID,
            instance_id: INSTANCE_ID,
            world_id: campaign?.act1?.exploration?.worldId,
            sector_id: campaign?.act1?.exploration?.activeBattle?.sectorId
              ?? campaign?.act1?.exploration?.currentSectorId,
            hex,
          },
          destinationTown: TOWN_ID,
          campaignProfile: DATA_PROFILE,
          difficultyProfile: "normal",
          scrollSupply: supply,
          encounterRules,
          hasLivingEnemies: combat.livingEnemyCount() > 0,
          isLegalHex: (candidate) => portalChoices.has(hexKey(candidate)) && !hexGrid.isBlocked(candidate),
        });
        if (!result.ok) throw new Error(result.message);
        combat.log.push(`${actor.name} zużywa 1 zwój i otwiera Miejski Portal na heksie ${hexKey(hex)}.`);
        return result;
      },
    });
  } catch (error) {
    showToast(error.message, "warning");
    render();
  }
}

function submitPortalEntry(actorId, portal, { groupPortal = false } = {}) {
  const actor = roster.get(actorId);
  const stagedPortals = PortalSystem.fromJSON(portalSystem.toJSON());
  const result = stagedPortals.enterTown({
    portal_id: portal.portal_id,
    character_id: actorId,
    character: actor,
    isLastLivingHeroLeaving: nextEligibleIds().length === 1,
    canReachPortal: () => hexDistance(hexGrid.positionOf(actorId), portal.source.hex) <= 1,
  });
  if (!result.ok) throw new Error(result.message);
  const stagedGrid = HexGrid.restore(hexGrid.snapshot());
  if (!stagedGrid.removeUnit(actorId)) throw new Error(`${actor.name} nie zajmuje już pola walki`);
  const stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
  stagedPreparation.withdrawUnit(actorId);
  commitActiveTurn(() => {
    const command = combat.submitAction(actorId, "portalEnter", { portalId: portal.portal_id, groupPortal }, {
      resolve: (_event, resolveCore) => {
        resolveCore();
        return result;
      },
    });
    portalSystem = stagedPortals;
    hexGrid = stagedGrid;
    battlePreparation = stagedPreparation;
    combat.log.push(`${actor.name} dociera do ${TOWN_ID}. Spotkanie ${result.encounterDisposition === "suspend" ? "zostaje zawieszone" : "pozostaje aktywne"}; EXP +0, łup +0.`);
    return command;
  });
  return result;
}

function enterPortal(actorId, portal) {
  const actor = roster.get(actorId);
  if (actorId !== actingUnitId || !combat.canAct(actorId)) {
    showToast("Ta postać nie jest jeszcze gotowa do wejścia w portal.", "warning");
    return false;
  }
  try {
    submitPortalEntry(actorId, portal);
  } catch (error) {
    showToast(error.message, "warning");
    return false;
  }
  inspectedCharacterId = actorId;
  driveTimeline(actorId);
  render();
  openPanel("portal");
  return true;
}

function portalCommand() {
  if (!campaignBattleAvailable()) return true;
  if (isPaused()) return true;
  if (activePanel) {
    showToast("Najpierw zamknij aktywny panel.", "warning");
    return true;
  }
  if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
    showToast("Miejski Portal jest dostępny po rozpoczęciu walki.", "warning");
    return true;
  }
  const inspectedLocation = portalSystem.locationOf(inspectedCharacterId);
  if (inspectedLocation?.kind === "town") {
    openPanel("portal");
    return true;
  }
  if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) {
    openPanel("portal");
    return true;
  }
  const actor = actingCharacter();
  if (!actor) {
    showToast("Żadna jednostka na polu nie oczekuje na polecenie.", "warning");
    return true;
  }
  const portal = portalSystem.getActivePortalForOwner(actor.id);
  if (portal && hexDistance(hexGrid.positionOf(actor.id), portal.source.hex) <= 1) return enterPortal(actor.id, portal);
  if (portalScrolls.get(actor.id).remaining <= 0) {
    showToast("Brak zwoju Miejskiego Portalu.", "warning");
    return true;
  }
  return beginTargeting("portal");
}

function findReturnHex(portal) {
  return hexDisk(portal.source.hex, 2).find((hex) => hexGrid.has(hex) && !hexGrid.isBlocked(hex)) ?? null;
}

function livingTownTravelers(portal) {
  return party.activeCharacters().filter((character) => {
    const location = portalSystem.locationOf(character.id);
    return character.lifeState === "alive"
      && character.resources.hp > 0
      && location?.kind === "town"
      && location.via_portal_id === portal.portal_id;
  });
}

function returnInspectedFromTown() {
  const location = portalSystem.locationOf(inspectedCharacterId);
  if (location?.kind !== "town") return false;
  const portal = portalSystem.getPortal(location.via_portal_id);
  if (!portal?.active) {
    showToast("Portal powrotny jest zamknięty.", "warning");
    return false;
  }
  if (!findReturnHex(portal)) {
    showToast("Brak legalnego pola powrotu przy portalu.", "warning");
    return false;
  }
  const returningId = inspectedCharacterId;
  const returningCharacter = inspectedCharacter();
  if (returningCharacter.lifeState !== "alive" || returningCharacter.resources.hp <= 0) {
    showToast("Martwa postać nie może wrócić jako żywy podróżny.", "warning");
    return false;
  }
  if (returningId === portal.owner_character_id
    && livingTownTravelers(portal).some(({ id }) => id !== returningId)) {
    showToast("Właściciel portalu wraca ostatni. Użyj powrotu drużyny albo najpierw wybierz towarzysza.", "warning");
    return false;
  }
  if (battlePreparation.phase === BATTLE_PHASE.COMPLETED) return returnAfterVictory(returningId);
  pendingReturns.add(returningId);
  combat.log.push(`${returningCharacter.name} planuje powrót przez portal; polecenie wykona się w jej/jego najbliższym oknie gotowości.`);
  closePanel();
  driveTimeline();
  render();
  showToast(pendingReturns.has(returningId) ? "Powrót dodano do wspólnej kolejki." : "Powrót przez portal wykonany.");
  return true;
}

function resolvePendingReturn(returningId) {
  const returningCharacter = roster.get(returningId);
  const location = portalSystem.locationOf(returningId);
  const portal = location?.kind === "town" ? portalSystem.getPortal(location.via_portal_id) : null;
  const destination = portal?.active ? findReturnHex(portal) : null;
  if (!portal?.active || !destination) {
    pendingReturns.delete(returningId);
    combat.log.push(`Nie można wykonać zaplanowanego powrotu: ${returningCharacter.name} pozostaje w mieście.`);
    commitActiveTurn(() => combat.submitAction(returningId, "wait"));
    return false;
  }
  try {
    const stagedPortals = PortalSystem.fromJSON(portalSystem.toJSON());
    const result = stagedPortals.returnThroughPortal({
      portal_id: portal.portal_id,
      character_id: returningId,
      character: returningCharacter,
    });
    if (!result.ok) throw new Error(result.message);
    const stagedGrid = HexGrid.restore(hexGrid.snapshot());
    stagedGrid.addUnit({ id: returningId, position: destination });
    const stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
    stagedPreparation.returnUnit({ unitId: returningId, to: destination });
    stagedPortals.setCharacterLocation(returningId, {
      kind: "area",
      area_id: portal.source.area_id,
      instance_id: portal.source.instance_id,
      hex: destination,
      via_portal_id: portal.portal_id,
    });
    const combatUnit = combat.units.get(returningId);
    if (!combatUnit) throw new Error(`Brak jednostki walki dla ${returningCharacter.name}`);
    commitActiveTurn(() => {
      const command = combat.submitAction(returningId, "portalEnter", { portalId: portal.portal_id, direction: "return" }, {
        resolve: (_event, resolveCore) => {
          resolveCore();
          return result;
        },
      });
      portalSystem = stagedPortals;
      hexGrid = stagedGrid;
      battlePreparation = stagedPreparation;
      combatUnit.position = destination;
      combat.log.push(`${returningCharacter.name} wraca do tej samej instancji ${result.transition.to.instance_id}; przejście kosztowało ${(ACTION_TIME.portalEnter / 1000).toFixed(2)} s.`);
      return command;
    });
    pendingReturns.delete(returningId);
    return true;
  } catch (error) {
    pendingReturns.delete(returningId);
    combat.log.push(`Powrót ${returningCharacter.name} odrzucony: ${error.message}.`);
    commitActiveTurn(() => combat.submitAction(returningId, "wait"));
    return false;
  }
}

function partyReturnThroughPortal(portal) {
  if (!portal?.active) {
    showToast("Brak aktywnego portalu powrotnego.", "warning");
    return false;
  }
  const livingActive = party.activeCharacters().filter((character) =>
    character.lifeState === "alive" && character.resources.hp > 0);
  const travelers = livingTownTravelers(portal);
  if (travelers.length < 2 || travelers.length !== livingActive.length) {
    showToast("Powrót drużyny wymaga, aby wszyscy żywi aktywni bohaterowie byli w tym samym mieście przez ten portal.", "warning");
    return false;
  }

  const ordered = [
    ...travelers.filter(({ id }) => id !== portal.owner_character_id),
    ...travelers.filter(({ id }) => id === portal.owner_character_id),
  ];
  const groupIds = new Set(ordered.map(({ id }) => id));
  const planned = new Set(groupIds);
  const returned = [];
  const unable = [];
  for (const { id } of ordered) pendingReturns.add(id);
  closePanel();

  for (let step = 0; step < 500 && planned.size; step += 1) {
    if (!portal.active) {
      for (const id of planned) {
        pendingReturns.delete(id);
        unable.push(id);
      }
      planned.clear();
      break;
    }
    const head = nextCommandWindow();
    if (!head) break;

    if (planned.has(head.id) && pendingReturns.has(head.id)) {
      const nonOwnersRemain = [...planned].some((id) => id !== portal.owner_character_id);
      if (head.id === portal.owner_character_id && nonOwnersRemain) {
        commitActiveTurn(() => combat.submitAction(head.id, "wait"));
        combat.log.push(`${roster.get(head.id).name} czeka w mieście, aby właściciel wrócił jako ostatni.`);
        continue;
      }
      const returnedNow = resolvePendingReturn(head.id);
      planned.delete(head.id);
      if (returnedNow) {
        returned.push(head.id);
      } else {
        unable.push(head.id);
      }
      continue;
    }

    if (groupIds.has(head.id) && planned.size) {
      // A member who already returned has committed to the group macro; waiting
      // lets the remaining travelers receive their own paid readiness windows.
      commitActiveTurn(() => combat.submitAction(head.id, "wait"));
      continue;
    }

    actingUnitId = head.id;
    break;
  }

  for (const id of planned) {
    pendingReturns.delete(id);
    if (!unable.includes(id)) unable.push(id);
  }
  combat.log.push(`Powrót drużyny: ${returned.join(" → ") || "nikt"}; bez powrotu: ${unable.join(", ") || "nikt"}. Właściciel: ${portal.owner_character_id} (ostatni).`);
  driveTimeline();
  render();
  showToast(unable.length ? "Powrót drużyny zakończony częściowo." : "Drużyna wróciła do tej samej instancji.");
  return unable.length === 0;
}

function approachPathToPortal(characterId, portal, maxCost = 12) {
  const current = hexGrid.positionOf(characterId);
  if (hexDistance(current, portal.source.hex) <= 1) return [current];
  const candidates = hexNeighbors(portal.source.hex)
    .filter((hex) => hexGrid.has(hex) && !hexGrid.isBlocked(hex, { ignoreUnitId: characterId }))
    .map((hex) => hexGrid.findPath(characterId, hex, { maxCost }))
    .filter(Boolean)
    .sort((a, b) => a.length - b.length || hexKey(a.at(-1)).localeCompare(hexKey(b.at(-1))));
  return candidates[0] ?? null;
}

function partyToPortal(portal) {
  if (!portal?.active) {
    showToast("Brak aktywnego portalu dla tego rozkazu.", "warning");
    return;
  }
  closePanel();
  const members = party.activeCharacters().filter((member) => characterOnBattlefield(member.id) && member.resources.hp > 0);
  const ordered = [
    ...members.filter((member) => member.id !== portal.owner_character_id),
    ...members.filter((member) => member.id === portal.owner_character_id),
  ];
  const planned = new Set(ordered.map(({ id }) => id));
  const entered = [];
  const unable = [];

  for (let step = 0; step < 500 && planned.size; step += 1) {
    for (const memberId of [...planned]) {
      const member = roster.get(memberId);
      if (member.resources.hp <= 0 || member.lifeState !== "alive") {
        planned.delete(memberId);
        unable.push(memberId);
      } else if (!characterOnBattlefield(memberId)) {
        planned.delete(memberId);
        if (portalSystem.locationOf(memberId)?.kind === "town") entered.push(memberId);
        else unable.push(memberId);
      }
    }
    if (!planned.size) break;

    const head = nextCommandWindow();
    if (!head) break;

    if (pendingReturns.has(head.id)) {
      resolvePendingReturn(head.id);
      continue;
    }
    if (!planned.has(head.id)) {
      actingUnitId = head.id;
      break;
    }

    const member = roster.get(head.id);
    actingUnitId = member.id;
    const path = approachPathToPortal(member.id, portal);
    if (!path) {
      planned.delete(member.id);
      unable.push(member.id);
      combat.log.push(`${member.name} nie ma legalnej trasy do portalu; rozkaz grupowy zatrzymano w jej/jego oknie.`);
      break;
    }
    const distance = path.length - 1;
    if (distance > 0) {
      commitActiveTurn(() => submitMovement(member.id, path, { groupPortal: true }));
      combat.log.push(`${member.name} rozpoczyna marsz do portalu: ${distance} heksów, +${(distance * ACTION_TIME.movePerTile / 1000).toFixed(2)} s.`);
      continue;
    }

    const nonOwnersRemain = [...planned].some((id) => id !== portal.owner_character_id);
    if (member.id === portal.owner_character_id && nonOwnersRemain) {
      commitActiveTurn(() => combat.submitAction(member.id, "wait"));
      combat.log.push(`${member.name} czeka przy portalu, aby właściciel przeszedł jako ostatni.`);
      continue;
    }

    try {
      submitPortalEntry(member.id, portal, { groupPortal: true });
      planned.delete(member.id);
      entered.push(member.id);
    } catch (error) {
      planned.delete(member.id);
      unable.push(member.id);
      combat.log.push(`Wejście ${member.name} odrzucone: ${error.message}.`);
      commitActiveTurn(() => combat.submitAction(member.id, "wait"));
      break;
    }
  }

  for (const memberId of planned) if (!unable.includes(memberId)) unable.push(memberId);
  const remaining = nextEligibleIds();
  combat.log.push(`Drużyna do portalu: kolejność ${ordered.map(({ id }) => id).join(" → ") || "brak"}. W mieście: ${entered.join(", ") || "nikt"}; bez przejścia: ${unable.join(", ") || "nikt"}; na polu: ${remaining.join(", ") || "nikt"}.`);
  driveTimeline();
  render();
  openPanel("portal");
}

function useBeltSlot(index) {
  if (!campaignBattleAvailable()) return true;
  if (activePanel || isPaused() || pendingTarget) return true;
  const actor = actingCharacter();
  if (!actor) return true;
  const belt = belts.get(actor.id);
  const slot = belt?.[index];
  const kind = potionKind(slot);
  if (!slot || beltSlotCount(slot) <= 0 || !kind) {
    showToast(`Miejsce pasa ${index + 1} jest puste.`, "warning");
    return true;
  }
  if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
    consumePotionFromBelt(belt, index);
    if (kind === "health") actor.resources.hp = Math.min(actor.resources.maxHp, actor.resources.hp + 8);
    if (kind === "mana") actor.resources.mana = Math.min(actor.resources.maxMana, actor.resources.mana + 8);
    combat.log.push(`${actor.name} używa: ${slot.name} podczas przygotowania; AI pozostaje uśpione.`);
    showToast(`${slot.name}: pozostało ${beltSlotCount(belt[index])}.`, "success");
    render();
    return true;
  }
  if (!combat.canAct(actor.id)) {
    showToast(`${actor.name} nie jest jeszcze gotowa/y do użycia pasa.`, "warning");
    return true;
  }
  try {
    completePlayerAction("itemUse", { item: slot.name, beltSlot: index + 1 }, {
      resolve: (_event, resolveCore) => {
        const result = resolveCore();
        consumePotionFromBelt(belt, index);
        if (kind === "health") actor.resources.hp = Math.min(actor.resources.maxHp, actor.resources.hp + 8);
        if (kind === "mana") actor.resources.mana = Math.min(actor.resources.maxMana, actor.resources.mana + 8);
        combat.log.push(`${actor.name} używa: ${slot.name} (pas ${index + 1}).`);
        return result;
      },
    });
  } catch (error) {
    showToast(`Użycie pasa odrzucone: ${error.message}`, "warning");
    render();
  }
  return true;
}

const equipmentSlotLabels = Object.freeze({weapon:'BROŃ',offhand:'TARCZA',head:'GŁOWA',chest:'PANCERZ',hands:'RĘKAWICE',belt:'PAS',feet:'BUTY'});
const equipmentSlotClasses = Object.freeze({weapon:'slot-weapon',offhand:'slot-offhand',head:'slot-head',chest:'slot-chest',hands:'slot-hands',belt:'slot-belt',feet:'slot-feet'});
const equipmentGlyphs = Object.freeze({weapon:'⚔',offhand:'◈',head:'♜',chest:'♙',hands:'✦',belt:'═',feet:'♟'});
function safeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function equipmentPermission(owner) {
  if (isPaused()) return 'Zamknij pauzę, aby zmieniać wyposażenie.';
  if (owner.lifeState !== 'alive' || owner.resources.hp <= 0) return 'Martwa postać nie może zmieniać wyposażenia.';
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE
    && (owner.id !== actingUnitId || !combat.canAct(owner.id) || !characterOnBattlefield(owner.id))) {
    return `Tylko podgląd. Poczekaj na kolejkę ${owner.name}.`;
  }
  return null;
}
function equipmentCostCopy() {
  return battlePreparation.phase === BATTLE_PHASE.ACTIVE
    ? `Zmiana wyposażenia zużywa kolejkę (+${formatSeconds(ACTION_TIME.equipmentChange)} s).`
    : 'Przygotowanie / po walce: zmiana wyposażenia bez kosztu czasu.';
}
function selectedInventoryEntry(owner) {
  if (selectedInventoryItem?.ownerId !== owner.id) return null;
  return selectedInventoryItem.slot
    ? owner.equipment[selectedInventoryItem.slot] ?? null
    : inventories.get(owner.id).items.get(selectedInventoryItem.id) ?? null;
}
function potionBeltTransferPermission(owner) {
  return equipmentPermission(owner) || (battlePreparation.phase === BATTLE_PHASE.ACTIVE
    ? 'Pas można układać przed walką lub po walce.' : null);
}
function transferPotionBeltItem(owner, { itemId = null, index, toBelt }) {
  const inventory = inventories.get(owner.id);
  const belt = belts.get(owner.id);
  const previousInventory = inventory.toJSON();
  const previousBelt = structuredClone(belt);
  const previousIds = [...owner.inventoryItemIds];
  let item;
  try {
    const reason = potionBeltTransferPermission(owner);
    if (reason) throw new Error(reason);
    item = toBelt
      ? putPotionInBelt(inventory, belt, itemId, index)
      : takePotionFromBelt(inventory, belt, index, owner.id);
    updateInventoryOwnership(owner.id);
    publishSaveSnapshot(buildSaveSnapshot());
  } catch (error) {
    inventories.set(owner.id, InventoryGrid.fromJSON(previousInventory));
    belts.set(owner.id, previousBelt);
    owner.inventoryItemIds = previousIds;
    inventoryNotice = error.message;
    render();
    renderInventoryPanel();
    return false;
  }
  selectedInventoryItem = null;
  inventoryNotice = `${item.name}: przeniesiono ${toBelt ? `do pasa ${index + 1}` : 'do plecaka'}.`;
  render();
  renderInventoryPanel();
  return true;
}
function selectInventoryItem(ownerId, id, slot = null) {
  selectedInventoryItem = {ownerId,id,slot};
  renderItemDetails();
  panelBody.querySelectorAll('[data-item-id]').forEach(node => {
    node.classList.toggle('item-selected', node.dataset.itemId === id);
  });
}
function performEquipmentChange({itemId,slot}) {
  const owner = inspectedCharacter();
  const grid = inventories.get(owner.id);
  try {
    const reason = equipmentPermission(owner);
    if (reason) throw new Error(reason);
    const plan = planEquipmentChange({character:owner,inventory:grid,catalog:equipmentCatalog,itemId,slot});
    const nextBelt = resizePotionBelt(belts.get(owner.id), potionBeltCapacity({ equipment: plan.equipment }, equipmentCatalog));
    if (battlePreparation.phase === BATTLE_PHASE.ACTIVE) {
      const previousEquipment = structuredClone(owner.equipment);
      const previousInventory = grid.toJSON();
      const previousIndex = [...owner.inventoryItemIds];
      try {
        completePlayerAction('equipmentChange', {itemId:plan.changedItem.id,operation:plan.action}, {
          actorId:owner.id, allowPanel:'inventory', drive:false,
          resolve:(_event,resolveCore) => {
            const result = resolveCore();
            commitEquipmentChange(owner,grid,equipmentCatalog,plan);
            return result;
          },
        });
      } catch (error) {
        // CombatState rolls back its graph. Restore the external inventory transaction too.
        const liveOwner = roster.get(owner.id);
        liveOwner.equipment = previousEquipment;
        liveOwner.inventoryItemIds = previousIndex;
        grid.items = InventoryGrid.fromJSON(previousInventory).items;
        throw error;
      }
      driveTimeline();
    } else {
      commitEquipmentChange(owner,grid,equipmentCatalog,plan);
    }
    belts.set(owner.id, nextBelt);
    refreshHeroSkillAvailability(owner.id);
    const currentOwner = roster.get(owner.id);
    const equippedSlot = Object.entries(currentOwner.equipment).find(([,item])=>item.id===plan.changedItem.id)?.[0] ?? null;
    selectedInventoryItem = {ownerId:owner.id,id:plan.changedItem.id,slot:equippedSlot};
    inventoryNotice = `${plan.action === 'equip' ? 'Założono' : 'Zdjęto'}: ${plan.changedItem.name}. ${equipmentCostCopy()}`;
    combat.log.push(`${owner.name}: ${plan.action === 'equip' ? 'zakłada' : 'zdejmuje'} ${plan.changedItem.name}.`);
    autosaveGame('zmianie wyposażenia');
    render(); renderInventoryPanel();
    panelBody.querySelector('#equipment-action')?.focus({preventScroll:true});
    return true;
  } catch (error) {
    inventoryNotice = error.message;
    renderInventoryPanel();
    panelBody.querySelector('#equipment-message')?.focus({preventScroll:true});
    return false;
  }
}
function renderItemDetails() {
  const host = panelBody.querySelector('#item-details');
  if (!host) return;
  const owner = inspectedCharacter();
  const item = selectedInventoryEntry(owner);
  host.replaceChildren();
  host.hidden = false;
  host.append(make('h3', '', 'Pas mikstur'));
  const selectedPotion = item && !selectedInventoryItem?.slot && isPotionItem(item) ? item : null;
  const transferReason = potionBeltTransferPermission(owner);
  const belt = belts.get(owner.id) ?? emptyPotionBelt();
  host.append(make('p', 'item-detail-note', selectedPotion
    ? 'Wybierz puste miejsce, aby włożyć tę miksturę do pasa.'
    : 'Wybierz miksturę w plecaku, aby włożyć ją do pasa. Zajęte miejsca można opróżnić.'));
  const beltGrid = make('div', 'inventory-belt-grid');
  host.append(beltGrid);
  for (let index = 0; index < belt.length; index += 1) {
    const slot = belt[index];
    const filled = beltSlotCount(slot) > 0;
    const button = make('button', 'inventory-belt-cell');
    button.append(make('small', '', String(index + 1)));
    const iconId = filled ? potionIconId(slot) : null;
    if (iconId) {
      const image = document.createElement('img');
      image.src = `/app/assets/items/${iconId}.png`; image.alt = slot.name;
      button.append(image);
    }
    button.type = 'button';
    button.dataset.inventoryBeltIndex = String(index);
    button.disabled = Boolean(transferReason) || (!filled && !selectedPotion);
    button.title = transferReason ?? (filled
      ? `Wyjmij miksturę z pasa ${index + 1} do plecaka`
      : selectedPotion ? `Włóż ${selectedPotion.name} do pasa ${index + 1}` : 'Wybierz miksturę w plecaku');
    button.setAttribute('aria-label', `${index + 1}: ${filled ? slot.name : 'Puste miejsce'}. ${button.title}`);
    button.addEventListener('click', () => transferPotionBeltItem(owner, {
      itemId: selectedPotion?.id ?? null, index, toBelt: !filled,
    }));
    button.style.gridRow = String(belt.length / 4 - Math.floor(index / 4));
    button.style.gridColumn = String(index % 4 + 1);
    beltGrid.append(button);
  }
  if (transferReason) host.append(make('p', 'equipment-error', transferReason));
  if (!item) return;
  const close = make('button', 'd2-live-detail-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Zamknij opis przedmiotu');
  close.addEventListener('click', () => {
    selectedInventoryItem = null;
    renderItemDetails();
    panelBody.querySelectorAll('.item-selected').forEach(node => node.classList.remove('item-selected'));
  });
  host.append(close);
  const d = equipmentCatalog.get(item.canonicalId);
  const unidentified = item.identified === false;
  host.append(make('h3','item-detail-name',unidentified ? 'Niezidentyfikowany przedmiot' : item.name));
  if (!d) {
    host.append(make('p','',isPotionItem(item)
      ? 'Miksturę można włożyć do wybranego pustego miejsca pasa powyżej.'
      : 'Przedmiot użytkowy nie zajmuje slotu wyposażenia.'));
    return;
  }
  const equipped = Boolean(selectedInventoryItem?.slot);
  const problems = requirementsFor(owner,d);
  const stats = equipmentStats(owner,equipmentCatalog);
  const lines = [
    unidentified ? 'Zidentyfikuj przedmiot u Deckarda Caina, aby poznać jego pełne właściwości.' : `${d.displayName} · zwykły przedmiot`,
    `Rozmiar: ${d.width} × ${d.height} · slot: ${equipmentSlotLabels[d.slot]}`,
    d.kind === 'weapon' ? `Obrażenia bazy: ${(d.twoHanded ? d.twoHandDamage : d.oneHandDamage).join('–')}${d.twoHanded ? ' (oburącz)' : ' (jedną ręką)'}` : `Obrona przedmiotu: ${item.defense} (zakres bazy ${d.defenseRange.join('–')})`,
    `Wymagania: poziom ${d.requiredLevel} · siła ${d.requiredStrength} · zręczność ${d.requiredDexterity}${d.classOnly ? ` · ${classNames[d.classOnly]}` : ''}`,
    `Trwałość: ${item.durability}/${item.maxDurability} — zużycie nie jest jeszcze włączone.`,
  ];
  if (d.barbarianOneHand && owner.classId === 'barbarian') lines.push(`Barbarzyńca: z tarczą obrażenia jednoręczne ${d.oneHandDamage.join('–')}, bez tarczy oburącz.`);
  for (const line of lines) host.append(make('p','item-detail-line',line));
  const statsNow = make('p','equipment-comparison',`Teraz: ${stats.weaponName} · atak bronią ${stats.weaponDamage.join('–')} · obrona ${stats.defense}`);
  host.append(statsNow);
  let planError = null;
  try {
    const plan = planEquipmentChange({character:owner,inventory:inventories.get(owner.id),catalog:equipmentCatalog,
      ...(equipped ? {slot:selectedInventoryItem.slot} : {itemId:item.id})});
    const after = equipmentStats({...owner,equipment:plan.equipment},equipmentCatalog);
    host.append(make('p','equipment-comparison',`Po ${equipped ? 'zdjęciu' : 'założeniu'}: ${after.weaponName} · atak bronią ${after.weaponDamage.join('–')} · obrona ${after.defense}`));
  } catch (error) { planError = error.message; }
  if (problems.length && !equipped) host.append(make('p','equipment-error',problems.join(' · ')));
  const action = make('button','metal-button equipment-primary',equipped ? 'ZDEJMIJ DO PLECAKA' : 'ZAŁÓŻ');
  action.id = 'equipment-action'; action.type = 'button';
  const disabledReason = equipmentPermission(owner) || planError;
  action.disabled = Boolean(disabledReason);
  action.title = disabledReason ?? equipmentCostCopy();
  action.addEventListener('click',()=>performEquipmentChange(equipped ? {slot:selectedInventoryItem.slot} : {itemId:item.id}));
  host.append(action);
  const tradeVendorId = tradeVendorByPanel[activePanel];
  if (tradeVendorId && !equipped) {
    const price = campServices.quoteSell({ item });
    const sell = make('button', 'metal-button merchant-sell', `SPRZEDAJ ZA ${price} ZŁOTA`);
    sell.type = 'button';
    sell.disabled = Boolean(disabledReason);
    sell.addEventListener('click', () => sellCampItem(tradeVendorId, item.id));
    host.append(sell);
  }
  if (disabledReason) host.append(make('p','equipment-error',disabledReason));
  host.append(make('p','item-detail-note','Wymagania i zajęte miejsce są sprawdzane przed zmianą wyposażenia.'));
}
function inventoryDragPayload(event) {
  try {
    const value = JSON.parse(event.dataTransfer.getData('application/x-rotw-item'));
    if (!value || value.ownerId !== inspectedCharacterId || typeof value.id !== 'string') return null;
    // A drag may outlive a panel refresh or a gear swap. The original identity
    // must still occupy that container; never unequip a replacement item.
    if (value.slot != null) {
      if (!EQUIPMENT_SLOTS.includes(value.slot)
        || inspectedCharacter().equipment[value.slot]?.id !== value.id) return null;
    } else if (!inventories.get(value.ownerId)?.items.has(value.id)) return null;
    return value;
  } catch { return null; }
}
const canonicalEquipmentSlots = Object.freeze([
  ['head', 'HEŁM'], ['amulet', 'AMULET'], ['weapon', 'BROŃ'],
  ['offhand', 'TARCZA'], ['chest', 'PANCERZ'], ['hands', 'RĘKAWICE'],
  ['belt', 'PAS'], ['feet', 'BUTY'], ['ring-left', 'PIERŚCIEŃ'],
  ['ring-right', 'PIERŚCIEŃ'],
]);

function inventoryItemGlyph(item, definition) {
  if (definition) return equipmentGlyphs[definition.slot] ?? '◆';
  if (/mana|many/i.test(item.name)) return '✧';
  if (/zdrow|leczen|życi/i.test(item.name)) return '✚';
  if (/kostk/i.test(item.name)) return '◇';
  return '◆';
}

function inventoryArtworkNode(item, definition) {
  const art = make('span', 'd2-live-item-art');
  art.setAttribute('aria-hidden', 'true');
  if (definition || hasTradeItemArtwork(item.canonicalId)) art.innerHTML = tradeItemArtworkMarkup(item.canonicalId);
  else art.textContent = inventoryItemGlyph(item, definition);
  return art;
}

function attachEquipmentTooltip(node, item, { value, valueLabel } = {}) {
  node.removeAttribute('title');
  attachItemTooltip(node, {
    item,
    definition: equipmentCatalog.get(item?.canonicalId),
    character: inspectedCharacter(),
    ...(Number.isFinite(value) ? { value } : {}),
    ...(valueLabel ? { valueLabel } : {}),
  });
}

function safeItemSellValue(item) {
  return equipmentCatalog.get(item?.canonicalId) || CAMP_SUPPLY_DEFINITIONS.some(supply => supply.id === item?.canonicalId)
    ? campServices.quoteSell({ item })
    : undefined;
}

function renderCanonicalInventoryPanel({ empty = false } = {}) {
  const owner = empty ? null : inspectedCharacter();
  const inventory = owner ? inventories.get(owner.id) : null;
  const reason = owner ? equipmentPermission(owner) : null;
  if (owner && selectedInventoryItem?.ownerId !== owner.id) selectedInventoryItem = null;
  panelBody.className = `game-panel-body d2-empty-inventory${empty ? '' : ' d2-live-inventory inventory-view equipment-v051 d2-inventory-v0518'}`;
  panelBody.innerHTML = `
    <div class="d2-empty-layout" aria-label="${empty ? 'Pusty szablon ekwipunku' : `Ekwipunek: ${safeHtml(owner.name)}`}">
      <div id="equipment-slots" class="d2-empty-equipment" role="group" aria-label="Pola wyposażenia">
        <div class="d2-empty-weapon-tabs" data-side="left" role="group" aria-label="Zestaw broni"><button type="button" class="active" data-weapon-set="1" aria-pressed="true">I</button><button type="button" data-weapon-set="2" aria-pressed="false" ${empty ? '' : 'disabled title="Drugi zestaw broni nie jest obsługiwany w tej wersji gry"'}>II</button></div>
        <div class="d2-empty-weapon-tabs" data-side="right" role="group" aria-label="Zestaw broni"><button type="button" class="active" data-weapon-set="1" aria-pressed="true">I</button><button type="button" data-weapon-set="2" aria-pressed="false" ${empty ? '' : 'disabled title="Drugi zestaw broni nie jest obsługiwany w tej wersji gry"'}>II</button></div>
      </div>
      <div id="inventory-grid" class="d2-empty-grid${empty ? '' : ' inventory-grid'}" role="group" aria-label="${empty ? '40 pustych pól plecaka' : `Plecak ${safeHtml(owner.name)}: 10 kolumn, 4 rzędy`}"></div>
      <div class="d2-empty-gold" aria-label="Złoto: ${empty ? 0 : campServices.gold}">${empty ? '<span class="d2-empty-visually-hidden">Złoto: 0</span>' : `<b class="d2-live-gold-count">${campServices.gold}</b><button id="open-horadric-cube" type="button" title="Otwórz Kostkę Horadrimów" aria-label="Otwórz Kostkę Horadrimów">◇</button>`}</div>
      ${empty ? '' : '<div id="equipment-owner-tabs" class="d2-live-owner-tabs" aria-label="Wybierz postać"></div><div id="equipment-message" class="d2-live-notice" role="status" tabindex="-1"></div><section id="item-details" class="item-details d2-live-item-details" aria-label="Szczegóły przedmiotu" hidden></section>'}
    </div>`;

  const slotsNode = panelBody.querySelector('#equipment-slots');
  if (owner) {
    slotsNode.dataset.heroClass = owner.classId;
    slotsNode.style.setProperty('--inventory-canonical-hero', `url("${spritePaths[owner.classId]}")`);
  }
  for (const [slot, label] of canonicalEquipmentSlots) {
    const supported = EQUIPMENT_SLOTS.includes(slot);
    const item = supported && owner ? owner.equipment[slot] : null;
    const button = make('button', `d2-empty-slot${item ? ' equipped' : ''}`);
    button.type = 'button';
    button.dataset.slot = slot;
    button.setAttribute('aria-label', item ? `${label}: ${item.name}` : `Pusty slot: ${label.toLowerCase()}`);
    if (supported && owner) button.dataset.equipSlot = slot;
    if (!supported && owner) {
      button.title = 'Miejsce widoczne we wzorcu; ten typ wyposażenia nie jest jeszcze obsługiwany w grze.';
      button.addEventListener('click', () => {
        inventoryNotice = 'Ten typ wyposażenia nie jest jeszcze obsługiwany.';
        renderCanonicalInventoryPanel();
      });
    }
    if (item) {
      const definition = equipmentCatalog.get(item.canonicalId);
      button.append(inventoryArtworkNode(item, definition), make('span', 'd2-live-item-name', item.name));
      button.dataset.itemId = item.id;
      button.title = `${item.name} — kliknij: opis, dwuklik: zdejmij.`;
      attachEquipmentTooltip(button, item);
      button.addEventListener('click', () => selectInventoryItem(owner.id, item.id, slot));
      button.addEventListener('dblclick', () => performEquipmentChange({ slot }));
      button.draggable = !reason;
      button.addEventListener('dragstart', event => event.dataTransfer.setData('application/x-rotw-item', JSON.stringify({ ownerId: owner.id, id: item.id, slot })));
    }
    if (supported && owner) {
      button.addEventListener('dragover', event => { if (!reason) event.preventDefault(); });
      button.addEventListener('drop', event => {
        event.preventDefault();
        const payload = inventoryDragPayload(event);
        if (!payload || payload.slot || reason) return;
        const movedItem = inventory.items.get(payload.id);
        if (equipmentCatalog.get(movedItem?.canonicalId)?.slot !== slot) {
          inventoryNotice = 'Ten przedmiot nie pasuje do wskazanego slotu.';
          renderInventoryPanel();
          return;
        }
        performEquipmentChange({ itemId: payload.id });
      });
    }
    slotsNode.append(button);
  }

  const gridNode = panelBody.querySelector('#inventory-grid');
  for (let index = 0; index < 40; index += 1) {
    const x = index % 10, y = Math.floor(index / 10);
    const cell = make(empty ? 'button' : 'span', `d2-empty-cell${empty ? '' : ' inventory-cell'}`);
    if (empty) {
      cell.type = 'button';
      cell.setAttribute('aria-label', `Puste pole ${index + 1}`);
    } else {
      cell.style.gridColumn = String(x + 1);
      cell.style.gridRow = String(y + 1);
      cell.addEventListener('dragover', event => event.preventDefault());
      cell.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        const payload = inventoryDragPayload(event);
        if (!payload) return;
        if (payload.slot) {
          performEquipmentChange({ slot: payload.slot });
        } else {
          const moved = inventory.move(payload.id, { x, y });
          inventoryNotice = moved ? 'Przedmiot przeniesiony w plecaku.' : 'Przedmiot nie mieści się tutaj — pozostał na swoim miejscu.';
          renderInventoryPanel();
        }
      });
    }
    gridNode.append(cell);
  }
  if (owner) {
    for (const item of inventory.toJSON().items) {
      const definition = equipmentCatalog.get(item.canonicalId);
      const itemNode = make('button', `inventory-item d2-live-pack-item quality-${item.quality ?? 'normal'}${definition && requirementsFor(owner, definition).length ? ' requirements-not-met' : ''}`);
      itemNode.type = 'button';
      itemNode.dataset.itemId = item.id;
      itemNode.style.gridColumn = `${item.position.x + 1} / span ${item.width}`;
      itemNode.style.gridRow = `${item.position.y + 1} / span ${item.height}`;
      itemNode.setAttribute('aria-label', item.identified === false ? 'Niezidentyfikowany przedmiot' : item.name);
      itemNode.title = `${item.identified === false ? 'Niezidentyfikowany' : item.name} · ${item.width}×${item.height}${definition ? ' · klik: opis, dwuklik: załóż' : ''}`;
      itemNode.append(inventoryArtworkNode(item, definition), make('span', 'd2-live-item-name', item.identified === false ? 'Niezidentyfikowany' : item.name));
      attachEquipmentTooltip(itemNode, item);
      itemNode.draggable = true;
      itemNode.addEventListener('click', () => selectInventoryItem(owner.id, item.id));
      itemNode.addEventListener('focus', () => selectInventoryItem(owner.id, item.id));
      itemNode.addEventListener('dblclick', () => { if (definition) performEquipmentChange({ itemId: item.id }); });
      itemNode.addEventListener('dragstart', event => event.dataTransfer.setData('application/x-rotw-item', JSON.stringify({ ownerId: owner.id, id: item.id })));
      gridNode.append(itemNode);
    }
    panelBody.querySelector('#equipment-owner-tabs').append(renderOwnerTabs());
    const message = panelBody.querySelector('#equipment-message');
    message.textContent = inventoryNotice || reason || '';
    message.hidden = !message.textContent;
    renderItemDetails();
    panelBody.querySelector('#open-horadric-cube').addEventListener('click', () => openPanel('horadric-cube'));
  } else {
    panelBody.querySelectorAll('.d2-empty-weapon-tabs button').forEach(button => {
      button.addEventListener('click', () => {
        panelBody.querySelectorAll('.d2-empty-weapon-tabs button').forEach(tab => {
          const active = tab.dataset.weaponSet === button.dataset.weaponSet;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-pressed', String(active));
        });
      });
    });
  }
  const footer = document.querySelector('#game-panel .game-panel-footer');
  footer.classList.add('d2-empty-footer');
  footer.replaceChildren();
}

function renderInventoryPanel() {
  renderCanonicalInventoryPanel({ empty: EMPTY_INVENTORY_TEMPLATE });
}


function transferHoradricCubeItem(direction, itemId) {
  const owner = inspectedCharacter();
  const inventory = inventories.get(owner.id);
  const beforeCube = horadricCube.snapshot();
  const beforeInventory = inventory.toJSON();
  const beforeIds = [...owner.inventoryItemIds];
  try {
    const item = direction === 'in'
      ? horadricCube.transferToCube({ itemId, inventory })
      : horadricCube.transferFromCube({ itemId, inventory });
    owner.inventoryItemIds = inventory.toJSON().items.map(({ id }) => id);
    validateEquipmentWorld(roster, inventories, equipmentCatalog);
    horadricCube.validateUniqueOwnership(inventories);
    campServices.validateUniqueOwnership(new Map([...inventories, ['horadric-cube', horadricCube.grid]]));
    publishSaveSnapshot(buildSaveSnapshot());
    render();
    renderPanel('horadric-cube');
    showToast(`${item.name ?? 'Przedmiot'}: przeniesiono ${direction === 'in' ? 'do Kostki' : 'do plecaka'}.`, 'success');
    return true;
  } catch (error) {
    horadricCube = HoradricCubeState.restore(beforeCube);
    inventories.set(owner.id, InventoryGrid.fromJSON(beforeInventory));
    owner.inventoryItemIds = beforeIds;
    render();
    renderPanel('horadric-cube');
    showToast(/Brak miejsca/.test(error.message)
      ? error.message : 'Nie udało się przenieść przedmiotu. Stan plecaka i Kostki zachowano.', 'warning');
    return false;
  }
}

function renderHoradricCubePanel() {
  const owner = inspectedCharacter();
  panelBody.className = 'game-panel-body cube-panel-view d2-cube-v0518';
  renderCubePanel({
    host: panelBody,
    cube: horadricCube,
    inventory: inventories.get(owner.id),
    owner,
    catalog: equipmentCatalog,
    resolveValue: item => equipmentCatalog.get(item?.canonicalId) ? campServices.quoteSell({ item }) : undefined,
    onToCube: ({ itemId }) => transferHoradricCubeItem('in', itemId),
    onFromCube: ({ itemId }) => transferHoradricCubeItem('out', itemId),
  });
}

function renderOwnerTabs() {
  const tabs = make("div", "owner-tabs");
  for (const character of party.activeCharacters()) {
    const button = make("button", character.id === inspectedCharacterId ? "active" : "", character.name);
    button.type = "button";
    button.addEventListener("click", () => {
      inspectedCharacterId = character.id;
      inventoryNotice = "";
      render();
      renderPanel(activePanel);
    });
    tabs.append(button);
  }
  return tabs;
}

function renderHirelingPanel() {
  const owner = inspectedCharacter();
  const hireling = hirelingsByOwner.get(owner.id);
  panelBody.className = "game-panel-body hireling-view";
  panelBody.replaceChildren(renderOwnerTabs());
  if (!hireling) {
    const empty = make("div", "panel-empty-state");
    empty.innerHTML = `<span class="empty-sigil">◇</span><h3>Ten bohater nie ma zatrudnionego najemnika</h3><p>Właściciel: <b>${owner.name}</b>. Przywołania nie są wyświetlane jako najemnicy i nie otrzymują fikcyjnych plecaków.</p>`;
    panelBody.append(empty);
    return;
  }
}

function renderCharacterPanel() {
  const owner = inspectedCharacter();
  const actor = actingCharacter();
  const gearStats = equipmentStats(owner, equipmentCatalog);
  const progress = characterProgressionView(owner);
  panelBody.className = "game-panel-body character-view d2-character-sheet";
  panelBody.innerHTML = `
    <div class="d2-sheet-heading"><div><small>KARTA POSTACI</small><h3>${safeHtml(owner.name)}</h3><p>${safeHtml(classNames[owner.classId])}</p></div><span class="d2-sheet-level">POZIOM <strong>${owner.level}</strong></span></div>
    <div class="d2-sheet-columns">
      <div class="d2-sheet-column">
        <section class="d2-sheet-section"><h4>Atrybuty</h4><dl>${Object.entries({strength:'Siła',dexterity:'Zręczność',vitality:'Witalność',energy:'Energia'}).map(([key,label])=>`<div class="d2-sheet-row"><dt>${label}</dt><dd><strong>${owner.stats[key]}</strong><button type="button" data-spend-stat="${key}" aria-label="Zwiększ: ${label}" title="Przydziel 1 punkt: ${label}" ${owner.unspentStatPoints < 1 ? 'disabled' : ''}>+</button></dd></div>`).join('')}</dl><p class="d2-sheet-points">Wolne punkty cech <b id="stat-points">${owner.unspentStatPoints}</b></p></section>
        <section class="d2-sheet-section"><h4>Życie i mana</h4><dl><div class="d2-sheet-row"><dt>Życie</dt><dd><strong>${owner.resources.hp} / ${owner.resources.maxHp}</strong></dd></div><div class="d2-sheet-row"><dt>Mana</dt><dd><strong>${owner.resources.mana} / ${owner.resources.maxMana}</strong></dd></div><div class="d2-sheet-row"><dt>Stan</dt><dd><strong>${owner.lifeState==='alive'?'Żywy':'Poległy'}</strong></dd></div></dl></section>
      </div>
      <div class="d2-sheet-column">
        <section class="d2-sheet-section"><h4>Walka</h4><dl><div class="d2-sheet-row"><dt>Obrażenia broni</dt><dd><strong>${gearStats.weaponDamage.join('–')}</strong></dd></div><div class="d2-sheet-row"><dt>Obrona</dt><dd><strong>${gearStats.defense}</strong></dd></div><div class="d2-sheet-row"><dt>Trafienie</dt><dd><strong class="d2-sheet-unavailable">Niewdrożone</strong></dd></div><div class="d2-sheet-row"><dt>Broń</dt><dd><strong>${safeHtml(gearStats.weaponName)}</strong></dd></div></dl></section>
        <section class="d2-sheet-section d2-sheet-progress"><h4>Doświadczenie</h4><p><strong id="experience-next">${progress.isMaxLevel ? 'Maksymalny poziom' : `${owner.experience} / ${progress.nextLevelExperience} EXP`}</strong><span>${Math.round(progress.progress)}%</span></p><progress id="experience-progress" max="1" value="${progress.fraction}" aria-label="Postęp do następnego poziomu">${Math.round(progress.progress)}%</progress><div class="d2-sheet-row"><span>Punkty umiejętności</span><strong id="skill-points">${owner.unspentSkillPoints}</strong></div></section>
      </div>
    </div>
    <div class="d2-sheet-meta"><span>Położenie: <b>${safeHtml(characterLocationLabel(owner.id))}</b></span><span>Zestaw broni: <b>${weaponSets.get(owner.id)}</b></span><span>Wykonuje turę: <b>${safeHtml(actor?.name ?? '—')}</b></span></div>
    <p class="d2-sheet-note">Przydział punktów zwiększa maksymalne zasoby bez automatycznego leczenia. Test trafienia i blok nie są jeszcze wdrożone.</p>`;
  panelBody.querySelectorAll('[data-spend-stat]').forEach(button => button.addEventListener('click', () => {
    try {
      spendCharacterStatPoints(roster.get(owner.id), button.dataset.spendStat);
      equipmentStats(roster.get(owner.id), equipmentCatalog);
      combat.log.push(`${owner.name}: przydzielono punkt atrybutu.`);
      render();
      renderCharacterPanel();
    } catch (error) { showToast(error.message); }
  }));
}

function announceLevelUps(awards) {
  for (const { characterId, levelUp } of awards) {
    if (!levelUp) continue;
    const message = `${roster.get(characterId).name} osiąga poziom ${levelUp.toLevel}! +${levelUp.statPointsGained} punktów statystyk, +${levelUp.skillPointsGained} umiejętności.`;
    combat.log.push(message);
    showToast(message);
  }
}

function renderSkillsPanel() {
  const owner = inspectedCharacter();
  const treeView = skillTreeCatalog.view(owner, selectedSkillTreePage);
  const treeLabel = treeView.tree.name?.plPLSourceForm || treeView.tree.name?.enUS || treeView.tree.sourceKey;
  const sourceWarning = skillTreeCatalog.sourceStatus === 'no_gameplay_implementation_before_source_audit'
    ? 'Dane nazw, wymagań, poziomów, kosztów i synergii pochodzą z lokalnych tabel D2R. Wykonanie efektów bojowych pozostaje zablokowane, dopóki nie zostanie potwierdzone i zaimplementowane.'
    : 'Dane drzewka pochodzą ze zweryfikowanego katalogu źródłowego.';
  const skillByName = new Map(treeView.skills.map((skill) => [skill.internalName, skill]));
  const treeLinks = treeView.skills.flatMap((target) => target.requirements.prerequisiteSkills.flatMap((name) => {
    const source = skillByName.get(name);
    return source ? [{ source, target }] : [];
  }));
  const renderSynergyNames = (edges, direction) => {
    const names = [...new Set((edges ?? []).map((edge) => direction === 'in' ? edge.sourceSkill : edge.targetSkill))];
    return names.length ? names.map((name) => `<span>${safeHtml(owner.classId === 'barbarian' ? skillTreeCatalog.skill(owner.classId, name).localizedName.plPL : name)}</span>`).join('') : '<span class="skill-tree-none">brak zadeklarowanych</span>';
  };
  const renderNode = (skill) => {
    const name = skill.localizedName?.plPL || skill.localizedName?.enUS || skill.internalName;
    const short = skill.localizedShortDescription?.plPL || skill.localizedShortDescription?.enUS || 'BRAK POTWIERDZONYCH DANYCH';
    const reqNames = skill.requirements.prerequisiteSkills.length
      ? skill.requirements.prerequisiteSkills.map((value) => safeHtml(owner.classId === 'barbarian' ? skillTreeCatalog.skill(owner.classId, value).localizedName.plPL : value)).join(', ')
      : 'brak';
    const mana = skillManaProfile({mana:skill.mana.raw}, Math.max(1, skill.state.effectiveLevel)).cost;
    const weaponTypes = skill.requirements.weaponTypes;
    const weaponCopy = weaponTypes ? [...weaponTypes.includeA, ...weaponTypes.includeB].join(', ') || 'brak ograniczenia typu w źródle' : 'BRAK DANYCH';
    const cooldown = skill.cooldown?.convertedSeconds ?? 'BRAK POTWIERDZONYCH DANYCH';
    const reasons = skill.lockReasons.length ? skill.lockReasons.join(' · ') : 'Gotowe do przydzielenia';
    const classes = ['skill-tree-node', skill.allocatable ? 'allocatable' : '', skill.unlocked ? '' : 'locked'].filter(Boolean).join(' ');
    const glyph = 'BRAK IKONY';
    let effectCopy = '';
    if (skill.id === 'sorceress.fire_bolt' && learnedSourceSkill(owner, skill)) {
      const values = fireBoltValues(owner, skillTreeCatalog);
      effectCopy = `<p class="skill-tree-description skill-source-damage">Ogień: ${values.damage.join('–')} · synergie: +${values.synergyPercent}% · mistrzostwo: +${values.masteryPercent}%</p>`;
    }
    if (skill.id === 'barbarian.bash') {
      effectCopy = '<p class="skill-tree-description skill-source-damage">Synergie: Ogłuszenie — +5% obrażeń/punkt; Koncentracja — +5% skuteczności ataku/punkt. Liczą się tylko wydane punkty.</p>';
      if (learnedSourceSkill(owner, skill)) {
        const v = bashValues(owner, skillTreeCatalog);
        effectCopy += `<p class="skill-tree-description">Teraz: obrażenia +${v.damagePercent}% i +${v.flatDamage}; skuteczność +${v.ratingPercent}%.</p>`;
      }
    }
    if (owner.classId === 'barbarian' && skill.crossSkillDependenciesIncoming.length) {
      effectCopy += `<p class="skill-tree-description">Zależności potwierdzone w tabelach: ${skill.crossSkillDependenciesIncoming.map(edge =>
        safeHtml(skillTreeCatalog.skill(owner.classId, edge.sourceSkill).localizedName.plPL) + ' — ' + safeHtml(edge.formula)).join('; ')}.</p>`;
    }
    return `<article class="${classes} skill-node-class-${safeHtml(owner.classId)}" data-skill-id="${safeHtml(skill.id)}" style="--tree-row:${skill.position.row};--tree-column:${skill.position.column}">
      <div class="skill-tree-node-head"><span class="skill-tree-icon" aria-hidden="true"><img src="${skillIconUrl(owner.classId, skill)}" alt="" loading="lazy" data-skill-icon="${safeHtml(skill.id)}"><span class="skill-tree-icon-fallback">${glyph}</span></span><div><h4>${safeHtml(name)}</h4><small>${safeHtml(skill.internalName)}</small></div><strong>${skill.state.hardPoints}/${skill.maximumBaseLevel}</strong></div>
      <p class="skill-tree-description">${safeHtml(short)}</p>
      <p class="skill-tree-description">${safeHtml(runtimeSkillStatus(skill.id).label)}</p>
      ${effectCopy}
      <dl class="skill-tree-meta"><div><dt>Poziom</dt><dd>${skill.requirements.characterLevel}</dd></div><div><dt>Mana (ranga ${Math.max(1,skill.state.effectiveLevel)})</dt><dd>${safeHtml(String(mana))}</dd></div><div><dt>Cooldown</dt><dd>${safeHtml(String(cooldown))}</dd></div><div><dt>Typ</dt><dd>${safeHtml(skill.mechanicType || 'BRAK POTWIERDZONYCH DANYCH')}</dd></div></dl>
      <p class="skill-tree-requirement"><b>Broń (kody źródłowe):</b> ${safeHtml(weaponCopy)}${weaponTypes?.excludeA?.length ? ` · wyklucza: ${safeHtml(weaponTypes.excludeA.join(', '))}` : ''}</p>
      <p class="skill-tree-requirement"><b>Wymaga:</b> ${reqNames}</p>
      <div class="skill-tree-synergy"><b>Zależności od wydanych punktów:</b><div>${renderSynergyNames(owner.classId === 'barbarian' ? skill.crossSkillDependenciesIncoming.filter(e=>e.hardPointsOnly) : skill.synergiesIncoming, 'in')}</div><b>Wpływa na:</b><div>${renderSynergyNames(owner.classId === 'barbarian' ? skill.crossSkillDependenciesOutgoing.filter(e=>e.hardPointsOnly) : skill.synergiesOutgoing, 'out')}</div></div>
      <p class="skill-tree-lock" aria-live="polite">${safeHtml(reasons)}</p>
      <button type="button" class="metal-button skill-tree-spend" data-spend-skill="${safeHtml(skill.id)}" aria-label="${skill.allocatable ? `Przydziel punkt: ${safeHtml(name)}` : `Zablokowane: ${safeHtml(name)}`}" ${skill.allocatable ? '' : 'disabled'}>${skill.allocatable ? '＋' : '·'}</button>
    </article>`;
  };
  panelBody.className = "game-panel-body skills-view";
  panelBody.innerHTML = `
    <div class="skill-tree-audit-bar"><span>${safeHtml(classNames[owner.classId])} · D2R ${safeHtml(skillTreeCatalog.installedBuild)}</span><b>MASZ ${owner.unspentSkillPoints} PKT. UMIEJĘTNOŚCI</b></div>
    <div class="skill-tree-tabs" role="tablist" aria-label="Drzewka klasy">
      ${skillTreeCatalog.treesForClass(owner.classId).map((tree) => `<button type="button" class="skill-tree-tab ${tree.page === selectedSkillTreePage ? 'active' : ''}" data-skill-tree-page="${tree.page}" role="tab" aria-selected="${tree.page === selectedSkillTreePage}">${safeHtml(tree.name?.plPLSourceForm || tree.name?.enUS || tree.sourceKey)}</button>`).join('')}
    </div>
    <div class="skill-tree-board skill-tree-class-${safeHtml(owner.classId)} skill-tree-page-${treeView.tree.page}" role="tabpanel" aria-label="${safeHtml(treeLabel)}">
      <svg class="skill-tree-links" viewBox="0 0 300 600" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="skill-tree-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>${treeLinks.map(({ source, target }) => `<path d="M ${(source.position.column - .5) * 100} ${(source.position.row) * 100 - 9} L ${(target.position.column - .5) * 100} ${(target.position.row - 1) * 100 + 9}" marker-end="url(#skill-tree-arrow)" />`).join('')}</svg>
      ${treeView.skills.map(renderNode).join('')}
    </div>
    <div class="skill-tree-footer"><span>${safeHtml(treeLabel)} · KARTA ${treeView.tree.page}/3</span><small>ŹRÓDŁO: D2R ${safeHtml(skillTreeCatalog.installedBuild)} · ${safeHtml(sourceWarning)}</small></div>
    <p class="data-warning">Każdy bohater ma niezależne punkty i poziomy. Przydział sprawdza poziom postaci oraz wyłącznie potwierdzone wymagania hard-point; punkty z przedmiotów nie otwierają prerekwizytów. Surowe zależności formuł są zachowane w audycie, ale nie są interpretowane jako dodatkowe mechaniki.</p>`;
  panelBody.querySelectorAll('[data-skill-tree-page]').forEach((button) => button.addEventListener('click', () => {
    selectedSkillTreePage = Number(button.dataset.skillTreePage);
    renderSkillsPanel();
  }));
  panelBody.querySelectorAll('[data-spend-skill]').forEach((button) => button.addEventListener('click', () => {
    spendSkillTreePoint(button.dataset.spendSkill);
  }));
  panelBody.querySelectorAll('[data-skill-icon]').forEach((image) => image.addEventListener('error', () => {
    image.hidden = true;
    image.parentElement?.classList.add('missing-icon');
  }));
  panelBody.querySelectorAll('.skill-tree-node').forEach((node) => node.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    panelBody.querySelectorAll('.skill-tree-node.expanded').forEach((other) => {
      if (other !== node) other.classList.remove('expanded');
    });
    node.classList.toggle('expanded');
  }));
}

function spendSkillTreePoint(skillId) {
  const previous = captureLiveSession();
  try {
    const candidate = buildSaveSnapshot();
    const stagedRoster = new Roster(candidate.roster);
    const stagedOwner = stagedRoster.get(inspectedCharacterId);
    const result = skillTreeCatalog.spendPoint(stagedOwner, skillId);
    candidate.roster = stagedRoster.toJSON();
    installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
    // Restaging deliberately clears the presentation actor. Restore the same
    // decision window; learning is not a turn and must not strand the battle.
    driveTimeline();
    autosaveGame('przydzieleniu punktu umiejętności');
    render();
    if (activePanel === 'skills') renderSkillsPanel();
    showToast(`${skillTreeCatalog.skill(stagedOwner.classId, skillId).localizedName?.plPL || skillId}: poziom ${result.hardPoints}.`, 'success');
  } catch (error) {
    installLiveSession(previous);
    render();
    if (activePanel === 'skills') renderSkillsPanel();
    showToast(`Nie przydzielono punktu: ${error.message}`, 'warning');
  }
}

function renderQuestPanel() {
  panelBody.className = "game-panel-body quest-view";
  if(campaign) {
    const quest=campaign.denQuestView(),atCamp=campaign.act1.currentAreaId===TOWN_ID;
    const labels={available:'Dostępne — porozmawiaj z Akarą',active:'Aktywne — oczyść Siedlisko Zła','objective-complete':'Cel wykonany — wróć do Akary','reward-claimed':'Nagroda odebrana'};
    panelBody.innerHTML=`<div class="quest-entry active"><span>AKT I</span><div><h3>Siedlisko Zła</h3><p id="den-quest-status">${labels[quest.status]}</p><p id="den-quest-progress">Pokonani przeciwnicy w Siedlisku Zła: ${quest.killed}/${quest.total} · pozostało ${quest.remaining}.</p><small>Zabójstwa na Krwawym Wrzosowisku nie realizują tego celu.</small></div></div>
      <section class="akara-dialog"><h3>Akara · Obozowisko Łotrzyc</h3><p>${atCamp?'Oczyść Siedlisko Zła, a następnie wróć po nagrodę. Kliknięcie Akary w obozie automatycznie leczy żywą aktywną drużynę i otwiera handel.':'Akara czeka w obozie. Wróć przez Krwawe Wrzosowisko.'}</p>
      <div class="options-actions"><button type="button" id="akara-accept" class="metal-button" ${!atCamp||quest.status!=='available'?'disabled':''}>PRZYJMIJ ZADANIE</button><button type="button" id="akara-claim" class="metal-button" ${!atCamp||quest.status!=='objective-complete'||!quest.eligibleHeroIds.length?'disabled':''}>ODBIERZ NAGRODĘ</button></div>
      <p>Nagroda: +1 punkt umiejętności oraz zapisane prawo do jednej darmowej zmiany specjalizacji dla każdego uprawnionego bohatera.</p>
      <p id="den-reward-recipients">Uprawnieni: ${quest.eligibleHeroIds.length?quest.eligibleHeroIds.map(id=>safeHtml(roster.has(id)?roster.get(id).name:id)).join(', '):'ustalani po oczyszczeniu Siedliska Zła'}.</p>
      <p class="data-warning">Drzewka źródłowe są dostępne w panelu UMIEJĘTNOŚCI; wykonywanie zmiany specjalizacji nie jest jeszcze wdrożone. Prawo do nagrody jest zachowane w zapisie; nowi bohaterowie go nie dziedziczą. Leczenie nie wskrzesza poległych. Stamina nie ma jeszcze własnego runtime.</p>
      ${quest.completionEvidence==='legacy-party-unavailable'?'<p class="data-warning">Starszy zapis ma oczyszczone Siedlisko Zła, lecz nie zawiera listy uprawnionych bohaterów. Nie przyznano nagrody nowym postaciom przez domysł.</p>':''}</section>`;
    panelBody.querySelector('#akara-accept').onclick=()=>akaraAction('accept');
    panelBody.querySelector('#akara-claim').onclick=()=>akaraAction('claim');
    return;
  }
  panelBody.innerHTML = `
    <div class="quest-entry"><span>TRENING</span><div><h3>Siedlisko Zła</h3><p>Starcia treningowe nie realizują zadań. Kampanię rozpoczniesz z panelu mapy.</p></div></div>`;
}

function akaraAction(action, { fromVisit = false } = {}) {
  const previous=captureLiveSession();
  try {
    if(!campaign || isPaused()
      || (activePanel !== 'quests'
        && !(fromVisit && action === 'heal' && activePanel === null && isSafeCamp()))) return false;
    const candidate=buildSaveSnapshot();
    const nextCampaign=CampaignState.restoreAct1(candidate.campaign,{catalog:equipmentCatalog});
    const nextRoster=new Roster(candidate.roster);
    let message;
    if(action==='accept') {nextCampaign.acceptDenQuest([...party.slots]);message='Akara: zadanie Siedlisko Zła jest aktywne.';}
    else if(action==='claim') {
      const awards=nextCampaign.claimDenReward(nextRoster);
      message=awards.length?'Akara: odebrano jednorazową nagrodę — punkt umiejętności i prawo do zmiany specjalizacji.':'Ta nagroda została już odebrana.';
    } else if(action==='heal') {
      const changes=nextCampaign.healAtAkara(nextRoster,[...party.slots]);
      if (fromVisit && !changes.length) return true;
      message=changes.length
        ? `Akara uleczyła: ${changes.map(({heroId})=>nextRoster.get(heroId).name).join(', ')}. Polegli pozostają polegli.`
        : 'Akara: żaden żywy bohater nie wymaga leczenia. Polegli nie są wskrzeszani.';
    }
    else throw new Error('Nieznana usługa Akary');
    candidate.campaign=nextCampaign.toJSON();candidate.roster=nextRoster.toJSON();
    installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
    combat.log.push(message);render();
    if (action === 'accept' || action === 'claim') autosaveGame('zmianie zadania');
    if (activePanel) renderPanel(activePanel);
    showToast(message);return true;
  } catch(error) {installLiveSession(previous);showToast(error.message,'warning');return false;}
}

function campItemCopy(item) {
  const definition = equipmentCatalog.get(item.canonicalId);
  return definition
    ? `${definition.displayName} · ${definition.kind === "weapon" ? `obrażenia ${definition.oneHandDamage.join("–")}` : `obrona ${item.defense ?? definition.defenseRange[0]}`}`
    : item.name;
}

function updateInventoryOwnership(ownerId) {
  roster.get(ownerId).inventoryItemIds = inventories.get(ownerId).toJSON().items.map(({ id }) => id);
  campServices.validateUniqueOwnership(inventories);
  validateEquipmentWorld(roster, inventories, equipmentCatalog);
}

function beginCampTradingSession(state) {
  state.campServices.beginSession({
    inventories: new Map([...state.inventories, ['horadric-cube', state.horadricCube.grid]]),
  });
}

function commitCampInventoryOperation(operation, { successPanel = activePanel } = {}) {
  if (!isSafeCamp()) return false;
  const ownerId = inspectedCharacterId;
  const beforeCamp = campServices.snapshot();
  const beforeInventory = inventories.get(ownerId).toJSON();
  const beforeIds = [...roster.get(ownerId).inventoryItemIds];
  try {
    const result = operation(inventories.get(ownerId));
    updateInventoryOwnership(ownerId);
    publishSaveSnapshot(buildSaveSnapshot());
    render();
    renderPanel(successPanel);
    return result;
  } catch (error) {
    campServices = CampServicesState.restore(beforeCamp, { catalog: equipmentCatalog });
    inventories.set(ownerId, InventoryGrid.fromJSON(beforeInventory));
    roster.get(ownerId).inventoryItemIds = beforeIds;
    showToast(error.message, "warning");
    render();
    renderPanel(activePanel);
    return null;
  }
}

function createCampItemGrid(width, height, className, label) {
  const grid = make("div", `d2-grid ${className}`);
  grid.style.setProperty("--d2-columns", String(width));
  grid.style.setProperty("--d2-rows", String(height));
  grid.setAttribute("aria-label", label);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = make("span", "d2-grid-cell");
      cell.style.gridColumn = String(x + 1);
      cell.style.gridRow = String(y + 1);
      grid.append(cell);
    }
  }
  return grid;
}

function placeCampGridCard(card, item, position) {
  card.classList.add("d2-grid-item");
  card.style.gridColumn = `${position.x + 1} / span ${item.width}`;
  card.style.gridRow = `${position.y + 1} / span ${item.height}`;
  return card;
}

const tradeVendorByPanel = Object.freeze({
  'camp-trade-akara': 'akara',
  'camp-charsi': 'charsi',
  'camp-gheed': 'gheed',
});

function sellCampItem(vendorId, itemId) {
  const result = commitCampInventoryOperation((inventory) => campServices.sell({
    vendorId, itemId, inventory,
  }));
  if (result) {
    selectedInventoryItem = null;
    showToast(`Sprzedano: ${result.item.name} za ${result.price} złota.`, 'success');
  }
  return Boolean(result);
}

function repairAtCharsi(itemId) {
  if (!isSafeCamp() || activePanel !== 'camp-charsi') return false;
  const previous = captureLiveSession();
  try {
    const staged = stageGameState(validateSaveEnvelope(buildSaveSnapshot()));
    const owner = staged.roster.get(inspectedCharacterId);
    const result = staged.campServices.repair({
      itemId,
      inventory: staged.inventories.get(owner.id),
      character: owner,
    });
    installLiveSession(staged);
    publishSaveSnapshot(buildSaveSnapshot());
    render();
    renderPanel(activePanel);
    showToast(`Charsi naprawiła ${result.item.name} za ${result.price} złota.`, 'success');
    return true;
  } catch (error) {
    installLiveSession(previous);
    showToast(error.message, 'warning');
    render();
    renderPanel(activePanel);
    return false;
  }
}

// Akara uses the same trade frame as Charsi, but her small supplies are spread
// across its actual cells instead of being crammed into the first two rows.
const akaraShopPositions = Object.freeze({
  scroll_identify: { x: 1, y: 1 }, scroll_town_portal: { x: 2, y: 1 },
  tome_identify: { x: 3, y: 1 }, tome_town_portal: { x: 4, y: 1 },
  potion_health_lesser: { x: 1, y: 4 }, potion_health_light: { x: 2, y: 4 },
  potion_health: { x: 3, y: 4 },
  potion_mana_lesser: { x: 1, y: 6 }, potion_mana_light: { x: 2, y: 6 },
  potion_mana: { x: 3, y: 6 },
  wand: { x: 6, y: 2 }, war_staff: { x: 8, y: 3 },
  scepter: { x: 6, y: 6 }, grand_scepter: { x: 6, y: 6 }, dagger: { x: 6, y: 6 },
});

// The player wing is always the canonical inventory. Every NPC uses the same
// merchant frame and a single, real stock grid; no category/paper-doll fork.
function renderCampTradeScaffold(vendorId) {
  const vendor = campServices.vendor(vendorId);
  renderCanonicalInventoryPanel({ empty: false });
  const merchant = make("section", "merchant-inventory-frame");
  merchant.id = "merchant-panel";
  merchant.setAttribute("role", "region");
  merchant.setAttribute("aria-label", `Towary handlarza ${vendor.displayName}`);
  const close = make("button", "merchant-inventory-close", "Zamknij handel");
  close.type = "button";
  close.setAttribute("aria-label", "Zamknij handel");
  close.addEventListener("click", closePanel);
  merchant.append(close);
  const header = make("header", "merchant-inventory-heading");
  header.append(make("h2", "", vendor.displayName));
  merchant.append(header);
  const grid = make("div", "merchant-empty-grid merchant-goods-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `100 pól oferty: ${vendor.displayName}`);
  const status = make("p", "merchant-empty-status", vendor.offers.length
    ? "Wybierz przedmiot, aby sprawdzić cenę. Przeciągnij przedmiot z plecaka tutaj, aby go sprzedać."
    : "Wszystkie towary zostały wykupione.");
  status.setAttribute("role", "status");
  for (let index = 0; index < 100; index += 1) {
    const cell = make("span", "merchant-empty-cell");
    grid.append(cell);
  }
  const layout = new InventoryGrid({ width: 10, height: 10 });
  const displayedOffers = vendorId === 'akara'
    ? [...vendor.offers].sort((a, b) => {
      const rank = offer => {
        const index = CAMP_AKARA_CORE_STOCK.indexOf(offer.item.canonicalId);
        return index < 0 ? CAMP_AKARA_CORE_STOCK.length : index;
      };
      return rank(a) - rank(b);
    })
    : vendor.offers;
  for (const offer of displayedOffers) {
    const preferred = vendorId === 'akara' ? akaraShopPositions[offer.item.canonicalId] : null;
    let position = preferred && layout.place(offer.item, preferred) ? preferred : null;
    if (!position) {
      position = findInventorySpace(layout, offer.item);
      if (!position || !layout.place(offer.item, position)) {
        throw new Error(`Brak miejsca na ofertę ${offer.displayName} w siatce ${vendor.displayName}`);
      }
    }
    const buy = make("button", "merchant-offer d2-trade-buy");
    buy.type = "button";
    buy.dataset.offerId = offer.offerId;
    buy.dataset.canonicalId = offer.item.canonicalId;
    buy.style.gridColumn = `${position.x + 1} / span ${offer.item.width}`;
    buy.style.gridRow = `${position.y + 1} / span ${offer.item.height}`;
    buy.setAttribute("aria-label", `Kup ${offer.displayName} za ${offer.buyPrice} złota`);
    buy.title = `${campItemCopy(offer.item)} · ${offer.item.width} × ${offer.item.height} · koszt ${offer.buyPrice} złota`;
    buy.innerHTML = tradeItemArtworkMarkup(offer.item.canonicalId);
    attachEquipmentTooltip(buy, offer.item, { value: offer.buyPrice, valueLabel: 'Cena zakupu' });
    buy.addEventListener("pointerenter", () => { status.textContent = buy.title; });
    buy.addEventListener("focus", () => { status.textContent = buy.title; });
    buy.addEventListener("click", () => {
      const result = commitCampInventoryOperation((inventory) => campServices.buy({
        vendorId, offerId: offer.offerId, inventory,
      }));
      if (result) showToast(`Kupiono: ${result.item.name}. Pozostało ${result.gold} złota.`, 'success');
    });
    grid.append(buy);
  }
  grid.addEventListener('dragover', event => event.preventDefault());
  grid.addEventListener('drop', event => {
    event.preventDefault();
    const payload = inventoryDragPayload(event);
    if (payload && !payload.slot) sellCampItem(vendorId, payload.id);
  });
  merchant.append(grid, status);
  const actions = make('div', 'merchant-action-bar');
  if (vendorId === 'charsi') {
    const repair = make('button', 'merchant-repair', '⚒');
    repair.type = 'button';
    repair.id = 'charsi-repair';
    repair.setAttribute('aria-label', 'Naprawa u Charsi');
    repair.title = 'Naprawa: wybierz uszkodzony przedmiot w ekwipunku';
    repair.addEventListener('click', () => {
      const owner = inspectedCharacter();
      const item = selectedInventoryEntry(owner);
      if (!item) {
        const equipment = Object.values(owner.equipment).filter(Boolean);
        const damaged = [...inventories.get(owner.id).toJSON().items, ...equipment]
          .some(entry => entry.durability < entry.maxDurability);
        status.textContent = damaged
          ? 'Wybierz uszkodzony przedmiot z plecaka lub wyposażenia, aby zobaczyć koszt naprawy.'
          : 'Brak przedmiotów wymagających naprawy. Trwałość nie zużywa się jeszcze podczas walki.';
        return;
      }
      try {
        const quote = campServices.repairQuote({
          itemId: item.id, inventory: inventories.get(owner.id), character: owner,
        });
        if (quote.price === 0) {
          status.textContent = `${item.name}: pełna trwałość ${quote.maxDurability}/${quote.maxDurability} — naprawa nie jest potrzebna.`;
          repair.dataset.confirmItemId = '';
          return;
        }
        if (repair.dataset.confirmItemId !== item.id) {
          repair.dataset.confirmItemId = item.id;
          status.textContent = `${item.name}: ${quote.durability}/${quote.maxDurability}. Naprawa kosztuje ${quote.price} złota. Kliknij młotek ponownie, aby potwierdzić.`;
          return;
        }
        repair.dataset.confirmItemId = '';
        repairAtCharsi(item.id);
      } catch (error) { status.textContent = error.message; }
    });
    actions.append(repair);
  }
  const gold = make('p', 'merchant-wallet', `ZŁOTO  ${campServices.gold}`);
  gold.setAttribute('aria-label', `Złoto: ${campServices.gold}`);
  actions.append(gold);
  merchant.append(actions);
  panelLayer.insertBefore(merchant, document.querySelector("#game-panel"));
}

function renderCampTradePanel(vendorId) {
  const owner = inspectedCharacter();
  const vendor = campServices.vendor(vendorId);
  const inventory = inventories.get(owner.id);
  panelBody.className = "game-panel-body camp-trade-view d2-trade-v0518 d2-shop-v0518";
  const ownerTabs = renderOwnerTabs();
  ownerTabs.classList.add("d2-shop-owner-tabs");
  panelBody.replaceChildren(ownerTabs);
  const columns = make("div", "d2-trade-columns d2-shop-columns");
  const vendorWing = make("section", `d2-trade-vendor d2-shop-wing d2-shop-${vendorId}`);
  const vendorHeading = make("header", "d2-shop-heading");
  vendorHeading.innerHTML = `<div class="d2-npc-portrait d2-npc-${vendorId}" aria-hidden="true"></div><div><small>OBOZOWISKO ŁOTRZYC</small><h3>${safeHtml(vendor.displayName)}</h3><p>TOWARY HANDLARZA</p></div>`;
  vendorWing.append(vendorHeading);

  // Only categories backed by actual, purchasable equipment are shown. The
  // game has no consumable/tome economy yet, so an empty "Misc" tab would lie.
  const categoryFor = (item) => vendorId === "akara"
    ? item.canonicalId
    : equipmentCatalog.get(item.canonicalId)?.kind === "armor"
      ? "armor"
      : equipmentCatalog.get(item.canonicalId)?.twoHanded ? "weapon-two" : "weapon-one";
  const categories = vendorId === "akara"
    ? [{ id: "all", label: "WSZYSTKO" }, { id: "wand", label: "RÓŻDŻKI" }, { id: "scepter", label: "BERŁA" }, { id: "grand_scepter", label: "WIELKIE BERŁA" }]
    : [{ id: "all", label: "WSZYSTKO" }, { id: "weapon-one", label: "BROŃ I" }, { id: "weapon-two", label: "BROŃ II" }, { id: "armor", label: "PANCERZE" }];
  const tabs = make("div", "d2-shop-categories");
  tabs.setAttribute("role", "tablist");
  const offers = createCampItemGrid(10, 8, "camp-offer-list d2-vendor-grid d2-shop-goods", `Towary handlarza ${vendor.displayName}`);
  const offerGrid = new InventoryGrid({ width: 10, height: 8 });
  const offerButtons = new Map();
  const reflowOffers = (categoryId) => {
    const pageGrid = new InventoryGrid({ width: 10, height: 8 });
    for (const offer of vendor.offers) {
      const button = offerButtons.get(offer.offerId);
      if (!button) continue;
      button.hidden = categoryId !== "all" && categoryFor(offer.item) !== categoryId;
      if (button.hidden) continue;
      const position = findInventorySpace(pageGrid, offer.item);
      if (position && pageGrid.place(offer.item, position)) placeCampGridCard(button, offer.item, position);
    }
  };
  const detail = make("p", "d2-shop-detail", "Wybierz towar, aby sprawdzić cenę i kupić.");
  detail.setAttribute("role", "status");
  for (const category of categories) {
    const tab = make("button", category.id === "all" ? "is-active" : "", category.label);
    tab.type = "button";
    tab.dataset.tradeCategory = category.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", category.id === "all" ? "true" : "false");
    tab.disabled = category.id !== "all" && !vendor.offers.some(offer => categoryFor(offer.item) === category.id);
    if (tab.disabled) tab.title = "Brak towarów w tej kategorii";
    tab.addEventListener("click", () => {
      for (const candidate of tabs.children) {
        const active = candidate === tab;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
      }
      reflowOffers(category.id);
      detail.textContent = `${category.label} · ${[...offers.querySelectorAll("[data-category]:not([hidden])")].length} towarów`;
    });
    tabs.append(tab);
  }
  vendorWing.append(tabs);
  for (const offer of vendor.offers) {
    const position = findInventorySpace(offerGrid, offer.item);
    if (!position || !offerGrid.place(offer.item, position)) continue;
    const buy = make("button", "d2-trade-item d2-trade-buy");
    buy.type = "button";
    buy.dataset.category = categoryFor(offer.item);
    buy.dataset.canonicalId = offer.item.canonicalId;
    buy.disabled = campServices.gold < offer.buyPrice;
    buy.setAttribute("aria-label", `Kup ${offer.displayName} za ${offer.buyPrice} złota`);
    buy.title = `${campItemCopy(offer.item)} · ${offer.buyPrice} złota`;
    buy.innerHTML = tradeItemArtworkMarkup(offer.item.canonicalId);
    attachEquipmentTooltip(buy, offer.item, { value: offer.buyPrice, valueLabel: 'Cena zakupu' });
    buy.addEventListener("pointerenter", () => { detail.textContent = buy.title; });
    buy.addEventListener("focus", () => { detail.textContent = buy.title; });
    buy.addEventListener("click", () => {
      const result = commitCampInventoryOperation((targetInventory) => campServices.buy({
        vendorId,
        offerId: offer.offerId,
        inventory: targetInventory,
      }));
      if (result) showToast(`Kupiono: ${result.item.name}. Pozostało ${result.gold} złota.`, "success");
    });
    offerButtons.set(offer.offerId, buy);
    offers.append(placeCampGridCard(buy, offer.item, position));
  }
  reflowOffers("all");
  vendorWing.append(offers, detail);
  if (!vendor.offers.length) detail.textContent = "Towary zostały wykupione.";
  const backpackWing = make("section", "d2-trade-pack d2-shop-wing d2-shop-player");
  const playerHeading = make("header", "d2-shop-heading d2-shop-player-heading");
  playerHeading.innerHTML = `<div class="d2-shop-crest" aria-hidden="true">◇</div><div><small>TWOJA POSTAĆ</small><h3>${safeHtml(owner.name)}</h3><p>PLECAK · SPRZEDAŻ</p></div>`;
  backpackWing.append(playerHeading);
  const paperDoll = make("section", "d2-shop-paperdoll");
  paperDoll.setAttribute("aria-label", `Założone wyposażenie ${owner.name} — tylko podgląd`);
  const compactSlotLabels = { weapon: "BROŃ", offhand: "TARCZA", head: "GŁOWA", chest: "PANCERZ", hands: "RĘCE", belt: "PAS", feet: "BUTY" };
  for (const slot of EQUIPMENT_SLOTS) {
    const item = owner.equipment[slot];
    const slotView = make("div", `d2-shop-equip-slot${item ? " is-equipped" : ""}`);
    slotView.dataset.slot = slot;
    if (item) slotView.dataset.itemId = item.id;
    slotView.setAttribute("aria-label", item ? `${equipmentSlotLabels[slot]}: ${item.name}` : `${equipmentSlotLabels[slot]}: puste`);
    slotView.title = item ? `${equipmentSlotLabels[slot]} · ${item.name}` : `${equipmentSlotLabels[slot]} · puste`;
    if (item) slotView.innerHTML = tradeItemArtworkMarkup(item.canonicalId);
    else slotView.append(make("span", "d2-shop-slot-name", compactSlotLabels[slot]));
    if (item) attachEquipmentTooltip(slotView, item);
    paperDoll.append(slotView);
  }
  backpackWing.append(paperDoll);
  const sellList = createCampItemGrid(10, 4, "camp-sell-list d2-backpack-grid d2-shop-backpack", `Plecak ${owner.name} do sprzedaży`);
  const backpackItems = inventory.toJSON().items;
  for (const item of backpackItems) {
    const sellable = Boolean(equipmentCatalog.get(item.canonicalId)
      || CAMP_SUPPLY_DEFINITIONS.some(supply => supply.id === item.canonicalId));
    const sell = make("button", "d2-trade-item d2-trade-sell");
    sell.type = "button";
    sell.disabled = !sellable;
    sell.dataset.canonicalId = item.canonicalId ?? "unknown";
    sell.setAttribute("aria-label", sellable ? `Sprzedaj ${item.name}` : `${item.name} — nie na sprzedaż`);
    sell.title = `${campItemCopy(item)}${sellable ? " · sprzedaj" : " · nie na sprzedaż"}`;
    sell.innerHTML = tradeItemArtworkMarkup(item.canonicalId);
    attachEquipmentTooltip(sell, item, { value: campServices.quoteSell({ item }), valueLabel: 'Cena sprzedaży' });
    sell.addEventListener("pointerenter", () => { detail.textContent = sell.title; });
    sell.addEventListener("focus", () => { detail.textContent = sell.title; });
    sell.addEventListener("click", () => {
      const result = commitCampInventoryOperation((targetInventory) => campServices.sell({ vendorId, itemId: item.id, inventory: targetInventory }));
      if (result) showToast(`Sprzedano: ${result.item.name} za ${result.price} złota.`, "success");
    });
    sellList.append(placeCampGridCard(sell, item, item.position));
  }
  backpackWing.append(sellList);
  const wallet = make("div", "d2-shop-wallet");
  wallet.innerHTML = `<span aria-hidden="true">◈</span> ZŁOTO <strong>${campServices.gold}</strong>`;
  backpackWing.append(wallet);
  if (!backpackItems.length) backpackWing.append(make("p", "d2-shop-empty", "Plecak jest pusty."));
  columns.append(vendorWing, backpackWing);
  panelBody.append(columns);
}

function renderCampStashPanel() {
  hideItemTooltip();
  const owner = inspectedCharacter();
  const inventory = inventories.get(owner.id);
  panelBody.className = "game-panel-body loot-view camp-stash-view d2-stash-v0518";
  panelBody.replaceChildren(renderOwnerTabs());
  const columns = make("div", "d2-storage-columns");
  const stashWing = make("section", "d2-stash-wing");
  stashWing.append(make("h3", "d2-wing-heading", "WSPÓLNA SKRYTKA · 10 × 8"));
  const stash = createCampItemGrid(10, 8, "d2-stash-grid", "Wspólna skrytka");
  for (const item of campServices.stash.toJSON().items) {
    const row = make("article", "loot-row");
    row.setAttribute("aria-label", `${item.name}, ${item.width} × ${item.height}`);
    const art = make("span", "d2-stash-item-art");
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = tradeItemArtworkMarkup(item.canonicalId);
    const name = make("span", "d2-stash-item-name", item.name);
    const move = make("button", "metal-button", "→");
    move.type = "button";
    move.setAttribute("aria-label", `Przenieś ${item.name} ze skrytki do plecaka ${owner.name}`);
    move.title = `Do plecaka · ${item.name}`;
    move.addEventListener("click", () => {
      const result = commitCampInventoryOperation((targetInventory) => campServices.transferFromStash({ itemId: item.id, inventory: targetInventory }));
      if (result) showToast(`Wyjęto ze skrytki: ${result.item.name}.`, "success");
    });
    row.append(art, name, move);
    attachEquipmentTooltip(row, item, { value: safeItemSellValue(item), valueLabel: 'Wartość u handlarza' });
    stash.append(placeCampGridCard(row, item, item.position));
  }
  stashWing.append(stash);
  if (!campServices.stash.toJSON().items.length) stashWing.append(make("p", "loot-empty", "Skrytka jest pusta."));
  const backpackWing = make("section", "d2-stash-backpack-wing");
  backpackWing.append(make("h3", "d2-wing-heading", `PLECAK · ${owner.name.toUpperCase()}`));
  const backpack = createCampItemGrid(10, 4, "d2-backpack-grid", "Plecak bohatera");
  for (const item of inventory.toJSON().items) {
    const row = make("article", "loot-row");
    row.setAttribute("aria-label", `${item.name}, ${item.width} × ${item.height}`);
    const art = make("span", "d2-stash-item-art");
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = tradeItemArtworkMarkup(item.canonicalId);
    const name = make("span", "d2-stash-item-name", item.name);
    const move = make("button", "metal-button", "←");
    move.type = "button";
    move.setAttribute("aria-label", `Przenieś ${item.name} do skrytki`);
    move.title = `Do skrytki · ${item.name}`;
    move.addEventListener("click", () => {
      const result = commitCampInventoryOperation((targetInventory) => campServices.transferToStash({ itemId: item.id, inventory: targetInventory }));
      if (result) showToast(`Przeniesiono do skrytki: ${result.item.name}.`, "success");
    });
    row.append(art, name, move);
    attachEquipmentTooltip(row, item, { value: safeItemSellValue(item), valueLabel: 'Wartość u handlarza' });
    backpack.append(placeCampGridCard(row, item, item.position));
  }
  backpackWing.append(backpack);
  if (!inventory.toJSON().items.length) backpackWing.append(make("p", "loot-empty", "Plecak jest pusty."));
  columns.append(stashWing, backpackWing);
  panelBody.append(columns);
}

function renderCainIdentifyPanel() {
  const owner = inspectedCharacter();
  const remaining = unidentifiedItems(inventories.get(owner.id)).length;
  panelBody.className = "game-panel-body camp-dialogue-view d2-cain-identify";
  panelBody.innerHTML = `
    <section class="d2-cain-identify-inner" aria-label="Usługa Deckarda Caina">
      <img src="/app/assets/npc-cain-v0517.png" alt="Deckard Cain">
      <div class="d2-cain-identify-copy">
        <span class="overline">OBOZOWISKO ŁOTRZYC</span>
        <h3>Deckard Cain</h3>
        <p>Identyfikacja przedmiotów w plecaku postaci: <strong>${safeHtml(owner.name)}</strong>.</p>
        <button type="button" id="cain-identify" class="metal-button">Identyfikuj</button>
        <p id="cain-identify-status" role="status">${remaining ? `Niezidentyfikowane przedmioty: ${remaining}.` : 'Brak niezidentyfikowanych przedmiotów w tym plecaku.'}</p>
      </div>
    </section>`;
  panelBody.querySelector("#cain-identify").addEventListener("click", () => {
    if (!isSafeCamp()) return;
    if (!unidentifiedItems(inventories.get(owner.id)).length) {
      panelBody.querySelector("#cain-identify-status").textContent = "Brak przedmiotów do identyfikacji.";
      return;
    }
    const result = commitCampInventoryOperation(
      inventory => identifyBackpackItems(inventory),
      { successPanel: "camp-cain" },
    );
    if (result) {
      panelBody.querySelector("#cain-identify-status").textContent =
        `Zidentyfikowano ${result.identifiedCount} ${result.identifiedCount === 1 ? 'przedmiot' : 'przedmiotów'}.`;
    }
  });
}

function renderCampDialoguePanel(kind) {
  if (kind === "camp-cain") { renderCainIdentifyPanel(); return; }
  panelBody.className = "game-panel-body quest-view camp-dialogue-view";
  const definitions = {
    "camp-kashya": ["Kashya", "Łotrzyce strzegą obozu, ale rozbudowany system najemników nie jest jeszcze wdrożony.", "ZARZĄDZAJ DRUŻYNĄ"],
    "camp-warriv": ["Warriv", "Droga na wschód pozostaje zamknięta. Akt II nie został odblokowany; obecna wyprawa prowadzi przez Krwawe Wrzosowisko.", null],
  };
  const [name, copy, action] = definitions[kind];
  panelBody.innerHTML = `<section class="akara-dialog"><h3>${name}</h3><p>${copy}</p></section>`;
  if (action) {
    const button = make("button", "metal-button", action);
    button.type = "button";
    button.addEventListener("click", () => { closePanel(); openTeamSelection(); });
    panelBody.append(button);
  }
}

function renderCampWaypointPanel() {
  panelBody.className = "game-panel-body map-view camp-waypoint-view";
  const currentId = campaign.act1.currentAreaId;
  const current = act1Area(currentId);
  const activated = Object.keys(campaign.waypoints).filter((id) => campaign.waypoints[id] === true && ACT1_EXPLORATION_AREAS[id]?.waypoint);
  panelBody.innerHTML = `<section class="akara-dialog"><h3>Punkt nawigacyjny · ${safeHtml(current.label)}</h3><p>Podróż jest dostępna wyłącznie między naprawdę aktywowanymi punktami. Nieodkryte lokacje nie są dopisywane.</p></section>`;
  const list = make("div", "loot-list");
  for (const id of activated) {
    const area = act1Area(id);
    const row = make("article", "loot-row");
    const copy = make("div");
    copy.append(make("h3", "", area.label), make("p", "", id === currentId ? "Bieżąca lokacja" : "Aktywowany punkt docelowy"));
    const travel = make("button", "metal-button", id === currentId ? "JESTEŚ TUTAJ" : "PRZENIEŚ");
    travel.type = "button";
    travel.disabled = id === currentId;
    travel.addEventListener("click", () => travelCampaignWaypoint(id));
    row.append(make("span", "loot-icon", "✧"), copy, travel);
    list.append(row);
  }
  if (!activated.length) list.append(make("p", "loot-empty", "Nie aktywowano jeszcze żadnego punktu nawigacyjnego."));
  const activate = make("button", "metal-button", campaign.waypoints[currentId] ? "BIEŻĄCY WAYPOINT AKTYWNY" : "AKTYWUJ BIEŻĄCY WAYPOINT");
  activate.type = "button";
  activate.disabled = campaign.waypoints[currentId] === true || !current.waypoint;
  activate.addEventListener("click", activateExplorationWaypoint);
  panelBody.append(list, activate);
}

function travelCampaignWaypoint(areaId) {
  const previous = captureLiveSession();
  try {
    const next = CampaignState.restoreAct1(campaign.toJSON(), { catalog: equipmentCatalog });
    if (next.act1.currentAreaId === TOWN_ID && activePanel === "camp-waypoint") {
      approachCurrentAreaWaypoint(next);
    }
    next.travelViaWaypoint(areaId);
    const candidate = buildSaveSnapshot();
    candidate.campaign = next.toJSON();
    candidate.loot = visibleLootMarker(next);
    installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
    closePanel();
    autosaveGame('podróży waypointem');
    render();
    showToast(`Waypoint: ${act1Area(areaId).label}. Zasoby zachowane.`, "success");
    return true;
  } catch (error) {
    installLiveSession(previous);
    showToast(error.message, "warning");
    return false;
  }
}

function approachCurrentAreaWaypoint(nextCampaign) {
  const world = nextCampaign.act1;
  const map = nextCampaign.act1ExplorationMap();
  const waypoint = map.points.find((point) => point.kind === "waypoint");
  if (!waypoint) throw new Error("Ta lokacja nie ma waypointu");
  const path = shortestSectorPath(map, world.exploration.currentSectorId, waypoint.sectorId);
  if (!path) throw new Error("Nie można dojść do waypointu w bieżącej lokacji");
  for (const sectorId of path.slice(1)) {
    const exploration = nextCampaign.act1.exploration;
    nextCampaign.moveAct1Sector(sectorId, {
      expectedAreaId: nextCampaign.act1.currentAreaId,
      expectedSectorId: exploration.currentSectorId,
      expectedSequence: exploration.movementSequence,
    });
  }
  return waypoint;
}

function renderMapPanel() {
  panelBody.className = "game-panel-body map-view";
  if (!campaign) {
    panelBody.innerHTML = '<h3>Tryb treningowy</h3><p>Powtarzalne starcie nie zalicza zadania kampanii. Bohaterowie i wyposażenie pozostają Twoi.</p><button type="button" id="begin-campaign" class="metal-button">ROZPOCZNIJ POCZĄTEK AKTU I</button>';
    const canStartCampaign=(battlePreparation.phase===BATTLE_PHASE.COMPLETED
      || (battlePreparation.phase===BATTLE_PHASE.PREPARATION && battlePreparation.encounterNumber===1 && combat.commandSequence===0))
      && groundDrops(encounterProgress).length===0;
    panelBody.querySelector('#begin-campaign').disabled = !canStartCampaign;
    if(!canStartCampaign) panelBody.append(make('p','data-warning','Najpierw zakończ trening i zbierz pozostawiony łup. Kampania zachowa bohaterów oraz wszystkie zdobyte przedmioty.'));
    panelBody.querySelector('#begin-campaign').onclick = () => {
      if (!canStartCampaign) return;
      campaign = new CampaignState({ worldSeed: crypto.getRandomValues(new Uint32Array(1))[0] }); loot = null; clearTargeting(false); render(); renderMapPanel();
    };
    return;
  }
  const area = act1Area(campaign.act1.currentAreaId);
  document.querySelector('#panel-context').textContent=`Akt I · ${area.label}`;
  const { map, sectors } = campaign.act1ExplorationView();
  const exploration = campaign.act1.exploration;
  const current = sectors.find(sector => sector.current);
  const discovered = sectors.filter(sector => sector.discovered);
  const byId = new Map(sectors.map(sector => [sector.id, sector]));
  const naturalLandscape = hasLandscape(area.id);
  document.querySelector('#game-panel').classList.toggle('sanctuary-map',naturalLandscape);
  if(naturalLandscape) {
    document.querySelector('#panel-title').textContent=area.label;
    document.querySelector('#panel-context').textContent='AKT I · MAPA EKSPLORACJI';
  } else document.querySelector('#panel-title').textContent='MAPA EKSPLORACJI';
  const point = sector => landscapePoint(area.id,sector);
  const currentPoint = naturalLandscape && exploration.currentPosition
    ? exploration.currentPosition : point(current);
  const leaderClassId = roster.get(party.slots[0]).classId;
  const worldWidth = (map.bounds.maxX - map.bounds.minX + 1) * (naturalLandscape?168:76)+(naturalLandscape?160:0);
  const worldHeight = (map.bounds.maxY - map.bounds.minY + 1) * (naturalLandscape?132:58)+(naturalLandscape?160:0);
  const fitScale=Math.max(.18,Math.min(1.15,850/worldWidth,460/worldHeight));
  if (!explorationCameraByArea.has(area.id)) explorationCameraByArea.set(area.id, {
    scale: naturalLandscape?(area.id==='act1.den_of_evil'?1.65:1.25):Math.max(.62,fitScale), fitScale, offsetX: 0, offsetY: 0,
  });
  const camera = explorationCameraByArea.get(area.id);
  camera.fitScale=fitScale;
  const transform = `translate(${500 + camera.offsetX} ${275 + camera.offsetY}) scale(${camera.scale}) translate(${-currentPoint.x} ${-currentPoint.y})`;
  const discoveredIds = new Set(discovered.map(sector => sector.id));
  const frontierTargets = sectors.filter(sector => sector.reachable && !sector.discovered);
  const frontierIndex = new Map(frontierTargets.map((sector, index) => [sector.id, index]));
  const corridors = map.edges.map(edge => {
    const a = byId.get(edge.a), b = byId.get(edge.b), pa = point(a), pb = point(b);
    if (discoveredIds.has(a.id) && discoveredIds.has(b.id)) {
      return `<path class="exploration-passage ${edge.kind}" d="M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}"/>`;
    }
    const frontier = a.current && b.reachable ? [pa,pb] : b.current && a.reachable ? [pb,pa] : null;
    if (!frontier) return '';
    const end={x:frontier[0].x+(frontier[1].x-frontier[0].x)*.55,y:frontier[0].y+(frontier[1].y-frontier[0].y)*.55};
    return `<path class="exploration-passage frontier" d="M ${frontier[0].x} ${frontier[0].y} L ${end.x} ${end.y}"/>`;
  }).join('');
  const sectorMarkup = sectors.map(sector => {
    const p=point(sector);
    if (!sector.discovered) return sector.reachable
      ? `<g class="exploration-sector fog reachable" data-frontier-index="${frontierIndex.get(sector.id)}" transform="translate(${p.x} ${p.y})"><circle r="13"/></g>` : '';
    const encounter = sector.encounter;
    const icon = encounter ? (encounter.status==='completed'?'✓':encounter.status==='active'?'⚔':'!')
      : sector.points.some(item=>item.kind==='waypoint')?'◈'
        : sector.exits.length?'↗':'';
    const organic=['field','forest','marsh','cemetery','ruins'].includes(area.profile);
    const ground=organic
      ? `<path class="sector-ground" d="${[
        'M-31-7 Q-27-20-12-22 L17-20 Q31-16 32-3 Q31 15 17 21 L-14 22 Q-29 18-33 6Z',
        'M-29-12 Q-18-24 2-21 L22-18 Q34-8 29 8 Q25 22 6 21 L-20 18 Q-35 8-29-12Z',
        'M-32-4 Q-29-19-9-22 L20-17 Q34-8 30 9 Q20 23 1 20 L-23 17 Q-35 8-32-4Z',
        'M-27-15 Q-11-23 8-20 L27-13 Q34 2 25 17 Q8 24-12 20 L-31 10 Q-35-3-27-15Z',
      ][sector.variant]}"/>`
      : '<rect class="sector-ground" x="-31" y="-22" width="62" height="44" rx="5"/>';
    return `<g class="exploration-sector discovered v${sector.variant}${sector.current?' current':''}${sector.reachable?' reachable':''}" data-sector-id="${sector.id}" transform="translate(${p.x} ${p.y})">
      ${ground}
      <path class="sector-detail" d="M-21 ${-9+sector.variant*3} Q0 ${-17+sector.variant*2} 22 ${-7+sector.variant} M-19 ${9-sector.variant} Q3 ${16-sector.variant} 21 ${8-sector.variant}"/>
      ${icon?`<text class="sector-icon" y="5">${icon}</text>`:''}
    </g>`;
  }).join('');
  const currentExitButtons = current.exits.map(exit => {
    const target=act1Area(exit.targetAreaId),locked=exit.accessRule!=='open'||Boolean(exploration.activeBattle)||current.encounter?.status==='available';
    const targetLabel=explorationTransitionLabel(area.id,exit.targetAreaId);
    return `<button type="button" class="metal-button" data-area-exit="${exit.targetAreaId}" ${locked?'disabled':''}>${locked?'ZABLOKOWANE':safeHtml(targetLabel)}</button>`;
  }).join('');
  const waypoint = current.points.find(item=>item.kind==='waypoint');
  const waypointActive = waypoint && campaign.act1.exploration.areaStates[area.id].activatedWaypointIds.includes(waypoint.id);
  const currentEncounter=current.encounter;
  const landscape=renderExplorationLandscape({map,sectors});
  const decisions=area.id!=='act1.blood_moor'&&isTravelFork(area.id,sectors,map.edges)
    ? travelDecisions(area.id,sectors,map.edges):[];
  const travelRoutePreviews=naturalLandscape?decisions.map((option,index)=>{
    const first=byId.get(option.routeSectorIds[0]);
    const routePoints=[current,...option.routeSectorIds.map(id=>byId.get(id)).filter(Boolean)].map(point);
    const points=first?.discovered?routePoints:[currentPoint,{
      x:currentPoint.x+(point(first).x-currentPoint.x)*.55,
      y:currentPoint.y+(point(first).y-currentPoint.y)*.55,
    }];
    return `<path class="travel-route-preview" data-travel-route-preview="${index}" d="M ${points.map(({x,y})=>`${x} ${y}`).join(' L ')}" marker-end="url(#travel-route-arrow)" aria-hidden="true"/>`;
  }).join(''):'';
  const decisionMarkup=decisions.length?`<nav class="travel-decisions" aria-label="Decyzje podróży"><div class="travel-caption">Rozwidlenie<small>Wybierz kierunek. Mgła nie zdradza, co jest dalej.</small></div><div class="travel-cards">${decisions.map((option,index)=>`<button type="button" class="travel-card" data-travel-option="${index}"><span class="travel-direction">${option.number} · ${option.direction}</span><strong>${option.title}</strong><small>${option.detail} · ${option.segmentDetail}</small></button>`).join('')}</div></nav>`:'';
    const landscapeDetail = area.id==='act1.blood_moor'
      ? 'Dzikie pogranicze · mokra ziemia i wrzosy'
      : area.profile==='cave' ? 'Skalne komory · ziemia, rumowisko i wąskie korytarze'
        : area.profile==='crypt'||area.profile==='catacombs' ? 'Kamienne grobowce · krypty, płyty i korytarze'
          : area.profile==='tower' ? 'Kamienne piętra · schody, krużganki i wieża'
            : area.profile==='jail' ? 'Więzienne korytarze · cele i kamienne przejścia'
              : 'Kamienne krużganki · sale i przejścia klasztoru';
    panelBody.innerHTML = `<div class="exploration-layout">
    <section class="exploration-map-shell${naturalLandscape?' natural-landscape':''}" data-profile="${area.profile}">
      <div class="exploration-toolbar"><div><h3 id="current-area">${naturalLandscape?(area.id==='act1.blood_moor'?'Szlaki Krwawego Wrzosowiska':safeHtml(area.label)):safeHtml(area.label)}</h3><small>${naturalLandscape?safeHtml(landscapeDetail):`${safeHtml(area.sourceName)} · ${map.sectors.length} sektorów`}</small></div><div><button type="button" id="map-zoom-out" aria-label="Oddal mapę">−</button><button type="button" id="map-fit">CAŁA MAPA</button><button type="button" id="map-center">DRUŻYNA</button><button type="button" id="map-zoom-in" aria-label="Przybliż mapę">+</button></div></div>
      <svg id="exploration-map" class="exploration-map" viewBox="0 0 1000 550" role="application" aria-label="Mapa terenu ${safeHtml(area.label)}">
        <defs><filter id="map-glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><marker id="travel-route-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z"/></marker></defs>
        ${landscape?.defs??''}<rect class="map-fog" width="1000" height="550"/>
        <g id="exploration-world" transform="${transform}">${landscape?.markup??corridors+sectorMarkup}${travelRoutePreviews}
          <g class="party-map-marker" transform="translate(${currentPoint.x} ${currentPoint.y})" aria-label="Pozycja drużyny"><ellipse class="party-map-shadow" cy="2" rx="11" ry="4"/>${explorationWalkerMarkup(leaderClassId)}</g>
        </g>
      </svg>
      ${area.id==='act1.blood_moor'&&currentEncounter?.status==='available'?`<div class="map-encounter-callout" role="alert" aria-live="assertive"><strong>SPOTKANIE${currentEncounter.encounterKind==='champion'?' · CHAMPION':''}</strong><span>${safeHtml(currentEncounter.label??'Grupa przeciwników')} zatrzymała drużynę.</span><button type="button" id="start-map-encounter" class="metal-button">ROZPOCZNIJ WALKĘ</button></div>`:''}
      ${decisionMarkup}
      <p class="exploration-hint">${area.id==='act1.blood_moor'?'Kliknij dowolny przechodni punkt terenu · przeciągnij: przesuń mapę · kółko: przybliż/oddal':'Kliknij sąsiednie miejsce lub dalszy punkt na odkrytej drodze · przeciągnij: przesuń mapę · kółko: przybliż/oddal'}</p>
    </section>
    <aside class="exploration-info"><span class="overline">${naturalLandscape?'Kronika wyprawy':'BIEŻĄCY SEKTOR'}</span><h3>${naturalLandscape?(area.id==='act1.blood_moor'?(current.exits.some(e=>e.targetAreaId==='act1.den_of_evil')?'U wejścia do Siedliska Zła':'Na Krwawym Wrzosowisku'):safeHtml(area.label)):current.id.replace('sector-','Sektor ')}</h3>
      ${naturalLandscape?`<p class="map-location-copy">${area.id==='act1.blood_moor'?'Za palisadą obozu ścieżki nikną w wilgotnej trawie.':area.profile==='cave'?'Surowe skalne komory łączą się wąskimi przejściami. Światło gaśnie kilka kroków dalej.':area.profile==='crypt'||area.profile==='catacombs'?'Kamienne płyty, grobowce i sklepione korytarze giną w ciemności.':area.profile==='tower'?'Schody prowadzą między kamiennymi piętrami Wieży Zapomnienia.':area.profile==='jail'?'Cele i kamienne przejścia tworzą labirynt więziennych poziomów.':'Krużganki, kamienne sale i przejścia prowadzą w głąb klasztoru.'}</p>`:''}
      <p class="map-discovery">Odkryto <b>${discovered.length}${naturalLandscape?'':`/${sectors.length}`}</b> ${naturalLandscape?'obszarów':'sektorów'}. ${exploration.activeBattle?'Trwa walka — mapa jest tylko podglądem.':naturalLandscape?'Jasne ślady wskazują dostępne przejścia.':'Podświetlone kierunki są legalnymi przejściami.'}</p>
      ${currentEncounter?`<div class="map-status ${currentEncounter.status}"><b>${currentEncounter.encounterKind==='champion'?'CHAMPION · MOCNIEJSZA GRUPA':currentEncounter.encounterKind==='normal'?'SPOTKANIE':'SPOTKANIE'}</b><span>${currentEncounter.status==='completed'?'zakończone':currentEncounter.status==='active'?'rozpoczęte':'dostępne'}</span></div>`:'<div class="map-status empty"><b>TEREN</b><span>brak spotkania</span></div>'}
      ${area.id!=='act1.blood_moor'&&currentEncounter?.status==='available'?`<button type="button" id="start-map-encounter" class="metal-button">${currentEncounter.encounterKind==='champion'?'ROZPOCZNIJ WALKĘ · CHAMPION':'ROZPOCZNIJ WALKĘ'}</button>`:''}
      ${waypoint?`<button type="button" id="activate-waypoint" class="metal-button" ${waypointActive?'disabled':''}>${waypointActive?'WAYPOINT AKTYWNY':'AKTYWUJ WAYPOINT'}</button>`:''}
      <div class="map-exits">${currentExitButtons}</div>
      ${area.profile==='camp'?'<button type="button" class="metal-button" id="map-akara">DZIENNIK ZADAŃ</button>':''}
      ${visibleGroundDrops().length?'<button type="button" class="metal-button" id="map-loot">ŁUP PO WALCE</button>':''}
      <details class="act-overview"><summary>Połączenia Aktu I</summary><p>${Object.values(ACT1_EXPLORATION_AREAS).filter(entry=>campaign.act1.visitedAreaIds.includes(entry.id)).map(entry=>safeHtml(entry.label)).join(' · ')}</p></details>
      <p class="data-warning">${naturalLandscape?(area.id==='act1.den_of_evil'?'Wyjście prowadzi z powrotem na Krwawe Wrzosowisko.':current.exits.some(exit=>exit.targetAreaId==='act1.den_of_evil')?'Odkryto boczne wejście. Możesz je zbadać albo kontynuować szlak.':'Nieznane odnogi odsłonią się podczas wyprawy.'):area.contentStatus==='map-ready-content-not-implemented'?'Mapa jest dostępna; przeciwnicy, zadania i boss tej lokacji wymagają osobnego etapu.':'Stan mapy i działających spotkań jest zapisany w świecie.'}</p>
    </aside></div>`;
  wireExplorationMap({ areaId:area.id, sectorId:current.id, sequence:exploration.movementSequence },frontierTargets);
  const decisionIdentity={areaId:area.id,sectorId:current.id,sequence:exploration.movementSequence};
  for(const [index,option] of decisions.entries()) {
    const card=panelBody.querySelector(`[data-travel-option="${index}"]`);
    const marker=frontierIndex.has(option.sectorId)
      ? panelBody.querySelector(`[data-frontier-index="${frontierIndex.get(option.sectorId)}"]`)
      : panelBody.querySelector(`[data-sector-id="${option.sectorId}"]`);
    const routePreview=panelBody.querySelector(`[data-travel-route-preview="${index}"]`);
    if(marker&&byId.get(option.sectorId)?.discovered) {
      const badge=document.createElementNS('http://www.w3.org/2000/svg','text');
      badge.setAttribute('class','travel-map-number');badge.setAttribute('y','-27');badge.textContent=option.number;marker.append(badge);
    }
    card.addEventListener('click',()=>moveExplorationRoute(option.routeSectorIds,decisionIdentity));
    const preview=active=>{
      marker?.classList.toggle('decision-focus',active);
      routePreview?.classList.toggle('is-route-preview-active',active);
    };
    for(const event of ['mouseenter','focus'])card.addEventListener(event,()=>preview(true));
    for(const event of ['mouseleave','blur'])card.addEventListener(event,()=>preview(false));
  }
  panelBody.querySelectorAll('[data-area-exit]').forEach(button=>button.addEventListener('click',()=>travelExplorationExit(button.dataset.areaExit)));
  panelBody.querySelector('#start-map-encounter')?.addEventListener('click',beginCurrentExplorationEncounter);
  panelBody.querySelector('#activate-waypoint')?.addEventListener('click',activateExplorationWaypoint);
  panelBody.querySelector('#map-akara')?.addEventListener('click',()=>openPanel('quests'));
  panelBody.querySelector('#map-loot')?.addEventListener('click',()=>openPanel('loot'));
}

function mapTransform() {
  const world=panelBody.querySelector('#exploration-world');
  if(!world||!campaign)return;
  const {map,sectors}=campaign.act1ExplorationView(),current=sectors.find(sector=>sector.current);
  const camera=explorationCameraByArea.get(map.areaId);
  const point=campaign.act1.exploration.currentPosition ?? landscapePoint(map.areaId,current);
  world.setAttribute('transform',`translate(${500+camera.offsetX} ${275+camera.offsetY}) scale(${camera.scale}) translate(${-point.x} ${-point.y})`);
}

function wireExplorationMap(identity, frontierTargets = []) {
  const svg=panelBody.querySelector('#exploration-map'),camera=explorationCameraByArea.get(identity.areaId);
  if(!svg||!camera)return;
  const zoom=delta=>{camera.scale=Math.max(.18,Math.min(2.4,camera.scale*delta));mapTransform();};
  panelBody.querySelector('#map-zoom-in').onclick=()=>zoom(1.2);
  panelBody.querySelector('#map-zoom-out').onclick=()=>zoom(1/1.2);
  panelBody.querySelector('#map-fit').onclick=()=>{
    camera.scale=camera.fitScale;
    if(!hasLandscape(identity.areaId)){camera.offsetX=0;camera.offsetY=0;mapTransform();return;}
    const {map,sectors}=campaign.act1ExplorationView();
    const current=campaign.act1.exploration.currentPosition
      ?? landscapePoint(map.areaId,sectors.find(s=>s.current));
    const center=landscapePoint(map.areaId,{x:(map.bounds.minX+map.bounds.maxX)/2,y:(map.bounds.minY+map.bounds.maxY)/2});
    camera.offsetX=(current.x-center.x)*camera.scale;camera.offsetY=(current.y-center.y)*camera.scale;mapTransform();
  };
  panelBody.querySelector('#map-center').onclick=()=>{if(hasLandscape(identity.areaId))camera.scale=identity.areaId==='act1.den_of_evil'?1.65:1.25;camera.offsetX=0;camera.offsetY=0;mapTransform();};
  svg.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?1.12:1/1.12);},{passive:false});
  svg.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    explorationGesture={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,dragged:false,target:event.target.closest('[data-sector-id]')?.dataset.sectorId??null,identity};
  });
  svg.addEventListener('pointermove',event=>{
    if(!explorationGesture||event.pointerId!==explorationGesture.pointerId)return;
    const dx=event.clientX-explorationGesture.lastX,dy=event.clientY-explorationGesture.lastY;
    if(!explorationGesture.dragged&&Math.hypot(event.clientX-explorationGesture.startX,event.clientY-explorationGesture.startY)>6){
      explorationGesture.dragged=true;
      try { svg.setPointerCapture(event.pointerId); } catch { /* synthetic UI regression event */ }
    }
    if(explorationGesture.dragged){camera.offsetX+=dx;camera.offsetY+=dy;mapTransform();}
    explorationGesture.lastX=event.clientX;explorationGesture.lastY=event.clientY;
  });
  const finish=event=>{
    if(!explorationGesture||event.pointerId!==explorationGesture.pointerId)return;
    const gesture=explorationGesture;explorationGesture=null;
    if(gesture.dragged){explorationSuppressClick=true;setTimeout(()=>{explorationSuppressClick=false;},0);}
  };
  svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',()=>{explorationGesture=null;});
  svg.addEventListener('click',async event=>{
    if(explorationSuppressClick){explorationSuppressClick=false;return;}
    const mapExit=event.target.closest('[data-landmark-exit]');
    if(mapExit) {
      const targetAreaId=mapExit.dataset.landmarkExit,sectorId=mapExit.dataset.sectorId;
      if(campaign?.act1?.exploration?.currentSectorId===sectorId) {
        travelExplorationExit(targetAreaId);
        return;
      }
      if(identity.areaId==='act1.blood_moor') {
        await moveExplorationOpenTerrain({x:Number(mapExit.dataset.targetX),y:Number(mapExit.dataset.targetY)},identity);
      } else {
        const sector=campaign?.act1ExplorationView().sectors.find(item=>item.id===sectorId);
        if(sector?.reachable) await moveExplorationSector(sectorId,identity);
        else if(sector?.discovered) await moveExplorationKnownTarget(sectorId,identity);
      }
      const after=campaign?.act1ExplorationView().sectors.find(item=>item.current);
      if(campaign?.act1?.currentAreaId===targetAreaId) return;
      if(after?.id===sectorId && after.encounter?.status!=='available'
        && !campaign?.act1?.exploration?.activeBattle) travelExplorationExit(targetAreaId);
      return;
    }
    if(identity.areaId==='act1.blood_moor') {
      const world=panelBody.querySelector('#exploration-world');
      const inverse=world?.getScreenCTM()?.inverse();
      if(!inverse)return;
      const target=new DOMPoint(event.clientX,event.clientY).matrixTransform(inverse);
      void moveExplorationOpenTerrain({x:target.x,y:target.y},identity);
      return;
    }
    const target=event.target.closest('[data-sector-id], [data-frontier-index]');
    if(!target)return;
    const index=target.dataset.frontierIndex;
    const sectorId=index===undefined?target.dataset.sectorId:frontierTargets[Number(index)]?.id;
    if(!sectorId||sectorId===identity.sectorId)return;
    const sector=campaign?.act1ExplorationView().sectors.find(item=>item.id===sectorId);
    if(sector?.reachable)moveExplorationSector(sectorId,identity);
    else if(sector?.discovered)moveExplorationKnownTarget(sectorId,identity);
  });
}

function publishExplorationCampaign(nextCampaign) {
  const candidate=buildSaveSnapshot();candidate.campaign=nextCampaign.toJSON();candidate.loot=visibleLootMarker(nextCampaign);
  installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
}

function animateExplorationPath(map, fromId, routeSectorIds) {
  const marker=panelBody.querySelector('.party-map-marker');
  if(!marker||activePanel!=='map'||!routeSectorIds.length)return Promise.resolve();
  const byId=new Map(map.sectors.map(sector=>[sector.id,sector]));
  const points=[fromId,...routeSectorIds].map(id=>byId.get(id)).filter(Boolean).map(sector=>landscapePoint(map.areaId,sector));
  if(points.length<2)return Promise.resolve();
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(reduced){const last=points.at(-1);marker.setAttribute('transform',`translate(${last.x} ${last.y})`);return Promise.resolve();}
  const duration=routeSectorIds.length===1?1200:Math.max(110,Math.min(320,1400/routeSectorIds.length));
  const camera=explorationCameraByArea.get(map.areaId);
  return points.slice(1).reduce((chain,to,index)=>chain.then(()=>new Promise(resolve=>{
    const from=points[index],start=performance.now();
    const step=now=>{
      if(!marker.isConnected||activePanel!=='map'){resolve();return;}
      const t=Math.min(1,(now-start)/duration),ease=t*t*(3-2*t);
      const position={x:from.x+(to.x-from.x)*ease,y:from.y+(to.y-from.y)*ease};
      marker.setAttribute('transform',`translate(${position.x} ${position.y})`);
      if(camera){
        const origin=points[0];
        const screenX=500+camera.offsetX+(position.x-origin.x)*camera.scale;
        const screenY=275+camera.offsetY+(position.y-origin.y)*camera.scale;
        // Keep the party far enough from the edges that an adjacent area is
        // still physically selectable without fitting the whole fogged world.
        const adjustX=screenX<340?340-screenX:screenX>660?660-screenX:0;
        const adjustY=screenY<230?230-screenY:screenY>320?320-screenY:0;
        if(adjustX||adjustY){camera.offsetX+=adjustX;camera.offsetY+=adjustY;mapTransform();}
      }
      if(t<1)requestAnimationFrame(step);else resolve();
    };
    requestAnimationFrame(step);
  })),Promise.resolve());
}

function preserveExplorationCamera(areaId, fromSector, toSector) {
  const camera=explorationCameraByArea.get(areaId);
  if(!camera)return;
  if(activePanel!=='map'){camera.offsetX=0;camera.offsetY=0;return;}
  const from=landscapePoint(areaId,fromSector),to=landscapePoint(areaId,toSector);
  camera.offsetX+=(to.x-from.x)*camera.scale;
  camera.offsetY+=(to.y-from.y)*camera.scale;
}

async function commitExplorationMove(nextCampaign, result, routeSectorIds, identity) {
  const map=campaign.act1ExplorationMap();
  const from=map.sectors.find(sector=>sector.id===identity.sectorId);
  const to=map.sectors.find(sector=>sector.id===result.sectorId);
  await animateExplorationPath(map,identity.sectorId,routeSectorIds);
  preserveExplorationCamera(identity.areaId,from,to);
  publishExplorationCampaign(nextCampaign);
  autosaveGame('ruchu po mapie');
  render();
  if(activePanel==='map')renderMapPanel();
  return true;
}

function positionOpenTerrainView(position, walking = false) {
  if(activePanel!=='map')return;
  const marker=panelBody.querySelector('.party-map-marker');
  const world=panelBody.querySelector('#exploration-world');
  const camera=explorationCameraByArea.get('act1.blood_moor');
  if(!marker||!world||!camera)return;
  marker.setAttribute('transform',`translate(${position.x} ${position.y})`);
  marker.classList.toggle('is-walking',walking);
  updateExplorationWalker(marker,position,walking);
  world.setAttribute('transform',`translate(${500+camera.offsetX} ${275+camera.offsetY}) scale(${camera.scale}) translate(${-position.x} ${-position.y})`);
}

function animateOpenTerrainStep(from,to) {
  if(activePanel!=='map'||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    positionOpenTerrainView(to);
    return Promise.resolve();
  }
  const distance=Math.hypot(to.x-from.x,to.y-from.y);
  const duration=Math.max(75,Math.min(170,distance/180*1000));
  return new Promise(resolve=>{
    let started=null;
    const frame=now=>{
      if(activePanel!=='map'||!panelBody.querySelector('.party-map-marker')){resolve();return;}
      if(started===null)started=now;
      const t=Math.min(1,(now-started)/duration);
      positionOpenTerrainView({x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t},true);
      if(t<1)requestAnimationFrame(frame);else resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function moveExplorationOpenTerrain(target, identity) {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  let startEncounter=false;
  let moved=false;
  try {
    const nextCampaign=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    const expected={expectedAreaId:identity.areaId,expectedSectorId:identity.sectorId,
      expectedSequence:identity.sequence};
    const plan=nextCampaign.planAct1OpenTerrain(target,expected);
    let from=plan.from;
    let currentIdentity=expected;
    for(const [index,to] of plan.pathPoints.slice(1).entries()) {
      await animateOpenTerrainStep(from,to);
      const beforeSector=currentIdentity.expectedSectorId;
      const result=nextCampaign.advanceAct1OpenTerrain(to,currentIdentity);
      moved=true;
      from=result.position;
      currentIdentity={expectedAreaId:result.areaId,expectedSectorId:result.sectorId,
        expectedSequence:result.movementSequence};
      const last=index===plan.pathPoints.length-2;
      if(result.newlyDiscoveredSectorIds.length||result.sectorId!==beforeSector||result.stoppedBy||last) {
        publishExplorationCampaign(nextCampaign);
        render();
        if(activePanel==='map')renderMapPanel();
      } else positionOpenTerrainView(result.position,true);
      if(result.stoppedBy) {
        startEncounter=result.stoppedBy==='encounter';
        break;
      }
    }
    positionOpenTerrainView(from,false);
    if(moved)autosaveGame('ruchu po mapie');
  } catch(error) {
    installLiveSession(previous);
    try { render(); if(activePanel==='map')renderMapPanel(); } catch { /* preserve original error */ }
    showToast(error.message,'warning');
    return false;
  } finally { explorationCommandLocked=false; }
  if(startEncounter) {
    panelBody.querySelector('#start-map-encounter')?.focus({preventScroll:true});
    showToast('SPOTKANIE — kliknij ROZPOCZNIJ WALKĘ, aby wejść na planszę heksową.','warning');
  }
  return moved;
}

async function moveExplorationSector(sectorId, identity) {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {
    const nextCampaign=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    const result=nextCampaign.moveAct1Sector(sectorId,{expectedAreaId:identity.areaId,expectedSectorId:identity.sectorId,expectedSequence:identity.sequence});
    return await commitExplorationMove(nextCampaign,result,[sectorId],identity);
  } catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

async function moveExplorationRoute(routeSectorIds, identity) {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {
    const nextCampaign=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    const result=nextCampaign.moveAct1Route(routeSectorIds,{expectedAreaId:identity.areaId,expectedSectorId:identity.sectorId,expectedSequence:identity.sequence});
    return await commitExplorationMove(nextCampaign,result,result.traversedSectorIds,identity);
  } catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

async function moveExplorationKnownTarget(sectorId, identity) {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {
    const nextCampaign=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    const result=nextCampaign.moveAct1KnownRoute(sectorId,{expectedAreaId:identity.areaId,expectedSectorId:identity.sectorId,expectedSequence:identity.sequence});
    return await commitExplorationMove(nextCampaign,result,result.traversedSectorIds,identity);
  } catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

function beginCurrentExplorationEncounter() {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {
    const view=campaign.act1ExplorationView(),current=view.sectors.find(sector=>sector.current);
    if(current?.encounter?.status!=='available')throw new Error('W tym miejscu nie ma starcia do rozpoczęcia');
    const config=campaign.act1Encounter(current.encounter.encounterId);
    if(!config)throw new Error('Nieznane starcie');
    const nextCampaign=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    nextCampaign.beginAct1Encounter(config.id,{sectorId:current.id});
    publishAct1Battle(nextCampaign,config);
    return true;
  }catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

function explorationTransitionLabel(fromAreaId, targetAreaId) {
  const known = {
    'act1.rogue_encampment>act1.blood_moor': 'WYJŚCIE DO KRWAWEGO WRZOSOWISKA',
    'act1.blood_moor>act1.rogue_encampment': 'POWRÓT DO OBOZOWISKA ŁOTRZYC',
    'act1.blood_moor>act1.den_of_evil': 'WEJŚCIE DO SIEDLISKA ZŁA',
    'act1.den_of_evil>act1.blood_moor': 'WYJŚCIE NA KRWAWE WRZOSOWISKO',
    'act1.blood_moor>act1.cold_plains': 'PRZEJŚCIE DO ZIMNEJ RÓWNINY',
    'act1.cold_plains>act1.blood_moor': 'POWRÓT NA KRWAWE WRZOSOWISKO',
  };
  return known[`${fromAreaId}>${targetAreaId}`] ?? `PRZEJŚCIE DO ${act1Area(targetAreaId).label.toLocaleUpperCase('pl-PL')}`;
}

function travelExplorationExit(areaId) {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {
    const next=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog}),e=campaign.act1.exploration;
    const result=next.travelThroughAct1Exit(areaId,{expectedAreaId:campaign.act1.currentAreaId,expectedSectorId:e.currentSectorId,expectedSequence:e.movementSequence});
    publishExplorationCampaign(next);clearTargeting(false);render();
    autosaveGame('zmianie lokacji');
    if(areaId===TOWN_ID) closePanel(); else openPanel('map');
    showToast(`Wejście: ${result.area.label}.`);return true;
  } catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

function activateExplorationWaypoint() {
  if(explorationCommandLocked)return false;
  explorationCommandLocked=true;
  const previous=captureLiveSession();
  try {const next=CampaignState.restoreAct1(campaign.toJSON(),{catalog:equipmentCatalog});
    if(next.act1.currentAreaId===TOWN_ID&&activePanel==="camp-waypoint") approachCurrentAreaWaypoint(next);
    next.activateCurrentWaypoint();publishExplorationCampaign(next);autosaveGame('aktywacji waypointu');render();renderPanel(activePanel);showToast('Waypoint aktywowany.');return true;}
  catch(error){installLiveSession(previous);showToast(error.message,'warning');return false;}
  finally{explorationCommandLocked=false;}
}

function travelAct1(areaId) {
  const previous = captureLiveSession();
  try {
    const next = CampaignState.restoreAct1(campaign.toJSON(), {catalog:equipmentCatalog});
    next.travelAct1(areaId);
    const candidate = buildSaveSnapshot(); candidate.campaign=next.toJSON(); candidate.loot=visibleLootMarker(next);
    installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
    autosaveGame('zmianie lokacji');
    clearTargeting(false); render(); openPanel('map');
    showToast(`Podróż: ${act1Area(areaId).label}. Zasoby zachowane.`);
    return true;
  } catch(error) { installLiveSession(previous); showToast(error.message,'warning'); return false; }
}

function publishAct1Battle(nextCampaign, config) {
  if (battlePreparation.phase===BATTLE_PHASE.COMPLETED) settleCompletedBattle();
  const nextDeploymentColumnOf = deploymentColumnForMode("approved-v3");
  const nextPreparation = BattlePreparationState.restore(battlePreparation.snapshot(),
    { deploymentColumnOf: nextDeploymentColumnOf });
  const nextGrid = new HexGrid({ tiles: buildTiles(), blockedTerrain });
  const next = stageAct1Encounter({config,roster,party,players,combat,preparation:nextPreparation,
    hexGrid:nextGrid,portals:portalSystem,initialPositions,deploymentColumnOf:nextDeploymentColumnOf});
  if (battlefieldGeometryMode === "legacy-187") {
    for (const encounter of Object.values(nextCampaign.act1.encounters)) {
      relocateLegacyDropHexes(encounter.drops, nextGrid);
    }
  }
  const candidate=buildSaveSnapshot();
  candidate.campaign=nextCampaign.toJSON(); candidate.combat=next.combat.snapshot();
  if (battlefieldGeometryMode === "legacy-187") {
    relocateLegacyDropHexes(candidate.encounterProgress.drops, nextGrid);
  }
  candidate.battlePreparation=next.preparation.snapshot(); candidate.hexGrid=next.hexGrid.snapshot();
  candidate.activeAuras=buildActiveAuraSnapshot({heroIds:roster.toJSON().map(({id})=>id),buffs:next.preparation.listBuffs(),catalog:mouseSkillCatalog});
  candidate.hexUnits=candidate.hexGrid.units.map(u=>({id:u.id,position:u.position,footprint:u.footprint}));
  candidate.portals=next.portals.toJSON(); candidate.loot=visibleLootMarker(nextCampaign);
  candidate.enemyAiById=next.enemyAiById; candidate.enemyAi=next.enemyAiById[next.enemy.id];
  candidate.selectedEnemyId=next.enemy.id; candidate.pendingReturns=[];
  candidate.actingUnitId=next.actingUnitId;
  candidate.inspectedCharacterId=next.actingUnitId;
  installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
  autosaveGame('rozpoczęciu starcia');
  clearTargeting(false); closePanel(); render(); showToast(config.label+' — rozstaw drużynę.');
}

function beginAct1Battle(encounterId) {
  const previous = captureLiveSession();
  try {
    const config = campaign.act1Encounter(encounterId);
    const nextCampaign = CampaignState.restoreAct1(campaign.toJSON(), {catalog:equipmentCatalog});
    nextCampaign.beginAct1Encounter(encounterId);
    publishAct1Battle(nextCampaign,config); return true;
  } catch(error) {installLiveSession(previous); showToast(`Nie rozpoczęto starcia: ${error.message}`,'warning');return false;}
}

function renderPortalPanel() {
  const owner = inspectedCharacter();
  const location = portalSystem.locationOf(owner.id);
  const returnPending = pendingReturns.has(owner.id);
  const portalId = location?.via_portal_id ?? portalSystem.getActivePortalForOwner(owner.id)?.portal_id;
  const portal = portalId ? portalSystem.getPortal(portalId) : null;
  const townTravelers = portal?.active ? livingTownTravelers(portal) : [];
  const ownerMustWait = Boolean(portal?.active
    && owner.id === portal.owner_character_id
    && townTravelers.some(({ id }) => id !== owner.id));
  const allLivingActiveCount = party.activeCharacters().filter((character) =>
    character.lifeState === "alive" && character.resources.hp > 0).length;
  const canReturnParty = townTravelers.length > 1 && townTravelers.length === allLivingActiveCount && battlePreparation.phase === BATTLE_PHASE.ACTIVE;
  panelBody.className = "game-panel-body portal-view";
  const activePortals = portalSystem.listActivePortals();
  panelBody.innerHTML = `
    <div class="portal-summary"><span class="portal-orb">◉</span><div><small>WŁAŚCICIEL PODGLĄDU</small><h3>${owner.name}</h3><p>${location?.kind === "town" ? `W mieście: ${location.town_id}` : `Na polu: ${location?.instance_id ?? INSTANCE_ID}`}</p></div></div>
    <div class="portal-records">
      ${activePortals.length ? activePortals.map((item) => `<article><b>${item.portal_id}</b><span>Właściciel: ${roster.get(item.owner_character_id).name}</span><span>Źródło: ${item.source.instance_id} · heks ${hexKey(item.source.hex)}</span><span>Cel: ${item.destinationTown}</span></article>`).join("") : "<p>Brak aktywnych Miejskich Portali.</p>"}
    </div>
    <div class="portal-actions">
${location?.kind === "town" && portal?.active ? `<button type="button" id="return-through-portal" class="metal-button" ${returnPending || ownerMustWait ? "disabled" : ""}>${returnPending ? "POWRÓT JEST W KOLEJCE" : ownerMustWait ? "WŁAŚCICIEL WRACA OSTATNI" : "WRÓĆ DO TEJ SAMEJ INSTANCJI"}</button>` : ""}
${location?.kind === "town" && portal?.active && canReturnParty ? '<button type="button" id="party-return-through-portal" class="metal-button">WRÓĆ CAŁĄ DRUŻYNĄ — WŁAŚCICIEL OSTATNI</button>' : ""}
${battlePreparation.phase === BATTLE_PHASE.ACTIVE && location?.kind === "area" && portalSystem.getActivePortalForOwner(owner.id) ? '<button type="button" id="party-to-portal" class="metal-button">DRUŻYNA DO PORTALU</button>' : ""}
${battlePreparation.phase === BATTLE_PHASE.ACTIVE && location?.kind === "area" && owner.id === actingUnitId && portalScrolls.get(owner.id)?.remaining > 0 ? '<button type="button" id="replace-own-portal" class="metal-button">OTWÓRZ / PRZENIEŚ WŁASNY PORTAL</button>' : ""}
    </div>
    <p class="data-warning">Wejście do miasta nie przyznaje EXP, łupu ani zwycięstwa. Stan przeciwnika, zwłok, przedmiotów i kolejki pozostaje w instancji ${INSTANCE_ID}.</p>`;
  panelBody.querySelector("#return-through-portal")?.addEventListener("click", returnInspectedFromTown);
  panelBody.querySelector("#party-return-through-portal")?.addEventListener("click", () => partyReturnThroughPortal(portal));
  panelBody.querySelector("#party-to-portal")?.addEventListener("click", () => partyToPortal(portalSystem.getActivePortalForOwner(owner.id)));
  panelBody.querySelector("#replace-own-portal")?.addEventListener("click", () => beginTargeting("portal"));
}

const shortcutLabels = {
  inventory: "Ekwipunek",
  hireling: "Najemnik",
  character: "Statystyki",
  skills: "Umiejętności",
  quests: "Zadania",
  map: "Mapa",
  beltSlot1: "Pas 1",
  beltSlot2: "Pas 2",
  beltSlot3: "Pas 3",
  beltSlot4: "Pas 4",
  townPortal: "Miejski Portal",
  escape: "ESC",
};

function renderOptionsPanel() {
  panelBody.className = "game-panel-body options-view";
  const bindings = shortcutManager.getAllBindings();
  panelBody.innerHTML = `
    <div class="shortcut-list">
      ${Object.entries(bindings).map(([action, values]) => `<label><span>${shortcutLabels[action] ?? action}</span><input data-action-binding="${action}" value="${values.join(", ")}" spellcheck="false"></label>`).join("")}
    </div>
    <div id="shortcut-conflict" class="shortcut-conflict hidden"></div>
<div class="options-actions"><button type="button" id="save-shortcuts" class="metal-button">SPRAWDŹ I ZAPISZ</button><button type="button" id="reset-shortcuts" class="metal-button">DOMYŚLNE</button><button type="button" id="load-save" class="metal-button">WCZYTAJ ZAPIS</button></div>
    <p class="data-warning">Konflikty są wykrywane przed zapisem. Skróty nie działają podczas pisania w tych polach.</p>`;
  panelBody.querySelector("#save-shortcuts").addEventListener("click", saveShortcutOptions);
  panelBody.querySelector("#reset-shortcuts").addEventListener("click", () => {
    replaceShortcutManager(DEFAULT_KEYBINDINGS, true);
    renderOptionsPanel();
  });
  panelBody.querySelector("#load-save").addEventListener("click", continueGame);
}

function saveShortcutOptions() {
  const candidate = {};
  for (const input of panelBody.querySelectorAll("[data-action-binding]")) {
    candidate[input.dataset.actionBinding] = input.value.split(",").map((value) => value.trim()).filter(Boolean);
  }
  const conflict = panelBody.querySelector("#shortcut-conflict");
  try {
    replaceShortcutManager(candidate, true);
    conflict.textContent = "Skróty zapisane. Brak konfliktów.";
    conflict.dataset.kind = "success";
    conflict.classList.remove("hidden");
  } catch (error) {
    conflict.textContent = error instanceof KeybindingConflictError
      ? `Konflikt: ${error.conflicts.map(({ binding, actionIds }) => `${binding} → ${actionIds.join(" / ")}`).join("; ")}`
      : error.message;
    conflict.dataset.kind = "error";
    conflict.classList.remove("hidden");
  }
}

function renderEncounterControls() {
  const drops = visibleGroundDrops();
  const completed = battlePreparation.phase === BATTLE_PHASE.COMPLETED;
  document.querySelector('#encounter-actions').classList.toggle('preparing', battlePreparation.phase === BATTLE_PHASE.PREPARATION);
  const count = document.querySelector('#ground-loot-count');
  count.textContent = `ŁUP NA ZIEMI: ${drops.length}`;
  document.querySelector('#loot-toast').classList.toggle('hidden', drops.length === 0 && !completed);
  document.querySelector('#encounter-label').textContent = `Krwawe Wrzosowisko · starcie ${encounterProgress.encounterNumber}`;
  const next = document.querySelector('#next-encounter');
  if (campaign) {
    const area=act1Area(campaign.act1.currentAreaId);
    const config=campaignEncounter();
    document.querySelector('#encounter-label').textContent = `${area.label}${config?.areaId===area.id?' · '+config.label:''}`;
    next.classList.add('hidden');
    if (!campaignBattleAvailable()) document.querySelector('#loot-toast').classList.toggle('hidden',drops.length===0);
    return;
  }
  document.querySelector('#encounter-label').textContent = `Trening · Krwawe Wrzosowisko · starcie ${encounterProgress.encounterNumber}`;
  next.classList.toggle('hidden', !completed);
  next.dataset.encounter = String(encounterProgress.encounterNumber);
  const living = party.activeCharacters().filter(h=>h.lifeState==='alive' && h.resources.hp>0);
  const absent = living.filter(h=>!characterOnBattlefield(h.id));
  next.disabled = !completed || !living.length || absent.length>0;
  next.title = !living.length ? 'Brak żywych bohaterów.' : absent.length
    ? `Najpierw wróć z miasta: ${absent.map(h=>h.name).join(', ')}.`
    : 'Nowy przeciwnik w tej samej lokacji. Łup na ziemi zostaje, życie i mana nie są odnawiane.';
  if(completed) {
    document.querySelector('#phase-detail').textContent = living.length
      ? `Starcie ${encounterProgress.encounterNumber} zakończone · łup na ziemi: ${drops.length}`
      : 'Przeciwnik pokonany, ale drużyna nie przeżyła. Nie można ruszyć dalej.';
  }
}

function pickupGroundItem(dropId, ownerId) {
  if (isPaused() || activePanel !== 'loot') return false;
  const previous = captureLiveSession();
  try {
    if (!party.isActive(ownerId)) throw new Error('Łup zbiera jeden z aktywnych bohaterów');
    const owner = roster.get(ownerId);
    const pickupArgs = {progress:encounterProgress, dropId, character:owner,
      inventory:inventories.get(ownerId), catalog:equipmentCatalog, phase:battlePreparation.phase,
      onField:characterOnBattlefield(ownerId), ownedIds:validateEquipmentWorld(roster,inventories,equipmentCatalog)};
    const taken = campaign ? campaign.stageAct1Pickup(pickupArgs) : stageLootPickup(pickupArgs);
    const candidate = buildSaveSnapshot();
    candidate.inventories = candidate.inventories.map(([id,bag])=>[id,id===ownerId?taken.inventory.toJSON():bag]);
    candidate.roster.find(h=>h.id===ownerId).inventoryItemIds = taken.inventoryItemIds;
    if(campaign) { candidate.campaign=taken.campaign.toJSON(); candidate.loot=visibleLootMarker(taken.campaign); }
    else { candidate.encounterProgress = taken.progress; candidate.loot = currentLootMarker(taken.progress); }
    const staged = stageGameState(validateSaveEnvelope(candidate));
    installLiveSession(staged);
    lootNotice = `${owner.name}: zebrano ${taken.item.name}. Przedmiot znajdziesz w plecaku I/B.`;
    combat.log.push(lootNotice);
    autosaveGame('podniesieniu przedmiotu');
    render(); renderLootPanel();
    panelBody.querySelector('#loot-message')?.focus({preventScroll:true});
    return true;
  } catch(error) {
    installLiveSession(previous);
    lootNotice = error.message;
    render(); renderLootPanel();
    panelBody.querySelector('#loot-message')?.focus({preventScroll:true});
    return false;
  }
}

function renderLootPanel() {
  const owner = inspectedCharacter();
  const drops = visibleGroundDrops();
  const eligible = battlePreparation.phase===BATTLE_PHASE.COMPLETED && party.isActive(owner.id)
    && owner.lifeState==='alive' && owner.resources.hp>0 && characterOnBattlefield(owner.id);
  panelBody.className = 'game-panel-body loot-view';
  panelBody.replaceChildren();
  const tabs=renderOwnerTabs(); tabs.id='loot-owner-tabs'; panelBody.append(tabs);
  const intro=make('p','loot-intro',`Odbiorca: ${owner.name}. Po walce zbierasz bez kosztu tury. Nie musisz podchodzić do każdej sztuki.`);
  const notice=make('p','loot-message',lootNotice || (!eligible
    ? 'Podgląd. Wybierz żywego bohatera na polu i zakończ starcie, aby zebrać łup.'
    : 'Przy pełnym plecaku przedmiot pozostaje na ziemi, także po rozpoczęciu kolejnego starcia.'));
  notice.id='loot-message';notice.setAttribute('role','status');notice.tabIndex=-1;
  panelBody.append(intro,notice);
  const list=make('div','ground-loot-list');list.id='ground-loot-list';
  for(const drop of drops) {
    const d=equipmentCatalog.get(drop.item.canonicalId);
    const row=make('article','ground-loot-row');row.dataset.dropId=drop.id;
    const icon=make('span','loot-item-glyph',equipmentGlyphs[d.slot]);icon.setAttribute('aria-hidden','true');
    const text=make('div');text.append(make('h3','',drop.item.name));
    const numbers=d.kind==='weapon'?`Obrażenia bazy: ${d.oneHandDamage[0]}–${d.oneHandDamage[1]}`:`Obrona przedmiotu: ${drop.item.defense}`;
    text.append(make('p','',`${numbers} · miejsce w plecaku: ${d.width}×${d.height}`));
    text.append(make('small','',`Starcie ${drop.encounterNumber} · ${drop.id}`));
    const requirements=requirementsFor(owner,d);
    if(requirements.length) text.append(make('p','loot-requirements',`Możesz podnieść, ale jeszcze nie założysz: ${requirements.join(' · ')}`));
    const button=make('button','metal-button',`ZBIERZ → ${owner.name}`);button.type='button';button.dataset.pickup=drop.id;button.disabled=!eligible;
    button.addEventListener('click',()=>pickupGroundItem(drop.id,owner.id));
    row.append(icon,text,button);list.append(row);
  }
  if(!drops.length) list.append(make('p','loot-empty','Wszystkie przedmioty zebrane. Możesz założyć zdobyty sprzęt i rozpocząć następne starcie.'));
  const bag=make('button','metal-button','OTWÓRZ PLECAK · I/B');bag.id='loot-open-inventory';bag.addEventListener('click',()=>openPanel('inventory'));
  const note=make('p','data-warning','Etap łupu: dziesięć zwykłych baz w jawnej sekwencji nagród. To jeszcze nie pełny drop Diablo, TreasureClass, Magic Find ani słowa runiczne.');
  panelBody.append(list,bag,note);
}

function startNextEncounter(expectedEncounter) {
  if (campaign) return false;
  if(isPaused() || activePanel || pendingTarget) return false;
  const previous=captureLiveSession();
  try {
    if(battlePreparation.phase!==BATTLE_PHASE.COMPLETED) throw new Error('Najpierw zakończ starcie');
    settleCompletedBattle();
    const nextDeploymentColumnOf = deploymentColumnForMode("approved-v3");
    const nextPreparation = BattlePreparationState.restore(battlePreparation.snapshot(),
      { deploymentColumnOf: nextDeploymentColumnOf });
    const nextGrid = new HexGrid({ tiles: buildTiles(), blockedTerrain });
    const next=stageNextEncounter({progress:encounterProgress,expectedEncounter,catalog:equipmentCatalog,
      roster,party,players,combat,enemy,preparation:nextPreparation,hexGrid:nextGrid,portals:portalSystem,
      initialPositions,deploymentColumnOf:nextDeploymentColumnOf,areaId:AREA_ID});
    if (battlefieldGeometryMode === "legacy-187") relocateLegacyDropHexes(next.progress.drops, nextGrid);
    const candidate=buildSaveSnapshot();
    candidate.encounterProgress=next.progress;candidate.combat=next.combat.snapshot();
    candidate.battlePreparation=next.preparation.snapshot();candidate.hexGrid=next.hexGrid.snapshot();
    candidate.hexUnits=candidate.hexGrid.units.map(u=>({id:u.id,position:u.position,footprint:u.footprint}));
    candidate.portals=next.portals.toJSON();candidate.loot=currentLootMarker(next.progress);
    candidate.enemyAi={profileId:AI_PROFILE_IDS.MELEE_PRESSURE,currentTargetId:null};
    candidate.enemyAiById={[next.enemy.id]:structuredClone(candidate.enemyAi)};
    candidate.selectedEnemyId=next.enemy.id;
    candidate.pendingReturns=[];candidate.actingUnitId=next.actingUnitId;candidate.inspectedCharacterId=next.actingUnitId;
    const staged=stageGameState(validateSaveEnvelope(candidate));
    installLiveSession(staged);
    clearTargeting(false);selectedInventoryItem=null;lootNotice='';
    render();showToast(`Starcie ${encounterProgress.encounterNumber}. Rozstaw drużynę; HP, mana i wyposażenie zostały zachowane.`);
    return true;
  } catch(error) {
    installLiveSession(previous);render();showToast(`Nie rozpoczęto następnego starcia: ${error.message}`,'warning');return false;
  }
}

function returnAfterVictory(returningId) {
  const previous=captureLiveSession();
  try {
    if(battlePreparation.phase!==BATTLE_PHASE.COMPLETED) throw new Error('Starcie jeszcze trwa');
    const h=roster.get(returningId), location=portalSystem.locationOf(returningId);
    const portal=location?.kind==='town'?portalSystem.getPortal(location.via_portal_id):null;
    if(!portal?.active || h.lifeState!=='alive' || h.resources.hp<=0) throw new Error('Brak legalnego powrotu');
    if(returningId===portal.owner_character_id && livingTownTravelers(portal).some(t=>t.id!==returningId)) throw new Error('Właściciel wraca ostatni');
    const destination=findReturnHex(portal);if(!destination) throw new Error('Brak wolnego heksa przy portalu');
    const stagedPortals=PortalSystem.fromJSON(portalSystem.toJSON());
    const result=stagedPortals.returnThroughPortal({portal_id:portal.portal_id,character_id:returningId,character:h});
    if(!result.ok) throw new Error(result.message);
    stagedPortals.setCharacterLocation(returningId,{kind:'area',area_id:AREA_ID,instance_id:INSTANCE_ID,hex:destination,via_portal_id:portal.portal_id});
    const stagedGrid=HexGrid.restore(hexGrid.snapshot());stagedGrid.addUnit({id:returningId,position:destination});
    const stagedPreparation=postBattlePresence(battlePreparation,returningId,destination,deploymentColumnOf);
    const candidate=buildSaveSnapshot();candidate.portals=stagedPortals.toJSON();candidate.hexGrid=stagedGrid.snapshot();
    candidate.hexUnits=candidate.hexGrid.units.map(u=>({id:u.id,position:u.position,footprint:u.footprint}));
    candidate.combat.units.find(u=>u.id===returningId).position=destination;
    candidate.battlePreparation=stagedPreparation.snapshot();candidate.pendingReturns=candidate.pendingReturns.filter(id=>id!==returningId);
    installLiveSession(stageGameState(validateSaveEnvelope(candidate)));
    closePanel();render();showToast(`${h.name} wraca po zakończonej walce. Zasoby nie zostały odnowione.`);
    return true;
  } catch(error) {installLiveSession(previous);render();showToast(error.message,'warning');return false;}
}

function renderDiabloPanelFooter(owner, themed) {
  const footer = document.querySelector('#game-panel .game-panel-footer');
  footer.classList.toggle('d2-footer', themed);
  if (!themed) {
    footer.replaceChildren(make('span', '', 'Czas symulacji jest zatrzymany podczas przeglądania.'), make('kbd', '', 'ESC'));
    return;
  }
  const life = make('span', 'd2-orb d2-life', `${owner.resources.hp}/${owner.resources.maxHp}`);
  life.setAttribute('aria-label', `Życie ${owner.resources.hp} z ${owner.resources.maxHp}`);
  const mana = make('span', 'd2-orb d2-mana', `${formatMana(owner.resources.mana)}/${formatMana(owner.resources.maxMana)}`);
  mana.setAttribute('aria-label', `Mana ${formatMana(owner.resources.mana)} z ${formatMana(owner.resources.maxMana)}`);
  const belt = make('div', 'd2-belt');
  belt.setAttribute('aria-label', 'Pas mikstur');
  (belts.get(owner.id) ?? []).forEach((slot, index) => {
    const filled = beltSlotCount(slot) > 0;
    const cell = make('span', '', `${index + 1} · ${filled ? `×${beltSlotCount(slot)}` : '—'}`);
    cell.title = filled ? slot.name : 'Puste miejsce pasa';
    belt.append(cell);
  });
  footer.replaceChildren(life, belt, mana);
}

function renderPanel(kind) {
  const gamePanel = document.querySelector('#game-panel');
  const tradeScaffold = ['camp-trade-akara', 'camp-charsi', 'camp-gheed'].includes(kind);
  panelLayer.querySelector('#merchant-panel')?.remove();
  panelLayer.classList.toggle('trade-pair', tradeScaffold);
  gamePanel.classList.remove('sanctuary-map');
  gamePanel.classList.toggle('empty-inventory-template', kind === 'inventory' || tradeScaffold);
  gamePanel.querySelector('.game-panel-footer').classList.remove('d2-empty-footer');
  const owner = inspectedCharacter();
  const themed = ['inventory', 'character', 'camp-charsi', 'camp-gheed', 'camp-cain', 'camp-stash', 'horadric-cube']
    .includes(kind) || kind.startsWith('camp-trade-');
  gamePanel.classList.toggle('diablo-panel', themed);
  gamePanel.classList.toggle('skills-panel', kind === 'skills');
  renderDiabloPanelFooter(owner, themed);
  const titles = {
    loot: ["ŁUP Z POLA WALKI", campaign ? act1Area(campaign.act1.currentAreaId).label : `Trening · starcie ${encounterProgress.encounterNumber}`],
    inventory: ["EKWIPUNEK", `${owner.name} · ${classNames[owner.classId]} · poziom ${owner.level}`],
    hireling: ["WYPOSAŻENIE NAJEMNIKA", `Właściciel: ${owner.name}`],
    character: ["STATYSTYKI POSTACI", `Oglądana: ${owner.name}`],
    skills: ["UMIEJĘTNOŚCI", `Oglądana: ${owner.name}`],
    quests: ["DZIENNIK ZADAŃ", "Postęp świata i nagrody osobiste"],
    map: ["MAPA EKSPLORACJI", campaign ? `Akt I · ${act1Area(campaign.act1.currentAreaId).label}` : 'Tryb treningowy'],
    portal: ["MIEJSKI PORTAL", "Podróż nie resetuje zwykłego spotkania"],
    options: ["OPCJE I SKRÓTY", "Centralna konfiguracja sterowania"],
    "camp-trade-akara": ["HANDEL · AKARA", "Zwoje, tomy, mikstury i lekkie przedmioty magiczne"],
    "camp-charsi": ["HANDEL · CHARSI", "Broń, pancerze, tarcze i naprawy"],
    "camp-gheed": ["HANDEL · GHEED", "Wędrowny kupiec · broń i podstawowe opancerzenie"],
    "camp-kashya": ["KASHYA", "Straż obozu i skład aktywnej drużyny"],
    "camp-warriv": ["WARRIV", "Droga karawany na wschód"],
    "camp-cain": ["DECKARD CAIN", "Wiedza i identyfikacja"],
    "camp-stash": ["WSPÓLNA SKRYTKA", "Przenoszenie przedmiotów bez zmiany ich tożsamości"],
    "horadric-cube": ["KOSTKA HORADRIMÓW", "Przedmioty bohatera i starożytny artefakt"],
    "camp-waypoint": ["PUNKT NAWIGACYJNY", "Wyłącznie odkryte i aktywowane miejsca"],
  };
  document.querySelector("#panel-title").textContent = titles[kind][0];
  document.querySelector("#panel-context").textContent = titles[kind][1];
  if (kind === "loot") renderLootPanel();
  if (kind === "inventory") renderInventoryPanel();
  if (kind === "horadric-cube") renderHoradricCubePanel();
  if (kind === "hireling") renderHirelingPanel();
  if (kind === "character") renderCharacterPanel();
  if (kind === "skills") renderSkillsPanel();
  if (kind === "quests") renderQuestPanel();
  if (kind === "map") renderMapPanel();
  if (kind === "portal") renderPortalPanel();
  if (kind === "options") renderOptionsPanel();
  if (kind === "camp-trade-akara") renderCampTradeScaffold("akara");
  if (kind === "camp-charsi") renderCampTradeScaffold("charsi");
  if (kind === "camp-gheed") renderCampTradeScaffold("gheed");
  if (["camp-kashya", "camp-warriv", "camp-cain"].includes(kind)) renderCampDialoguePanel(kind);
  if (kind === "camp-stash") renderCampStashPanel();
  if (kind === "camp-waypoint") renderCampWaypointPanel();
}

function isolatePanelBackground() {
  const gameShell = document.querySelector("#app");
  panelBackgroundState = {
    element: gameShell,
    inert: gameShell.inert,
    ariaHidden: gameShell.getAttribute("aria-hidden"),
  };
  gameShell.inert = true;
  gameShell.setAttribute("aria-hidden", "true");
}

function restorePanelBackground() {
  if (!panelBackgroundState) return;
  const { element, inert, ariaHidden } = panelBackgroundState;
  element.inert = inert;
  if (ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", ariaHidden);
  panelBackgroundState = null;
}

function focusablePanelControls() {
  return [...panelLayer.querySelectorAll(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function openPanel(kind) {
  const isFirstPanel = !activePanel;
  if (isFirstPanel) {
    focusBeforePanel = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  if(kind==='map'&&campaign){
    const camera=explorationCameraByArea.get(campaign.act1.currentAreaId);
    if(camera){camera.offsetX=0;camera.offsetY=0;}
  }
  clearTargeting(false);
  activePanel = kind;
  syncMusicScene();
  renderPanel(kind);
  if (isFirstPanel) isolatePanelBackground();
  panelLayer.classList.remove("hidden");
  panelLayer.setAttribute("aria-hidden", "false");
  document.querySelector("#close-panel").focus({ preventScroll: true });
  drawScene();
  return true;
}

function closePanel() {
  if (!activePanel) return false;
  hideItemTooltip();
  activePanel = null;
  syncMusicScene();
  panelLayer.classList.add("hidden");
  panelLayer.setAttribute("aria-hidden", "true");
  restorePanelBackground();
  const restoreTarget = focusBeforePanel;
  focusBeforePanel = null;
  if (restoreTarget?.isConnected && !restoreTarget.disabled) restoreTarget.focus({ preventScroll: true });
  else canvas.focus({ preventScroll: true });
  drawScene();
  return true;
}

function togglePanel(kind) {
  if (isPaused()) return true;
  if (activePanel === kind) return closePanel();
  return openPanel(kind);
}

function pauseBackgroundTargets() {
  const battlefieldChildren = [...pauseOverlay.parentElement.children]
    .filter((element) => element !== pauseOverlay);
  return [
    document.querySelector(".top-frame"),
    document.querySelector(".party-panel"),
    document.querySelector(".intel-panel"),
    document.querySelector(".command-deck"),
    panelLayer,
    ...battlefieldChildren,
  ].filter((element, index, all) => element && all.indexOf(element) === index);
}

function isolatePauseBackground() {
  pausedBackgroundState = new Map();
  for (const element of pauseBackgroundTargets()) {
    pausedBackgroundState.set(element, {
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    });
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }
}

function restorePauseBackground() {
  for (const [element, state] of pausedBackgroundState) {
    element.inert = state.inert;
    if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", state.ariaHidden);
  }
  pausedBackgroundState.clear();
}

function focusablePauseControls() {
  return [...pauseOverlay.querySelectorAll(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function togglePause(force) {
  const shouldHide = force ?? !pauseOverlay.classList.contains("hidden");
  const isHidden = pauseOverlay.classList.contains("hidden");
  if (shouldHide === isHidden) return true;
  if (shouldHide) {
    pauseOverlay.classList.add("hidden");
    pauseOverlay.setAttribute("aria-hidden", "true");
    restorePauseBackground();
    const restoreTarget = focusBeforePause;
    focusBeforePause = null;
    if (restoreTarget?.isConnected && !restoreTarget.disabled) restoreTarget.focus({ preventScroll: true });
    return true;
  }
  focusBeforePause = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  isolatePauseBackground();
  pauseOverlay.classList.remove("hidden");
  pauseOverlay.setAttribute("aria-hidden", "false");
  document.querySelector("#resume").focus({ preventScroll: true });
  return true;
}

function openCampMenuOrTogglePause() {
  if (isSafeCamp()) {
    mainMenu.show({ resumeGame: true });
    return true;
  }
  return togglePause();
}

function shortcutActions() {
  return {
    [KeybindingAction.INVENTORY]: () => togglePanel("inventory"),
    [KeybindingAction.HIRELING]: () => togglePanel("hireling"),
    [KeybindingAction.CHARACTER]: () => togglePanel("character"),
    [KeybindingAction.SKILLS]: () => togglePanel("skills"),
    [KeybindingAction.QUESTS]: () => togglePanel("quests"),
    [KeybindingAction.MAP]: () => togglePanel("map"),
    [KeybindingAction.BELT_SLOT_1]: () => useBeltSlot(0),
    [KeybindingAction.BELT_SLOT_2]: () => useBeltSlot(1),
    [KeybindingAction.BELT_SLOT_3]: () => useBeltSlot(2),
    [KeybindingAction.BELT_SLOT_4]: () => useBeltSlot(3),
    [KeybindingAction.TOWN_PORTAL]: portalCommand,
  };
}

function replaceShortcutManager(bindings, persist = false) {
  const next = new KeybindingManager({
    bindings,
    actions: shortcutActions(),
    escape: {
      cancel: () => clearTargeting(),
      chooser: () => closeMouseSkillChooser(),
      closePanel,
      pause: openCampMenuOrTogglePause,
    },
  });
  shortcutManager?.detach();
  shortcutManager = next;
  shortcutManager.attach(window);
  if (persist) shortcutManager.save(localStorage);
}

function serializeHexUnits() {
  const hexUnits = [];
  for (const id of [...party.slots, ...battlePreparation.listSummons().map(({ id }) => id), ...battleMonsters().map(({id})=>id)]) {
    try {
      hexUnits.push({
        id,
        position: hexGrid.positionOf(id),
        footprint: hexGrid.footprintOf(id),
      });
    } catch {
      // A hero in town intentionally has no battlefield occupancy.
    }
  }
  return hexUnits;
}

function savedEffectsVolume() {
  const value = Number(localStorage.getItem('rotw.effects.volume.v1') ?? 70);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 70;
}

function restoreSavedSettings(settings) {
  if (!settings) return; // Older saves keep the current player's preferences.
  try {
    gameMusic.setVolume(settings.musicVolume);
    localStorage.setItem('rotw.effects.volume.v1', String(settings.effectsVolume));
    if (settings.keybindings?.bindings) replaceShortcutManager(settings.keybindings.bindings, true);
    mainMenu?.syncSettings();
  } catch (error) {
    showToast(`Wczytano grę, ale ustawień nie udało się odtworzyć: ${error.message}`, 'warning');
  }
}

function buildSaveSnapshot() {
  return {
    schemaVersion: 3,
    skillTreeSchemaVersion: SKILL_TREE_SAVE_SCHEMA_VERSION,
    skillTreeCatalogId: SKILL_TREE_CATALOG_ID,
    campaignSchemaVersion: 2,
    campaign: campaign?.toJSON() ?? null,
    encounterSchemaVersion: ENCOUNTER_SCHEMA_VERSION,
    encounterProgress: structuredClone(encounterProgress),
    equipmentSchemaVersion: EQUIPMENT_SCHEMA_VERSION,
    equipmentCatalogId: EQUIPMENT_CATALOG_ID,
    mouseSkillSchemaVersion: MOUSE_SKILL_SCHEMA_VERSION,
    mouseSkillCatalogId: mouseSkillCatalog.id,
    mouseSkills: mouseSkills.snapshot(),
    skillHotkeys: skillHotkeys.snapshot(),
    activeAuraSchemaVersion: ACTIVE_AURA_SAVE_SCHEMA_VERSION,
    activeAuras: buildActiveAuraSnapshot({
      heroIds: roster.toJSON().map(({ id }) => id),
      buffs: battlePreparation.listBuffs(), catalog: mouseSkillCatalog,
    }),
    campServicesSchemaVersion: CAMP_SERVICES_SCHEMA_VERSION,
    campServices: campServices.snapshot(),
    horadricCubeSchemaVersion: HORADRIC_CUBE_SCHEMA_VERSION,
    horadricCube: horadricCube.snapshot(),
    game_ruleset_version: GAME_RULESET_VERSION,
    source_snapshot_id: SOURCE_SNAPSHOT_ID,
    settings: {
      schemaVersion: 1,
      musicVolume: gameMusic.getVolume(),
      effectsVolume: savedEffectsVolume(),
      keybindings: shortcutManager?.serialize() ?? null,
    },
    creationProfile: structuredClone(creationProfile),
    roster: roster.toJSON(),
    partyIds: [...party.slots],
    players: players.value,
    combat: combat.snapshot(),
    rng: combatRng.snapshot(),
    hexUnits: serializeHexUnits(),
    hexGrid: hexGrid.snapshot(),
    portals: portalSystem.toJSON(),
    portalScrolls: [...portalScrolls.entries()].map(([id, supply]) => [id, supply.toJSON()]),
    inventories: [...inventories.entries()].map(([id, grid]) => [id, grid.toJSON()]),
    beltSchemaVersion: 1,
    belts: structuredClone([...belts.entries()]),
    weaponSets: [...weaponSets.entries()],
    pendingReturns: [...pendingReturns],
    actingUnitId,
    inspectedCharacterId,
    loot,
    enemyAi: structuredClone(enemyAi),
    enemyAiById: structuredClone(enemyAiById),
    selectedEnemyId: enemy.id,
    battlePreparation: battlePreparation.snapshot(),
  };
}

function saveGameState() {
  try {
    if(explorationCommandLocked)throw new Error('Poczekaj na zakończenie ruchu drużyny');
    publishSaveSnapshot(buildSaveSnapshot());
    combat.log.push("Zapis v3 zachował zegar, zdarzenia, polecenia, heksy, rezerwacje, RNG i instancję.");
    document.querySelector(".save-state").textContent = "Zapisano przed chwilą";
    render();
    showToast("Zapisano stan gry.");
    return true;
  } catch (error) {
    showToast(`Nie udało się zapisać: ${error.message}`, "warning");
    return false;
  }
}

function autosaveGame(moment) {
  try {
    publishSaveSnapshot(buildSaveSnapshot());
    return true;
  } catch (error) {
    showToast(`Autozapis po ${moment} nie powiódł się: ${error.message}`, 'warning');
    return false;
  }
}

function optionalGridPosition(grid, unitId) {
  try {
    return grid.positionOf(unitId);
  } catch {
    return null;
  }
}

function sameHex(left, right) {
  try {
    return hexKey(left) === hexKey(right);
  } catch {
    return false;
  }
}

function validateRestoredWorld({
  restoredCampaign,
  restoredEnemyAiById,
  restoredRoster,
  restoredParty,
  restoredCombat,
  restoredEnemy,
  restoredPortals,
  restoredHexGrid,
  restoredEnemyAi,
  restoredPreparation,
  restoredLoot,
  restoredProgress,
  restoredPendingReturns,
  rawPendingReturns,
  rawHexUnits,
}) {
  const areaEncounter = campaignEncounter(restoredCampaign);
  const AREA_ID = areaEncounter?.areaId ?? 'act1.blood_moor';
  const INSTANCE_ID = areaEncounter?.id ?? 'BM-01';
  const monsters = [...restoredCombat.units.values()].filter(unit=>unit.kind==='monster');
  if (!Array.isArray(rawHexUnits)) throw new TypeError("Zapis nie zawiera kompletnej listy jednostek heksowych");
  if (!Array.isArray(rawPendingReturns)) throw new TypeError("Zapis nie zawiera listy zaplanowanych powrotów");
  if (new Set(rawPendingReturns).size !== rawPendingReturns.length) throw new Error("Zapis zawiera powielony plan powrotu");
  if (!(restoredPreparation instanceof BattlePreparationState)) throw new TypeError("Zapis nie zawiera stanu przygotowania bitwy");
  const combatSnapshot = restoredCombat.snapshot();
  if (restoredPreparation.phase === BATTLE_PHASE.ACTIVE && restoredCombat.timelineMode !== TIMELINE_MODE.RECOVERY) {
    throw new Error("Aktywna walka w zapisie nie używa wspólnej kolejki recovery-time");
  }
  if (restoredPreparation.phase === BATTLE_PHASE.PREPARATION) {
    const sleepingScheduler = restoredCombat.timelineMode === null
      && restoredCombat.currentActorId === null
      && combatSnapshot.readiness?.phase === READINESS_PHASE.RESOLVING
      && combatSnapshot.scheduler?.queue?.length === 0
      && combatSnapshot.commands?.active?.length === 0
      && combatSnapshot.projectiles?.active?.length === 0
      && combatSnapshot.units.every(({ readinessEventId }) => readinessEventId === null)
      && restoredHexGrid.reservations().length === 0
      && restoredPendingReturns.size === 0;
    if (!sleepingScheduler) {
      throw new Error("Przygotowanie nie może zawierać kolejki, komend, pocisków, rezerwacji ani zaplanowanych powrotów");
    }
  }
  if (restoredPreparation.heroIds.length !== restoredParty.slots.length
    || restoredPreparation.heroIds.some((id, index) => id !== restoredParty.slots[index])) {
    throw new Error("Stan przygotowania nie odpowiada aktywnej drużynie");
  }
  const restoredSummons = restoredPreparation.listSummons();
  const requireRegisteredClassSkill = (heroId, skillId, expectedCategory = null) => {
    const character = restoredRoster.get(heroId);
    const definition = skillDefinitions[skillId];
    if (!definition || (skillId !== "basic.attack" && !skillId.startsWith(`${character.classId}.`))) {
      throw new Error(`Skill ${skillId} nie należy do klasy bohatera ${heroId}`);
    }
    if (expectedCategory !== null && definition.category !== expectedCategory) {
      throw new Error(`Skill ${skillId} ma nieprawidłową kategorię w zapisie`);
    }
    return definition;
  };
  for (const heroId of restoredPreparation.heroIds) {
    const loadout = restoredPreparation.getLoadout(heroId);
    for (const skillId of [loadout.left, ...loadout.right]) requireRegisteredClassSkill(heroId, skillId);
  }
  for (const summon of restoredSummons) {
    const ownerClassId = restoredRoster.get(summon.ownerId).classId;
    const matchingSummonSkill = Object.values(skillDefinitions).find((definition) => (
      definition.id.startsWith(`${ownerClassId}.`)
      && definition.category === SKILL_CATEGORY.SUMMON
      && definition.summonKind === summon.kind
    ));
    if (!matchingSummonSkill) throw new Error(`Summon ${summon.id} nie należy do klasy właściciela ${summon.ownerId}`);
  }
  for (const buff of restoredPreparation.listBuffs()) {
    const definition = requireRegisteredClassSkill(buff.sourceId, buff.skillId);
    if (![SKILL_CATEGORY.BUFF, SKILL_CATEGORY.AURA].includes(definition.category)) {
      throw new Error(`Efekt ${buff.id} nie pochodzi z buffu ani aury`);
    }
  }
  const allowedHexUnitIds = new Set([...restoredParty.slots, ...restoredSummons.map(({ id }) => id), ...monsters.map(({id})=>id)]);
  for (const entry of rawHexUnits) {
    if (!entry || !allowedHexUnitIds.has(entry.id)) throw new Error(`Nieznana jednostka na siatce zapisu: ${entry?.id ?? "—"}`);
  }
  const gridUnits=restoredHexGrid.snapshot().units;
  if(rawHexUnits.length!==gridUnits.length || new Set(rawHexUnits.map(u=>u.id)).size!==rawHexUnits.length
    || rawHexUnits.some(u=>!sameHex(u.position,gridUnits.find(g=>g.id===u.id)?.position))) throw new Error('Lista pól nie odpowiada zajętości siatki');
  if(restoredCampaign) for(const state of Object.values(restoredCampaign.act1.encounters)) {
    for(const drop of state.drops) if(!restoredHexGrid.has(drop.hex)) throw new Error('Łup kampanii poza planszą');
  }

  for (const portal of restoredPortals.listActivePortals()) {
    if (!restoredParty.isActive(portal.owner_character_id)) {
      throw new Error(`Aktywny portal ma niedostępnego właściciela: ${portal.owner_character_id}`);
    }
    if (portal.source.area_id !== AREA_ID || portal.source.instance_id !== INSTANCE_ID) {
      throw new Error(`Portal ${portal.portal_id} wskazuje inną instancję niż bieżące spotkanie`);
    }
    const exploration = restoredCampaign?.act1?.exploration;
    if (portal.source.world_id !== undefined
      && (portal.source.world_id !== exploration?.worldId
        || portal.source.sector_id !== exploration?.activeBattle?.sectorId)) {
      throw new Error(`Portal ${portal.portal_id} wskazuje inny świat lub sektor eksploracji`);
    }
  }

  for (const id of restoredParty.slots) {
    const character = restoredRoster.get(id);
    const unit = restoredCombat.units.get(id);
    if (!unit || unit.kind !== "hero") throw new Error(`Aktywny bohater nie ma jednostki walki: ${id}`);
    const location = restoredPortals.locationOf(id);
    const gridPosition = optionalGridPosition(restoredHexGrid, id);
    if (!location || !["area", "town"].includes(location.kind)) {
      throw new Error(`Aktywny bohater ma nieprawidłową lokację: ${id}`);
    }
    if (restoredPreparation.phase === BATTLE_PHASE.PREPARATION
      && character.lifeState === "alive" && location.kind !== "area") {
      throw new Error(`Żywy bohater przygotowania musi być na polu: ${id}`);
    }
    if (location.kind === "area") {
      if (location.area_id !== AREA_ID || location.instance_id !== INSTANCE_ID) {
        throw new Error(`Bohater ${id} jest w innej instancji niż pole walki`);
      }
      if (character.lifeState === "alive" && character.resources.hp > 0) {
        if (!restoredPreparation.isUnitOnField(id)) {
          throw new Error(`Żywy bohater obszaru jest oznaczony jako poza polem: ${id}`);
        }
        if (!gridPosition || !sameHex(gridPosition, unit.position) || !sameHex(gridPosition, location.hex)) {
          throw new Error(`Niespójna pozycja walki, siatki i lokacji bohatera: ${id}`);
        }
        if (!sameHex(gridPosition, restoredPreparation.positionOf(id))) {
          throw new Error(`Pozycja bohatera nie zgadza się ze stanem przygotowania: ${id}`);
        }
      } else {
        if (gridPosition || restoredPreparation.isUnitOnField(id)) {
          throw new Error(`Martwy bohater nadal zajmuje heks lub jest obecny w stanie walki: ${id}`);
        }
      }
    } else {
      if (gridPosition || restoredPreparation.isUnitOnField(id)) {
        throw new Error(`Bohater w mieście nadal zajmuje heks lub jest obecny w stanie walki: ${id}`);
      }
      const viaPortal = restoredPortals.getPortal(location.via_portal_id);
      if (!viaPortal || viaPortal.source.instance_id !== INSTANCE_ID || location.source_instance_id !== INSTANCE_ID) {
        throw new Error(`Lokacja miejska bohatera nie prowadzi do tej instancji: ${id}`);
      }
    }
    if (restoredPendingReturns.has(id)) {
      const returnPortal = location.kind === "town" ? restoredPortals.getPortal(location.via_portal_id) : null;
      if (character.lifeState !== "alive" || character.resources.hp <= 0 || !returnPortal?.active) {
        throw new Error(`Nielegalny zaplanowany powrót bohatera: ${id}`);
      }
    }
  }

  for (const summon of restoredSummons) {
    const gridPosition = optionalGridPosition(restoredHexGrid, summon.id);
    if (!gridPosition || !sameHex(gridPosition, summon.position) || !restoredParty.isActive(summon.ownerId)) {
      throw new Error(`Niespójny trwały summon w zapisie: ${summon.id}`);
    }
  }

  for (const id of restoredPendingReturns) {
    if (!restoredParty.isActive(id)) throw new Error(`Powrót zaplanowano dla postaci spoza aktywnej drużyny: ${id}`);
  }

  for (const unit of restoredCombat.units.values()) {
    if (unit.kind === "summon" && unit.alive === false) {
      if (restoredSummons.some(s=>s.id===unit.id) || optionalGridPosition(restoredHexGrid,unit.id)) throw new Error("Martwy summon nadal zajmuje pole");
      continue;
    }
    if (!allowedHexUnitIds.has(unit.id)) throw new Error(`Nieznana jednostka walki w zapisie: ${unit.id}`);
    if (unit.kind === "hero" && !restoredParty.isActive(unit.id)) throw new Error(`Jednostka bohatera spoza aktywnej drużyny: ${unit.id}`);
    if (unit.kind === "summon") {
      const prepSummon = restoredSummons.find(({ id }) => id === unit.id);
      if (!prepSummon || prepSummon.ownerId !== unit.ownerId
        || prepSummon.kind !== unit.summonType
        || !sameHex(unit.position, prepSummon.position) || unit.encounterId !== restoredCombat.encounterId) {
        throw new Error(`Runtime summon nie zgadza się ze stanem przygotowania: ${unit.id}`);
      }
      if (unit.alive && unit.hp === 0) throw new Error(`Żywy summon ma zero HP: ${unit.id}`);
    }
  }

  if (areaEncounter) {
    if (restoredCombat.encounterId!==areaEncounter.id || restoredPreparation.encounterNumber!==restoredCampaign.act1EncounterNumber(areaEncounter.id)
      || monsters.length!==areaEncounter.monsters.length) throw new Error('Niespójne spotkanie kampanii');
    const ledger=restoredCampaign.act1.encounters[areaEncounter.id];
    if ((ledger.status==='completed') !== (restoredPreparation.phase===BATTLE_PHASE.COMPLETED)) throw new Error('Stan kampanii nie zgadza się z wynikiem bitwy');
    if (ledger.status==='active' && restoredCampaign.act1.currentAreaId!==areaEncounter.areaId) throw new Error('Aktywna bitwa jest w innej lokacji');
    for(const entry of areaEncounter.monsters) {
      const unit=monsters.find(u=>u.id===entry.id),profile=ACT1_MONSTERS[entry.profileId];
      if(!unit) throw new Error('Brak przeciwnika spotkania');
      const expected=new PlayersSetting(unit.playersSnapshot).scaleMonsterBase({hp:profile.baseHp,experience:profile.baseExperience});
      if(unit.sourceMonsterCode!==entry.profileId || unit.maxHp!==expected.hp || unit.experience!==expected.experience
        || ledger.defeatedIds.includes(unit.id)!==(unit.hp===0 && unit.rewardsGranted)) throw new Error('Niespójne dane lub rozliczenie potwora');
    }
  } else if(monsters.length!==1) throw new Error('Trening wymaga jednego przeciwnika');
  for(const restoredEnemy of monsters) {
  const enemyGridPosition = optionalGridPosition(restoredHexGrid, restoredEnemy.id);
  if (!Number.isFinite(restoredEnemy.hp) || !Number.isFinite(restoredEnemy.maxHp)
    || restoredEnemy.hp < 0 || restoredEnemy.maxHp <= 0 || restoredEnemy.hp > restoredEnemy.maxHp) {
    throw new Error("Przeciwnik ma nieprawidłowy stan życia");
  }
  if (restoredPreparation.phase === BATTLE_PHASE.COMPLETED && restoredEnemy.hp !== 0) {
    throw new Error("Zakończona walka nie może zawierać żywego przeciwnika");
  }
  if (!areaEncounter && restoredPreparation.phase !== BATTLE_PHASE.COMPLETED && restoredEnemy.hp === 0) {
    throw new Error("Przygotowanie ani aktywna walka nie mogą zawierać pokonanego przeciwnika");
  }
  if (restoredEnemy.hp > 0) {
    if (restoredEnemy.rewardsGranted !== false || (!areaEncounter && restoredLoot !== null)) {
      throw new Error("Żywy przeciwnik nie może mieć rozliczonej nagrody ani łupu");
    }
    if (!enemyGridPosition || !sameHex(enemyGridPosition, restoredEnemy.position)) {
      throw new Error("Żywy przeciwnik ma niespójną pozycję heksową");
    }
  } else {
    if (enemyGridPosition) throw new Error("Pokonany przeciwnik nadal zajmuje pole walki");
    if (restoredEnemy.rewardsGranted !== true) {
      throw new Error("Pokonany przeciwnik nie ma atomowo rozliczonej nagrody");
    }
  }
  }
  if (JSON.stringify(restoredLoot) !== JSON.stringify(visibleLootMarker(restoredCampaign,restoredProgress))) {
    throw new Error("Znacznik łupu nie zgadza się z rejestrem nagród");
  }

  const currentId = restoredCombat.currentActorId;
  if (currentId) {
    const current = restoredCombat.units.get(currentId);
    if (current.kind === "hero") {
      const location = restoredPortals.locationOf(currentId);
      const isLegalFieldActor = location?.kind === "area"
        && restoredRoster.get(currentId).lifeState === "alive"
        && restoredRoster.get(currentId).resources.hp > 0;
      const isLegalPendingReturn = location?.kind === "town" && restoredPendingReturns.has(currentId);
      if (!isLegalFieldActor && !isLegalPendingReturn) throw new Error("Bieżący bohater nie ma legalnego okna polecenia");
    } else if (current.kind === "summon") {
      const summon = restoredCombat.units.get(currentId);
      if (!summon.alive || !restoredSummons.some(({ id }) => id === currentId)
        || !optionalGridPosition(restoredHexGrid, currentId)) {
        throw new Error("Bieżący summon nie ma legalnego okna AI");
      }
    } else {
      const hasLivingFieldHero = restoredParty.slots.some((id) => {
        const character = restoredRoster.get(id);
        return character.lifeState === "alive"
          && character.resources.hp > 0
          && restoredPortals.locationOf(id)?.kind === "area";
      });
      if (!monsters.some(u=>u.id===current.id) || current.hp <= 0 || !hasLivingFieldHero) {
        throw new Error("Bieżący przeciwnik nie należy do aktywnego spotkania");
      }
    }
  }

  if (Object.keys(restoredEnemyAiById).length!==monsters.length || monsters.some(u=>!Object.hasOwn(restoredEnemyAiById,u.id))) throw new Error('Niekompletna mapa AI');
  for(const restoredEnemyAi of Object.values(restoredEnemyAiById)) {
  if (!restoredEnemyAi || restoredEnemyAi.profileId !== AI_PROFILE_IDS.MELEE_PRESSURE) {
    throw new Error("Zapis ma nieobsługiwany profil AI przeciwnika");
  }
  if (restoredEnemyAi.currentTargetId !== null
    && (!restoredParty.isActive(restoredEnemyAi.currentTargetId) || !restoredRoster.has(restoredEnemyAi.currentTargetId))) {
    throw new Error("Pamięć celu AI wskazuje postać spoza aktywnej drużyny");
  }
  }

  const reservations = new Map(restoredHexGrid.reservations().map((entry) => [entry.eventId, entry]));
  const futureMoveEvents = restoredCombat.scheduler.queue.filter(({ kind }) => kind === "move:step");
  for (const event of futureMoveEvents) {
    const reservation = reservations.get(event.id);
    if (!reservation
      || reservation.commandId !== event.payload.commandId
      || reservation.unitId !== event.actorId
      || reservation.at !== event.at
      || !sameHex(reservation.from, event.payload.from)
      || !sameHex(reservation.to, event.payload.to)) {
      throw new Error(`Brak spójnej rezerwacji dla kroku ${event.id}`);
    }
  }
  const futureMoveIds = new Set(futureMoveEvents.map(({ id }) => id));
  for (const reservation of reservations.values()) {
    if (!futureMoveIds.has(reservation.eventId)) {
      throw new Error(`Rezerwacja nie ma przyszłego zdarzenia ruchu: ${reservation.eventId}`);
    }
  }
}

function validateSaveEnvelope(parsed) {
  if ((parsed?.campaignSchemaVersion === undefined) !== (parsed?.campaign === undefined)) throw new Error('Niekompletny nagłówek kampanii');
  if (parsed?.campaignSchemaVersion !== undefined && ![1, 2].includes(parsed.campaignSchemaVersion)) throw new Error('Nieobsługiwana wersja kampanii');
  if (!parsed || typeof parsed !== "object") throw new TypeError("Zapis nie jest obiektem");
  if (parsed.schemaVersion !== 3) throw new Error("Nieobsługiwany schemat zapisu; wymagany jest natywny zapis v3");
  const hasSkillTreeSchema = parsed.skillTreeSchemaVersion !== undefined || parsed.skillTreeCatalogId !== undefined;
  if (hasSkillTreeSchema && (parsed.skillTreeSchemaVersion !== SKILL_TREE_SAVE_SCHEMA_VERSION
    || parsed.skillTreeCatalogId !== SKILL_TREE_CATALOG_ID)) {
    throw new Error("Nieobsługiwany katalog lub schemat drzewek umiejętności");
  }
  if (parsed.game_ruleset_version !== GAME_RULESET_VERSION) throw new Error("Nieobsługiwana wersja reguł walki");
  if (parsed.source_snapshot_id !== SOURCE_SNAPSHOT_ID) throw new Error("Nieobsługiwany snapshot źródeł");
  if (parsed.settings !== undefined && (parsed.settings?.schemaVersion !== 1
    || !Number.isFinite(parsed.settings.musicVolume) || parsed.settings.musicVolume < 0 || parsed.settings.musicVolume > 1
    || !Number.isFinite(parsed.settings.effectsVolume) || parsed.settings.effectsVolume < 0 || parsed.settings.effectsVolume > 100
    || (parsed.settings.keybindings !== null && typeof parsed.settings.keybindings !== 'object'))) {
    throw new Error('Nieprawidłowe ustawienia gracza w zapisie');
  }
  if ((parsed.encounterSchemaVersion === undefined) !== (parsed.encounterProgress === undefined)) {
    throw new Error("Niekompletny nagłówek starć i łupu");
  }
  if (parsed.encounterSchemaVersion !== undefined && parsed.encounterSchemaVersion !== ENCOUNTER_SCHEMA_VERSION) {
    throw new Error("Nieobsługiwany schemat starć i łupu");
  }
  if ((parsed.equipmentSchemaVersion === undefined) !== (parsed.equipmentCatalogId === undefined)) {
    throw new Error('Niekompletny nagłówek wyposażenia: wymagane equipmentSchemaVersion i equipmentCatalogId');
  }
  if (parsed.equipmentSchemaVersion !== undefined && (parsed.equipmentSchemaVersion !== EQUIPMENT_SCHEMA_VERSION
    || parsed.equipmentCatalogId !== EQUIPMENT_CATALOG_ID)) throw new Error("Nieobsługiwany katalog lub schemat wyposażenia");
  migrateMouseSkillSnapshot(parsed, { catalog: mouseSkillCatalog, legacyCatalogIds: LEGACY_MOUSE_SKILL_CATALOG_IDS });
  if ((parsed.activeAuraSchemaVersion === undefined) !== (parsed.activeAuras === undefined)) {
    throw new Error('Niekompletny nagłówek aktywnych aur');
  }
  if (parsed.activeAuraSchemaVersion !== undefined && parsed.activeAuraSchemaVersion !== ACTIVE_AURA_SAVE_SCHEMA_VERSION) {
    throw new Error('Nieobsługiwany schemat aktywnych aur');
  }
  const migrated = completeV0517SaveEnvelope(parsed);
  if (migrated.campaignSchemaVersion === 1) migrated.campaignSchemaVersion = 2;
  // Saves produced before the source-audited trees were added remain readable;
  // their per-hero `skills` objects are preserved and interpreted by this
  // catalog from this point forward.
  if (!hasSkillTreeSchema) {
    migrated.skillTreeSchemaVersion = SKILL_TREE_SAVE_SCHEMA_VERSION;
    migrated.skillTreeCatalogId = SKILL_TREE_CATALOG_ID;
  }
  return migrated;
}

function restoreOwnedMap(entries, label, restoreValue) {
  if (!Array.isArray(entries)) throw new TypeError(`Zapis nie zawiera mapy: ${label}`);
  const restored = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]) {
      throw new TypeError(`Nieprawidłowy wpis mapy: ${label}`);
    }
    const [ownerId, value] = entry;
    if (restored.has(ownerId)) throw new Error(`Powielony właściciel w mapie ${label}: ${ownerId}`);
    restored.set(ownerId, restoreValue(value));
  }
  return restored;
}

function migratePreparationForRestoredWorld(snapshot, {
  restoredRoster, restoredParty, restoredPortals, restoredDeploymentColumnOf,
}) {
  const legacySchema = snapshot?.schemaVersion === 1;
  const migrated = structuredClone(BattlePreparationState.migrateSnapshot(snapshot,
    { deploymentColumnOf: restoredDeploymentColumnOf }));
  if (!legacySchema) {
    return {
      state: BattlePreparationState.restore(migrated,
        { deploymentColumnOf: restoredDeploymentColumnOf }),
      migrated: false,
    };
  }

  // Schema 1 predated explicit battlefield presence. Infer it from the already
  // persisted authoritative world: heroes in town and defeated heroes are off
  // field. Remove their legacy ghost positions and detach them from effects,
  // while preserving party-wide effects for every remaining target.
  const offFieldIds = new Set(restoredParty.slots.filter((heroId) => {
    const character = restoredRoster.get(heroId);
    return restoredPortals.locationOf(heroId)?.kind === "town"
      || character.lifeState !== "alive"
      || character.resources.hp <= 0;
  }));
  migrated.heroPresence = migrated.heroPresence.map(({ heroId }) => ({
    heroId,
    state: offFieldIds.has(heroId) ? UNIT_PRESENCE.OFF_FIELD : UNIT_PRESENCE.ON_FIELD,
  }));
  migrated.positions = migrated.positions.filter(({ unitId }) => !offFieldIds.has(unitId));
  migrated.buffs = migrated.buffs.flatMap((buff) => {
    if (offFieldIds.has(buff.sourceId)) return [];
    const targetIds = buff.targetIds.filter((targetId) => !offFieldIds.has(targetId));
    return targetIds.length > 0 ? [{ ...buff, targetIds }] : [];
  });
  return {
    state: BattlePreparationState.restore(migrated,
      { deploymentColumnOf: restoredDeploymentColumnOf }),
    migrated: true,
  };
}

function completeV0517SaveEnvelope(envelope) {
  const migrated = structuredClone(envelope);
  const savedPartySlotPositions = battlefieldModeForTiles(migrated.hexGrid?.tiles) === "legacy-187"
    ? legacyPartySlotPositions : partySlotPositions;
  let changed = false;
  const hasCampVersion = migrated.campServicesSchemaVersion !== undefined;
  const hasCampState = migrated.campServices !== undefined;
  if (hasCampVersion !== hasCampState) throw new Error("Niekompletny nagłówek usług obozu");
  // Only pre-camp saves may synthesize missing starter heroes or repair their
  // inventory index. On current saves an empty index beside a nonempty bag is
  // corruption and must never become a valid backup through migration.
  if (!hasCampState) {
    const rosterMigration = migrateMissingStarterRoster({
      roster: migrated.roster,
      inventories: migrated.inventories,
      catalog: equipmentCatalog,
    });
    migrated.roster = rosterMigration.roster;
    migrated.inventories = rosterMigration.inventories;
    changed ||= rosterMigration.addedIds.length > 0;
  }

  const heroIds = migrated.roster.map(({ id }) => id);
  const appendOwnedDefault = (field, factory) => {
    if (!Array.isArray(migrated[field])) throw new TypeError(`Zapis nie zawiera mapy: ${field}`);
    const known = new Set(migrated[field].map((entry) => entry?.[0]));
    for (const id of heroIds) {
      if (known.has(id)) continue;
      migrated[field].push([id, factory(id)]);
      known.add(id);
      changed = true;
    }
  };
  appendOwnedDefault("portalScrolls", () => new TownPortalScrollSupply({ tomeScrolls: 3 }).toJSON());
  appendOwnedDefault("belts", () => emptyPotionBelt());
  appendOwnedDefault("weaponSets", () => 1);

  const savedPortals = PortalSystem.fromJSON(migrated.portals);
  for (const [index, id] of heroIds.entries()) {
    if (savedPortals.locationOf(id)) continue;
    savedPortals.setCharacterLocation(id, {
      kind: "area",
      area_id: AREA_ID,
      instance_id: INSTANCE_ID,
      hex: structuredClone(savedPartySlotPositions[index % savedPartySlotPositions.length]),
    });
    changed = true;
  }
  migrated.portals = savedPortals.toJSON();

  const mouseMigration = migrateMouseSkillSnapshot(migrated, {
    catalog: mouseSkillCatalog,
    legacyCatalogIds: LEGACY_MOUSE_SKILL_CATALOG_IDS,
  });
  const defaultBindings = defaultMouseBindingsFromLoadouts(
    heroIds,
    (id) => defaultLoadouts[id],
    mouseSkillCatalog,
  );
  const mouseSnapshot = mouseMigration.snapshot ?? {
    schemaVersion: MOUSE_SKILL_SCHEMA_VERSION,
    catalogId: mouseSkillCatalog.id,
    bindings: [],
  };
  const mouseByHero = new Map(mouseSnapshot.bindings.map((entry) => [entry.heroId, entry]));
  for (const id of heroIds) {
    if (mouseByHero.has(id)) continue;
    mouseSnapshot.bindings.push({ heroId: id, left: "basic.attack", right: defaultBindings[id].right });
    changed = true;
  }
  migrated.mouseSkillSchemaVersion = MOUSE_SKILL_SCHEMA_VERSION;
  migrated.mouseSkillCatalogId = mouseSkillCatalog.id;
  migrated.mouseSkills = mouseSnapshot;
  changed ||= mouseMigration.migrated;

  if (Array.isArray(migrated.activeAuras)) {
    const auraOwners = new Set(migrated.activeAuras.map(({ heroId }) => heroId));
    for (const id of heroIds) {
      if (auraOwners.has(id)) continue;
      migrated.activeAuras.push({ heroId: id, activeAuraSkillId: null });
      changed = true;
    }
  }

  if (!hasCampState) {
    const freshCamp = new CampServicesState({ catalog: equipmentCatalog });
    migrated.campServicesSchemaVersion = CAMP_SERVICES_SCHEMA_VERSION;
    migrated.campServices = freshCamp.snapshot();
    changed = true;
  }
  const hasCubeVersion = migrated.horadricCubeSchemaVersion !== undefined;
  const hasCubeState = migrated.horadricCube !== undefined;
  if (hasCubeVersion !== hasCubeState) throw new Error("Niekompletny nagłówek Kostki Horadrimów");
  if (!hasCubeState) {
    migrated.horadricCubeSchemaVersion = HORADRIC_CUBE_SCHEMA_VERSION;
    migrated.horadricCube = new HoradricCubeState().snapshot();
  }
  migrated.__v0518CubeMigration = !hasCubeState;
  migrated.__v0517Migration = changed;
  return migrated;
}

function stageGameState(data) {
  const restoredCampaign = data.campaign == null ? null : CampaignState.restoreAct1(data.campaign,{catalog:equipmentCatalog});
  const areaEncounter = campaignEncounter(restoredCampaign);
  const commands = data?.combat?.commands;
  const projectiles = data?.combat?.projectiles;
  if (!data?.combat
    || !commands || typeof commands !== "object" || Array.isArray(commands)
    || !Array.isArray(commands.active)
    || !Array.isArray(commands.history)
    || !Array.isArray(commands.transactions)
    || !projectiles || typeof projectiles !== "object" || Array.isArray(projectiles)
    || !Array.isArray(projectiles.active)
    || !data.combat.controlEffects
    || !Array.isArray(data.combat.effects)
    || !Array.isArray(data.combat.log)
    || !Object.hasOwn(data.combat, "pendingPlayersValue")) {
    throw new Error("Natywny zapis v3 nie zawiera pełnego stanu poleceń, kontroli i dziennika");
  }
  if (!data.rng) throw new Error("Natywny zapis v3 nie zawiera stanu RNG");
  if (!data.hexGrid) throw new Error("Natywny zapis v3 nie zawiera snapshotu siatki heksowej");
  const restoredGeometryMode = battlefieldModeForTiles(data.hexGrid.tiles);
  const restoredDeploymentColumnOf = deploymentColumnForMode(restoredGeometryMode);
  if (!Array.isArray(data.pendingReturns)) throw new Error("Natywny zapis v3 nie zawiera kolejki powrotów");
  if (!data.battlePreparation) throw new Error("Natywny zapis v3 nie zawiera fazy, loadoutów, buffów i summonów");
  if (!Array.isArray(data.partyIds) || data.partyIds.length < 1 || data.partyIds.length > 3
    || new Set(data.partyIds).size !== data.partyIds.length) {
    throw new Error("Zapis musi zawierać od jednego do trzech aktywnych bohaterów");
  }
  const restoredRoster = new Roster(data.roster);
  const restoredParty = new Party(restoredRoster, data.partyIds);
  const restoredPlayers = new PlayersSetting(data.players);
  const restoredCombat = CombatState.restore(data.combat, {
    party: restoredParty,
    playersSetting: restoredPlayers,
  });
  if (data.encounterProgress !== undefined) validateLootRecords(data.encounterProgress, equipmentCatalog);
  const restoredEnemy = restoredCombat.units.get(areaEncounter
    ? (areaEncounter.monsters.some(e=>e.id===data.selectedEnemyId) ? data.selectedEnemyId : areaEncounter.monsters[0].id)
    : encounterEnemyId(data.encounterProgress?.encounterNumber ?? 1));
  if (!restoredEnemy || restoredEnemy.kind !== "monster") throw new Error("W zapisie brakuje przeciwnika spotkania");
  const restoredPortals = PortalSystem.fromJSON(data.portals);
  const restoredScrolls = restoreOwnedMap(data.portalScrolls, "portalScrolls", (supply) => TownPortalScrollSupply.fromJSON(supply));
  const restoredInventories = restoreOwnedMap(data.inventories, "inventories", (grid) => InventoryGrid.fromJSON(grid));
  if (data.beltSchemaVersion !== undefined && data.beltSchemaVersion !== 1) {
    throw new Error("Nieobsługiwany schemat pasa mikstur");
  }
  const restoredBelts = restoreOwnedMap(data.belts, "belts", (belt) => structuredClone(belt));
  const restoredWeaponSets = restoreOwnedMap(data.weaponSets, "weaponSets", (set) => set);
  if (data.campServicesSchemaVersion !== CAMP_SERVICES_SCHEMA_VERSION) {
    throw new Error("Nieobsługiwany schemat usług obozu");
  }
  const restoredCampServices = CampServicesState.restore(data.campServices, { catalog: equipmentCatalog });
  if (data.horadricCubeSchemaVersion !== HORADRIC_CUBE_SCHEMA_VERSION) {
    throw new Error("Nieobsługiwany schemat Kostki Horadrimów");
  }
  const restoredHoradricCube = HoradricCubeState.restore(data.horadricCube);
  for (const owned of [restoredScrolls, restoredInventories, restoredBelts, restoredWeaponSets]) {
    for (const ownerId of owned.keys()) {
      if (!restoredRoster.has(ownerId)) throw new Error(`Kontener należy do nieznanej postaci: ${ownerId}`);
    }
  }
  for (const id of restoredRoster.toJSON().map(({ id }) => id)) {
    if (!restoredScrolls.has(id) || !restoredInventories.has(id) || !restoredBelts.has(id) || !restoredWeaponSets.has(id)) {
      throw new Error(`Niekompletny stan kontenerów postaci: ${id}`);
    }
    const inventory = restoredInventories.get(id);
    if (inventory.width !== 10 || inventory.height !== 4) {
      throw new Error(`Nieprawidłowy rozmiar plecaka postaci: ${id}`);
    }
    const belt = restoredBelts.get(id);
    if (!validPotionBelt(belt)) throw new Error(`Nieprawidłowy pas postaci: ${id}`);
    if (restoredWeaponSets.get(id) !== 1) throw new Error(`Obsługiwany jest wyłącznie jeden zestaw broni postaci: ${id}`);
  }
  const equipmentMigrated = data.equipmentSchemaVersion === undefined;
  if (equipmentMigrated) migrateLegacyEquipment(restoredRoster, restoredInventories, equipmentCatalog);
  for (const [id, belt] of restoredBelts) {
    restoredBelts.set(id, resizePotionBelt(belt, potionBeltCapacity(restoredRoster.get(id), equipmentCatalog)));
  }
  const allEquipmentIds = validateEquipmentWorld(restoredRoster, restoredInventories, equipmentCatalog);
  restoredHoradricCube.validateUniqueOwnership(restoredInventories);
  restoredCampServices.validateUniqueOwnership(new Map([...restoredInventories, ['horadric-cube', restoredHoradricCube.grid]]));
  const campOnlyItems = [
    ...restoredCampServices.stash.toJSON().items,
    ...restoredCampServices.listVendors().flatMap(({ offers }) => offers.map(({ item }) => item)),
    ...restoredHoradricCube.grid.toJSON().items,
  ];
  const equippedIds = new Set(restoredRoster.toJSON().flatMap(({ equipment }) => Object.values(equipment).map(({ id }) => id)));
  for (const item of campOnlyItems) {
    if (equippedIds.has(item.id)) throw new Error(`Przedmiot obozu jest jednocześnie założony: ${item.id}`);
  }
  restoredCampaign?.validateAct1World({roster:restoredRoster,inventories:restoredInventories,
    catalog:equipmentCatalog,otherOwnedItems:campOnlyItems});
  const preparationMigration = migratePreparationForRestoredWorld(data.battlePreparation, {
    restoredRoster,
    restoredParty,
    restoredPortals,
    restoredDeploymentColumnOf,
  });
  const restoredPreparation = preparationMigration.state;
  const mouseMigration = migrateMouseSkillSnapshot(data, { catalog: mouseSkillCatalog, legacyCatalogIds: LEGACY_MOUSE_SKILL_CATALOG_IDS });
  const mouseSkillsMigrated = mouseMigration.migrated;
  const restoredMouseSkills = createMouseSkillState({
    rosterRef: restoredRoster,
    partyRef: restoredParty,
    preparationRef: restoredPreparation,
    snapshot: mouseMigration.snapshot,
  });
  const restoredHeroIds = restoredRoster.toJSON().map(({ id }) => id);
  const restoredSkillHotkeys = new SkillHotkeys(restoredHeroIds, data.skillHotkeys);
  for (const id of restoredHeroIds) restoredSkillHotkeys.retainAvailable(id,
    (skillId,side) => restoredMouseSkills.available(id,side).includes(skillId));
  const auraMigration = validateActiveAuraSnapshot(data, {
    heroIds: restoredHeroIds, buffs: restoredPreparation.listBuffs(), catalog: mouseSkillCatalog,
  });
  validatePendingSkillCommands({
    combat: data.combat, heroIds: restoredHeroIds, catalog: mouseSkillCatalog, skillDefinitions,
    knownSkillsByHero: Object.fromEntries(restoredHeroIds.map(id => [id, restoredMouseSkills.knownSkills(id)])),
  });
  const restoredRng = DeterministicRng.restore(data.rng);
  if (!Array.isArray(data.hexUnits)) throw new TypeError("Brak jednostek heksowych w zapisie");
  const restoredHexGrid = HexGrid.restore(data.hexGrid);
  const restoredTiles = restoredHexGrid.tiles();
  const expectedTileKeys = new Set(buildTiles(restoredGeometryMode).map(hexKey));
  const restoredTopologyMatches = restoredTiles.length === expectedTileKeys.size
    && restoredTiles.every((tile) => expectedTileKeys.has(hexKey(tile)));
  if (!restoredTopologyMatches) {
    throw new Error("Zapis używa niezgodnej, starszej geometrii pola walki");
  }
  const restoredEnemyAiById = data.enemyAiById === undefined
    ? {[restoredEnemy.id]:structuredClone(data.enemyAi)} : structuredClone(data.enemyAiById);
  if(!restoredEnemyAiById || typeof restoredEnemyAiById!=='object' || Array.isArray(restoredEnemyAiById)) throw new Error('Niepoprawna mapa AI');
  const restoredEnemyAi = restoredEnemyAiById[restoredEnemy.id];
  if(data.enemyAiById!==undefined && (data.enemyAi?.profileId!==restoredEnemyAi?.profileId
    || data.enemyAi?.currentTargetId!==restoredEnemyAi?.currentTargetId)) throw new Error('Niespójna pamięć wskazanego przeciwnika');
  const encounterMigrated = data.encounterSchemaVersion === undefined;
  const restoredProgress = encounterMigrated
    ? migrateLegacyEncounter({legacyLoot:data.loot ?? null, enemy:restoredEnemy, preparation:restoredPreparation, catalog:equipmentCatalog})
    : structuredClone(data.encounterProgress);
  const restoredLoot = structuredClone(data.loot ?? null);
  if(!areaEncounter) validateEncounterWorld(restoredProgress, {catalog:equipmentCatalog, roster:restoredRoster, inventories:restoredInventories,
    hexGrid:restoredHexGrid, enemy:restoredEnemy, preparation:restoredPreparation, otherOwnedItems:campOnlyItems});
  else {
    // Converted training receipts remain authoritative; campaign travel must not
    // create a second route for forging or losing their already collected gear.
    const trainingReceipts=new Map(restoredProgress.drops.map(drop=>[drop.id,drop]));
    const owned=new Map([...restoredRoster.toJSON().flatMap(hero=>[
      ...restoredInventories.get(hero.id).toJSON().items,...Object.values(hero.equipment),
    ]),...campOnlyItems].map(item=>[item.id,item]));
    for(const drop of trainingReceipts.values()) {
      if(!restoredHexGrid.has(drop.hex) || drop.status!=='collected' || !restoredRoster.has(drop.collectorId)
        || !owned.has(drop.id)) throw new Error('Niespójny odziedziczony łup treningowy');
      for(const key of ['canonicalId','baseCode','defense']) if(owned.get(drop.id)[key]!==drop.item[key]) throw new Error('Zmieniony odziedziczony przedmiot');
    }
    for(const id of owned.keys()) if((id==='short-sword-1'||id.startsWith('bm-01.loot.'))&&!trainingReceipts.has(id)) throw new Error('Przedmiot treningowy bez potwierdzenia');
  }
  const inventoryItemIds = new Set();
  for (const [ownerId, inventory] of restoredInventories) {
    for (const item of inventory.toJSON().items) {
      if (inventoryItemIds.has(item.id)) throw new Error(`Powielony identyfikator przedmiotu: ${item.id}`);
      inventoryItemIds.add(item.id);
    }
  }
  for (const [ownerId, belt] of restoredBelts) {
    for (const slot of belt) {
      if (!slot?.canonicalId) continue;
      if (inventoryItemIds.has(slot.id) || equippedIds.has(slot.id)
        || campOnlyItems.some(({ id }) => id === slot.id)) {
        throw new Error(`Mikstura pasa powiela identyfikator przedmiotu: ${slot.id}`);
      }
      inventoryItemIds.add(slot.id);
    }
  }
  if (restoredLoot?.id && (allEquipmentIds.has(restoredLoot.id)
    || campOnlyItems.some(({ id }) => id === restoredLoot.id))) {
    throw new Error(`Łup powiela identyfikator przedmiotu z ekwipunku: ${restoredLoot.id}`);
  }
  const rawPendingReturns = data.pendingReturns ?? [];
  const restoredPendingReturns = new Set(rawPendingReturns);
  validateRestoredWorld({
    restoredCampaign,
    restoredEnemyAiById,
    restoredRoster,
    restoredParty,
    restoredCombat,
    restoredEnemy,
    restoredPortals,
    restoredHexGrid,
    restoredEnemyAi,
    restoredPreparation,
    restoredLoot,
    restoredProgress,
    restoredPendingReturns,
    rawPendingReturns,
    rawHexUnits: data.hexUnits,
  });
  return {
    campaign: restoredCampaign,
    creationProfile: normalizeCreationProfile(data.creationProfile),
    enemyAiById: restoredEnemyAiById,
    roster: restoredRoster,
    party: restoredParty,
    players: restoredPlayers,
    combat: restoredCombat,
    enemy: restoredEnemy,
    enemyAi: restoredEnemyAi,
    battlePreparation: restoredPreparation,
    mouseSkills: restoredMouseSkills,
    skillHotkeys: restoredSkillHotkeys,
    portalSystem: restoredPortals,
    portalScrolls: restoredScrolls,
    inventories: restoredInventories,
    belts: restoredBelts,
    weaponSets: restoredWeaponSets,
    campServices: restoredCampServices,
    horadricCube: restoredHoradricCube,
    combatRng: restoredRng,
    damageEngine: new DamageEngine(restoredRng),
    hexGrid: restoredHexGrid,
    battlefieldGeometryMode: restoredGeometryMode,
    pendingReturns: restoredPendingReturns,
    actingUnitId: restoredPreparation.phase === BATTLE_PHASE.PREPARATION
      ? [data.actingUnitId, ...restoredParty.slots].find(id => restoredParty.isActive(id)
        && restoredRoster.get(id).lifeState === "alive" && restoredPreparation.isUnitOnField(id)) ?? null
      : null,
    inspectedCharacterId: restoredRoster.has(data.inspectedCharacterId)
      ? data.inspectedCharacterId
      : restoredParty.slots[0],
    loot: restoredLoot,
    encounterProgress: restoredProgress,
    encounterMigrated,
    preparationMigrated: preparationMigration.migrated,
    equipmentMigrated,
    mouseSkillsMigrated,
    activeAurasMigrated: auraMigration.migrated,
    v0517Migrated: data.__v0517Migration === true,
    v0518CubeMigrated: data.__v0518CubeMigration === true,
  };
}

function captureLiveSession() {
  return {
    campaign,
    creationProfile: structuredClone(creationProfile),
    enemyAiById,
    roster,
    party,
    players,
    combat,
    enemy,
    enemyAi,
    battlePreparation,
    mouseSkills,
    skillHotkeys,
    portalSystem,
    portalScrolls,
    inventories,
    belts,
    weaponSets,
    campServices,
    horadricCube,
    combatRng,
    damageEngine,
    hexGrid,
    battlefieldGeometryMode,
    pendingReturns,
    actingUnitId,
    inspectedCharacterId,
    loot,
    encounterProgress,
    encounterMigrated: false,
    preparationMigrated: false,
    equipmentMigrated: false,
    mouseSkillsMigrated: false,
    activeAurasMigrated: false,
    v0517Migrated: false,
    v0518CubeMigrated: false,
  };
}

function installLiveSession(state) {
  battleAnimationEpoch++;
  battleAnimation.cancel();
  battleAnimationBusy = false;
  battleImpactVisual = null;
  campaign = state.campaign ?? null;
  creationProfile = normalizeCreationProfile(state.creationProfile);
  enemyAiById = state.enemyAiById ?? {[state.enemy.id]:state.enemyAi};
  const areaEncounter = campaignEncounter();
  AREA_ID = areaEncounter?.areaId ?? 'act1.blood_moor';
  INSTANCE_ID = areaEncounter?.id ?? 'BM-01';
  roster = state.roster;
  party = state.party;
  players = state.players;
  combat = state.combat;
  enemy = state.enemy;
  enemyAi = state.enemyAi;
  battlePreparation = state.battlePreparation;
  mouseSkills = state.mouseSkills;
  skillHotkeys = state.skillHotkeys ?? new SkillHotkeys(roster.toJSON().map(({id}) => id));
  portalSystem = state.portalSystem;
  portalScrolls = state.portalScrolls;
  inventories = state.inventories;
  belts = state.belts;
  weaponSets = state.weaponSets;
  campServices = state.campServices;
  horadricCube = state.horadricCube;
  combatRng = state.combatRng;
  damageEngine = state.damageEngine;
  hexGrid = state.hexGrid;
  battlefieldGeometryMode = state.battlefieldGeometryMode
    ?? battlefieldModeForTiles(hexGrid.tiles());
  canvas.dataset.deploymentCells = battlefieldGeometryMode === "approved-v3" ? "26" : "30";
  battlefieldLayoutCache = null;
  pendingReturns = state.pendingReturns;
  actingUnitId = state.actingUnitId;
  inspectedCharacterId = state.inspectedCharacterId;
  loot = state.loot;
  encounterProgress = state.encounterProgress;
  playersSelect.value = String(players.value);
}

/** Reject a different/newer format before a write can replace its recovery data. */
function incompatibleSaveHeader(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion !== 3)
    || (parsed.beltSchemaVersion !== undefined && parsed.beltSchemaVersion !== 1)
    || (parsed.campaignSchemaVersion !== undefined && ![1, 2].includes(parsed.campaignSchemaVersion))
    || (parsed.campaign?.act1?.schemaVersion !== undefined && ![1, 2, 3].includes(parsed.campaign.act1.schemaVersion))
    || (parsed.campaign?.questState?.['act1.den_of_evil']?.schemaVersion !== undefined && parsed.campaign.questState['act1.den_of_evil'].schemaVersion !== 1)
    || (Array.isArray(parsed.roster) && parsed.roster.some(hero => ['normal:act1.den_of_evil', 'normal:den_of_evil'].some(key => {
      const receipt=hero?.questRewards?.[key];
      return receipt?.schemaVersion !== undefined && receipt.schemaVersion !== 1;
    })))
    || (Array.isArray(parsed.roster) && parsed.roster.some(h=>h.progression?.schemaVersion !== undefined && h.progression.schemaVersion !== 1))
    || (Array.isArray(parsed.roster) && parsed.roster.some(h=>h.progression?.catalogId !== undefined && h.progression.catalogId !== PROGRESSION_DATA.catalogId))
    || (typeof parsed.game_ruleset_version === 'string' && parsed.game_ruleset_version !== GAME_RULESET_VERSION)
    || (typeof parsed.source_snapshot_id === 'string' && parsed.source_snapshot_id !== SOURCE_SNAPSHOT_ID)
    || (parsed.creationProfile?.schemaVersion !== undefined && parsed.creationProfile.schemaVersion !== 1)
    || (parsed.encounterSchemaVersion !== undefined && parsed.encounterSchemaVersion !== ENCOUNTER_SCHEMA_VERSION)
    || (parsed.equipmentSchemaVersion !== undefined && parsed.equipmentSchemaVersion !== EQUIPMENT_SCHEMA_VERSION)
    || (parsed.equipmentCatalogId !== undefined && parsed.equipmentCatalogId !== EQUIPMENT_CATALOG_ID)
    || (parsed.mouseSkillSchemaVersion !== undefined && parsed.mouseSkillSchemaVersion !== MOUSE_SKILL_SCHEMA_VERSION)
    || (parsed.activeAuraSchemaVersion !== undefined && parsed.activeAuraSchemaVersion !== ACTIVE_AURA_SAVE_SCHEMA_VERSION)
    || (parsed.campServicesSchemaVersion !== undefined && parsed.campServicesSchemaVersion !== CAMP_SERVICES_SCHEMA_VERSION)
    || (parsed.horadricCubeSchemaVersion !== undefined && parsed.horadricCubeSchemaVersion !== HORADRIC_CUBE_SCHEMA_VERSION)
    || (parsed.horadricCube?.schemaVersion !== undefined && parsed.horadricCube.schemaVersion !== HORADRIC_CUBE_SCHEMA_VERSION)
    || (parsed.mouseSkillCatalogId !== undefined
      && parsed.mouseSkillCatalogId !== mouseSkillCatalog.id
      && !LEGACY_MOUSE_SKILL_CATALOG_IDS.has(parsed.mouseSkillCatalogId));
}

function inspectStoredSave(raw) {
  if (raw === null) return {valid:false, incompatible:false};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return {valid:false, incompatible:false}; }
  if (incompatibleSaveHeader(parsed)) return {valid:false, incompatible:true};
  try {
    // Uses a staged graph, never the live roster, inventory or scheduler.
    stageGameState(validateSaveEnvelope(parsed));
    return {valid:true, incompatible:false};
  } catch { return {valid:false, incompatible:false}; }
}

function preserveDamagedBrowserSave(key, raw) {
  if (raw === null || inspectStoredSave(raw).valid) return;
  const archiveKey = `${key}-corrupt-${Date.now()}-${crypto.randomUUID()}`;
  // A quota error must stop publication rather than destroying the only copy.
  localStorage.setItem(archiveKey, raw);
  if (localStorage.getItem(archiveKey) !== raw) throw new Error('Nie udało się zabezpieczyć uszkodzonego zapisu');
}

function publishSaveSnapshot(snapshot, { preserveBackup = false } = {}) {
  if (typeof preserveBackup !== "boolean") throw new TypeError("preserveBackup musi być wartością logiczną");
  const encoded = JSON.stringify(snapshot);
  const decoded = JSON.parse(encoded);
  const staged = validateSaveEnvelope(decoded);
  stageGameState(staged);

  const previous = localStorage.getItem(SAVE_KEY);
  const previousBackup = localStorage.getItem(SAVE_BACKUP_KEY);
  const previousStatus = inspectStoredSave(previous);
  const backupStatus = inspectStoredSave(previousBackup);
  if (previousStatus.incompatible || backupStatus?.incompatible) {
    throw new Error('Istnieje zapis z nieobsługiwanego schematu lub katalogu. Zachowano go bez zmian; ta wersja gry nie może go nadpisać');
  }
  let changedBackup = false;
  let changedPrimary = false;
  try {
    if (previous !== null && !previousStatus.valid) preserveDamagedBrowserSave(SAVE_KEY, previous);
    if (previousStatus.valid && !preserveBackup) {
      if (previousBackup !== null && !backupStatus.valid) preserveDamagedBrowserSave(SAVE_BACKUP_KEY, previousBackup);
      localStorage.setItem(SAVE_BACKUP_KEY, previous);
      changedBackup = true;
    }
    localStorage.setItem(SAVE_KEY, encoded);
    changedPrimary = true;
    const published = localStorage.getItem(SAVE_KEY);
    if (published !== encoded) throw new Error("Odczyt kontrolny zapisu różni się od opublikowanych danych");
    const verified = validateSaveEnvelope(JSON.parse(published));
    stageGameState(verified);
    const preservePrimary = preserveDiskPrimaryUntilSaved;
    const preserveInvalidBackup = preserveDiskBackupUntilSaved;
    saveBridge.write(encoded, { preserveBackup, preservePrimary, preserveInvalidBackup }).then(() => {
      if (preservePrimary) preserveDiskPrimaryUntilSaved = false;
      if (preserveInvalidBackup) preserveDiskBackupUntilSaved = false;
    }, (error) => showToast(`Zapis na dysku nie powiódł się: ${error.message}`, 'warning'));
    return true;
  } catch (error) {
    let rollbackError = null;
    try {
      if (changedPrimary) {
        if (previous === null) localStorage.removeItem(SAVE_KEY);
        else localStorage.setItem(SAVE_KEY, previous);
      }
      if (changedBackup) {
        if (previousBackup === null) localStorage.removeItem(SAVE_BACKUP_KEY);
        else localStorage.setItem(SAVE_BACKUP_KEY, previousBackup);
      }
    } catch (failure) {
      rollbackError = failure;
    }
    const suffix = rollbackError ? `; rollback: ${rollbackError.message}` : "";
    throw new Error(`${error.message}${suffix}`);
  }
}

function loadGameState({ externalCandidates = [] } = {}) {
  try {
    lastLoadedSaveKind = null;
    if(explorationCommandLocked)throw new Error('Poczekaj na zakończenie ruchu drużyny');
    const candidates = [
      // The disk slot is shared by every launcher port. An origin-local copy
      // can be older, so it must never replace a newer valid disk primary.
      ...externalCandidates.filter(candidate => candidate.kind === 'disk-v3'),
      { kind: "primary-v3", label: "zapis główny v3", raw: localStorage.getItem(SAVE_KEY) },
      ...externalCandidates.filter(candidate => candidate.kind === 'disk-backup-v3'),
      { kind: "backup-v3", label: "kopia zapasowa wyposażenia", raw: localStorage.getItem(SAVE_BACKUP_KEY) },
      ...(localStorage.getItem(SAVE_KEY) === null && localStorage.getItem(SAVE_BACKUP_KEY) === null ? [
        { kind: "legacy-encounter", label: "zapis v0.5.1/v0.5.2 (import bez nadpisania oryginału)", raw: localStorage.getItem(LEGACY_EQUIPMENT_SAVE_KEY) },
        { kind: "legacy-encounter", label: "kopia zapisu v0.5.1/v0.5.2", raw: localStorage.getItem(`${LEGACY_EQUIPMENT_SAVE_KEY}-backup`) },
        { kind: "legacy-equipment", label: "zapis v0.5.0 (import bez nadpisania oryginału)", raw: localStorage.getItem(LEGACY_ITEM_SAVE_KEY) },
        { kind: "legacy-equipment", label: "kopia zapisu v0.5.0", raw: localStorage.getItem(`${LEGACY_ITEM_SAVE_KEY}-backup`) },
      ] : []),
    ].filter(({ raw }) => raw !== null);
    if (!candidates.length) {
      showToast("Brak natywnego zapisu v3 ani jego kopii zapasowej.", "warning");
      return false;
    }
    const failures = [];
    let selected = null;
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate.raw);
        if (["primary-v3", "disk-v3", "legacy-encounter"].includes(candidate.kind) && parsed && typeof parsed === "object") {
          if (incompatibleSaveHeader(parsed)) {
            const error = new Error("Niezgodny zapis główny zachowano bez zmian; automatyczne odzyskanie nie może go nadpisać");
            error.stopSaveFallback = true;
            throw error;
          }
        }
        const data = validateSaveEnvelope(parsed);
        // Build and validate the entire replacement graph before touching live state.
        selected = {
          ...candidate,
          data,
          staged: stageGameState(data),
        };
        // Restoring a save must not rotate vendor stock or otherwise advance
        // the world. Session rotation belongs to a newly created game.
        break;
      } catch (error) {
        if (error.stopSaveFallback) throw error;
        failures.push(`${candidate.label}: ${error.message}`);
      }
    }
    if (!selected) throw new Error(failures.join("; "));

    const previous = captureLiveSession();
    try {
      installLiveSession(selected.staged);
      // A chooser belongs to the previous inspected/binding state. Never let
      // a successful load leave an old listbox open over the new session.
      closeMouseSkillChooser();
      // Preparation is deliberately scheduler-free.  A restored preparation
      // snapshot must not even ask the timeline for a command window.
      if (battlePreparation.phase !== BATTLE_PHASE.PREPARATION) driveTimeline();
      // Rendering is part of the staged install: a structurally valid graph that
      // cannot be rendered must never replace the live session.
      render();
      if (selected.staged.battlefieldGeometryMode === "legacy-187") {
        // A legacy battle keeps its original coordinates and raw stored save.
        // The next encounter will be staged on the approved 213-cell board.
      } else if (["backup-v3", "disk-backup-v3"].includes(selected.kind)) {
        const repairedSnapshot = buildSaveSnapshot();
        if (selected.data.settings) repairedSnapshot.settings = selected.data.settings;
        publishSaveSnapshot(repairedSnapshot, { preserveBackup: true });
      } else if (selected.staged.preparationMigrated || selected.staged.equipmentMigrated || selected.staged.encounterMigrated || selected.staged.mouseSkillsMigrated || selected.staged.activeAurasMigrated || selected.staged.v0517Migrated || selected.staged.v0518CubeMigrated || selected.kind === "legacy-equipment" || selected.kind === "legacy-encounter") {
        const migratedSnapshot = buildSaveSnapshot();
        if (selected.data.settings) migratedSnapshot.settings = selected.data.settings;
        publishSaveSnapshot(migratedSnapshot);
      }
      closePanel();
      clearTargeting(false);
      render();
      if (campaign && campaign.act1.currentAreaId !== TOWN_ID
        && !campaign.act1.exploration.activeBattle) openPanel('map');
    } catch (error) {
      installLiveSession(previous);
      try { render(); } catch { /* retain the original load error */ }
      throw error;
    }
    restoreSavedSettings(selected.data.settings);
    lastLoadedSaveKind = selected.kind;
    const message = selected.staged.battlefieldGeometryMode === "legacy-187"
      ? "Wczytano starą bitwę na jej planszy 187 pól. Po zakończeniu kolejne starcie użyje planszy 213 pól; oryginalnego zapisu nie nadpisano."
      : selected.kind === "legacy-encounter" || selected.staged.encounterMigrated
      ? "Zaimportowano poprzedni zapis do v0.5.18. Oryginał pozostał nietknięty; EXP i zasoby nie zostały odnowione."
      : selected.kind === "legacy-equipment" || selected.staged.equipmentMigrated
      ? "Zaimportowano wyposażenie do v0.5.18. Oryginalny zapis v0.5.0 pozostaje bez zmian."
      : ["backup-v3", "disk-backup-v3"].includes(selected.kind)
      ? "Wczytano kopię zapasową v3 i naprawiono zapis główny."
      : selected.kind === 'disk-v3'
      ? 'Wczytano pełny zapis gry z dysku.'
      : selected.staged.preparationMigrated
        ? `Wczytano zapis v3 i bezpiecznie zaktualizowano przygotowanie do schematu ${BATTLE_PREPARATION_SCHEMA_VERSION}.`
        : selected.staged.v0517Migrated
          ? "Wczytano zapis i bezpiecznie dodano pełną ósemkę bohaterów oraz usługi obozu."
          : selected.staged.v0518CubeMigrated
          ? "Wczytano zapis i dodano pustą Kostkę Horadrimów bez zmiany dotychczasowych przedmiotów."
          : "Wczytano tę samą instancję i kolejkę v3.";
    showToast(message);
    return true;
  } catch (error) {
    showToast(`Nie udało się wczytać: ${error.message}`, "warning");
    return false;
  }
}

function continuationState(disk = null, diskError = null) {
  const localPrimary = localStorage.getItem(SAVE_KEY);
  const localBackup = localStorage.getItem(SAVE_BACKUP_KEY);
  const legacy = [LEGACY_EQUIPMENT_SAVE_KEY, LEGACY_ITEM_SAVE_KEY]
    .flatMap(key => [localStorage.getItem(key), localStorage.getItem(`${key}-backup`)]);
  const all = [localPrimary, localBackup, disk?.primary ?? null, disk?.backup ?? null, ...legacy];
  const hasExisting = all.some(raw => raw !== null) || Boolean(disk?.primaryIssue || disk?.backupIssue);
  if (diskError) return { available: false, hasExisting, storageUnavailable: true,
    message: `Nie można sprawdzić zapisu dyskowego: ${diskError.message}` };
  if ([localPrimary, disk?.primary].some(raw => raw !== null && raw !== undefined && inspectStoredSave(raw).incompatible)) {
    return { available: false, hasExisting, storageUnavailable: true,
      message: 'Zapis pochodzi z nieobsługiwanej wersji. Zachowano go bez zmian.' };
  }
  const available = [localPrimary, disk?.primary, localBackup, disk?.backup, ...legacy]
    .some(raw => raw !== null && raw !== undefined && inspectStoredSave(raw).valid);
  const damaged = Boolean(disk?.primaryIssue || disk?.backupIssue)
    || all.some(raw => raw !== null && !inspectStoredSave(raw).valid);
  return {
    available, hasExisting, storageUnavailable: Boolean(diskError),
    message: available
      ? damaged ? 'Dostępna jest kopia zapasowa. Uszkodzony zapis zostanie zachowany.'
        : diskError ? `Uwaga: zapis dyskowy jest niedostępny (${diskError.message}).` : ''
      : hasExisting ? 'Zapis jest uszkodzony. Dane zachowano; nie rozpoczynaj nowej gry bez kopii.'
        : diskError ? `Nie można sprawdzić zapisu dyskowego: ${diskError.message}` : '',
  };
}

async function checkContinuation() {
  let disk = null, diskError = null;
  try { disk = await saveBridge.read(); }
  catch (error) { diskError = error; }
  if (disk?.backupIssue || (disk?.backup !== null && disk?.backup !== undefined && !inspectStoredSave(disk.backup).valid)) {
    preserveDiskBackupUntilSaved = true;
  }
  return continuationState(disk, diskError);
}

async function continueGame() {
  let disk = null;
  try { disk = await saveBridge.read(); }
  catch (error) {
    showToast(`Nie można odczytać zapisu z dysku: ${error.message}`, 'warning');
    return false;
  }
  if (disk?.primaryIssue
    || (disk?.primary !== null && disk?.primary !== undefined && !inspectStoredSave(disk.primary).valid)) {
    preserveDiskPrimaryUntilSaved = true;
  }
  if (disk?.backupIssue || (disk?.backup !== null && disk?.backup !== undefined && !inspectStoredSave(disk.backup).valid)) {
    preserveDiskBackupUntilSaved = true;
  }
  const candidates = disk ? [
    { kind: 'disk-v3', label: 'zapis dyskowy v3', raw: disk.primary },
    { kind: 'disk-backup-v3', label: 'dyskowa kopia zapasowa v3', raw: disk.backup },
  ] : [];
  if (!loadGameState({ externalCandidates: candidates })) return false;
  try {
    if (lastLoadedSaveKind === 'primary-v3') publishSaveSnapshot(buildSaveSnapshot());
    await saveBridge.flush();
    return true;
  } catch (error) {
    showToast(`Kontynuacja wczytała stan, lecz nie mogła utrwalić go na dysku: ${error.message}`, 'warning');
    return false;
  }
}

async function saveAndExitGame() {
  if (!saveGameState()) return false;
  try {
    await saveBridge.flush();
    return true;
  } catch (error) {
    showToast(`Gra pozostała otwarta: zapis na dysku nie powiódł się (${error.message}).`, 'warning');
    return false;
  }
}

for (const side of ["left", "right"]) {
  document.querySelector(`#mouse-skill-${side}`)?.addEventListener("click", (event) => {
    if (isPaused()) return;
    event.stopPropagation();
    // The whole hand tile opens assignment; battlefield LPM/PPM uses it.
    mouseSkillChooserSide = mouseSkillChooserSide === side ? null : side;
    renderMouseSkillHud();
  });
}

document.querySelector("#mouse-skill-chooser")?.addEventListener("click", (event) => {
  if (isPaused()) return;
  const choice = event.target.closest("[data-skill-id][data-mouse-side]");
  if (!choice) return;
  if (choice.dataset.usable !== 'true') { showSkillTooltip(choice); return; }
  const character = inspectedCharacter();
  try {
    refreshHeroSkillAvailability(character.id);
    const result = mouseSkills.assign(character.id, choice.dataset.mouseSide, choice.dataset.skillId);
    const skill = skillDefinitions[choice.dataset.skillId];
    combat.log.push(`${character.name} przypisuje ${skill?.name ?? choice.dataset.skillId} do ${choice.dataset.mouseSide === "left" ? "LPM" : "PPM"}; zmiana nie zużywa czasu.`);
    if (result.changed) {
      // The hover plan belongs to the previous active LPM skill. Invalidate it
      // before the next render so the HUD and path overlay cannot describe a
      // command that the next click will no longer execute.
      primaryHoverPlan = null;
      hoveredHex = null;
    }
    closeMouseSkillChooser();
    if (result.changed) showToast(`${skill?.name ?? choice.dataset.skillId} → ${choice.dataset.mouseSide === "left" ? "LPM" : "PPM"}.`, "success");
    render();
  } catch (error) {
    showToast(`Nie można przypisać skilla: ${error.message}`, "warning");
  }
});

const skillChooser = document.querySelector('#mouse-skill-chooser');
for (const type of ['pointerover', 'focusin']) skillChooser.addEventListener(type, event => {
  const choice = event.target.closest('.mouse-skill-choice');
  if (!choice) return;
  hoveredSkillChoice = { skillId: choice.dataset.skillId, side: choice.dataset.mouseSide, usable: choice.dataset.usable === 'true' };
  showSkillTooltip(choice);
});
skillChooser.addEventListener('pointerleave', () => { hoveredSkillChoice = null; hideSkillTooltip(); });
window.addEventListener('resize', () => { if (mouseSkillChooserSide) renderMouseSkillChooser(inspectedCharacter()); });
window.addEventListener('keydown', event => {
  if (mainMenuOpen || activePanel || isPaused() || event.altKey || event.ctrlKey || event.metaKey
    || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (mouseSkillChooserSide && ['Space', 'KeyS'].includes(event.code)) {
    event.preventDefault(); event.stopImmediatePropagation(); closeMouseSkillChooser(); return;
  }
  if (!SKILL_HOTKEYS.includes(event.code)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat) return;
  const character = inspectedCharacter();
  try {
    refreshHeroSkillAvailability(character.id);
    if (mouseSkillChooserSide) {
      if (!hoveredSkillChoice?.usable || hoveredSkillChoice.side !== mouseSkillChooserSide) return;
      if (!mouseSkills.available(character.id, hoveredSkillChoice.side).includes(hoveredSkillChoice.skillId)) return;
      skillHotkeys.assign(character.id, event.code, hoveredSkillChoice.side, hoveredSkillChoice.skillId);
      renderMouseSkillHud();
      return;
    }
    const binding = skillHotkeys.get(character.id, event.code);
    if (!binding) return;
    mouseSkills.assign(character.id, binding.side, binding.skillId);
    primaryHoverPlan = null; hoveredHex = null;
    renderMouseSkillHud(); drawScene();
  } catch (error) { showToast(error.message, 'warning'); }
}, true);

document.querySelector("#hud-belt")?.addEventListener("click", (event) => {
  if (isPaused()) return;
  const button = event.target.closest("[data-belt-index]");
  if (!button || button.disabled) return;
  useHudBeltSlot(Number(button.dataset.beltIndex));
});
document.querySelector('#hud-belt')?.addEventListener('contextmenu', (event) => {
  const button = event.target.closest('[data-belt-index]');
  if (!button) return;
  event.preventDefault();
  if (!isPaused() && !button.disabled) useHudBeltSlot(Number(button.dataset.beltIndex));
});

document.querySelector("#cards").addEventListener("click", (event) => {
  if (isPaused()) return;
  const card = event.target.closest("[data-action]");
  const action = card?.dataset.action;
  if (!action || card.disabled) return;
  if (action === "skill") activateSkillCard(card.dataset.skillId);
});

document.querySelector(".utility-deck").addEventListener("click", (event) => {
  if (isPaused()) return;
  const control = event.target.closest("[data-action]");
  if (!control || control.disabled || control.id === "end-turn") return;
  if (control.dataset.action === "move") beginTargeting("move");
  if (control.dataset.action === "potion") {
    const belt = belts.get(actingCharacter()?.id) ?? [];
    const index = belt.findIndex((slot) => potionKind(slot) === control.dataset.potion && beltSlotCount(slot) > 0);
    if (index >= 0) useBeltSlot(index);
  }
  if (control.dataset.action === "change-loadout") cycleLoadoutSkill();
});

function buildPrimaryHoverPlan(selectedHex) {
  if (!campaignBattleAvailable()) return null;
  if (!selectedHex || pendingTarget || activePanel || isPaused()) return null;
  const actor = actingCharacter();
  if (!actor || !characterOnBattlefield(actor.id)) return null;
  if (battlePreparation.phase === BATTLE_PHASE.ACTIVE && inspectedCharacterId !== actor.id) return null;
  const targetEnemy = livingMonsterAt(selectedHex);
  if (!targetEnemy) return null;
  const binding = mouseSkills.get(actor.id);
  const skill = skillDefinitions[binding.left];
  if (!skill || !isOffensiveSkill(skill) || skill.range !== 1) return null;
  const profile = equipmentSkillProfile(actor, skill, equipmentCatalog);
  if (profile?.error) return null;
  const plan = planApproachAttack({
    grid: hexGrid,
    actorId: actor.id,
    targetId: targetEnemy.id,
    range: skill.range,
    maxMoveCost: 3,
    requireLineOfSight: true,
  });
  return Object.freeze({
    ...plan,
    actorId: actor.id,
    targetId: targetEnemy.id,
    skillId: skill.id,
    totalDuration: ACTION_TIME.attack + (plan.moveCost ?? 0) * ACTION_TIME.movePerTile,
  });
}

canvas.addEventListener("mousemove", (event) => {
  if (!campaignBattleAvailable()) return;
  const selected = clientToHex(event.clientX, event.clientY);
  if (pendingTarget) {
    primaryHoverPlan = null;
    hoveredHex = selected;
    render();
    return;
  }
  const nextPreview = buildPrimaryHoverPlan(selected);
  primaryHoverPlan = nextPreview;
  hoveredHex = activePanel || isPaused() ? null : selected;
  if (!pendingTarget) {
    const actor = actingCharacter();
    movementChoices = actor && characterOnBattlefield(actor.id)
      ? new Map(hexGrid.reachable(actor.id, 3).map(choice => [hexKey(choice.position), choice])) : new Map();
  }
  render();
});

canvas.addEventListener("mouseleave", () => {
  if (!pendingTarget && !primaryHoverPlan && !hoveredHex) return;
  hoveredHex = null;
  primaryHoverPlan = null;
  render();
});

const canvasNavigationVectors = Object.freeze({
  arrowup: Object.freeze({ x: 0, y: -1 }),
  w: Object.freeze({ x: 0, y: -1 }),
  arrowdown: Object.freeze({ x: 0, y: 1 }),
  s: Object.freeze({ x: 0, y: 1 }),
  arrowleft: Object.freeze({ x: -1, y: 0 }),
  a: Object.freeze({ x: -1, y: 0 }),
  arrowright: Object.freeze({ x: 1, y: 0 }),
  d: Object.freeze({ x: 1, y: 0 }),
});

function keyboardNeighbor(origin, key) {
  const desired = canvasNavigationVectors[key.toLowerCase()];
  if (!desired || !origin) return null;
  const originPoint = hexToScreen(origin);
  return hexNeighbors(origin)
    .filter((candidate) => hexGrid.has(candidate))
    .map((candidate) => {
      const point = hexToScreen(candidate);
      const dx = point.x - originPoint.x;
      const dy = point.y - originPoint.y;
      return { candidate, score: (dx * desired.x + dy * desired.y) / Math.hypot(dx, dy) };
    })
    .sort((left, right) => right.score - left.score || left.candidate.q - right.candidate.q || left.candidate.r - right.candidate.r)[0]?.candidate ?? null;
}

function describeKeyboardHex(position) {
  canvas.dataset.keyboardHex = position ? hexKey(position) : "";
  if (!position || !pendingTarget) return;
  const title = document.querySelector("#targeting-title").textContent;
  const copy = document.querySelector("#targeting-copy").textContent;
  canvas.setAttribute("aria-label", `${title}. ${copy} Wskazany heks: kolumna ${deploymentColumnOf(position) + 1}, rząd ${battlefieldRowOf(position) + 1}.`);
}

canvas.addEventListener("keydown", (event) => {
  if (!pendingTarget || activePanel || isPaused()) return;
  const navigation = canvasNavigationVectors[event.key.toLowerCase()];
  if (navigation) {
    event.preventDefault();
    event.stopPropagation();
    const origin = hoveredHex ?? optionalGridPosition(hexGrid, pendingTargetActorId ?? actingUnitId);
    const next = keyboardNeighbor(origin, event.key);
    if (!next) return;
    hoveredHex = next;
    describeKeyboardHex(next);
    render();
    return;
  }
  if (event.key !== "Enter" && event.code !== "Space") return;
  if (event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  if (!hoveredHex) {
    hoveredHex = optionalGridPosition(hexGrid, pendingTargetActorId ?? actingUnitId);
    describeKeyboardHex(hoveredHex);
    render();
    return;
  }
  selectTargetHex(hoveredHex);
});

async function presentPreparationMove(selected, choice, actorId) {
  const epoch = ++battleAnimationEpoch;
  battleAnimationBusy = true;
  try {
    const stepDuration = walkStepDuration(choice.path.length - 1);
    for (let i = 1; i < choice.path.length; i++) {
      const played = await battleAnimation.play({actorId, clip: 'walk',
        from: hexToScreen(choice.path[i - 1]), to: hexToScreen(choice.path[i])}, stepDuration);
      if (!played || epoch !== battleAnimationEpoch) return;
    }
    battleAnimationBusy = false;
    selectTargetHex(selected, {presented: true});
  } finally {
    if (epoch === battleAnimationEpoch) { battleAnimationBusy = false; render(); }
  }
}

function selectTargetHex(selected, {presented = false} = {}) {
  if (battleAnimationBusy) return;
  if (!pendingTarget || activePanel) return;
  if (!pendingTargetActorId || pendingTargetActorId !== actingUnitId) {
    clearTargeting(false);
    showToast("Celowanie anulowano, ponieważ zmieniła się aktywna postać.", "warning");
    render();
    return;
  }
  if (!selected) return;
  if (pendingTarget === "move") {
    const choice = movementChoices.get(hexKey(selected));
    if (!choice) {
      showToast("Ten heks jest poza zasięgiem lub zablokowany.", "warning");
      return;
    }
    if (battlePreparation.phase === BATTLE_PHASE.PREPARATION) {
      const actor = actingCharacter();
      if (!presented && heroWalkAnimationAvailable(actor.id)) {
        void presentPreparationMove(selected, choice, actor.id);
        return;
      }
      try {
        // Validate both authoritative spatial models before publishing either
        // mutation. Assigning the validated clones makes this commit atomic.
        const stagedPreparation = BattlePreparationState.restore(battlePreparation.snapshot(), { deploymentColumnOf });
        const result = stagedPreparation.moveUnit({ unitId: actor.id, to: selected });
        const stagedGrid = HexGrid.restore(hexGrid.snapshot());
        const path = stagedGrid.moveUnit(actor.id, selected, { maxCost: choice.cost });
        if (!path) throw new Error("trasa została zablokowana");
        const stagedPortals = PortalSystem.fromJSON(portalSystem.toJSON());
        stagedPortals.setCharacterLocation(actor.id, { kind: "area", area_id: AREA_ID, instance_id: INSTANCE_ID, hex: selected });
        const combatUnit = combat.units.get(actor.id);
        if (!combatUnit) throw new Error("brak jednostki bohatera w modelu walki");
        battlePreparation = stagedPreparation;
        hexGrid = stagedGrid;
        portalSystem = stagedPortals;
        combatUnit.position = selected;
        combat.log.push(result.activated
          ? `${actor.name} wychodzi ze strefy rozstawienia; walka rozpoczyna się.`
          : `${actor.name} zmienia ustawienie w zielonej strefie bez uruchamiania AI.`);
        clearTargeting(false);
        if (result.activated) {
          // Deployment exits commit atomically, then pay their exact movement
          // recovery in the common scheduler. Active-combat moves still retain
          // their reserved per-step events through submitMovement().
          setOpeningReadinessOrder(actor.id);
          actingUnitId = null;
          driveTimeline();
          if (actingUnitId !== actor.id) throw new Error("nie udało się przydzielić kolejki jednostce wychodzącej ze strefy");
          commitActiveTurn(() => combat.submitAction(actor.id, "move", {
            distance: choice.cost,
            to: selected,
            path: choice.path,
            openingDeploymentExit: true,
          }));
          driveTimeline();
          showToast("OPUSZCZONO ZIELONĄ STREFĘ — WALKA ROZPOCZĘTA.", "warning");
        }
        render();
      } catch (error) {
        showToast(`Ruch odrzucony: ${error.message}`, "warning");
      }
    } else {
      completePlayerAction("move", { distance: choice.cost, to: selected, path: choice.path });
    }
  } else if (pendingTarget === "skill") {
    try {
      attackSelectedHex(selected);
    } catch (error) {
      clearTargeting(false);
      showToast(`Umiejętność odrzucona: ${error.message}`, "warning");
      render();
    }
  } else if (pendingTarget === "portal") {
    if (!portalChoices.has(hexKey(selected))) {
      showToast("Portal nie może powstać na tym polu.", "warning");
      return;
    }
    openPortalAt(selected);
  }
}

const worldInputGuard = new WorldInputGuard();
canvas.addEventListener("click", (event) => {
  if (!campaignBattleAvailable()) return;
  const selected = clientToHex(event.clientX, event.clientY);
  if (!worldInputGuard.accept(event, selected)) return;
  if (pendingTarget) {
    selectTargetHex(selected);
    return;
  }
  if (activePanel || isPaused() || !selected) return;
  const occupant = hexGrid.occupantAt(selected);
  if (occupant && party.isActive(occupant)) {
    selectHeroFromBattlefield(occupant);
    return;
  }
  if (livingMonsterAt(selected)) {
    activateBoundMouseSkillAtHex("left", selected);
    return;
  }
  if (visibleGroundDrops().some(drop => sameHex(drop.hex, selected))) {
    openPanel("loot");
    return;
  }
  // Diablo-style primary click: empty ground means movement; no separate MOVE button.
  // Never move a hidden/current actor while the HUD is showing another hero.
  if (!inspectedHeroCanIssueWorldCommand()) return;
  if (beginTargeting("move")) {
    try { selectTargetHex(selected); }
    finally { if (!battleAnimationBusy && pendingTarget === 'move') clearTargeting(false); render(); }
  }
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (!campaignBattleAvailable()) return;
  if (pendingTarget || activePanel || isPaused()) return;
  const selected = clientToHex(event.clientX, event.clientY);
  if (!worldInputGuard.accept(event, selected)) return;
  activateBoundMouseSkillAtHex("right", selected);
});

document.querySelector("#loot-toast").addEventListener("click", () => togglePanel("loot"));
document.querySelector("#next-encounter").addEventListener("click", event => startNextEncounter(Number(event.currentTarget.dataset.encounter)));
document.querySelector("#cancel-targeting").addEventListener("click", () => clearTargeting());
document.querySelector("#start-battle").addEventListener("click", startBattleExplicitly);
document.querySelector("#end-turn").addEventListener("click", () => {
  if (campaignBattleAvailable() && !isPaused() && !activePanel && !pendingTarget) completePlayerAction("wait");
});
const playersSelect = document.querySelector("#players");
for (let value = 1; value <= 8; value += 1) playersSelect.add(new Option(`P${value}`, String(value)));
playersSelect.addEventListener("change", () => {
  if (isPaused()) {
    playersSelect.value = String(players.value);
    return;
  }
  const value = Number(playersSelect.value);
  players.set(value);
  combat.requestPlayersChange(value);
  render();
});

document.querySelector("#save").addEventListener("click", saveGameState);
document.querySelector("#load").addEventListener("click", continueGame);
document.querySelector("#camp-save")?.addEventListener("click", saveGameState);
document.querySelector("#camp-load")?.addEventListener("click", continueGame);
document.querySelector("#camp-open-team")?.addEventListener("click", () => openTeamSelection());
document.querySelector("#camp-open-inventory")?.addEventListener("click", () => openPanel("inventory"));
document.querySelector("#camp-open-map")?.addEventListener("click", () => openPanel("map"));
document.querySelector("#team-selection-confirm")?.addEventListener("click", confirmTeamSelection);
document.querySelector("#team-selection-cancel")?.addEventListener("click", closeTeamSelection);
teamSelectionLayer?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeTeamSelection();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [...teamSelectionLayer.querySelectorAll("button:not([disabled]):not([hidden])")]
    .filter((element) => element.getClientRects().length > 0);
  if (!controls.length) return;
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
const campPanels = Object.freeze({
  charsi: "camp-charsi",
  kashya: "camp-kashya",
  gheed: "camp-gheed",
  warriv: "camp-warriv",
  cain: "camp-cain",
  stash: "camp-stash",
  waypoint: "camp-waypoint",
});
campLayer?.querySelectorAll("[data-camp-action]").forEach((button) => button.addEventListener("click", () => {
  if (!isSafeCamp()) return;
  const action = button.dataset.campAction;
  button.classList.remove("is-invoked");
  void button.offsetWidth;
  button.classList.add("is-invoked");
  setTimeout(() => button.classList.remove("is-invoked"), 500);
  if (action === "gate") {
    travelAct1("act1.blood_moor");
    return;
  }
  if (action === "cain" && !CAIN_RESCUED_PREVIEW) return;
  if (action === 'akara') {
    if (!akaraAction('heal', { fromVisit: true })) return;
    openPanel('camp-trade-akara');
    return;
  }
  if (campPanels[action]) openPanel(campPanels[action]);
}));
document.querySelector("#clear-log").addEventListener("click", () => {
  logCutoff = combat.log.length;
  renderLog();
});
document.querySelector("#pause").addEventListener("click", () => togglePause(false));
document.querySelector("#resume").addEventListener("click", () => togglePause(true));
pauseOverlay.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || pauseOverlay.classList.contains("hidden")) return;
  const controls = focusablePauseControls();
  if (controls.length === 0) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
document.querySelector("#close-panel").addEventListener("click", closePanel);
panelLayer.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !activePanel || panelLayer.classList.contains("hidden")) return;
  const controls = focusablePanelControls();
  if (controls.length === 0) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  const panel = panelLayer;
  if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
panelLayer.addEventListener("pointerdown", (event) => {
  if (event.target === panelLayer) closePanel();
});
document.querySelectorAll("[data-open-panel]").forEach((button) => button.addEventListener("click", () => togglePanel(button.dataset.openPanel)));
document.querySelector("#portal-quick").addEventListener("click", () => togglePanel("portal"));

try {
  shortcutManager = KeybindingManager.load(localStorage, undefined, {
    actions: shortcutActions(),
    escape: {
      cancel: () => clearTargeting(),
      chooser: () => closeMouseSkillChooser(),
      closePanel,
      pause: openCampMenuOrTogglePause,
    },
  });
  shortcutManager.attach(window);
} catch {
  replaceShortcutManager(DEFAULT_KEYBINDINGS);
}

function battlefieldGeometrySnapshot() {
  const metrics = layoutMetrics();
  const gridReference = battlefieldGeometryMode === "approved-v3"
    ? BATTLEFIELD_GRID : LEGACY_BATTLEFIELD_GRID;
  const tiles = hexGrid.tiles().map((tile) => ({
    q: tile.q,
    r: tile.r,
    column: deploymentColumnOf(tile),
    row: battlefieldRowOf(tile),
    deployment: deploymentColumnOf(tile) < BATTLEFIELD_GRID.deploymentColumns,
    center: hexToScreen(tile, 0, metrics),
    vertices: hexVertices(tile, metrics),
  }));
  return {
    viewport: { ...viewport },
    metrics: {
      size: metrics.size,
      qx: metrics.qx,
      qy: metrics.qy,
      rx: metrics.rx,
      ry: metrics.ry,
      hexWidth: metrics.hexWidth,
      hexHeight: metrics.hexHeight,
      scaleX: metrics.scaleX,
      scaleY: metrics.scaleY,
    },
    targetFootprint: { ...metrics.frame },
    bounds: {
      left: metrics.left,
      top: metrics.top,
      right: metrics.right,
      bottom: metrics.bottom,
      width: metrics.gridWidth,
      height: metrics.gridHeight,
    },
    reference: {
      mode: battlefieldGeometryMode,
      columns: gridReference.columns,
      totalTiles: gridReference.totalTiles,
      deploymentColumns: gridReference.deploymentColumns,
      rotationDegrees: gridReference.rotationDegrees,
      diagnostic: GRID_DIAGNOSTIC,
    },
    tiles,
  };
}

const observer = new ResizeObserver(resizeCanvas);
observer.observe(canvas.parentElement);
canvas.dataset.deploymentCells = battlefieldGeometryMode === "approved-v3" ? "26" : "30";
resizeCanvas();
const rotwDebugApi = Object.freeze({
  storageKeys: Object.freeze({current:SAVE_KEY,backup:SAVE_BACKUP_KEY,legacyEquipment:LEGACY_EQUIPMENT_SAVE_KEY}),
  explorationCommandLocked: () => explorationCommandLocked,
  inputState: () => ({ activePanel, pendingTarget, pendingTargetActorId,
    battleAnimationBusy,
    paused:isPaused(), movementChoiceCount:movementChoices.size,
    hoveredHex: hoveredHex ? {...hoveredHex} : null, hoveredEnemyId: livingMonsterAt(hoveredHex)?.id ?? null }),
  snapshot: () => ({
    animation: {busy: battleAnimationBusy, current: battleAnimation.current ? structuredClone(battleAnimation.current) : null,
      facing: [...battleAnimation.facing], loaded: Object.keys(BARBARIAN_ATLASES).filter(key => barbarianAtlases[key]?.frames),
      unarmedLoaded: Object.keys(BARBARIAN_UNARMED_ATLASES).filter(key => barbarianAtlases[key]?.frames)},
    phase: battlePreparation.phase,
    enemyTurnsEnabled: battlePreparation.enemyTurnsEnabled,
    enemyAwarenessEnabled: battlePreparation.enemyAwarenessEnabled,
    actingUnitId,
    primaryHoverPlan: primaryHoverPlan ? structuredClone(primaryHoverPlan) : null,
    preparation: battlePreparation.snapshot(),
    mouseSkills: mouseSkills.snapshot(),
    hexUnits: serializeHexUnits(),
    save: buildSaveSnapshot(),
  }),
  equipment: (id = inspectedCharacterId) => ({
    stats: equipmentStats(roster.get(id), equipmentCatalog),
    items: inventories.get(id).toJSON(), equipment: structuredClone(roster.get(id).equipment),
    leftSkill: equipmentSkillProfile(roster.get(id), skillDefinitions[(party.isActive(id) ? battlePreparation.getLoadout(id) : reserveLoadouts[id]).left], equipmentCatalog),
  }),
  battlefieldGeometry: battlefieldGeometrySnapshot,
  projectHex: (q, r) => {
    const position = axial(q, r);
    return hexGrid.has(position) ? hexToScreen(position) : null;
  },
  hitTestHex: (x, y) => screenToHex(x, y),
  hitTestClient: (clientX, clientY) => clientToHex(clientX, clientY),
  saveGameState,
  loadGameState,
});
// Keep the existing diagnostics available in both the module global and the
// page global. Browser smoke tests run in an isolated evaluation realm where
// `globalThis` and `window` are not always the same object.
globalThis.__rotwDebug = rotwDebugApi;
if (typeof window !== "undefined") window.__rotwDebug = rotwDebugApi;
beginCampTradingSession({ campServices, inventories, horadricCube });
if (battlePreparation.phase === BATTLE_PHASE.ACTIVE) driveTimeline();
render();
const freshGameTemplate = buildSaveSnapshot();
function startFreshGame() {
  const previous = captureLiveSession();
  try {
    const candidate = structuredClone(freshGameTemplate);
    if (candidate.campaign) {
      candidate.campaign = new CampaignState({
        worldSeed: crypto.getRandomValues(new Uint32Array(1))[0],
      }).toJSON();
    }
    const staged = stageGameState(validateSaveEnvelope(candidate));
    beginCampTradingSession(staged);
    installLiveSession(staged);
    clearTargeting(false);
    closePanel();
    render();
    characterCreation.show();
    return true;
  } catch (error) {
    installLiveSession(previous);
    render();
    throw error;
  }
}
const menuSearch = new URLSearchParams(location.search);
const skipMainMenu = menuSearch.get("skip-main-menu") === "1"
  || menuSearch.get("training") === "1"
  || menuSearch.get("exploration-test") === "1"
  || SKIP_TEAM_SELECTION || GRID_DIAGNOSTIC;
let mainMenu;
const characterCreation = createCharacterCreation({
  definitions: STARTER_ROSTER_DEFINITIONS,
  classNames,
  gameShell,
  onConfirm: ({ selectedIds, names, profile }) => applyCampPartySelection(selectedIds, {
    creation: { names, profile },
  }),
  onBack: () => mainMenu.show(),
});
mainMenu = createMainMenu({
  gameShell,
  music: gameMusic,
  onNewGame: startFreshGame,
  onContinue: continueGame,
  onCheckContinue: checkContinuation,
  // Leaving the camp saves its live state. Leaving the title screen must not
  // overwrite an older save merely because a fresh session was not started.
  onSaveAndExit: ({ resumeGame }) => resumeGame ? saveAndExitGame() : true,
  onSettingsChanged: () => autosaveGame('zmianie ustawień'),
  onVisibilityChange: (visible) => { mainMenuOpen = visible; syncMusicScene(); },
});
if (skipMainMenu) mainMenu.hide();
const hasStoredSession = [SAVE_KEY, SAVE_BACKUP_KEY, LEGACY_EQUIPMENT_SAVE_KEY, LEGACY_ITEM_SAVE_KEY]
  .some((key) => localStorage.getItem(key) !== null);
if (skipMainMenu && !SKIP_TEAM_SELECTION && !GRID_DIAGNOSTIC && campaign && !hasStoredSession) {
  openTeamSelection({ mandatory: true });
}
