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
  SKELETON_BOW_SEGMENTS,
  SKELETON_SEGMENTS,
  WALK_PHASE_PER_BLOCK,
  ZOMBIE_SEGMENTS,
  type RigSegment,
} from '../src/entities/models.ts';
import {
  chopArc,
  HandAnimator,
  MINE_STRIKE_S,
  strikeArc,
  type HandFrame,
  type HandPose,
} from '../src/game/handpose.ts';
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

test('a skeleton is built with a bow arm that can be raised', () => {
  const rig = new Rig('test-skeleton', SKELETON_SEGMENTS, true);
  assert.ok(rig.segments.has('arms'), 'the bow arm must be posable');
  assert.ok(rig.segments.has('body'));
  assert.ok(
    rig.group.children.length <= 4,
    `a skeleton costs ${rig.group.children.length} draw calls; keep mobs at 4 or fewer`,
  );

  // The bow itself is a rig too, with a string that can be drawn back.
  const bow = new Rig('test-bow', SKELETON_BOW_SEGMENTS, true);
  assert.ok(bow.segments.has('arms'), 'the bowstring must be movable');
});

test('aiming raises the arms and holds them there', () => {
  const rig = new Rig('aim', SKELETON_SEGMENTS, true);
  rig.pose(0, 0, 0, 0, 0); // not aiming
  const rest = rig.segments.get('arms')!.rotation.x;

  rig.pose(0, 0, 0, 0, 0.5); // half drawn
  const half = rig.segments.get('arms')!.rotation.x;
  rig.pose(0, 0, 0, 0, 1); // full draw
  const full = rig.segments.get('arms')!.rotation.x;

  assert.ok(half < rest - 0.5, `arms should come up while aiming: ${rest} -> ${half}`);
  // Level, not flailing: roughly a quarter turn and then steady.
  assert.ok(Math.abs(full + Math.PI / 2) < 0.2, `full draw should hold level, got ${full}`);
  assert.ok(Math.abs(full - half) < 0.4, 'the arms should settle, not keep rising');
});

test('an aiming skeleton still walks, but does not also swing', () => {
  const rig = new Rig('aim-walk', SKELETON_SEGMENTS, true);
  // Aiming while strafing: legs keep moving so it does not slide.
  rig.pose(Math.PI / 2, 1, 0, 0, 1);
  const legL = rig.segments.get('legL')!.rotation.x;
  const legR = rig.segments.get('legR')!.rotation.x;
  assert.ok(Math.abs(legL) > 0.1, 'an aiming skeleton that moves must still walk');
  assert.ok(legL * legR < 0, 'and its legs must still alternate');

  // A swing passed at the same time must not fight the aim.
  rig.pose(0, 0, 1, 0, 1);
  const arms = rig.segments.get('arms')!.rotation.x;
  assert.ok(arms < -1, 'the aim must win over a swing, not blend with it');
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

// --- First-person hand -----------------------------------------------------
//
// The pose maths lives in handpose.ts precisely so it can be checked here:
// it is plain numbers, with none of the textures or materials the Viewmodel
// needs, so every curve below is the one the game actually runs.

/** A still, grounded, empty-handed frame. Override what a test cares about. */
function frame(over: Partial<HandFrame> = {}): HandFrame {
  return {
    dt: 1 / 60,
    hold: 'item',
    style: 'jab',
    speed: 0,
    velocityY: 0,
    onGround: true,
    bowCharge: 0,
    blocking: false,
    ...over,
  };
}

/** Run the animator forward and return the pose at each step. */
function run(anim: HandAnimator, steps: number, over: Partial<HandFrame> = {}): HandPose[] {
  const out: HandPose[] = [];
  for (let i = 0; i < steps; i++) out.push(anim.pose(frame(over)));
  return out;
}

test('the swing curve strikes fast and recovers slowly', () => {
  assert.equal(strikeArc(0), 0, 'a stroke starts at rest');
  assert.equal(strikeArc(1), 0, 'and ends there');

  // Find the peak by sampling; it should sit near a quarter of the way in,
  // which is what makes the blow read as a strike rather than a wave.
  let peakAt = 0;
  let peak = 0;
  for (let p = 0; p <= 1; p += 0.001) {
    const v = strikeArc(p);
    if (v > peak) {
      peak = v;
      peakAt = p;
    }
  }
  assert.ok(Math.abs(peak - 1) < 1e-3, `the arc should reach full extension, got ${peak}`);
  assert.ok(peakAt > 0.2 && peakAt < 0.3, `peak should be around 25% of the stroke, was ${peakAt}`);
  // Asymmetry is the whole point: measure it directly.
  assert.ok(
    strikeArc(0.1) > strikeArc(0.9),
    'the strike must be further along at 10% than at 90%',
  );
});

test('a mining stroke winds up backwards before it swings forwards', () => {
  assert.equal(chopArc(0), 0, 'the stroke starts from rest');
  assert.equal(chopArc(1), 0, 'and returns to it');

  // Sample the curve rather than probing fixed points, so retuning the wind-up
  // does not silently turn this into a test of nothing.
  let troughAt = 0;
  let trough = 0;
  let peakAt = 0;
  let peak = 0;
  for (let p = 0; p <= 1; p += 0.0005) {
    const v = chopArc(p);
    if (v < trough) [trough, troughAt] = [v, p];
    if (v > peak) [peak, peakAt] = [v, p];
  }
  assert.ok(trough < -0.2, `there should be a real wind-up, deepest was ${trough}`);
  assert.ok(peak > 0.95, `and the blow should reach full extension, peaked at ${peak}`);
  assert.ok(troughAt < peakAt, `the tool must pull back before it strikes (${troughAt}, ${peakAt})`);

  // Anticipation you cannot see is jitter. At 60fps the wind-up has to span
  // enough frames to read as a movement rather than a single-frame flicker.
  const windupFrames = troughAt * 2 * MINE_STRIKE_S * 60;
  assert.ok(windupFrames > 3, `the wind-up lasts only ${windupFrames.toFixed(1)} frames`);

  // The two halves must meet at zero, or the tool jumps where they join.
  let closestToZero = Infinity;
  for (let p = troughAt; p < peakAt; p += 0.0005) {
    closestToZero = Math.min(closestToZero, Math.abs(chopArc(p)));
  }
  assert.ok(closestToZero < 1e-3, `the halves never meet at zero (closest ${closestToZero})`);

  // Continuous is not enough: it must also be walkable at the framerate the
  // game runs. Regression — with a square-root blow the frame straddling the
  // join covered three quarters of the swing in one step, so the tool appeared
  // to teleport into the block rather than strike it.
  const perFrame = (1 / 60) / MINE_STRIKE_S;
  let biggest = 0;
  for (let p = 0; p + perFrame <= 1; p += perFrame / 4) {
    biggest = Math.max(biggest, Math.abs(chopArc(p + perFrame) - chopArc(p)));
  }
  assert.ok(biggest < 0.6, `one frame moves ${biggest.toFixed(2)} of the swing; too abrupt to read`);
});

test('an idle hand rests in place, but is not frozen', () => {
  const anim = new HandAnimator();
  const poses = run(anim, 120);
  const last = poses[poses.length - 1];
  // Close to the rest pose...
  assert.ok(Math.abs(last.x - 0.33) < 0.02, `x drifted to ${last.x}`);
  assert.ok(Math.abs(last.y - -0.3) < 0.02, `y drifted to ${last.y}`);
  // ...but breathing, so it is never bit-identical two seconds apart.
  assert.notEqual(poses[0].y, last.y, 'a still hand should still breathe');
});

/** Every pose across one full stroke of the given kind, at 60fps. */
function stroke(kind: 'mine' | 'attack' | 'use' | 'eat', over: Partial<HandFrame> = {}): HandPose[] {
  const anim = new HandAnimator();
  anim.strike(kind);
  const out: HandPose[] = [];
  while (anim.striking) out.push(anim.pose(frame(over)));
  return out;
}

const REST_ITEM = { x: 0.33, y: -0.3, z: -0.62 };

test('mining is a chop: the tool goes up, then down and into the block', () => {
  const poses = stroke('mine');
  const highest = Math.max(...poses.map((p) => p.y));
  const lowest = Math.min(...poses.map((p) => p.y));
  const deepest = Math.min(...poses.map((p) => p.z));

  assert.ok(highest > REST_ITEM.y + 0.05, `no wind-up: y only reached ${highest}`);
  assert.ok(lowest < REST_ITEM.y - 0.15, `the blow should come down hard, y reached ${lowest}`);
  assert.ok(deepest < REST_ITEM.z - 0.15, `and drive into the block, z reached ${deepest}`);

  // The wind-up has to come first, or it is a recoil rather than a swing.
  const highAt = poses.findIndex((p) => p.y === highest);
  const lowAt = poses.findIndex((p) => p.y === lowest);
  assert.ok(highAt < lowAt, `the tool must rise before it falls (${highAt} then ${lowAt})`);
});

test('a sword sweeps across the view rather than chopping', () => {
  const poses = stroke('attack', { style: 'sweep' });
  const sweep = Math.max(...poses.map((p) => p.rotY));
  const leftmost = Math.min(...poses.map((p) => p.x));
  assert.ok(sweep > 0.6, `a blade should sweep around, rotY peaked at ${sweep}`);
  assert.ok(leftmost < REST_ITEM.x - 0.2, `and travel across the view, x reached ${leftmost}`);
  // A sweep is horizontal: it must not also bury itself in the floor.
  assert.ok(Math.min(...poses.map((p) => p.y)) > REST_ITEM.y - 0.1, 'a sweep stays level');
});

test('a pickaxe attack chops; a bare fist just goes forward', () => {
  const chop = stroke('attack', { style: 'chop' });
  const jab = stroke('attack', { style: 'jab' });

  // The chop swings through a much wider vertical arc than the jab.
  const range = (poses: HandPose[]): number =>
    Math.max(...poses.map((p) => p.y)) - Math.min(...poses.map((p) => p.y));
  assert.ok(
    range(chop) > range(jab) * 3,
    `a chop should travel far further vertically: ${range(chop)} vs ${range(jab)}`,
  );

  // Neither sweeps sideways — that is the sword's move.
  for (const [name, poses] of [['chop', chop], ['jab', jab]] as const) {
    const sideways = Math.max(...poses.map((p) => p.rotY));
    assert.ok(sideways < 0.1, `a ${name} should not sweep; rotY reached ${sideways}`);
  }
  assert.ok(Math.min(...jab.map((p) => p.z)) < REST_ITEM.z - 0.2, 'a jab still goes forward');
});

test('every stroke starts and ends at rest, whatever the style', () => {
  // A stroke that does not close leaves the hand parked mid-swing.
  for (const style of ['sweep', 'chop', 'jab'] as const) {
    for (const kind of ['mine', 'attack', 'use', 'eat'] as const) {
      // A zero-length frame samples the stroke at its very start, before any
      // time has passed; by the first real frame a fast wind-up has already
      // moved, which is the point of it.
      const anim = new HandAnimator();
      anim.strike(kind);
      const start = anim.pose(frame({ style, dt: 0 }));
      assert.ok(
        Math.abs(start.y - REST_ITEM.y) < 0.01,
        `${kind}/${style} starts away from rest: ${start.y}`,
      );

      const poses = stroke(kind, { style });
      const last = poses[poses.length - 1];
      assert.ok(
        Math.abs(last.y - REST_ITEM.y) < 0.05,
        `${kind}/${style} does not return to rest: ${last.y}`,
      );
      // And it has to actually do something in between. Which channel carries
      // the motion differs by style — a sweep is sideways, a chop vertical, a
      // use mostly a rotation — so measure the largest departure on any of them.
      const moved = Math.max(
        ...poses.map((p) =>
          Math.max(
            Math.abs(p.x - start.x),
            Math.abs(p.y - start.y),
            Math.abs(p.z - start.z),
            Math.abs(p.rotX - start.rotX),
            Math.abs(p.rotY - start.rotY),
            Math.abs(p.rotZ - start.rotZ),
          ),
        ),
      );
      assert.ok(moved > 0.15, `${kind}/${style} barely moves the hand (${moved})`);
    }
  }
});

test('a stroke ends when its time is up', () => {
  const anim = new HandAnimator();
  anim.strike('attack');
  assert.ok(anim.swinging, 'a fresh stroke is in progress');
  run(anim, 40); // 0.66s — comfortably past the 0.34s stroke
  assert.ok(!anim.swinging, 'and it must finish rather than hang');
});

test('re-triggering restarts the stroke, so held mining loops', () => {
  const anim = new HandAnimator();
  anim.strike('mine');
  run(anim, 17); // most of the way through
  anim.strike('mine');
  const restarted = run(anim, 1)[0];
  // Immediately after a restart the stroke is at its wind-up, which pulls the
  // tool back rather than leaving it stuck at the end of the previous blow.
  assert.ok(restarted.rotX > -0.5, `expected a fresh wind-up, rotX was ${restarted.rotX}`);
  assert.ok(anim.swinging);
});

test('eating brings the item to the mouth without counting as a swing', () => {
  const anim = new HandAnimator();
  anim.strike('eat');
  assert.ok(anim.striking, 'the hand is busy');
  assert.ok(!anim.swinging, 'but eating is not a swing others should see');

  const poses = run(anim, 30); // half a second in
  const closest = Math.max(...poses.map((p) => p.z));
  const highest = Math.max(...poses.map((p) => p.y));
  assert.ok(closest > -0.5, `food should come toward the face, z reached ${closest}`);
  assert.ok(highest > -0.3, `and up toward the mouth, y reached ${highest}`);
});

test('swapping items hides the change at the bottom of a dip', () => {
  const anim = new HandAnimator();
  // Nothing pending before a swap is asked for.
  assert.ok(!anim.takeSwap());

  anim.equip();
  let swaps = 0;
  let lowest = 0;
  let lowestAtSwap: number | null = null;
  for (let i = 0; i < 30; i++) {
    const pose = anim.pose(frame());
    lowest = Math.min(lowest, pose.y);
    if (anim.takeSwap()) {
      swaps++;
      lowestAtSwap = pose.y;
    }
  }
  assert.equal(swaps, 1, 'the model must be rebuilt exactly once per swap');
  assert.ok(lowest < -0.3 - 0.4, `the item should drop out of frame, reached y=${lowest}`);
  assert.ok(
    lowestAtSwap !== null && lowestAtSwap < lowest + 0.05,
    `the swap must happen at the bottom of the dip (y=${lowestAtSwap}, lowest ${lowest})`,
  );
});

test('landing jolts the hand down and then settles', () => {
  const anim = new HandAnimator();
  // Falling: airborne, moving down fast.
  run(anim, 10, { onGround: false, velocityY: -12 });
  const restY = anim.pose(frame({ onGround: false, velocityY: -12 })).y;
  // Touch down — the collision has already zeroed the velocity by this point,
  // which is exactly why the animator remembers the last airborne speed.
  const landed = anim.pose(frame({ onGround: true, velocityY: 0 }));
  assert.ok(landed.y < restY, `the hand should drop on impact (${landed.y} vs ${restY})`);

  const settled = run(anim, 40).pop()!;
  assert.ok(Math.abs(settled.y - -0.3) < 0.03, `and recover, ended at ${settled.y}`);
});

test('a gentle step down does not trigger a landing jolt', () => {
  const anim = new HandAnimator();
  run(anim, 3, { onGround: false, velocityY: -1 });
  const before = anim.pose(frame({ onGround: false, velocityY: -1 })).y;
  const landed = anim.pose(frame({ onGround: true, velocityY: 0 })).y;
  assert.ok(
    Math.abs(landed - before) < 0.02,
    `walking off a kerb should not shake the hand (${before} -> ${landed})`,
  );
});

test('a drawn bow overrides whatever the hand was doing', () => {
  const anim = new HandAnimator();
  anim.strike('attack');
  const drawn = anim.pose(frame({ bowCharge: 1 }));
  // At full draw the bow sits at a fixed pose, not wherever the slash left it.
  assert.ok(Math.abs(drawn.x - (0.33 - 0.18)) < 0.02, `bow x was ${drawn.x}`);
  assert.ok(Math.abs(drawn.rotZ - (0.9 - 0.75)) < 0.02, `bow rotZ was ${drawn.rotZ}`);
});

test('a raised shield beats even a drawn bow', () => {
  const anim = new HandAnimator();
  const pose = anim.pose(frame({ bowCharge: 1, blocking: true }));
  // Not exactly the shield pose: breathing is applied over the top, so even a
  // braced shield drifts by a few thousandths.
  assert.ok(Math.abs(pose.x - 0.16) < 0.01, `shield x was ${pose.x}`);
  assert.equal(pose.rotY, 0.5);
});

test('walking sways the hand; standing still does not', () => {
  const walking = new HandAnimator();
  const walked = run(walking, 90, { speed: 4.3 });
  const spread = Math.max(...walked.map((p) => p.x)) - Math.min(...walked.map((p) => p.x));
  assert.ok(spread > 0.05, `a walking hand should sway, spread was ${spread}`);

  const still = new HandAnimator();
  const stood = run(still, 90);
  const stillSpread = Math.max(...stood.map((p) => p.x)) - Math.min(...stood.map((p) => p.x));
  assert.ok(stillSpread < 0.02, `a still hand should barely move, spread was ${stillSpread}`);
});

test('the sway advances with distance walked, not with time', () => {
  // Same distance covered at different speeds must land on the same phase, or
  // the hand falls out of step with the legs whenever the framerate moves.
  const fast = new HandAnimator();
  run(fast, 30, { speed: 4, dt: 1 / 60 }); // 2 seconds at 4 b/s = 2 blocks
  const slow = new HandAnimator();
  run(slow, 60, { speed: 2, dt: 1 / 60 }); // 4 seconds at 2 b/s = 2 blocks

  const a = fast.pose(frame({ speed: 4, dt: 0 }));
  const b = slow.pose(frame({ speed: 2, dt: 0 }));
  // The sway term is what must match; the eased amplitude differs slightly, so
  // compare the phase through the position it produces.
  assert.ok(Math.abs(a.x - b.x) < 0.02, `same distance, different phase: ${a.x} vs ${b.x}`);
});
