import { animationCell } from './barbarian-animation.js';

export const PALADIN_ATLASES = Object.freeze({
  unarmed: '/app/assets/animation/paladin-diagonal-unarmed-v1.png',
  scepter: '/app/assets/animation/paladin-diagonal-scepter-v1.png',
  scepterTarge: '/app/assets/animation/paladin-diagonal-scepter-targe-v1.png',
  scepterBuckler: '/app/assets/animation/paladin-diagonal-scepter-buckler-v1.png',
});

export function paladinAnimationVariant(character) {
  if (character?.classId !== 'paladin' || character?.gender === 'female'
    || character?.appearance?.gender === 'female') return null;
  const weapon = character?.equipment?.weapon?.canonicalId;
  const offhand = character?.equipment?.offhand?.canonicalId;
  if (!weapon && !offhand) return 'unarmed';
  if (weapon === 'scepter' && !offhand) return 'scepter';
  if (weapon === 'scepter' && offhand === 'targe') return 'scepterTarge';
  if (weapon === 'scepter' && offhand === 'buckler') return 'scepterBuckler';
  return null;
}

export function drawPaladinFrame(context, atlases, player, actorId, point, height, character) {
  const variant = paladinAnimationVariant(character);
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
