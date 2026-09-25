import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCharacter, Roster, setSkillPoints } from "../src/core/characters.js";
import { CampaignState } from "../src/core/campaign.js";
import { Party } from "../src/core/party.js";
import { PlayersSetting, parsePlayersCommand } from "../src/core/players.js";
import { CombatState, ACTION_TIME } from "../src/core/combat.js";
import { DeterministicScheduler } from "../src/core/scheduler.js";
import { ItemLedger } from "../src/core/inventory.js";
import { GameState } from "../src/core/state.js";
import { addCharacterExperience, classProgressionProfile } from "../src/core/progression.js";
import { RunewordCatalog } from "../src/core/runewords.js";
import { HoradricCube } from "../src/core/cube.js";
import { CorpseRegistry } from "../src/core/corpses.js";
import { DeterministicRng } from "../src/core/rng.js";
import { DamageEngine } from "../src/core/damage.js";
import { EffectRegistry } from "../src/core/effects.js";
import { generateArea, validateArea } from "../src/core/world.js";
import { loadGame, removeSaveArtifacts, saveAtomic } from "../src/node/save-store.js";

function hero(id, classId = "sorceress", name = id, hardcore = false) {
  return createCharacter({ id, classId, name, hardcore });
}

test("A: three active heroes of one class remain independent and a fourth stays reserve", () => {
  const roster = new Roster([hero("s1"), hero("s2"), hero("s3"), hero("s4")]);
  const party = new Party(roster, ["s1", "s2", "s3"]);
  setSkillPoints(roster.get("s1"), "sorceress.teleport", 1, 4);
  roster.get("s1").equipment.weapon = "staff-1";
  assert.equal(party.slots.length, 3);
  assert.throws(() => party.add("s4"), /Party is full/);
  assert.deepEqual(roster.get("s1").skills["sorceress.teleport"], { hardPoints: 1, softPoints: 4, effectiveLevel: 5 });
  assert.equal(roster.get("s2").skills["sorceress.teleport"], undefined);
  assert.equal(roster.get("s2").equipment.weapon, undefined);
});

test("one, two or three active heroes round-trip without equalizing independent levels", () => {
  const roster = new Roster([hero("veteran-a", "barbarian"), hero("veteran-b", "barbarian"), hero("novice", "barbarian")]);
  const levelTenExperience = classProgressionProfile("barbarian").thresholds[9];
  addCharacterExperience(roster.get("veteran-a"), levelTenExperience);
  addCharacterExperience(roster.get("veteran-b"), levelTenExperience);
  assert.deepEqual(roster.toJSON().map(({ level }) => level), [10, 10, 1]);

  for (const activeIds of [
    ["veteran-a"],
    ["veteran-a", "novice"],
    ["veteran-a", "veteran-b", "novice"],
  ]) {
    const saved = new GameState({ roster, partyIds: activeIds }).serialize();
    const restored = GameState.deserialize(saved);
    assert.deepEqual(restored.party.slots, activeIds);
    assert.deepEqual(restored.roster.toJSON().map(({ level }) => level), [10, 10, 1]);
    assert.deepEqual(restored.serialize(), saved);
  }
});

test("roster rejects malformed active and reserve character records", () => {
  const valid = hero("valid");
  assert.throws(() => new Roster([{ ...valid, classId: "wizard" }]), /Unknown class/);
  assert.throws(() => new Roster([{ ...valid, resources: null }]), /resources/);
  assert.throws(() => new Roster([{ ...valid, resources: { ...valid.resources, hp: Number.MAX_SAFE_INTEGER + 1 } }]), /safe integer|outside/);
  assert.throws(() => new Roster([{ ...valid, lifeState: "alive", resources: { ...valid.resources, hp: 0 } }]), /lifeState/);
});

test("character factory rejects malformed identity and hardcore flags before creating a record", () => {
  assert.throws(() => createCharacter({ id: " ", name: "Hero", classId: "barbarian" }), /id/);
  assert.throws(() => createCharacter({ id: null, name: "Hero", classId: "barbarian" }), /id/);
  assert.throws(() => createCharacter({ id: "hero", name: "Hero", classId: "barbarian", hardcore: "false" }), /hardcore/);
  assert.equal(createCharacter({ id: " hero ", name: "Hero", classId: "barbarian" }).id, "hero");
});

test("B: a Warlock created in Act III starts at level 1 and EXP 0", () => {
  const campaign = new CampaignState({ act: 3 });
  const roster = new Roster();
  const warlock = roster.create({ id: "new-warlock", name: "Marius", classId: "warlock" });
  assert.equal(campaign.act, 3);
  assert.equal(warlock.level, 1);
  assert.equal(warlock.experience, 0);
  assert.deepEqual(warlock.skills, {});
});

test("C: reserve hero receives no EXP and preserves state", () => {
  const roster = new Roster([hero("active"), hero("reserve", "paladin")]);
  roster.get("reserve").resources.hp = 7;
  const party = new Party(roster, ["active"]);
  const combat = new CombatState({ party, playersSetting: new PlayersSetting(1) });
  const monster = combat.spawnMonster({ id: "fallen", name: "Fallen", baseHp: 10, baseExperience: 100 });
  assert.deepEqual(monster.position, { q: 5, r: 5 });
  assert.throws(
    () => combat.spawnMonster({ id: "broken", name: "Broken", baseHp: 1, baseExperience: 0, position: { x: 1, y: 2 } }),
    /Axial coordinates/,
  );
  monster.hp = 0;
  const awards = combat.grantMonsterExperience("fallen", ["active", "reserve"]);
  assert.deepEqual(awards, [{ characterId: "active", amount: 100 }]);
  assert.equal(roster.get("reserve").experience, 0);
  assert.equal(roster.get("reserve").resources.hp, 7);
});

test("D/G: combat swap costs time and removes source aura without healing", () => {
  const outgoing = hero("out", "paladin");
  const incoming = hero("in", "warlock");
  incoming.resources.hp = 3;
  const roster = new Roster([outgoing, incoming]);
  const party = new Party(roster, ["out"]);
  const playersSetting = new PlayersSetting();
  const combat = new CombatState({ party, playersSetting });
  combat.effects.add({ id: "might-1", sourceId: "out", targetId: "out", kind: "aura" });
  combat.spawnMonster({ id: "buff-source", name: "Buff Source", baseHp: 10, baseExperience: 0 });
  combat.effects.add({ id: "external-buff", sourceId: "buff-source", targetId: "out", kind: "buff" });
  combat.controlEffects.applyTaunt({
    id: "taunt-before-swap",
    sourceId: "out",
    targetId: "enemy-control-target",
    startsAt: 0,
    expiresAt: 2000,
  });
  combat.nextReady(["out"]);
  const command = combat.requestSwap("out", "in");
  assert.equal(command.readyAt, ACTION_TIME.swap);
  assert.equal(party.slots[0], "in");
  assert.equal(combat.effects.snapshot().length, 0);
  assert.equal(combat.controlEffects.snapshot().effects.length, 0);
  assert.equal(roster.get("in").resources.hp, 3);
  assert.equal(combat.canAct("in"), false);
  combat.nextReady(["in"]);
  assert.equal(combat.canAct("in"), true);
  assert.doesNotThrow(() => CombatState.restore(combat.snapshot(), { party, playersSetting }));
});

test("J: P1-P8 multiplier is applied once and is independent of party size", () => {
  for (let p = 1; p <= 8; p += 1) {
    const setting = new PlayersSetting(p);
    assert.equal(setting.worldMultiplier, 1 + 0.5 * (p - 1));
    const roster = new Roster([hero(`h${p}-1`), hero(`h${p}-2`), hero(`h${p}-3`)]);
    const combat = new CombatState({ party: new Party(roster, roster.toJSON().map((h) => h.id)), playersSetting: setting });
    const monster = combat.spawnMonster({ id: `m${p}`, name: "Fallen", baseHp: 100, baseExperience: 80 });
    assert.equal(monster.hp, Math.floor(100 * setting.worldMultiplier));
  }
  assert.equal(parsePlayersCommand("/players 8"), 8);
  assert.equal(parsePlayersCommand("/players 9"), null);
});

test("R: dead Hardcore hero cannot return through roster", () => {
  const active = hero("active");
  const dead = hero("dead", "barbarian", "Dead", true);
  const roster = new Roster([active, dead]);
  roster.markDead("dead");
  const party = new Party(roster, ["active"]);
  assert.throws(() => party.replaceAt(0, "dead"), /Hardcore/);
});

test("S: scheduler order depends on simulation time, not rendering pauses", () => {
  const scheduler = new DeterministicScheduler();
  scheduler.schedule({ at: 1000, kind: "attack", actorId: "a" });
  scheduler.schedule({ at: 1000, kind: "attack", actorId: "b" });
  scheduler.schedule({ at: 700, kind: "poison", actorId: "p" });
  assert.deepEqual([scheduler.pop().actorId, scheduler.pop().actorId, scheduler.pop().actorId], ["p", "a", "b"]);
  assert.equal(scheduler.time, 1000);
});

test("scheduler restore rejects forged ids and any sequence that could be reused", () => {
  assert.throws(() => new DeterministicScheduler().schedule({ at: 0, kind: null, actorId: null }), /kind/);
  const scheduler = new DeterministicScheduler();
  scheduler.schedule({ at: 5, kind: "attack", actorId: "a" });
  const clean = scheduler.snapshot();

  const wrongId = structuredClone(clean);
  wrongId.queue[0].id = "event-forged";
  assert.throws(() => DeterministicScheduler.restore(wrongId), /id disagrees/);

  const stale = structuredClone(clean);
  stale.sequence = 0;
  assert.throws(() => DeterministicScheduler.restore(stale), /reuse/);

  const unsafeEvent = structuredClone(clean);
  unsafeEvent.queue[0].sequence = Number.MAX_SAFE_INTEGER;
  unsafeEvent.queue[0].id = `event-${Number.MAX_SAFE_INTEGER}`;
  unsafeEvent.sequence = Number.MAX_SAFE_INTEGER;
  assert.throws(() => DeterministicScheduler.restore(unsafeEvent), /event sequence/);

  const exhausted = structuredClone(clean);
  exhausted.sequence = Number.MAX_SAFE_INTEGER;
  const restored = DeterministicScheduler.restore(exhausted);
  assert.throws(
    () => restored.schedule({ at: 6, kind: "attack", actorId: "b" }),
    /exhausted/,
  );
});

test("N: item transfer is atomic and stale ownership cannot duplicate an item", () => {
  const ledger = new ItemLedger([{ id: "sword", baseId: "short_sword", location: { ownerId: "a", container: "inventory", x: 0, y: 0 } }]);
  const from = { ownerId: "a", container: "inventory", x: 0, y: 0 };
  assert.equal(ledger.transfer("sword", from, { ownerId: "b", container: "inventory", x: 1, y: 1 }), true);
  assert.equal(ledger.ownerOf("sword"), "b");
  assert.throws(() => ledger.transfer("sword", from, { ownerId: "c", container: "stash" }), /Stale/);
  assert.equal(ledger.toJSON().filter((item) => item.id === "sword").length, 1);
});

test("P: personal quest reward cannot be granted twice", () => {
  const campaign = new CampaignState();
  const character = hero("rewarded");
  assert.equal(campaign.grantPersonalReward(character, "den_of_evil", { skillPoints: 1 }), true);
  assert.equal(campaign.grantPersonalReward(character, "den_of_evil", { skillPoints: 1 }), false);
  assert.equal(Object.keys(character.questRewards).length, 1);
});

test("Q: atomic save/load preserves rolls, roster and settings", async () => {
  const work = path.resolve("work", "test-save");
  await mkdir(work, { recursive: true });
  const file = path.join(work, "save.json");
  await removeSaveArtifacts(file);
  const roster = new Roster([hero("saved", "amazon")]);
  const game = new GameState({
    roster,
    partyIds: ["saved"],
    campaign: new CampaignState({ worldSeed: 123 }),
    players: 8,
    items: [{ id: "rolled", roll: 37, location: { ownerId: "saved", container: "inventory" } }],
  });
  await saveAtomic(file, game);
  const loaded = await loadGame(file);
  assert.equal(loaded.players.value, 8);
  assert.equal(loaded.items.toJSON()[0].roll, 37);
  assert.equal(loaded.roster.get("saved").level, 1);
  await removeSaveArtifacts(file);
});

test("Q: invalid state is rejected before replacing a valid primary save", async () => {
  const work = path.resolve("work", "test-save-preflight");
  await mkdir(work, { recursive: true });
  const file = path.join(work, "save.json");
  await removeSaveArtifacts(file);
  const roster = new Roster([hero("safe", "amazon")]);
  const game = new GameState({
    roster,
    partyIds: ["safe"],
    campaign: new CampaignState({ worldSeed: 55 }),
    players: 2,
    items: [],
  });
  await saveAtomic(file, game);
  const original = await readFile(file, "utf8");
  const corruptState = {
    serialize() {
      const serialized = game.serialize();
      serialized.players = 99;
      return serialized;
    },
  };
  await assert.rejects(() => saveAtomic(file, corruptState));
  assert.equal(await readFile(file, "utf8"), original);
  await removeSaveArtifacts(file);
});

test("Q: GameState preflight rejects orphan items and malformed campaign/settings graphs", () => {
  const roster = new Roster([hero("owner", "amazon")]);
  const game = new GameState({ roster, partyIds: ["owner"], players: 1, items: [] });
  const clean = game.serialize();

  const orphan = structuredClone(clean);
  orphan.items = [{ id: "orphan", location: { ownerId: "ghost", container: "inventory" } }];
  assert.throws(() => GameState.deserialize(orphan), /owner is not present/);

  const malformedCampaign = structuredClone(clean);
  malformedCampaign.campaign.worldSeed = "not-a-seed";
  malformedCampaign.campaign.unlockedActs = null;
  assert.throws(() => GameState.deserialize(malformedCampaign), /worldSeed|progression/);

  const missingSettings = structuredClone(clean);
  missingSettings.settings = null;
  assert.throws(() => GameState.deserialize(missingSettings), /settings/);

  const emptyParty = structuredClone(clean);
  emptyParty.partyIds = [];
  assert.throws(() => GameState.deserialize(emptyParty), /party/);
});

test("Q: load falls back to the last validated backup when the primary is corrupt", async () => {
  const work = path.resolve("work", "test-save-backup");
  await mkdir(work, { recursive: true });
  const file = path.join(work, "save.json");
  await removeSaveArtifacts(file);
  const roster = new Roster([hero("backup", "paladin")]);
  const first = new GameState({
    roster,
    partyIds: ["backup"],
    campaign: new CampaignState({ worldSeed: 77 }),
    players: 3,
    items: [],
  });
  await saveAtomic(file, first);
  const second = GameState.deserialize(first.serialize());
  second.players.set(7);
  await saveAtomic(file, second);
  await writeFile(file, "{broken", "utf8");
  const recovered = await loadGame(file);
  assert.equal(recovered.players.value, 3);
  assert.equal(recovered.campaign.worldSeed, 77);
  await removeSaveArtifacts(file);
});

test("Q: node loader preserves an explicitly newer primary instead of hiding it with a backup", async () => {
  const work = path.resolve("work", "test-save-incompatible");
  await mkdir(work, { recursive: true });
  const file = path.join(work, "save.json");
  await removeSaveArtifacts(file);
  const roster = new Roster([hero("future", "amazon")]);
  const game = new GameState({ roster, partyIds: ["future"], players: 1, items: [] });
  await saveAtomic(file, game);
  await saveAtomic(file, game);
  const future = `${JSON.stringify({ schemaVersion: 2, futureData: true })}\n`;
  await writeFile(file, future, "utf8");
  await assert.rejects(() => loadGame(file), /newer|Unsupported primary save schema preserved/);
  assert.equal(await readFile(file, "utf8"), future);
  await removeSaveArtifacts(file);
});

test("Q: a validated node save replaces a corrupt same-schema primary", async () => {
  const work = path.resolve("work", "test-save-repair");
  await mkdir(work, { recursive: true });
  const file = path.join(work, "save.json");
  await removeSaveArtifacts(file);
  const roster = new Roster([hero("repair", "amazon")]);
  const game = new GameState({ roster, partyIds: ["repair"], players: 4, items: [] });
  await saveAtomic(file, game);
  const corrupt = game.serialize();
  corrupt.items = [{ id: "orphan", location: { ownerId: "ghost", container: "inventory" } }];
  await writeFile(file, JSON.stringify(corrupt), "utf8");
  await saveAtomic(file, game);
  assert.equal((await loadGame(file)).players.value, 4);
  await removeSaveArtifacts(file);
});

test("M: runeword requires exact base type, sockets and rune order and activates once", async () => {
  const recipes = JSON.parse(await readFile("data/runewords.rotw-3.3.json", "utf8"));
  const catalog = new RunewordCatalog(recipes);
  const armor = { id: "armor", socketableType: "body_armor", quality: "normal", sockets: ["Hel", "Shael", "Ral"] };
  assert.equal(catalog.activate(armor).recipeId, "rotw.authority");
  assert.equal(catalog.activate(armor).recipeId, "rotw.authority");
  assert.equal(catalog.match({ socketableType: "body_armor", quality: "normal", sockets: ["Hel", "Ral", "Shael"] }), null);
  assert.equal(catalog.match({ socketableType: "helm", quality: "normal", sockets: ["Hel", "Shael", "Ral"] }), null);
  assert.equal(catalog.match({ socketableType: "body_armor", quality: "magic", sockets: ["Hel", "Shael", "Ral"] }), null);
});

test("N: cube transmutation is atomic on success, mismatch and no space", () => {
  const ingredients = [
    { id: "r1", baseId: "rune_el" },
    { id: "r2", baseId: "rune_el" },
    { id: "g1", baseId: "chipped_topaz" },
  ];
  const recipe = { ingredients: { rune_el: 2, chipped_topaz: 1 } };
  const blocked = new HoradricCube(ingredients);
  assert.equal(blocked.transmute(recipe, () => ({ id: "eld", baseId: "rune_eld" }), () => false).reason, "NO_SPACE");
  assert.deepEqual(blocked.items, ingredients);
  const cube = new HoradricCube(ingredients);
  const result = cube.transmute(recipe, () => ({ id: "eld", baseId: "rune_eld", roll: 1 }));
  assert.equal(result.ok, true);
  assert.deepEqual(cube.items, [{ id: "eld", baseId: "rune_eld", roll: 1 }]);
});

test("H: a corpse can be consumed only once", () => {
  const corpses = new CorpseRegistry();
  corpses.create({ id: "corpse-1", unitType: "fallen", position: { x: 1, y: 2 } });
  assert.equal(corpses.consume("corpse-1", "necromancer-a", "corpse_explosion"), true);
  assert.equal(corpses.consume("corpse-1", "necromancer-b", "raise_skeleton"), false);
});

test("central damage preview and roll use the same profile", () => {
  const engine = new DamageEngine(new DeterministicRng(99));
  const profile = { weaponMin: 7, weaponMax: 11, offWeaponFlat: 2 };
  const preview = engine.previewBasicAttack(profile);
  const result = engine.resolveBasicAttack(profile);
  assert.deepEqual({ min: result.min, max: result.max }, { min: preview.min, max: preview.max });
  assert.ok(result.rolled >= preview.min && result.rolled <= preview.max);
  assert.equal(result.dataStatus, "PLACEHOLDER_UNVERIFIED");
});

test("G: same aura group selects the strongest instance instead of adding levels", () => {
  const effects = new EffectRegistry();
  effects.add({ id: "might-a", sourceId: "p1", targetId: "ally", stackKey: "aura.might", stackPolicy: "strongest", level: 6 });
  effects.add({ id: "might-b", sourceId: "p2", targetId: "ally", stackKey: "aura.might", stackPolicy: "strongest", level: 11 });
  effects.add({ id: "vigor-a", sourceId: "p3", targetId: "ally", stackKey: "aura.vigor", stackPolicy: "strongest", level: 4 });
  const resolved = effects.resolvedForTarget("ally");
  assert.equal(resolved.length, 2);
  assert.equal(resolved.find((effect) => effect.stackKey === "aura.might").level, 11);
});

test("O: generated area is deterministic and entrance, exit and quest object are reachable", () => {
  const options = { width: 24, height: 18, obstacleChance: 0.24, requiredObjects: [{ id: "quest-chest", position: { x: 23, y: 9 } }] };
  const a = generateArea({ ...options, rng: new DeterministicRng(444) });
  const b = generateArea({ ...options, rng: new DeterministicRng(444) });
  assert.deepEqual(a, b);
  assert.deepEqual(validateArea(a), { valid: true, exitReachable: true, unreachableObjects: [] });
});

test("RNG restore preserves an exact non-zero uint32 and rejects silently normalized states", () => {
  const snapshot = new DeterministicRng(0xffffffff).snapshot();
  assert.deepEqual(DeterministicRng.restore(snapshot).snapshot(), snapshot);
  assert.throws(() => DeterministicRng.restore({ algorithm: "xorshift32", state: 0 }), /non-zero uint32/);
  assert.throws(() => DeterministicRng.restore({ algorithm: "xorshift32", state: 0x100000000 }), /non-zero uint32/);
});
