// Lossless RGBA exports of the corresponding local Diablo II: Resurrected UI
// sprites. All listed art is source-extracted, not redrawn or generated.
const d2rItemSprites = new Map(Object.entries({
  club: 'club', hand_axe: 'hand_axe', great_axe: 'great_axe',
  short_sword: 'short_sword', two_handed_sword: 'two_handed_sword', great_sword: 'great_sword',
  dagger: 'dagger', war_hammer: 'war_hammer', spear: 'spear', war_staff: 'war_staff',
  wand: 'wand', hunters_bow: 'hunters_bow', light_crossbow: 'light_crossbow',
  throwing_axe: 'throwing_axe', katar: 'katar', flail: 'flail',
  scepter: 'scepter', grand_scepter: 'grand_scepter',
  cap: 'cap', quilted_armor: 'quilted_armor', buckler: 'buckler', targe: 'targe',
  leather_gloves: 'leather_gloves', boots: 'boots', sash: 'sash',
  scroll_identify: 'scroll_identify', scroll_town_portal: 'scroll_town_portal',
  tome_identify: 'tome_identify', tome_town_portal: 'tome_town_portal',
  potion_health_lesser: 'potion_health_lesser', potion_health_light: 'potion_health_light',
  potion_health: 'potion_health', potion_mana_lesser: 'potion_mana_lesser',
  potion_mana_light: 'potion_mana_light', potion_mana: 'potion_mana',
}));

export function hasTradeItemArtwork(canonicalId) {
  return d2rItemSprites.has(canonicalId);
}

export function tradeItemArtworkMarkup(canonicalId) {
  const sprite = d2rItemSprites.get(canonicalId);
  if (!sprite) return '<span class="d2-trade-item-art d2-trade-item-art-missing" aria-hidden="true"></span>';
  return `<img class="d2-trade-item-art" src="/app/assets/items/${sprite}.png" alt="" draggable="false">`;
}
