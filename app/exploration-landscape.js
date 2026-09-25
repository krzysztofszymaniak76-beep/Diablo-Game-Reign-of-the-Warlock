// Presentation only. No campaign mutation and no gameplay RNG is consumed here.
// Open-field decorations share their positions with the navigation layer.
import { explorationPoint, fieldDecorations, terrainRandomFor } from '../src/core/open-terrain.js';
import { act1Area } from '../data/act1-exploration.v058.js';
const MOOR = 'act1.blood_moor';
const DEN = 'act1.den_of_evil';
const INTERIOR_PROFILES = new Set(['cave', 'crypt', 'tower', 'jail', 'monastery', 'catacombs']);
export const hasLandscape = areaId => areaId === MOOR || INTERIOR_PROFILES.has(act1Area(areaId).profile);
export const landscapePoint = explorationPoint;
const randomFor = terrainRandomFor;
const f = n => Math.round(n * 10) / 10;
function chamber(p, variant, profile) {
  const sides = profile === 'tower' ? 10 : profile === 'crypt' || profile === 'catacombs' ? 12 : 16;
  const points = Array.from({length:sides}, (_,i) => {
    const angle = i / sides * Math.PI * 2 + (profile === 'tower' ? Math.PI / 10 : .07);
    const roughness = profile === 'cave' ? .11 : profile === 'jail' ? .045 : .065;
    const radius = 1 + roughness * Math.sin(i * 2.4 + variant * 3);
    const rx = profile === 'tower' ? 62 : profile === 'crypt' || profile === 'catacombs' ? 70 : 72;
    const ry = profile === 'tower' ? 59 : profile === 'crypt' || profile === 'catacombs' ? 47 : 52;
    return [f(p.x + Math.cos(angle) * (rx + variant * 2) * radius), f(p.y + Math.sin(angle) * (ry + variant * 1.5) * radius)];
  });
  return `M${points.map(v=>v.join(' ')).join(' L')}Z`;
}
function route(a,b,variant=0) {
  const dx=b.x-a.x,dy=b.y-a.y,bend=(variant%3-1)*27;
  return `M${a.x} ${a.y} Q${f((a.x+b.x)/2+(dy?bend:0))} ${f((a.y+b.y)/2+(dx?bend:0))} ${b.x} ${b.y}`;
}
function rock(x,y,size,rngOrRotation) {
  const r=size;
  const rotation=typeof rngOrRotation==='function'?rngOrRotation()*80-40:rngOrRotation;
  return `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rotation)})"><ellipse cy="${f(r*.35)}" rx="${f(r*1.15)}" ry="${f(r*.6)}" fill="#020301" opacity=".48"/><path d="M${-r} 0 L${f(-r*.6)} ${f(-r*.8)} ${f(r*.4)} ${-r} ${r} ${f(-r*.2)} ${f(r*.7)} ${f(r*.5)} ${f(-r*.6)} ${f(r*.4)}Z" fill="url(#land-rock)" stroke="#353830" stroke-width="1.2"/><path d="M${f(-r*.6)} ${f(-r*.8)} L0 ${f(-r*.2)} ${f(r*.4)} ${-r} M0 ${f(-r*.2)} L${f(r*.7)} ${f(r*.5)}" fill="none" stroke="#b3afa0" stroke-opacity=".22"/></g>`;
}
function bush(x,y,size,rngOrMirror,tree=false) {
  const width=size*(tree?4.2:2.8),height=size*(tree?4.4:2.4);
  const mirror=typeof rngOrMirror==='function'?(rngOrMirror()>.5?-1:1):rngOrMirror;
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${mirror} 1)"><ellipse cx="7" cy="7" rx="${f(width*.34)}" ry="${f(width*.13)}" fill="#050803" opacity=".35"/><image href="/app/assets/exploration/moor-oak-v059.png" x="${f(-width/2)}" y="${f(-height*.72)}" width="${f(width)}" height="${f(height)}" opacity=".95"/></g>`;
}
function torch(x,y) {
  return `<g transform="translate(${f(x)} ${f(y)})"><ellipse cy="-8" rx="42" ry="29" fill="url(#land-firelight)"/><path d="M0-16 V8 M0-5 L-7 12 M0-5 L7 12" stroke="#382a19" stroke-width="2.4"/><path d="M-4-17 Q-6-23 0-29 Q-2-22 4-21 L1-15Z" fill="#e7a640"/><path d="M-1-17 Q-3-22 0-24 L2-18Z" fill="#ffe7a0"/></g>`;
}
function caveCamp(x,y) {
  return `<g transform="translate(${x} ${y})"><ellipse cx="5" cy="8" rx="33" ry="12" fill="#0b0805" opacity=".6"/><path d="M-27 6 L-7-28 29 4 5 17Z" fill="#65553a" stroke="#251b13" stroke-width="2"/><path d="M-7-28 L5 17 29 4Z" fill="#30271d"/><path d="M-7-32 L-7-20 M-28 10 V-1 M30 9 V-2" stroke="#827259" stroke-width="2"/><path d="M-24 8 L-7-27 27 5" fill="none" stroke="#b59a66" stroke-opacity=".35"/></g>`;
}

function interiorFeature(p, profile, variant) {
  if (profile === 'crypt' || profile === 'catacombs') {
    const turn = variant % 2 ? 8 : -8;
    return `<g transform="translate(${p.x} ${p.y}) rotate(${turn})"><ellipse cy="9" rx="29" ry="9" fill="#050403" opacity=".6"/><path d="M-27 4 L-21-17 18-17 27 4 19 12-20 12Z" fill="#574e43" stroke="#a1947d" stroke-opacity=".48" stroke-width="2"/><path d="M-21-17 L-14-24 22-24 18-17Z" fill="#92836c" stroke="#c0b39b" stroke-opacity=".35"/><path d="M-17-12 L15-12 M-16-5 L16-5 M-15 2 L14 2" stroke="#261f19" stroke-opacity=".55" stroke-width="2"/></g>`;
  }
  if (profile === 'tower') {
    return `<g transform="translate(${p.x} ${p.y})"><ellipse cy="2" rx="32" ry="20" fill="none" stroke="#a39479" stroke-opacity=".34" stroke-width="3"/><ellipse cy="2" rx="20" ry="12" fill="none" stroke="#302921" stroke-opacity=".7" stroke-width="2"/><path d="M-43 25 H-18 V20 H5 V15 H27 V10 H43" fill="none" stroke="#b5a58b" stroke-opacity=".4" stroke-width="4"/><path d="M-40 28 H-17 M-15 23 H7 M10 18 H29" stroke="#181512" stroke-width="2"/></g>`;
  }
  if (profile === 'jail') {
    const side = variant % 2 ? 1 : -1;
    return `<g transform="translate(${p.x + side * 42} ${p.y - 9})"><path d="M-14 23 V-22 H14 V23 M-14-14 H14 M-14 16 H14" fill="none" stroke="#201b17" stroke-width="5"/><path d="M-8 22 V-21 M0 22 V-21 M8 22 V-21" stroke="#807361" stroke-opacity=".65" stroke-width="2"/><path d="M-16-22 H16" stroke="#b4a487" stroke-opacity=".45" stroke-width="3"/></g>`;
  }
  if (profile === 'monastery') {
    const dx = variant % 2 ? 1 : -1;
    return `<g transform="translate(${p.x + dx * 39} ${p.y - 10})"><ellipse cy="21" rx="11" ry="5" fill="#060504" opacity=".65"/><path d="M-8 18 V-18 L-12-25 0-30 12-25 8-18 V18Z" fill="#665c4c" stroke="#b2a38a" stroke-opacity=".5" stroke-width="2"/><path d="M-6-16 H6 M-8 15 H8" stroke="#29241e" stroke-width="3"/></g>`;
  }
  return '';
}

export function renderExplorationLandscape({map,sectors}) {
  if (!hasLandscape(map.areaId)) return null;
  const area=act1Area(map.areaId), profile=area.profile, interior=INTERIOR_PROFILES.has(profile);
  const cave=profile==='cave', discovered=sectors.filter(s=>s.discovered), byId=new Map(sectors.map(s=>[s.id,s]));
  const sight=discovered.filter(s=>s.visible===true||(s.visible===undefined&&s.current));
  const known=new Set(discovered.map(s=>s.id)), inSight=new Set(sight.map(s=>s.id)), current=sectors.find(s=>s.current);
  const p=s=>landscapePoint(map.areaId,s);
  const left=map.bounds.minX*168-220,top=map.bounds.minY*132-200;
  const width=(map.bounds.maxX-map.bounds.minX)*168+440,height=(map.bounds.maxY-map.bounds.minY)*132+400;
  const rect=`x="${left}" y="${top}" width="${width}" height="${height}"`;
  const linked=map.edges.filter(e=>known.has(e.a)&&known.has(e.b));
  const routes=linked.map((e,i)=>route(p(byId.get(e.a)),p(byId.get(e.b)),i));
  const sightRoutes=linked.flatMap((e,i)=>inSight.has(e.a)&&inSight.has(e.b)?[routes[i]]:[]);
  const geometryFor=(region,regionRoutes,color)=>region.map(s=>interior?`<path d="${chamber(p(s),s.variant,profile)}"/>`:`<ellipse cx="${p(s).x}" cy="${p(s).y}" rx="144" ry="112"/>`).join('')
    +(interior?regionRoutes.map(d=>`<path d="${d}" fill="none" stroke="${color}" stroke-width="${profile==='cave'?67:54}" stroke-linecap="round"/>`).join(''):'');
  const geometry=geometryFor(discovered,routes,'white');
  const sightGeometry=geometryFor(sight,sightRoutes,'black');
  const texture=interior?'den-earth-v059.png':'blood-moor-ground-v059.png';
  const defs=`<defs>
    <pattern id="land-ground" width="360" height="360" patternUnits="userSpaceOnUse"><image href="/app/assets/exploration/${texture}" width="360" height="360"/></pattern>
    <pattern id="land-rock" width="160" height="160" patternUnits="userSpaceOnUse"><image href="/app/assets/exploration/den-earth-v059.png" width="160" height="160"/><rect width="160" height="160" fill="#605f52" opacity=".3"/></pattern>
    <radialGradient id="land-firelight"><stop stop-color="#d88729" stop-opacity=".4"/><stop offset="1" stop-color="#d88729" stop-opacity="0"/></radialGradient>
    <filter id="land-foliage" x="-30%" y="-30%" width="160%" height="170%"><feTurbulence type="fractalNoise" baseFrequency=".16" numOctaves="3" seed="17" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="10"/><feDropShadow dx="2" dy="5" stdDeviation="3" flood-color="#020402" flood-opacity=".8"/></filter>
    <filter id="land-fog-edge"><feGaussianBlur stdDeviation="${interior?3:21}"/></filter>
    <filter id="land-trail-soft"><feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="3" seed="31" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="18"/><feGaussianBlur stdDeviation="2.8"/></filter>
    <filter id="land-cliff"><feMorphology in="SourceAlpha" operator="dilate" radius="24" result="rim"/><feComposite in="rim" in2="SourceAlpha" operator="out" result="ring"/><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="3" seed="7" result="n"/><feDisplacementMap in="ring" in2="n" scale="23" result="edge"/><feFlood flood-color="white"/><feComposite in2="edge" operator="in"/></filter>
    <filter id="land-rock-light"><feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="4" seed="17" result="n"/><feDiffuseLighting in="n" lighting-color="#8b7b67" surfaceScale="4" diffuseConstant=".8" result="light"><feDistantLight azimuth="225" elevation="38"/></feDiffuseLighting><feComposite in="light" in2="SourceAlpha" operator="in"/><feBlend in2="SourceGraphic" mode="multiply"/></filter>
    <g id="land-shape" fill="white">${geometry}</g>
    <mask id="land-reveal" maskUnits="userSpaceOnUse" ${rect}><use href="#land-shape" filter="url(#land-fog-edge)"/></mask>
    <mask id="land-floor" maskUnits="userSpaceOnUse" ${rect}><use href="#land-shape"/></mask>
    <mask id="land-wall" maskUnits="userSpaceOnUse" ${rect}><use href="#land-shape" filter="url(#land-cliff)"/></mask>
    <mask id="land-memory" maskUnits="userSpaceOnUse" ${rect}><use href="#land-shape"/><g fill="black" filter="url(#land-fog-edge)">${sightGeometry}</g></mask>
  </defs>`;
  const trails=`<g filter="url(#land-trail-soft)">${routes.map(d=>`<path d="${d}" fill="none" stroke="${interior?'#ac9170':'#867254'}" stroke-opacity="${interior?.18:.34}" stroke-width="${interior?18:29}" stroke-linecap="round"/>`).join('')}</g>`;
  let decorations='';
  for(const s of discovered) {
    const pos=p(s),rng=randomFor(`${map.layoutSignature}:${s.id}:landscape-v1`);
    if(interior) {
      // Profile-specific landmarks turn the logical room layout into a
      // recognizable floor plan instead of exposed sector tiles.
      decorations+=interiorFeature(pos,profile,s.variant);
      if(cave) {
        for(let i=0;i<7;i++) {
          const a=rng()*Math.PI*2;
          decorations+=rock(pos.x+Math.cos(a)*64,pos.y+Math.sin(a)*47,4+rng()*7,rng);
        }
        if(rng()<.3) decorations+=torch(pos.x-49,pos.y-20);
        if(rng()<.13) decorations+=caveCamp(pos.x+28,pos.y-24);
        if(rng()<.18) decorations+=`<g transform="translate(${pos.x-20} ${pos.y+30}) rotate(-12)">${[0,1,2,3].map(i=>`<path d="M-26 ${i*5} L30 ${i*5+2}" stroke="${i%2?'#594732':'#766047'}" stroke-width="4"/>`).join('')}</g>`;
        if(rng()<.45)decorations+=`<g transform="translate(${pos.x+45} ${pos.y+24})"><path d="M-11 5 Q-9-8-7-15 Q-6-3-3 4 L2-8 6 6 Q9-7 11-19 Q12-7 15 7Z" fill="url(#land-rock)" stroke="#625947" stroke-opacity=".3"/><path d="M-30 11 l12 5 m-11 0 l9-5" stroke="#a39777" opacity=".45" stroke-width="2"/></g>`;
      } else {
        const tileCount=profile==='tower'?4:profile==='jail'?3:5;
        for(let i=0;i<tileCount;i++) {
          const tx=pos.x-24+(i%3)*19,ty=pos.y+31+Math.floor(i/3)*8;
          decorations+=`<path d="M${tx} ${ty} l13-2 8 5-13 3Z" fill="${i%2?'#6b6050':'#877b67'}" fill-opacity=".52" stroke="#211d19" stroke-opacity=".7" stroke-width="1.2"/>`;
        }
        if(rng()<.24)decorations+=torch(pos.x-47,pos.y-18);
      }
    } else {
      const details=fieldDecorations(map,s);
      for(const item of details.bushes) {
        const image=bush(item.x,item.y,item.size,item.mirror,item.tree);
        decorations+=item.tree?`<g data-obstacle-id="tree:${s.id}">${image}</g>`:image;
      }
      if(details.rock)decorations+=`<g data-obstacle-id="rock:${s.id}">${rock(details.rock.x,details.rock.y,details.rock.size,details.rock.rotation)}</g>`;
      if(details.fence)decorations+=`<path data-obstacle-id="fence:${s.id}" d="M${pos.x-63} ${pos.y+35} l29 7 m-28-13 v16 m13-14 v12 m13-8 v13" fill="none" stroke="#6c6650" stroke-width="3" opacity=".8"/>`;
      // An absent logical edge is a boundary hedge, not an apparent walkable shortcut.
      for(const [dx,dy] of [[1,0],[0,1]]) {
        const other=discovered.find(t=>t.x===s.x+dx&&t.y===s.y+dy);
        if(!other||linked.some(e=>(e.a===s.id&&e.b===other.id)||(e.b===s.id&&e.a===other.id)))continue;
        const otherP=p(other),mid={x:(pos.x+otherP.x)/2,y:(pos.y+otherP.y)/2};
        decorations+=`<g data-obstacle-id="hedge:${s.id}:${other.id}">`;
        for(let i=-2;i<=2;i++)decorations+=bush(mid.x+(dy?i*24:0),mid.y+(dx?i*20:0),19,rng);
        decorations+='</g>';
      }
    }
  }
  const landmarks=discovered.flatMap(s=>s.exits.map(exit=>{
    const pos=p(s);
    if(map.areaId===MOOR&&exit.targetAreaId===DEN) return `<g class="den-entrance" data-landmark="den-entrance"><image href="/app/assets/exploration/den-entrance-v059.png" x="${pos.x-88}" y="${pos.y-113}" width="176" height="145" preserveAspectRatio="xMidYMid meet"/><text class="land-label" x="${pos.x}" y="${pos.y+45}">SIEDLISKO ZŁA</text></g>`;
    if(interior)return `<g class="den-daylight" transform="translate(${pos.x} ${pos.y})"><ellipse cy="-24" rx="31" ry="21" fill="#979d83" opacity=".35"/><path d="M-30-20 Q0-43 32-20 L21 8-22 7Z" fill="#2e3728"/><path d="M-20-16 Q0-27 21-16 L15-1-13-1Z" fill="#a1ad84" opacity=".6"/><text class="land-label" y="39">WYJŚCIE</text></g>`;
    const exitLabel=exit.targetAreaId==='act1.rogue_encampment'?'POWRÓT DO OBOZOWISKA ŁOTRZYC':exit.targetAreaId==='act1.cold_plains'?'PRZEJŚCIE DO ZIMNEJ RÓWNINY':`PRZEJŚCIE DO ${act1Area(exit.targetAreaId).label.toLocaleUpperCase('pl-PL')}`;
    return `<g transform="translate(${pos.x} ${pos.y})"><path d="M0 6 V-22 M-17-20 H19 L26-13 19-6 H-17Z" fill="#554331" stroke="#9a8763" stroke-width="2"/><text class="land-label" y="35">${exitLabel}</text></g>`;
  })).join('');
  const waypoints=discovered.filter(s=>s.points.some(point=>point.kind==='waypoint')).map(s=>{
    const pos=p(s);
    return `<g class="land-waypoint" data-landmark="waypoint" transform="translate(${pos.x} ${pos.y})"><circle class="land-waypoint-glow" r="24"/><ellipse class="land-waypoint-ring" rx="18" ry="8"/><path class="land-waypoint-runes" d="M-9-4 L-5-10 0-5 5-10 9-4 M-8 4 L-3-1 0 4 3-1 8 4"/></g>`;
  }).join('');
  const frontierIndexById=new Map(sectors.filter(s=>s.reachable&&!s.discovered).map((s,i)=>[s.id,i]));
  const tokens=sectors.map(s=>{
    const pos=p(s);
    if(!s.discovered&&!s.reachable)return '';
    const threat=s.visible&&s.encounter?.status==='available';
    const icon=s.visible&&s.encounter?.status==='completed'?'✓':'';
    const target=s.discovered?`data-sector-id="${s.id}"`:`data-frontier-index="${frontierIndexById.get(s.id)}"`;
    const monsters=threat?`<g class="land-threat" aria-hidden="true"><ellipse class="land-threat-glow" cy="1" rx="26" ry="10"/><image class="land-threat-figure" href="/app/assets/unit-zombie-d2r-v1.png" x="-19" y="-38" width="22" height="36" preserveAspectRatio="xMidYMax meet"/><image class="land-threat-figure" href="/app/assets/unit-fallen-d2r-v1.png" x="-1" y="-34" width="25" height="34" preserveAspectRatio="xMidYMax meet"/></g>`:'';
    return `<g class="exploration-sector landscape-sector ${s.discovered?'discovered':'fog'}${s.current?' current':''}${s.reachable?' reachable':''}" ${target} transform="translate(${pos.x} ${pos.y})"><ellipse class="land-hit" rx="63" ry="47"/><ellipse class="land-step" rx="17" ry="10"/>${monsters}${icon?`<g class="land-encounter"><path d="M-8-17 L0-24 8-17 0-10Z"/><text class="sector-icon" y="-12">${icon}</text></g>`:''}</g>`;
  }).join('');
  const exitTargets=discovered.flatMap(s=>s.exits.map(exit=>{
    const pos=p(s);
    return `<g class="land-exit-target" data-landmark-exit="${exit.targetAreaId}" data-sector-id="${s.id}" data-target-x="${pos.x}" data-target-y="${pos.y}" transform="translate(${pos.x} ${pos.y})" aria-label="${exit.targetAreaId===DEN?'Wejście do Siedliska Zła':exit.targetAreaId==='act1.cold_plains'?'Przejście do Zimnej Równiny':'Powrót do Obozowiska Łotrzyc'}"><ellipse class="land-hit" rx="78" ry="60"/></g>`;
  })).join('');
  return {defs,markup:`<g class="landscape-art ${interior?`${profile}-landscape`:'moor-landscape'}" data-landscape="${interior?profile:'moor'}" pointer-events="none">${interior?`<rect ${rect} fill="url(#land-rock)" mask="url(#land-wall)" filter="url(#land-rock-light)"/>`:''}<g mask="url(#land-reveal)"><rect ${rect} fill="url(#land-ground)"/><rect ${rect} fill="${interior?'#211109':'#17271b'}" opacity="${interior?.5:.23}"/><g ${interior?'mask="url(#land-floor)"':''}>${trails}${decorations}${landmarks}${waypoints}</g><rect class="land-memory-shade" ${rect} mask="url(#land-memory)"/></g></g>${tokens}${exitTargets}`,currentPoint:p(current)};
}
