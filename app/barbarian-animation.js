// Approved male Barbarian atlases for unarmed and short-sword poses.
// No mirroring, mesh deformation, damage callbacks or save state in this module.
export const BARBARIAN_ATLASES = Object.freeze({
  walk: '/app/assets/animation/barbarian-walk-v1.png',
  attack: '/app/assets/animation/barbarian-sword-v1.png',
  diagonal: '/app/assets/animation/barbarian-diagonal-v1.png',
});
export const BARBARIAN_UNARMED_ATLASES = Object.freeze({
  walkUnarmed: '/app/assets/animation/barbarian-walk-unarmed-v1.png',
  diagonalUnarmed: '/app/assets/animation/barbarian-diagonal-unarmed-v1.png',
  diagonalHandAxe: '/app/assets/animation/barbarian-diagonal-hand-axe-v1.png',
});
// Give the selected route a readable, continuous three-second march. The
// caller divides this across its per-hex walk animations.
export const WALK_ACTION_MS = 2250;
export const WALK_CYCLE_MS = 525;
export function walkStepDuration(stepCount) {
  const steps = Number.isInteger(stepCount) && stepCount > 0 ? stepCount : 1;
  return WALK_ACTION_MS / steps;
}
export const ATTACK_ACTION_MS = 1500;
export const WINDUP_MS = ATTACK_ACTION_MS / 2;
export const RECOVERY_MS = ATTACK_ACTION_MS - WINDUP_MS;

export function supportsBarbarianAnimation(character) {
  return character?.classId === 'barbarian' && character?.gender !== 'female'
    && character?.appearance?.gender !== 'female'
    && character?.equipment?.weapon?.canonicalId === 'short_sword'
    && !character?.equipment?.offhand;
}

export function barbarianWalkVariant(character) {
  if (character?.classId !== 'barbarian' || character?.gender === 'female'
    || character?.appearance?.gender === 'female' || character?.equipment?.offhand) return null;
  const weaponId = character?.equipment?.weapon?.canonicalId;
  if (!weaponId) return 'unarmed';
  if (weaponId === 'hand_axe') return 'hand_axe';
  return weaponId === 'short_sword' ? 'short_sword' : null;
}

export function supportsBarbarianWalkAnimation(character) {
  return barbarianWalkVariant(character) !== null;
}

export function facingForVector(from, to, previous = 'east') {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.hypot(dx, dy) < .01) return previous;
  if (Math.abs(dy) < Math.abs(dx) * .45) return dx > 0 ? 'east' : 'west';
  return `${dy < 0 ? 'north' : 'south'}${dx < 0 ? 'west' : 'east'}`;
}

export function animationCell(clip, direction, progress) {
  const p = Math.max(0, Math.min(.999999, progress));
  const diagonalRow = ['northeast', 'northwest', 'southeast', 'southwest'].indexOf(direction);
  if (diagonalRow >= 0) {
    const column = clip === 'walk' ? Math.floor(p * 4)
      : clip === 'windup' ? (p < .7 ? 5 : 6)
      : clip === 'recovery' ? (p < .7 ? 7 : 4) : 4;
    return {index: diagonalRow * 8 + column, column, row: diagonalRow};
  }
  const offset = direction === 'west' ? 8 : 0;
  const phase = clip === 'walk' ? Math.floor(p * 8)
    : clip === 'windup' ? 2 + Math.floor(p * 3)
    : clip === 'recovery' ? 5 + Math.floor(p * 3)
    : Math.floor(p * 2);
  const index = offset + phase;
  return { index, column: index % 4, row: Math.floor(index / 4) };
}

export function interpolateGround(from, to, progress) {
  const p = Math.max(0, Math.min(1, progress));
  return {x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p};
}

// Time-based presentation; the caller resolves one authoritative event after
// the promise completes. Frames never roll damage or advance simulation time.
export class BattleAnimationPlayer {
  constructor({ frame = callback => requestAnimationFrame(callback), now = () => performance.now(), paused = () => false, draw = () => {} } = {}) {
    this.frame = frame; this.now = now; this.paused = paused; this.draw = draw;
    this.playbacks = new Map(); this.facing = new Map(); this.walkPhase = new Map(); this.generation = 0;
  }
  // Compatibility for diagnostics: rendering always looks up the actor, never
  // this aggregate view. No unit can overwrite another unit's playback.
  get current() { return this.playbacks.values().next().value ?? null; }
  cancel() { this.generation++; this.playbacks.clear(); }
  async play(spec, duration) {
    if (!spec.actorId || !Number.isFinite(duration) || duration <= 0) throw new Error('Nieprawidłowa animacja');
    if (this.playbacks.has(spec.actorId)) throw new Error('Jednostka już odtwarza akcję');
    const generation = this.generation;
    if (spec.from && spec.to) this.facing.set(spec.actorId, facingForVector(spec.from, spec.to, this.facing.get(spec.actorId)));
    const initialWalkPhase = spec.clip === 'walk' ? this.walkPhase.get(spec.actorId) ?? 0 : 0;
    let previous = this.now(), elapsed = 0;
    const playback = () => ({...spec, progress: Math.min(1, elapsed / duration),
      frameProgress: spec.clip === 'walk' ? (initialWalkPhase + elapsed / WALK_CYCLE_MS) % 1 : Math.min(1, elapsed / duration)});
    this.playbacks.set(spec.actorId, playback());
    this.draw();
    return new Promise((resolve, reject) => {
      const tick = timestamp => {
        try {
        if (generation !== this.generation) return resolve(false);
        if (!this.paused()) elapsed += Math.max(0, timestamp - previous);
        previous = timestamp;
        this.playbacks.set(spec.actorId, playback());
        this.draw();
        if (elapsed >= duration) {
          if (spec.clip === 'walk') this.walkPhase.set(spec.actorId, playback().frameProgress);
          this.playbacks.delete(spec.actorId);
          resolve(true);
        }
        else this.frame(tick);
        } catch (error) { this.playbacks.delete(spec.actorId); reject(error); }
      };
      this.frame(tick);
    });
  }
  point(actorId, fallback) {
    const c = this.playbacks.get(actorId);
    return c?.actorId === actorId && c.clip === 'walk' ? interpolateGround(c.from, c.to, c.progress) : fallback;
  }
  pose(actorId, timestamp = this.now()) {
    const c = this.playbacks.get(actorId);
    return {clip: c?.clip ?? 'idle', direction: this.facing.get(actorId) ?? 'east',
      progress: c?.progress ?? (timestamp % 2400) / 2400,
      frameProgress: c?.frameProgress ?? (timestamp % WALK_CYCLE_MS) / WALK_CYCLE_MS};
  }
}

// Scan source alpha once to anchor each frame at its boot baseline. These are
// drawImage source rectangles, not edited/generated replacement bitmaps.
export function measureAtlas(image, document, columns = 4, rows = 4) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0);
  const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
  const cw = canvas.width / columns, ch = canvas.height / rows;
  return Array.from({length: columns * rows}, (_, i) => {
    const x = Math.round(i % columns * cw), y = Math.round(Math.floor(i / columns) * ch);
    let foot = 0;
    for (let dy = Math.floor(ch * .5); dy < ch; dy++) {
      let solid = 0;
      for (let dx = Math.floor(cw * .12); dx < cw * .88; dx++) if (data[((y + dy) * canvas.width + x + dx) * 4 + 3] > 160) solid++;
      if (solid >= 4) foot = dy;
    }
    return {x, y, w: Math.round(cw), h: Math.round(ch), pivotX: cw / 2, pivotY: foot};
  });
}

export function drawBarbarianFrame(context, atlases, player, actorId, point, height, character) {
  const pose = player.pose(actorId);
  const diagonal = !['east', 'west'].includes(pose.direction);
  const walkVariant = barbarianWalkVariant(character);
  const diagonalWeaponPose = ['unarmed', 'hand_axe'].includes(walkVariant);
  const unarmedPose = diagonalWeaponPose && ['idle', 'windup', 'recovery'].includes(pose.clip);
  if (pose.clip === 'walk' && !walkVariant) return false;
  if (pose.clip !== 'walk' && !unarmedPose && !supportsBarbarianAnimation(character)) return false;
  const diagonalAsset = diagonal || unarmedPose || (walkVariant === 'hand_axe' && pose.clip === 'walk');
  const assetKey = unarmedPose ? (walkVariant === 'hand_axe' ? 'diagonalHandAxe' : 'diagonalUnarmed') : pose.clip === 'walk'
    ? diagonal ? (walkVariant === 'hand_axe' ? 'diagonalHandAxe' : walkVariant === 'unarmed' ? 'diagonalUnarmed' : 'diagonal')
      : (walkVariant === 'hand_axe' ? 'diagonalHandAxe' : walkVariant === 'unarmed' ? 'walkUnarmed' : 'walk')
    : diagonal ? 'diagonal' : 'attack';
  const asset = atlases[assetKey];
  if (!asset?.frames) return false;
  const atlasDirection = (unarmedPose || (walkVariant === 'hand_axe' && pose.clip === 'walk')) && !diagonal
    ? (pose.direction === 'west' ? 'southwest' : 'southeast') : pose.direction;
  const {index} = animationCell(pose.clip, atlasDirection,
    pose.clip === 'walk' ? pose.frameProgress : pose.progress);
  const f = asset.frames[index];
  // Constant body scale per atlas: a raised arm or blade must not shrink the body.
  const bodyFraction = diagonalAsset ? .9 : pose.clip === 'walk' ? .93 : .86;
  const scale = height / (f.h * bodyFraction);
  context.drawImage(asset.image, f.x, f.y, f.w, f.h,
    point.x - f.pivotX * scale, point.y - f.pivotY * scale,
    f.w * scale, f.h * scale);
  return true;
}
