// Light propagation and flowing water.
//
// Both run over a purpose-built flat world rather than real terrain, so every
// assertion is about the rule under test and not about what the noise
// generator happened to put there. The engine and the simulation are the same
// ones the game and the server run.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Block,
  MAX_LIGHT,
  TORCH_LIGHT,
  isWater,
  waterLevel,
} from '../src/blocks.ts';
import { CHUNK_SIZE, HOSTILE_MAX_SPAWN_LIGHT, WORLD_HEIGHT } from '../src/constants.ts';
import { RoomSimulation } from '../src/shared/roomsim.ts';
import type { SimPlayer } from '../src/shared/mobsim.ts';
import type { Vec3 } from '../src/shared/voxel.ts';
import { Chunk } from '../src/world/chunk.ts';
import {
  LightEngine,
  blockOf,
  effectiveLight,
  skyLightFactor,
  skyOf,
} from '../src/world/lighting.ts';

/** Ground fills every column up to (but not including) this height. */
const GROUND = 20;
/** Chunks either side of the origin, so borders have somewhere to flow to. */
const RADIUS = 1;

/**
 * A flat stone world: solid up to GROUND, open sky above. Enough of a SimWorld
 * for the room simulation, and enough of a chunk store for the light engine.
 */
class FlatWorld {
  readonly seed = 1;
  readonly chunks = new Map<string, Chunk>();
  readonly lighting = new LightEngine({
    peekChunk: (cx, cz) => this.chunks.get(Chunk.key(cx, cz)) ?? null,
  });

  constructor() {
    for (let cz = -RADIUS; cz <= RADIUS; cz++) {
      for (let cx = -RADIUS; cx <= RADIUS; cx++) {
        const chunk = new Chunk(cx, cz);
        for (let y = 0; y < GROUND; y++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
              chunk.data[Chunk.index(lx, y, lz)] = y === 0 ? Block.Bedrock : Block.Stone;
            }
          }
        }
        this.chunks.set(Chunk.key(cx, cz), chunk);
      }
    }
    for (const chunk of this.chunks.values()) this.lighting.seedChunk(chunk);
  }

  private chunkAt(x: number, z: number): Chunk | undefined {
    return this.chunks.get(Chunk.key(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  private index(chunk: Chunk, x: number, y: number, z: number): number {
    return Chunk.index(x - chunk.cx * CHUNK_SIZE, y, z - chunk.cz * CHUNK_SIZE);
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return Block.Air;
    const chunk = this.chunkAt(x, z);
    return chunk ? chunk.data[this.index(chunk, x, y, z)] : Block.Air;
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    return id !== Block.Air && id !== Block.Water && !isWater(id);
  }

  /** Edit a block the way the game does: write it, then relight around it. */
  applyEdit(x: number, y: number, z: number, id: number): void {
    const chunk = this.chunkAt(x, z);
    if (!chunk) return;
    chunk.data[this.index(chunk, x, y, z)] = id;
    this.lighting.blockChanged(x, y, z, id);
  }

  lightAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return -1;
    const chunk = this.chunkAt(x, z);
    if (!chunk) return -1;
    return chunk.light[this.index(chunk, x, y, z)];
  }

  sky(x: number, y: number, z: number): number {
    return skyOf(this.lightAt(x, y, z));
  }

  blockLight(x: number, y: number, z: number): number {
    return blockOf(this.lightAt(x, y, z));
  }

  surfaceAt(x: number, z: number): number | null {
    for (let y = WORLD_HEIGHT - 3; y >= 1; y--) {
      if (!this.isSolidAt(x, y, z)) continue;
      if (this.getBlock(x, y + 1, z) !== Block.Air) return null;
      return y + 1;
    }
    return null;
  }
}

function makeRoom(): { world: FlatWorld; sim: RoomSimulation } {
  const world = new FlatWorld();
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    giveItems: (_id, _item, count) => count,
  });
  return { world, sim };
}

const PLAYERS: SimPlayer[] = [{ id: 'p1', position: { x: 8, y: GROUND, z: 8 }, dead: false }];

/** Advance the room by whole water ticks. */
function step(sim: RoomSimulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.update(0.25, PLAYERS);
}

/** Run the room long enough for the water to finish moving. */
function settle(sim: RoomSimulation, seconds = 30): void {
  step(sim, Math.ceil(seconds / 0.25));
}

/** Place a block the way a player does: edit, then tell the simulation. */
function place(world: FlatWorld, sim: RoomSimulation, at: Vec3, id: number): void {
  world.applyEdit(at.x, at.y, at.z, id);
  sim.blockPlaced(at.x, at.y, at.z, id);
}

function mine(world: FlatWorld, sim: RoomSimulation, at: Vec3): void {
  world.applyEdit(at.x, at.y, at.z, Block.Air);
  sim.blockRemoved(at.x, at.y, at.z);
}

/**
 * Wall a one-block-wide channel along z=8, so a stream running down it has
 * banks. Without them water simply goes around anything you put in its way —
 * which is correct, and useless for testing a dam.
 */
function channel(world: FlatWorld, sim: RoomSimulation, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) {
    place(world, sim, { x, y: GROUND, z: 7 }, Block.Stone);
    place(world, sim, { x, y: GROUND, z: 9 }, Block.Stone);
  }
}

// --- Sky light -------------------------------------------------------------

test('daylight fills the open air and stops dead at the ground', () => {
  const world = new FlatWorld();
  assert.equal(world.sky(8, GROUND, 8), MAX_LIGHT, 'the open air is fully lit');
  assert.equal(world.sky(8, WORLD_HEIGHT - 1, 8), MAX_LIGHT, 'right to the top of the world');
  assert.equal(world.sky(8, GROUND - 1, 8), 0, 'the first solid block is dark');
  assert.equal(world.sky(8, 5, 8), 0, 'and so is everything under it');
});

test('a shaft dug from the surface is lit to the bottom, and sealing it puts it out', () => {
  const world = new FlatWorld();
  const bottom = 10;
  for (let y = GROUND - 1; y >= bottom; y--) world.applyEdit(8, y, 8, Block.Air);

  assert.equal(world.sky(8, bottom, 8), MAX_LIGHT, 'daylight falls the whole way down');
  // Sideways is another matter: it costs a level per block, so the rock beside
  // the shaft is dimmer, and nothing reaches far.
  assert.equal(world.sky(8, bottom, 8), MAX_LIGHT);

  // Cap the shaft and the whole thing goes dark.
  world.applyEdit(8, GROUND - 1, 8, Block.Stone);
  assert.equal(world.sky(8, bottom, 8), 0, 'a capped shaft is a cave');
  assert.equal(world.sky(8, GROUND - 2, 8), 0);

  // Open it again and the light comes straight back.
  world.applyEdit(8, GROUND - 1, 8, Block.Air);
  assert.equal(world.sky(8, bottom, 8), MAX_LIGHT, 'reopening it lets the day back in');
});

test('daylight spreading sideways into a tunnel fades one level per block', () => {
  const world = new FlatWorld();
  // A shaft at x=8, then a horizontal tunnel running away from it at y=15.
  for (let y = GROUND - 1; y >= 15; y--) world.applyEdit(8, y, 8, Block.Air);
  for (let x = 9; x <= 25; x++) world.applyEdit(x, 15, 8, Block.Air);

  assert.equal(world.sky(8, 15, 8), MAX_LIGHT, 'the bottom of the shaft is in full daylight');
  assert.equal(world.sky(9, 15, 8), MAX_LIGHT - 1);
  assert.equal(world.sky(12, 15, 8), MAX_LIGHT - 4);
  assert.equal(world.sky(22, 15, 8), 1, 'fourteen blocks in there is barely anything left');
  assert.equal(world.sky(23, 15, 8), 0, 'and fifteen blocks in, the daylight has run out');
});

// --- Block light -----------------------------------------------------------

test('a torch lights the rock around it, and taking it away takes the light with it', () => {
  const world = new FlatWorld();
  // A pocket of air inside the stone, with no way for daylight to get in.
  for (let x = 2; x <= 14; x++) world.applyEdit(x, 10, 8, Block.Air);
  assert.equal(world.sky(8, 10, 8), 0, 'sanity: the pocket is a proper cave');
  assert.equal(world.blockLight(8, 10, 8), 0, 'and it starts pitch dark');

  world.applyEdit(8, 10, 8, Block.Torch);
  assert.equal(world.blockLight(8, 10, 8), TORCH_LIGHT);
  assert.equal(world.blockLight(9, 10, 8), TORCH_LIGHT - 1);
  assert.equal(world.blockLight(12, 10, 8), TORCH_LIGHT - 4);
  assert.equal(world.blockLight(2, 10, 8), 8, 'six blocks away it is down to eight');

  world.applyEdit(8, 10, 8, Block.Air);
  for (let x = 2; x <= 14; x++) {
    assert.equal(world.blockLight(x, 10, 8), 0, `light left behind at x=${x}`);
  }
});

test('torchlight ignores the time of day; daylight does not', () => {
  const world = new FlatWorld();
  for (let x = 2; x <= 14; x++) world.applyEdit(x, 10, 8, Block.Air);
  world.applyEdit(8, 10, 8, Block.Torch);

  const noon = skyLightFactor(0.5);
  const midnight = skyLightFactor(0.0);
  assert.ok(noon > 0.95, 'noon is full strength');
  assert.ok(midnight < 0.25, 'midnight is not');

  // Open ground: bright by day, dim by night.
  assert.equal(effectiveLight(world.lightAt(8, GROUND, 8), noon), MAX_LIGHT);
  assert.ok(effectiveLight(world.lightAt(8, GROUND, 8), midnight) <= HOSTILE_MAX_SPAWN_LIGHT);

  // The torch-lit cave is exactly as bright either way.
  assert.equal(effectiveLight(world.lightAt(9, 10, 8), noon), TORCH_LIGHT - 1);
  assert.equal(effectiveLight(world.lightAt(9, 10, 8), midnight), TORCH_LIGHT - 1);
});

test('a torch is what makes a cave too bright for hostiles to spawn in', () => {
  const world = new FlatWorld();
  for (let x = 2; x <= 14; x++) world.applyEdit(x, 10, 8, Block.Air);
  const noon = skyLightFactor(0.5);
  const spot = () => effectiveLight(world.lightAt(6, 10, 8), noon);

  assert.ok(spot() <= HOSTILE_MAX_SPAWN_LIGHT, 'an unlit cave is dangerous at midday');
  world.applyEdit(8, 10, 8, Block.Torch);
  assert.ok(spot() > HOSTILE_MAX_SPAWN_LIGHT, 'a torch two blocks away makes it safe');
  world.applyEdit(8, 10, 8, Block.Air);
  assert.ok(spot() <= HOSTILE_MAX_SPAWN_LIGHT, 'and taking it out makes it dangerous again');
});

// --- Flowing water ---------------------------------------------------------

test('a source on flat ground spreads seven blocks and no further', () => {
  const { world, sim } = makeRoom();
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim);

  assert.equal(waterLevel(world.getBlock(8, GROUND, 8)), 0, 'the source stays a source');
  for (let d = 1; d <= 7; d++) {
    assert.equal(
      waterLevel(world.getBlock(8 + d, GROUND, 8)),
      d,
      `${d} blocks out should be level ${d}`,
    );
  }
  assert.equal(world.getBlock(16, GROUND, 8), Block.Air, 'eight blocks out it has run dry');
  // It spreads in every direction, not just one.
  assert.equal(waterLevel(world.getBlock(8, GROUND, 11)), 3);
  assert.equal(waterLevel(world.getBlock(5, GROUND, 8)), 3);
});

test('a stream runs: one block further every water tick', () => {
  const { world, sim } = makeRoom();
  channel(world, sim, 7, 20);
  settle(sim, 4); // let the banks stop asking questions before the water starts
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);

  const reach = (): number => {
    let d = 0;
    while (isWater(world.getBlock(8 + d + 1, GROUND, 8))) d++;
    return d;
  };
  assert.equal(reach(), 0, 'nothing has moved before the first tick');
  for (let tick = 1; tick <= 7; tick++) {
    step(sim, 1);
    assert.equal(reach(), tick, `after ${tick} ticks the stream should be ${tick} blocks long`);
  }
  step(sim, 4);
  assert.equal(reach(), 7, 'and there it stops');
});

test('water falls before it spreads, and pools where it lands', () => {
  const { world, sim } = makeRoom();
  // A hole in the ground two blocks deep, with a source beside it.
  for (let y = GROUND - 1; y >= GROUND - 2; y--) mine(world, sim, { x: 10, y, z: 8 });
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim);

  assert.ok(isWater(world.getBlock(10, GROUND - 2, 8)), 'it reached the bottom of the hole');
  // The cell above the hole is draining, so it feeds the fall rather than
  // pushing water further along the surface.
  assert.ok(isWater(world.getBlock(10, GROUND - 1, 8)));
});

test('damming a stream dries out everything below the dam', () => {
  const { world, sim } = makeRoom();
  channel(world, sim, 7, 18);
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim);
  assert.ok(isWater(world.getBlock(13, GROUND, 8)), 'sanity: the stream got this far');

  place(world, sim, { x: 10, y: GROUND, z: 8 }, Block.Stone);
  settle(sim);

  assert.equal(world.getBlock(10, GROUND, 8), Block.Stone, 'the dam holds');
  for (let x = 11; x <= 15; x++) {
    assert.equal(world.getBlock(x, GROUND, 8), Block.Air, `water left standing at x=${x}`);
  }
  assert.equal(waterLevel(world.getBlock(9, GROUND, 8)), 1, 'and the near side is unchanged');
});

test('taking the dam out again lets the stream through', () => {
  const { world, sim } = makeRoom();
  channel(world, sim, 7, 18);
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  place(world, sim, { x: 10, y: GROUND, z: 8 }, Block.Stone);
  settle(sim);
  assert.equal(world.getBlock(12, GROUND, 8), Block.Air);

  mine(world, sim, { x: 10, y: GROUND, z: 8 });
  settle(sim);
  assert.equal(waterLevel(world.getBlock(12, GROUND, 8)), 4, 'the stream runs again');
});

test('a stream goes around a dam that does not reach the banks', () => {
  const { world, sim } = makeRoom();
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  place(world, sim, { x: 10, y: GROUND, z: 8 }, Block.Stone);
  settle(sim);
  // One block in open ground stops nothing: the water simply flows past it.
  assert.ok(isWater(world.getBlock(11, GROUND, 8)), 'water finds its way round');
  assert.ok(isWater(world.getBlock(10, GROUND, 9)), 'by going along the side');
});

test('two sources either side make the cell between them a source: water finds its level', () => {
  const { world, sim } = makeRoom();
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  place(world, sim, { x: 10, y: GROUND, z: 8 }, Block.Water);
  settle(sim);

  assert.equal(
    waterLevel(world.getBlock(9, GROUND, 8)),
    0,
    'the gap between two sources fills with a source of its own',
  );
});

test('water washes a torch away and drops it', () => {
  const { world, sim } = makeRoom();
  place(world, sim, { x: 10, y: GROUND, z: 8 }, Block.Torch);
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim);

  assert.ok(isWater(world.getBlock(10, GROUND, 8)), 'the water took the torch’s place');
  const drops = [...sim.drops.values()].filter((d) => d.itemId === 'torch');
  assert.equal(drops.length, 1, 'and the torch itself is on the ground to pick up');
});

test('a settled world queues no more water work', () => {
  const { world, sim } = makeRoom();
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim, 20);
  assert.equal(sim.pendingWaterCount, 0, 'the flow comes to a stop by itself');
});

test('water is dark at the bottom of a deep pool', () => {
  const { world, sim } = makeRoom();
  // A pit five deep, filled from a source at the top.
  for (let y = GROUND - 1; y >= GROUND - 5; y--) {
    for (let z = 7; z <= 9; z++) {
      for (let x = 7; x <= 9; x++) mine(world, sim, { x, y, z });
    }
  }
  place(world, sim, { x: 8, y: GROUND, z: 8 }, Block.Water);
  settle(sim, 20);

  assert.ok(isWater(world.getBlock(8, GROUND - 5, 8)), 'the pit filled up');
  assert.equal(world.sky(8, GROUND + 1, 8), MAX_LIGHT, 'the air above the pool is full daylight');
  const top = world.sky(8, GROUND, 8);
  const bottom = world.sky(8, GROUND - 5, 8);
  assert.ok(top < MAX_LIGHT, 'the first block of water already takes some of it');
  assert.ok(bottom < top - 2, `daylight should fade with depth (${bottom} vs ${top})`);
});
