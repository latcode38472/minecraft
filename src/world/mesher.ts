// Chunk mesher: culled face meshing with baked ambient occlusion.
//
// For every non-air voxel we emit a quad only for faces adjacent to a
// non-opaque block, so interior faces cost nothing. Each vertex carries a
// grayscale colour = directional face shade x ambient occlusion, computed from
// the three blocks diagonally adjacent to the vertex (the classic 0fps AO
// scheme). Water goes into a separate transparent mesh with its top surface
// lowered slightly when exposed to air.

import * as THREE from 'three';
import { BLOCKS, Block, isCutout, isOpaque } from '../blocks';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants';
import { getAtlasTexture, tileUVRect } from '../textures';
import { Chunk } from './chunk';

export type BlockSampler = (wx: number, wy: number, wz: number) => number;

interface FaceDef {
  dir: [number, number, number];
  // Corner positions in CCW order viewed from outside; uv maps corner -> tile UV.
  corners: { pos: [number, number, number]; uv: [number, number] }[];
  shade: number;
  kind: 'top' | 'bottom' | 'side';
}

const FACES: FaceDef[] = [
  {
    dir: [1, 0, 0],
    shade: 0.8,
    kind: 'side',
    corners: [
      { pos: [1, 0, 0], uv: [0, 0] },
      { pos: [1, 1, 0], uv: [0, 1] },
      { pos: [1, 1, 1], uv: [1, 1] },
      { pos: [1, 0, 1], uv: [1, 0] },
    ],
  },
  {
    dir: [-1, 0, 0],
    shade: 0.8,
    kind: 'side',
    corners: [
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [0, 0, 1], uv: [1, 0] },
      { pos: [0, 1, 1], uv: [1, 1] },
      { pos: [0, 1, 0], uv: [0, 1] },
    ],
  },
  {
    dir: [0, 1, 0],
    shade: 1.0,
    kind: 'top',
    corners: [
      { pos: [0, 1, 0], uv: [0, 0] },
      { pos: [0, 1, 1], uv: [0, 1] },
      { pos: [1, 1, 1], uv: [1, 1] },
      { pos: [1, 1, 0], uv: [1, 0] },
    ],
  },
  {
    dir: [0, -1, 0],
    shade: 0.55,
    kind: 'bottom',
    corners: [
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [1, 0, 0], uv: [1, 0] },
      { pos: [1, 0, 1], uv: [1, 1] },
      { pos: [0, 0, 1], uv: [0, 1] },
    ],
  },
  {
    dir: [0, 0, 1],
    shade: 0.7,
    kind: 'side',
    corners: [
      { pos: [0, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 1], uv: [1, 0] },
      { pos: [1, 1, 1], uv: [1, 1] },
      { pos: [0, 1, 1], uv: [0, 1] },
    ],
  },
  {
    dir: [0, 0, -1],
    shade: 0.7,
    kind: 'side',
    corners: [
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [0, 1, 0], uv: [0, 1] },
      { pos: [1, 1, 0], uv: [1, 1] },
      { pos: [1, 0, 0], uv: [1, 0] },
    ],
  },
];

const AO_LEVELS = [0.45, 0.62, 0.8, 1.0];
const WATER_SURFACE_Y = 0.875;

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  build(): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setIndex(new THREE.Uint32BufferAttribute(this.indices, 1));
    return geo;
  }
}

let opaqueMaterial: THREE.MeshLambertMaterial | null = null;
let cutoutMaterial: THREE.MeshLambertMaterial | null = null;
let waterMaterial: THREE.MeshLambertMaterial | null = null;

export function getOpaqueMaterial(): THREE.MeshLambertMaterial {
  if (!opaqueMaterial) {
    opaqueMaterial = new THREE.MeshLambertMaterial({ map: getAtlasTexture(), vertexColors: true });
  }
  return opaqueMaterial;
}

/** See-through blocks (glass): alpha-tested, so no transparency sorting. */
export function getCutoutMaterial(): THREE.MeshLambertMaterial {
  if (!cutoutMaterial) {
    cutoutMaterial = new THREE.MeshLambertMaterial({
      map: getAtlasTexture(),
      vertexColors: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
  }
  return cutoutMaterial;
}

export function getWaterMaterial(): THREE.MeshLambertMaterial {
  if (!waterMaterial) {
    waterMaterial = new THREE.MeshLambertMaterial({
      map: getAtlasTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return waterMaterial;
}

export interface ChunkGeometry {
  opaque: THREE.BufferGeometry | null;
  cutout: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
}

export function buildChunkGeometry(chunk: Chunk, sample: BlockSampler): ChunkGeometry {
  const opaque = new MeshBuilder();
  const cutout = new MeshBuilder();
  const water = new MeshBuilder();
  const ox = chunk.cx * CHUNK_SIZE;
  const oz = chunk.cz * CHUNK_SIZE;

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = chunk.get(lx, y, lz);
        if (id === Block.Air) continue;
        const wx = ox + lx;
        const wz = oz + lz;
        const isWater = id === Block.Water;
        const cut = isCutout(id);
        const def = BLOCKS[id];
        const target = isWater ? water : cut ? cutout : opaque;

        for (const face of FACES) {
          const neighbor = sample(wx + face.dir[0], y + face.dir[1], wz + face.dir[2]);
          if (isWater) {
            if (neighbor !== Block.Air) continue;
          } else if (cut) {
            // Cull against opaque neighbours and against the same block, so a
            // glass wall has no interior faces but still shows through.
            if (isOpaque(neighbor) || neighbor === id) continue;
          } else if (isOpaque(neighbor)) {
            continue;
          }
          const tile = def.tiles[face.kind];
          emitFace(target, face, lx, y, lz, wx, wz, tile, isWater, sample);
        }
      }
    }
  }

  return { opaque: opaque.build(), cutout: cutout.build(), water: water.build() };
}

function emitFace(
  out: MeshBuilder,
  face: FaceDef,
  lx: number,
  y: number,
  lz: number,
  wx: number,
  wz: number,
  tile: number,
  isWater: boolean,
  sample: BlockSampler,
): void {
  const [u0, v0, u1, v1] = tileUVRect(tile);
  const base = out.positions.length / 3;
  const [nx, ny, nz] = face.dir;
  // The air cell the face looks into; AO neighbours live in its plane.
  const ax = wx + nx;
  const ay = y + ny;
  const az = wz + nz;
  // Tangent axes of the face (the two axes where corner coords vary).
  const uAxis = nx !== 0 ? 1 : 0;
  const vAxis = nz !== 0 ? 1 : 2;
  const lowerTop = isWater && sample(wx, y + 1, wz) !== Block.Water;

  const ao: number[] = [];
  for (const corner of face.corners) {
    let px = lx + corner.pos[0];
    let py = y + corner.pos[1];
    let pz = lz + corner.pos[2];
    if (lowerTop && corner.pos[1] === 1) py = y + WATER_SURFACE_Y;

    let aoLevel = 3;
    if (!isWater) {
      const du = [0, 0, 0];
      const dv = [0, 0, 0];
      du[uAxis] = corner.pos[uAxis] === 0 ? -1 : 1;
      dv[vAxis] = corner.pos[vAxis] === 0 ? -1 : 1;
      const side1 = isOpaque(sample(ax + du[0], ay + du[1], az + du[2])) ? 1 : 0;
      const side2 = isOpaque(sample(ax + dv[0], ay + dv[1], az + dv[2])) ? 1 : 0;
      const cornerOcc = isOpaque(
        sample(ax + du[0] + dv[0], ay + du[1] + dv[1], az + du[2] + dv[2]),
      )
        ? 1
        : 0;
      aoLevel = side1 && side2 ? 0 : 3 - (side1 + side2 + cornerOcc);
    }
    ao.push(aoLevel);

    const shade = face.shade * AO_LEVELS[aoLevel];
    out.positions.push(px, py, pz);
    out.normals.push(nx, ny, nz);
    out.colors.push(shade, shade, shade);
    out.uvs.push(u0 + (u1 - u0) * corner.uv[0], v0 + (v1 - v0) * corner.uv[1]);
  }

  // Flip the quad diagonal when needed so AO interpolates without artifacts.
  if (ao[0] + ao[2] >= ao[1] + ao[3]) {
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  } else {
    out.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
  }
}
