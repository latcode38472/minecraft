// Voxel raycast using the Amanatides & Woo DDA: step from voxel to voxel along
// the ray, always crossing the nearest axis boundary, so every voxel on the
// ray is visited exactly once. Returns the first breakable-solid hit plus the
// face normal (the axis we last stepped across).

import * as THREE from 'three';
import { Block, isSolid } from './blocks';
import type { World } from './world/world';

export interface RayHit {
  x: number;
  y: number;
  z: number;
  id: number;
  normal: [number, number, number];
}

export function raycastVoxel(
  world: World,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
): RayHit | null {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;

  const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

  const distToBoundary = (p: number, ip: number, step: number): number =>
    step > 0 ? ip + 1 - p : p - ip;

  let tMaxX = tDeltaX === Infinity ? Infinity : distToBoundary(origin.x, x, stepX) * tDeltaX;
  let tMaxY = tDeltaY === Infinity ? Infinity : distToBoundary(origin.y, y, stepY) * tDeltaY;
  let tMaxZ = tDeltaZ === Infinity ? Infinity : distToBoundary(origin.z, z, stepZ) * tDeltaZ;

  for (let i = 0; i < 256; i++) {
    let normal: [number, number, number];
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      if (tMaxX > maxDist) return null;
      x += stepX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > maxDist) return null;
      y += stepY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      if (tMaxZ > maxDist) return null;
      z += stepZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }

    const id = world.getBlock(x, y, z);
    // Water is not targetable — rays pass through it like Minecraft's default.
    if (id !== Block.Air && id !== Block.Water && isSolid(id)) {
      return { x, y, z, id, normal };
    }
  }
  return null;
}
