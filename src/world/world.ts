import * as THREE from 'three';
import { Block, isSolid } from '../blocks';
import {
  CHUNK_SIZE,
  MAX_CHUNK_GENS_PER_FRAME,
  MESH_BUDGET_MS,
  UNLOAD_PADDING,
  WORLD_HEIGHT,
} from '../constants';
import { Chunk } from './chunk';
import {
  buildChunkGeometry,
  getCutoutMaterial,
  getOpaqueMaterial,
  getWaterMaterial,
} from './mesher';
import { TerrainGenerator } from './terrain';

/** Sparse per-chunk map of player edits: voxel index -> block id. */
export type ChunkEdits = Map<number, number>;

export class World {
  readonly terrain: TerrainGenerator;
  readonly chunks = new Map<string, Chunk>();
  /** All edits ever made, kept for chunks whether loaded or not. */
  readonly edits = new Map<string, ChunkEdits>();
  /** Chunk keys whose edits changed since the last save flush. */
  readonly unsavedEditKeys = new Set<string>();

  private readonly scene: THREE.Scene;
  private readonly dirtyQueue = new Set<Chunk>();
  private frame = 0;

  /**
   * Multiplayer hooks. Both are null in singleplayer, so that path is
   * byte-for-byte the behaviour it had before multiplayer existed.
   */
  onLocalEdit: ((wx: number, wy: number, wz: number, id: number) => void) | null = null;
  onChunkCreated: ((key: string) => void) | null = null;
  /** Multiplayer worlds are server-authoritative and are not written to IndexedDB. */
  persistEdits = true;

  constructor(seed: number, scene: THREE.Scene, savedEdits?: Map<string, ChunkEdits>) {
    this.terrain = new TerrainGenerator(seed);
    this.scene = scene;
    if (savedEdits) {
      for (const [key, edits] of savedEdits) this.edits.set(key, edits);
    }
  }

  /** Block id at world coords; Air for unloaded chunks or above the world. */
  getBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= WORLD_HEIGHT) return Block.Air;
    const chunk = this.chunkAtWorld(wx, wz);
    if (!chunk) return Block.Air;
    return chunk.get(wx - chunk.cx * CHUNK_SIZE, wy, wz - chunk.cz * CHUNK_SIZE);
  }

  /**
   * Sampler for meshing: below the world reads as stone (culls the underside),
   * above and in unloaded chunks as air (draws a solid wall at the load edge).
   */
  readonly meshSampler = (wx: number, wy: number, wz: number): number => {
    if (wy < 0) return Block.Stone;
    if (wy >= WORLD_HEIGHT) return Block.Air;
    const chunk = this.chunkAtWorld(wx, wz);
    if (!chunk) return Block.Air;
    return chunk.get(wx - chunk.cx * CHUNK_SIZE, wy, wz - chunk.cz * CHUNK_SIZE);
  };

  /** Collision query: unloaded chunks and below-world read as solid so the player never falls through terrain that hasn't streamed in yet. */
  isSolidAt(wx: number, wy: number, wz: number): boolean {
    if (wy < 0) return true;
    if (wy >= WORLD_HEIGHT) return false;
    const chunk = this.chunkAtWorld(wx, wz);
    if (!chunk) return true;
    return isSolid(chunk.get(wx - chunk.cx * CHUNK_SIZE, wy, wz - chunk.cz * CHUNK_SIZE));
  }

  setBlock(wx: number, wy: number, wz: number, id: number): boolean {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const chunk = this.chunks.get(Chunk.key(cx, cz));
    if (!chunk) return false;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    chunk.set(lx, wy, lz, id);

    this.recordEdit(Chunk.key(cx, cz), Chunk.index(lx, wy, lz), id);
    this.markDirty(chunk);
    this.markNeighborsDirty(cx, cz, lx, lz);
    this.onLocalEdit?.(wx, wy, wz, id);
    return true;
  }

  /** Store an edit in the sparse diff map (and queue it for saving if enabled). */
  private recordEdit(key: string, index: number, id: number): void {
    let edits = this.edits.get(key);
    if (!edits) {
      edits = new Map();
      this.edits.set(key, edits);
    }
    edits.set(index, id);
    if (this.persistEdits) this.unsavedEditKeys.add(key);
  }

  /** A border edit changes face culling/AO in the adjacent chunk too. */
  private markNeighborsDirty(cx: number, cz: number, lx: number, lz: number): void {
    if (lx === 0) this.markDirtyAt(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirtyAt(cx + 1, cz);
    if (lz === 0) this.markDirtyAt(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirtyAt(cx, cz + 1);
  }

  /**
   * Apply an edit that came from another player. Unlike setBlock this succeeds
   * even when the chunk is not loaded: the edit lands in the diff map, and
   * createChunk replays it if and when the player walks over there.
   * Never re-broadcasts (no onLocalEdit), so edits cannot echo around the room.
   */
  applyRemoteEdit(wx: number, wy: number, wz: number, id: number): void {
    if (wy < 0 || wy >= WORLD_HEIGHT) return;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    this.recordEdit(Chunk.key(cx, cz), Chunk.index(lx, wy, lz), id);

    const chunk = this.chunks.get(Chunk.key(cx, cz));
    if (!chunk) return; // will be replayed on load
    chunk.set(lx, wy, lz, id);
    this.markDirty(chunk);
    this.markNeighborsDirty(cx, cz, lx, lz);
  }

  /**
   * Bulk-apply one chunk's edits from the server, as flat [index, id] pairs.
   * Used for the backlog a late joiner receives.
   */
  applyChunkEdits(key: string, pairs: number[]): void {
    const [cxRaw, czRaw] = key.split(',');
    const cx = Number(cxRaw);
    const cz = Number(czRaw);
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) return;

    let edits = this.edits.get(key);
    if (!edits) {
      edits = new Map();
      this.edits.set(key, edits);
    }
    const chunk = this.chunks.get(key);
    const voxels = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const index = pairs[i];
      const id = pairs[i + 1];
      if (!Number.isInteger(index) || index < 0 || index >= voxels) continue;
      edits.set(index, id);
      if (chunk) chunk.data[index] = id;
    }
    if (this.persistEdits) this.unsavedEditKeys.add(key);
    if (chunk) {
      this.markDirty(chunk);
      // A bulk apply can touch any border, so refresh all four neighbours once.
      this.markDirtyAt(cx - 1, cz);
      this.markDirtyAt(cx + 1, cz);
      this.markDirtyAt(cx, cz - 1);
      this.markDirtyAt(cx, cz + 1);
    }
  }

  private chunkAtWorld(wx: number, wz: number): Chunk | undefined {
    return this.chunks.get(Chunk.key(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
  }

  private markDirty(chunk: Chunk): void {
    chunk.dirty = true;
    this.dirtyQueue.add(chunk);
  }

  private markDirtyAt(cx: number, cz: number): void {
    const chunk = this.chunks.get(Chunk.key(cx, cz));
    if (chunk) this.markDirty(chunk);
  }

  /** Stream chunks around the player and process the remesh queue. */
  update(
    playerX: number,
    playerZ: number,
    viewDistance: number,
    maxGensPerFrame = MAX_CHUNK_GENS_PER_FRAME,
    meshBudgetMs = MESH_BUDGET_MS,
  ): void {
    this.frame++;
    const pcx = Math.floor(playerX / CHUNK_SIZE);
    const pcz = Math.floor(playerZ / CHUNK_SIZE);

    // Generate missing chunks, nearest ring first, a few per frame.
    let gens = 0;
    outer: for (let r = 0; r <= viewDistance; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const key = Chunk.key(pcx + dx, pcz + dz);
          if (this.chunks.has(key)) continue;
          this.createChunk(pcx + dx, pcz + dz);
          if (++gens >= maxGensPerFrame) break outer;
        }
      }
    }

    if (this.frame % 30 === 0) this.unloadDistantChunks(pcx, pcz, viewDistance);

    this.processMeshQueue(pcx, pcz, meshBudgetMs);
  }

  private createChunk(cx: number, cz: number): void {
    const chunk = new Chunk(cx, cz);
    this.terrain.generate(chunk);
    const key = Chunk.key(cx, cz);
    const edits = this.edits.get(key);
    if (edits) {
      for (const [idx, id] of edits) chunk.data[idx] = id;
    }
    this.chunks.set(key, chunk);
    // Multiplayer: ask the server for any edits this chunk has that we missed.
    this.onChunkCreated?.(key);
    this.markDirty(chunk);
    // Neighbours were meshed assuming this space was air; rebuild their borders.
    this.markDirtyAt(cx - 1, cz);
    this.markDirtyAt(cx + 1, cz);
    this.markDirtyAt(cx, cz - 1);
    this.markDirtyAt(cx, cz + 1);
  }

  private unloadDistantChunks(pcx: number, pcz: number, viewDistance: number): void {
    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (dist <= viewDistance + UNLOAD_PADDING) continue;
      this.disposeChunkMeshes(chunk);
      this.dirtyQueue.delete(chunk);
      this.chunks.delete(key);
    }
  }

  private processMeshQueue(pcx: number, pcz: number, budgetMs: number): void {
    if (this.dirtyQueue.size === 0) return;
    const queue = [...this.dirtyQueue].sort(
      (a, b) =>
        Math.hypot(a.cx - pcx, a.cz - pcz) - Math.hypot(b.cx - pcx, b.cz - pcz),
    );
    const start = performance.now();
    for (const chunk of queue) {
      this.remesh(chunk);
      this.dirtyQueue.delete(chunk);
      if (performance.now() - start > budgetMs) break;
    }
  }

  private remesh(chunk: Chunk): void {
    this.disposeChunkMeshes(chunk);
    const { opaque, cutout, water } = buildChunkGeometry(chunk, this.meshSampler);
    const origin = new THREE.Vector3(chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE);
    if (opaque) {
      chunk.opaqueMesh = new THREE.Mesh(opaque, getOpaqueMaterial());
      chunk.opaqueMesh.position.copy(origin);
      this.scene.add(chunk.opaqueMesh);
    }
    if (cutout) {
      chunk.cutoutMesh = new THREE.Mesh(cutout, getCutoutMaterial());
      chunk.cutoutMesh.position.copy(origin);
      this.scene.add(chunk.cutoutMesh);
    }
    if (water) {
      chunk.waterMesh = new THREE.Mesh(water, getWaterMaterial());
      chunk.waterMesh.position.copy(origin);
      chunk.waterMesh.renderOrder = 1;
      this.scene.add(chunk.waterMesh);
    }
    chunk.dirty = false;
  }

  private disposeChunkMeshes(chunk: Chunk): void {
    for (const mesh of [chunk.opaqueMesh, chunk.cutoutMesh, chunk.waterMesh]) {
      if (mesh) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    chunk.opaqueMesh = null;
    chunk.cutoutMesh = null;
    chunk.waterMesh = null;
  }

  get pendingMeshCount(): number {
    return this.dirtyQueue.size;
  }
}
