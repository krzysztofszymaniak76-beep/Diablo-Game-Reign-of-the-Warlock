import { animationCell } from './barbarian-animation.js';

// One body atlas per original class figure. The equipment is drawn from the
// equipped item IDs, so changing gear never silently substitutes another hero.
export const HERO_BODY_ATLASES = Object.freeze({
  amazon: '/app/assets/animation/amazon-diagonal-unarmed-v1.png',
  assassin: '/app/assets/animation/assassin-diagonal-unarmed-v1.png',
  barbarian: '/app/assets/animation/barbarian-diagonal-unarmed-v1.png',
  druid: '/app/assets/animation/druid-diagonal-unarmed-v1.png',
  necromancer: '/app/assets/animation/necromancer-diagonal-unarmed-v1.png',
  paladin: '/app/assets/animation/paladin-diagonal-unarmed-v1.png',
  sorceress: '/app/assets/animation/sorceress-diagonal-unarmed-v1.png',
  warlock: '/app/assets/animation/warlock-diagonal-unarmed-v1.png',
});

export const HERO_DEFAULT_GENDERS = Object.freeze({
  amazon: 'female', assassin: 'female', barbarian: 'male', druid: 'male',
  necromancer: 'male', paladin: 'male', sorceress: 'female', warlock: 'male',
});

export function heroAnimationLoadout(character, catalog) {
  const classId = character?.classId;
  if (!Object.hasOwn(HERO_BODY_ATLASES, classId)) return null;
  const gender = character?.appearance?.gender ?? character?.gender;
  if (gender && gender !== HERO_DEFAULT_GENDERS[classId]) return null;
  const weaponId = character?.equipment?.weapon?.canonicalId ?? null;
  const offhandId = character?.equipment?.offhand?.canonicalId ?? null;
  const weapon = weaponId ? catalog.get(weaponId) : null;
  const offhand = offhandId ? catalog.get(offhandId) : null;
  if ((weaponId && (!weapon || weapon.kind !== 'weapon'))
    || (offhandId && !offhand)
    || (weapon?.classOnly && weapon.classOnly !== classId)
    || (offhand?.classOnly && offhand.classOnly !== classId)) return null;
  // Weapon-in-offhand is reserved for the Barbarian, and only for a weapon
  // that can actually be wielded in one hand. The current catalog does not
  // yet offer an offhand weapon slot; this also guards future save formats.
  const dualWield = offhand?.kind === 'weapon';
  if (dualWield && (classId !== 'barbarian'
    || (offhand.twoHanded && !offhand.barbarianOneHand))) return null;
  const twoHanded = Boolean(weapon?.twoHanded
    && !(classId === 'barbarian' && weapon.barbarianOneHand && offhand));
  if (twoHanded && offhand) return null;
  if (offhand && !dualWield && offhand.slot !== 'offhand') return null;
  return {classId, weaponId, offhandId, twoHanded, dualWield};
}

function itemHeight(id, twoHanded, bodyHeight) {
  if (['hunters_bow', 'light_crossbow'].includes(id)) return bodyHeight * .62;
  if (['spear', 'war_staff', 'great_axe', 'great_sword', 'two_handed_sword'].includes(id)) return bodyHeight * .81;
  if (id === 'dagger' || id === 'katar' || id === 'wand') return bodyHeight * .32;
  return bodyHeight * (twoHanded ? .72 : .45);
}

function drawHeldItem(context, sprite, id, hand, bodyHeight,
  {twoHanded = false, mirror = false, offhand = false} = {}) {
  if (!sprite?.complete || !sprite.naturalWidth || !sprite.naturalHeight) return;
  const shield = offhand;
  const h = shield ? bodyHeight * .28 : itemHeight(id, twoHanded, bodyHeight);
  const w = h * sprite.naturalWidth / sprite.naturalHeight;
  const bow = ['hunters_bow', 'light_crossbow'].includes(id);
  const rotation = shield ? 0 : bow ? (mirror ? -.12 : .12)
    : twoHanded ? (mirror ? -.43 : .43) : (mirror ? -.18 : .18);
  context.save();
  context.translate(hand.x, hand.y);
  context.rotate(rotation);
  context.drawImage(sprite, -w / 2, shield || bow ? -h / 2 : -h * .86, w, h);
  context.restore();
}

export function drawHeroAnimationFrame(context, atlases, itemSprites, player,
  actorId, point, height, character, catalog) {
  const loadout = heroAnimationLoadout(character, catalog);
  if (!loadout) return false;
  const atlas = atlases[loadout.classId];
  if (!atlas?.frames) return false;
  if ((loadout.weaponId && !(itemSprites[loadout.weaponId]?.naturalWidth > 0))
    || (loadout.offhandId && !(itemSprites[loadout.offhandId]?.naturalWidth > 0))) return false;
  const pose = player.pose(actorId);
  const direction = pose.direction === 'east' ? 'southeast'
    : pose.direction === 'west' ? 'southwest' : pose.direction;
  const {index, column, row} = animationCell(pose.clip, direction,
    pose.clip === 'walk' ? pose.frameProgress : pose.progress);
  const frame = atlas.frames[index];
  if (!frame) return false;
  const scale = height / (frame.h * .9);
  const left = point.x - frame.pivotX * scale;
  const top = point.y - frame.pivotY * scale;
  const width = frame.w * scale, bodyHeight = frame.h * scale;
  context.drawImage(atlas.image, frame.x, frame.y, frame.w, frame.h,
    left, top, width, bodyHeight);
  if (!loadout.weaponId && !loadout.offhandId) return true;

  const back = row < 2, mirror = row % 2 === 1;
  const primaryX = mirror ? (back ? .24 : .76) : (back ? .76 : .24);
  const secondX = 1 - primaryX;
  const handY = column < 5 ? .61 : column === 5 ? .30 : column === 6 ? .39 : .52;
  const primary = {x: left + width * primaryX, y: top + bodyHeight * handY};
  const second = {x: left + width * secondX, y: top + bodyHeight * .59};
  if (loadout.weaponId) drawHeldItem(context, itemSprites[loadout.weaponId],
    loadout.weaponId, primary, bodyHeight, {twoHanded: loadout.twoHanded, mirror});
  if (loadout.offhandId) drawHeldItem(context, itemSprites[loadout.offhandId],
    loadout.offhandId, second, bodyHeight, {mirror: !mirror, offhand: !loadout.dualWield});
  return true;
}
