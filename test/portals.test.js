import test from "node:test";
import assert from "node:assert/strict";
import {
  EncounterRules,
  PORTAL_RESULT,
  PortalSystem,
  TownPortalScrollSupply,
  validatePortalPlacement,
} from "../src/core/portals.js";

function hero(id, overrides = {}) {
  return {
    id,
    lifeState: "alive",
    experience: 0,
    resources: { hp: 100, maxHp: 100 },
    ...overrides,
  };
}

function source(instance = "blood-moor-instance-7", hex = { q: 4, r: 2 }) {
  return { area_id: "blood_moor", instance_id: instance, hex };
}

function open(system, {
  owner = hero("owner"),
  scrollSupply = new TownPortalScrollSupply(1),
  encounterRules = EncounterRules.standard(),
  portal_id,
  sourceLocation = source(),
  isLegalHex = () => true,
  ...overrides
} = {}) {
  return system.openPortal({
    portal_id,
    owner,
    source: sourceLocation,
    destinationTown: "rogue_encampment",
    campaignProfile: { ruleset: "rotw-3.3", act: 1 },
    difficultyProfile: { difficulty: "normal", players: 1 },
    scrollSupply,
    encounterRules,
    isLegalHex,
    ...overrides,
  });
}

test("H: a Town Portal can be opened while living enemies remain", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply({ tomeScrolls: 2 });
  const result = open(system, {
    owner: hero("amazon"),
    scrollSupply: supply,
    hasLivingEnemies: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.combatWasActive, true);
  assert.equal(result.portal.owner_character_id, "amazon");
  assert.equal(result.portal.active, true);
  assert.equal(supply.remaining, 1);
});

test("portal id sequence rejects unsafe restore values and exhausts without looping", () => {
  assert.throws(
    () => new PortalSystem({ nextPortalSequence: Number.MAX_SAFE_INTEGER }),
    /nextPortalSequence/,
  );
  const system = new PortalSystem({ nextPortalSequence: Number.MAX_SAFE_INTEGER - 1 });
  const supply = new TownPortalScrollSupply(1);
  const result = open(system, { owner: hero("sequence-owner"), scrollSupply: supply });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INVALID_PORTAL_DATA");
  assert.match(result.message, /sequence is exhausted/);
  assert.equal(supply.remaining, 1);
  assert.equal(system.toJSON().nextPortalSequence, Number.MAX_SAFE_INTEGER - 1);
});

test("portal restore rejects a malformed transition log before any scroll can be reserved", () => {
  const snapshot = new PortalSystem().toJSON();
  snapshot.transitionLog = null;
  assert.throws(() => PortalSystem.fromJSON(snapshot), /transitionLog/);

  const supply = new TownPortalScrollSupply(1);
  assert.equal(supply.remaining, 1);
});

test("H: every hero owns a separate portal and replaces only their own", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply(3);
  const firstA = open(system, { owner: hero("a"), scrollSupply: supply, portal_id: "a-1" });
  const firstB = open(system, { owner: hero("b"), scrollSupply: supply, portal_id: "b-1" });
  const secondA = open(system, {
    owner: hero("a"),
    scrollSupply: supply,
    portal_id: "a-2",
    sourceLocation: source("instance-2", { q: 8, r: 1 }),
  });

  assert.equal(firstA.ok && firstB.ok && secondA.ok, true);
  assert.equal(system.getPortal("a-1").closed, true);
  assert.equal(system.getPortal("a-1").closeReason, "replaced_by_owner");
  assert.equal(system.getPortal("a-2").active, true);
  assert.equal(system.getPortal("b-1").active, true);
  assert.equal(system.getActivePortalForOwner("a").portal_id, "a-2");
  assert.equal(system.getActivePortalForOwner("b").portal_id, "b-1");
});

test("I: opening consumes exactly one scroll and failed creation rolls it back", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply({ looseScrolls: 1, tomeScrolls: 1 });

  const success = open(system, { owner: hero("a"), scrollSupply: supply });
  assert.equal(success.ok, true);
  assert.equal(success.scrollsConsumed, 1);
  assert.deepEqual(supply.toJSON(), { looseScrolls: 1, tomeScrolls: 0 });

  const resetting = EncounterRules.resettingEncounter();
  const failed = open(system, {
    owner: hero("b"),
    scrollSupply: supply,
    encounterRules: resetting,
    confirmReset: true,
    onEncounterReset() { throw new Error("reset storage unavailable"); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "PORTAL_TRANSACTION_FAILED");
  assert.equal(supply.remaining, 1);
  assert.equal(system.getActivePortalForOwner("b"), null);
});

test("I: missing scroll never creates a free portal", () => {
  const system = new PortalSystem();
  const result = open(system, { owner: hero("a"), scrollSupply: new TownPortalScrollSupply() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, PORTAL_RESULT.NO_SCROLL);
  assert.equal(system.listActivePortals().length, 0);
});

test("portal scroll counts must remain exact safe integers", () => {
  assert.throws(
    () => new TownPortalScrollSupply({ tomeScrolls: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer/,
  );
  const supply = new TownPortalScrollSupply({ tomeScrolls: Number.MAX_SAFE_INTEGER });
  const before = supply.remaining;
  const reservation = supply.reserveOne();
  assert.equal(supply.remaining, before - 1);
  reservation.rollback();
  assert.equal(supply.remaining, before);
});

test("J: a portal cannot be placed on a wall, inaccessible hex, or large-enemy footprint", () => {
  const battlefield = {
    width: 12,
    height: 8,
    blocked: new Set(["2,2"]),
    inaccessible: [{ x: 3, y: 2 }],
    units: [{ id: "large-enemy", hp: 100, occupiedHexes: [{ x: 6, y: 2 }, { x: 7, y: 2 }] }],
  };
  for (const hex of [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 7, y: 2 }, { x: 12, y: 2 }]) {
    const result = validatePortalPlacement({ source: source("instance", hex), battlefield });
    assert.equal(result.ok, false);
    assert.equal(result.reason, PORTAL_RESULT.ILLEGAL_HEX);
  }

  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply(1);
  const blocked = open(system, {
    owner: hero("a"),
    scrollSupply: supply,
    sourceLocation: source("instance", { x: 7, y: 2 }),
    battlefield,
    isLegalHex: null,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, PORTAL_RESULT.ILLEGAL_HEX);
  assert.equal(supply.remaining, 1);
});

test("K: entering town grants no EXP, loot, victory, or quest reward", () => {
  const system = new PortalSystem();
  const owner = hero("owner", { experience: 51 });
  const encounter = {
    id: "encounter-9",
    victory: false,
    monsters: [{ id: "fallen-1", hp: 7 }],
    groundItems: [{ id: "potion-1" }],
    rewardsGranted: false,
  };
  const before = structuredClone(encounter);
  const opened = open(system, { owner });
  const entered = system.enterTown({
    portal_id: opened.portal.portal_id,
    character: owner,
    isLastLivingHeroLeaving: true,
  });

  assert.equal(entered.ok, true);
  assert.deepEqual(entered.rewards, { experience: 0, loot: [], victory: false, questRewards: [] });
  assert.equal(entered.encounterDisposition, "suspend");
  assert.equal(owner.experience, 51);
  assert.deepEqual(encounter, before);
});

test("L: return uses the exact saved area instance and source hex", () => {
  const system = new PortalSystem();
  const opened = open(system, {
    owner: hero("owner"),
    sourceLocation: source("persistent-instance-42", { q: -3, r: 11 }),
  });
  assert.equal(system.enterTown({ portal_id: opened.portal.portal_id, character_id: "ally" }).ok, true);
  const returned = system.returnThroughPortal({ portal_id: opened.portal.portal_id, character_id: "ally" });

  assert.equal(returned.ok, true);
  assert.deepEqual(returned.transition.to, {
    kind: "area",
    area_id: "blood_moor",
    instance_id: "persistent-instance-42",
    hex: { q: -3, r: 11 },
    via_portal_id: opened.portal.portal_id,
  });
  assert.equal(opened.portal.active, true, "a non-owner return must not close the portal");
});

test("M: grouped return traverses non-owners first and the owner last", () => {
  const system = new PortalSystem();
  const opened = open(system, { owner: hero("owner") });
  const portalId = opened.portal.portal_id;
  for (const id of ["owner", "ally-a", "ally-b"]) {
    assert.equal(system.enterTown({ portal_id: portalId, character_id: id }).ok, true);
  }

  const returned = system.returnPartyThroughPortal({
    portal_id: portalId,
    characterIds: ["owner", "ally-a", "ally-b"],
  });
  assert.equal(returned.ok, true);
  assert.deepEqual(returned.traversalOrder, ["ally-a", "ally-b", "owner"]);
  assert.deepEqual(returned.returned, ["ally-a", "ally-b", "owner"]);
  assert.equal(returned.portalClosed, true);
  for (const id of returned.returned) assert.equal(system.locationOf(id).instance_id, "blood-moor-instance-7");
});

test("N: followers retain identity and state without duplicate traversal entries", () => {
  const system = new PortalSystem();
  const owner = hero("owner");
  const mercenary = { id: "merc-1", ownerId: "owner", hp: 37, equipment: { weapon: "insight-1" } };
  const persistentSummon = { id: "golem-1", ownerId: "owner", hp: 19, portalPolicy: "follow" };
  const temporarySummon = { id: "skeleton-1", ownerId: "owner", hp: 8, portalPolicy: "dismiss" };
  const beforeMercenary = structuredClone(mercenary);
  const opened = open(system, { owner });
  const entered = system.enterTown({
    portal_id: opened.portal.portal_id,
    character: owner,
    followers: [mercenary, mercenary, persistentSummon, temporarySummon],
  });

  assert.equal(entered.ok, true);
  assert.deepEqual(entered.movedFollowerIds, ["merc-1", "golem-1"]);
  assert.deepEqual(entered.dismissedFollowerIds, ["skeleton-1"]);
  assert.deepEqual(mercenary, beforeMercenary, "travel must not recreate or normalize a mercenary");
  assert.equal([...system.locations.keys()].filter((id) => id === "merc-1").length, 1);
  assert.equal(system.locationOf("merc-1").kind, "town");
  assert.equal(system.locationOf("skeleton-1").kind, "dismissed");
});

test("O: reset-causing encounters warn before mutation and apply only after confirmation", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply(1);
  const rules = EncounterRules.resettingEncounter({
    id: "special_encounter",
    openingResetWarning: "This will restart the special encounter.",
  });
  let resets = 0;

  const warning = open(system, {
    owner: hero("owner"),
    scrollSupply: supply,
    encounterRules: rules,
    onEncounterReset() { resets += 1; },
  });
  assert.equal(warning.ok, false);
  assert.equal(warning.reason, PORTAL_RESULT.RESET_CONFIRMATION_REQUIRED);
  assert.equal(warning.warning, "This will restart the special encounter.");
  assert.equal(warning.requiresConfirmation, true);
  assert.equal(resets, 0);
  assert.equal(supply.remaining, 1);

  const confirmed = open(system, {
    owner: hero("owner"),
    scrollSupply: supply,
    encounterRules: rules,
    confirmReset: true,
    onEncounterReset() { resets += 1; },
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.encounterReset, true);
  assert.equal(resets, 1);
  assert.equal(supply.remaining, 0);

  const leaveWarning = system.enterTown({
    portal_id: confirmed.portal.portal_id,
    character_id: "owner",
    isLastLivingHeroLeaving: true,
  });
  assert.equal(leaveWarning.ok, false);
  assert.equal(leaveWarning.reason, PORTAL_RESULT.RESET_CONFIRMATION_REQUIRED);
  assert.equal(system.locationOf("owner"), null);
});

test("O: encounter rules can forbid portal creation in a restricted area", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply(1);
  const result = open(system, {
    owner: hero("owner"),
    scrollSupply: supply,
    encounterRules: new EncounterRules({ allowTownPortal: false, denialMessage: "Restricted quest area" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "Restricted quest area");
  assert.equal(supply.remaining, 1);
});

test("T: JSON save/load preserves portal ownership, status, rules, and transit state", () => {
  const system = new PortalSystem();
  const supply = new TownPortalScrollSupply(2);
  const first = open(system, { owner: hero("owner"), scrollSupply: supply, portal_id: "portal-old" });
  const second = open(system, {
    owner: hero("owner"),
    scrollSupply: supply,
    portal_id: "portal-live",
    sourceLocation: source("same-instance-after-load", { x: 9, y: 4 }),
    encounterRules: new EncounterRules({ id: "saved-rules", closeOnOwnerReturn: true }),
  });
  assert.equal(first.portal.closed, true);
  assert.equal(system.enterTown({ portal_id: second.portal.portal_id, character_id: "ally" }).ok, true);

  const json = JSON.parse(JSON.stringify(system));
  const restored = PortalSystem.fromJSON(json);
  assert.deepEqual(restored.toJSON(), system.toJSON());
  assert.equal(restored.getPortal("portal-old").closed, true);
  assert.equal(restored.getActivePortalForOwner("owner").portal_id, "portal-live");
  assert.equal(restored.getActivePortalForOwner("owner").encounterRules.id, "saved-rules");
  assert.equal(restored.locationOf("ally").source_instance_id, "same-instance-after-load");

  const returned = restored.returnThroughPortal({ portal_id: "portal-live", character_id: "ally" });
  assert.equal(returned.ok, true);
  assert.equal(returned.transition.to.instance_id, "same-instance-after-load");
});

test("exploration portal preserves its world and exact sector without changing legacy sources", () => {
  const system = new PortalSystem();
  const sourceLocation = {
    ...source("BM-01"),
    world_id: "act1-world-12345",
    sector_id: "act1.blood_moor:sector:17",
  };
  const opened = open(system, {
    owner: hero("explorer"),
    sourceLocation,
    scrollSupply: new TownPortalScrollSupply(1),
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.portal.source, sourceLocation);
  assert.deepEqual(PortalSystem.fromJSON(system.toJSON()).getActivePortalForOwner("explorer").source, sourceLocation);
  const malformedSupply = new TownPortalScrollSupply(1);
  const malformed = open(new PortalSystem(), {
    owner: hero("broken"),
    sourceLocation: { ...source(), world_id: "world-without-sector" },
    scrollSupply: malformedSupply,
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /both world_id and sector_id/);
  assert.equal(malformedSupply.remaining, 1);
});
