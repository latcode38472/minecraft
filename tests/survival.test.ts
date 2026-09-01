// Tests for health, breath and drowning.
//
// Survival only ever reads three things off the player — position, fall
// distance and whether the eyes are underwater — so a stub stands in for it and
// the real Survival class runs here unmodified.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  AIR_BUBBLES,
  DROWN_DAMAGE,
  MAX_AIR,
  MAX_HEALTH,
} from '../src/constants.ts';
import { bubblesFor, Survival, type SurvivalHooks } from '../src/player/survival.ts';
import type { Player } from '../src/player/player.ts';

/** Just enough of a Player for Survival to read. */
class StubPlayer {
  position = new THREE.Vector3(0, 40, 0);
  eyeInWater = false;
  private fall = 0;
  setFall(blocks: number): void {
    this.fall = blocks;
  }
  takeFallDistance(): number {
    const f = this.fall;
    this.fall = 0;
    return f;
  }
}

interface Rig {
  survival: Survival;
  player: StubPlayer;
  deaths: number;
  pops: number[];
  /** Run `seconds` of game time in 1/20s steps, the way the frame loop does. */
  run(seconds: number): void;
}

function rig(hooks: Partial<SurvivalHooks> = {}): Rig {
  const player = new StubPlayer();
  const state = { deaths: 0, pops: [] as number[] };
  const survival = new Survival({
    onHurt: () => {},
    onDeath: () => state.deaths++,
    armorPoints: () => 0,
    isBlocking: () => false,
    onAbsorb: () => {},
    onBubblePop: (remaining) => state.pops.push(remaining),
    ...hooks,
  });
  return {
    survival,
    player,
    get deaths() {
      return state.deaths;
    },
    get pops() {
      return state.pops;
    },
    run(seconds: number) {
      const step = 1 / 20;
      for (let t = 0; t < seconds - 1e-9; t += step) {
        survival.update(step, player as unknown as Player);
      }
    },
  };
}

test('breath is full on land and stays there', () => {
  const r = rig();
  r.run(30);
  assert.equal(r.survival.air, MAX_AIR, 'standing about must not cost air');
  assert.equal(r.survival.health, MAX_HEALTH);
  assert.equal(r.pops.length, 0, 'and no bubbles should burst');
});

test('air drains a second per second while submerged', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(5);
  assert.ok(Math.abs(r.survival.air - (MAX_AIR - 5)) < 0.06, `air was ${r.survival.air}`);
  assert.equal(r.survival.health, MAX_HEALTH, 'breath alone costs no health');
});

test('running out of air is not itself damage; the drowning starts a second later', () => {
  const r = rig();
  r.player.eyeInWater = true;

  r.run(MAX_AIR);
  assert.equal(r.survival.air, 0, 'the air should be gone');
  assert.equal(r.survival.health, MAX_HEALTH, 'but the first breath missed is free');

  // One second on, the first heart goes.
  r.run(1);
  assert.equal(r.survival.health, MAX_HEALTH - DROWN_DAMAGE);

  // And it keeps costing, once a second.
  r.run(3);
  assert.equal(r.survival.health, MAX_HEALTH - DROWN_DAMAGE * 4);
});

test('drowning ignores armour and a raised shield', () => {
  // Full diamond and a shield up: neither keeps water out of your lungs.
  const r = rig({ armorPoints: () => 20, isBlocking: () => true });
  r.player.eyeInWater = true;
  r.run(MAX_AIR + 1);
  assert.equal(
    r.survival.health,
    MAX_HEALTH - DROWN_DAMAGE,
    'armour must not soften drowning damage',
  );
});

test('drowning damage is not gated by the hurt cooldown', () => {
  // Ordinary hits are ignored for HURT_INVULN_S after one lands. If drowning
  // went through that path, taking a hit underwater would skip a drown tick.
  const r = rig();
  r.player.eyeInWater = true;
  r.run(MAX_AIR + 0.5);
  r.survival.damage(1); // an ordinary hit, which starts the cooldown
  const afterHit = r.survival.health;
  r.run(1);
  assert.ok(
    r.survival.health <= afterHit - DROWN_DAMAGE,
    `drowning stalled behind the hurt cooldown: ${afterHit} -> ${r.survival.health}`,
  );
});

test('drowning kills, and the death screen can name it', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(MAX_AIR + MAX_HEALTH / DROWN_DAMAGE + 1);
  assert.ok(r.survival.dead, 'ten hearts of drowning should be fatal');
  assert.equal(r.deaths, 1, 'and must report the death exactly once');
  assert.equal(r.survival.lastCause, 'drown');
});

test('a dead player stops drowning further', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(60);
  assert.equal(r.deaths, 1, 'death must fire once, not once per second underwater');
  assert.equal(r.survival.health, 0);
});

test('surfacing refills the lungs quickly and stops the damage', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(MAX_AIR + 2);
  const hurt = r.survival.health;
  assert.ok(hurt < MAX_HEALTH, 'the test needs the player to actually be drowning');

  r.player.eyeInWater = false;
  r.run(0.5);
  assert.equal(r.survival.health, hurt, 'the moment you surface the drowning stops');
  assert.ok(r.survival.air > 1.5, `a gulp of air should count, got ${r.survival.air}`);

  // Fully recovered well before the fifteen seconds it took to spend.
  r.run(4);
  assert.equal(r.survival.air, MAX_AIR);
});

test('a bobbing head does not accumulate drowning between dips', () => {
  const r = rig();
  for (let i = 0; i < 8; i++) {
    r.player.eyeInWater = true;
    r.run(4);
    r.player.eyeInWater = false;
    r.run(4);
  }
  assert.equal(r.survival.health, MAX_HEALTH, 'surfacing in time must be completely safe');
  assert.equal(r.survival.air, MAX_AIR);
});

test('ten bubbles burst, one at a time, on the way down', () => {
  assert.equal(bubblesFor(MAX_AIR), AIR_BUBBLES, 'a full bar is every bubble');
  assert.equal(bubblesFor(0), 0, 'and an empty one is none');

  const r = rig();
  r.player.eyeInWater = true;
  r.run(MAX_AIR);
  assert.equal(r.pops.length, AIR_BUBBLES, `expected ${AIR_BUBBLES} pops, got ${r.pops.length}`);
  // Reported counts must descend to zero without skipping or repeating.
  assert.deepEqual(r.pops, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('refilling air does not fire the bubble sound', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(6);
  const duringDive = r.pops.length;
  r.player.eyeInWater = false;
  r.run(6);
  assert.equal(r.pops.length, duringDive, 'bubbles burst on the way out, not on the way in');
});

test('the HUD is told the moment the air stops being full', () => {
  // The bubble bar appears as soon as your head goes under, showing all ten,
  // rather than staying hidden until the first of them bursts. Redraws are
  // driven off `version`, so it has to move on that first fraction of a second.
  const r = rig();
  const before = r.survival.version;
  r.player.eyeInWater = true;
  r.run(0.1);
  assert.ok(r.survival.air > MAX_AIR - 1, 'this is meant to be the very first moment under');
  assert.equal(bubblesFor(r.survival.air), AIR_BUBBLES, 'with every bubble still showing');
  assert.ok(r.survival.version > before, 'a version bump is what makes the bar appear');
  assert.equal(r.pops.length, 0, 'and nothing has burst yet');

  // Likewise on the way back: the bar has to be told to go away again.
  r.player.eyeInWater = false;
  r.run(10);
  const full = r.survival.version;
  assert.equal(r.survival.air, MAX_AIR);
  r.run(5);
  assert.equal(r.survival.version, full, 'a full bar should stop redrawing once it is hidden');
});

test('respawning gives the lungs back', () => {
  const r = rig();
  r.player.eyeInWater = true;
  r.run(MAX_AIR + 20);
  assert.ok(r.survival.dead);

  r.survival.respawn();
  assert.equal(r.survival.air, MAX_AIR);
  assert.equal(r.survival.health, MAX_HEALTH);
  assert.equal(r.survival.lastCause, 'generic');

  // And the drown clock must have been reset with it: a fresh spawn underwater
  // gets the full fifteen seconds, not an instant second death.
  r.run(1);
  assert.equal(r.survival.health, MAX_HEALTH, 'respawn must not inherit the old drown timer');
});

test('other deaths are named too', () => {
  const fall = rig();
  fall.player.setFall(12);
  fall.run(0.05);
  assert.equal(fall.survival.lastCause, 'fall');

  const starve = rig();
  starve.survival.eat(-MAX_HEALTH); // no-op; hunger is drained below instead
  starve.run(60 * 20); // long enough to empty the hunger bar and start starving
  assert.equal(starve.survival.lastCause, 'starve');
});
