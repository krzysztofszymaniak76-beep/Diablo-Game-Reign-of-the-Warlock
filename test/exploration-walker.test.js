import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  directionForWalkDelta, explorationWalkFrameCount, explorationWalkerMarkup,
} from '../app/exploration-walker.js';

test('map walk retains the whole upper body and alternates restrained steps', () => {
  const markup = explorationWalkerMarkup('barbarian');
  assert.match(markup, /unit-canonical-barbarian-v1\.png/);
  assert.match(markup, /unit-canonical-barbarian-back-v1\.png/);
  assert.equal(explorationWalkFrameCount, 8);
  assert.equal((markup.match(/class="party-map-walk-frame"/g) || []).length, 16);
  for (const part of ['upper', 'left-leg', 'right-leg']) {
    assert.match(markup, new RegExp(`party-walker-${part}`));
  }
  assert.doesNotMatch(markup, /party-walker-(left|right)-(upper-arm|forearm)/,
    'arms and held equipment must not be cut away from the torso');
  const thighPoses = [...markup.matchAll(/class="party-map-walk-frame" data-walk-frame="\d" display="none"><g transform="translate\(0 [-\d.]+\) rotate\(([-\d.]+) -3 -15\)/g)]
    .map(([, angle]) => Number(angle));
  assert.equal(thighPoses.length, 16);
  assert.ok(thighPoses.includes(-3) && thighPoses.includes(3));
  assert.ok(thighPoses.every(angle => Math.abs(angle) <= 3), 'legs must not swing outward into a jumping-jack pose');
  assert.doesNotMatch(markup, /party-map-walker-back/, 'the fake rear-view patch must not cover the character');
});

test('every selectable hero has a separate rear view', () => {
  for (const classId of ['amazon', 'assassin', 'necromancer', 'barbarian', 'paladin', 'sorceress', 'warlock', 'druid']) {
    const asset = new URL(`../app/assets/unit-canonical-${classId}-back-v1.png`, import.meta.url);
    assert.ok(existsSync(asset), classId);
    assert.match(explorationWalkerMarkup(classId), new RegExp(`unit-canonical-${classId}-back-v1\\.png`));
  }
});

test('map walker distinguishes all eight travel directions', () => {
  assert.equal(directionForWalkDelta(1, 0), 'east');
  assert.equal(directionForWalkDelta(1, 1), 'southeast');
  assert.equal(directionForWalkDelta(0, 1), 'south');
  assert.equal(directionForWalkDelta(-1, 1), 'southwest');
  assert.equal(directionForWalkDelta(-1, 0), 'west');
  assert.equal(directionForWalkDelta(-1, -1), 'northwest');
  assert.equal(directionForWalkDelta(0, -1), 'north');
  assert.equal(directionForWalkDelta(1, -1), 'northeast');
  assert.equal(directionForWalkDelta(0, 0), null);
});
