// Chunk mesher: culled face meshing with baked ambient occlusion and light.
//
// For every non-air voxel we emit a quad only for faces adjacent to a
// non-opaque block, so interior faces cost nothing. Each vertex carries a
// grayscale colour = directional face shade x ambient occlusion, computed from
// the three blocks diagonally adjacent to the vertex (the classic 0fps AO
// scheme), plus a second attribute holding the sky and block light averaged
// over the same four cells — that average is what makes light fade smoothly
// across a face instead of stepping from block to block.
//
// Terrain is lit entirely by that attribute and not by any scene lamp; see
// applyVoxelLight below for why. Water goes into a separate transparent mesh
// whose surface height comes from its flow level, so a stream steps down as it
// thins out.

import * as THREE from 'three';
import {
  BLOCKS,
  Block,
  MAX_LIGHT,
  isCutout,
  isOpaque,
  isWater,
  waterSurfaceHeight,
} from '../blocks';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants';
import { getAtlasTexture, tileUVRect } from '../textures';
import { Chunk } from './chunk';
import { blockOf, packLight, skyOf } from './lighting';

export type BlockSampler = (wx: number, wy: number, wz: number) => number;
/** Packed sky/block light at a world position; see world/lighting.ts. */
export type LightSampler = (wx: number, wy: number, wz: number) => number;

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
/** How thick a torch post is, in blocks. */
const POST_WIDTH = 2 / 16;
/**
 * How dark a cell with no light at all gets. Not quite zero: a pitch-black
 * cave should be frightening, not unrenderable.
 */
const MIN_BRIGHTNESS = 0.05;

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  uvs: number[] = [];
  /** Per-vertex (sky, block) light, 0..1 each; combined in the shader. */
  lights: number[] = [];
  indices: number[] = [];

  build(): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geo.setAttribute('voxLight', new THREE.Float32BufferAttribute(this.lights, 2));
    geo.setIndex(new THREE.Uint32BufferAttribute(this.indices, 1));
    return geo;
  }
}

/**
 * How much of the sky's strength is currently reaching the ground: 1 at noon,
 * near 0 at midnight. Shared by every chunk material, so the whole world
 * darkens at dusk without a single triangle being rebuilt — and block light,
 * which ignores this entirely, keeps a torch-lit room exactly as bright.
 */
const lightUniforms = { uDaylight: { value: 1 } };

export function setDaylight(value: number): void {
  lightUniforms.uDaylight.value = Math.max(0, Math.min(1, value));
}

export function getDaylight(): number {
  return lightUniforms.uDaylight.value;
}

/**
 * Overall gain on a fully lit block face. Terrain carries its own light rather
 * than taking it from the scene's lamps, so this is what keeps midday looking
 * like midday instead of like a flat texture swatch.
 */
const EXPOSURE = 1.25;

/**
 * Fold per-voxel light into the vertex colour, which already carries the face
 * shade and ambient occlusion. Sky light is scaled by the time of day; block
 * light is not; the brighter of the two wins.
 *
 * This is the whole lighting model for terrain — no scene lamp touches a
 * chunk. It has to be: three.js lights have no idea where the walls are, so a
 * cave lit by the scene's sun is as bright as the field above it, and a torch
 * could never add anything to a surface the sun was already hitting. Baking
 * the light into the mesh is both what makes a cave dark and what makes a
 * torch worth carrying.
 */
function applyVoxelLight(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDaylight = lightUniforms.uDaylight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 voxLight;
         uniform float uDaylight;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
         float voxBrightness = max(voxLight.x * uDaylight, voxLight.y);
         vColor.rgb *= ${EXPOSURE.toFixed(3)} * mix(${MIN_BRIGHTNESS.toFixed(3)}, 1.0, voxBrightness);`,
      );
  };
  material.customProgramCacheKey = () => 'voxel-light';
}

let opaqueMaterial: THREE.MeshBasicMaterial | null = null;
let cutoutMaterial: THREE.MeshBasicMaterial | null = null;
let waterMaterial: THREE.MeshBasicMaterial | null = null;

export function getOpaqueMaterial(): THREE.MeshBasicMaterial {
  if (!opaqueMaterial) {
    opaqueMaterial = new THREE.MeshBasicMaterial({ map: getAtlasTexture(), vertexColors: true });
    applyVoxelLight(opaqueMaterial);
  }
  return opaqueMaterial;
}

/** See-through blocks (glass, crops, torches): alpha-tested, so no sorting. */
export function getCutoutMaterial(): THREE.MeshBasicMaterial {
  if (!cutoutMaterial) {
    cutoutMaterial = new THREE.MeshBasicMaterial({
      map: getAtlasTexture(),
      vertexColors: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    applyVoxelLight(cutoutMaterial);
  }
  return cutoutMaterial;
}

export function getWaterMaterial(): THREE.MeshBasicMaterial {
  if (!waterMaterial) {
    waterMaterial = new THREE.MeshBasicMaterial({
      map: getAtlasTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    applyVoxelLight(waterMaterial);
  }
  return waterMaterial;
}

export interface ChunkGeometry {
  opaque: THREE.BufferGeometry | null;
  cutout: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
}

export function buildChunkGeometry(
  chunk: Chunk,
  sample: BlockSampler,
  sampleLight: LightSampler = fullDaylight,
): ChunkGeometry {
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
        const liquid = isWater(id);
        const cut = isCutout(id);
        const def = BLOCKS[id];
        const target = liquid ? water : cut ? cutout : opaque;

        if (def.shape === 'cross') {
          // Crops: two diagonal sprites, drawn from both sides, never culled.
          emitCross(cutout, lx, y, lz, def.tiles.side, sampleLight(wx, y, wz));
          continue;
        }
        if (def.shape === 'post') {
          // Torches: a thin standing box, lit by the cell it occupies.
          emitPost(cutout, lx, y, lz, def.tiles.side, def.height, sampleLight(wx, y, wz));
          continue;
        }

        const slab = def.shape === 'slab';
        // Water under water fills its cell completely, so a waterfall is a
        // solid column rather than a stack of gaps.
        const surface = !liquid
          ? 1
          : isWater(sample(wx, y + 1, wz))
            ? 1
            : waterSurfaceHeight(id);
        for (const face of FACES) {
          const neighbor = sample(wx + face.dir[0], y + face.dir[1], wz + face.dir[2]);
          if (liquid) {
            if (face.kind === 'top') {
              if (isWater(neighbor)) continue; // more water above: no surface here
            } else if (neighbor === Block.Air) {
              // Exposed to air: this is the edge of the stream.
            } else if (isWater(neighbor) && waterSurfaceHeight(neighbor) < surface - 1e-3) {
              // A shallower neighbour leaves the side of this cell showing.
            } else {
              continue;
            }
          } else if (slab && face.kind === 'top') {
            // A slab's top sits below the cell's ceiling, so a block above it
            // never fully hides it.
          } else if (cut) {
            // Cull against opaque neighbours and against the same block, so a
            // glass wall has no interior faces but still shows through.
            if (coversFace(neighbor) || neighbor === id) continue;
          } else if (coversFace(neighbor)) {
            continue;
          }
          const tile = def.tiles[face.kind];
          const height = liquid ? surface : slab ? def.height : 1;
          emitFace(target, face, lx, y, lz, wx, wz, tile, liquid, sample, sampleLight, height);
        }
      }
    }
  }

  return { opaque: opaque.build(), cutout: cutout.build(), water: water.build() };
}

/** Fallback light for callers that have none: broad daylight everywhere. */
const fullDaylight: LightSampler = () => packLight(MAX_LIGHT, 0);

/**
 * Only a full opaque cube hides a neighbour's face completely. A slab leaves
 * a slit above itself, so faces beside it must still be drawn or the gap
 * would show straight through the world.
 */
function coversFace(id: number): boolean {
  return isOpaque(id) && BLOCKS[id].shape === 'cube';
}

/** Two diagonal quads through the cell; the cutout material draws both sides. */
function emitCross(
  out: MeshBuilder,
  lx: number,
  y: number,
  lz: number,
  tile: number,
  light: number,
): void {
  const [u0, v0, u1, v1] = tileUVRect(tile);
  const quads: [number, number, number, number][] = [
    [0, 0, 1, 1],
    [1, 0, 0, 1],
  ];
  const sky = skyOf(light) / MAX_LIGHT;
  const block = blockOf(light) / MAX_LIGHT;
  for (const [xa, za, xb, zb] of quads) {
    const base = out.positions.length / 3;
    const corners: [number, number, number, number, number][] = [
      [lx + xa, y, lz + za, 0, 0],
      [lx + xb, y, lz + zb, 1, 0],
      [lx + xb, y + 1, lz + zb, 1, 1],
      [lx + xa, y + 1, lz + za, 0, 1],
    ];
    for (const [px, py, pz, u, v] of corners) {
      out.positions.push(px, py, pz);
      out.normals.push(0, 1, 0);
      out.colors.push(0.95, 0.95, 0.95);
      out.lights.push(sky, block);
      out.uvs.push(u0 + (u1 - u0) * u, v0 + (v1 - v0) * v);
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * A thin box standing in the middle of the cell: the torch. The whole tile is
 * mapped onto each side, so the flame at the top of the texture ends up at the
 * top of the post however short it is.
 */
function emitPost(
  out: MeshBuilder,
  lx: number,
  y: number,
  lz: number,
  tile: number,
  height: number,
  light: number,
): void {
  const [u0, v0, u1, v1] = tileUVRect(tile);
  const sky = skyOf(light) / MAX_LIGHT;
  const block = blockOf(light) / MAX_LIGHT;
  // A torch is its own little light source, so nothing shades it: full bright
  // on every face, which is what makes it read as glowing.
  for (const face of FACES) {
    const base = out.positions.length / 3;
    const [nx, ny, nz] = face.dir;
    for (const corner of face.corners) {
      out.positions.push(
        lx + 0.5 + (corner.pos[0] - 0.5) * POST_WIDTH,
        y + corner.pos[1] * height,
        lz + 0.5 + (corner.pos[2] - 0.5) * POST_WIDTH,
      );
      out.normals.push(nx, ny, nz);
      out.colors.push(1, 1, 1);
      out.lights.push(sky, block);
      out.uvs.push(u0 + (u1 - u0) * corner.uv[0], v0 + (v1 - v0) * corner.uv[1]);
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
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
  liquid: boolean,
  sample: BlockSampler,
  sampleLight: LightSampler,
  height = 1,
): void {
  const [u0, v0, u1, v1full] = tileUVRect(tile);
  // Shorter blocks show only the lower part of their side texture.
  const v1 = face.kind === 'side' ? v0 + (v1full - v0) * height : v1full;
  const base = out.positions.length / 3;
  const [nx, ny, nz] = face.dir;
  // The air cell the face looks into; AO and light neighbours live in its plane.
  const ax = wx + nx;
  const ay = y + ny;
  const az = wz + nz;
  // Tangent axes of the face (the two axes where corner coords vary).
  const uAxis = nx !== 0 ? 1 : 0;
  const vAxis = nz !== 0 ? 1 : 2;

  const ao: number[] = [];
  for (const corner of face.corners) {
    const px = lx + corner.pos[0];
    const py = y + corner.pos[1] * height;
    const pz = lz + corner.pos[2];

    const du = [0, 0, 0];
    const dv = [0, 0, 0];
    du[uAxis] = corner.pos[uAxis] === 0 ? -1 : 1;
    dv[vAxis] = corner.pos[vAxis] === 0 ? -1 : 1;

    let aoLevel = 3;
    if (!liquid) {
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

    // Smooth lighting: average the four cells that meet at this corner, on the
    // lit side of the face, ignoring any that are solid enough to hold no light.
    let skySum = 0;
    let blockSum = 0;
    let count = 0;
    for (const [ox, oy, oz] of [
      [0, 0, 0],
      [du[0], du[1], du[2]],
      [dv[0], dv[1], dv[2]],
      [du[0] + dv[0], du[1] + dv[1], du[2] + dv[2]],
    ]) {
      const cx = ax + ox;
      const cy = ay + oy;
      const cz = az + oz;
      if (count > 0 && coversFace(sample(cx, cy, cz))) continue;
      const packed = sampleLight(cx, cy, cz);
      skySum += skyOf(packed);
      blockSum += blockOf(packed);
      count++;
    }

    const shade = face.shade * AO_LEVELS[aoLevel];
    out.positions.push(px, py, pz);
    out.normals.push(nx, ny, nz);
    out.colors.push(shade, shade, shade);
    out.lights.push(skySum / count / MAX_LIGHT, blockSum / count / MAX_LIGHT);
    out.uvs.push(u0 + (u1 - u0) * corner.uv[0], v0 + (v1 - v0) * corner.uv[1]);
  }

  // Flip the quad diagonal when needed so AO interpolates without artifacts.
  if (ao[0] + ao[2] >= ao[1] + ao[3]) {
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  } else {
    out.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
  }
}
