// Player movement. Collision resolution lives in physics.ts, shared with mobs;
// this file owns intent (walk/jump/swim), water state and fall tracking.

import * as THREE from 'three';
import { Block } from '../blocks';
import {
  GRAVITY,
  JUMP_SPEED,
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
import { bodyOverlapsBlock, moveWithCollision, type BodyShape } from '../physics';
import type { World } from '../world/world';

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
  readonly shape: BodyShape = { halfWidth: PLAYER_HALF_WIDTH, height: PLAYER_HEIGHT };
  onGround = false;
  feetInWater = false;
  eyeInWater = false;
  /** Last frame's sneak intent, mirrored for multiplayer state packets. */
  sneaking = false;
  /** Horizontal distance walked while grounded, consumed for footstep sounds. */
  stepAccumulator = 0;

  /** Highest point reached since leaving the ground, for fall damage. */
  private apexY = 0;
  private pendingFallDistance = 0;

  constructor(private readonly world: World) {}

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + PLAYER_EYE_HEIGHT, this.position.z);
  }

  /** Distance of the last completed fall, in blocks; clears when read. */
  takeFallDistance(): number {
    const d = this.pendingFallDistance;
    this.pendingFallDistance = 0;
    return d;
  }

  /** Drop all momentum and fall state (respawn, teleport). */
  reset(): void {
    this.velocity.set(0, 0, 0);
    this.apexY = this.position.y;
    this.pendingFallDistance = 0;
  }

  update(dt: number, move: MoveInput, yaw: number): void {
    this.updateWaterState();
    this.sneaking = move.sneak;

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

    const wasGrounded = this.onGround;
    this.onGround = moveWithCollision(this.world, this.position, this.velocity, this.shape, dt);

    // Fall tracking: remember the apex while airborne, bank the drop on landing.
    // Water breaks a fall, exactly as it does in Minecraft.
    if (this.feetInWater) {
      this.apexY = this.position.y;
    } else if (!this.onGround) {
      this.apexY = Math.max(this.apexY, this.position.y);
    } else if (!wasGrounded) {
      this.pendingFallDistance = Math.max(0, this.apexY - this.position.y);
      this.apexY = this.position.y;
    } else {
      this.apexY = this.position.y;
    }

    if (this.onGround) {
      this.stepAccumulator +=
        Math.hypot(this.velocity.x, this.velocity.z) * dt * (wasGrounded ? 1 : 0.5);
    }
  }

  private updateWaterState(): void {
    const { x, y, z } = this.position;
    this.feetInWater =
      this.world.getBlock(Math.floor(x), Math.floor(y + 0.4), Math.floor(z)) === Block.Water;
    this.eyeInWater =
      this.world.getBlock(Math.floor(x), Math.floor(y + PLAYER_EYE_HEIGHT), Math.floor(z)) ===
      Block.Water;
  }

  /** Would a block placed at these voxel coords intersect the player's AABB? */
  intersectsBlock(bx: number, by: number, bz: number): boolean {
    return bodyOverlapsBlock(this.position, this.shape, bx, by, bz);
  }
}
