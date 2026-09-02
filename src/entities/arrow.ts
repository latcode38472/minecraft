// Arrow projectile: ballistic flight, block collision, and a hit test against
// mobs and other players.
//
// Arrows are stepped in small increments and swept against the voxel grid, so
// a fast arrow cannot tunnel through a one-block wall. Hits are only *reported*
// — the simulation that owns the target (the server, or the local one in
// singleplayer) decides what the damage actually does.

import * as THREE from 'three';
import { isSolid } from '../blocks';
import { ARROW_GRAVITY, ARROW_LIFETIME_S, WORLD_HEIGHT } from '../constants';
import type { BodyShape } from '../shared/voxel';
import { Entity, type EntityContext } from './entity';
import { buildBoxGeometry, getMobMaterial } from './models';

const SHAFT = 0.06;
const LENGTH = 0.7;
const MAX_STEP = 0.25; // blocks per sweep step

let arrowGeometry: THREE.BufferGeometry | null = null;

function getArrowGeometry(): THREE.BufferGeometry {
  if (!arrowGeometry) {
    // Modelled along +Z so the mesh can be aimed with lookAt-style rotation.
    arrowGeometry = buildBoxGeometry([
      { pos: [0, 0, 0], size: [SHAFT, SHAFT, LENGTH], color: 0x9a6b3f },
      { pos: [0, 0, LENGTH / 2], size: [SHAFT * 1.6, SHAFT * 1.6, 0.12], color: 0xbebebe },
      { pos: [0, 0, -LENGTH / 2 + 0.06], size: [0.02, 0.14, 0.16], color: 0xeeeeee },
      { pos: [0, 0, -LENGTH / 2 + 0.06], size: [0.14, 0.02, 0.16], color: 0xeeeeee },
    ]);
  }
  return arrowGeometry;
}

/** Something an arrow can hit that isn't a block: a mob or another player. */
export interface ArrowTarget {
  /** Stable id: a network player id, or "mob:<n>" for a simulated mob. */
  id: string;
  position: THREE.Vector3;
  halfWidth: number;
  height: number;
}

export interface ArrowHooks {
  /** Mobs and remote players an arrow may hit. */
  targets(): ArrowTarget[];
  /** Called when an arrow hits one of them. */
  onHitTarget(id: string, damage: number, fromX: number, fromZ: number): void;
}

export class Arrow extends Entity {
  readonly shape: BodyShape = { halfWidth: SHAFT, height: SHAFT };
  readonly object: THREE.Mesh;
  /** Who fired this, so an arrow never hits its owner. */
  readonly ownerId: string;
  readonly damage: number;

  private stuck = false;

  constructor(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    speed: number,
    damage: number,
    ownerId: string,
    private readonly hooks: ArrowHooks | null,
  ) {
    super();
    this.damage = damage;
    this.ownerId = ownerId;
    this.position.copy(origin);
    this.velocity.copy(direction).normalize().multiplyScalar(speed);
    this.object = new THREE.Mesh(getArrowGeometry(), getMobMaterial());
    this.object.position.copy(origin);
  }

  /**
   * Replay `seconds` of flight immediately, so an arrow that spent time on the
   * wire appears where it truly is rather than lagging behind the shooter.
   */
  fastForward(seconds: number, ctx: EntityContext): void {
    const step = 1 / 60;
    let remaining = Math.min(seconds, 2);
    while (remaining > 0 && !this.dead && !this.stuck) {
      const dt = Math.min(step, remaining);
      remaining -= dt;
      this.update({ ...ctx, dt });
    }
  }

  update(ctx: EntityContext): void {
    this.age += ctx.dt;
    if (this.age > ARROW_LIFETIME_S) {
      this.dead = true;
      return;
    }
    if (this.stuck) return; // stuck arrows just sit until they age out

    this.velocity.y -= ARROW_GRAVITY * ctx.dt;

    // Sweep in small steps so nothing is skipped at high speed.
    const distance = this.velocity.length() * ctx.dt;
    const steps = Math.max(1, Math.ceil(distance / MAX_STEP));
    const stepDt = ctx.dt / steps;

    for (let i = 0; i < steps && !this.dead && !this.stuck; i++) {
      this.position.addScaledVector(this.velocity, stepDt);
      if (this.checkEntityHit()) return;
      this.checkBlockHit(ctx);
    }

    this.object.position.copy(this.position);
    // Point the mesh along its current velocity.
    const v = this.velocity;
    this.object.rotation.set(
      Math.atan2(v.y, Math.hypot(v.x, v.z)),
      Math.atan2(v.x, v.z),
      0,
      'YXZ',
    );
  }

  /** Report the first target the arrow entered. True if it was consumed. */
  private checkEntityHit(): boolean {
    for (const target of this.hooks?.targets() ?? []) {
      if (target.id === this.ownerId) continue;
      if (!this.insideBox(target.position, target.halfWidth, target.height)) continue;
      this.hooks?.onHitTarget(target.id, this.damage, this.position.x, this.position.z);
      this.dead = true;
      return true;
    }
    return false;
  }

  private insideBox(centre: THREE.Vector3, halfWidth: number, height: number): boolean {
    const pad = 0.12; // forgiving, since arrows are thin and fast
    return (
      Math.abs(this.position.x - centre.x) < halfWidth + pad &&
      Math.abs(this.position.z - centre.z) < halfWidth + pad &&
      this.position.y > centre.y - pad &&
      this.position.y < centre.y + height + pad
    );
  }

  private checkBlockHit(ctx: EntityContext): void {
    const bx = Math.floor(this.position.x);
    const by = Math.floor(this.position.y);
    const bz = Math.floor(this.position.z);
    if (by < 0 || by >= WORLD_HEIGHT) {
      this.dead = true;
      return;
    }
    if (!isSolid(ctx.world.getBlock(bx, by, bz))) return;
    // Back off out of the block and stop dead.
    this.position.addScaledVector(this.velocity, -0.02);
    this.velocity.set(0, 0, 0);
    this.stuck = true;
    this.object.position.copy(this.position);
  }
}
