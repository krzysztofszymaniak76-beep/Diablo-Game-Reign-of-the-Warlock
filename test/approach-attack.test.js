import test from 'node:test';
import assert from 'node:assert/strict';
import { planApproachAttack } from '../src/core/approach-attack.js';
import { ACTION_TIME, ATTACK_IMPACT_OFFSET, CombatState } from '../src/core/combat.js';
import { createCharacter, Roster } from '../src/core/characters.js';
import { Party } from '../src/core/party.js';
import { PlayersSetting } from '../src/core/players.js';
import { HexGrid, axial, hexDisk } from '../src/core/hex-grid.js';

function makeGrid({ hero = axial(0, 0), enemy = axial(3, 0), blockedTerrain = [] } = {}) {
  const grid = new HexGrid({ tiles: hexDisk(axial(0, 0), 7), blockedTerrain });
  grid.addUnit({ id: 'hero', position: hero });
  grid.addUnit({ id: 'enemy', position: enemy });
  return grid;
}

function makeCombat() {
  const roster = new Roster([createCharacter({ id: 'hero', name: 'Hero', classId: 'barbarian' })]);
  const party = new Party(roster, ['hero']);
  const playersSetting = new PlayersSetting(1);
  const combat = new CombatState({ party, playersSetting, seed: 31 });
  const enemy = combat.spawnMonster({ id: 'enemy', name: 'Enemy', baseHp: 30, baseExperience: 1, position: axial(3, 0) });
  combat.units.get('hero').position = axial(0, 0);
  enemy.readyAt = 9999;
  return { roster, party, playersSetting, combat, enemy };
}

function submitApproach(combat, grid, path, { damage = 5, transactionId = 'approach-1' } = {}) {
  const distance = path.length - 1;
  const moveDuration = distance * ACTION_TIME.movePerTile;
  const targetAnchor = grid.positionOf('enemy');
  const events = [
    ...path.slice(1).map((to, index) => ({
      offset: (index + 1) * ACTION_TIME.movePerTile,
      kind: 'move:step',
      payload: { from: path[index], to, stepIndex: index + 1, stepCount: distance },
    })),
    {
      offset: moveDuration + ATTACK_IMPACT_OFFSET,
      kind: 'attack:impact',
      payload: { targetId: 'enemy', damage, range: 1, attackType: 'melee', plannedTargetAnchor: targetAnchor, requireStableTargetAnchor: true },
    },
  ];
  const result = combat.submitSequence('hero', 'approachAttack', {
    distance,
    path,
    to: path.at(-1),
    targetId: 'enemy',
    plannedTargetAnchor: targetAnchor,
    requireStableTargetAnchor: true,
  }, { events, transactionId });
  const moveEvents = result.events.filter((event) => event.kind === 'move:step');
  moveEvents.forEach((event, index) => grid.reserveStep({
    commandId: result.commandId,
    eventId: event.id,
    unitId: 'hero',
    at: event.at,
    from: path[index],
    to: path[index + 1],
  }));
  return result;
}

function advance(combat, grid) {
  return combat.advanceTimeline(['hero', 'enemy'], {
    resolve: (event, resolveCore) => {
      if (event.kind === 'move:step') {
        const moved = grid.commitReservedStep(event.id);
        if (!moved) throw new Error('movement step became blocked');
      }
      if (event.kind === 'attack:impact') {
        const target = grid.positionOf(event.payload.targetId);
        if (event.payload.requireStableTargetAnchor
          && (target.q !== event.payload.plannedTargetAnchor.q || target.r !== event.payload.plannedTargetAnchor.r)) {
          throw new Error('target left planned anchor');
        }
      }
      return resolveCore();
    },
    onInterrupt: ({ command }) => grid.releaseReservationsByCommand(command.commandId),
  });
}

test('planner returns in-range without inventing movement', () => {
  const grid = makeGrid({ enemy: axial(1, 0) });
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  assert.equal(plan.type, 'in-range');
  assert.equal(plan.moveSteps, 0);
  assert.deepEqual(plan.path, [axial(0, 0)]);
});

test('planner chooses a deterministic legal adjacent attack hex', () => {
  const grid = makeGrid({ enemy: axial(3, 0) });
  const first = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  const second = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  assert.equal(first.type, 'approach');
  assert.equal(first.moveSteps, 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first.path.at(0), axial(0, 0));
  assert.equal(first.path.length, 3);
});

test('planner refuses implicit movement when the legal attack position exceeds the existing move budget', () => {
  const grid = makeGrid({ enemy: axial(6, 0) });
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  assert.equal(plan.type, 'unreachable');
  assert.equal(plan.path, null);
  assert.deepEqual(grid.positionOf('hero'), axial(0, 0));
});

test('planner routes around blocked terrain without entering the enemy footprint', () => {
  const grid = makeGrid({ enemy: axial(3, 0), blockedTerrain: [axial(1, 0)] });
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  assert.equal(plan.type, 'approach');
  assert.ok(plan.path.every((cell) => !(cell.q === 1 && cell.r === 0)));
  assert.ok(plan.path.every((cell) => !(cell.q === 3 && cell.r === 0)));
});

test('approachAttack is one authoritative command with movement plus attack recovery', () => {
  const grid = makeGrid({ enemy: axial(3, 0) });
  const { combat, enemy } = makeCombat();
  combat.nextReady(['hero', 'enemy']);
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  const result = submitApproach(combat, grid, plan.path);
  assert.equal(result.duration, plan.moveSteps * ACTION_TIME.movePerTile + ACTION_TIME.attack);
  assert.equal(result.events.filter((event) => event.kind === 'move:step').length, plan.moveSteps);
  assert.equal(result.events.filter((event) => event.kind === 'attack:impact').length, 1);

  while (combat.scheduler.time < result.recoveryEnd) {
    const boundary = advance(combat, grid);
    if (boundary.type === 'ready') break;
  }
  assert.deepEqual(grid.positionOf('hero'), plan.attackAnchor);
  assert.equal(enemy.hp, 25);
  assert.equal(combat.commandHistory.filter(({ transactionId }) => transactionId === 'approach-1').length, 1);
});

test('a dynamic blocker interrupts the combined command before the hit and leaves no reservations', () => {
  const grid = makeGrid({ enemy: axial(3, 0) });
  const { combat, enemy } = makeCombat();
  combat.nextReady(['hero', 'enemy']);
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  const command = submitApproach(combat, grid, plan.path, { transactionId: 'blocked-approach' });
  const first = advance(combat, grid);
  assert.equal(first.event.kind, 'move:step');
  grid.addUnit({ id: 'blocker', position: plan.path[2] });
  const interrupted = advance(combat, grid);
  assert.equal(interrupted.type, 'interrupted');
  assert.equal(interrupted.interruption.command.commandId, command.commandId);
  assert.equal(enemy.hp, 30);
  assert.equal(grid.reservations().length, 0);
  assert.ok(!combat.timelinePreview(20).some((event) => event.payload?.commandId === command.commandId));
});

test('a target that changes anchor before impact invalidates the combined hit', () => {
  const grid = makeGrid({ enemy: axial(3, 0) });
  const { combat, enemy } = makeCombat();
  combat.nextReady(['hero', 'enemy']);
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  const command = submitApproach(combat, grid, plan.path, { transactionId: 'moving-target' });
  for (let index = 0; index < plan.moveSteps; index += 1) {
    const boundary = advance(combat, grid);
    assert.equal(boundary.event.kind, 'move:step');
  }
  const enemyMoved = grid.moveUnit('enemy', axial(3, -1));
  assert.ok(enemyMoved);
  combat.units.get('enemy').position = axial(3, -1);
  const interrupted = advance(combat, grid);
  assert.equal(interrupted.type, 'interrupted');
  assert.equal(interrupted.interruption.command.commandId, command.commandId);
  assert.equal(enemy.hp, 30);
});

test('save/restore during approach preserves the combined command, reservations, and future hit', () => {
  const grid = makeGrid({ enemy: axial(3, 0) });
  const { party, playersSetting, combat } = makeCombat();
  combat.nextReady(['hero', 'enemy']);
  const plan = planApproachAttack({ grid, actorId: 'hero', targetId: 'enemy', range: 1, maxMoveCost: 3 });
  submitApproach(combat, grid, plan.path, { damage: 6, transactionId: 'save-mid-approach' });
  const first = advance(combat, grid);
  assert.equal(first.event.kind, 'move:step');

  const restoredCombat = CombatState.restore(structuredClone(combat.snapshot()), { party, playersSetting });
  const restoredGrid = HexGrid.restore(structuredClone(grid.snapshot()));
  assert.deepEqual(restoredCombat.timelinePreview(20), combat.timelinePreview(20));
  assert.deepEqual(restoredGrid.reservations(), grid.reservations());

  let guard = 0;
  while (restoredCombat.activeCommands.size && guard++ < 20) advance(restoredCombat, restoredGrid);
  assert.ok(guard < 20);
  assert.deepEqual(restoredGrid.positionOf('hero'), plan.attackAnchor);
  assert.equal(restoredCombat.units.get('enemy').hp, 24);
  const history = restoredCombat.commandHistory.filter(({ transactionId }) => transactionId === 'save-mid-approach');
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, 'approachAttack');
  assert.equal(history[0].status, 'effects-complete');
});
