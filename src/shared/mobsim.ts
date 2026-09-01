// Headless mob and item-drop simulation, shared by client and server.
//
// This is the authority in multiplayer: the server runs it, and clients render
// the snapshots it produces. Singleplayer runs the identical code locally, so
// there is exactly one implementation of how a zombie behaves.
//
// No THREE, no DOM — just numbers and a BlockQuery.

import { Block } from '../blocks.ts';
import {
  GRAVITY,
  NIGHT_END,
  NIGHT_START,
  TERMINAL_VELOCITY,
  ZOMBIE_DETECT_RANGE,
} from '../constants.ts';
import { moveWithCollision, type BlockQuery, type BodyShape, type Vec3 } from './voxel.ts';

export type MobKind = 'zombie' | 'pig';

export interface MobStats {
  maxHealth: number;
  shape: BodyShape;
  speed: number;
  /** Zombies only. */
  attackDamage: number;
  attackRange: number;
  attackCooldown: number;
}

export const MOB_STATS: Record<MobKind, MobStats> = {
  zombie: {
    maxHealth: 20,
    shape: { halfWidth: 0.3, height: 1.95 },
    // Slower than the player's 4.3, so running away always works.
    speed: 2.4,
    attackDamage: 3,
    attackRange: 1.7,
    attackCooldown: 1.1,
  },
  pig: {
    maxHealth: 10,
    shape: { halfWidth: 0.45, height: 0.9 },
    speed: 0.9,
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
  },
};

const PIG_FLEE_SPEED = 2.8;
const PIG_FLEE_DURATION_S = 4;
/** How long a landed hit keeps the mob's arms mid-swing on every client. */
const SWING_TIME_S = 0.35;
const HURT_FLASH_S = 0.4;
const JUMP_SPEED = 7.2;

/** A player as the simulation sees them: an id, a position, and a body. */
export interface SimPlayer {
  id: string;
  position: Vec3;
  dead: boolean;
}

/** What the simulation reports back to whoever is driving it. */
export interface SimEvents {
  /** A mob landed a hit on a player. */
  onPlayerHit(playerId: string, damage: number, fromX: number, fromZ: number): void;
  /** A mob died; `killerId` is whoever last damaged it, if anyone. */
  onMobDied(mob: MobSim, killerId: string | null): void;
}

let nextMobId = 1;

export class MobSim {
  readonly id: number;
  readonly kind: MobKind;
  readonly stats: MobStats;
  readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  readonly velocity: Vec3 = { x: 0, y: 0, z: 0 };
  health: number;
  yaw = 0;
  onGround = false;
  dead = false;
  /** Seconds of hurt flash left; doubles as a damage cooldown. */
  hurtTime = 0;
  /** Who last damaged this mob — decides who receives the loot. */
  lastAttackerId: string | null = null;
  /** Seconds left of the swing animation clients should be drawing. */
  swingTime = 0;

  private attackCooldown = 0;
  private wanderYaw = Math.random() * Math.PI * 2;
  private wanderTimer = 0;
  private moving = false;
  private fleeTime = 0;
  private fleeFrom: [number, number] = [0, 0];

  constructor(kind: MobKind, x: number, y: number, z: number, id?: number) {
    this.id = id ?? nextMobId++;
    this.kind = kind;
    this.stats = MOB_STATS[kind];
    this.health = this.stats.maxHealth;
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.yaw = Math.random() * Math.PI * 2;
  }

  get shape(): BodyShape {
    return this.stats.shape;
  }

  takeDamage(amount: number, fromX: number, fromZ: number, attackerId: string | null): void {
    if (this.hurtTime > 0 || this.dead) return;
    this.health -= amount;
    this.hurtTime = HURT_FLASH_S;
    this.lastAttackerId = attackerId;

    const dx = this.position.x - fromX;
    const dz = this.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.velocity.x = (dx / len) * 6;
    this.velocity.z = (dz / len) * 6;
    this.velocity.y = Math.max(this.velocity.y, 3.2);

    if (this.kind === 'pig') {
      this.fleeTime = PIG_FLEE_DURATION_S;
      this.fleeFrom = [fromX, fromZ];
    }
    if (this.health <= 0) this.dead = true;
  }

  update(dt: number, world: BlockQuery, players: SimPlayer[], events: SimEvents): void {
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.swingTime = Math.max(0, this.swingTime - dt);

    if (this.kind === 'zombie') this.updateZombie(dt, world, players, events);
    else this.updatePig(dt, world);

    this.applyGravity(dt, world);
  }

  private updateZombie(
    dt: number,
    world: BlockQuery,
    players: SimPlayer[],
    events: SimEvents,
  ): void {
    // Chase the closest living player in range — in multiplayer that may be
    // any of them, which is what makes a zombie a shared threat.
    let target: SimPlayer | null = null;
    let bestSq = ZOMBIE_DETECT_RANGE * ZOMBIE_DETECT_RANGE;
    for (const candidate of players) {
      if (candidate.dead) continue;
      const dx = candidate.position.x - this.position.x;
      const dz = candidate.position.z - this.position.z;
      const dy = candidate.position.y - this.position.y;
      const sq = dx * dx + dz * dz;
      if (sq < bestSq && Math.abs(dy) < 8) {
        bestSq = sq;
        target = candidate;
      }
    }

    if (target) {
      const dx = target.position.x - this.position.x;
      const dz = target.position.z - this.position.z;
      const dy = target.position.y - this.position.y;
      this.walkToward(world, dx, dz, this.stats.speed);
      if (
        Math.sqrt(bestSq) < this.stats.attackRange &&
        Math.abs(dy) < 2 &&
        this.attackCooldown === 0
      ) {
        events.onPlayerHit(target.id, this.stats.attackDamage, this.position.x, this.position.z);
        this.attackCooldown = this.stats.attackCooldown;
        this.swingTime = SWING_TIME_S;
      }
      return;
    }

    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 3 + Math.random() * 4;
      this.wanderYaw = Math.random() * Math.PI * 2;
    }
    // Shamble aimlessly when nobody is close.
    this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.stats.speed * 0.35);
  }

  private updatePig(dt: number, world: BlockQuery): void {
    if (this.fleeTime > 0) {
      this.fleeTime -= dt;
      this.walkToward(
        world,
        this.position.x - this.fleeFrom[0],
        this.position.z - this.fleeFrom[1],
        PIG_FLEE_SPEED,
      );
      return;
    }

    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      // Alternate between strolling and standing still.
      this.moving = !this.moving;
      this.wanderTimer = this.moving ? 2 + Math.random() * 3 : 2 + Math.random() * 5;
      if (this.moving) this.wanderYaw = Math.random() * Math.PI * 2;
    }
    if (this.moving) {
      this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.stats.speed);
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
  }

  /**
   * Walk toward a horizontal direction, hopping one-block ledges the way
   * Minecraft mobs do. No pathfinding — enough to follow over uneven ground.
   */
  private walkToward(world: BlockQuery, dirX: number, dirZ: number, speed: number): void {
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
      const ax = Math.floor(this.position.x + nx * (this.shape.halfWidth + 0.35));
      const az = Math.floor(this.position.z + nz * (this.shape.halfWidth + 0.35));
      const footY = Math.floor(this.position.y + 0.1);
      if (world.isSolidAt(ax, footY, az) && !world.isSolidAt(ax, footY + 1, az)) {
        this.velocity.y = JUMP_SPEED;
      }
    }
  }

  private applyGravity(dt: number, world: BlockQuery): void {
    const inWater =
      world.getBlock(
        Math.floor(this.position.x),
        Math.floor(this.position.y + 0.3),
        Math.floor(this.position.z),
      ) === Block.Water;
    if (inWater) {
      // Gentle buoyancy keeps mobs bobbing rather than sinking forever.
      this.velocity.y = Math.min(this.velocity.y + GRAVITY * 0.25 * dt, 2);
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    } else {
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -TERMINAL_VELOCITY);
    }
    this.onGround = moveWithCollision(world, this.position, this.velocity, this.shape, dt);
  }

  /** Loot table, rolled once on death — same numbers everywhere. */
  loot(): { id: string; count: number }[] {
    const out: { id: string; count: number }[] = [];
    if (this.kind === 'pig') {
      out.push({ id: 'raw_porkchop', count: 1 + Math.floor(Math.random() * 2) });
      out.push({ id: 'leather', count: Math.random() < 0.7 ? 1 : 2 });
    } else {
      if (Math.random() < 0.6) out.push({ id: 'rotten_flesh', count: 1 });
      // String from zombies keeps bows reachable without a spider mob.
      if (Math.random() < 0.5) out.push({ id: 'string', count: 1 });
    }
    return out.filter((e) => e.count > 0);
  }
}

// --- Item drops ---------------------------------------------------------

let nextDropId = 1;

const DROP_SHAPE: BodyShape = { halfWidth: 0.15, height: 0.3 };

/**
 * A dropped item lying in the world. In multiplayer these are server-owned, so
 * two players can never both pick up the same stack.
 */
export class DropSim {
  readonly id: number;
  readonly itemId: string;
  count: number;
  readonly position: Vec3;
  readonly velocity: Vec3 = { x: 0, y: 0, z: 0 };
  age = 0;
  dead = false;
  /** Who threw it; they cannot re-collect it until the delay passes. */
  readonly ownerId: string | null;

  constructor(
    itemId: string,
    count: number,
    x: number,
    y: number,
    z: number,
    ownerId: string | null = null,
    id?: number,
  ) {
    this.id = id ?? nextDropId++;
    this.itemId = itemId;
    this.count = count;
    this.position = { x, y, z };
    this.ownerId = ownerId;
    // A little scatter so a pile of drops doesn't stack into one pixel.
    this.velocity.x = (Math.random() - 0.5) * 1.5;
    this.velocity.y = 2.2;
    this.velocity.z = (Math.random() - 0.5) * 1.5;
  }

  update(dt: number, world: BlockQuery): void {
    this.age += dt;
    this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -TERMINAL_VELOCITY);
    const onGround = moveWithCollision(world, this.position, this.velocity, DROP_SHAPE, dt);
    if (onGround) {
      this.velocity.x *= 0.7;
      this.velocity.z *= 0.7;
    }
  }
}

export function isNightTime(timeOfDay: number): boolean {
  return timeOfDay >= NIGHT_START || timeOfDay < NIGHT_END;
}
