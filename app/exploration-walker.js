import { canonicalHeroSpritePath } from '../src/core/hero-visuals.js';

// Keep movement restrained: large limb rotations on a flattened character
// image look like jumping jacks, especially after the map scales it down.
const WALK_CYCLE_DISTANCE = 86;
const WALK_FRAMES = Object.freeze([
  [0, 0, 0, 0, 0],
  [-2, 2, -.3, .4, 0],
  [-3, 3, -.5, .9, 0],
  [-2, 2, -.3, .4, 0],
  [0, 0, 0, 0, 0],
  [2, -2, -.3, 0, .4],
  [3, -3, -.5, 0, .9],
  [2, -2, -.3, 0, .4],
]);
const frameImage = (part, view) => `<use href="#party-walker-source-${view}" clip-path="url(#party-walker-${part})"/>`;
const leg = (side, angle, lift, view) => `<g transform="translate(0 ${-lift}) rotate(${angle} ${side === 'left' ? '-3' : '3'} -15)">${frameImage(`${side}-leg`, view)}</g>`;

function walkFrame(index, view) {
  const [leftStep, rightStep, bodyRise, leftLift, rightLift] = WALK_FRAMES[index];
  return `<g class="party-map-walk-frame" data-walk-frame="${index}" display="none">${leg('left', leftStep, leftLift, view)}${leg('right', rightStep, rightLift, view)}<g transform="translate(0 ${bodyRise})">${frameImage('upper', view)}</g></g>`;
}

export function explorationWalkerMarkup(classId) {
  const source = canonicalHeroSpritePath(classId);
  const rearSource = `/app/assets/unit-canonical-${classId}-back-v1.png`;
  return `<defs>
    <image id="party-walker-source-front" href="${source}" x="-13" y="-34" width="26" height="36" preserveAspectRatio="xMidYMax meet"/>
    <image id="party-walker-source-rear" href="${rearSource}" x="-13" y="-34" width="26" height="36" preserveAspectRatio="xMidYMax meet"/>
    <clipPath id="party-walker-upper"><path d="M-16-36 H16 V-14 H-16Z M-16-14 H-9 V2 H-16Z M9-14 H16 V2 H9Z"/></clipPath>
    <clipPath id="party-walker-left-leg"><path d="M-9-17 H0 V2 H-9Z"/></clipPath>
    <clipPath id="party-walker-right-leg"><path d="M0-17 H9 V2 H0Z"/></clipPath>
  </defs><g class="party-map-walker" data-direction="${currentDirection}" data-walk-state="idle" data-walk-frame="idle">
    <g class="party-map-walker-facing">
      <g class="party-map-view-front"><g class="party-map-idle"><use href="#party-walker-source-front"/></g>${WALK_FRAMES.map((_, index) => walkFrame(index, 'front')).join('')}</g>
      <g class="party-map-view-rear"><g class="party-map-idle"><use href="#party-walker-source-rear"/></g>${WALK_FRAMES.map((_, index) => walkFrame(index, 'rear')).join('')}</g>
    </g>
  </g>`;
}

export function directionForWalkDelta(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < .05) return null;
  const compass = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return compass[(octant + 8) % 8];
}

let previousPosition = null;
let previousMarker = null;
let walkedDistance = 0;
let currentDirection = 'south';

export function updateExplorationWalker(marker, position, walking) {
  const walker = marker?.querySelector('.party-map-walker');
  if (!walker || !position) return;
  if (marker !== previousMarker) {
    previousMarker = marker;
    previousPosition = { x: position.x, y: position.y };
  }
  if (previousPosition && walking) {
    const dx = position.x - previousPosition.x;
    const dy = position.y - previousPosition.y;
    const moved = Math.hypot(dx, dy);
    if (moved > .05 && moved < 40) {
      walkedDistance += moved;
      currentDirection = directionForWalkDelta(dx, dy) || currentDirection;
    }
  }
  previousPosition = { x: position.x, y: position.y };
  walker.dataset.direction = currentDirection;
  const frame = walking ? Math.floor(walkedDistance / WALK_CYCLE_DISTANCE * WALK_FRAMES.length) % WALK_FRAMES.length : null;
  walker.dataset.walkState = walking ? 'walking' : 'idle';
  walker.dataset.walkFrame = frame === null ? 'idle' : String(frame);
  for (const idle of walker.querySelectorAll('.party-map-idle')) {
    idle.setAttribute('display', walking ? 'none' : 'inline');
  }
  for (const node of walker.querySelectorAll('.party-map-walk-frame')) {
    node.setAttribute('display', Number(node.dataset.walkFrame) === frame ? 'inline' : 'none');
  }
}

export const explorationWalkFrameCount = WALK_FRAMES.length;
