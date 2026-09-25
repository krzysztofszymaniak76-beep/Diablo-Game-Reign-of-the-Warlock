import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CampaignState } from '../src/core/campaign.js';
import { ACT1_ENCOUNTERS } from '../data/act1-encounters.v057.js';
import { Roster, createCharacter } from '../src/core/characters.js';
import { InventoryGrid } from '../src/core/inventory-grid.js';
import { EquipmentCatalog } from '../src/core/equipment.js';

const catalog = new EquipmentCatalog(JSON.parse(readFileSync(
  new URL('../data/equipment.v051.json', import.meta.url), 'utf8')));
const CAMP = 'act1.rogue_encampment';
const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const QUEST = 'act1.den_of_evil';
const REWARD = `normal:${QUEST}`;
const LEGACY_REWARD = 'normal:den_of_evil';
const DEN_ENCOUNTERS = ACT1_ENCOUNTERS.filter(encounter => encounter.areaId === DEN);

function fixture(ids = ['a', 'b', 'c', 'd']) {
  const roster = new Roster(ids.map(id => createCharacter({ id, name: id.toUpperCase(), classId: 'barbarian' })));
  const inventories = new Map(roster.toJSON().map(hero => [hero.id, new InventoryGrid()]));
  return { campaign: new CampaignState(), roster, inventories, catalog };
}

function enterDen(f) {
  if (f.campaign.act1.currentAreaId === CAMP) f.campaign.travelAct1(MOOR);
  if (f.campaign.act1.currentAreaId === MOOR) f.campaign.travelAct1(DEN);
  assert.equal(f.campaign.act1.currentAreaId, DEN);
}

function clearDen(f, { finalParty = ['b', 'c'], reconcileEachKill = true } = {}) {
  enterDen(f);
  assert.equal(DEN_ENCOUNTERS.length, 5);
  let killed = 0;
  for (const [encounterIndex, expected] of DEN_ENCOUNTERS.entries()) {
    const config = f.campaign.nextAct1Encounter();
    assert.equal(config.id, expected.id);
    f.campaign.beginAct1Encounter(config.id);
    for (const [monsterIndex, monster] of config.monsters.entries()) {
      const isFinal = encounterIndex === DEN_ENCOUNTERS.length - 1
        && monsterIndex === config.monsters.length - 1;
      const result = f.campaign.recordAct1Defeat(monster.id, { hex: monster.position, catalog });
      killed += 1;
      assert.equal(result.recorded, true);
      assert.equal(result.completed, monsterIndex === config.monsters.length - 1);
      if (reconcileEachKill || isFinal) {
        const view = f.campaign.reconcileDenQuest(isFinal ? finalParty : ['a', 'b', 'c']);
        assert.equal(view.killed, killed);
        assert.equal(view.remaining, 30 - killed);
      }
    }
  }
  assert.equal(killed, 30);
  assert.equal(f.campaign.nextAct1Encounter(), null);
  return f.campaign.denQuestView();
}

function returnToCamp(f) {
  if (f.campaign.act1.currentAreaId === DEN) f.campaign.travelAct1(MOOR);
  if (f.campaign.act1.currentAreaId === MOOR) f.campaign.travelAct1(CAMP);
  assert.equal(f.campaign.act1.currentAreaId, CAMP);
}

const campaignSnapshot = campaign => JSON.stringify(campaign.toJSON());
const rosterSnapshot = roster => JSON.stringify(roster.toJSON());

test('Den kills do not silently accept the quest before the Akara conversation', () => {
  const f = fixture();
  enterDen(f);
  const encounter = f.campaign.nextAct1Encounter();
  f.campaign.beginAct1Encounter(encounter.id);
  f.campaign.recordAct1Defeat(encounter.monsters[0].id, {
    hex: encounter.monsters[0].position, catalog,
  });
  assert.equal(f.campaign.reconcileDenQuest(['a', 'b', 'c']).status, 'available');
  assert.equal(Object.hasOwn(f.campaign.questState, QUEST), false);
  assert.equal(f.campaign.denQuestView().killed, 1);
});

test('Den quest uses all five authored encounters and freezes the actual final-kill party', () => {
  const f = fixture();
  assert.deepEqual(f.campaign.denQuestView(), {
    status: 'available', total: 30, killed: 0, remaining: 30,
    eligibleHeroIds: [], claimedHeroIds: [], completionEvidence: 'none',
  });
  assert.equal(f.campaign.acceptDenQuest(['a', 'b', 'c']).status, 'active');

  const completed = clearDen(f, { finalParty: ['b', 'c'] });
  assert.deepEqual(completed, {
    status: 'objective-complete', total: 30, killed: 30, remaining: 0,
    eligibleHeroIds: ['b', 'c'], claimedHeroIds: [], completionEvidence: 'final-kill-party',
  });

  const before = campaignSnapshot(f.campaign);
  assert.deepEqual(f.campaign.reconcileDenQuest(['a']), completed);
  assert.equal(campaignSnapshot(f.campaign), before);
  assert.equal(Object.values(f.campaign.act1.encounters)
    .filter(encounter => encounter.status === 'completed').length, 5);
});

test('Akara grants the Den reward exactly once to each eligible hero and nobody else', () => {
  const f = fixture();
  f.campaign.acceptDenQuest(['a', 'b', 'c']);
  clearDen(f, { finalParty: ['b', 'c'] });
  returnToCamp(f);
  f.roster.get('b').unspentSkillPoints = 2;
  f.roster.get('c').unspentSkillPoints = 4;
  const beforeA = structuredClone(f.roster.get('a'));
  const beforeD = structuredClone(f.roster.get('d'));

  assert.deepEqual(f.campaign.claimDenReward(f.roster), [
    { heroId: 'b', skillPoints: 1, respecAvailable: true },
    { heroId: 'c', skillPoints: 1, respecAvailable: true },
  ]);
  assert.equal(f.roster.get('b').unspentSkillPoints, 3);
  assert.equal(f.roster.get('c').unspentSkillPoints, 5);
  assert.deepEqual(f.roster.get('b').questRewards[REWARD], {
    schemaVersion: 1, skillPoints: 1, respecAvailable: true, respecUsable: false,
  });
  assert.deepEqual(f.roster.get('c').questRewards[REWARD], f.roster.get('b').questRewards[REWARD]);
  assert.deepEqual(f.roster.get('a'), beforeA);
  assert.deepEqual(f.roster.get('d'), beforeD);
  assert.equal(f.campaign.denQuestView().status, 'reward-claimed');
  assert.deepEqual(f.campaign.denQuestView().claimedHeroIds, ['b', 'c']);

  const campaignBeforeRepeat = campaignSnapshot(f.campaign);
  const rosterBeforeRepeat = rosterSnapshot(f.roster);
  assert.deepEqual(f.campaign.claimDenReward(f.roster), []);
  assert.equal(campaignSnapshot(f.campaign), campaignBeforeRepeat);
  assert.equal(rosterSnapshot(f.roster), rosterBeforeRepeat);
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('legacy Den completion and legacy personal receipts never award a new hero twice', () => {
  const legacy = fixture();
  clearDen(legacy, { reconcileEachKill: false, finalParty: ['a'] });
  // Simulate an old save that knew the cleared world but had no quest-party evidence.
  delete legacy.campaign.questState[QUEST];
  returnToCamp(legacy);
  const restored = CampaignState.restoreAct1(legacy.campaign.toJSON(), { catalog });
  legacy.campaign = restored;
  assert.deepEqual(legacy.campaign.denQuestView(), {
    status: 'objective-complete', total: 30, killed: 30, remaining: 0,
    eligibleHeroIds: [], claimedHeroIds: [], completionEvidence: 'legacy-party-unavailable',
  });
  assert.equal(legacy.campaign.acceptDenQuest(['a']).completionEvidence, 'legacy-party-unavailable');
  assert.deepEqual(legacy.campaign.claimDenReward(legacy.roster), []);
  assert.equal(legacy.roster.get('a').unspentSkillPoints, 0);
  assert.deepEqual(legacy.roster.get('a').questRewards, {});

  const f = fixture();
  f.campaign.acceptDenQuest(['a']);
  clearDen(f, { finalParty: ['a'] });
  returnToCamp(f);
  f.roster.get('a').unspentSkillPoints = 7;
  f.roster.get('a').questRewards[LEGACY_REWARD] = { skillPoints: 1, respecAvailable: true };
  assert.deepEqual(f.campaign.claimDenReward(f.roster), []);
  assert.equal(f.roster.get('a').unspentSkillPoints, 7);
  assert.equal(Object.hasOwn(f.roster.get('a').questRewards, REWARD), false);
  assert.equal(f.campaign.denQuestView().status, 'reward-claimed');
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('Den quest survives exact save/load and world validation before and after reward claim', () => {
  const f = fixture();
  f.campaign.acceptDenQuest(['a', 'b', 'c']);
  enterDen(f);
  const first = f.campaign.nextAct1Encounter();
  f.campaign.beginAct1Encounter(first.id);
  f.campaign.recordAct1Defeat(first.monsters[0].id, { hex: first.monsters[0].position, catalog });
  f.campaign.reconcileDenQuest(['a', 'b', 'c']);
  let raw = f.campaign.toJSON();
  f.campaign = CampaignState.restoreAct1(raw, { catalog });
  assert.deepEqual(f.campaign.toJSON(), raw);
  assert.equal(f.campaign.denQuestView().killed, 1);
  assert.equal(f.campaign.validateAct1World(f), true);

  for (const monster of first.monsters.slice(1)) {
    f.campaign.recordAct1Defeat(monster.id, { hex: monster.position, catalog });
    f.campaign.reconcileDenQuest(['a', 'b', 'c']);
  }
  // The helper continues with the remaining four real Den encounters.
  for (let index = 1; index < DEN_ENCOUNTERS.length; index += 1) {
    const config = f.campaign.nextAct1Encounter();
    assert.equal(config.id, DEN_ENCOUNTERS[index].id);
    f.campaign.beginAct1Encounter(config.id);
    for (const monster of config.monsters) {
      f.campaign.recordAct1Defeat(monster.id, { hex: monster.position, catalog });
      f.campaign.reconcileDenQuest(index === DEN_ENCOUNTERS.length - 1 ? ['a', 'c'] : ['a', 'b', 'c']);
    }
  }
  returnToCamp(f);
  raw = f.campaign.toJSON();
  f.campaign = CampaignState.restoreAct1(raw, { catalog });
  assert.deepEqual(f.campaign.toJSON(), raw);
  assert.deepEqual(f.campaign.denQuestView().eligibleHeroIds, ['a', 'c']);
  assert.equal(f.campaign.validateAct1World(f), true);

  f.campaign.claimDenReward(f.roster);
  raw = f.campaign.toJSON();
  const rosterRaw = f.roster.toJSON();
  f.campaign = CampaignState.restoreAct1(raw, { catalog });
  assert.deepEqual(f.campaign.toJSON(), raw);
  assert.deepEqual(f.roster.toJSON(), rosterRaw);
  assert.equal(f.campaign.validateAct1World(f), true);
});

test('future or contradictory Den quest data is rejected without rewriting the save', () => {
  const f = fixture();
  f.campaign.acceptDenQuest(['a', 'b']);
  const active = f.campaign.toJSON();
  const mutations = [
    data => { data.questState[QUEST].schemaVersion = 2; },
    data => { data.questState[QUEST].extra = true; },
    data => { data.questState[QUEST].status = 'reward-claimed'; },
    data => { data.questState[QUEST].eligibleHeroIds = ['a', 'a']; },
    data => { data.questState[QUEST].claimedHeroIds = ['a']; },
    data => { data.questState[QUEST].completionEvidence = 'invented'; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(active);
    mutate(data);
    const before = structuredClone(data);
    assert.throws(() => CampaignState.restoreAct1(data, { catalog }));
    assert.deepEqual(data, before);
  }

  // A schema-v1 personal receipt also has to be backed by quest eligibility and claim state.
  f.roster.get('a').questRewards[REWARD] = {
    schemaVersion: 1, skillPoints: 1, respecAvailable: true, respecUsable: false,
  };
  assert.throws(() => f.campaign.validateAct1World(f), /uprawnienia/);
});

test('reward publication is atomic when any eligible hero cannot receive the point', () => {
  const f = fixture();
  f.campaign.acceptDenQuest(['a', 'b']);
  clearDen(f, { finalParty: ['a', 'b'] });
  returnToCamp(f);
  f.roster.get('b').unspentSkillPoints = Number.MAX_SAFE_INTEGER;
  const beforeCampaign = campaignSnapshot(f.campaign);
  const beforeRoster = rosterSnapshot(f.roster);
  assert.throws(() => f.campaign.claimDenReward(f.roster), /bezpieczny zakres/);
  assert.equal(campaignSnapshot(f.campaign), beforeCampaign);
  assert.equal(rosterSnapshot(f.roster), beforeRoster);
});

test('Akara heals living party members in camp without revive or unrelated side effects', () => {
  const f = fixture(['a', 'b', 'c']);
  const a = f.roster.get('a'), b = f.roster.get('b'), c = f.roster.get('c');
  a.resources.hp = 3; a.resources.mana = 1; a.experience = 321;
  a.unspentStatPoints = 2; a.unspentSkillPoints = 3;
  b.experience = 123;
  c.lifeState = 'dead'; c.resources.hp = 0; c.resources.mana = 0;
  const campaignBefore = campaignSnapshot(f.campaign);
  const before = f.roster.toJSON();

  assert.deepEqual(f.campaign.healAtAkara(f.roster, ['a', 'b', 'c']), [{
    heroId: 'a', hpRestored: a.resources.maxHp - 3, manaRestored: a.resources.maxMana - 1,
  }]);
  assert.equal(campaignSnapshot(f.campaign), campaignBefore);
  assert.equal(a.resources.hp, a.resources.maxHp);
  assert.equal(a.resources.mana, a.resources.maxMana);
  assert.equal(c.lifeState, 'dead'); assert.equal(c.resources.hp, 0); assert.equal(c.resources.mana, 0);
  for (const [index, hero] of f.roster.toJSON().entries()) {
    const expected = structuredClone(before[index]);
    if (hero.id === 'a') {
      expected.resources.hp = expected.resources.maxHp;
      expected.resources.mana = expected.resources.maxMana;
    }
    assert.deepEqual(hero, expected);
  }
  assert.deepEqual(f.campaign.healAtAkara(f.roster, ['a', 'b', 'c']), []);

  a.resources.hp = 1;
  const rosterBeforeBadId = rosterSnapshot(f.roster);
  assert.throws(() => f.campaign.healAtAkara(f.roster, ['a', 'missing']), /Unknown character/);
  assert.equal(rosterSnapshot(f.roster), rosterBeforeBadId);

  f.campaign.travelAct1(MOOR);
  const rosterBeforeTravel = rosterSnapshot(f.roster);
  assert.throws(() => f.campaign.healAtAkara(f.roster, ['a']), /obozu/);
  assert.equal(rosterSnapshot(f.roster), rosterBeforeTravel);
});
