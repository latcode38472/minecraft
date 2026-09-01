// Hostile mob: walks at the player when in range, hits on a cooldown, and
// wanders aimlessly otherwise. Deliberately simple — the AI hook is
// `update`, so smarter behaviour (pathfinding, fleeing, group aggro) can be
// swapped in without touching the rest of the game.

import { ZOMBIE_DETECT_RANGE } from '../constants';
import type { BodyShape } from '../physics';
import { Mob, type EntityContext } from './entity';
import { ZOMBIE_PARTS, cachedGeometry } from './models';

const SPEED = 2.4; // slower than the player's 4.3, so running away works
const ATTACK_RANGE = 1.7;
const ATTACK_DAMAGE = 3;
const ATTACK_COOLDOWN_S = 1.1;
const MAX_HEALTH = 20;

export class Zombie extends Mob {
  readonly shape: BodyShape = { halfWidth: 0.3, height: 1.95 };
  private wanderYaw = Math.random() * Math.PI * 2;
  private wanderTimer = 0;

  constructor() {
    super(cachedGeometry('zombie', ZOMBIE_PARTS), MAX_HEALTH);
  }

  protected loot(): { id: string; count: number }[] {
    return [
      { id: 'rotten_flesh', count: Math.random() < 0.6 ? 1 : 0 },
      // String from zombies keeps bows reachable without a spider mob.
      { id: 'string', count: Math.random() < 0.5 ? 1 : 0 },
    ];
  }

  update(ctx: EntityContext): void {
    // Pick the closest player in range; in multiplayer that may be a remote one.
    let target = null as (typeof ctx.players)[number] | null;
    let bestSq = ZOMBIE_DETECT_RANGE * ZOMBIE_DETECT_RANGE;
    for (const candidate of ctx.players) {
      const ddx = candidate.position.x - this.position.x;
      const ddz = candidate.position.z - this.position.z;
      const ddy = candidate.position.y - this.position.y;
      const sq = ddx * ddx + ddz * ddz;
      if (sq < bestSq && Math.abs(ddy) < 8) {
        bestSq = sq;
        target = candidate;
      }
    }

    if (target) {
      const dx = target.position.x - this.position.x;
      const dz = target.position.z - this.position.z;
      const dy = target.position.y - this.position.y;
      this.walkToward(ctx, dx, dz, SPEED);
      const dist = Math.sqrt(bestSq);
      if (dist < ATTACK_RANGE && Math.abs(dy) < 2 && this.attackCooldown === 0) {
        ctx.damagePlayer(target.id, ATTACK_DAMAGE, this.position.x, this.position.z);
        this.attackCooldown = ATTACK_COOLDOWN_S;
      }
    } else {
      this.wanderTimer -= ctx.dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 3 + Math.random() * 4;
        this.wanderYaw = Math.random() * Math.PI * 2;
      }
      // Shamble in the current wander direction at half speed.
      this.walkToward(ctx, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), SPEED * 0.35);
    }

    this.applyGravity(ctx);
    this.syncObject(ctx);
  }
}
