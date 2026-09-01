// Passive mob: mills about, and panics briefly after being hit.

import type { BodyShape } from '../physics';
import { Mob, type EntityContext } from './entity';
import { PIG_PARTS, cachedGeometry } from './models';

const WANDER_SPEED = 0.9;
const FLEE_SPEED = 2.8;
const FLEE_DURATION_S = 4;
const MAX_HEALTH = 10;

export class Pig extends Mob {
  readonly shape: BodyShape = { halfWidth: 0.45, height: 0.9 };
  private wanderYaw = Math.random() * Math.PI * 2;
  private wanderTimer = 0;
  private moving = false;
  private fleeTime = 0;
  private fleeFrom: [number, number] = [0, 0];

  constructor() {
    super(cachedGeometry('pig', PIG_PARTS), MAX_HEALTH);
  }

  protected loot(): { id: string; count: number }[] {
    return [
      { id: 'raw_porkchop', count: 1 + Math.floor(Math.random() * 2) },
      { id: 'leather', count: Math.random() < 0.7 ? 1 : 2 },
    ];
  }

  takeDamage(amount: number, fromX: number, fromZ: number): void {
    super.takeDamage(amount, fromX, fromZ);
    this.fleeTime = FLEE_DURATION_S;
    this.fleeFrom = [fromX, fromZ];
  }

  update(ctx: EntityContext): void {
    if (this.fleeTime > 0) {
      this.fleeTime -= ctx.dt;
      this.walkToward(
        ctx,
        this.position.x - this.fleeFrom[0],
        this.position.z - this.fleeFrom[1],
        FLEE_SPEED,
      );
    } else {
      this.wanderTimer -= ctx.dt;
      if (this.wanderTimer <= 0) {
        // Alternate between strolling and standing still.
        this.moving = !this.moving;
        this.wanderTimer = this.moving ? 2 + Math.random() * 3 : 2 + Math.random() * 5;
        if (this.moving) this.wanderYaw = Math.random() * Math.PI * 2;
      }
      if (this.moving) {
        this.walkToward(ctx, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), WANDER_SPEED);
      } else {
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }

    this.applyGravity(ctx);
    this.syncObject(ctx);
  }
}
