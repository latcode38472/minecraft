// Headless tests for the shared world simulation.
//
// These run the exact class the multiplayer server runs (RoomSimulation) over
// the exact terrain the clients generate (ServerWorld -> TerrainGenerator), so
// what passes here is what happens in a real room. No browser, no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerWorld } from '../server/world.ts';
import { RoomSimulation } from '../src/shared/roomsim.ts';
import { ArrowSim, MobSim, isNightTime, solveArrowArc } from '../src/shared/mobsim.ts';
import { MOB_DEFS } from '../src/shared/mobs.ts';
import { moveWithCollision, rayBoxDistance } from '../src/shared/voxel.ts';
import { Block } from '../src/blocks.ts';
import { MAX_MOBS, NIGHT_START } from '../src/constants.ts';
import type { SimPlayer } from '../src/shared/mobsim.ts';

const SEED = 1337;

/** A world plus a simulation, with the hooks recording what they were told. */
function makeRoom(seed = SEED) {
  const world = new ServerWorld(seed, new Map());
  const damage: { id: string; amount: number }[] = [];
  const given: [string, string, number][] = [];
  const sim = new RoomSimulation(world, {
    damagePlayer: (id, amount) => damage.push({ id, amount }),
    giveItems: (id, itemId, count) => {
      given.push([id, itemId, count]);
      return 0; // the test player always has room
    },
  });
  return { world, sim, damage, given };
}

/**
 * A player standing on real ground near the seed's spawn. `findSpawnColumn`
 * returns the first air block above the surface, which is where the feet go.
 */
function spawnPlayer(world: ServerWorld, id = 'p1'): SimPlayer {
  const spawn = world.terrain.findSpawnColumn();
  return {
    id,
    position: { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 },
    dead: false,
  };
}

/** Step the room for `seconds` at a fixed 20Hz, like the server's tick. */
function run(sim: RoomSimulation, players: SimPlayer[], seconds: number): void {
  const dt = 1 / 20;
  for (let t = 0; t < seconds; t += dt) sim.update(dt, players);
}

test('terrain is deterministic: the same seed gives the same ground', () => {
  const a = new ServerWorld(SEED, new Map());
  const b = new ServerWorld(SEED, new Map());
  const c = new ServerWorld(SEED + 1, new Map());
  let sameAsB = 0;
  let sameAsC = 0;
  for (let i = 0; i < 200; i++) {
    const x = i * 7 - 700;
    const z = i * 13 - 900;
    if (a.terrain.heightAt(x, z) === b.terrain.heightAt(x, z)) sameAsB++;
    if (a.terrain.heightAt(x, z) === c.terrain.heightAt(x, z)) sameAsC++;
  }
  assert.equal(sameAsB, 200, 'same seed must reproduce the world exactly');
  assert.ok(sameAsC < 200, 'a different seed must not produce the same world');
});

test('the server generates real ground under the spawn point', () => {
  const world = new ServerWorld(SEED, new Map());
  const spawn = world.terrain.findSpawnColumn();
  assert.ok(world.isSolidAt(spawn.x, spawn.y - 1, spawn.z), 'spawn must stand on solid ground');
  assert.equal(world.getBlock(spawn.x, spawn.y, spawn.z), Block.Air, 'feet space must be clear');
  assert.equal(world.getBlock(spawn.x, spawn.y + 1, spawn.z), Block.Air, 'head space must be clear');
  assert.equal(world.getBlock(spawn.x, 0, spawn.z), Block.Bedrock, 'bedrock floors the world');
});

test('mobs spawn at night, on the ground, and stay grounded', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  sim.timeOfDay = NIGHT_START + 0.01;
  assert.ok(isNightTime(sim.timeOfDay));

  run(sim, [player], 60);

  assert.ok(sim.mobs.size > 0, 'night should populate the room with hostiles');
  const mobs = [...sim.mobs.values()];
  assert.ok(
    mobs.every((m) => MOB_DEFS[m.kind].hostile),
    `only hostiles spawn at night, got ${mobs.map((m) => m.kind)}`,
  );
  // Every mob must be resting on something solid, not floating or sunk.
  for (const mob of mobs) {
    const below = world.isSolidAt(
      Math.floor(mob.position.x),
      Math.floor(mob.position.y - 0.2),
      Math.floor(mob.position.z),
    );
    const insideGround = world.isSolidAt(
      Math.floor(mob.position.x),
      Math.floor(mob.position.y + 0.5),
      Math.floor(mob.position.z),
    );
    assert.ok(below || mob.position.y > 0, `mob at ${JSON.stringify(mob.position)} lost the ground`);
    assert.ok(!insideGround, 'a mob must never end up inside a solid block');
  }
});

test('night brings both zombies and skeletons, not just one', () => {
  // A night of only melee, or only archers, is a much less interesting night.
  const kinds = new Set<string>();
  for (let seed = 0; seed < 6 && kinds.size < 2; seed++) {
    const { world, sim } = makeRoom(SEED + seed);
    const player = spawnPlayer(world);
    sim.timeOfDay = NIGHT_START + 0.01;
    run(sim, [player], 120);
    for (const mob of sim.mobs.values()) kinds.add(mob.kind);
  }
  assert.ok(kinds.has('zombie'), `no zombies spawned: ${[...kinds]}`);
  assert.ok(kinds.has('skeleton'), `no skeletons spawned: ${[...kinds]}`);
});

test('daytime spawns passive mobs instead of hostiles', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  sim.timeOfDay = 0.3; // midday
  run(sim, [player], 60);

  assert.ok(sim.mobs.size > 0, 'daytime should still populate the room');
  const kinds = [...sim.mobs.values()].map((m) => m.kind);
  assert.ok(
    kinds.every((k) => !MOB_DEFS[k].hostile),
    `daylight spawns passive mobs only, got ${kinds}`,
  );
});

test('a zombie closes on the nearest player and hits them', () => {
  const { world, sim, damage } = makeRoom();
  const player = spawnPlayer(world);
  const far: SimPlayer = {
    id: 'p2',
    position: { x: player.position.x + 60, y: player.position.y, z: player.position.z },
    dead: false,
  };

  // Place a zombie right next to the near player rather than waiting for a spawn.
  const zombie = new MobSim('zombie', player.position.x + 1.2, player.position.y, player.position.z);
  sim.mobs.set(zombie.id, zombie);

  const startDist = Math.hypot(
    zombie.position.x - player.position.x,
    zombie.position.z - player.position.z,
  );
  run(sim, [player, far], 5);

  assert.ok(damage.length > 0, 'an adjacent zombie must land hits');
  assert.equal(damage[0].id, 'p1', 'it must target the nearer player');
  assert.ok(damage[0].amount > 0);
  assert.ok(startDist < 4, 'sanity: the test placed it in range');
});

// --- Skeletons -------------------------------------------------------------

test('a skeleton draws its bow before shooting, and the draw is visible', () => {
  const { world, sim, damage } = makeRoom();
  const player = spawnPlayer(world);
  const skeleton = new MobSim(
    'skeleton',
    player.position.x + 8,
    player.position.y,
    player.position.z,
  );
  sim.mobs.set(skeleton.id, skeleton);

  // Step until the first arrow exists, watching the draw build.
  const draws: number[] = [];
  let firstArrowAt = -1;
  for (let i = 0; i < 200 && firstArrowAt < 0; i++) {
    sim.update(1 / 20, [player]);
    draws.push(skeleton.drawTime);
    if (sim.arrows.size > 0) firstArrowAt = i;
  }

  assert.ok(firstArrowAt > 0, 'the skeleton never fired');
  const peak = Math.max(...draws);
  assert.ok(peak > 0.9, `the bow was barely drawn before firing: ${peak.toFixed(2)}s`);
  // The draw is the player's warning, so it must last long enough to react to.
  assert.ok(
    draws.filter((d) => d > 0).length >= 15,
    'the draw must be visible for a beat, not an instant',
  );

  // And the shot must eventually land.
  run(sim, [player], 6);
  assert.ok(damage.length > 0, 'arrows should hit a stationary player');
  assert.equal(damage[0].id, 'p1');
});

test('the draw reaches clients as a 0..1 level on the mob snapshot', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  const skeleton = new MobSim('skeleton', player.position.x + 8, player.position.y, player.position.z);
  sim.mobs.set(skeleton.id, skeleton);

  let sawDraw = false;
  for (let i = 0; i < 60 && !sawDraw; i++) {
    sim.update(1 / 20, [player]);
    const snap = sim.mobSnapshot().find((m) => m.i === skeleton.id)!;
    if (snap.d !== undefined) {
      sawDraw = true;
      assert.ok(snap.d > 0 && snap.d <= 1, `draw out of range: ${snap.d}`);
      assert.equal(snap.k, 2, 'a skeleton is kind 2 on the wire');
    }
  }
  assert.ok(sawDraw, 'clients were never told the bow was being drawn');

  // Once it fires, the field disappears rather than sticking at 1.
  run(sim, [player], 2);
  const after = sim.mobSnapshot().find((m) => m.i === skeleton.id);
  assert.ok(after, 'the skeleton should still exist');
  assert.ok(after.d === undefined || after.d < 1, 'a loosed bow must not stay fully drawn');
});

test('a skeleton keeps its distance instead of walking into melee', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  // Start it right on top of the player: it should back off, not close.
  const skeleton = new MobSim('skeleton', player.position.x + 1.5, player.position.y, player.position.z);
  sim.mobs.set(skeleton.id, skeleton);

  run(sim, [player], 4);
  const distance = Math.hypot(
    skeleton.position.x - player.position.x,
    skeleton.position.z - player.position.z,
  );
  assert.ok(distance > 3, `an archer should retreat, but it stayed at ${distance.toFixed(1)} blocks`);
});

test('a skeleton will not shoot through a wall', () => {
  const world = new ServerWorld(SEED, new Map());
  const fired: unknown[] = [];
  const sim = new RoomSimulation(world, { damagePlayer: () => {}, giveItems: () => 0 });
  const spawn = world.terrain.findSpawnColumn();
  const player: SimPlayer = {
    id: 'p1',
    position: { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 },
    dead: false,
  };
  const skeleton = new MobSim('skeleton', player.position.x + 8, player.position.y, player.position.z);
  sim.mobs.set(skeleton.id, skeleton);

  // Seal the player inside a solid box — walls two thick and a roof, so no
  // angle threads a corner and no shot arcs over the top. A single-thickness
  // ring is not enough: the skeleton strafes, and a diagonal line of sight can
  // pass between two cells.
  const px = Math.floor(player.position.x);
  const py = Math.floor(player.position.y);
  const pz = Math.floor(player.position.z);
  for (let dy = -1; dy <= 4; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const inside = dx === 0 && dz === 0 && dy >= 0 && dy <= 1;
        if (inside) continue;
        // Read first: ServerWorld.applyEdit only writes into chunks it already
        // holds (unloaded ones get their edits replayed from the room's map on
        // generation instead), so an unread column would silently drop the
        // write and leave the "sealed" player standing in the open.
        world.getBlock(px + dx, py + dy, pz + dz);
        world.applyEdit(px + dx, py + dy, pz + dz, 1);
      }
    }
  }
  assert.ok(
    world.isSolidAt(px + 2, py + 1, pz),
    'sanity: the box must actually exist before testing line of sight',
  );

  run(sim, [player], 8);

  // The one thing that matters: a sealed player is never shot.
  assert.equal(sim.arrows.size, 0, 'no arrow should be in flight');
  assert.equal(fired.length, 0);
  assert.equal(sim.removedArrows.length, 0, 'nor should one have been fired and expired');
  // And it should not stand there drawing at a wall it cannot shoot through.
  assert.equal(skeleton.drawTime, 0, 'the bow should be relaxed with no line of sight');
});

test('a skeleton arrow stops at terrain instead of passing through it', () => {
  const world = new ServerWorld(SEED, new Map());
  const sim = new RoomSimulation(world, { damagePlayer: () => {}, giveItems: () => 0 });
  const spawn = world.terrain.findSpawnColumn();
  // Fire flat into the ground: it must stick, not tunnel onward forever.
  const arrow = new ArrowSim(
    { x: spawn.x + 0.5, y: spawn.y + 0.5, z: spawn.z + 0.5 },
    { x: 0, y: -1, z: 0 },
    40,
    3,
    999,
  );
  sim.arrows.set(arrow.id, arrow);
  for (let i = 0; i < 40 && !arrow.stuck; i++) arrow.update(1 / 20, world, []);

  assert.ok(arrow.stuck, 'the arrow flew through the ground');
  assert.ok(
    !world.isSolidAt(
      Math.floor(arrow.position.x),
      Math.floor(arrow.position.y),
      Math.floor(arrow.position.z),
    ),
    'and it must come to rest in open air, not inside a block',
  );
});

test('the ballistic solver hits its mark, and admits when it cannot', () => {
  const speed = 26;
  // A level shot at a reachable distance leans very slightly upward.
  const flat = solveArrowArc(10, 0, speed);
  assert.ok(flat !== null && flat > 0 && flat < 0.5, `implausible level shot slope: ${flat}`);

  // Shooting upward needs more elevation than shooting level.
  const up = solveArrowArc(10, 4, speed)!;
  const down = solveArrowArc(10, -4, speed)!;
  assert.ok(up > flat!, 'an uphill shot must aim higher');
  assert.ok(down < flat!, 'a downhill shot must aim lower');

  // And a shot beyond the bow's reach is refused rather than fudged.
  assert.equal(solveArrowArc(10_000, 0, speed), null, 'an impossible shot must return null');
});

test('a skeleton drops bones and arrows, arming the player who kills it', () => {
  const { world, sim, given } = makeRoom();
  const player = spawnPlayer(world);
  const skeleton = new MobSim('skeleton', player.position.x + 1, player.position.y, player.position.z);
  sim.mobs.set(skeleton.id, skeleton);

  for (let i = 0; i < 30 && !skeleton.dead; i++) {
    sim.damageMob(skeleton.id, 5, 'p1', player.position);
    sim.update(1 / 20, [player]);
  }
  assert.ok(skeleton.dead, 'the skeleton should have died');
  assert.ok(
    given.some(([, item]) => item === 'bone'),
    `expected bones in the loot, got ${JSON.stringify(given)}`,
  );
  assert.ok(
    given.every(([who]) => who === 'p1'),
    'loot goes to the killer',
  );
});

test('mob loot goes to whoever landed the killing blow', () => {
  const { world, sim, given } = makeRoom();
  const player = spawnPlayer(world);
  const pig = new MobSim('pig', player.position.x + 1, player.position.y, player.position.z);
  sim.mobs.set(pig.id, pig);

  // Hit it until it dies; the sim clears hurtTime so each swing lands.
  for (let i = 0; i < 20 && !pig.dead; i++) {
    sim.damageMob(pig.id, 5, 'p1', player.position);
    sim.update(1 / 20, [player]);
  }

  assert.ok(pig.dead, 'the pig should be dead after repeated hits');
  assert.ok(given.length > 0, 'its loot must be handed to someone');
  assert.ok(
    given.every(([who]) => who === 'p1'),
    'all of it goes to the killer',
  );
  assert.ok(
    given.some(([, item]) => item === 'raw_porkchop'),
    'a pig drops porkchop',
  );
  assert.ok(sim.mobDeaths.length > 0, 'the death must be reported so clients can play the sound');
});

test('loot the killer cannot carry falls on the ground instead', () => {
  const world = new ServerWorld(SEED, new Map());
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    // A full inventory: nothing fits, everything comes back as leftover.
    giveItems: (_id, _item, count) => count,
  });
  const player = spawnPlayer(world);
  const pig = new MobSim('pig', player.position.x + 1, player.position.y, player.position.z);
  sim.mobs.set(pig.id, pig);

  for (let i = 0; i < 20 && !pig.dead; i++) {
    sim.damageMob(pig.id, 5, 'p1', player.position);
    sim.update(1 / 20, [player]);
  }

  assert.ok(pig.dead);
  assert.ok(sim.drops.size > 0, 'unclaimable loot must land in the world, not vanish');
});

test('a thrown item is picked up by another player, and only by one of them', () => {
  const world = new ServerWorld(SEED, new Map());
  const claimed: [string, string, number][] = [];
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    giveItems: (id, itemId, count) => {
      claimed.push([id, itemId, count]);
      return 0;
    },
  });

  const thrower = spawnPlayer(world, 'thrower');
  // Two receivers standing on the exact same spot, both in range of the stack.
  const a: SimPlayer = { id: 'a', position: { ...thrower.position }, dead: false };
  const b: SimPlayer = { id: 'b', position: { ...thrower.position }, dead: false };

  sim.spawnDrop('diamond', 3, thrower.position.x, thrower.position.y + 1.2, thrower.position.z, 'thrower');
  run(sim, [thrower, a, b], 3);

  assert.equal(claimed.length, 1, 'exactly one player may ever claim a stack');
  assert.notEqual(claimed[0][0], 'thrower', 'the thrower cannot instantly take it back');
  assert.deepEqual(claimed[0].slice(1), ['diamond', 3]);
  assert.equal(sim.drops.size, 0, 'the claimed stack leaves the world');
  assert.ok(sim.removedDrops.length > 0, 'and clients are told to delete it');
});

test('a thrower can reclaim their own throw once the delay lapses', () => {
  const world = new ServerWorld(SEED, new Map());
  const claimed: string[] = [];
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    giveItems: (id) => {
      claimed.push(id);
      return 0;
    },
  });
  const thrower = spawnPlayer(world, 'thrower');
  sim.spawnDrop('dirt', 1, thrower.position.x, thrower.position.y + 1.2, thrower.position.z, 'thrower');

  run(sim, [thrower], 1); // inside the 2s thrower delay
  assert.equal(claimed.length, 0, 'a fresh throw must not snap straight back');

  run(sim, [thrower], 3); // past it
  assert.deepEqual(claimed, ['thrower'], 'after the delay the thrower may pick it up again');
});

test('a mined block\'s drop is free for anyone to collect immediately', () => {
  const world = new ServerWorld(SEED, new Map());
  const claimed: string[] = [];
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    giveItems: (id) => {
      claimed.push(id);
      return 0;
    },
  });
  const miner = spawnPlayer(world, 'miner');
  // No owner: this is a block drop, not a throw.
  sim.spawnDrop('cobblestone', 1, miner.position.x, miner.position.y + 0.5, miner.position.z);

  run(sim, [miner], 2);
  assert.deepEqual(claimed, ['miner'], 'the miner picks up what they mined');
});

test('drops despawn, so a long session cannot accumulate them forever', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  // Well out of pickup range so only the despawn timer can remove it.
  sim.spawnDrop('dirt', 1, player.position.x + 40, player.position.y, player.position.z);
  assert.equal(sim.drops.size, 1);

  run(sim, [player], 310); // past the 300s despawn
  assert.equal(sim.drops.size, 0, 'a drop nobody collects must eventually vanish');
});

test('mob population stays bounded over a long session', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  sim.timeOfDay = NIGHT_START + 0.01;
  // 400s spans night into day, so both spawn caps get exercised.
  run(sim, [player], 400);
  assert.ok(sim.mobs.size <= MAX_MOBS, `mob count ran away: ${sim.mobs.size}`);
});

test('server memory stays flat while a player travels', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  let peak = 0;
  // Walk 2,400 blocks in a straight line, stepping the sim as we go.
  for (let step = 0; step < 300; step++) {
    player.position.x += 8;
    player.position.y = (world.surfaceAt(Math.floor(player.position.x), Math.floor(player.position.z)) ?? 40);
    sim.update(1 / 20, [player]);
    peak = Math.max(peak, world.chunkCount);
  }
  assert.ok(peak <= 400, `chunk cache grew unbounded: peaked at ${peak}`);
});

test('collision keeps a falling body out of solid ground', () => {
  const world = new ServerWorld(SEED, new Map());
  const spawn = world.terrain.findSpawnColumn();
  const position = { x: spawn.x + 0.5, y: spawn.y + 30, z: spawn.z + 0.5 };
  const velocity = { x: 0, y: -60, z: 0 }; // fast enough to tunnel without substeps
  const shape = { halfWidth: 0.3, height: 1.8 };

  let grounded = false;
  for (let i = 0; i < 200 && !grounded; i++) {
    grounded = moveWithCollision(world, position, velocity, shape, 1 / 20);
  }
  assert.ok(grounded, 'a falling body must land');
  assert.ok(
    !world.isSolidAt(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)),
    'and must not end up inside the ground',
  );
});

test('the shared ray test hits a box in front and misses one behind', () => {
  const min = { x: -0.5, y: 0, z: 4 };
  const max = { x: 0.5, y: 2, z: 5 };
  const hit = rayBoxDistance({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, min, max, 10);
  assert.ok(hit !== null && Math.abs(hit - 4) < 0.01, `expected a hit at ~4, got ${hit}`);

  const behind = rayBoxDistance({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, min, max, 10);
  assert.equal(behind, null, 'a ray pointing away must not hit');

  const tooFar = rayBoxDistance({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, min, max, 2);
  assert.equal(tooFar, null, 'a hit beyond the reach limit must be rejected');
});

test('a dead player is neither targeted nor able to pick items up', () => {
  const world = new ServerWorld(SEED, new Map());
  const claimed: string[] = [];
  const sim = new RoomSimulation(world, {
    damagePlayer: (id) => claimed.push(`hit:${id}`),
    giveItems: (id) => {
      claimed.push(`give:${id}`);
      return 0;
    },
  });
  const ghost = spawnPlayer(world, 'ghost');
  ghost.dead = true;
  sim.spawnDrop('dirt', 1, ghost.position.x, ghost.position.y, ghost.position.z);
  const zombie = new MobSim('zombie', ghost.position.x + 1, ghost.position.y, ghost.position.z);
  sim.mobs.set(zombie.id, zombie);

  run(sim, [ghost], 5);
  assert.deepEqual(claimed, [], 'a dead player is invisible to mobs and to item pickup');
});
