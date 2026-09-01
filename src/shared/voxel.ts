// Headless voxel physics, shared by the browser client and the Node server.
//
// Nothing here touches THREE or the DOM: positions are plain {x,y,z} objects,
// which THREE.Vector3 structurally satisfies, so the client passes its vectors
// straight in. The server runs the very same code, which is what lets mob
// movement be authoritative without the two sides drifting apart.

import { MAX_MOVE_PER_SUBSTEP } from '../constants.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BodyShape {
  halfWidth: number;
  height: number;
}

/** The only thing physics needs from a world: what is solid where. */
export interface BlockQuery {
  getBlock(x: number, y: number, z: number): number;
  isSolidAt(x: number, y: number, z: number): boolean;
}

const EPSILON = 0.001;

/**
 * Move `position` by `velocity * dt` with collision, one axis at a time.
 * Motion is split into substeps small enough that no step exceeds
 * MAX_MOVE_PER_SUBSTEP, which rules out tunnelling at any frame rate.
 * Returns true when the body ended up standing on something.
 */
export function moveWithCollision(
  world: BlockQuery,
  position: Vec3,
  velocity: Vec3,
  shape: BodyShape,
  dt: number,
): boolean {
  const maxDelta =
    Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z)) * dt;
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
  world: BlockQuery,
  pos: Vec3,
  vel: Vec3,
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
  pos: Vec3,
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

/**
 * Slab-method ray/AABB test. Returns the entry distance, or null on a miss.
 * Used for melee targeting, arrows, and server-side hit validation.
 */
export function rayBoxDistance(
  origin: Vec3,
  dir: Vec3,
  boxMin: Vec3,
  boxMax: Vec3,
  maxDist: number,
): number | null {
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const min = [boxMin.x, boxMin.y, boxMin.z];
  const max = [boxMax.x, boxMax.y, boxMax.z];
  let tMin = 0;
  let tMax = maxDist;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-8) {
      if (o[axis] < min[axis] || o[axis] > max[axis]) return null;
      continue;
    }
    const inv = 1 / d[axis];
    let t1 = (min[axis] - o[axis]) * inv;
    let t2 = (max[axis] - o[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}
