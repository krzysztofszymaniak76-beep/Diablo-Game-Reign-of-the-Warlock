import { animationCell } from './barbarian-animation.js';

export const SORCERESS_ATLASES = Object.freeze({
  unarmed: '/app/assets/animation/sorceress-diagonal-unarmed-v1.png',
  wand: '/app/assets/animation/sorceress-diagonal-wand-v1.png',
});

export function sorceressAnimationVariant(character) {
  if (character?.classId !== 'sorceress' || character?.gender === 'male'
    || character?.appearance?.gender === 'male') return null;
  const weapon = character?.equipment?.weapon?.canonicalId;
  const offhand = character?.equipment?.offhand?.canonicalId;
  if (offhand) return null;
  if (!weapon) return 'unarmed';
  if (weapon === 'wand') return 'wand';
  return null;
}

export function drawSorceressFrame(context, atlases, player, actorId, point, height, character) {
  const variant = sorceressAnimationVariant(character);
  const atlas = atlases[variant];
  if (!atlas?.frames) return false;
  const pose = player.pose(actorId);
  const direction = pose.direction === 'east' ? 'southeast'
    : pose.direction === 'west' ? 'southwest' : pose.direction;
  const { index } = animationCell(pose.clip, direction,
    pose.clip === 'walk' ? pose.frameProgress : pose.progress);
  const frame = atlas.frames[index];
  if (!frame) return false;
  const scale = height / (frame.h * .9);
  context.drawImage(atlas.image, frame.x, frame.y, frame.w, frame.h,
    point.x - frame.pivotX * scale, point.y - frame.pivotY * scale,
    frame.w * scale, frame.h * scale);
  return true;
}
