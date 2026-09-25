/**
 * Focused native-save regressions. Import into the existing runner-owned browser;
 * this module starts no browser/server. All fixtures are explicitly serialized
 * save inputs, not substitutes for the separate complete gameplay acceptance.
 */
export async function runAct1NativeEdgeChecks() {
  const debug = globalThis.__rotwDebug;
  if (!debug) throw new Error('Game debug snapshot is unavailable');
  const checks = [];
  const state = () => structuredClone(debug.snapshot().save);
  const initial = state();
  const originalStorage = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .map(key => [key, localStorage.getItem(key)]);
  const keys = debug.storageKeys;
  let failure = null;
  const hero = (save, id) => save.roster.find(entry => entry.id === id);
  const check = (condition, label) => {
    if (!condition) throw new Error(`${label}: ${document.querySelector('#game-toast')?.textContent ?? ''}`);
    checks.push(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
  const click = selector => {
    const control = document.querySelector(selector);
    if (!control || control.disabled) throw new Error(`Missing/disabled control: ${selector}`);
    control.click();
  };
  const close = () => {
    if (document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false') click('#close-panel');
  };
  const restore = saved => {
    close();
    localStorage.clear();
    localStorage.setItem(keys.current, JSON.stringify(saved));
    if (!debug.loadGameState()) throw new Error(`Native edge fixture rejected: ${document.querySelector('#game-toast')?.textContent}`);
  };
  const protectedState = save => ({
    roster: save.roster, inventories: save.inventories, belts: save.belts, portalScrolls: save.portalScrolls,
    campaign: save.campaign, combat: save.combat, hexGrid: save.hexGrid, portals: save.portals,
    preparation: save.battlePreparation, mouseSkills: save.mouseSkills, rng: save.rng,
  });
  const dispatchCanvas = (hex, eventName) => {
    const point = debug.projectHex(hex.q, hex.r), canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect(), viewport = debug.battlefieldGeometry().viewport;
    if (!point) throw new Error('Fixture click is outside actual battlefield');
    canvas.dispatchEvent(new MouseEvent(eventName, {
      bubbles: true, cancelable: true, button: eventName === 'contextmenu' ? 2 : 0,
      clientX: rect.left + point.x * rect.width / viewport.width,
      clientY: rect.top + point.y * rect.height / viewport.height,
    }));
  };
  try {
    check(initial.campaign?.act1.currentAreaId === 'act1.rogue_encampment'
      && initial.campaign.act1.currentEncounterId === null, 'native edge suite begins from isolated fresh camp');
    const { PROGRESSION_DATA } = await import('/data/progression.v057.js');

    // Old training saves predate both campaign headers and progression metadata.
    const legacy = structuredClone(initial);
    delete legacy.campaign; delete legacy.campaignSchemaVersion;
    const oldHero = hero(legacy, 'korgan');
    delete oldHero.progression;
    oldHero.level = 1; oldHero.experience = 1500;
    oldHero.resources.hp = 17; oldHero.resources.mana = 2;
    const oldResources = structuredClone(oldHero.resources);
    const oldPoints = [oldHero.unspentStatPoints, oldHero.unspentSkillPoints];
    restore(legacy);
    const migrated = state(), advanced = hero(migrated, 'korgan');
    equal(migrated.campaign, null, 'older native save imports as the existing training mode');
    equal([advanced.level, advanced.experience], [3, 1500], 'old level-one accumulated EXP reaches source level three without losing EXP');
    equal([advanced.unspentStatPoints, advanced.unspentSkillPoints], [oldPoints[0] + 10, oldPoints[1] + 2], 'legacy two-level migration awards exact points once');
    equal([advanced.resources.hp, advanced.resources.mana], [17, 2], 'legacy progression migration preserves wounded current resources');
    equal([advanced.resources.maxHp, advanced.resources.maxMana],
      [oldResources.maxHp + 4, oldResources.maxMana + 2], 'legacy progression migration applies only two source growth increments');
    equal(migrated.inventories, legacy.inventories, 'legacy migration retains item ownership and layout');
    equal(migrated.mouseSkills, legacy.mouseSkills, 'legacy migration retains existing LPM/PPM bindings');
    equal(advanced.skills, oldHero.skills, 'legacy migration retains existing demonstration skill points');
    check(debug.loadGameState(), 'same old native save can be imported a second time');
    equal(hero(state(), 'korgan'), advanced, 'reloading old level-one EXP cannot stack rewards or resource growth');
    check(debug.saveGameState() && debug.loadGameState(), 'migrated progression publishes and reloads through native storage');
    equal(hero(state(), 'korgan'), advanced, 'published migrated save retains exactly the awarded progression');

    // Neither future progression format nor an unknown catalog may be hidden by
    // loading a valid older backup, or overwritten by pressing native Save.
    const valid = state();
    for (const [label, mutate] of [
      ['future progression schema', save => { hero(save, 'korgan').progression.schemaVersion = 99; }],
      ['future progression catalog', save => { hero(save, 'korgan').progression.catalogId = `${PROGRESSION_DATA.catalogId}:future`; }],
    ]) {
      restore(valid);
      const future = structuredClone(valid); mutate(future);
      const futureBytes = JSON.stringify(future), backupBytes = JSON.stringify(valid);
      localStorage.setItem(keys.current, futureBytes); localStorage.setItem(keys.backup, backupBytes);
      const liveBefore = state();
      check(debug.loadGameState() === false, `${label}: native load refuses fallback over future primary`);
      equal(state(), liveBefore, `${label}: failed load retains complete live state`);
      check(debug.saveGameState() === false, `${label}: native save refuses overwrite`);
      equal(localStorage.getItem(keys.current), futureBytes, `${label}: primary bytes preserved`);
      equal(localStorage.getItem(keys.backup), backupBytes, `${label}: valid backup bytes preserved`);
    }

    // A source fractional-life class is a reserve in the existing roster. Its
    // own already-earned legacy EXP is migrated, never shared from the party.
    const fractional = structuredClone(initial);
    const druid = hero(fractional, 'mael');
    if (!druid || druid.classId !== 'druid') throw new Error('Expected existing Druid reserve fixture');
    delete druid.progression; druid.experience = 500;
    druid.resources.hp = 12.5; druid.resources.mana = 2.25;
    const originalMaxHp = druid.resources.maxHp;
    restore(fractional);
    const fractionalHero = structuredClone(hero(state(), 'mael'));
    equal(fractionalHero.level, 2, 'Druid legacy EXP reaches the source level threshold');
    equal(fractionalHero.resources.maxHp, originalMaxHp + 1.5, 'fractional source life growth remains exact');
    equal([fractionalHero.resources.hp, fractionalHero.resources.mana], [12.5, 2.25], 'fractional current HP and mana remain exact');
    check(debug.saveGameState() && debug.loadGameState(), 'fractional HP/mana pass native save and restore');
    equal(hero(state(), 'mael'), fractionalHero, 'fractional-life native round trip neither rounds nor heals');
    equal(state().roster.filter(h => h.id !== 'mael'), initial.roster.filter(h => h.id !== 'mael'), 'reserve migration changes no other hero');

    // Camp input regression: use actual rendered buttons, keyboard dispatch and
    // the old dormant canvas coordinates; all battle mutations must stay gated.
    const woundedCamp = structuredClone(initial);
    hero(woundedCamp, 'korgan').resources.hp = 17;
    hero(woundedCamp, 'korgan').resources.mana = 2;
    restore(woundedCamp); close();
    const campBefore = state();
    for (const selector of ['#move-command', '#potion-health', '#potion-mana', '#change-loadout', '#end-turn',
      '#skill-card-right-1', '#hud-belt-slot-1', '#hud-belt-slot-2']) {
      const button = document.querySelector(selector);
      if (!button) throw new Error(`Expected camp control ${selector}`);
      check(button.disabled === true, `${selector} is disabled while the campaign is in camp`);
      button.click();
    }
    document.querySelector('#start-battle')?.click();
    for (const key of ['1', '2', '3', '4', 't', 'T']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    const oldEnemy = campBefore.combat.units.find(unit => unit.kind === 'monster');
    dispatchCanvas(oldEnemy.position, 'click'); dispatchCanvas(oldEnemy.position, 'contextmenu');
    const canvas = document.querySelector('#scene'); canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    equal(protectedState(state()), protectedState(campBefore), 'camp buttons, keys and mouse leave HP/mana, inventory and dormant combat unchanged');
    check(document.querySelector('#targeting-banner').classList.contains('hidden'), 'camp input leaves no stale targeting mode');

    // Enter through the real map first, so the preparation belongs to campaign
    // encounter 2. Fixture then represents one dead active hero coherently.
    click('[data-open-panel="map"]');
    click('[data-travel="act1.blood_moor"]');
    click('#campaign-next');
    const firstPrep = state();
    check(firstPrep.campaign.act1.currentEncounterId?.startsWith('act1.blood_moor.encounter.'), 'real map starts the first campaign preparation for the edge fixture');
    check(firstPrep.battlePreparation.encounterNumber >= 2, 'campaign preparation respects existing off-field migration boundary');
    const dead = structuredClone(firstPrep), deadId = 'hadriel';
    hero(dead, deadId).resources.hp = 0; hero(dead, deadId).lifeState = 'corpse';
    dead.battlePreparation.heroPresence.find(entry => entry.heroId === deadId).state = 'off-field';
    dead.battlePreparation.positions = dead.battlePreparation.positions.filter(entry => entry.unitId !== deadId);
    dead.hexUnits = dead.hexUnits.filter(entry => entry.id !== deadId);
    dead.hexGrid.units = dead.hexGrid.units.filter(entry => entry.id !== deadId);
    restore(dead);
    const deadLoaded = state();
    equal(hero(deadLoaded, deadId).resources.hp, 0, 'native campaign fixture preserves dead active hero HP zero');
    check(!deadLoaded.hexUnits.some(unit => unit.id === deadId), 'dead active hero has no battlefield occupancy after native load');
    check(deadLoaded.battlePreparation.heroPresence.find(entry => entry.heroId === deadId).state === 'off-field', 'dead active hero stays off-field after native load');
    check(debug.saveGameState() && debug.loadGameState(), 'campaign with dead active member passes native save/load');
    equal(state().roster, deadLoaded.roster, 'dead-member round trip does not revive, heal or change EXP');
    equal(state().campaign, deadLoaded.campaign, 'dead-member round trip keeps current campaign encounter identity');
    equal(state().mouseSkills, deadLoaded.mouseSkills, 'dead-member round trip preserves all LPM/PPM bindings');

    return { passed: checks.length, checks,
      fixtures: 'Explicit native-save edge fixtures only: legacy earned EXP, future schema/catalog, fractional resources, wounded camp and one coherently dead member after map entry.' };
  } catch (error) {
    failure = error;
    globalThis.__act1NativeEdgeFailure = { message: error?.stack ?? String(error), checks,
      toast: document.querySelector('#game-toast')?.textContent, save: state() };
    throw error;
  } finally {
    try { restore(initial); } catch (cleanupError) {
      if (failure) globalThis.__act1NativeEdgeFailure.cleanupError = cleanupError?.stack ?? String(cleanupError);
      else throw cleanupError;
    } finally {
      localStorage.clear();
      for (const [key, value] of originalStorage) localStorage.setItem(key, value);
    }
  }
}
