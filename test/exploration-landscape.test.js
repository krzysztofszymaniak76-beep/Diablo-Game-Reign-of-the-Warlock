import test from 'node:test';
import assert from 'node:assert/strict';
import { renderExplorationLandscape, hasLandscape } from '../app/exploration-landscape.js';
import { generateAreaMap } from '../src/core/exploration.js';
import { ACT1_EXPLORATION_AREAS } from '../data/act1-exploration.v058.js';

const samples={
  cave:'act1.den_of_evil', crypt:'act1.crypt', tower:'act1.forgotten_tower',
  jail:'act1.jail_1', monastery:'act1.monastery_gate', catacombs:'act1.catacombs_1',
};

test('every Act I cave, cellar, jail, crypt and monastery uses natural rendered terrain instead of sector tiles',()=>{
  for(const [profile,areaId] of Object.entries(samples)) {
    const area=ACT1_EXPLORATION_AREAS[areaId],map=generateAreaMap({worldSeed:4402,areaId});
    const sectors=map.sectors.map(sector=>({...sector,discovered:true,visible:true,current:sector.id===map.startSectorId,
      reachable:false,encounter:null,exits:map.exits.filter(exit=>exit.sectorId===sector.id),
      points:map.points.filter(point=>point.sectorId===sector.id)}));
    assert.equal(area.profile,profile);
    assert.equal(hasLandscape(areaId),true,`${areaId} must select the terrain renderer`);
    const rendered=renderExplorationLandscape({map,sectors});
    assert.ok(rendered?.markup.includes(`data-landscape="${profile}"`),`${areaId} must declare its visual profile`);
    assert.ok(rendered.markup.includes('landscape-sector'),`${areaId} must retain clickable sector targets`);
    assert.ok(rendered.defs.includes('land-wall')&&rendered.markup.includes('land-ground'),`${areaId} needs terrain and wall rendering`);
    assert.equal(rendered.markup.includes('sector-ground'),false,`${areaId} must not expose the technical tile view`);
    assert.equal(rendered.markup.includes('<rect class="sector-ground"'),false);
  }
});
