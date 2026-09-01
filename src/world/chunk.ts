import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants';

/**
 * One 16 x WORLD_HEIGHT x 16 column of voxels. Block ids are stored in a flat
 * Uint8Array indexed x + z*16 + y*256 so a horizontal slice is contiguous.
 */
export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly data: Uint8Array;
  dirty = true; // needs (re)meshing
  opaqueMesh: THREE.Mesh | null = null;
  cutoutMesh: THREE.Mesh | null = null;
  waterMesh: THREE.Mesh | null = null;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
  }

  static index(lx: number, ly: number, lz: number): number {
    return lx + lz * CHUNK_SIZE + ly * CHUNK_SIZE * CHUNK_SIZE;
  }

  get(lx: number, ly: number, lz: number): number {
    return this.data[Chunk.index(lx, ly, lz)];
  }

  set(lx: number, ly: number, lz: number, id: number): void {
    this.data[Chunk.index(lx, ly, lz)] = id;
  }

  static key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }
}
