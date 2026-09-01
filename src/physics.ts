// Shared AABB-vs-voxel collision, used by the player and every mob.
//
// The body is moved one axis at a time; after each axis move, any solid voxel
// overlapping the box pushes the body back to that voxel's face and zeroes the
// corresponding velocity component. Motion is split into substeps small enough
// that no step exceeds MAX_MOVE_PER_SUBSTEP, which rules out tunnelling at any
// frame rate.

import type * as THREE from 'three';
import { MAX_MOVE_PER_SUBSTEP } from './constants';
import type { World } from './world/world';

const EPSILON = 0.001;

export interface BodyShape {
  halfWidth: number;
  height: number;
}

/** Moves `position` by `velocity * dt` with collision. Returns true if grounded. */
export function moveWithCollision(
  world: World,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  shape: BodyShape,
  dt: number,
): boolean {
  const maxDelta = Math.max(
    Math.abs(velocity.x),
    Math.abs(velocity.y),
    Math.abs(velocity.z),
  ) * dt;
  const steps = Math.max(1, Math.ceil(maxDelta / MAX_MOVE_PER_SUBSTEP));
  const stepDt = dt / steps;
  let onGround = false;

  for (let s = 0; s < steps; s++) {
    moveAxis(world, position, velocity, shape, 0, velocity.x * stepDt);
    moveAxis(world, position, velocity, shape, 2, velocity.z * stepDt);
    // Capture dy first: a collision zeroes velocity.y before we can read it.
    const dy = velocity.y * stepDt;
    if (moveAxis(world, position, velocity, shape, 1, dy) && dy < 0) onGround = true;
  }
  return onGround;
}

/** Returns true if the move was blocked on this axis. */
function moveAxis(
  world: World,
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  shape: BodyShape,
  axis: 0 | 1 | 2,
  delta: number,
): boolean {
  if (delta === 0) return false;
  if (axis === 0) pos.x += delta;
  else if (axis === 1) pos.y += delta;
  else pos.z += delta;

  const minX = pos.x - shape.halfWidth;
  const maxX = pos.x + shape.halfWidth;
  const minY = pos.y;
  const maxY = pos.y + shape.height;
  const minZ = pos.z - shape.halfWidth;
  const maxZ = pos.z + shape.halfWidth;

  for (let by = Math.floor(minY); by <= Math.floor(maxY - EPSILON); by++) {
    for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ - EPSILON); bz++) {
      for (let bx = Math.floor(minX); bx <= Math.floor(maxX - EPSILON); bx++) {
        if (!world.isSolidAt(bx, by, bz)) continue;
        if (axis === 0) {
          pos.x = delta > 0 ? bx - shape.halfWidth - EPSILON : bx + 1 + shape.halfWidth + EPSILON;
          vel.x = 0;
        } else if (axis === 2) {
          pos.z = delta > 0 ? bz - shape.halfWidth - EPSILON : bz + 1 + shape.halfWidth + EPSILON;
          vel.z = 0;
        } else {
          pos.y = delta > 0 ? by - shape.height - EPSILON : by + 1 + EPSILON;
          vel.y = 0;
        }
        return true;
      }
    }
  }
  return false;
}

/** Does an axis-aligned body at `pos` overlap the voxel at (bx, by, bz)? */
export function bodyOverlapsBlock(
  pos: THREE.Vector3,
  shape: BodyShape,
  bx: number,
  by: number,
  bz: number,
): boolean {
  return (
    bx + 1 > pos.x - shape.halfWidth &&
    bx < pos.x + shape.halfWidth &&
    by + 1 > pos.y &&
    by < pos.y + shape.height &&
    bz + 1 > pos.z - shape.halfWidth &&
    bz < pos.z + shape.halfWidth
  );
}
