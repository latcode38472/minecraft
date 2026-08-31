// Player physics: AABB vs voxel grid with axis-separated resolution.
// Movement is integrated in substeps small enough that no axis moves more
// than MAX_MOVE_PER_SUBSTEP per step, which rules out tunnelling.

import * as THREE from 'three';
import { Block } from '../blocks';
import {
  GRAVITY,
  JUMP_SPEED,
  MAX_MOVE_PER_SUBSTEP,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  SNEAK_SPEED,
  SWIM_UP_SPEED,
  TERMINAL_VELOCITY,
  WALK_SPEED,
  WATER_GRAVITY,
  WATER_SPEED_FACTOR,
  WATER_TERMINAL_VELOCITY,
} from '../constants';
import type { World } from '../world/world';

const EPSILON = 0.001;

/** Device-agnostic movement intent; forward/strafe may be analog (joystick). */
export interface MoveInput {
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
}

export class Player {
  /** Feet position (bottom centre of the AABB). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  onGround = false;
  feetInWater = false;
  eyeInWater = false;
  /** Horizontal distance walked while grounded, consumed for footstep sounds. */
  stepAccumulator = 0;

  constructor(private readonly world: World) {}

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + PLAYER_EYE_HEIGHT, this.position.z);
  }

  update(dt: number, move: MoveInput, yaw: number): void {
    this.updateWaterState();

    // Wish direction in the horizontal plane, relative to camera yaw. Analog
    // magnitudes below 1 scale the speed; diagonals get normalised.
    let fwd = move.forward;
    let strafe = move.strafe;
    const len = Math.hypot(fwd, strafe);
    let speed = move.sneak ? SNEAK_SPEED : WALK_SPEED;
    if (this.feetInWater) speed *= WATER_SPEED_FACTOR;
    if (len > 0) {
      if (len > 1) {
        fwd /= len;
        strafe /= len;
      }
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      this.velocity.x = (-sin * fwd + cos * strafe) * speed;
      this.velocity.z = (-cos * fwd - sin * strafe) * speed;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    if (this.feetInWater) {
      if (move.jump) {
        this.velocity.y = SWIM_UP_SPEED;
      } else {
        this.velocity.y -= WATER_GRAVITY * dt;
        if (move.sneak) this.velocity.y -= WATER_GRAVITY * dt;
        this.velocity.y = Math.max(this.velocity.y, -WATER_TERMINAL_VELOCITY);
      }
    } else {
      if (move.jump && this.onGround) this.velocity.y = JUMP_SPEED;
      this.velocity.y -= GRAVITY * dt;
      this.velocity.y = Math.max(this.velocity.y, -TERMINAL_VELOCITY);
    }

    this.integrate(dt);
  }

  private updateWaterState(): void {
    const { x, y, z } = this.position;
    this.feetInWater = this.world.getBlock(Math.floor(x), Math.floor(y + 0.4), Math.floor(z)) === Block.Water;
    this.eyeInWater =
      this.world.getBlock(Math.floor(x), Math.floor(y + PLAYER_EYE_HEIGHT), Math.floor(z)) ===
      Block.Water;
  }

  private integrate(dt: number): void {
    const maxDelta =
      Math.max(Math.abs(this.velocity.x), Math.abs(this.velocity.y), Math.abs(this.velocity.z)) *
      dt;
    const steps = Math.max(1, Math.ceil(maxDelta / MAX_MOVE_PER_SUBSTEP));
    const stepDt = dt / steps;
    const wasGrounded = this.onGround;
    this.onGround = false;

    for (let i = 0; i < steps; i++) {
      this.moveAxis(0, this.velocity.x * stepDt);
      this.moveAxis(2, this.velocity.z * stepDt);
      this.moveAxis(1, this.velocity.y * stepDt);
    }

    if (this.onGround) {
      this.stepAccumulator +=
        Math.hypot(this.velocity.x, this.velocity.z) * dt * (wasGrounded ? 1 : 0.5);
    }
  }

  /** Move along one axis (0=x, 1=y, 2=z) and clamp against any solid voxel overlapped. */
  private moveAxis(axis: 0 | 1 | 2, delta: number): void {
    if (delta === 0) return;
    const pos = this.position;
    if (axis === 0) pos.x += delta;
    else if (axis === 1) pos.y += delta;
    else pos.z += delta;

    const minX = pos.x - PLAYER_HALF_WIDTH;
    const maxX = pos.x + PLAYER_HALF_WIDTH;
    const minY = pos.y;
    const maxY = pos.y + PLAYER_HEIGHT;
    const minZ = pos.z - PLAYER_HALF_WIDTH;
    const maxZ = pos.z + PLAYER_HALF_WIDTH;

    for (let by = Math.floor(minY); by <= Math.floor(maxY - EPSILON); by++) {
      for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ - EPSILON); bz++) {
        for (let bx = Math.floor(minX); bx <= Math.floor(maxX - EPSILON); bx++) {
          if (!this.world.isSolidAt(bx, by, bz)) continue;
          if (axis === 0) {
            pos.x = delta > 0 ? bx - PLAYER_HALF_WIDTH - EPSILON : bx + 1 + PLAYER_HALF_WIDTH + EPSILON;
            this.velocity.x = 0;
          } else if (axis === 2) {
            pos.z = delta > 0 ? bz - PLAYER_HALF_WIDTH - EPSILON : bz + 1 + PLAYER_HALF_WIDTH + EPSILON;
            this.velocity.z = 0;
          } else {
            if (delta > 0) {
              pos.y = by - PLAYER_HEIGHT - EPSILON;
            } else {
              pos.y = by + 1 + EPSILON;
              this.onGround = true;
            }
            this.velocity.y = 0;
          }
          return;
        }
      }
    }
  }

  /** Would a block placed at these voxel coords intersect the player's AABB? */
  intersectsBlock(bx: number, by: number, bz: number): boolean {
    return (
      bx + 1 > this.position.x - PLAYER_HALF_WIDTH &&
      bx < this.position.x + PLAYER_HALF_WIDTH &&
      by + 1 > this.position.y &&
      by < this.position.y + PLAYER_HEIGHT &&
      bz + 1 > this.position.z - PLAYER_HALF_WIDTH &&
      bz < this.position.z + PLAYER_HALF_WIDTH
    );
  }
}
