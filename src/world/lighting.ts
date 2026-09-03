// Per-voxel light: a flood fill over the block grid, in two channels.
//
//   sky   — where daylight reaches. Seeded from the top of the world, it falls
//           straight down at full strength through anything clear and loses a
//           step for every block it spreads sideways. This is what makes a
//           cave dark: no path from the sky means no sky light, at any hour.
//   block — light a block gives off itself (a torch, a lit furnace). It has no
//           idea what time it is, so a torch is exactly as bright at midnight.
//
// Both are stored a nibble each in `Chunk.light`, and both use the same two
// passes: an *add* flood that pushes light outward from anything brighter than
// its neighbours, and a *removal* flood that unlights everything a vanished
// source was responsible for, collecting the still-lit cells at the edge of
// the hole so the add pass can fill it back in. That pair is what lets a
// single block change be re-lit in microseconds instead of relighting a chunk.
//
// The engine only ever writes into chunks that are already in memory: light
// stops at the edge of the loaded world and flows on when the next chunk
// arrives and seeds itself. Node loads this file for the tests and the server,
// so imports carry explicit .ts extensions.

import { BLOCKS, MAX_LIGHT, lightEmission, lightOpacity } from '../blocks.ts';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants.ts';
import { Chunk } from './chunk.ts';

// Flat lookup tables. Seeding a chunk asks about eighteen thousand voxels, and
// a typed-array index is a great deal cheaper than a registry lookup each time.
const OPACITY = new Uint8Array(BLOCKS.length).map((_, id) => lightOpacity(id));
const EMISSION = new Uint8Array(BLOCKS.length).map((_, id) => lightEmission(id));

/** Sky light lives in the high nibble of a light byte, block light in the low one. */
const SKY_SHIFT = 4;
const NIBBLE = 0x0f;

/** The six face neighbours, as flat x/y/z triples. */
const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];

/** What the engine needs from a world: chunks it already holds, nothing more. */
export interface LightAccess {
  /** The loaded chunk at these chunk coords, or null. Must never generate one. */
  peekChunk(cx: number, cz: number): Chunk | null;
  /** Called once per chunk whose light this pass changed, for remeshing. */
  onLightChanged?(chunk: Chunk): void;
}

/** Pack sky and block light into one byte. */
export function packLight(sky: number, block: number): number {
  return (sky << SKY_SHIFT) | block;
}
export function skyOf(packed: number): number {
  return (packed >> SKY_SHIFT) & NIBBLE;
}
export function blockOf(packed: number): number {
  return packed & NIBBLE;
}

/**
 * How bright a spot actually looks, 0..15, given how much of the sky's
 * strength is currently reaching the ground. `daylight` is 1 at noon and 0 at
 * midnight, so a torch-lit cave holds its brightness while the surface dims.
 */
export function effectiveLight(packed: number, daylight: number): number {
  return Math.max(blockOf(packed), Math.round(skyOf(packed) * daylight));
}

/**
 * Moonlight. Even a clear night is not pitch dark outdoors — you can still
 * make out the ground — but it is dark enough that things start crawling out
 * of it, and dark enough that a torch is worth putting down.
 */
export const NIGHT_SKY_FACTOR = 0.08;

/** How much of full sunlight reaches the ground at this time of day, 0..1. */
export function skyLightFactor(timeOfDay: number): number {
  const elevation = Math.sin((timeOfDay - 0.25) * Math.PI * 2);
  return NIGHT_SKY_FACTOR + (1 - NIGHT_SKY_FACTOR) * Math.sqrt(Math.max(0, elevation));
}

export class LightEngine {
  private readonly access: LightAccess;
  /** Chunks written since the last flush, so each is remeshed once. */
  private readonly touched = new Set<Chunk>();
  /** Flat x,y,z triples waiting to spread their light. */
  private readonly addQueue: number[] = [];
  /** Flat x,y,z,level quadruples whose light is being taken away. */
  private readonly removeQueue: number[] = [];

  // One-entry chunk memo: a flood walks the same chunk hundreds of times.
  private memo: Chunk | null = null;
  private memoCx = 0;
  private memoCz = 0;
  private memoValid = false;

  constructor(access: LightAccess) {
    this.access = access;
  }

  /**
   * Light a chunk that has just been generated, and let the light of the
   * chunks already around it flow in. Safe to call again to relight one from
   * scratch after a bulk edit.
   */
  seedChunk(chunk: Chunk): void {
    this.begin();
    chunk.light.fill(0);
    chunk.lit = true;

    const ox = chunk.cx * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;

    // Daylight down each column, and every emitter on the way past.
    // `shadedTop` is the highest point anywhere in the chunk where the sky is
    // not at full strength: above it there is nothing but open air.
    let shadedTop = -1;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        let level = MAX_LIGHT;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const index = Chunk.index(lx, y, lz);
          const id = chunk.data[index];
          const opacity = OPACITY[id];
          level = opacity >= MAX_LIGHT ? 0 : level - opacity;
          if (level < 0) level = 0;
          if (level < MAX_LIGHT && y > shadedTop) shadedTop = y;
          const emission = EMISSION[id];
          chunk.light[index] = packLight(level, emission);
          if (emission > 0) this.addQueue.push(ox + lx, y, oz + lz);
        }
      }
    }

    // Anywhere daylight stops short of its neighbour is where it spreads
    // sideways: cave mouths, overhangs, the shaded side of a hill. Columns are
    // dimmest at the bottom, so each one can stop as soon as it hits the dark,
    // and only the chunk's own border needs looking at above the terrain —
    // that is where the light of the chunk next door has to be handed over.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const border = lx === 0 || lz === 0 || lx === CHUNK_SIZE - 1 || lz === CHUNK_SIZE - 1;
        const from = border ? WORLD_HEIGHT - 1 : Math.min(shadedTop + 1, WORLD_HEIGHT - 1);
        for (let y = from; y >= 0; y--) {
          const sky = skyOf(chunk.light[Chunk.index(lx, y, lz)]);
          if (sky === 0) break; // and everything under it is dark too
          if (sky === 1) continue; // too dim to light anything else
          if (border || this.hasDarkerNeighbour(chunk, lx, y, lz, sky)) {
            this.addQueue.push(ox + lx, y, oz + lz);
          }
        }
      }
    }
    this.propagate(true);
    this.propagate(false);

    // Now the other direction: light already standing in the neighbouring
    // chunks spills into this one.
    this.seedFromNeighbours(chunk);
    this.propagate(true);
    this.propagate(false);

    this.flush();
  }

  /** Does any in-chunk side neighbour hold less light than `sky`? */
  private hasDarkerNeighbour(chunk: Chunk, lx: number, y: number, lz: number, sky: number): boolean {
    if (lx > 0 && skyOf(chunk.light[Chunk.index(lx - 1, y, lz)]) < sky - 1) return true;
    if (lx < CHUNK_SIZE - 1 && skyOf(chunk.light[Chunk.index(lx + 1, y, lz)]) < sky - 1) return true;
    if (lz > 0 && skyOf(chunk.light[Chunk.index(lx, y, lz - 1)]) < sky - 1) return true;
    if (lz < CHUNK_SIZE - 1 && skyOf(chunk.light[Chunk.index(lx, y, lz + 1)]) < sky - 1) return true;
    return false;
  }

  /** Queue every lit cell along the four shared borders of the chunks around this one. */
  private seedFromNeighbours(chunk: Chunk): void {
    const sides = [
      { dcx: -1, dcz: 0, lx: CHUNK_SIZE - 1, lz: -1 },
      { dcx: 1, dcz: 0, lx: 0, lz: -1 },
      { dcx: 0, dcz: -1, lx: -1, lz: CHUNK_SIZE - 1 },
      { dcx: 0, dcz: 1, lx: -1, lz: 0 },
    ];
    for (const side of sides) {
      const neighbour = this.access.peekChunk(chunk.cx + side.dcx, chunk.cz + side.dcz);
      if (!neighbour || !neighbour.lit) continue;
      const ox = neighbour.cx * CHUNK_SIZE;
      const oz = neighbour.cz * CHUNK_SIZE;
      for (let i = 0; i < CHUNK_SIZE; i++) {
        const lx = side.lx < 0 ? i : side.lx;
        const lz = side.lz < 0 ? i : side.lz;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          if (neighbour.light[Chunk.index(lx, y, lz)] === 0) continue;
          this.addQueue.push(ox + lx, y, oz + lz);
        }
      }
    }
  }

  /**
   * A block changed. Unlight whatever the old one was responsible for, then
   * let the neighbours light the hole back up.
   */
  blockChanged(x: number, y: number, z: number, newId: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    this.begin();
    const chunk = this.chunkFor(x, z);
    if (!chunk || !chunk.lit) return; // not lit yet: seeding will cover it

    for (const sky of [false, true]) {
      const old = this.get(sky, x, y, z);
      if (old > 0) {
        this.set(sky, x, y, z, 0);
        this.removeQueue.push(x, y, z, old);
        this.runRemoval(sky);
      }
      // Whatever is around it can flow back in — including straight down from
      // an open sky, which is how a dug shaft lights up to the bottom.
      for (let d = 0; d < DIRS.length; d += 3) {
        this.addQueue.push(x + DIRS[d], y + DIRS[d + 1], z + DIRS[d + 2]);
      }
      this.propagate(sky);
    }

    const emission = lightEmission(newId);
    if (emission > 0) {
      this.set(false, x, y, z, emission);
      this.addQueue.push(x, y, z);
      this.propagate(false);
    }
    this.flush();
  }

  /** The packed light byte at a world position; 0 where nothing is loaded. */
  lightAt(x: number, y: number, z: number): number {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return packLight(MAX_LIGHT, 0);
    this.memoValid = false;
    const chunk = this.chunkFor(x, z);
    if (!chunk || !chunk.lit) return 0;
    return chunk.light[this.indexIn(chunk, x, y, z)];
  }

  /** True when this position belongs to a chunk whose light is known. */
  isLit(x: number, z: number): boolean {
    this.memoValid = false;
    const chunk = this.chunkFor(x, z);
    return chunk !== null && chunk.lit;
  }

  // --- Flood fills --------------------------------------------------------

  /** Spread light outward from everything in the add queue. */
  private propagate(sky: boolean): void {
    const queue = this.addQueue;
    for (let head = 0; head < queue.length; head += 3) {
      const x = queue[head];
      const y = queue[head + 1];
      const z = queue[head + 2];
      const level = this.get(sky, x, y, z);
      if (level <= 1) continue;
      for (let d = 0; d < DIRS.length; d += 3) {
        const dy = DIRS[d + 1];
        const nx = x + DIRS[d];
        const ny = y + dy;
        const nz = z + DIRS[d + 2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const id = this.blockAt(nx, ny, nz);
        if (id < 0) continue; // not loaded: light stops at the edge of the world
        const opacity = OPACITY[id];
        if (opacity >= MAX_LIGHT) continue;
        // Daylight does not weaken on the way down, so a shaft stays bright
        // all the way to the bottom rather than fading out after fifteen blocks.
        const target =
          sky && dy === -1 && level === MAX_LIGHT && opacity === 0
            ? MAX_LIGHT
            : level - Math.max(1, opacity);
        if (target <= 0 || this.get(sky, nx, ny, nz) >= target) continue;
        this.set(sky, nx, ny, nz, target);
        queue.push(nx, ny, nz);
      }
    }
    queue.length = 0;
  }

  /**
   * Unlight everything that was only lit by what just vanished, and collect
   * the cells at the edge of the hole that are still lit by something else.
   */
  private runRemoval(sky: boolean): void {
    const queue = this.removeQueue;
    for (let head = 0; head < queue.length; head += 4) {
      const x = queue[head];
      const y = queue[head + 1];
      const z = queue[head + 2];
      const level = queue[head + 3];
      for (let d = 0; d < DIRS.length; d += 3) {
        const dy = DIRS[d + 1];
        const nx = x + DIRS[d];
        const ny = y + dy;
        const nz = z + DIRS[d + 2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (this.blockAt(nx, ny, nz) < 0) continue;
        const neighbour = this.get(sky, nx, ny, nz);
        if (neighbour === 0) continue;
        // A column of full-strength daylight below the change goes dark too,
        // even though it never looked dimmer than the cell above it.
        const fellFromHere = sky && dy === -1 && level === MAX_LIGHT && neighbour === MAX_LIGHT;
        if (neighbour < level || fellFromHere) {
          this.set(sky, nx, ny, nz, 0);
          queue.push(nx, ny, nz, neighbour);
        } else {
          this.addQueue.push(nx, ny, nz);
        }
      }
    }
    queue.length = 0;
  }

  // --- Storage ------------------------------------------------------------

  private begin(): void {
    this.memoValid = false;
    this.addQueue.length = 0;
    this.removeQueue.length = 0;
  }

  private flush(): void {
    for (const chunk of this.touched) this.access.onLightChanged?.(chunk);
    this.touched.clear();
  }

  private chunkFor(x: number, z: number): Chunk | null {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    if (this.memoValid && cx === this.memoCx && cz === this.memoCz) return this.memo;
    this.memo = this.access.peekChunk(cx, cz);
    this.memoCx = cx;
    this.memoCz = cz;
    this.memoValid = true;
    return this.memo;
  }

  private indexIn(chunk: Chunk, x: number, y: number, z: number): number {
    return Chunk.index(x - chunk.cx * CHUNK_SIZE, y, z - chunk.cz * CHUNK_SIZE);
  }

  /** Block id, or -1 where there is nothing loaded to light. */
  private blockAt(x: number, y: number, z: number): number {
    const chunk = this.chunkFor(x, z);
    if (!chunk || !chunk.lit) return -1;
    return chunk.data[this.indexIn(chunk, x, y, z)];
  }

  private get(sky: boolean, x: number, y: number, z: number): number {
    if (y < 0) return 0;
    if (y >= WORLD_HEIGHT) return sky ? MAX_LIGHT : 0;
    const chunk = this.chunkFor(x, z);
    if (!chunk || !chunk.lit) return 0;
    const packed = chunk.light[this.indexIn(chunk, x, y, z)];
    return sky ? skyOf(packed) : blockOf(packed);
  }

  private set(sky: boolean, x: number, y: number, z: number, value: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const chunk = this.chunkFor(x, z);
    if (!chunk || !chunk.lit) return;
    const index = this.indexIn(chunk, x, y, z);
    const packed = chunk.light[index];
    chunk.light[index] = sky
      ? packLight(value, blockOf(packed))
      : packLight(skyOf(packed), value);
    this.touched.add(chunk);
  }
}
