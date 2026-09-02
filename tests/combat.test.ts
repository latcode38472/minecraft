// Knockback and sprinting.
//
// Both are about a number turning into movement, so these tests measure the
// movement rather than the number: how far a shove actually carries a mob, and
// how much food running actually costs.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  FIST_KNOCKBACK,
  KNOCKBACK_TIME_S,
  HUNGER_IDLE_DRAIN_PER_S,
  HUNGER_SPRINT_COST_PER_BLOCK,
  HUNGER_WALK_COST_PER_BLOCK,
  MAX_HUNGER,
  MAX_KNOCKBACK,
  SPRINT_MIN_HUNGER,
  SPRINT_SPEED,
  WALK_SPEED,
} from '../src/constants.ts';
import {
  arrowKnockback,
  attackKnockback,
  clampKnockback,
  knockbackDistance,
  knockbackLift,
} from '../src/shared/combat.ts';
import { allItems, getItem } from '../src/items/items.ts';
import { MOB_DEFS } from '../src/shared/mobs.ts';
import { MobSim } from '../src/shared/mobsim.ts';
import { RoomSimulation } from '../src/shared/roomsim.ts';
import { Survival } from '../src/player/survival.ts';
import type { Player } from '../src/player/player.ts';
import { ServerWorld } from '../server/world.ts';

const NO_EVENTS = { onPlayerHit() {}, onMobDied() {}, onMobShoot() {} };

/** A flat stone field, so a shove is measured against nothing but itself. */
function arena(seed = 99) {
  const edits = new Map<string, Map<number, number>>();
  const world = new ServerWorld(seed, edits);
  const at = { x: 600, y: 50, z: 600 };
  for (let dz = -20; dz <= 20; dz++) {
    for (let dx = -20; dx <= 20; dx++) {
      const x = at.x + dx;
      const z = at.z + dz;
      world.getBlock(x, at.y, z); // load the chunk so the edit lands
      const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
      let chunk = edits.get(key);
      if (!chunk) {
        chunk = new Map();
        edits.set(key, chunk);
      }
      const lx = ((x % 16) + 16) % 16;
      const lz = ((z % 16) + 16) % 16;
      for (let dy = 0; dy <= 5; dy++) {
        const id = dy === 0 ? 3 : 0; // stone floor, air above
        chunk.set(lx + lz * 16 + (at.y + dy) * 256, id);
        world.applyEdit(x, at.y + dy, z, id);
      }
    }
  }
  return { world, floor: at.y + 1, x: at.x, z: at.z };
}

/**
 * How far a shove of this strength carries a mob.
 *
 * Measured over the shove itself, not afterwards: a struck animal then runs
 * away under its own steam, and that flight is behaviour, not knockback.
 */
function shoveDistance(kind: 'pig' | 'zombie' | 'cow', strength: number): number {
  const { world, floor, x, z } = arena();
  const mob = new MobSim(kind, x + 0.5, floor, z + 0.5);
  // Let it settle onto the floor first, so the lift has ground to push off.
  for (let t = 0; t < 0.5; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  const start = { x: mob.position.x, z: mob.position.z };
  // Hit from due west, so the shove runs along +x.
  mob.takeDamage(1, mob.position.x - 1, mob.position.z, 'p1', strength);
  for (let t = 0; t < KNOCKBACK_TIME_S; t += 0.02) mob.update(0.02, world, [], NO_EVENTS);
  return Math.hypot(mob.position.x - start.x, mob.position.z - start.z);
}

// --- The registry -----------------------------------------------------------

test('every way of dealing damage carries its own knockback', () => {
  const of = (id: string): number => attackKnockback({ id, count: 1 });
  const seen = new Map<number, string[]>();
  for (const item of allItems()) {
    if (!item.attack) continue;
    const k = item.attack.knockback;
    assert.ok(k > 0, `${item.id} has no knockback`);
    seen.set(k, [...(seen.get(k) ?? []), item.id]);
  }
  assert.ok(seen.size >= 8, `expected a spread of strengths, got ${seen.size}`);

  // A bare hand is the weakest thing that is not a tool being misused.
  assert.equal(of('shears') < FIST_KNOCKBACK, true, 'shears snip rather than shove');
  assert.ok(of('wooden_sword') > FIST_KNOCKBACK, 'a sword beats a fist');

  // Within a tier: pickaxe < sword < axe. Heavier swings shove harder.
  for (const tier of ['wooden', 'stone', 'iron', 'diamond']) {
    assert.ok(of(`${tier}_pickaxe`) < of(`${tier}_sword`), `${tier}: pickaxe under sword`);
    assert.ok(of(`${tier}_sword`) < of(`${tier}_axe`), `${tier}: sword under axe`);
  }
  // And along the tiers, each material shoves harder than the last.
  for (const kind of ['sword', 'axe', 'pickaxe']) {
    const ladder = ['wooden', 'stone', 'iron', 'diamond'].map((t) => of(`${t}_${kind}`));
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(ladder[i] > ladder[i - 1], `${kind} tier ${i} shoves harder than ${i - 1}`);
    }
  }
  // An arrow is its own thing, between a fist and a sword.
  assert.ok(arrowKnockback() > FIST_KNOCKBACK && arrowKnockback() < of('diamond_sword'));
});

test('nothing is shoved far: the hardest hit moves a target about a block', () => {
  const strengths = allItems()
    .filter((i) => i.attack)
    .map((i) => i.attack!.knockback);
  const hardest = Math.max(...strengths, arrowKnockback(), MOB_DEFS.zombie.knockback);
  assert.ok(hardest <= MAX_KNOCKBACK, `${hardest} is over the cap`);
  assert.ok(
    knockbackDistance(hardest) <= 1.2,
    `the hardest hit throws things ${knockbackDistance(hardest).toFixed(2)} blocks`,
  );
  assert.ok(
    knockbackDistance(FIST_KNOCKBACK) >= 0.4,
    'a punch should still visibly move something',
  );
  // The cap holds however silly the request.
  assert.equal(clampKnockback(1e6), MAX_KNOCKBACK);
  assert.equal(clampKnockback(-5), 0);
  assert.equal(clampKnockback(Number.NaN), 0);
  assert.ok(knockbackLift(FIST_KNOCKBACK) > 0, 'a hit pops the target up a little');
  assert.ok(
    knockbackLift(MAX_KNOCKBACK) < 4,
    'but never launches it — that would read as a bug, not a hit',
  );
});

test('an unarmed hand and a mob without a weapon are handled', () => {
  assert.equal(attackKnockback(null), FIST_KNOCKBACK);
  assert.equal(attackKnockback(undefined), FIST_KNOCKBACK);
  assert.equal(attackKnockback({ id: 'dirt', count: 1 }), FIST_KNOCKBACK, 'a block is a fist');
  assert.equal(attackKnockback({ id: 'not_an_item', count: 1 }), FIST_KNOCKBACK);
  assert.equal(MOB_DEFS.zombie.knockback > 0, true, 'a zombie shoves you');
  assert.equal(MOB_DEFS.cow.knockback, 0, 'a cow does not');
});

// --- The movement it produces ----------------------------------------------

test('a shove actually moves a mob, roughly as far as the maths says', () => {
  const fist = shoveDistance('pig', FIST_KNOCKBACK);
  assert.ok(fist > 0.2, `a punched pig barely moved: ${fist.toFixed(2)} blocks`);
  assert.ok(fist < 1.5, `a punched pig flew: ${fist.toFixed(2)} blocks`);
  // Within a wide tolerance of the predicted strength/drag — collisions,
  // gravity and the flee that follows all nudge the real number.
  const predicted = knockbackDistance(FIST_KNOCKBACK);
  assert.ok(
    Math.abs(fist - predicted) < predicted,
    `moved ${fist.toFixed(2)}, predicted about ${predicted.toFixed(2)}`,
  );
});

test('a heavier weapon shoves further than a lighter one', () => {
  const fist = shoveDistance('pig', FIST_KNOCKBACK);
  const sword = shoveDistance('pig', getItem('diamond_sword')!.attack!.knockback);
  const axe = shoveDistance('pig', getItem('diamond_axe')!.attack!.knockback);
  assert.ok(sword > fist, `sword ${sword.toFixed(2)} should beat fist ${fist.toFixed(2)}`);
  assert.ok(axe > sword, `axe ${axe.toFixed(2)} should beat sword ${sword.toFixed(2)}`);
  assert.ok(axe < 1.5, `even the axe must stay close: ${axe.toFixed(2)} blocks`);
});

test('a struck animal runs away afterwards — that is flight, not knockback', () => {
  const { world, floor, x, z } = arena();
  const mob = new MobSim('pig', x + 0.5, floor, z + 0.5);
  for (let t = 0; t < 0.5; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  mob.takeDamage(1, mob.position.x - 1, mob.position.z, 'p1', FIST_KNOCKBACK);
  // The shove is over well before the flight is.
  for (let t = 0; t < KNOCKBACK_TIME_S; t += 0.02) mob.update(0.02, world, [], NO_EVENTS);
  const afterShove = mob.position.x;
  for (let t = 0; t < 1.5; t += 0.02) mob.update(0.02, world, [], NO_EVENTS);
  assert.ok(
    mob.position.x > afterShove + 0.5,
    'a hit pig should keep running once the shove lets go',
  );
});

test('a shove pushes away from the attacker, not just anywhere', () => {
  const { world, floor, x, z } = arena();
  const mob = new MobSim('cow', x + 0.5, floor, z + 0.5);
  for (let t = 0; t < 0.5; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  const startX = mob.position.x;
  // Struck from the east: it must travel west.
  mob.takeDamage(1, mob.position.x + 1, mob.position.z, 'p1', 6);
  for (let t = 0; t < 0.4; t += 0.02) mob.update(0.02, world, [], NO_EVENTS);
  assert.ok(mob.position.x < startX - 0.1, `pushed the wrong way: ${mob.position.x - startX}`);
});

test('a shove overrides the mob\'s own movement while it lasts, then hands back', () => {
  const { world, floor, x, z } = arena();
  const mob = new MobSim('zombie', x + 0.5, floor, z + 0.5);
  for (let t = 0; t < 0.5; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  mob.takeDamage(1, mob.position.x - 1, mob.position.z, 'p1', 6);
  assert.ok(mob.knockbackTime > 0, 'the shove is running');
  // Mid-shove the mob is still carried, even though its AI wants to wander.
  mob.update(0.05, world, [], NO_EVENTS);
  assert.ok(mob.velocity.x > 1, `the AI cancelled the shove: vx=${mob.velocity.x}`);
  // Once it expires the mob is its own again.
  for (let t = 0; t < 1.2; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  assert.equal(mob.knockbackTime, 0, 'the shove ended');
});

test('the room passes an attacker\'s weapon strength through to the mob', () => {
  const { world, floor, x, z } = arena();
  const sim = new RoomSimulation(world, { damagePlayer: () => {}, giveItems: () => 0 });
  const soft = new MobSim('cow', x + 0.5, floor, z + 0.5);
  const hard = new MobSim('cow', x + 6.5, floor, z + 0.5);
  sim.addMob(soft);
  sim.addMob(hard);
  const players = [{ id: 'p1', position: { x, y: floor, z }, dead: false }];
  for (let t = 0; t < 0.5; t += 0.05) sim.update(0.05, players);

  const softStart = soft.position.x;
  const hardStart = hard.position.x;
  sim.damageMob(soft.id, 1, 'p1', { x: soft.position.x - 1, y: floor, z: soft.position.z }, 3);
  sim.damageMob(hard.id, 1, 'p1', { x: hard.position.x - 1, y: floor, z: hard.position.z }, 6.5);
  for (let t = 0; t < 0.6; t += 0.02) sim.update(0.02, players);

  const softMoved = soft.position.x - softStart;
  const hardMoved = hard.position.x - hardStart;
  assert.ok(hardMoved > softMoved, `weak ${softMoved.toFixed(2)} vs strong ${hardMoved.toFixed(2)}`);
});

test('a mob standing exactly on the attacker is still shoved somewhere', () => {
  const { world, floor, x, z } = arena();
  const mob = new MobSim('pig', x + 0.5, floor, z + 0.5);
  for (let t = 0; t < 0.5; t += 0.05) mob.update(0.05, world, [], NO_EVENTS);
  // Same column: the direction is degenerate and must not become NaN.
  mob.takeDamage(1, mob.position.x, mob.position.z, 'p1', 5);
  assert.ok(Number.isFinite(mob.velocity.x) && Number.isFinite(mob.velocity.z));
  assert.ok(Math.hypot(mob.velocity.x, mob.velocity.z) > 1, 'it went somewhere');
});

// --- Sprinting --------------------------------------------------------------

/** Just enough of a Player for Survival to read, with a sprint switch. */
class StubRunner {
  position = new THREE.Vector3(0, 40, 0);
  eyeInWater = false;
  feetInWater = false;
  sprinting = false;
  takeFallDistance(): number {
    return 0;
  }
}

/** Hunger spent covering `blocks` at the given gait. */
function hungerOver(blocks: number, sprinting: boolean): number {
  const player = new StubRunner();
  player.sprinting = sprinting;
  const survival = new Survival({
    onHurt: () => {},
    onDeath: () => {},
    armorPoints: () => 0,
    isBlocking: () => false,
    onAbsorb: () => {},
  });
  const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
  const dt = 0.05;
  const before = survival.hunger;
  for (let travelled = 0; travelled < blocks; travelled += speed * dt) {
    player.position.x += speed * dt;
    survival.update(dt, player as unknown as Player);
  }
  return before - survival.hunger;
}

test('sprinting is faster than walking, but not a different game', () => {
  assert.ok(SPRINT_SPEED > WALK_SPEED, 'sprinting must actually be quicker');
  const ratio = SPRINT_SPEED / WALK_SPEED;
  assert.ok(ratio > 1.15 && ratio < 1.5, `sprint is ${ratio.toFixed(2)}x walking`);
});

test('sprinting costs more food per block — noticeably, not punishingly', () => {
  const walked = hungerOver(200, false);
  const sprinted = hungerOver(200, true);
  assert.ok(sprinted > walked, 'running must cost more than walking');
  const ratio = sprinted / walked;
  assert.ok(ratio > 1.5, `sprinting only costs ${ratio.toFixed(2)}x walking per block`);
  assert.ok(ratio < 4, `sprinting costs ${ratio.toFixed(2)}x walking per block, which is punishing`);
  assert.equal(
    HUNGER_SPRINT_COST_PER_BLOCK > HUNGER_WALK_COST_PER_BLOCK,
    true,
    'the per-block constant is the higher one',
  );
});

test('a full stomach is worth minutes of running, not seconds', () => {
  const perSecond = HUNGER_IDLE_DRAIN_PER_S + HUNGER_SPRINT_COST_PER_BLOCK * SPRINT_SPEED;
  const minutes = MAX_HUNGER / perSecond / 60;
  assert.ok(minutes > 4, `constant sprinting empties the bar in ${minutes.toFixed(1)} min`);
  assert.ok(minutes < 15, `sprinting barely costs anything: ${minutes.toFixed(1)} min`);
  // And you have to eat before you can run again.
  assert.ok(SPRINT_MIN_HUNGER > 0 && SPRINT_MIN_HUNGER < MAX_HUNGER / 2);
});
