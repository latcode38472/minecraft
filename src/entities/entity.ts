// Entity foundation for client-side effects that move through the world.
//
// Since mobs and dropped items became server-authoritative (see
// shared/roomsim.ts), the only thing left here is the base class arrows use:
// gravity, buoyancy and the shared voxel collision, so a projectile falls and
// stops on exactly the same geometry the player walks on.

import * as THREE from 'three';
import { isWater } from '../blocks';
import { GRAVITY, TERMINAL_VELOCITY } from '../constants';
import { moveWithCollision, type BodyShape } from '../shared/voxel';
import type { World } from '../world/world';

/** Everything a client entity needs to know about the world on a given tick. */
export interface EntityContext {
  world: World;
  dt: number;
  /** Local player feet position; entities retire once they get far from it. */
  playerPos: THREE.Vector3;
}

export abstract class Entity {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  abstract readonly shape: BodyShape;
  abstract readonly object: THREE.Object3D;
  onGround = false;
  dead = false;
  age = 0;

  abstract update(ctx: EntityContext): void;

  /** Free per-entity GPU resources; shared geometry/materials stay cached. */
  dispose(): void {}

  protected applyGravity(ctx: EntityContext, buoyant = true): void {
    const inWater =
      buoyant &&
      isWater(
        ctx.world.getBlock(
          Math.floor(this.position.x),
          Math.floor(this.position.y + 0.3),
          Math.floor(this.position.z),
        ),
      );
    if (inWater) {
      // Gentle buoyancy keeps entities bobbing at the surface instead of sinking.
      this.velocity.y = Math.min(this.velocity.y + GRAVITY * 0.25 * ctx.dt, 2);
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    } else {
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * ctx.dt, -TERMINAL_VELOCITY);
    }
    this.onGround = moveWithCollision(ctx.world, this.position, this.velocity, this.shape, ctx.dt);
  }
}
