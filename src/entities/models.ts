// Mob models are a handful of coloured boxes merged into ONE geometry per mob
// type, so a mob costs a single draw call instead of one per body part.
// Geometries are built once and shared by every instance of that mob.

import * as THREE from 'three';

export interface BoxPart {
  /** Centre of the box, in blocks, relative to the entity's feet. */
  pos: [number, number, number];
  size: [number, number, number];
  color: number;
}

const FACE_DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Per-face shading matching the terrain mesher, so mobs sit in the same light.
const FACE_SHADE = [0.8, 0.8, 1.0, 0.55, 0.7, 0.7];

/** Merge boxes into one indexed BufferGeometry with baked vertex colours. */
export function buildBoxGeometry(parts: BoxPart[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  for (const part of parts) {
    const [cx, cy, cz] = part.pos;
    const [sx, sy, sz] = part.size;
    color.setHex(part.color);

    FACE_DIRS.forEach((dir, faceIndex) => {
      const base = positions.length / 3;
      // Build a quad perpendicular to `dir` by spanning the other two axes.
      const axis = dir[0] !== 0 ? 0 : dir[1] !== 0 ? 1 : 2;
      const uAxis = axis === 0 ? 1 : 0;
      const vAxis = axis === 2 ? 1 : 2;
      const half = [sx / 2, sy / 2, sz / 2];
      const centre = [cx, cy, cz];

      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = [centre[0], centre[1], centre[2]];
        p[axis] += dir[axis] * half[axis];
        p[uAxis] += su * half[uAxis];
        p[vAxis] += sv * half[vAxis];
        positions.push(p[0], p[1], p[2]);
        normals.push(dir[0], dir[1], dir[2]);
        const shade = FACE_SHADE[faceIndex];
        colors.push(color.r * shade, color.g * shade, color.b * shade);
      }

      // Wind each quad so its front face points along `dir`.
      const flip = dir[axis] > 0 === (axis === 1);
      if (flip) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

let mobMaterial: THREE.MeshLambertMaterial | null = null;
let mobHurtMaterial: THREE.MeshLambertMaterial | null = null;

export function getMobMaterial(): THREE.MeshLambertMaterial {
  if (!mobMaterial) {
    mobMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return mobMaterial;
}

/** Shared red-tinted variant swapped in during a mob's hurt flash. */
export function getMobHurtMaterial(): THREE.MeshLambertMaterial {
  if (!mobHurtMaterial) {
    mobHurtMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissive: 0xaa2222,
      emissiveIntensity: 0.9,
    });
  }
  return mobHurtMaterial;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();

/** Build-once, share-forever geometry for a named model. */
export function cachedGeometry(key: string, build: () => BoxPart[]): THREE.BufferGeometry {
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = buildBoxGeometry(build());
    geometryCache.set(key, geo);
  }
  return geo;
}

// Models face +Z; mobs set rotation.y = atan2(dirX, dirZ) to look along travel.

export const ZOMBIE_PARTS = (): BoxPart[] => {
  const skin = 0x63a05a;
  const shirt = 0x35696b;
  const pants = 0x33396b;
  return [
    { pos: [0, 1.72, 0], size: [0.5, 0.5, 0.5], color: skin }, // head
    { pos: [0, 1.05, 0], size: [0.55, 0.75, 0.3], color: shirt }, // torso
    { pos: [-0.4, 1.15, 0.15], size: [0.25, 0.6, 0.25], color: skin }, // arms, raised
    { pos: [0.4, 1.15, 0.15], size: [0.25, 0.6, 0.25], color: skin },
    { pos: [-0.15, 0.32, 0], size: [0.25, 0.65, 0.25], color: pants }, // legs
    { pos: [0.15, 0.32, 0], size: [0.25, 0.65, 0.25], color: pants },
  ];
};

export const PIG_PARTS = (): BoxPart[] => {
  const body = 0xe89a96;
  const snout = 0xd4746f;
  return [
    { pos: [0, 0.55, -0.05], size: [0.6, 0.55, 0.9], color: body }, // body
    { pos: [0, 0.62, 0.55], size: [0.45, 0.45, 0.35], color: body }, // head
    { pos: [0, 0.56, 0.75], size: [0.22, 0.18, 0.1], color: snout }, // snout
    { pos: [-0.2, 0.14, 0.3], size: [0.16, 0.28, 0.16], color: body }, // legs
    { pos: [0.2, 0.14, 0.3], size: [0.16, 0.28, 0.16], color: body },
    { pos: [-0.2, 0.14, -0.35], size: [0.16, 0.28, 0.16], color: body },
    { pos: [0.2, 0.14, -0.35], size: [0.16, 0.28, 0.16], color: body },
  ];
};
