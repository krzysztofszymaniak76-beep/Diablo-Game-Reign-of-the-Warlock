import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignState } from '../src/core/campaign.js';
import { hasTravelDecisions, isTravelFork, travelDecisions } from '../app/exploration-decisions.js';

test('cards appear at a fork, not on every ordinary step',()=>{
  const current={id:'a',x:0,y:0,current:true,discovered:true};
  const known={id:'b',x:1,y:0,reachable:true,discovered:true};
  const hidden={id:'c',x:0,y:1,reachable:true,discovered:false};
  assert.equal(isTravelFork('act1.blood_moor',[current,hidden],[{a:'a',b:'c'}]),false);
  assert.equal(isTravelFork('act1.blood_moor',[current,known,hidden],[{a:'a',b:'b'},{a:'a',b:'c'}]),false,
    'a known return path and one forward path are a corridor');
  assert.equal(isTravelFork('act1.blood_moor',[{...current,exits:[{targetAreaId:'act1.den_of_evil'}]},known,hidden],
    [{a:'a',b:'b'},{a:'a',b:'c'}]),true,'a discovered entrance is an important decision');
  assert.equal(isTravelFork('act1.blood_moor',[current,{...known,discovered:false},hidden],[{a:'a',b:'b'},{a:'a',b:'c'}]),true);
  assert.equal(isTravelFork('act1.den_of_evil',[current,known,hidden,{id:'d',x:-1,y:0,reachable:true,discovered:true}],
    [{a:'a',b:'b'},{a:'a',b:'c'},{a:'a',b:'d'}]),true);
  assert.equal(isTravelFork('act1.cold_plains',[current,{...known,discovered:false},hidden],[{a:'a',b:'b'},{a:'a',b:'c'}]),false);
});

test('travel decisions stay limited to the two prototype locations',()=>{
  assert.equal(hasTravelDecisions('act1.blood_moor'),true);
  assert.equal(hasTravelDecisions('act1.den_of_evil'),true);
  assert.deepEqual(travelDecisions('act1.cold_plains',[]),[]);
});
test('cards are deterministic, non-mutating and exactly adjacent across 100 worlds',()=>{
  for(let seed=1;seed<=100;seed++)for(const areaId of ['act1.blood_moor','act1.den_of_evil']) {
    const c=new CampaignState({worldSeed:seed});c.travelAct1('act1.blood_moor');if(areaId==='act1.den_of_evil')c.travelAct1(areaId);
    const {sectors}=c.act1ExplorationView(),before=JSON.stringify(sectors),save=JSON.stringify(c.toJSON());
    const cards=travelDecisions(areaId,sectors);
    assert.deepEqual(cards.map(c=>c.sectorId),sectors.filter(s=>s.reachable).map(s=>s.id));
    assert.deepEqual(cards,travelDecisions(areaId,sectors));
    assert.equal(JSON.stringify(sectors),before);assert.equal(JSON.stringify(c.toJSON()),save);
    for(const card of cards) {
      const sector=sectors.find(s=>s.id===card.sectorId);
      if(!sector.discovered) assert.equal(card.detail,'Nieodkryty obszar');
      else assert.notEqual(card.detail,'Nieodkryty obszar');
    }
  }
});
test('hidden content is not named by travel cards, even with accidental private data',()=>{
  const sectors=[{id:'a',x:0,y:0,current:true},{id:'b',x:1,y:0,reachable:true,discovered:false,exits:[{targetAreaId:'act1.den_of_evil'}],encounter:{status:'available'}}];
  const [card]=travelDecisions('act1.blood_moor',sectors);
  assert.equal(card.title,'Nieodkryty obszar');assert.equal(card.direction,'Wschód');assert.equal(card.detail,'Nieodkryty obszar');
  sectors[1].discovered=true;
  assert.equal(travelDecisions('act1.blood_moor',sectors)[0].title,'Wejście do Siedliska Zła');
});
test('combat locked public view produces no travel actions',()=>{
  const c=new CampaignState({worldSeed:1});c.travelAct1('act1.blood_moor');
  const {sectors}=c.act1ExplorationView();
  assert.deepEqual(travelDecisions('act1.blood_moor',sectors.map(s=>({...s,reachable:false}))),[]);
});

test('a card joins only a short visible corridor and stops before fog, encounters, exits and branches',()=>{
  const current={id:'a',x:0,y:0,current:true,discovered:true,exits:[]};
  const known=(id,x,{reachable=false,encounter=null,exits=[]}={})=>({id,x,y:0,discovered:true,reachable,encounter,exits});
  const edges=[{a:'a',b:'b'},{a:'b',b:'c'},{a:'c',b:'d'}];
  const corridor=[current,known('b',1,{reachable:true}),known('c',2),known('d',3)];
  const [card]=travelDecisions('act1.blood_moor',corridor,edges);
  assert.deepEqual(card.routeSectorIds,['b','c','d']);
  assert.equal(card.stopReason,'distance');
  assert.equal(card.segmentDetail,'Krótki odcinek: 3 obszary');

  const encounter=[current,known('b',1,{reachable:true}),known('c',2,{encounter:{status:'available'}}),known('d',3)];
  assert.deepEqual(travelDecisions('act1.blood_moor',encounter,edges)[0].routeSectorIds,['b','c']);
  assert.equal(travelDecisions('act1.blood_moor',encounter,edges)[0].stopReason,'encounter');

  const exit=[current,known('b',1,{reachable:true}),known('c',2,{exits:[{targetAreaId:'act1.den_of_evil'}]}),known('d',3)];
  assert.deepEqual(travelDecisions('act1.blood_moor',exit,edges)[0].routeSectorIds,['b','c']);
  assert.equal(travelDecisions('act1.blood_moor',exit,edges)[0].stopReason,'exit');

  const fog=[current,{id:'b',x:1,y:0,reachable:true,discovered:false,encounter:{status:'available'},exits:[{targetAreaId:'act1.den_of_evil'}]},known('c',2),known('d',3)];
  const [fogCard]=travelDecisions('act1.blood_moor',fog,edges);
  assert.deepEqual(fogCard.routeSectorIds,['b']);
  assert.equal(fogCard.stopReason,'fog');
  assert.equal(fogCard.title,'Nieodkryty obszar');

  const branch=[current,known('b',1,{reachable:true}),known('c',2),known('d',3),known('e',2)];
  const [branchCard]=travelDecisions('act1.blood_moor',branch,[...edges,{a:'b',b:'e'}]);
  assert.deepEqual(branchCard.routeSectorIds,['b']);
  assert.equal(branchCard.stopReason,'branch');

  const hiddenForward=[current,known('b',1,{reachable:true}),{id:'c',x:2,y:0,discovered:false,exits:[],encounter:null}];
  const [hiddenForwardCard]=travelDecisions('act1.blood_moor',hiddenForward,[{a:'a',b:'b'},{a:'b',b:'c'}]);
  assert.deepEqual(hiddenForwardCard.routeSectorIds,['b']);
  assert.equal(hiddenForwardCard.stopReason,'fog');

  const hiddenBranch=[current,known('b',1,{reachable:true}),known('c',2),{id:'hidden',x:1,y:1,discovered:false,exits:[],encounter:null}];
  const [hiddenBranchCard]=travelDecisions('act1.blood_moor',hiddenBranch,[{a:'a',b:'b'},{a:'b',b:'c'},{a:'b',b:'hidden'}]);
  assert.deepEqual(hiddenBranchCard.routeSectorIds,['b']);
  assert.equal(hiddenBranchCard.stopReason,'branch');
  assert.equal(JSON.stringify(hiddenBranchCard).includes('hidden'),false,'a hidden branch does not leak through the card data');
});
