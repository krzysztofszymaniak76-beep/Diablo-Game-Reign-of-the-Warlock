import test from 'node:test';
import assert from 'node:assert/strict';
import {renderExplorationLandscape} from '../app/exploration-landscape.js';

const moorMap={
  areaId:'act1.blood_moor', layoutSignature:'visibility-test',
  bounds:{minX:0,maxX:2,minY:0,maxY:0},
  edges:[{a:'sector-001',b:'sector-002',kind:'path'},{a:'sector-002',b:'sector-003',kind:'path'}],
};
const baseSector=(id,x)=>({id,x,y:0,variant:0,current:false,reachable:false,
  discovered:false,visible:false,encounter:null,points:[],exits:[]});

test('landscape keeps hidden frontier black and strips undiscovered content and sector ID from DOM',()=>{
  const current={...baseSector('sector-001',0),current:true,discovered:true,visible:true};
  const remembered={...baseSector('sector-002',1),discovered:true,reachable:true,visible:false,
    encounter:{encounterId:'remembered-enemy',status:'available'}};
  const hidden={...baseSector('sector-003',2),reachable:true,
    encounter:{encounterId:'secret-enemy',status:'available'},
    exits:[{targetAreaId:'act1.den_of_evil'}],points:[{kind:'waypoint'}]};
  const {defs,markup}=renderExplorationLandscape({map:moorMap,sectors:[current,remembered,hidden]});
  assert.match(defs,/id="land-memory"/);
  assert.match(markup,/class="land-memory-shade"/);
  assert.match(markup,/data-frontier-index="0"/);
  assert.doesNotMatch(markup,/data-sector-id="sector-003"|secret-enemy|den-entrance|land-waypoint|land-direction|SIEDLISKO ZŁA/);
  assert.doesNotMatch(markup,/land-threat/);
});

test('discovered waypoint and encounter appear only when actually visible',()=>{
  const current={...baseSector('sector-001',0),current:true,discovered:true,visible:true};
  const waypoint={...baseSector('sector-002',1),discovered:true,visible:true,
    points:[{kind:'waypoint'}],encounter:{encounterId:'known-enemy',status:'available'}};
  const visible=renderExplorationLandscape({map:moorMap,sectors:[current,waypoint]});
  assert.match(visible.markup,/data-landmark="waypoint"/);
  assert.match(visible.markup,/land-threat/);
  assert.match(visible.markup,/unit-fallen-d2r-v1\.png/);
  assert.match(visible.markup,/unit-zombie-d2r-v1\.png/);
  assert.match(visible.markup,/data-sector-id="sector-002"/);
  const remembered=renderExplorationLandscape({map:moorMap,sectors:[current,{...waypoint,visible:false}]});
  assert.match(remembered.markup,/data-landmark="waypoint"/);
  assert.doesNotMatch(remembered.markup,/land-threat/);
});
