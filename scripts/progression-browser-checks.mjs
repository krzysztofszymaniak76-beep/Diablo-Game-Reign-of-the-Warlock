/**
 * Stage A integration check. Run ONLY in an owned, isolated browser profile.
 * The single fixture puts a level-1 hero at 499 accumulated EXP; it does not
 * award a level, kill a monster, spend points or complete an encounter.
 * All those actions below use the application's ordinary UI/save entrypoints.
 * The later campaign acceptance playthrough must start without this XP fixture.
 */
export async function runProgressionBrowserChecks() {
  const debug = globalThis.__rotwDebug;
  if (!debug) throw new Error('Game debug snapshot is unavailable');
  const checks = [];
  const state = () => debug.snapshot().save;
  const hero = (save, id = 'korgan') => save.roster.find(entry => entry.id === id);
  const initial = structuredClone(state());
  const storage = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .map(key => [key, localStorage.getItem(key)]);
  const check = (condition, label) => {
    if (!condition) throw new Error(`${label}: ${document.querySelector('#game-toast')?.textContent ?? ''}`);
    checks.push(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
  const click = selector => {
    const element = document.querySelector(selector);
    if (!element || element.disabled) throw new Error(`Missing or disabled UI control: ${selector}`);
    element.click();
  };
  const close = () => {
    if (document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false') click('#close-panel');
  };
  const restore = save => {
    close();
    localStorage.clear();
    localStorage.setItem(debug.storageKeys.current, JSON.stringify(save));
    if (!debug.loadGameState()) throw new Error(`Save fixture rejected: ${document.querySelector('#game-toast')?.textContent}`);
  };
  const characterPanel = () => {
    close();
    click('.hero[data-character-id="korgan"]');
    click(document.querySelector('#character-command') ? '#character-command' : '[data-open-panel="character"]');
  };
  const text = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing progression display: ${selector}`);
    return element.textContent;
  };
  const hexKey = point => `${point.q},${point.r}`;
  const distance = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
  const clickHex = hex => {
    const point = debug.projectHex(hex.q, hex.r);
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    const viewport = debug.battlefieldGeometry().viewport;
    canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: rect.left + point.x * rect.width / viewport.width,
      clientY: rect.top + point.y * rect.height / viewport.height,
    }));
  };
  const moveTarget = (save, actorId, target) => {
    const start = save.hexUnits.find(unit => unit.id === actorId)?.position;
    if (!start) return null;
    const tiles = new Set(save.hexGrid.tiles.map(hexKey));
    const occupied = new Set(save.hexUnits.filter(unit => unit.id !== actorId).map(unit => hexKey(unit.position)));
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    const queue = [{ point: start, cost: 0 }];
    const visited = new Set([hexKey(start)]);
    for (let i = 0; i < queue.length; i += 1) {
      const { point, cost } = queue[i];
      if (cost === 3) continue;
      for (const [q, r] of directions) {
        const next = { q: point.q + q, r: point.r + r };
        const key = hexKey(next);
        if (!tiles.has(key) || occupied.has(key) || visited.has(key)) continue;
        visited.add(key);
        queue.push({ point: next, cost: cost + 1 });
      }
    }
    return queue.filter(entry => entry.cost > 0)
      .sort((a, b) => distance(a.point, target) - distance(b.point, target)
        || a.cost - b.cost || a.point.q - b.point.q || a.point.r - b.point.r)[0]?.point;
  };
  function winThroughUi() {
    close();
    if (debug.snapshot().phase === 'preparation') click('#start-battle');
    for (let turn = 0; turn < 180; turn += 1) {
      const before = state();
      if (before.battlePreparation.phase === 'completed') return before;
      const actorId = debug.snapshot().actingUnitId;
      if (!actorId) throw new Error(`Ordinary battle has no player command window at step ${turn + 1}`);
      const actorPosition = before.hexUnits.find(unit => unit.id === actorId)?.position;
      const enemies = before.combat.units.filter(unit => unit.kind === 'monster' && unit.hp > 0);
      if (!actorPosition || !enemies.length) throw new Error('Battle has no living legal actor/target');
      const target = enemies.sort((a, b) => distance(actorPosition, a.position) - distance(actorPosition, b.position)
        || a.id.localeCompare(b.id))[0];
      click(`.hero[data-character-id="${actorId}"]`);
      // Primary click also exercises the ordinary melee approach-and-attack path.
      clickHex(target.position);
      if (JSON.stringify(state().combat) !== JSON.stringify(before.combat)) continue;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const destination = moveTarget(before, actorId, target.position);
      if (destination) {
        click('#move-command');
        clickHex(destination);
      }
      if (JSON.stringify(state().combat) === JSON.stringify(before.combat)) click('#end-turn');
    }
    throw new Error('Ordinary UI battle did not finish within the deterministic limit');
  }
  try {
    const { PROGRESSION_DATA } = await import('/data/progression.v057.js');
    const profile = PROGRESSION_DATA.classes[hero(initial).classId];
    check(initial.battlePreparation.phase === 'preparation', 'dedicated Stage A fixture starts in preparation');
    check(hero(initial).level === 1 && profile.thresholds[1] === 500, 'source threshold for initial hero level 2 is 500 EXP');
    const fixture = structuredClone(initial);
    hero(fixture).experience = 499;
    restore(fixture);
    const imported = structuredClone(hero(state()));
    equal(imported.level, 1, 'import at 499 EXP remains level 1');
    equal(imported.experience, 499, 'import preserves accumulated EXP');
    equal(imported.resources, hero(initial).resources, 'import below threshold neither heals nor changes resource maxima');
    characterPanel();
    check(text('#experience-next').includes('500'), 'character panel shows the real next threshold');
    check(text('#experience-progress').length > 0, 'character panel shows progress to the next level');
    check(text('#stat-points').includes(String(imported.unspentStatPoints)), 'character panel shows stat-point pool');
    check(text('#skill-points').includes(String(imported.unspentSkillPoints)), 'character panel shows skill-point pool');
    close();

    click('#inventory-command');
    for (const [name, itemId, ownerId] of [
      ['Korgan', 'korgan.hand_axe', 'korgan'],
      ['Hadriel', 'hadriel.scepter', 'hadriel'],
      ['Ormus', 'ormus.wand', 'ormus'],
    ]) {
      if (hero(state(), ownerId).equipment.weapon?.id === itemId) continue;
      const ownerTab = [...document.querySelectorAll('#equipment-owner-tabs button')].find(button => button.textContent === name);
      if (!ownerTab) throw new Error(`Missing equipment owner ${name}`);
      ownerTab.click();
      click(`[data-item-id="${itemId}"]`);
      click('#equipment-action');
    }
    close();
    const equipped = structuredClone(state());
    const victory = structuredClone(winThroughUi());
    const advanced = hero(victory);
    check(victory.partyIds.every(id => hero(victory, id).lifeState === 'alive'), 'test encounter ends with all three participating heroes alive');
    const expectedExperience = 499 + victory.combat.units.filter(unit => unit.kind === 'monster')
      .reduce((sum, unit) => sum + Math.floor(unit.experience / victory.partyIds.length), 0);
    equal(advanced.experience, expectedExperience, 'actual kills award exactly one share of scaled monster EXP');
    equal(advanced.level, 2, 'ordinary battle kill advances hero to level 2');
    equal(advanced.unspentStatPoints, imported.unspentStatPoints + profile.statPointsPerLevel, 'actual level-up grants source stat points once');
    equal(advanced.unspentSkillPoints, imported.unspentSkillPoints + profile.skillPointsPerLevel, 'actual level-up grants one source skill-point allocation');
    equal(advanced.resources.maxHp, imported.resources.maxHp + profile.lifePerLevel, 'level-up increases max HP by the class source amount');
    equal(advanced.resources.maxMana, imported.resources.maxMana + profile.manaPerLevel, 'level-up increases max mana by the class source amount');
    check(victory.combat.units.filter(unit => unit.kind === 'monster').every(unit => unit.rewardsGranted), 'each defeated monster has an EXP receipt');
    equal(advanced.equipment, hero(equipped).equipment, 'level-up preserves equipped items');
    equal(victory.mouseSkills, equipped.mouseSkills, 'level-up preserves LPM/PPM bindings');

    characterPanel();
    const beforeSpend = structuredClone(hero(state()));
    click('[data-spend-stat="vitality"]');
    const spent = structuredClone(hero(state()));
    equal(spent.stats.vitality, beforeSpend.stats.vitality + 1, 'UI spends one point on the selected hero vitality');
    equal(spent.unspentStatPoints, beforeSpend.unspentStatPoints - 1, 'UI deducts exactly one stat point');
    equal(spent.resources.maxHp, beforeSpend.resources.maxHp + profile.lifePerVitality, 'vitality increases class-dependent max HP');
    equal([spent.resources.hp, spent.resources.mana], [beforeSpend.resources.hp, beforeSpend.resources.mana], 'spending a stat point preserves current HP and mana');
    equal(spent.unspentSkillPoints, beforeSpend.unspentSkillPoints, 'stat allocation does not spend skill points');
    check(text('#stat-points').includes(String(spent.unspentStatPoints)), 'stat-point display refreshes after spending');
    const otherHeroes = state().roster.filter(entry => entry.id !== spent.id);
    equal(otherHeroes, victory.roster.filter(entry => entry.id !== spent.id), 'spending affects only the inspected hero');
    if (typeof window.captureAct1Evidence === 'function') {
      const evidenceName = 'character-level-up';
      window.captureAct1Evidence(evidenceName);
      const deadline = Date.now() + 15000;
      while (window.__act1CaptureDone !== evidenceName) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the owned runner to capture the character panel');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const checkpointSave = structuredClone(state());
    close();
    characterPanel();
    equal(hero(state()), spent, 'reopening the panel neither awards points nor heals');
    close();
    check(debug.saveGameState(), 'progression native save succeeds');
    check(debug.loadGameState(), 'progression native load succeeds');
    equal(hero(state()), spent, 'native save/load preserves level, cumulative EXP, pools, attributes and resources');
    equal(state().encounterProgress, checkpointSave.encounterProgress, 'native save/load preserves kill and loot receipts');
    check(debug.loadGameState(), 'second native load succeeds');
    equal(hero(state()), spent, 'second load does not duplicate level-up rewards');
    return {
      passed: checks.length,
      checks,
      fixture: 'Only starting EXP=499 on existing level-1 Korgan; actual kill, level-up and stat spend through UI.',
      checkpointSave,
    };
  } finally {
    try { restore(initial); } finally {
      localStorage.clear();
      for (const [key, value] of storage) localStorage.setItem(key, value);
    }
  }
}
