import { CampaignState } from '../src/core/campaign.js';
import { generateAreaMap, shortestSectorPath } from '../src/core/exploration.js';

// Isolated browser profile only. Used across a real document reload by the runner.
export function landscapeReloadProbe(areaId,prepare=false) {
  const debug=globalThis.__rotwDebug;
  if(prepare) {
    const save=structuredClone(debug.snapshot().save),campaign=new CampaignState({worldSeed:7007});
    campaign.travelAct1('act1.blood_moor');
    if(areaId==='act1.den_of_evil')campaign.travelAct1(areaId);
    campaign.act1.exploration.areaStates[areaId].discoveredSectorIds=campaign.act1ExplorationMap().sectors.map(s=>s.id).sort();
    save.campaignSchemaVersion=2;save.campaign=campaign.toJSON();save.loot=null;
    localStorage.clear();localStorage.setItem(debug.storageKeys.current,JSON.stringify(save));
  }
  if(!debug.loadGameState())throw new Error('Reload probe could not load its save');
  if(document.querySelector('#panel-layer')?.getAttribute('aria-hidden')==='false')document.querySelector('#close-panel').click();
  document.querySelector('[data-open-panel="map"]').click();
  return {campaign:debug.snapshot().save.campaign,art:document.querySelector('.landscape-art')?.innerHTML};
}

export async function runExplorationBrowserChecks() {
  const debug=globalThis.__rotwDebug;if(!debug)throw new Error('Game is not ready');
  const checks=[];const check=(condition,label)=>{if(!condition)throw new Error(`${label}: ${document.querySelector('#game-toast')?.textContent??''}`);checks.push(label);};
  const equal=(a,b,label)=>check(JSON.stringify(a)===JSON.stringify(b),label);
  const state=()=>debug.snapshot().save;
  const original=structuredClone(state());
  const storage=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).map(key=>[key,localStorage.getItem(key)]);
  const click=selector=>{const element=document.querySelector(selector);if(!element||element.disabled)throw new Error(`Missing/disabled ${selector}`);element.click();};
  const close=()=>{if(document.querySelector('#panel-layer')?.getAttribute('aria-hidden')==='false')click('#close-panel');};
  const openMap=()=>{close();click('[data-open-panel="map"]');};
  const currentMap=()=>{const s=state();return generateAreaMap({worldSeed:s.campaign.worldSeed,areaId:s.campaign.act1.currentAreaId,difficulty:s.campaign.difficulty,generatorVersion:s.campaign.act1.exploration.generatorVersion});};
  const clickSector=id=>{if(document.querySelector('#game-panel.sanctuary-map')){click(`[data-travel-sector="${id}"]`);return;}const element=document.querySelector(`[data-sector-id="${id}"]`);if(!element)throw new Error(`Sector not visible: ${id}`);element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));};
  const walk=id=>{
    // A landscape card can consume a short visible road segment.  Recalculate
    // after every click instead of assuming that a card always means one tile.
    for(let guard=0;guard<160;guard++) {
      const s=state();if(s.campaign.act1.exploration.currentSectorId===id)return;
      openMap();const now=state(),path=shortestSectorPath(currentMap(),now.campaign.act1.exploration.currentSectorId,id);
      if(!path||path.length<2)throw new Error(`No path to ${id}`);
      const before=now.campaign.act1.exploration;clickSector(path[1]);
      if(state().campaign.act1.exploration.currentSectorId===before.currentSectorId)throw new Error(`Travel card did not advance toward ${id}`);
    }
    throw new Error(`Travel guard exceeded for ${id}`);
  };
  const evidence=async name=>{if(typeof window.captureAct1Evidence!=='function')return;window.captureAct1Evidence(name);const until=Date.now()+15000;while(window.__act1CaptureDone!==name){if(Date.now()>until)throw new Error(`Screenshot timeout ${name}`);await new Promise(resolve=>setTimeout(resolve,20));}};
  const installCampaign=campaign=>{
    const save=structuredClone(original);save.campaignSchemaVersion=2;save.campaign=campaign.toJSON();save.loot=null;
    localStorage.clear();localStorage.setItem(debug.storageKeys.current,JSON.stringify(save));
    if(!debug.loadGameState())throw new Error(`Evidence campaign could not load: ${document.querySelector('#game-toast')?.textContent}`);
  };
  const visitLegacyRoute=(campaign,areaId)=>{
    if(areaId==='act1.rogue_encampment')return;
    campaign.travelAct1('act1.blood_moor');
    if(areaId==='act1.den_of_evil')campaign.travelAct1('act1.den_of_evil');
  };
  const fixture=(seed,areaId,{full=false,sideEntrance=false,currentSectorId=null}={})=>{
    const campaign=new CampaignState({worldSeed:seed});visitLegacyRoute(campaign,areaId);
    const map=campaign.act1ExplorationMap(),areaState=campaign.act1.exploration.areaStates[areaId];
    if(full)areaState.discoveredSectorIds=map.sectors.map(sector=>sector.id).sort();
    else {
      const graph=new Map(map.sectors.map(sector=>[sector.id,[]]));for(const edge of map.edges){graph.get(edge.a).push(edge.b);graph.get(edge.b).push(edge.a);}
      const seen=new Set([map.startSectorId]),queue=[map.startSectorId];while(queue.length&&seen.size<16){for(const next of graph.get(queue.shift()))if(!seen.has(next)&&seen.size<16){seen.add(next);queue.push(next);}}
      areaState.discoveredSectorIds=[...seen].sort();
    }
    if(currentSectorId){campaign.act1.exploration.currentSectorId=currentSectorId;if(!areaState.discoveredSectorIds.includes(currentSectorId))areaState.discoveredSectorIds.push(currentSectorId);}
    else if(sideEntrance){const exit=map.exits.find(item=>item.targetAreaId==='act1.den_of_evil');campaign.act1.exploration.currentSectorId=exit.sectorId;if(!areaState.discoveredSectorIds.includes(exit.sectorId))areaState.discoveredSectorIds.push(exit.sectorId);}
    else campaign.act1.exploration.currentSectorId=map.startSectorId;
    installCampaign(CampaignState.restoreAct1(campaign.toJSON()));openMap();click(full?'#map-fit':'#map-center');return map;
  };
  const hiddenFrontierFixture=kind=>{
    const campaign=new CampaignState({worldSeed:7007});campaign.travelAct1('act1.blood_moor');
    const map=campaign.act1ExplorationMap();
    const targetId=kind==='encounter'?map.encounters[0].sectorId:map.exits.find(exit=>exit.targetAreaId==='act1.den_of_evil').sectorId;
    const occupied=new Set([...map.encounters.map(item=>item.sectorId),...map.exits.map(item=>item.sectorId)]);
    const approach=map.edges.flatMap(edge=>edge.a===targetId?[edge.b]:edge.b===targetId?[edge.a]:[]).find(id=>!occupied.has(id));
    if(!approach)throw new Error(`No clean approach to hidden ${kind}`);
    const areaState=campaign.act1.exploration.areaStates['act1.blood_moor'];
    campaign.act1.exploration.currentSectorId=approach;areaState.discoveredSectorIds=[approach];
    installCampaign(CampaignState.restoreAct1(campaign.toJSON()));openMap();return targetId;
  };
  try {
    openMap();
    check(document.querySelectorAll('.exploration-sector.discovered').length===1,'fresh map reveals only the entry sector');
    check(document.querySelectorAll('.exploration-sector.fog.reachable').length>0,'fresh map shows neutral adjacent directions without content');
    check(!document.querySelector('.exploration-sector.fog .sector-icon'),'fog does not expose encounters, exits or points');
    const beforeDrag=structuredClone(state().campaign.act1.exploration),svg=document.querySelector('#exploration-map'),current=document.querySelector('.exploration-sector.current');
    current.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:77,button:0,clientX:400,clientY:300}));
    svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:77,button:0,clientX:470,clientY:345}));
    svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:77,button:0,clientX:470,clientY:345}));
    equal(state().campaign.act1.exploration,beforeDrag,'dragging the map does not move the party');
    const reachable=document.querySelector('.exploration-sector.reachable'),sequence=state().campaign.act1.exploration.movementSequence;
    reachable.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
    reachable.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
    check(state().campaign.act1.exploration.movementSequence===sequence+1,'rapid repeated click advances exactly one sector');
    const moved=structuredClone(state().campaign.act1.exploration);
    check(debug.saveGameState()&&debug.loadGameState(),'exploration save/load succeeds through native controls');
    equal(state().campaign.act1.exploration,moved,'save/load preserves current and discovered sectors exactly');

    openMap();const campExit=currentMap().exits.find(exit=>exit.targetAreaId==='act1.blood_moor');walk(campExit.sectorId);click('[data-area-exit="act1.blood_moor"]');
    check(state().campaign.act1.currentAreaId==='act1.blood_moor','actual sector traversal reaches Blood Moor');
    const blood=currentMap(),first=blood.encounters[0];walk(first.sectorId);
    check(state().campaign.act1.exploration.activeBattle?.sectorId===first.sectorId,'entering an encounter sector binds the battle to that exact sector');
    check(state().battlePreparation.phase==='preparation','encounter sector launches the existing preparation phase');
    openMap();
    check(document.querySelectorAll('[data-travel-sector]').length===0,'travel decisions are unavailable during combat');

    const hiddenEncounter=hiddenFrontierFixture('encounter'),beforeHiddenEncounter=state().campaign.act1.exploration;
    const hiddenEncounterCard=document.querySelector(`[data-travel-sector="${hiddenEncounter}"]`);
    check(hiddenEncounterCard?.dataset.travelSegmentLength==='1','a hidden encounter is the terminal first step of its card');
    clickSector(hiddenEncounter);
    check(state().campaign.act1.exploration.currentSectorId===hiddenEncounter&&state().campaign.act1.exploration.activeBattle?.sectorId===hiddenEncounter,'a travel segment stops and launches the first hidden encounter it reaches');
    check(state().campaign.act1.exploration.areaStates['act1.blood_moor'].discoveredSectorIds.length===beforeHiddenEncounter.areaStates['act1.blood_moor'].discoveredSectorIds.length+1,'hidden encounter travel reveals no sector beyond the encounter');

    const hiddenExit=hiddenFrontierFixture('exit'),beforeHiddenExit=state().campaign.act1.exploration;
    const hiddenExitCard=document.querySelector(`[data-travel-sector="${hiddenExit}"]`);
    check(hiddenExitCard?.dataset.travelSegmentLength==='1','a hidden exit is the terminal first step of its card');
    clickSector(hiddenExit);
    check(state().campaign.act1.exploration.currentSectorId===hiddenExit&&state().campaign.act1.currentAreaId==='act1.blood_moor'&&!state().campaign.act1.exploration.activeBattle,'a travel segment stops at a hidden exit without taking it automatically');
    check(document.querySelector('[data-area-exit="act1.den_of_evil"]')&&!document.querySelector('[data-area-exit="act1.den_of_evil"]').disabled,'the newly discovered exit requires its separate existing action');
    check(state().campaign.act1.exploration.areaStates['act1.blood_moor'].discoveredSectorIds.length===beforeHiddenExit.areaStates['act1.blood_moor'].discoveredSectorIds.length+1,'hidden exit travel reveals no sector beyond the exit');

    // Prototype evidence: fresh world, reveal only by actual adjacent travel cards.
    const prototype=new CampaignState({worldSeed:1});prototype.travelAct1('act1.blood_moor');
    installCampaign(prototype);openMap();
    check(document.querySelectorAll('[data-travel-sector]').length>0,'fresh Moor offers adjacent travel cards');
    check(!document.querySelector('[data-area-exit="act1.den_of_evil"]'),'undiscovered entrance cannot be entered');
    const staticMapState=structuredClone(state().campaign);
    document.querySelector('.landscape-sector.reachable').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    equal(state().campaign,staticMapState,'clicking the terrain cannot move the party in the prototype');
    const entrance=currentMap().exits.find(e=>e.targetAreaId==='act1.den_of_evil');
    let cardJourney=0;
    while(state().campaign.act1.exploration.currentSectorId!==entrance.sectorId) {
      if(cardJourney++>160)throw new Error('Travel-card route to the Den exceeded its safety guard');
      const before=state().campaign.act1.exploration,view=CampaignState.restoreAct1(state().campaign).act1ExplorationView();
      const route=shortestSectorPath(currentMap(),before.currentSectorId,entrance.sectorId),step=route?.[1];
      if(!step)throw new Error('No next legal sector on the route to the Den');
      equal([...document.querySelectorAll('[data-travel-sector]')].map(e=>e.dataset.travelSector).sort(),view.sectors.filter(s=>s.reachable).map(s=>s.id).sort(),'cards expose exactly the legal adjacent choices');
      const oldCard=document.querySelector(`[data-travel-sector="${step}"]`);clickSector(step);
      const after=state().campaign.act1.exploration;
      if(cardJourney===1) {const sequence=after.movementSequence;oldCard.click();check(state().campaign.act1.exploration.movementSequence===sequence,'stale double activation does not perform a second journey');}
      const newlyDiscovered=after.areaStates['act1.blood_moor'].discoveredSectorIds.filter(id=>!before.areaStates['act1.blood_moor'].discoveredSectorIds.includes(id));
      check(after.currentSectorId!==before.currentSectorId&&newlyDiscovered.length<=1,'a travel card advances only through a known segment and at most one fog frontier');
      if(cardJourney===5)await evidence('prototype-blood-moor');
    }
    check(Boolean(document.querySelector('[data-area-exit="act1.den_of_evil"]'))&&document.querySelectorAll('[data-travel-sector]').length>0,'discovered entrance offers both entry and continuation on the Moor');
    await evidence('prototype-den-entrance');
    const discoveredMoor=structuredClone(state().campaign.act1.exploration.areaStates['act1.blood_moor'].discoveredSectorIds);
    click('[data-area-exit="act1.den_of_evil"]');
    check(state().campaign.act1.currentAreaId==='act1.den_of_evil','prototype enters the separate cave map');
    const denStart=state().campaign.act1.exploration.currentSectorId;
    const caveMap=currentMap();
    for(let i=0;i<4;i++) {
      const publicView=CampaignState.restoreAct1(state().campaign).act1ExplorationView();
      const next=publicView.sectors.find(s=>s.reachable&&!s.discovered&&!caveMap.encounters.some(e=>e.sectorId===s.id));
      if(!next)break;clickSector(next.id);
    }
    await evidence('prototype-den-interior');
    const savedPrototype=structuredClone(state().campaign);
    check(debug.saveGameState()&&debug.loadGameState(),'decision exploration saves and loads through existing controls');openMap();
    equal(state().campaign,savedPrototype,'position and discoveries survive decision prototype save/load');
    walk(denStart);click('[data-area-exit="act1.blood_moor"]');
    equal(state().campaign.act1.exploration.areaStates['act1.blood_moor'].discoveredSectorIds,discoveredMoor,'return from the cave preserves Moor discoveries');
    walk(currentMap().exits.find(e=>e.targetAreaId==='act1.cold_plains').sectorId);
    check(!document.querySelector('[data-area-exit="act1.cold_plains"]').disabled,'leaving the cave unfinished does not block the main route');

    installCampaign(prototype);openMap();walk(entrance.sectorId);
    walk(currentMap().exits.find(e=>e.targetAreaId==='act1.cold_plains').sectorId);
    check(!state().campaign.act1.visitedAreaIds.includes('act1.den_of_evil'),'player can discover then skip the entrance entirely');

    // Fresh deterministic world; no completed fights or quests are injected.
    const optionalCampaign=new CampaignState({worldSeed:1});optionalCampaign.travelAct1('act1.blood_moor');
    installCampaign(optionalCampaign);openMap();
    const onward=currentMap().exits.find(e=>e.targetAreaId==='act1.cold_plains');walk(onward.sectorId);
    check(!state().campaign.act1.visitedAreaIds.includes('act1.den_of_evil'),'onward path does not require visiting the Den');
    check(!document.querySelector('[data-area-exit="act1.cold_plains"]').disabled,'onward exit is enabled before completing the Den');
    click('[data-area-exit="act1.cold_plains"]');
    check(state().campaign.act1.currentAreaId==='act1.cold_plains','actual UI can skip the Den and continue onward');
    check(!document.querySelector('#game-panel').classList.contains('sanctuary-map'),'new frame does not leak into later locations');
    check(document.querySelector('#panel-title').textContent==='MAPA EKSPLORACJI','leaving the scoped locations restores the original map heading');

    for(const file of ['blood-moor-ground','den-earth','den-entrance','moor-oak']) {
      const image=new Image();image.src=`/app/assets/exploration/${file}-v059.png`;await image.decode();
      check(image.naturalWidth>0,`landscape asset ${file} is available in the actual build`);
    }
    fixture(1001,'act1.blood_moor',{full:false});
    check(document.querySelector('#game-panel').classList.contains('sanctuary-map'),'Blood Moor receives the scoped stone map frame');
    check(document.querySelector('#panel-title').textContent==='Krwawe Wrzosowisko','map header uses the Polish location name');
    for(const asset of ['map-stoneframe','map-relief','map-flourish']) {
      const image=new Image();image.src=`/app/assets/exploration/${asset}-v0510.svg`;await image.decode();
      check(image.naturalWidth>0,`carved map frame asset loads: ${asset}`);
    }
    const mapBox=document.querySelector('#exploration-map').getBoundingClientRect();
    check(mapBox.width>600&&mapBox.height>300,'heavy frame retains a usable exploration viewport');
    for(const file of ['map-ironstone-v0512.png','map-ironframe-v0512.png','map-seal-v0512.svg']) {
      const image=new Image();image.src='/app/assets/exploration/'+file;await image.decode();
      check(image.naturalWidth>0,`iron UI asset loads: ${file}`);
    }
    check(getComputedStyle(document.querySelector('#game-panel')).borderImageSource.includes('map-ironframe-v0512.png'),'actual map uses the worn stone frame');
    const frameStyle=getComputedStyle(document.querySelector('#game-panel'));
    check(frameStyle.getPropertyValue('--map-theme-id').trim()==='act1-exterior','Moor selects the exterior theme');
    check(frameStyle.overflow==='visible','sculptures are not clipped by the outer panel');
    for(const file of ['map-sentinel-v0513.png','map-crest-v0513.png','map-caveframe-v0513.png']) {
      const image=new Image();image.src='/app/assets/exploration/'+file;await image.decode();
      check(image.naturalWidth>0,`themed frame asset loads: ${file}`);
    }
    const crest=document.querySelector('.panel-sigil').getBoundingClientRect(),title=document.querySelector('#panel-title').getBoundingClientRect();
    check(crest.bottom<title.top&&crest.top>=0,'central ornament stays above the title and within viewport');
    for(const pseudo of ['::before','::after']) {
      const decoration=getComputedStyle(document.querySelector('.game-panel-header'),pseudo);
      check(decoration.pointerEvents==='none'&&Math.abs(parseFloat(decoration.width)/parseFloat(decoration.height)-2/3)<.001,'corner uses a fixed proportional box and cannot intercept clicks');
    }
    check(getComputedStyle(document.querySelector('.game-panel-header'),'::before').pointerEvents==='none','header decoration cannot intercept input');
    for(const id of ['map-zoom-in','map-zoom-out','map-fit','map-center','close-panel']) {
      const button=document.getElementById(id),r=button.getBoundingClientRect();
      check(r.width>=24&&r.height>=24&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button,`iron UI control is unobstructed: ${id}`);
    }
    for(const card of document.querySelectorAll('[data-travel-sector]')) {
      const r=card.getBoundingClientRect();
      check(r.width>=100&&r.height>=44&&r.bottom<innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-travel-sector]')===card,'decision card is visible and directly clickable');
    }
    check(Boolean(document.querySelector('[data-landscape="moor"]')),'Blood Moor renders continuous meadow terrain');
    check(!document.querySelector('.landscape-sector .sector-ground'),'Blood Moor has no individual board tile outlines');
    check(!document.querySelector('[data-landmark="den-entrance"]'),'hidden Den entrance is not leaked through fog');
    const visibleTargets=[...document.querySelectorAll('.landscape-sector.reachable')].filter(element=>{
      const r=element.querySelector('.land-hit').getBoundingClientRect(),view=document.querySelector('#exploration-map').getBoundingClientRect();
      return r.x+r.width/2>view.left&&r.x+r.width/2<view.right&&r.y+r.height/2>view.top&&r.y+r.height/2<view.bottom;
    });
    check(visibleTargets.length>0&&visibleTargets.every(element=>{
      const r=element.querySelector('.land-hit').getBoundingClientRect();
      return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-sector-id]')===element;
    }),'rendered reachable paths hit their own sector, not a decoration');
    await evidence('blood-moor-partial-fog');
    const mapBeforeSave=document.querySelector('.landscape-art').innerHTML;
    const exploredBeforeSave=structuredClone(state().campaign);
    check(debug.saveGameState()&&debug.loadGameState(),'landscape campaign saves and loads through actual handlers');openMap();
    equal(state().campaign,exploredBeforeSave,'visual refresh preserves the v0.5.8 exploration save exactly');
    check(document.querySelector('.landscape-art').innerHTML===mapBeforeSave,'terrain and decoration are identical after save/load');
    const seedOne=fixture(1001,'act1.blood_moor',{full:true});await evidence('blood-moor-seed-1001-full');
    const seedTwo=fixture(2002,'act1.blood_moor',{full:true});await evidence('blood-moor-seed-2002-full');
    check(seedOne.layoutSignature!==seedTwo.layoutSignature,'two seeds render structurally different Blood Moor layouts');
    fixture(1001,'act1.blood_moor',{full:true,currentSectorId:'sector-003'});
    const longCard=[...document.querySelectorAll('[data-travel-sector]')].find(card=>Number(card.dataset.travelSegmentLength)>1);
    check(Boolean(longCard)&&Number(longCard.dataset.travelSegmentLength)<=3,'a known corridor is offered as a bounded multi-sector travel segment');
    const routeKey=longCard.querySelector('.travel-direction').textContent.split('·')[0].trim();
    const routePreview=document.querySelector(`[data-travel-route-preview="${routeKey}"]`);
    longCard.dispatchEvent(new MouseEvent('mouseenter'));
    check(routePreview?.classList.contains('is-route-preview-active')&&routePreview.getTotalLength()>40,'hovering a legal card highlights its full visible road segment, not only the endpoint');
    await evidence('travel-route-highlight');
    longCard.dispatchEvent(new MouseEvent('mouseleave'));
    check(!routePreview.classList.contains('is-route-preview-active'),'leaving a card removes the route preview');
    longCard.focus({preventScroll:true});
    check(routePreview.classList.contains('is-route-preview-active'),'keyboard focus uses the same route preview');
    longCard.blur();
    fixture(3003,'act1.blood_moor',{full:true,sideEntrance:true});
    check(Boolean(document.querySelector('[data-area-exit="act1.den_of_evil"]')),'revealed Blood Moor shows its side entrance only at the correct sector');
    check(document.querySelector('[data-area-exit="act1.den_of_evil"]').textContent.includes('Siedlisko Zła'),'entrance action has the correct Polish name');
    await evidence('blood-moor-side-entrance');
    click('#map-center');await evidence('den-entrance-detail');
    click('[data-area-exit="act1.den_of_evil"]');
    check(state().campaign.act1.currentAreaId==='act1.den_of_evil','actual entrance action reaches the Den');
    const returning=currentMap().exits.find(e=>e.targetAreaId==='act1.blood_moor');walk(returning.sectorId);click('[data-area-exit="act1.blood_moor"]');
    check(state().campaign.act1.currentAreaId==='act1.blood_moor','actual Den exit returns to Blood Moor');
    const den=fixture(4004,'act1.den_of_evil',{full:true});await evidence('den-of-evil-dungeon-full');
    check(den.profile==='cave'&&den.sectors.length>=35,'dungeon evidence uses the cave profile and requested large-map scale');
    check(Boolean(document.querySelector('[data-landscape="den"]')),'Den uses natural rock chambers instead of the meadow profile');
    check(document.querySelector('#panel-title').textContent==='Siedlisko Zła','Den header uses the corrected Polish name');
    const caveStyle=getComputedStyle(document.querySelector('#game-panel'));
    check(caveStyle.getPropertyValue('--map-theme-id').trim()==='act1-cave'&&caveStyle.borderImageSource.includes('map-caveframe-v0513.png'),'Den selects the separate rocky underground frame');
    const scrollPanel=document.querySelector('.exploration-info'),copy=scrollPanel.querySelector('.map-location-copy'),oldCopy=copy.textContent;
    const campaignBeforeStress=structuredClone(state().campaign);
    copy.textContent=Array(16).fill(oldCopy).join(' ');
    check(scrollPanel.scrollHeight>scrollPanel.clientHeight&&getComputedStyle(scrollPanel).overflowY==='auto','long right-panel descriptions scroll instead of breaking the map');
    scrollPanel.scrollTop=scrollPanel.scrollHeight;
    check(scrollPanel.scrollTop>0,'long right-panel description remains scrollable');
    copy.textContent=oldCopy;scrollPanel.scrollTop=0;
    equal(state().campaign,campaignBeforeStress,'description layout stress never changes campaign state');
    const keyboardCard=document.querySelector('[data-travel-sector]');keyboardCard.focus({preventScroll:true});
    await new Promise(resolve=>setTimeout(resolve,300));
    check(document.activeElement===keyboardCard&&keyboardCard.matches(':focus')&&getComputedStyle(keyboardCard).boxShadow.includes('rgb(210, 179, 137)'),'travel card has a visible keyboard focus state');keyboardCard.blur();
    check(!/Jaskinia Zła|Jaskinię Zła|Jaskini Zła/i.test(document.querySelector('#game-panel').textContent),'map contains no obsolete Den name');
    check(!document.querySelector('.landscape-sector rect'),'Den has no rectangular floor tiles');
    click('#map-center');await evidence('den-interior-detail');
    await evidence('map-frame');
    const denBeforeSave=document.querySelector('.landscape-art').innerHTML;
    check(debug.saveGameState()&&debug.loadGameState(),'Den landscape saves and loads');openMap();
    check(document.querySelector('.landscape-art').innerHTML===denBeforeSave,'Den walls, floor and decorations remain identical after reload');
    close();click('[data-open-panel="quests"]');
    check(!document.querySelector('#game-panel').classList.contains('sanctuary-map'),'map styling is removed when the quest panel opens');
    check(document.querySelector('#panel-body').textContent.includes('Siedlisko Zła')&&!/Jaskini[aęy]?/i.test(document.querySelector('#panel-body').textContent),'quest panel uses Siedlisko Zła throughout');
    return {passed:checks.length,checks,screenshots:['prototype-blood-moor','prototype-den-entrance','prototype-den-interior','blood-moor-partial-fog','blood-moor-seed-1001-full','blood-moor-seed-2002-full','blood-moor-side-entrance','den-of-evil-dungeon-full','den-entrance-detail','den-interior-detail','map-frame']};
  } finally {
    close();localStorage.clear();localStorage.setItem(debug.storageKeys.current,JSON.stringify(original));debug.loadGameState();
    localStorage.clear();for(const [key,value] of storage)localStorage.setItem(key,value);
  }
}
