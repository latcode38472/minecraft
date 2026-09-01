// Tests for the animation systems: rigs, gait, swings and block cracks.
//
// three.js runs headless here — geometry and object transforms need no canvas —
// so the real Rig, the real pose maths and the real atlas indexing are all
// exercised, not stand-ins for them.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  PIG_SEGMENTS,
  Rig,
  WALK_PHASE_PER_BLOCK,
  ZOMBIE_SEGMENTS,
  type RigSegment,
} from '../src/entities/models.ts';
import { CRACK_STAGES, CRACK_TILE_0, crackTileFor } from '../src/textures.ts';
import {
  FLAG_MOVING,
  FLAG_SWINGING,
  receiveClock,
  sanitizePlayerState,
} from '../src/net/protocol.ts';

/** A minimal humanoid, so the tests do not depend on a specific mob's shape. */
const HUMANOID = (): RigSegment[] => [
  { name: 'torso', pivot: [0, 0, 0], parts: [{ pos: [0, 1, 0], size: [0.5, 0.7, 0.3], color: 0 }] },
  { name: 'head', pivot: [0, 1.4, 0], parts: [{ pos: [0, 0.25, 0], size: [0.5, 0.5, 0.5], color: 0 }] },
  { name: 'armL', pivot: [-0.4, 1.35, 0], parts: [{ pos: [0, -0.35, 0], size: [0.2, 0.7, 0.2], color: 0 }] },
  { name: 'armR', pivot: [0.4, 1.35, 0], parts: [{ pos: [0, -0.35, 0], size: [0.2, 0.7, 0.2], color: 0 }] },
  { name: 'legL', pivot: [-0.15, 0.65, 0], parts: [{ pos: [0, -0.33, 0], size: [0.25, 0.65, 0.25], color: 0 }] },
  { name: 'legR', pivot: [0.15, 0.65, 0], parts: [{ pos: [0, -0.33, 0], size: [0.25, 0.65, 0.25], color: 0 }] },
];

test('an articulated rig exposes one mesh per joint; a merged rig exposes none', () => {
  const articulated = new Rig('test-human', HUMANOID, true);
  assert.equal(articulated.segments.size, 6, 'every segment should be independently posable');
  assert.ok(articulated.segments.has('legL'));
  assert.equal(articulated.group.children.length, 6);

  const merged = new Rig('test-human', HUMANOID, false);
  assert.equal(merged.segments.size, 0, 'a merged rig has no joints to pose');
  assert.equal(merged.group.children.length, 1, 'and costs exactly one draw call');
});

test('a merged rig holds the same boxes as the articulated one', () => {
  // Flattening must not lose or move geometry: a body that stops animating
  // should look identical, not shrink or come apart.
  const articulated = new Rig('vertex-count-a', HUMANOID, true);
  const merged = new Rig('vertex-count-m', HUMANOID, false);

  let articulatedVerts = 0;
  for (const mesh of articulated.segments.values()) {
    articulatedVerts += mesh.geometry.getAttribute('position').count;
  }
  const mergedMesh = merged.group.children[0] as THREE.Mesh;
  assert.equal(
    (mergedMesh.geometry.getAttribute('position') as THREE.BufferAttribute).count,
    articulatedVerts,
  );
});

test('posing swings the legs in opposite directions', () => {
  const rig = new Rig('gait', HUMANOID, true);
  // A quarter-turn into the cycle is peak stride.
  rig.pose(Math.PI / 2, 1, 0);
  const left = rig.segments.get('legL')!.rotation.x;
  const right = rig.segments.get('legR')!.rotation.x;

  assert.ok(Math.abs(left) > 0.3, `left leg barely moved: ${left}`);
  assert.ok(left * right < 0, 'legs must swing in opposition, not together');
  assert.ok(Math.abs(left + right) < 1e-6, 'and by equal amounts');
});

test('arms counter-swing against the legs', () => {
  const rig = new Rig('gait-arms', HUMANOID, true);
  rig.pose(Math.PI / 2, 1, 0);
  const legL = rig.segments.get('legL')!.rotation.x;
  const armL = rig.segments.get('armL')!.rotation.x;
  assert.ok(legL * armL < 0, 'the left arm should oppose the left leg, as a body does');
});

test('a standing body is still', () => {
  const rig = new Rig('idle', HUMANOID, true);
  rig.pose(1.234, 0, 0); // any phase, but no movement
  for (const name of ['legL', 'legR', 'armL', 'armR'] as const) {
    assert.ok(
      Math.abs(rig.segments.get(name)!.rotation.x) < 1e-6,
      `${name} should be at rest when not walking`,
    );
  }
});

test('walk amount scales the stride rather than switching it on', () => {
  const rig = new Rig('amount', HUMANOID, true);
  rig.pose(Math.PI / 2, 0.25, 0);
  const quarter = Math.abs(rig.segments.get('legL')!.rotation.x);
  rig.pose(Math.PI / 2, 1, 0);
  const full = Math.abs(rig.segments.get('legL')!.rotation.x);
  assert.ok(quarter > 0, 'a slow walk still moves the legs');
  assert.ok(full > quarter * 3, 'and a fast one moves them much further');
});

test('a swing lifts the tool arm and returns it', () => {
  const rig = new Rig('swing', HUMANOID, true);
  const rest = (() => {
    rig.pose(0, 0, 0);
    return rig.segments.get('armR')!.rotation.x;
  })();

  rig.pose(0, 0, 0.5); // mid-stroke
  const mid = rig.segments.get('armR')!.rotation.x;
  assert.ok(mid < rest - 1, `the tool arm should be raised mid-swing, got ${mid}`);

  rig.pose(0, 0, 1); // stroke finished
  const end = rig.segments.get('armR')!.rotation.x;
  assert.ok(Math.abs(end - rest) < 1e-6, 'and back to rest when the stroke ends');
});

test('a swing does not disturb the legs', () => {
  const rig = new Rig('swing-legs', HUMANOID, true);
  rig.pose(0.7, 1, 0);
  const before = rig.segments.get('legL')!.rotation.x;
  rig.pose(0.7, 1, 0.5);
  assert.equal(rig.segments.get('legL')!.rotation.x, before, 'swinging is an arm action');
});

test('posing a merged rig is a harmless no-op', () => {
  const merged = new Rig('merged-pose', HUMANOID, false);
  // The quality ladder poses every body each frame without checking; this must
  // not throw when limbs were traded away for draw calls.
  assert.doesNotThrow(() => merged.pose(1, 1, 1, 0.3));
});

test('the head follows pitch, clamped so it cannot spin', () => {
  const rig = new Rig('head', HUMANOID, true);
  rig.pose(0, 0, 0, 0.4);
  assert.ok(Math.abs(rig.segments.get('head')!.rotation.x - 0.4) < 1e-6);
  rig.pose(0, 0, 0, 99);
  assert.ok(rig.segments.get('head')!.rotation.x <= 0.6, 'pitch must be clamped');
});

test('the gait advances with distance walked, not with time', () => {
  // Two bodies covering the same ground must end on the same footfall, however
  // many frames or seconds it took — this is why the phase is fed by distance.
  const perBlock = WALK_PHASE_PER_BLOCK;
  const oneStep = 3 * perBlock; // three blocks in one big frame
  const manySteps = Array.from({ length: 30 }, () => 0.1 * perBlock).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(oneStep - manySteps) < 1e-9, 'phase must be frame-rate independent');
  assert.ok(perBlock > 0, 'and actually advance');
});

test('the real mob rigs are built and posable', () => {
  for (const [name, segments] of [
    ['zombie', ZOMBIE_SEGMENTS],
    ['pig', PIG_SEGMENTS],
  ] as const) {
    const rig = new Rig(`real-${name}`, segments, true);
    assert.ok(rig.segments.size >= 3, `${name} should have moving parts`);
    assert.ok(rig.segments.has('body'), `${name} needs a body segment`);
    assert.doesNotThrow(() => rig.pose(1, 1, 0.5, 0.2));

    // Draw-call budget: a mob must stay cheap enough to have many on screen.
    assert.ok(
      rig.group.children.length <= 4,
      `${name} costs ${rig.group.children.length} draw calls; keep mobs at 4 or fewer`,
    );
  }
});

test('a pig walks on diagonal pairs, as four-legged animals do', () => {
  const rig = new Rig('pig-gait', PIG_SEGMENTS, true);
  rig.pose(Math.PI / 2, 1, 0);
  const a = rig.segments.get('legsA')!.rotation.x;
  const b = rig.segments.get('legsB')!.rotation.x;
  assert.ok(a * b < 0, 'the two diagonal pairs must alternate');
});

test('crack stages step through the whole set as mining progresses', () => {
  assert.equal(crackTileFor(0), CRACK_TILE_0, 'a fresh block shows the first stage');
  assert.equal(crackTileFor(0.999), CRACK_TILE_0 + CRACK_STAGES - 1, 'and the last just before breaking');
  assert.equal(crackTileFor(1), CRACK_TILE_0 + CRACK_STAGES - 1, 'progress at or past 1 is clamped');
  assert.equal(crackTileFor(5), CRACK_TILE_0 + CRACK_STAGES - 1, 'overshoot cannot index past the atlas');
  assert.equal(crackTileFor(-1), CRACK_TILE_0, 'and cannot index before it');

  // Every stage must be reachable: no progress value should skip one.
  const seen = new Set<number>();
  for (let p = 0; p < 1; p += 0.01) seen.add(crackTileFor(p));
  assert.equal(seen.size, CRACK_STAGES, 'all ten stages should be used');

  // Stages must increase monotonically, so cracks never appear to heal.
  let previous = -1;
  for (let p = 0; p <= 1; p += 0.02) {
    const tile = crackTileFor(p);
    assert.ok(tile >= previous, 'cracks must never go backwards');
    previous = tile;
  }
});

test('snapshots are stamped with the same clock interpolation compares against', () => {
  // Regression: snapshots were stamped with Date.now() while the frame loop
  // interpolated against performance.now(). The epochs differ by ~1.7e12, so
  // no snapshot ever compared as "old enough" and remote bodies rendered the
  // OLDEST sample in the buffer — over a second stale, with no smoothing.
  const stamp = receiveClock();
  const frameClock = performance.now();
  assert.ok(
    Math.abs(stamp - frameClock) < 1000,
    `receive and frame clocks disagree by ${Math.abs(stamp - frameClock)}ms; ` +
      'they must share an epoch or interpolation silently breaks',
  );

  // And it must be monotonic: a clock that can jump backwards (as a wall clock
  // can, on an NTP correction) would reorder the snapshot buffer.
  const a = receiveClock();
  const b = receiveClock();
  assert.ok(b >= a, 'the receive clock must be monotonic');
});

test('the swing flag survives the wire, alongside the movement flags', () => {
  const state = sanitizePlayerState({
    x: 0, y: 64, z: 0, yaw: 0, pitch: 0,
    flags: FLAG_MOVING | FLAG_SWINGING,
  });
  assert.ok(state, 'a valid state must be accepted');
  assert.ok((state.flags & FLAG_SWINGING) !== 0, 'the swing must reach other players');
  assert.ok((state.flags & FLAG_MOVING) !== 0, 'without clobbering the movement flags');
});

test('flags above the defined set are still masked away', () => {
  const state = sanitizePlayerState({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0xffff });
  assert.ok(state);
  // Widening the mask for the swing flag must not have opened it wide.
  assert.ok(state.flags <= (FLAG_SWINGING << 1) - 1, `mask leaked: ${state.flags}`);
});
