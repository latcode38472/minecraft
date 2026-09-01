// Entity foundation: everything that moves through the world and isn't the
// player. Mobs share the player's voxel collision (physics.ts) so they walk,
// fall and get stuck on exactly the same geometry.

import * as THREE from 'three';
import { Block } from '../blocks';
import { GRAVITY, KNOCKBACK_LIFT, KNOCKBACK_SPEED, TERMINAL_VELOCITY } from '../constants';
import { moveWithCollision, type BodyShape } from '../physics';
import type { World } from '../world/world';
import { getMobHurtMaterial, getMobMaterial } from './models';

/** Everything a mob needs to know about the world on a given tick. */
export interface EntityContext {
  world: World;
  dt: number;
  /** Player feet position. */
  playerPos: THREE.Vector3;
  isNight: boolean;
  damagePlayer(amount: number, fromX: number, fromZ: number): void;
  spawnDrop(id: string, count: number, x: number, y: number, z: number): void;
  /** Try to put an item in the player's inventory; returns the leftover count. */
  collectItem(id: string, count: number, damage?: number): number;
  onMobDeath(): void;
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
      ctx.world.getBlock(
        Math.floor(this.position.x),
        Math.floor(this.position.y + 0.3),
        Math.floor(this.position.z),
      ) === Block.Water;
    if (inWater) {
      // Gentle buoyancy keeps mobs bobbing at the surface instead of sinking.
      this.velocity.y = Math.min(this.velocity.y + GRAVITY * 0.25 * ctx.dt, 2);
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    } else {
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * ctx.dt, -TERMINAL_VELOCITY);
    }
    this.onGround = moveWithCollision(ctx.world, this.position, this.velocity, this.shape, ctx.dt);
  }
}

export abstract class Mob extends Entity {
  health: number;
  readonly maxHealth: number;
  /** Seconds of red hurt-flash remaining; also acts as damage cooldown. */
  hurtTime = 0;
  attackCooldown = 0;
  /** Facing angle, applied to the model each frame. */
  yaw = 0;
  readonly mesh: THREE.Mesh;

  constructor(geometry: THREE.BufferGeometry, maxHealth: number) {
    super();
    this.maxHealth = maxHealth;
    this.health = maxHealth;
    this.mesh = new THREE.Mesh(geometry, getMobMaterial());
  }

  get object(): THREE.Object3D {
    return this.mesh;
  }

  /** Loot table, rolled once on death. */
  protected abstract loot(): { id: string; count: number }[];

  takeDamage(amount: number, fromX: number, fromZ: number): void {
    if (this.hurtTime > 0 || this.dead) return;
    this.health -= amount;
    this.hurtTime = 0.4;
    const dx = this.position.x - fromX;
    const dz = this.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.velocity.x = (dx / len) * KNOCKBACK_SPEED;
    this.velocity.z = (dz / len) * KNOCKBACK_SPEED;
    this.velocity.y = Math.max(this.velocity.y, KNOCKBACK_LIFT);
    if (this.health <= 0) this.dead = true;
  }

  /** Call at the end of each subclass update to sync the visual state. */
  protected syncObject(ctx: EntityContext): void {
    this.hurtTime = Math.max(0, this.hurtTime - ctx.dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - ctx.dt);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    this.mesh.material = this.hurtTime > 0 ? getMobHurtMaterial() : getMobMaterial();
  }

  /** Spawn this mob's loot where it died. */
  dropLoot(ctx: EntityContext): void {
    for (const entry of this.loot()) {
      if (entry.count > 0) {
        ctx.spawnDrop(entry.id, entry.count, this.position.x, this.position.y + 0.4, this.position.z);
      }
    }
  }

  /**
   * Walk toward a horizontal direction, hopping over one-block obstacles the
   * way Minecraft mobs do (no pathfinding — enough to follow a player over
   * uneven ground).
   */
  protected walkToward(ctx: EntityContext, dirX: number, dirZ: number, speed: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const nx = dirX / len;
    const nz = dirZ / len;
    this.velocity.x = nx * speed;
    this.velocity.z = nz * speed;
    this.yaw = Math.atan2(nx, nz);

    if (this.onGround) {
      // Look one step ahead: solid at foot level but clear above means hop up.
      const ax = Math.floor(this.position.x + nx * (this.shape.halfWidth + 0.35));
      const az = Math.floor(this.position.z + nz * (this.shape.halfWidth + 0.35));
      const footY = Math.floor(this.position.y + 0.1);
      const blockedAtFoot = ctx.world.isSolidAt(ax, footY, az);
      const clearAbove = !ctx.world.isSolidAt(ax, footY + 1, az);
      if (blockedAtFoot && clearAbove) this.velocity.y = 7.2;
    }
  }
}
