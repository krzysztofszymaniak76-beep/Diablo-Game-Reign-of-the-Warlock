/** Isolated test profile only. Exercise the actual native save validator/backup. */
export async function runSummonSaveBrowserChecks() {
  const debug=window.__rotwDebug, keys=debug.storageKeys, checks=[];
  const initial=structuredClone(debug.snapshot().save);
  const stored=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).map(k=>[k,localStorage.getItem(k)]);
  const check=(ok,label)=>{if(!ok)throw new Error(`${label}: ${document.querySelector('#game-toast')?.textContent}`);checks.push(label);};
  const restore=s=>{localStorage.removeItem(keys.backup);localStorage.setItem(keys.current,JSON.stringify(s));check(debug.loadGameState(),'fixture accepted');};
  try {
    const [{Roster},{Party},{PlayersSetting},{CombatState},{HexGrid},{BattlePreparationState},{planRaiseSkeleton,commitRaiseSkeleton}]=await Promise.all([
      import('/src/core/characters.js'),import('/src/core/party.js'),import('/src/core/players.js'),import('/src/core/combat.js'),import('/src/core/hex-grid.js'),import('/src/core/battle-preparation.js'),import('/src/core/summons.js')]);
    const roster=new Roster(initial.roster),party=new Party(roster,initial.partyIds),playersSetting=new PlayersSetting(initial.players);
    const combat=CombatState.restore(initial.combat,{party,playersSetting}),grid=HexGrid.restore(initial.hexGrid);
    const deploymentColumnOf=p=>p.q+Math.floor(p.r/2);
    const preparation=BattlePreparationState.restore(initial.battlePreparation,{deploymentColumnOf});preparation.startBattle();
    const free=grid.tiles().find(p=>grid.canOccupy(p));check(free,'free legal corpse hex');
    const corpse=combat.corpses.createFromDeath({sourceUnitId:'audit-dead-monster',sourceMonsterCode:'SOURCE_DATA_NOT_FOUND',position:free});
    combat.units.get('ormus').readinessTieKey='000:ormus';
    combat.nextReady(combat.units.keys());
    const beforeCast=structuredClone(initial);beforeCast.combat=combat.snapshot();beforeCast.battlePreparation=preparation.snapshot();beforeCast.actingUnitId='ormus';beforeCast.inspectedCharacterId='ormus';
    const plan=planRaiseSkeleton({combat,grid,preparation,casterId:'ormus',corpseId:corpse.id,manaCost:6,commandId:'browser-audit-cast'});
    const raised=commitRaiseSkeleton({combat,grid,preparation,plan,deploymentColumnOf});
    const valid=structuredClone(initial);valid.roster=raised.roster.toJSON();valid.combat=raised.combat.snapshot();valid.hexGrid=raised.grid.snapshot();valid.battlePreparation=raised.preparation.snapshot();
    valid.hexUnits=valid.hexGrid.units.map(u=>({id:u.id,position:u.position,footprint:u.footprint}));valid.actingUnitId=raised.combat.currentActorId;
    restore(valid);check(debug.saveGameState(),'native summon save succeeds');check(debug.loadGameState(),'native summon load succeeds');
    let current=debug.snapshot().save;check(current.combat.units.filter(u=>u.kind==='summon').length===1,'one summon after native roundtrip');
    check(current.combat.corpses.corpses.find(c=>c.id===corpse.id).consumed,'consumed corpse survives');
    check(current.roster.find(h=>h.id==='ormus').resources.mana===valid.roster.find(h=>h.id==='ormus').resources.mana,'load does not spend mana again');
    const bytes=JSON.stringify(current);
    const mutations=[
      ['duplicate summon',s=>s.combat.units.push(structuredClone(s.combat.units.find(u=>u.kind==='summon')))],
      ['duplicate corpse',s=>s.combat.corpses.corpses.push(structuredClone(s.combat.corpses.corpses[0]))],
      ['invalid owner',s=>s.combat.units.find(u=>u.kind==='summon').ownerId='unknown'],
      ['unknown source skill',s=>s.combat.units.find(u=>u.kind==='summon').sourceSkillId='necromancer.unknown'],
      ['outside board',s=>s.combat.units.find(u=>u.kind==='summon').position={q:999,r:999}],
      ['occupied hex',s=>s.combat.units.find(u=>u.kind==='summon').position=s.combat.units.find(u=>u.kind==='hero').position],
      ['corrupt HP',s=>s.combat.units.find(u=>u.kind==='summon').hp=-1],
      ['future summon schema',s=>s.combat.units.find(u=>u.kind==='summon').schemaVersion=99],
      ['wrong provenance',s=>s.combat.units.find(u=>u.kind==='summon').statInputs.sourceMonsterSha256='fake'],
    ];
    for(const [label,mutate] of mutations) {
      restore(JSON.parse(bytes));const bad=JSON.parse(bytes);mutate(bad);
      localStorage.setItem(keys.current,JSON.stringify(bad));localStorage.setItem(keys.backup,bytes);
      const backupBefore=localStorage.getItem(keys.backup);
      debug.loadGameState();
      check(localStorage.getItem(keys.backup)===backupBefore,`${label}: valid backup preserved`);
      check(JSON.stringify(debug.snapshot().save.combat.units)===JSON.stringify(JSON.parse(bytes).combat.units),`${label}: invalid summon never installed`);
    }
    restore(beforeCast);
    document.querySelector('#mouse-skill-right').click();
    document.querySelector('#mouse-skill-chooser [data-skill-id="necromancer.raise_skeleton"]').click();
    const canvas=document.querySelector('#scene'),bounds=canvas.getBoundingClientRect(),point=debug.projectHex(free.q,free.r);
    const cast=()=>canvas.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,detail:1,clientX:bounds.left+point.x,clientY:bounds.top+point.y}));
    const manaBefore=debug.snapshot().save.roster.find(h=>h.id==='ormus').resources.mana;
    cast();cast();
    current=debug.snapshot().save;
    check(current.combat.units.filter(u=>u.kind==='summon').length===1,'real PPM double delivery creates one summon');
    check(current.combat.corpses.corpses.find(c=>c.id===corpse.id).consumed,'real PPM consumes exactly one corpse');
    check(current.roster.find(h=>h.id==='ormus').resources.mana===manaBefore-6,'real PPM spends mana exactly once');
    for(let i=0;i<6;i++)document.querySelector('#end-turn').click();
    check(debug.saveGameState() && debug.loadGameState(),'AI movement and subsequent native save/load succeed');
    return {passed:checks.length,checks};
  } finally {
    restore(initial);localStorage.clear();for(const [k,v]of stored)localStorage.setItem(k,v);
  }
}
