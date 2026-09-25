/** Use ONLY in a dedicated test profile. Includes synthetic save fixtures, never a player's tab. */
export async function runEncounterBrowserChecks() {
  const results=[];
  const check=(ok,label)=>{if(!ok)throw new Error(label);results.push(label);};
  const eq=(a,b,label)=>check(JSON.stringify(a)===JSON.stringify(b),label);
  const state=()=>__rotwDebug.snapshot().save;
  const visibleState=()=>__rotwDebug.snapshot();
  const clone=v=>structuredClone(v);
  const keys=__rotwDebug.storageKeys;
  const originalStorage=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).map(k=>[k,localStorage.getItem(k)]);
  const initial=clone(state());
  const click=selector=>{const e=document.querySelector(selector);if(!e||e.disabled)throw new Error('Missing/disabled '+selector);e.click();};
  const close=()=>{if(document.querySelector('#panel-layer').getAttribute('aria-hidden')==='false')click('#close-panel');};
  const restore=(save)=>{close();localStorage.clear();localStorage.setItem(keys.current,JSON.stringify(save));if(!__rotwDebug.loadGameState())throw new Error('Fixture rejected: '+document.querySelector('#game-toast').textContent);};
  const selectOwner=name=>{const b=[...document.querySelectorAll('#loot-owner-tabs button')].find(b=>b.textContent===name);if(!b)throw new Error('owner '+name);b.click();};
  const hero=(s,id)=>s.roster.find(h=>h.id===id);
  const bag=(s,id)=>s.inventories.find(([owner])=>owner===id)[1];
  const hexKey=p=>`${p.q},${p.r}`;
  const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.r-b.r)+Math.abs(a.q+a.r-b.q-b.r))/2;
  const directions=[[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
  const clickHex=hex=>{const p=__rotwDebug.projectHex(hex.q,hex.r),r=document.querySelector('#scene').getBoundingClientRect(),v=__rotwDebug.battlefieldGeometry().viewport;document.querySelector('#scene').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+p.x*r.width/v.width,clientY:r.top+p.y*r.height/v.height}));};
  function moveTarget(s,actor,target) {
    const start=s.hexUnits.find(u=>u.id===actor).position,tiles=new Set(s.hexGrid.tiles.map(hexKey));
    const blocked=new Set(s.hexUnits.filter(u=>u.id!==actor).map(u=>hexKey(u.position)));
    const queue=[start],seen=new Map([[hexKey(start),{point:start,cost:0}]]);
    for(let i=0;i<queue.length;i++) {const p=queue[i],cost=seen.get(hexKey(p)).cost;if(cost>=3)continue;
      for(const [q,r] of directions) {const n={q:p.q+q,r:p.r+r},k=hexKey(n);if(tiles.has(k)&&!blocked.has(k)&&!seen.has(k)){seen.set(k,{point:n,cost:cost+1});queue.push(n);}}
    }
    return [...seen.values()].filter(x=>x.cost>0).sort((a,b)=>dist(a.point,target)-dist(b.point,target)||a.cost-b.cost||a.point.q-b.point.q||a.point.r-b.point.r)[0]?.point;
  }
  function win() {
    if(visibleState().phase==='preparation')click('#start-battle');
    for(let i=0;i<180;i++) {
      const s=state();if(s.battlePreparation.phase==='completed')return s;
      const actor=visibleState().actingUnitId;if(!actor)throw new Error('No command window');
      const enemy=s.combat.units.find(u=>u.kind==='monster'),pos=s.hexUnits.find(u=>u.id===actor).position;
      let changed=false;
      if(dist(pos,enemy.position)<=(actor==='ormus'?5:1)) {
        click('#skill-card-left');clickHex(enemy.position);
        changed=JSON.stringify(state().combat)!==JSON.stringify(s.combat);
        if(!changed)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      }
      if(!changed) {const d=moveTarget(s,actor,enemy.position);if(d){click('#move-command');clickHex(d);}else click('#end-turn');}
    }
    throw new Error('Real battle did not finish');
  }
  try {
    click('#inventory-command');
    for(const [name,id] of [['Korgan','korgan.hand_axe'],['Hadriel','hadriel.scepter'],['Ormus','ormus.wand']]) {
      [...document.querySelectorAll('#equipment-owner-tabs button')].find(b=>b.textContent===name).click();click(`[data-item-id="${id}"]`);click('#equipment-action');
    }
    close();click('.hero[data-character-id="korgan"]');
    const victory=clone(win());
    eq(victory.encounterProgress.rewardedCount,1,'real playthrough produces one reward receipt');
    eq(victory.encounterProgress.drops[0].item.baseCode,'ssd','real reward uses catalog short-sword code');
    eq(victory.roster.slice(0,3).map(h=>h.experience),[8,8,8],'EXP awarded once');
    eq(victory.combat.scheduler.queue,[],'victory fully settles pending queue');
    eq(victory.combat.commands.active,[],'victory has no active commands');

    click('#loot-toast');selectOwner('Korgan');
    const old=document.querySelector('[data-pickup="short-sword-1"]');old.click();const once=state();old.click();
    eq(state().encounterProgress,once.encounterProgress,'old pickup callback cannot duplicate receipt');
    eq(state().inventories,once.inventories,'old pickup callback cannot duplicate item');
    eq(state().roster,once.roster,'duplicate pickup cannot award EXP or heal');
    check(document.querySelector('#loot-message').textContent.includes('zebrany'),'duplicate pickup has visible reason');
    close();
    check(__rotwDebug.saveGameState(),'collected reward save succeeds');
    check(__rotwDebug.loadGameState(),'collected reward load succeeds');
    eq(state().encounterProgress.drops[0].status,'collected','collected status persists');

    restore(victory);
    const full=clone(victory), h=hero(full,'korgan'),inventory=bag(full,'korgan');
    inventory.items=Array.from({length:40},(_,i)=>({id:`fixture.filler.${i}`,canonicalId:'fixture-filler',name:'Przedmiot testowy',width:1,height:1,position:{x:i%10,y:Math.floor(i/10)}}));
    h.inventoryItemIds=inventory.items.map(i=>i.id);
    restore(full);const before=state();click('#loot-toast');selectOwner('Korgan');click('[data-pickup="short-sword-1"]');
    eq(state().inventories,before.inventories,'full backpack is unchanged');
    eq(state().encounterProgress,before.encounterProgress,'full bag leaves real item on ground');
    check(document.querySelector('#loot-message').textContent.includes('Brak miejsca'),'full bag error readable');
    selectOwner('Hadriel');click('[data-pickup="short-sword-1"]');
    eq(state().encounterProgress.drops[0].collectorId,'hadriel','another hero collects after full-bag refusal');
    check(bag(state(),'hadriel').items.some(i=>i.id==='short-sword-1'),'chosen owner receives physical item');
    eq(hero(state(),'korgan').inventoryItemIds,h.inventoryItemIds,'first full bag remains untouched');
    close();

    restore(victory);const savedBefore=state(),button=document.querySelector('#next-encounter');button.click();button.click();
    const second=state();eq(second.encounterProgress.encounterNumber,2,'double next click starts only one encounter');
    eq(second.battlePreparation.phase,'preparation','next starts in safe preparation');
    for(const k of ['roster','inventories','belts','portalScrolls','rng','weaponSets'])eq(second[k],savedBefore[k],`next preserves ${k}`);
    eq(second.encounterProgress.drops[0].status,'ground','uncollected first reward remains');
    check(second.combat.scheduler.time>=savedBefore.combat.scheduler.time,'new fight keeps monotonic clock');
    check(__rotwDebug.saveGameState(),'next encounter can be saved');check(__rotwDebug.loadGameState(),'next encounter can be loaded');
    eq(state().combat.units.find(u=>u.kind==='monster').id,'fallen-2','save restores actual current enemy');
    click('#loot-toast');check(document.querySelector('[data-pickup]').disabled,'cannot collect during preparation');close();
    click('#start-battle');const active=clone(state());check(__rotwDebug.saveGameState(),'active second encounter saves');check(__rotwDebug.loadGameState(),'active second encounter loads');eq(state().encounterProgress,active.encounterProgress,'active reload keeps receipt history');

    // Former schema: import a structurally valid v0.5.2-shaped first-victory fixture.
    restore(victory);const legacy=clone(victory);delete legacy.encounterProgress;delete legacy.encounterSchemaVersion;
    localStorage.clear();const bytes=JSON.stringify(legacy);localStorage.setItem(keys.legacyEquipment,bytes);
    check(__rotwDebug.loadGameState(),'legacy first-victory import succeeds');
    eq(localStorage.getItem(keys.legacyEquipment),bytes,'legacy save bytes untouched');
    eq(state().encounterProgress.drops[0].status,'ground','legacy marker becomes one real ground item');
    eq(state().roster,victory.roster,'legacy import grants no experience or resources');
    check(__rotwDebug.saveGameState(),'import writes only new namespace');
    eq(localStorage.getItem(keys.legacyEquipment),bytes,'saving imported game never overwrites original');

    // Strict failures must not publish partially parsed data.
    for(const [label,edit] of [
      ['future encounter schema',s=>s.encounterSchemaVersion=99],
      ['missing encounter header',s=>delete s.encounterSchemaVersion],
      ['missing encounter progress',s=>delete s.encounterProgress],
      ['duplicate reward',s=>s.encounterProgress.drops.push(clone(s.encounterProgress.drops[0]))],
      ['wrong encounter identity',s=>s.encounterProgress.encounterNumber=2],
      ['wrong base reward',s=>s.encounterProgress.drops[0].item.baseCode='hax'],
      ['ground collected twice',s=>{const d=s.encounterProgress.drops[0];bag(s,'korgan').items.push({...clone(d.item),position:{x:9,y:0}});hero(s,'korgan').inventoryItemIds.push(d.id);}],
      ['collected without real item',s=>{s.encounterProgress.drops[0].status='collected';s.encounterProgress.drops[0].collectorId='korgan';}],
      ['missing registered reward',s=>{s.encounterProgress.rewardedCount=0;s.encounterProgress.drops=[];}],
    ]) {
      restore(victory);const invalid=clone(victory);edit(invalid);localStorage.setItem(keys.current,JSON.stringify(invalid));localStorage.removeItem(keys.backup);const before=state();
      check(__rotwDebug.loadGameState()===false,`reject ${label}`);eq(state(),before,`${label} does not alter live session`);
    }
    restore(victory);const future={...clone(victory),encounterSchemaVersion:99};localStorage.setItem(keys.current,JSON.stringify(future));localStorage.setItem(keys.backup,JSON.stringify(victory));
    check(__rotwDebug.saveGameState()===false,'saving cannot overwrite future encounter schema');
    eq(localStorage.getItem(keys.current),JSON.stringify(future),'future bytes kept');
    eq(localStorage.getItem(keys.backup),JSON.stringify(victory),'future refusal keeps backup');

    // Dead hero is intentionally removed from all occupancy models, not revived by new encounter.
    const dead=clone(victory),deadId='korgan';hero(dead,deadId).resources.hp=0;hero(dead,deadId).lifeState='corpse';
    dead.hexGrid.units=dead.hexGrid.units.filter(u=>u.id!==deadId);dead.hexUnits=dead.hexUnits.filter(u=>u.id!==deadId);
    dead.battlePreparation.positions=dead.battlePreparation.positions.filter(u=>u.unitId!==deadId);
    dead.battlePreparation.heroPresence.find(h=>h.heroId===deadId).state='off-field';dead.actingUnitId='hadriel';
    restore(dead);click('#next-encounter');eq(state().encounterProgress.encounterNumber,2,'survivors can proceed after one death');
    eq(hero(state(),deadId).resources.hp,0,'next encounter does not heal fallen hero');
    check(!state().hexUnits.some(u=>u.id===deadId),'fallen hero never occupies next deployment');
    check(__rotwDebug.saveGameState(),'second preparation with a fallen hero saves');check(__rotwDebug.loadGameState(),'second preparation with a fallen hero loads');
    click('.hero[data-character-id="korgan"]');eq(visibleState().actingUnitId,'hadriel','inspecting dead hero cannot make it act');
    click('#start-battle');check(visibleState().actingUnitId!=='korgan','dead hero receives no readiness turn');

    // Several completed rewards can stay on a field and be picked after a later victory.
    restore(victory);click('#next-encounter');const victory2=clone(win());
    eq(victory2.encounterProgress.rewardedCount,2,'second real victory has second distinct reward');
    eq(victory2.encounterProgress.drops.map(d=>d.id),['short-sword-1','bm-01.loot.2'],'reward IDs are stable and unique');
    click('#loot-toast');eq(document.querySelectorAll('[data-pickup]').length,2,'loot dialog shows both old and new items');selectOwner('Ormus');
    click('[data-pickup="short-sword-1"]');click('[data-pickup="bm-01.loot.2"]');close();
    eq(state().encounterProgress.drops.map(d=>d.status),['collected','collected'],'both rewards gathered once');
    check(__rotwDebug.saveGameState(),'multiple collected receipts save');check(__rotwDebug.loadGameState(),'multiple collected receipts reload');
    eq(bag(state(),'ormus').items.filter(i=>['short-sword-1','bm-01.loot.2'].includes(i.id)).length,2,'reload retains exactly two physical items');
    return results;
  } finally {
    restore(initial);localStorage.clear();for(const [k,v] of originalStorage)localStorage.setItem(k,v);
  }
}
