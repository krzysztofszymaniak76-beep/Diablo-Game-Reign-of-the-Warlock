/** Run only in a dedicated browser test profile: exercises real native storage. */
export async function runHeroControlSaveBrowserChecks() {
  const checks = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const eq = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected), label);
  const debug = window.__rotwDebug;
  const keys = debug.storageKeys;
  const state = () => structuredClone(debug.snapshot().save);
  const initial = state();
  const originalStorage = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .map(key => [key, localStorage.getItem(key)]);
  const click = selector => {
    const control = document.querySelector(selector);
    if (!control || control.disabled) throw new Error(`Missing or disabled control: ${selector}`);
    control.click();
  };
  const closePanel = () => {
    if (document.querySelector('#panel-layer')?.getAttribute('aria-hidden') === 'false') click('#close-panel');
  };
  const restore = saved => {
    closePanel();
    localStorage.removeItem(keys.backup);
    localStorage.setItem(keys.current, JSON.stringify(saved));
    if (!debug.loadGameState()) throw new Error(`Save fixture rejected: ${document.querySelector('#game-toast')?.textContent}`);
  };
  const select = id => click(`.hero[data-character-id="${id}"]`);
  const choose = (side, skillId) => {
    click(`#mouse-skill-${side}`);
    click(`#mouse-skill-chooser [data-skill-id="${skillId}"][data-mouse-side="${side}"]`);
  };
  const conserved = saved => ({ roster: saved.roster, inventories: saved.inventories,
    belts: saved.belts, loot: saved.loot, encounterProgress: saved.encounterProgress,
    portalScrolls: saved.portalScrolls, weaponSets: saved.weaponSets, rng: saved.rng });
  try {
    check(initial.battlePreparation.phase === 'preparation', 'save checks begin with safe preparation fixture');
    select('korgan'); choose('left', 'barbarian.bash'); choose('right', 'barbarian.shout');
    const manaBeforeBuff = state().roster.find(hero => hero.id === 'korgan').resources.mana;
    click('#skill-card-right-1');
    check(state().roster.find(hero => hero.id === 'korgan').resources.mana < manaBeforeBuff,
      `real prepared Battle Orders spends mana before save round-trip: ${document.querySelector('#game-toast')?.textContent}; phase=${state().battlePreparation.phase}; actor=${state().actingUnitId}`);
    select('hadriel'); choose('left', 'paladin.zeal'); choose('right', 'paladin.holy_fire');
    click('#skill-card-right-2');
    select('ormus'); choose('left', 'necromancer.teeth'); choose('right', 'necromancer.clay_golem');
    check(debug.saveGameState(), 'native save accepts independent controls and spent mana');
    const native = JSON.parse(localStorage.getItem(keys.current));
    eq(native.activeAuras.find(entry => entry.heroId === 'hadriel')?.activeAuraSkillId, 'paladin.holy_fire',
      'native save explicitly records activeAuraSkillId from the live aura');
    const changed = structuredClone(native);
    changed.roster.find(hero => hero.id === 'korgan').resources.mana = 2.5;
    restore(changed);
    check(debug.saveGameState(), 'native save accepts remaining fractional mana');
    const fractional = JSON.parse(localStorage.getItem(keys.current));
    restore(native);
    restore(fractional);
    eq(state().roster.find(hero => hero.id === 'korgan').resources.mana, 2.5, 'native load preserves 2.5 mana exactly');
    eq(state().mouseSkills, fractional.mouseSkills, 'native load preserves every hero LPM/PPM independently');
    eq(state().activeAuras, fractional.activeAuras, 'native load preserves active aura and other heroes without aura');
    eq(conserved(state()), conserved(fractional), 'native load preserves inventories, equipment, loot, resources and RNG');

    for (const version of ['v0.5.4', 'v0.5.5']) {
      const legacy = structuredClone(fractional);
      delete legacy.activeAuras; delete legacy.activeAuraSchemaVersion;
      if (version === 'v0.5.4') {
        legacy.mouseSkillCatalogId = legacy.mouseSkills.catalogId = 'd2r-mouse-skill-bindings-v0.5.4';
        const reserve = legacy.mouseSkills.bindings.find(entry => entry.heroId === 'mael');
        if (reserve) reserve.left = 'druid.maul';
      }
      const originalBytes = JSON.stringify(legacy);
      restore(legacy);
      eq(conserved(state()), conserved(legacy), `${version} migration byte-preserves inventory/equipment/loot/resources sections`);
      eq(state().mouseSkills.bindings, legacy.mouseSkills.bindings, `${version} migration preserves every mouse assignment`);
      eq(state().activeAuras, fractional.activeAuras, `${version} migration derives aura from existing effects`);
      eq(localStorage.getItem(keys.backup), originalBytes, `${version} migration keeps original valid bytes as backup`);
      eq(JSON.parse(localStorage.getItem(keys.current)).activeAuraSchemaVersion, 1, `${version} migration publishes current aura schema`);
    }
    const beforeMouseSchema = structuredClone(fractional);
    for (const field of ['mouseSkillSchemaVersion', 'mouseSkillCatalogId', 'mouseSkills', 'activeAuras', 'activeAuraSchemaVersion']) delete beforeMouseSchema[field];
    restore(beforeMouseSchema);
    eq(conserved(state()), conserved(beforeMouseSchema), 'pre-mouse save migration preserves inventory/equipment/loot/mana');
    eq(state().mouseSkills.bindings.find(entry => entry.heroId === 'korgan').left, 'basic.attack', 'pre-mouse save obtains explicit safe Attack default');

    for (const [label, corrupt] of [
      ['nested legacy mouse catalog mismatch', saved => { saved.mouseSkillCatalogId = 'd2r-mouse-skill-bindings-v0.5.4'; saved.mouseSkills.catalogId = 'forged'; }],
      ['non-representable mana', saved => { saved.roster[0].resources.mana = 0.1; }],
      ['false aura identity', saved => { saved.activeAuras.find(entry => entry.heroId === 'hadriel').activeAuraSkillId = 'paladin.might'; }],
      ['partial aura header', saved => { delete saved.activeAuras; }],
    ]) {
      restore(fractional);
      const damaged = structuredClone(fractional); corrupt(damaged);
      const bytes = JSON.stringify(damaged);
      localStorage.setItem(keys.current, bytes); localStorage.removeItem(keys.backup);
      const before = state();
      check(!debug.loadGameState(), `load rejects ${label}`);
      eq(state(), before, `failed ${label} load preserves complete live session`);
      eq(localStorage.getItem(keys.current), bytes, `failed ${label} load preserves damaged source for recovery`);
    }

    restore(fractional);
    const validBytes = JSON.stringify(fractional);
    localStorage.setItem(keys.backup, validBytes);
    localStorage.setItem(keys.current, '{broken-json');
    check(debug.saveGameState(), 'new valid save can replace corrupt JSON primary');
    eq(localStorage.getItem(keys.backup), validBytes, 'corrupt JSON never overwrites good backup');
    localStorage.setItem(keys.current, '{broken-json');
    check(debug.loadGameState(), 'native load recovers good backup after corrupt primary');
    eq(conserved(state()), conserved(fractional), 'backup recovery preserves original gameplay state');
    eq(localStorage.getItem(keys.backup), validBytes, 'backup recovery keeps original backup bytes');

    for (const onlyBackup of [false, true]) {
      restore(fractional);
      const future = JSON.stringify({ ...fractional, activeAuraSchemaVersion: 99 });
      localStorage.setItem(keys.backup, future);
      if (onlyBackup) localStorage.removeItem(keys.current);
      const primary = localStorage.getItem(keys.current);
      check(!debug.saveGameState(), `future aura backup blocks replacement (sole=${onlyBackup})`);
      eq(localStorage.getItem(keys.current), primary, 'future backup protection preserves primary bytes');
      eq(localStorage.getItem(keys.backup), future, 'future backup is never overwritten');
    }

    // Use the actual core to build a valid in-flight projectile graph. A second
    // hero is ready at the same tick, allowing real save/load before impact.
    restore(fractional); select('ormus'); click('#start-battle');
    const active = state();
    eq(active.combat.readiness.currentActorId, 'ormus', 'ranged save fixture opens Ormus decision');
    const [{ Roster }, { Party }, { PlayersSetting }, { CombatState, PROJECTILE_HEX_TIME }, { HexGrid }] = await Promise.all([
      import('/src/core/characters.js'), import('/src/core/party.js'), import('/src/core/players.js'),
      import('/src/core/combat.js'), import('/src/core/hex-grid.js'),
    ]);
    const roster = new Roster(active.roster), party = new Party(roster, active.partyIds);
    const combat = CombatState.restore(active.combat, { party, playersSetting: new PlayersSetting(active.players) });
    const grid = HexGrid.restore(active.hexGrid);
    const enemy = [...combat.units.values()].find(unit => unit.kind === 'monster');
    const from = grid.positionOf('ormus'), destination = { q: from.q + 3, r: from.r };
    check(grid.has(destination) && !grid.isBlocked(destination), 'ranged save target is a legal empty hex');
    grid.removeUnit(enemy.id); grid.addUnit({ id: enemy.id, position: destination });
    enemy.position = destination;
    active.hexGrid = grid.snapshot();
    active.hexUnits.find(unit => unit.id === enemy.id).position = destination;
    const execution = { schemaVersion: 1, skillId: 'necromancer.teeth', skillLevel: 1, side: 'left', weaponFingerprint: null };
    combat.submitProjectile('ormus', { skillId: 'necromancer.teeth', skillExecution: execution,
      targetId: enemy.id, range: 5, attackType: 'ranged', damage: 6 },
    { from, to: destination, targetAnchor: destination, stepTime: PROJECTILE_HEX_TIME });
    combat.advanceTimeline(combat.units.keys());
    active.combat = combat.snapshot();
    check(active.combat.scheduler.queue.some(event => event.kind === 'projectile:step' && !event.payload.skillExecution),
      'real pending projectile includes intermediate steps without skillExecution');
    const unspent = active.roster.find(hero => hero.id === 'ormus').resources.mana;
    restore(active);
    eq(state().roster.find(hero => hero.id === 'ormus').resources.mana, unspent, 'load of pending projectile charges no mana before impact');
    check(state().combat.commands.active.length === 1, 'load preserves one pending ranged command');
    check(debug.saveGameState() && debug.loadGameState(), 'pending ranged attack round-trips through native storage');
    eq(state().roster.find(hero => hero.id === 'ormus').resources.mana, unspent, 'repeated pending load cannot double-charge mana');

    const oldPending = structuredClone(active);
    for (const command of oldPending.combat.commands.active) delete command.payload.skillExecution;
    for (const event of oldPending.combat.scheduler.queue) if (event.payload) delete event.payload.skillExecution;
    for (const [, transaction] of oldPending.combat.commands.transactions) {
      for (const event of transaction.result.events ?? []) if (event.payload) delete event.payload.skillExecution;
    }
    localStorage.setItem(keys.current, JSON.stringify(oldPending)); localStorage.removeItem(keys.backup);
    const beforeRejection = state();
    check(!debug.loadGameState(), 'legacy prepaid in-flight attack is clearly rejected');
    check(document.querySelector('#game-toast')?.textContent.includes('v0.5.5'), 'legacy pending rejection explains incompatible mana accounting');
    eq(state(), beforeRejection, 'legacy pending rejection preserves live mana and command');
    return { passed: checks.length, checks };
  } finally {
    restore(initial);
    localStorage.clear();
    for (const [key, value] of originalStorage) localStorage.setItem(key, value);
  }
}
