// Server-side view of a room's world.
//
// This is what makes mobs genuinely server-authoritative: the server runs the
// SAME TerrainGenerator the clients do, so it knows what the ground looks like
// and can collide mobs against it. Chunks are generated on demand around the
// players and evicted behind them, so a room's memory stays bounded no matter
// how far anyone travels.

import { BLOCKS } from '../src/blocks.ts';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../src/constants.ts';
import { Chunk } from '../src/world/chunk.ts';
import { TerrainGenerator } from '../src/world/terrain.ts';
import type { Vec3 } from '../src/shared/voxel.ts';
import type { SimWorld } from '../src/shared/roomsim.ts';

/** Chunks are kept this far (in chunks) around any player, then evicted. */
const KEEP_RADIUS = 4;
/** Hard cap in case players scatter; oldest-touched chunks go first. */
const MAX_CHUNKS = 400;

export class ServerWorld implements SimWorld {
  readonly terrain: TerrainGenerator;
  private readonly chunks = new Map<string, Chunk>();
  /** Last tick each chunk was touched, for eviction. */
  private readonly touched = new Map<string, number>();
  private tick = 0;

  /** Live reference to the room's edits: chunkKey -> voxelIndex -> blockId. */
  private readonly edits: Map<string, Map<number, number>>;

  constructor(seed: number, edits: Map<string, Map<number, number>>) {
    this.terrain = new TerrainGenerator(seed);
    this.edits = edits;
  }

  private chunkAt(cx: number, cz: number): Chunk {
    const key = Chunk.key(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      this.terrain.generate(chunk);
      // Replay the room's edits so the server sees the world players see.
      const edits = this.edits.get(key);
      if (edits) for (const [index, id] of edits) chunk.data[index] = id;
      this.chunks.set(key, chunk);
    }
    this.touched.set(key, this.tick);
    return chunk;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunkAt(cx, cz);
    return chunk.get(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    // Below bedrock is solid so nothing falls out of the world; above the
    // build limit is open sky.
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    const id = this.getBlock(x, y, z);
    return id !== 0 && BLOCKS[id].solid;
  }

  /** Mirror a block edit that the room accepted. */
  applyEdit(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = Chunk.key(cx, cz);
    // Only touch a chunk we already hold; otherwise the edit is already in the
    // room's edit map and will be replayed when the chunk is next generated.
    const chunk = this.chunks.get(key);
    if (chunk) chunk.set(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE, id);
  }

  /** Drop chunks nobody is standing near, keeping memory flat. */
  evict(playerPositions: Vec3[]): void {
    this.tick++;
    if (this.chunks.size <= MAX_CHUNKS / 2) return;

    const keep = new Set<string>();
    for (const pos of playerPositions) {
      const pcx = Math.floor(pos.x / CHUNK_SIZE);
      const pcz = Math.floor(pos.z / CHUNK_SIZE);
      for (let dz = -KEEP_RADIUS; dz <= KEEP_RADIUS; dz++) {
        for (let dx = -KEEP_RADIUS; dx <= KEEP_RADIUS; dx++) {
          keep.add(Chunk.key(pcx + dx, pcz + dz));
        }
      }
    }

    for (const key of [...this.chunks.keys()]) {
      if (keep.has(key)) continue;
      this.chunks.delete(key);
      this.touched.delete(key);
    }

    // Still over the cap (players far apart): evict least-recently-touched.
    if (this.chunks.size > MAX_CHUNKS) {
      const order = [...this.touched.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of order.slice(0, this.chunks.size - MAX_CHUNKS)) {
        this.chunks.delete(key);
        this.touched.delete(key);
      }
    }
  }

  /** Ground height for spawning, honouring edits where the chunk is loaded. */
  surfaceAt(x: number, z: number): number | null {
    const generated = this.terrain.heightAt(x, z);
    for (let y = generated + 6; y >= Math.max(1, generated - 8); y--) {
      if (!this.isSolidAt(x, y, z)) continue;
      if (this.getBlock(x, y + 1, z) !== 0 || this.getBlock(x, y + 2, z) !== 0) return null;
      return y + 1;
    }
    return null;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }
}
