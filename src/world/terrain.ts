// Seeded terrain generation: heightmap layers plus deterministic trees.
// Everything is a pure function of (seed, coordinates) so any chunk can be
// regenerated independently and trees stay consistent across chunk borders.

import { Block } from '../blocks';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../constants';
import { Chunk } from './chunk';
import { coordRandom, fbm2, fbm3, smoothstep } from './noise';

const TREE_SALT = 0x7ee5;
const TREE_CHANCE = 0.007;
const TREE_MARGIN = 2; // how far outside a chunk a tree centre can still reach in

/**
 * Carve where the cave metric falls below this; see TerrainGenerator.caveMetric.
 * This is the measured 5th percentile of that metric, i.e. ~5% of underground
 * volume becomes cave.
 */
const CAVE_THRESHOLD = 0.0414;

export class TerrainGenerator {
  constructor(readonly seed: number) {}

  /** Ground height: terrain occupies y in [0, height). */
  heightAt(wx: number, wz: number): number {
    const s = this.seed;
    // Continentality decides ocean vs land, rolling hills sit on top of it, a
    // low-frequency mountain mask gates ridged peaks, and fine detail roughens
    // surfaces. Tuned so roughly a quarter of the map is below sea level.
    const continent = fbm2(wx * 0.0035 - 300, wz * 0.0035 + 300, s + 123, 3);
    const base = fbm2(wx * 0.01, wz * 0.01, s, 4);
    const mountainMask = smoothstep(0.55, 0.8, fbm2(wx * 0.003 + 100, wz * 0.003 - 100, s + 991, 3));
    const ridge = fbm2(wx * 0.02 + 7, wz * 0.02 + 7, s + 337, 4);
    const detail = fbm2(wx * 0.06, wz * 0.06, s + 555, 2) * 3 - 1.5;
    const h = 27 + (continent - 0.45) * 40 + base * 6 + mountainMask * ridge * 22 + detail;
    return Math.max(4, Math.min(WORLD_HEIGHT - 12, Math.floor(h)));
  }

  /** Nearest land column to the origin, spiralling outward — used for spawn. */
  findSpawnColumn(): { x: number; z: number; y: number } {
    for (let r = 0; r < 32; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = 8 + dx * 8;
          const z = 8 + dz * 8;
          const h = this.heightAt(x, z);
          if (h > SEA_LEVEL + 2) return { x, z, y: h };
        }
      }
    }
    return { x: 8, z: 8, y: this.heightAt(8, 8) };
  }

  private treeAt(wx: number, wz: number): { height: number } | null {
    if (coordRandom(wx, wz, this.seed ^ TREE_SALT) >= TREE_CHANCE) return null;
    const ground = this.heightAt(wx, wz);
    // Trees only on grass, comfortably above the beach line.
    if (ground <= SEA_LEVEL + 2) return null;
    // Don't root a tree over a cave mouth — it would be left floating.
    if (this.isCaveAt(wx, ground - 1, wz)) return null;
    const r = coordRandom(wx, wz, this.seed ^ (TREE_SALT + 1));
    return { height: 4 + Math.floor(r * 3) };
  }

  /**
   * Caves are the intersection of two noise "sheets": each |noise - 0.5| < t
   * band is a warped surface, and where two of them cross you get a tunnel
   * rather than the swiss-cheese blobs a single threshold produces.
   *
   * Returns how far the worst of the two sheets is from its centre, so
   * `metric < CAVE_THRESHOLD` is the carve test. Exposed for calibration:
   * the threshold is the Nth percentile of this metric, which is how the
   * value below was picked (~5% of underground volume carved).
   */
  caveMetric(wx: number, y: number, wz: number): number {
    // Y is scaled up so tunnels run flatter than they do wide.
    const a = fbm3(wx * 0.031, y * 0.055, wz * 0.031, this.seed + 4001, 2);
    const b = fbm3(wx * 0.031, y * 0.055, wz * 0.031, this.seed + 8009, 2);
    return Math.max(Math.abs(a - 0.5), Math.abs(b - 0.5));
  }

  isCaveAt(wx: number, y: number, wz: number): boolean {
    if (y < 2) return false;
    return this.caveMetric(wx, y, wz) < CAVE_THRESHOLD;
  }

  /** Ore blobs: rarer and deeper as the material gets more valuable. */
  private oreAt(wx: number, y: number, wz: number, ground: number): number | null {
    const blob = (salt: number, freq: number): number =>
      fbm3(wx * freq, y * freq, wz * freq, this.seed + salt, 2);
    if (y < 14 && blob(9101, 0.155) > 0.815) return Block.DiamondOre;
    if (y < 28 && blob(9203, 0.145) > 0.79) return Block.GoldOre;
    if (y < 46 && blob(9307, 0.135) > 0.752) return Block.IronOre;
    if (y < ground - 3 && blob(9403, 0.125) > 0.722) return Block.CoalOre;
    return null;
  }

  generate(chunk: Chunk): void {
    const ox = chunk.cx * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        const ground = this.heightAt(wx, wz);
        const beach = ground <= SEA_LEVEL + 1;
        // Keep the sea floor sealed: an open cave under water would be a dry
        // air pocket, since water here is static.
        const underwater = ground < SEA_LEVEL;

        for (let y = 0; y < ground; y++) {
          let id: number;
          if (y === 0) id = Block.Bedrock;
          else if (y < ground - 4) id = Block.Stone;
          else if (y < ground - 1) id = beach ? Block.Sand : Block.Dirt;
          else id = beach ? Block.Sand : Block.Grass;

          if (id === Block.Stone) {
            const sealFloor = underwater && y >= ground - 3;
            if (!sealFloor && this.isCaveAt(wx, y, wz)) {
              id = Block.Air;
            } else {
              // Gravel patches, then ores, both only inside stone.
              if (fbm3(wx * 0.085, y * 0.085, wz * 0.085, this.seed + 5501, 2) > 0.735) {
                id = Block.Gravel;
              } else {
                id = this.oreAt(wx, y, wz, ground) ?? id;
              }
            }
          } else if (y > 1 && y < ground - 1 && !underwater && this.isCaveAt(wx, y, wz)) {
            // Let tunnels break through dirt so caves have surface entrances.
            id = Block.Air;
          }

          chunk.set(lx, y, lz, id);
        }
        for (let y = ground; y < SEA_LEVEL; y++) {
          chunk.set(lx, y, lz, Block.Water);
        }
      }
    }

    // Trees whose centre lies in or near this chunk; blocks are clipped to the
    // chunk so a tree spanning a border renders identically from both sides.
    for (let wz = oz - TREE_MARGIN; wz < oz + CHUNK_SIZE + TREE_MARGIN; wz++) {
      for (let wx = ox - TREE_MARGIN; wx < ox + CHUNK_SIZE + TREE_MARGIN; wx++) {
        const tree = this.treeAt(wx, wz);
        if (tree) this.placeTree(chunk, wx, wz, tree.height);
      }
    }
  }

  private placeTree(chunk: Chunk, wx: number, wz: number, trunkHeight: number): void {
    const ground = this.heightAt(wx, wz);
    const topY = ground + trunkHeight - 1;

    // Leaf blob: two 5x5 layers (corners trimmed), then a 3x3, then a plus.
    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy;
      const radius = dy <= -1 ? 2 : 1;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const isCorner = Math.abs(dx) === radius && Math.abs(dz) === radius;
          if (radius === 2 && isCorner && coordRandom(wx + dx, wz + dz, this.seed ^ y) < 0.5) continue;
          if (dy === 1 && isCorner) continue;
          this.setIfInside(chunk, wx + dx, y, wz + dz, Block.Leaves, true);
        }
      }
    }
    for (let y = ground; y <= topY; y++) {
      this.setIfInside(chunk, wx, y, wz, Block.Log, false);
    }
  }

  private setIfInside(
    chunk: Chunk,
    wx: number,
    y: number,
    wz: number,
    id: number,
    onlyIntoAir: boolean,
  ): void {
    const lx = wx - chunk.cx * CHUNK_SIZE;
    const lz = wz - chunk.cz * CHUNK_SIZE;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
    if (y < 0 || y >= WORLD_HEIGHT) return;
    if (onlyIntoAir && chunk.get(lx, y, lz) !== Block.Air) return;
    chunk.set(lx, y, lz, id);
  }
}
