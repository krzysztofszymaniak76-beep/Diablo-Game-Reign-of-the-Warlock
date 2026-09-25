import { generateAreaMap, shortestSectorPath } from '../src/core/exploration.js';

/**
 * Actual Stage B / full Stage C playthrough in an isolated, owned browser profile.
 * Gameplay begins with the native fresh campaign and 0 EXP. Only the final
 * invalid-save checks alter serialized data, after the real playthrough.
 */
export async function runAct1BrowserChecks({ full = false } = {}) {
  const debug = globalThis.__rotwDebug;
  if (!debug) throw new Error('Game is not ready');
  const checks = [];
  const recentActions = [];
  let primaryFailure = null;
  let lastCanvasClick = null;
  const state = () => debug.snapshot().save;
  const combatFingerprint = save => {
    const timeline = { ...save.combat };
    delete timeline.log; // Selecting a skill writes a log entry but takes no action.
    return JSON.stringify(timeline);
  };
  const initial = structuredClone(state());
  const originalStorage = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .map(key => [key, localStorage.getItem(key)]);
  const hero = (save, id) => save.roster.find(entry => entry.id === id);
  const encounter = save => save.campaign.act1.encounters[save.campaign.act1.currentEncounterId];
  const monsters = save => save.combat.units.filter(unit => unit.kind === 'monster');
  const live = save => monsters(save).filter(unit => unit.hp > 0);
  const quest = save => save.campaign.questState['act1.den_of_evil'] ?? { status: 'available' };
  const completed = (save, areaId) => Object.entries(save.campaign.act1.encounters)
    .filter(([id, entry]) => id.startsWith(`${areaId}.encounter.`) && entry.status === 'completed');
  const denKills = save => Object.entries(save.campaign.act1.encounters)
    .filter(([id]) => id.startsWith('act1.den_of_evil.encounter.'))
    .reduce((total, [, entry]) => total + entry.defeatedIds.length, 0);
  const check = (condition, label) => {
    if (!condition) throw new Error(`${label}: ${document.querySelector('#game-toast')?.textContent ?? ''}`);
    checks.push(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
  const click = selector => {
    const button = document.querySelector(selector);
    if (!button || button.disabled) throw new Error(`Missing/disabled ${selector}: ${document.querySelector('#game-toast')?.textContent ?? ''}`);
    button.click();
  };
  const clickVisibleHudControl = selector => {
    const button = document.querySelector(selector);
    const rect = button?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    if (!button || button.disabled || !rect || rect.width < 1 || rect.height < 1
      || style.display === 'none' || style.visibility === 'hidden') {
      throw new Error(`Missing/disabled/hidden HUD control ${selector}: ${document.querySelector('#game-toast')?.textContent ?? ''}`);
    }
    button.click();
  };
  const close = () => {
    if (document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false') click('#close-panel');
  };
  const openMap = () => { close(); click('[data-open-panel="map"]'); };
  const explorationMap = (save=state()) => generateAreaMap({worldSeed:save.campaign.worldSeed,
    areaId:save.campaign.act1.currentAreaId,difficulty:save.campaign.difficulty,
    generatorVersion:save.campaign.act1.exploration.generatorVersion});
    const clickSector = sectorId => {
      if(document.querySelector('#game-panel.sanctuary-map')) {click(`[data-travel-sector="${sectorId}"]`);return;}
    const sector=document.querySelector(`[data-sector-id="${sectorId}"]`);
    if(!sector)throw new Error(`Missing visible exploration sector ${sectorId}`);
    sector.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
  };
  const walkToSector = sectorId => {
    // A landscape card may cover a short known corridor. Recalculate the first
    // legal direction after each activation, and fail with a useful diagnostic
    // if a card would ever send the isolated campaign around a cycle.
    const visited=new Set();
    for(let guard=0;guard<160;guard++) {
      const before=state(),from=before.campaign.act1.exploration.currentSectorId;
      if(from===sectorId)return;
      if(visited.has(from))throw new Error(`Travel-card cycle while routing ${from} -> ${sectorId}`);
      visited.add(from);
      openMap();
      const current=state(),map=explorationMap(current),path=shortestSectorPath(map,current.campaign.act1.exploration.currentSectorId,sectorId);
      if(!path||path.length<2)throw new Error(`No exploration path ${from} -> ${sectorId}`);
      clickSector(path[1]);
      if(state().campaign.act1.exploration.currentSectorId===from)throw new Error(`Travel card did not advance from ${from}`);
    }
    throw new Error(`Travel-card route to ${sectorId} exceeded its safety guard`);
  };
  const travel = areaId => {
    openMap();
    const map=explorationMap(),exit=map.exits.find(entry=>entry.targetAreaId===areaId);
    if(!exit)throw new Error(`No exit from ${map.areaId} to ${areaId}`);
    walkToSector(exit.sectorId);
    click(`[data-area-exit="${areaId}"]`);
    equal(state().campaign.act1.currentAreaId, areaId, `UI travel reaches ${areaId}`);
  };
  const startNextCampaignEncounter = () => {
    const save=state(),map=explorationMap(save);
    const placement=map.encounters.find(entry=>save.campaign.act1.encounters[entry.encounterId].status==='unvisited');
    if(!placement)throw new Error(`No unvisited encounter in ${map.areaId}`);
    walkToSector(placement.sectorId);
    equal(state().campaign.act1.currentEncounterId,placement.encounterId,`sector ${placement.sectorId} starts ${placement.encounterId}`);
  };
  const openQuests = () => { close(); click('[data-open-panel="quests"]'); };
  const verifyQuestProgress = (killed, label) => {
    openQuests();
    equal(denKills(state()), killed, `${label}: only recorded Den kills advance the objective`);
    const text = document.querySelector('#den-quest-progress')?.textContent ?? '';
    check(text.includes(`${killed}/30`) && text.includes(`pozostało ${30 - killed}`),
      `${label}: quest UI displays ${killed}/30 and ${30 - killed} remaining`);
  };
  const healAtCamp = () => {
    equal(state().campaign.act1.currentAreaId, 'act1.rogue_encampment', 'Akara service is requested in camp');
    const before = structuredClone(state());
    openQuests();
    equal(state().roster, before.roster, 'opening the quest journal does not heal the party');
    close();
    click('[data-camp-action="akara"]');
    check(document.querySelector('#panel-title')?.textContent.trim() === 'HANDEL · AKARA'
      && document.querySelector('#merchant-panel') && !document.querySelector('.d2-dialogue-sheet'),
    'clicking Akara opens trade directly without a service menu');
    const expected = structuredClone(before.roster);
    for (const member of expected) {
      if (!before.partyIds.includes(member.id) || member.lifeState !== 'alive') continue;
      member.resources.hp = member.resources.maxHp;
      member.resources.mana = member.resources.maxMana;
    }
    equal(state().roster, expected, 'visiting Akara restores only living active heroes without progression changes');
    equal(state().campaign, before.campaign, 'healing preserves encounter, loot and quest receipts');
    equal(state().inventories, before.inventories, 'healing preserves item ownership');
    close();
    return JSON.stringify(expected) !== JSON.stringify(before.roster);
  };
  const campHealingRoundTrip = areaId => {
    if (areaId === 'act1.den_of_evil') travel('act1.blood_moor');
    travel('act1.rogue_encampment');
    const restoredResources = healAtCamp();
    travel('act1.blood_moor');
    if (areaId === 'act1.den_of_evil') travel('act1.den_of_evil');
    return restoredResources;
  };
  const restore = save => {
    close();
    localStorage.clear();
    localStorage.setItem(debug.storageKeys.current, JSON.stringify(save));
    if (!debug.loadGameState()) throw new Error(`Could not restore isolated test state: ${document.querySelector('#game-toast')?.textContent}`);
  };
  const evidence = async name => {
    if (typeof window.captureAct1Evidence !== 'function') return;
    window.captureAct1Evidence(name);
    const deadline = Date.now() + 15000;
    while (window.__act1CaptureDone !== name) {
      if (Date.now() > deadline) throw new Error(`Screenshot acknowledgement timed out: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const hexKey = point => `${point.q},${point.r}`;
  const distance = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
  const clickHex = async (hex, side = 'left') => {
    const clickKey = `${side}:${hexKey(hex)}`;
    const elapsed = performance.now() - (lastCanvasClick?.time ?? -Infinity);
    // Distinct user actions must not masquerade as a double-delivered click.
    if (lastCanvasClick?.key === clickKey && elapsed < 310) {
      await new Promise(resolve => setTimeout(resolve, 310 - elapsed));
    }
    const point = debug.projectHex(hex.q, hex.r);
    if (!point) throw new Error(`Target outside board: ${hexKey(hex)}`);
    const canvas = document.querySelector('#scene'), rect = canvas.getBoundingClientRect();
    const viewport = debug.battlefieldGeometry().viewport;
    canvas.dispatchEvent(new MouseEvent(side === 'left' ? 'click' : 'contextmenu', {
      bubbles: true, cancelable: true, button: side === 'left' ? 0 : 2,
      clientX: rect.left + point.x * rect.width / viewport.width,
      clientY: rect.top + point.y * rect.height / viewport.height,
    }));
    lastCanvasClick = { key: clickKey, time: performance.now() };
  };
  function moveTarget(save, actorId, target) {
    const start = save.hexUnits.find(unit => unit.id === actorId)?.position;
    if (!start) return null;
    const tiles = new Set(save.hexGrid.tiles.map(hexKey));
    const occupied = new Set(save.hexUnits.filter(unit => unit.id !== actorId).map(unit => hexKey(unit.position)));
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const queue = [{ point: start, cost: 0 }], visited = new Set([hexKey(start)]);
    for (let index = 0; index < queue.length; index += 1) {
      const { point, cost } = queue[index];
      if (cost === 3) continue;
      for (const [q, r] of directions) {
        const next = { q: point.q + q, r: point.r + r }, key = hexKey(next);
        if (!tiles.has(key) || occupied.has(key) || visited.has(key)) continue;
        visited.add(key); queue.push({ point: next, cost: cost + 1 });
      }
    }
    return queue.filter(entry => entry.cost > 0)
      .sort((a, b) => distance(a.point, target) - distance(b.point, target)
        || a.cost - b.cost || a.point.q - b.point.q || a.point.r - b.point.r)[0]?.point;
  }
  function chooseAttack(actorId) {
    const preferred = actorId === 'ormus' ? 'necromancer.teeth'
      : actorId === 'hadriel' ? 'paladin.blessed_hammer' : 'basic.attack';
    click('#mouse-skill-left');
    const preferredButton = document.querySelector(`#mouse-skill-chooser [data-skill-id="${preferred}"]`);
    const fallback = document.querySelector('#mouse-skill-chooser [data-skill-id="basic.attack"]');
    const choice = preferredButton && !preferredButton.disabled && !preferredButton.classList.contains('mana-unavailable')
      ? preferredButton : fallback;
    if (!choice || choice.disabled) throw new Error(`No legal attack binding for ${actorId}`);
    choice.click();
    return choice.dataset.skillId;
  }
  async function winCurrentBattle({ checkFirstKill = false } = {}) {
    close();
    if (state().battlePreparation.phase === 'preparation') click('#start-battle');
    let firstKillChecked = false;
    let lootTargetChecked = false;
    for (let turn = 0; turn < 260; turn += 1) {
      const before = state();
      if (checkFirstKill && !firstKillChecked && monsters(before).some(unit => unit.hp === 0)) {
        firstKillChecked = true;
        const dead = monsters(before).filter(unit => unit.hp === 0);
        equal(dead.length, 1, 'first observed kill affects one individual monster');
        equal(live(before).length, 5, 'five monsters remain alive after the first kill');
        equal(before.battlePreparation.phase, 'active', 'first kill does not end the six-monster battle');
        equal(encounter(before).defeatedIds, [dead[0].id], 'first kill receipt identifies the actual dead monster');
        equal(encounter(before).drops.map(drop => drop.enemyId), [dead[0].id], 'first drop belongs to the killed monster');
        check(!before.hexUnits.some(unit => unit.id === dead[0].id), 'first defeated monster no longer occupies a hex');
        check(live(before).every(unit => unit.rewardsGranted === false), 'living monsters have no EXP reward receipt');
        check(debug.saveGameState() && debug.loadGameState(), 'mixed living/dead multi-monster battle saves and loads');
        equal(state().combat.units, before.combat.units, 'mid-battle restore retains separate IDs, HP and reward flags');
        equal(state().campaign, before.campaign, 'mid-battle restore keeps the one kill and one drop');
        equal(state().roster, before.roster, 'mid-battle load neither heals nor duplicates EXP');
      }
      if (before.battlePreparation.phase === 'completed') {
        if (checkFirstKill && !firstKillChecked) throw new Error('Never observed a legal intermediate first-kill state');
        return before;
      }
      const actorId = debug.snapshot().actingUnitId;
      if (!actorId || !hero(before, actorId)) throw new Error('No player command window during ordinary battle');
      const actorPosition = before.hexUnits.find(unit => unit.id === actorId)?.position;
      if (!actorPosition || !live(before).length) throw new Error('No legal actor or living monster');
      const target = live(before).sort((a, b) => distance(actorPosition, a.position) - distance(actorPosition, b.position)
        || a.hp - b.hp || a.id.localeCompare(b.id))[0];
      click(`.hero[data-character-id="${actorId}"]`);
      const actor = hero(before, actorId), belt = before.belts.find(([owner]) => owner === actorId)?.[1];
      if (actor.resources.hp <= 12 && actor.resources.hp < actor.resources.maxHp && belt?.[0]?.count > 0) {
        click('#potion-health');
        continue;
      }
      const chosenSkill = chooseAttack(actorId);
      await clickHex(target.position);
      if (!lootTargetChecked && encounter(before).drops.some(drop => drop.status === 'ground'
        && hexKey(drop.hex) === hexKey(target.position))
        && combatFingerprint(state()) !== combatFingerprint(before)) {
        check(document.querySelector('#panel-layer').getAttribute('aria-hidden') === 'true',
          'living monster on a loot hex receives the combat command instead of opening loot');
        lootTargetChecked = true;
      }
      recentActions.push({ turn, actorId, chosenSkill, actorPosition, targetId: target.id,
        targetPosition: target.position, beforeTime: before.combat.scheduler.time,
        afterTime: state().combat.scheduler.time, toast: document.querySelector('#game-toast')?.textContent,
        actionAccepted: combatFingerprint(state()) !== combatFingerprint(before) });
      if (recentActions.length > 40) recentActions.shift();
      if (combatFingerprint(state()) !== combatFingerprint(before)) continue;
      if (!document.querySelector('#targeting-banner').classList.contains('hidden')) click('#cancel-targeting');
      const destination = moveTarget(before, actorId, target.position);
      if (destination) { click('#move-command'); await clickHex(destination); }
      recentActions.at(-1).fallbackMove = destination;
      recentActions.at(-1).fallbackToast = document.querySelector('#game-toast')?.textContent;
      if (combatFingerprint(state()) === combatFingerprint(before)) {
        if (!document.querySelector('#targeting-banner').classList.contains('hidden')) click('#cancel-targeting');
        click('#end-turn');
      }
    }
    throw new Error('Normal UI battle exceeded 260 player commands');
  }
  function equipStarters() {
    close(); click('#inventory-command');
    for (const [name, ownerId, itemId] of [
      ['Korgan', 'korgan', 'korgan.hand_axe'], ['Hadriel', 'hadriel', 'hadriel.scepter'], ['Ormus', 'ormus', 'ormus.wand'],
    ]) {
      if (hero(state(), ownerId).equipment.weapon?.id === itemId) continue;
      const owner = [...document.querySelectorAll('#equipment-owner-tabs button')].find(button => button.textContent === name);
      if (!owner) throw new Error(`Equipment owner missing: ${name}`);
      owner.click(); click(`[data-item-id="${itemId}"]`); click('#equipment-action');
    }
    close();
  }
  const characterPanel = (characterId = 'korgan') => {
    close();
    click(`.hero[data-character-id="${characterId}"]`);
    click(document.querySelector('#character-command') ? '#character-command' : '[data-open-panel="character"]');
  };
  const denRewardReceipt = character => Object.entries(character.questRewards ?? {})
    .find(([key]) => key === 'normal:act1.den_of_evil' || key === 'normal:den_of_evil');
  async function runFullCampaignPlaythrough() {
    const { PROGRESSION_DATA } = await import('/data/progression.v057.js');
    const starting = structuredClone(state());
    const startingById = new Map(starting.roster.map(entry => [entry.id, entry]));
    const partyIds = [...starting.partyIds];
    const reserveIds = starting.roster.map(entry => entry.id).filter(id => !partyIds.includes(id));
    equal(starting.players, 1, 'full acceptance route starts on the native /players 1 setting');

    openQuests();
    check(document.querySelector('#akara-accept') && !document.querySelector('#akara-accept').disabled,
      'fresh campaign offers the Den of Evil quest through Akara');
    check(document.querySelector('#den-quest-status')?.textContent.includes('Dostępne'),
      'quest journal visibly starts in the available state');
    const beforeAccept = structuredClone(state());
    click('#akara-accept');
    equal(quest(state()).status, 'active', 'Akara acceptance activates the real quest');
    equal(state().roster, beforeAccept.roster, 'accepting the quest grants no EXP, points, healing or reward');
    equal(quest(state()).eligibleHeroIds, [], 'acceptance does not prematurely freeze reward recipients');
    check(document.querySelector('#akara-accept').disabled, 'accepted quest cannot be accepted twice through the UI');
    const accepted = structuredClone(state());
    document.querySelector('#akara-accept').click();
    equal(state(), accepted, 'disabled repeated acceptance is a no-op');
    close();

    let cumulativeExperience = 0;
    let restorativeAkaraUse = false;
    travel('act1.blood_moor');
    await evidence('map-travel');
    for (let fight = 1; fight <= 3; fight += 1) {
      openMap();
      startNextCampaignEncounter();
      const started = structuredClone(state());
      const expectedId = `act1.blood_moor.encounter.${String(fight).padStart(2, '0')}`;
      equal(started.campaign.act1.currentEncounterId, expectedId,
        `Blood Moor fight ${fight} starts the authored encounter in sequence`);
      equal(monsters(started).length, 6, `Blood Moor fight ${fight} exposes six individual monsters`);
      equal(new Set(monsters(started).map(unit => unit.id)).size, 6,
        `Blood Moor fight ${fight} keeps unique monster identities`);
      if (fight === 1) await evidence('multi-enemy-battle');
      const victory = structuredClone(await winCurrentBattle({ checkFirstKill: fight === 1 }));
      equal(encounter(victory).status, 'completed', `Blood Moor fight ${fight} completes through ordinary UI combat`);
      equal(encounter(victory).defeatedIds.length, 6, `Blood Moor fight ${fight} records all six actual kills`);
      cumulativeExperience += monsters(victory).reduce((sum, unit) => sum + Math.floor(unit.experience / partyIds.length), 0);
      equal(partyIds.map(id => hero(victory, id).experience), partyIds.map(() => cumulativeExperience),
        `Blood Moor fight ${fight} awards each participant exactly one EXP share`);
      check(partyIds.every(id => hero(victory, id).lifeState === 'alive'),
        `all active heroes survive Blood Moor fight ${fight}`);
      if (fight === 1) {
        const swordDrop = encounter(victory).drops.find(drop => drop.item.canonicalId === 'short_sword');
        if (!swordDrop) throw new Error('First authored encounter did not offer the expected source short sword');
        click('#loot-toast');
        [...document.querySelectorAll('#loot-owner-tabs button')]
          .find(button => button.textContent === 'Korgan').click();
        click(`[data-pickup="${swordDrop.id}"]`);
        check(state().inventories.find(([ownerId]) => ownerId === 'korgan')[1].items
          .some(item => item.id === swordDrop.id), 'actual combat drop is collected through the loot UI');
        close();
        click('#inventory-command');
        [...document.querySelectorAll('#equipment-owner-tabs button')]
          .find(button => button.textContent === 'Korgan').click();
        click(`[data-item-id="${swordDrop.id}"]`);
        click('#equipment-action');
        equal(hero(state(), 'korgan').equipment.weapon.id, swordDrop.id,
          'collected combat drop is equipped through the existing inventory UI');
        await evidence('inventory-equipped');
        close();
      }
      verifyQuestProgress(0, `after Blood Moor fight ${fight}`);
      close();
      if (fight === 2) {
        const midMoor = structuredClone(state());
        check(debug.saveGameState() && debug.loadGameState(), 'native save/load succeeds midway through Blood Moor');
        equal(state().campaign, midMoor.campaign, 'mid-Moor load preserves encounters and active quest state');
        equal(state().roster, midMoor.roster, 'mid-Moor load preserves actual EXP and current resources');
      }
      restorativeAkaraUse = campHealingRoundTrip('act1.blood_moor') || restorativeAkaraUse;
    }
    equal(completed(state(), 'act1.blood_moor').length, 3, 'all three Blood Moor encounters remain completed');
    equal(cumulativeExperience, 153, 'three source-authored Blood Moor fights award 153 EXP per active hero');

    travel('act1.den_of_evil');
    for (let fight = 1; fight <= 5; fight += 1) {
      openMap();
      startNextCampaignEncounter();
      const started = structuredClone(state());
      const expectedId = `act1.den_of_evil.encounter.${String(fight).padStart(2, '0')}`;
      equal(started.campaign.act1.currentEncounterId, expectedId,
        `Den fight ${fight} starts the authored encounter in sequence`);
      equal(monsters(started).length, 6, `Den fight ${fight} exposes six individual monsters`);
      const victory = structuredClone(await winCurrentBattle());
      equal(encounter(victory).status, 'completed', `Den fight ${fight} completes through ordinary UI combat`);
      equal(encounter(victory).defeatedIds.length, 6, `Den fight ${fight} records all six actual kills`);
      cumulativeExperience += monsters(victory).reduce((sum, unit) => sum + Math.floor(unit.experience / partyIds.length), 0);
      equal(partyIds.map(id => hero(victory, id).experience), partyIds.map(() => cumulativeExperience),
        `Den fight ${fight} awards each participant exactly one EXP share`);
      check(partyIds.every(id => hero(victory, id).lifeState === 'alive'),
        `all active heroes survive Den fight ${fight}`);
      verifyQuestProgress(fight * 6, `after Den fight ${fight}`);
      equal(quest(state()).status, fight === 5 ? 'objective-complete' : 'active',
        `Den quest status is correct after fight ${fight}`);
      if (fight === 1) await evidence('quest-progress');
      close();
      if (fight === 3) {
        const midDen = structuredClone(state());
        check(debug.saveGameState() && debug.loadGameState(), 'native save/load succeeds midway through the Den');
        equal(state().campaign, midDen.campaign, 'mid-Den load preserves exact kill progress and quest state');
        equal(state().roster, midDen.roster, 'mid-Den load preserves cumulative EXP and resources');
      }
      if (fight < 5) restorativeAkaraUse = campHealingRoundTrip('act1.den_of_evil') || restorativeAkaraUse;
    }

    const cleared = structuredClone(state());
    equal(completed(cleared, 'act1.den_of_evil').length, 5, 'all five Den encounters remain completed');
    equal(denKills(cleared), 30, 'the objective is backed by thirty individual Den kill receipts');
    const allDefeatedIds = Object.values(cleared.campaign.act1.encounters).flatMap(entry => entry.defeatedIds);
    equal(allDefeatedIds.length, 48, 'the full route stores one receipt for each of forty-eight defeated monsters');
    equal(new Set(allDefeatedIds).size, 48, 'all forty-eight kill receipts retain unique monster identities');
    equal(cumulativeExperience, 558, 'the complete source-authored route awards 558 EXP per active hero');
    equal(quest(cleared).eligibleHeroIds, partyIds, 'the actual final-kill party is frozen as reward recipients');
    equal(quest(cleared).claimedHeroIds, [], 'clearing the Den does not silently claim Akara rewards');
    equal(quest(cleared).completionEvidence, 'final-kill-party', 'quest completion records actual final-kill party evidence');
    for (const id of partyIds) {
      const advanced = hero(cleared, id), baseline = startingById.get(id), profile = PROGRESSION_DATA.classes[advanced.classId];
      equal(advanced.experience, 558, `${advanced.name} retains exact cumulative route EXP`);
      equal(advanced.level, 2, `${advanced.name} reaches level 2 naturally during the final Den fight`);
      equal(advanced.unspentStatPoints, baseline.unspentStatPoints + profile.statPointsPerLevel,
        `${advanced.name} receives source stat points exactly once`);
      equal(advanced.unspentSkillPoints, baseline.unspentSkillPoints + profile.skillPointsPerLevel,
        `${advanced.name} receives the level-up skill point exactly once`);
    }
    for (const id of reserveIds) {
      equal(hero(cleared, id), startingById.get(id), `reserve hero ${id} receives no combat progression or quest eligibility`);
    }

    characterPanel('korgan');
    const beforeSpend = structuredClone(hero(state(), 'korgan'));
    const korganProfile = PROGRESSION_DATA.classes[beforeSpend.classId];
    click('[data-spend-stat="vitality"]');
    const afterSpend = structuredClone(hero(state(), 'korgan'));
    equal(afterSpend.stats.vitality, beforeSpend.stats.vitality + 1, 'character UI spends one real vitality point');
    equal(afterSpend.unspentStatPoints, beforeSpend.unspentStatPoints - 1, 'stat allocation deducts exactly one point');
    equal(afterSpend.resources.maxHp, beforeSpend.resources.maxHp + korganProfile.lifePerVitality,
      'vitality allocation applies the class source HP increment');
    equal([afterSpend.resources.hp, afterSpend.resources.mana], [beforeSpend.resources.hp, beforeSpend.resources.mana],
      'stat allocation does not silently heal current resources');
    await evidence('character-level-up');
    close();

    travel('act1.blood_moor');
    travel('act1.rogue_encampment');
    restorativeAkaraUse = healAtCamp() || restorativeAkaraUse;
    check(restorativeAkaraUse, 'at least one Akara visit restores actually spent HP or mana');
    const beforeClaim = structuredClone(state());
    openQuests();
    check(document.querySelector('#akara-claim') && !document.querySelector('#akara-claim').disabled,
      'completed eligible party can explicitly claim the reward from Akara');
    click('#akara-claim');
    const rewarded = structuredClone(state());
    equal(quest(rewarded).status, 'reward-claimed', 'Akara conversation marks the reward claimed');
    equal(quest(rewarded).claimedHeroIds, partyIds, 'each eligible hero receives one personal claim receipt');
    for (const id of partyIds) {
      const before = hero(beforeClaim, id), after = hero(rewarded, id), receipt = denRewardReceipt(after);
      equal(after.unspentSkillPoints, before.unspentSkillPoints + 1,
        `${after.name} receives exactly one quest skill point`);
      equal(receipt?.[1], { schemaVersion: 1, skillPoints: 1, respecAvailable: true, respecUsable: false },
        `${after.name} stores the exact personal reward and non-usable respec entitlement`);
      equal(receipt?.[0], 'normal:act1.den_of_evil', `${after.name} stores the canonical Normal reward key`);
      equal({ level: after.level, experience: after.experience, stats: after.stats, resources: after.resources, equipment: after.equipment },
        { level: before.level, experience: before.experience, stats: before.stats, resources: before.resources, equipment: before.equipment },
        `${after.name} reward changes no combat progression, resources or equipment`);
    }
    for (const id of reserveIds) {
      equal(hero(rewarded, id), hero(beforeClaim, id), `ineligible reserve hero ${id} inherits no Den reward`);
      check(!denRewardReceipt(hero(rewarded, id)), `ineligible reserve hero ${id} has no reward receipt`);
    }
    check(document.querySelector('#den-quest-status')?.textContent.includes('Nagroda odebrana'),
      'quest UI visibly reports the claimed state');
    check(document.querySelector('#akara-claim').disabled, 'claimed reward control is disabled');
    await evidence('quest-reward');
    document.querySelector('#akara-claim').click();
    equal(state(), rewarded, 'repeated click on the disabled reward control cannot duplicate any reward');
    close();

    const checkpointSave = structuredClone(state());
    close();
    clickVisibleHudControl('#save');
    const checkpointBytes = localStorage.getItem(debug.storageKeys.current);
    check(Boolean(checkpointBytes), 'visible ZAPISZ creates the final campaign checkpoint');
    const persistedCheckpoint = JSON.parse(checkpointBytes);
    equal(persistedCheckpoint.campaign, checkpointSave.campaign,
      'visible ZAPISZ persists final encounter, quest and claim receipts');
    equal(persistedCheckpoint.roster, checkpointSave.roster,
      'visible ZAPISZ persists final level, stat spend and personal rewards');
    equal(persistedCheckpoint.inventories, checkpointSave.inventories,
      'visible ZAPISZ persists final inventory ownership');

    travel('act1.blood_moor');
    equal(state().campaign.act1.currentAreaId, 'act1.blood_moor',
      'real UI travel changes the live campaign before the final visible load');
    close();
    clickVisibleHudControl('#load');
    equal(state().campaign, checkpointSave.campaign, 'visible WCZYTAJ restores all encounter, quest and claim receipts');
    equal(state().roster, checkpointSave.roster, 'visible WCZYTAJ restores level, stat spend, healing and personal rewards');
    equal(state().inventories, checkpointSave.inventories, 'visible WCZYTAJ restores inventory ownership');
    equal(state().mouseSkills, checkpointSave.mouseSkills, 'visible WCZYTAJ restores actual LPM/PPM choices');

    travel('act1.blood_moor');
    close();
    clickVisibleHudControl('#load');
    equal(state().campaign, checkpointSave.campaign, 'second visible WCZYTAJ does not duplicate quest completion or claims');
    equal(state().roster, checkpointSave.roster, 'second visible WCZYTAJ does not duplicate EXP, stat or skill points');
    openQuests();
    await evidence('save-reloaded');
    close();
    const futureReceiptSave = structuredClone(checkpointSave);
    futureReceiptSave.roster.find(member => member.id === partyIds[0])
      .questRewards['normal:act1.den_of_evil'].schemaVersion = 2;
    const futureReceiptBytes = JSON.stringify(futureReceiptSave);
    const validBackupBytes = JSON.stringify(checkpointSave);
    localStorage.setItem(debug.storageKeys.current, futureReceiptBytes);
    localStorage.setItem(debug.storageKeys.backup, validBackupBytes);
    check(debug.saveGameState() === false, 'save refuses to overwrite a future personal quest-reward receipt');
    equal(localStorage.getItem(debug.storageKeys.current), futureReceiptBytes,
      'future personal reward bytes remain intact');
    equal(localStorage.getItem(debug.storageKeys.backup), validBackupBytes,
      'future personal reward refusal preserves the valid backup');
    restore(checkpointSave);
    return {
      passed: checks.length,
      checks,
      fixture: 'No gameplay fixtures: fresh campaign, 0 EXP, 3 Blood Moor and 5 Den fights, explicit Akara actions through actual UI.',
      checkpointSave,
    };
  }
  try {
    check(initial.campaign?.act1.currentAreaId === 'act1.rogue_encampment', 'native new campaign starts in Rogue Encampment');
    check(initial.roster.every(entry => entry.level === 1 && entry.experience === 0), 'actual playthrough starts at level 1 and 0 EXP without fixtures');
    check(Object.values(initial.campaign.act1.encounters).every(entry => entry.status === 'unvisited'), 'native campaign has no precompleted encounters');
    close();
    const safe = structuredClone(state().combat);
    document.querySelector('#end-turn').click();
    await clickHex(monsters(state())[0].position);
    equal(state().combat, safe, 'camp UI and canvas cannot start hostile AI or advance battle time');
    equipStarters();
    if (full) return await runFullCampaignPlaythrough();
    const prepared = structuredClone(state());
    travel('act1.blood_moor');
    equal(state().roster, prepared.roster, 'travel to Blood Moor preserves equipment, EXP and current resources');
    equal(state().campaign.act1.currentEncounterId, null, 'travel does not secretly start an encounter');
    await evidence('map-travel');
    startNextCampaignEncounter();
    const firstStart = structuredClone(state()), firstId = firstStart.campaign.act1.currentEncounterId;
    check(firstId?.startsWith('act1.blood_moor.encounter.'), 'map starts a stable Blood Moor encounter identity');
    equal(firstStart.battlePreparation.phase, 'preparation', 'campaign battle opens in deployment preparation');
    equal(monsters(firstStart).length, 6, 'six independent monsters appear in the first encounter');
    equal(new Set(monsters(firstStart).map(unit => unit.id)).size, 6, 'all six monsters have unique runtime IDs');
    equal(new Set(monsters(firstStart).map(unit => hexKey(unit.position))).size, 6, 'all six monsters occupy distinct hexes');
    const positions = new Map(debug.battlefieldGeometry().tiles.map(tile => [hexKey(tile), tile]));
    check(monsters(firstStart).every(unit => positions.has(hexKey(unit.position)) && !positions.get(hexKey(unit.position)).deployment), 'all enemies spawn on legal nondeployment hexes');
    await evidence('multi-enemy-battle');
    const firstVictory = structuredClone(await winCurrentBattle({ checkFirstKill: true }));
    await evidence('map-after-fight');
    equal(encounter(firstVictory).status, 'completed', 'first campaign encounter completes after all six deaths');
    equal(encounter(firstVictory).defeatedIds.length, 6, 'all six kills have separate receipts');
    equal(encounter(firstVictory).drops.length, 6, 'each killed monster produces its own stable loot record');
    equal(live(firstVictory).length, 0, 'victory contains no living monster');
    check(firstVictory.partyIds.every(id => hero(firstVictory, id).lifeState === 'alive'), 'ordinary first encounter is winnable with the original party');
    const expectedExperience = monsters(firstVictory).reduce((sum, unit) => sum + Math.floor(unit.experience / firstVictory.partyIds.length), 0);
    equal(firstVictory.partyIds.map(id => hero(firstVictory, id).experience), firstVictory.partyIds.map(() => expectedExperience), 'actual kills give each participant one share of source-scaled EXP');

    const swordDrop = encounter(firstVictory).drops.find(drop => drop.item.canonicalId === 'short_sword');
    if (!swordDrop) throw new Error('First authored encounter did not offer the expected source short sword');
    click('#loot-toast');
    [...document.querySelectorAll('#loot-owner-tabs button')].find(button => button.textContent === 'Korgan').click();
    const pickup = document.querySelector(`[data-pickup="${swordDrop.id}"]`);
    if (!pickup || pickup.disabled) throw new Error('Actual drop cannot be picked up');
    pickup.click();
    const once = structuredClone(state());
    pickup.click();
    equal(state().campaign, once.campaign, 'stale repeated pickup cannot duplicate campaign receipt');
    equal(state().roster, once.roster, 'stale pickup cannot grant more EXP or items');
    close(); click('#inventory-command');
    [...document.querySelectorAll('#equipment-owner-tabs button')].find(button => button.textContent === 'Korgan').click();
    click(`[data-item-id="${swordDrop.id}"]`); click('#equipment-action');
    equal(hero(state(), 'korgan').equipment.weapon.id, swordDrop.id, 'real collected sword equips through the existing inventory UI');
    close();
    const equippedVictory = structuredClone(state());
    travel('act1.rogue_encampment');
    equal(state().roster, equippedVictory.roster, 'return to camp does not heal, reset EXP or change equipment');
    const campCombat = structuredClone(state().combat);
    close(); document.querySelector('#end-turn').click(); await clickHex(monsters(state())[0].position);
    equal(state().combat, campCombat, 'returning camp keeps the previous battle dormant');
    travel('act1.blood_moor');
    equal(state().campaign.act1.encounters[firstId], equippedVictory.campaign.act1.encounters[firstId], 'revisiting Blood Moor retains clear state and collected loot');
    equal(state().roster, equippedVictory.roster, 'round trip preserves character progression and equipment exactly');
    equal(state().inventories, equippedVictory.inventories, 'round trip does not duplicate the collected sword');
    travel('act1.den_of_evil');
    const forbidden = document.querySelector('[data-area-exit="act1.rogue_encampment"]');
    check(!forbidden, 'Den of Evil has no direct travel edge to camp');
    const beforeForbidden = structuredClone(state().campaign);
    equal(state().campaign, beforeForbidden, 'disabled illegal connection cannot change location');
    equal(state().loot, null, 'Blood Moor drops are not transplanted into the Den');
    startNextCampaignEncounter();
    const denStart = structuredClone(state());
    check(denStart.campaign.act1.currentEncounterId.startsWith('act1.den_of_evil.encounter.'), 'Den battle owns a distinct encounter identity');
    check(monsters(denStart).every(unit => !monsters(firstStart).some(previous => previous.id === unit.id)), 'separate encounters never reuse monster runtime IDs');
    const denVictory = structuredClone(await winCurrentBattle());
    equal(encounter(denVictory).status, 'completed', 'ordinary UI commands also clear the first Den encounter');
    equal(denVictory.campaign.act1.encounters[firstId], equippedVictory.campaign.act1.encounters[firstId], 'Den fight does not reset Blood Moor rewards');
    check(denVictory.partyIds.every(id => hero(denVictory, id).experience > hero(firstVictory, id).experience), 'next real encounter grants additional cumulative EXP');
    const checkpointSave = structuredClone(state());
    check(debug.saveGameState() && debug.loadGameState(), 'real multi-location campaign saves and loads');
    equal(state().campaign, checkpointSave.campaign, 'native load preserves current location and all encounter progress');
    equal(state().roster, checkpointSave.roster, 'native load preserves heroes, rewards, equipment and remaining HP/mana');
    equal(state().inventories, checkpointSave.inventories, 'native load preserves physical loot ownership');
    equal(state().mouseSkills, checkpointSave.mouseSkills, 'native load preserves actual LPM/PPM choices');
    openMap();
    await evidence('map-after-load');
    close();

    // Isolated corrupt-save fixtures begin only after the actual gameplay above.
    for (const [label, mutate] of [
      ['unknown campaign area', save => { save.campaign.act1.currentAreaId = 'act1.unknown'; }],
      ['duplicated defeated identity', save => { encounter(save).defeatedIds.push(encounter(save).defeatedIds[0]); }],
      ['missing encounter ledger', save => { delete save.campaign.act1.encounters[firstId]; }],
    ]) {
      restore(checkpointSave);
      const invalid = structuredClone(checkpointSave); mutate(invalid);
      localStorage.setItem(debug.storageKeys.current, JSON.stringify(invalid));
      localStorage.removeItem(debug.storageKeys.backup);
      const before = structuredClone(state());
      check(debug.loadGameState() === false, `native load rejects ${label}`);
      equal(state(), before, `${label} cannot partially install state`);
    }
    restore(checkpointSave);
    const future = { ...structuredClone(checkpointSave), campaignSchemaVersion: 99 };
    const futureBytes = JSON.stringify(future), backupBytes = JSON.stringify(checkpointSave);
    localStorage.setItem(debug.storageKeys.current, futureBytes);
    localStorage.setItem(debug.storageKeys.backup, backupBytes);
    check(debug.saveGameState() === false, 'save refuses to overwrite future campaign format');
    equal(localStorage.getItem(debug.storageKeys.current), futureBytes, 'future campaign bytes remain intact');
    equal(localStorage.getItem(debug.storageKeys.backup), backupBytes, 'future-format refusal preserves the valid backup bytes');
    return { passed: checks.length, checks, fixture: 'No gameplay fixtures: native fresh campaign and 0 EXP; corrupt-save fixtures only after actual play.', checkpointSave };
  } catch (error) {
    primaryFailure = error;
    const failureState = structuredClone(state());
    window.__act1Failure = { message: error?.stack ?? String(error),
      toast: document.querySelector('#game-toast')?.textContent,
      actingUnitId: debug.snapshot().actingUnitId,
      recentActions: structuredClone(recentActions),
      lastLog: failureState.combat.log.slice(-20), save: failureState };
    throw error;
  } finally {
    try { restore(initial); } catch (cleanupError) {
      if (primaryFailure) window.__act1Failure.cleanupError = cleanupError?.stack ?? String(cleanupError);
      else throw cleanupError;
    } finally {
      localStorage.clear();
      for (const [key, value] of originalStorage) localStorage.setItem(key, value);
    }
  }
}
