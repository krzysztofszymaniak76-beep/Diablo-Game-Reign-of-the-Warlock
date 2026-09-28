// Visual pilot only. No eligibility, bindings, costs, or save state lives here.
// ListRow/IconCel: installed D2R 3.3.93847 skilldesc.txt
// SHA256 CDF11C518EAB9FE678616A237FC64B28CEA5EA51649EC641A14E09B06EA34B38.
export const PALETTE_PILOT_CLASS = 'sorceress';
export const SORCERESS_PALETTE_ROWS = Object.freeze({
  fire_bolt:[1,0], warmth:[1,2], inferno:[1,10], blaze:[1,20], fire_ball:[1,22],
  fire_wall:[1,30], enchant:[1,32], meteor:[1,40], fire_mastery:[1,50], hydra:[1,52],
  charged_bolt:[2,4], static_field:[2,12], telekinesis:[2,14], nova:[2,24], lightning:[2,26],
  chain_lightning:[2,34], teleport:[2,36], thunder_storm:[2,42], energy_shield:[2,44], lightning_mastery:[2,54],
  ice_bolt:[3,6], frozen_armor:[3,8], frost_nova:[3,16], ice_blast:[3,18], shiver_armor:[3,28],
  glacial_spike:[3,38], blizzard:[3,46], chilling_armor:[3,48], frozen_orb:[3,56], cold_mastery:[3,58],
});

export function paletteVisualRows(ids) {
  const groups = new Map();
  for (const id of ids) {
    const position = id === 'basic.attack' ? [0,2] : SORCERESS_PALETTE_ROWS[id.replace(/^sorceress\./, '')];
    const [row, order] = position || [0,-1];
    if (!groups.has(row)) groups.set(row, []);
    groups.get(row).push({id, order});
  }
  return [...groups].sort(([a],[b]) => b-a)
    .map(([row, entries]) => ({row, ids: entries.sort((a,b)=>b.order-a.order).map(e=>e.id)}));
}

export function watchPaletteAsset(image, host, name) {
  if (host.dataset.assetWatched === image.src) return;
  host.dataset.assetWatched = image.src;
  const clear = () => { host.classList.remove('visual-asset-missing'); host.querySelector('.visual-asset-warning')?.remove(); };
  image.onload = clear;
  image.onerror = () => {
    clear(); host.classList.add('visual-asset-missing');
    const warning = document.createElement('span'); warning.className = 'visual-asset-warning';
    warning.textContent = 'VISUAL ASSET MISSING'; host.append(warning);
    host.dataset.tooltip = `VISUAL ASSET MISSING — ${name}\n${image.getAttribute('src')}`;
    host.title = host.dataset.tooltip;
  };
  if (image.complete) image.naturalWidth ? clear() : image.onerror();
}

export function stylePilotPalette(chooser, tiles, side, anchor) {
  const buttons = [...tiles.children];
  const rows = paletteVisualRows(buttons.map(b=>b.dataset.skillId));
  const byId = new Map(buttons.map(b=>[b.dataset.skillId,b]));
  tiles.replaceChildren(); tiles.style.removeProperty('grid-template-columns');
  const desired = Math.min(96, Math.max(48, anchor.height * 1.02));
  const columns = Math.max(...rows.map(row=>row.ids.length));
  const size = Math.min(desired, (innerWidth-24)/columns, (anchor.top-100)/(rows.length+1.65));
  chooser.style.setProperty('--skill-tile-size', `${Math.max(30,size)}px`);
  for (const group of rows) {
    const row = document.createElement('div'); row.className = 'skill-choice-row'; row.dataset.sourceListRow = group.row;
    for (const id of group.ids) row.append(byId.get(id));
    tiles.append(row);
  }
  const width = chooser.getBoundingClientRect().width;
  // Reference: left-hand list ends above LPM; right-hand list starts above PPM.
  const left = side === 'left' ? anchor.right - width : anchor.left;
  chooser.style.left = `${Math.max(8,Math.min(innerWidth-width-8,left))}px`;
  chooser.style.bottom = `${innerHeight-anchor.top+size*1.45}px`;
  const instruction = chooser.querySelector('.skill-choice-instruction');
  const box = chooser.getBoundingClientRect(), caption = instruction.getBoundingClientRect();
  instruction.style.transform = 'none';
  instruction.style.left = `${Math.max(8,Math.min(innerWidth-caption.width-8,box.left+(box.width-caption.width)/2))-box.left}px`;
}
