// Headless tests for the shared world simulation.
//
// These run the exact class the multiplayer server runs (RoomSimulation) over
// the exact terrain the clients generate (ServerWorld -> TerrainGenerator), so
// what passes here is what happens in a real room. No browser, no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerWorld } from '../server/world.ts';
import { RoomSimulation } from '../src/shared/roomsim.ts';
import { MobSim, isNightTime } from '../src/shared/mobsim.ts';
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
    mobs.every((m) => m.kind === 'zombie'),
    'only hostiles spawn at night',
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

test('daytime spawns passive mobs instead of hostiles', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  sim.timeOfDay = 0.3; // midday
  run(sim, [player], 60);

  assert.ok(sim.mobs.size > 0, 'daytime should still populate the room');
  assert.ok(
    [...sim.mobs.values()].every((m) => m.kind === 'pig'),
    'daylight spawns passive mobs only',
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
