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

export type MobKind = 'zombie' | 'pig' | 'skeleton';

export interface MobStats {
  maxHealth: number;
  shape: BodyShape;
  speed: number;
  /** Melee attackers only. */
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
  skeleton: {
    maxHealth: 16,
    shape: { halfWidth: 0.3, height: 1.95 },
    speed: 2.6,
    // Damage comes from the arrow, not from touching you.
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

// --- Skeleton -------------------------------------------------------------
/** How far a skeleton will notice and start shooting at a player. */
const SKELETON_RANGE = 18;
/** It backs away inside this, closes outside it, and strafes in between. */
const SKELETON_PREFERRED_MIN = 5;
const SKELETON_PREFERRED_MAX = 11;
/** Seconds spent visibly drawing the bow before the arrow leaves it. */
export const SKELETON_DRAW_S = 1.1;
/** Rest between shots, so a skeleton is dangerous but not a machine gun. */
const SKELETON_RELOAD_S = 1.0;
const SKELETON_ARROW_SPEED = 26;
const SKELETON_ARROW_DAMAGE = 3;
/** Random aim error, in radians-ish slope. Enough to make dodging matter. */
const SKELETON_SPREAD = 0.09;
/** Height above the feet the arrow leaves from — roughly the bow hand. */
const SKELETON_SHOOT_HEIGHT = 1.45;
/** Arrows fall more slowly than bodies, so a shot carries. */
export const ARROW_GRAVITY_SCALE = 0.55;

/**
 * Launch slope (rise over run) to hit a target `distance` away and `height`
 * above, given a launch speed. Returns null when the shot cannot reach.
 *
 * Standard projectile solution: tanθ = (v² ± √(v⁴ − g(g·d² + 2h·v²))) / (g·d).
 * The minus branch is the flat, fast arc — the one an archer actually takes,
 * and the one that gives a player the least time to step aside.
 */
export function solveArrowArc(distance: number, height: number, speed: number): number | null {
  const g = GRAVITY * ARROW_GRAVITY_SCALE;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * distance * distance + 2 * height * v2);
  if (disc < 0) return null;
  return (v2 - Math.sqrt(disc)) / (g * distance);
}

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
  /** A skeleton loosed an arrow. The room turns this into a real projectile. */
  onMobShoot(
    from: Vec3,
    dir: Vec3,
    speed: number,
    damage: number,
    shooterId: number,
  ): void;
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
  /**
   * How long a skeleton has been drawing its bow, 0 when not drawing. Sent to
   * clients so the draw is animated everywhere, and so a player can see a shot
   * coming rather than being hit out of nowhere.
   */
  drawTime = 0;

  private attackCooldown = 0;
  private reloadTime = 0;
  private strafeDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  private strafeTimer = 0;
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
    else if (this.kind === 'skeleton') this.updateSkeleton(dt, world, players, events);
    else this.updatePig(dt, world);

    this.applyGravity(dt, world);
  }

  /**
   * Ranged hunter. It keeps its distance rather than closing, strafes so it is
   * not a stationary target, and spends a visible second drawing before every
   * shot — that draw is the tell that lets a player dodge or break line of
   * sight, so it is deliberately slow and deliberately visible.
   */
  private updateSkeleton(
    dt: number,
    world: BlockQuery,
    players: SimPlayer[],
    events: SimEvents,
  ): void {
    const target = this.nearestPlayer(players, SKELETON_RANGE);

    if (!target) {
      // Lost the target mid-draw: relax the bow rather than firing blind.
      this.drawTime = 0;
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 3 + Math.random() * 4;
        this.wanderYaw = Math.random() * Math.PI * 2;
      }
      this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.stats.speed * 0.3);
      return;
    }

    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const distance = Math.hypot(dx, dz) || 1;

    // Always face the target, whether closing, backing off or strafing.
    this.yaw = Math.atan2(dx / distance, dz / distance);

    const clearShot = this.canSee(world, target);

    if (distance < SKELETON_PREFERRED_MIN) {
      this.walkToward(world, -dx, -dz, this.stats.speed); // too close: back off
    } else if (distance > SKELETON_PREFERRED_MAX || !clearShot) {
      this.walkToward(world, dx, dz, this.stats.speed); // close in, or find an angle
      this.yaw = Math.atan2(dx / distance, dz / distance);
    } else if (this.drawTime === 0) {
      // In the pocket and not yet committed: circle, so it is a moving target.
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 1.2 + Math.random() * 1.6;
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.walkToward(world, -dz * this.strafeDir, dx * this.strafeDir, this.stats.speed * 0.7);
      this.yaw = Math.atan2(dx / distance, dz / distance);
    } else {
      // Committed to the shot: plant the feet so the arrow goes where it aimed.
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    if (this.reloadTime > 0) {
      this.reloadTime = Math.max(0, this.reloadTime - dt);
      return;
    }
    if (!clearShot) {
      this.drawTime = 0;
      return;
    }

    this.drawTime += dt;
    if (this.drawTime < SKELETON_DRAW_S) return;

    // Loose, aiming at the chest with a real ballistic solution rather than a
    // fudge factor — otherwise the arc is only right at one distance and the
    // skeleton misses high up close and low far away.
    const originY = this.position.y + SKELETON_SHOOT_HEIGHT;
    const aim = solveArrowArc(distance, target.position.y + 1.1 - originY, SKELETON_ARROW_SPEED);
    if (aim === null) {
      // Out of the bow's reach at this speed; hold the draw and wait to close.
      this.drawTime = SKELETON_DRAW_S;
      return;
    }
    // Horizontal components share the flat direction; vertical is the solution.
    // A little spread on top: a perfect solver hits a standing player every
    // single time, which reads as a sniper rather than a skeleton. This keeps
    // it threatening while leaving room to dodge, strafe and take cover.
    const spreadX = (Math.random() - 0.5) * SKELETON_SPREAD;
    const spreadY = (Math.random() - 0.5) * SKELETON_SPREAD;
    const nx = dx / distance;
    const nz = dz / distance;
    const len = Math.hypot(1, aim);
    events.onMobShoot(
      { x: this.position.x, y: originY, z: this.position.z },
      {
        // Rotate the flat direction slightly about the vertical axis.
        x: (nx + -nz * spreadX) / len,
        y: aim / len + spreadY,
        z: (nz + nx * spreadX) / len,
      },
      SKELETON_ARROW_SPEED,
      SKELETON_ARROW_DAMAGE,
      this.id,
    );
    this.drawTime = 0;
    this.reloadTime = SKELETON_RELOAD_S;
    this.swingTime = SWING_TIME_S;
  }

  /** Nearest living player within `range`, or null. */
  private nearestPlayer(players: SimPlayer[], range: number): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bestSq = range * range;
    for (const candidate of players) {
      if (candidate.dead) continue;
      const dx = candidate.position.x - this.position.x;
      const dz = candidate.position.z - this.position.z;
      const dy = candidate.position.y - this.position.y;
      const sq = dx * dx + dz * dz;
      if (sq < bestSq && Math.abs(dy) < 8) {
        bestSq = sq;
        best = candidate;
      }
    }
    return best;
  }

  /**
   * Is there open air between this mob's bow and the target's chest? Stepped
   * coarsely — this gates a shot, so being slightly generous costs a wasted
   * arrow, while being slow costs every skeleton every tick.
   */
  private canSee(world: BlockQuery, target: SimPlayer): boolean {
    const ox = this.position.x;
    const oy = this.position.y + SKELETON_SHOOT_HEIGHT;
    const oz = this.position.z;
    const dx = target.position.x - ox;
    const dy = target.position.y + 1.1 - oy;
    const dz = target.position.z - oz;
    const distance = Math.hypot(dx, dy, dz);
    const steps = Math.min(24, Math.ceil(distance * 2));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (
        world.isSolidAt(
          Math.floor(ox + dx * f),
          Math.floor(oy + dy * f),
          Math.floor(oz + dz * f),
        )
      ) {
        return false;
      }
    }
    return true;
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
    } else if (this.kind === 'skeleton') {
      // Killing an archer arms you as one: this is the main arrow supply.
      out.push({ id: 'bone', count: 1 + Math.floor(Math.random() * 2) });
      if (Math.random() < 0.75) out.push({ id: 'arrow', count: 1 + Math.floor(Math.random() * 2) });
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

// --- Mob arrows -----------------------------------------------------------

let nextArrowId = 1;

/** Beyond this an arrow is retired even if it never hit anything. */
const ARROW_MAX_AGE_S = 8;
/** Steps are capped to this many blocks so a fast arrow cannot tunnel walls. */
const ARROW_MAX_STEP = 0.3;
/** Forgiving hit radius around a player's body — arrows are thin and fast. */
const ARROW_HIT_PAD = 0.35;

/**
 * An arrow fired by a mob, simulated where the mob is simulated.
 *
 * Player arrows stay client-side (they are latency-compensated on the shooter's
 * machine and only *report* hits). A mob's arrow has no client to own it, so it
 * lives here: the same authority that decides the skeleton exists decides
 * whether its arrow hit you.
 */
export class ArrowSim {
  readonly id: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly damage: number;
  /** Mob that fired it, so an arrow never hits its own shooter. */
  readonly shooterId: number;
  age = 0;
  dead = false;
  /** Set once it sticks in a block; it then just ages out where it landed. */
  stuck = false;

  constructor(from: Vec3, dir: Vec3, speed: number, damage: number, shooterId: number, id?: number) {
    this.id = id ?? nextArrowId++;
    this.position = { x: from.x, y: from.y, z: from.z };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.velocity = {
      x: (dir.x / len) * speed,
      y: (dir.y / len) * speed,
      z: (dir.z / len) * speed,
    };
    this.damage = damage;
    this.shooterId = shooterId;
  }

  /** Direction of travel, for pointing the model. */
  get yaw(): number {
    return Math.atan2(this.velocity.x, this.velocity.z);
  }

  get pitch(): number {
    return Math.atan2(this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z));
  }

  /**
   * Fly one step. Returns the player it hit, if any — the caller applies the
   * damage, because only it knows how players take damage.
   */
  update(dt: number, world: BlockQuery, players: SimPlayer[]): SimPlayer | null {
    this.age += dt;
    if (this.age > ARROW_MAX_AGE_S) {
      this.dead = true;
      return null;
    }
    if (this.stuck) return null;

    this.velocity.y = Math.max(this.velocity.y - GRAVITY * ARROW_GRAVITY_SCALE * dt, -TERMINAL_VELOCITY);

    // Sweep in short steps so nothing is skipped between frames.
    const distance = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z) * dt;
    const steps = Math.max(1, Math.ceil(distance / ARROW_MAX_STEP));
    const stepDt = dt / steps;

    for (let i = 0; i < steps; i++) {
      this.position.x += this.velocity.x * stepDt;
      this.position.y += this.velocity.y * stepDt;
      this.position.z += this.velocity.z * stepDt;

      for (const player of players) {
        if (player.dead) continue;
        if (
          Math.abs(this.position.x - player.position.x) < PLAYER_HIT_HALF_WIDTH + ARROW_HIT_PAD &&
          Math.abs(this.position.z - player.position.z) < PLAYER_HIT_HALF_WIDTH + ARROW_HIT_PAD &&
          this.position.y > player.position.y - ARROW_HIT_PAD &&
          this.position.y < player.position.y + PLAYER_HIT_HEIGHT + ARROW_HIT_PAD
        ) {
          this.dead = true;
          return player;
        }
      }

      const bx = Math.floor(this.position.x);
      const by = Math.floor(this.position.y);
      const bz = Math.floor(this.position.z);
      if (by < 0 || by > 512) {
        this.dead = true;
        return null;
      }
      if (world.isSolidAt(bx, by, bz)) {
        // Back out of the block so it visibly stands in the surface.
        this.position.x -= this.velocity.x * stepDt * 0.5;
        this.position.y -= this.velocity.y * stepDt * 0.5;
        this.position.z -= this.velocity.z * stepDt * 0.5;
        this.velocity.x = 0;
        this.velocity.y = 0;
        this.velocity.z = 0;
        this.stuck = true;
        // A spent arrow lingers briefly rather than for its whole lifetime.
        this.age = Math.max(this.age, ARROW_MAX_AGE_S - 2);
        return null;
      }
    }
    return null;
  }
}

/** Player hitbox as the arrow sees it; matches the constants the client uses. */
const PLAYER_HIT_HALF_WIDTH = 0.3;
const PLAYER_HIT_HEIGHT = 1.8;

export function isNightTime(timeOfDay: number): boolean {
  return timeOfDay >= NIGHT_START || timeOfDay < NIGHT_END;
}
