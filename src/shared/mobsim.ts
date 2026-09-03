// Headless mob and item-drop simulation, shared by client and server.
//
// This is the authority in multiplayer: the server runs it, and clients render
// the snapshots it produces. Singleplayer runs the identical code locally, so
// there is exactly one implementation of how a zombie behaves.
//
// Numbers and behaviour flags come from the mob registry (mobs.ts); loot comes
// from the loot tables (loot.ts). No THREE, no DOM — just numbers and a
// BlockQuery.

import { isWater } from '../blocks.ts';
import {
  FIST_KNOCKBACK,
  GRAVITY,
  KNOCKBACK_TIME_S,
  NIGHT_END,
  NIGHT_START,
  TERMINAL_VELOCITY,
  WOOL_REGROW_S,
  ZOMBIE_DETECT_RANGE,
} from '../constants.ts';
import { clampKnockback, knockbackDecay, knockbackLift } from './combat.ts';
import {
  MOB_FLAG_COLOR_SHIFT,
  MOB_FLAG_GRAZING,
  MOB_FLAG_HURT,
  MOB_FLAG_SHEARED,
} from '../net/protocol.ts';
import { MOB_DEFS, pickSheepColor, type MobDef, type MobKind } from './mobs.ts';
import { SHEAR_LOOT, SHEEP_WOOL_LOOT, rollLoot, type LootRoll } from './loot.ts';
import type { SavedMob } from './save.ts';
import { moveWithCollision, type BlockQuery, type BodyShape, type Vec3 } from './voxel.ts';

export type { MobKind } from './mobs.ts';

/** How long a hit keeps an animal running. */
const FLEE_DURATION_S = 4;
/** How long a landed hit keeps the mob's arms mid-swing on every client. */
const SWING_TIME_S = 0.35;
const HURT_FLASH_S = 0.4;
const JUMP_SPEED = 7.2;
/** A grazing animal keeps its head down this long. */
const GRAZE_MIN_S = 2.5;
const GRAZE_MAX_S = 5;
/** Chance per idle stretch that a grazer eats rather than just standing. */
const GRAZE_CHANCE = 0.45;
/** How far a villager strays from home before turning back. */
const VILLAGER_ROAM = 12;
/** A villager runs from a zombie inside this range. */
const VILLAGER_FEAR_RANGE = 8;
/** A villager turns to look at a player standing this close. */
const VILLAGER_GREET_RANGE = 5;
/** Head turn limit while looking around, radians. */
const LOOK_MAX = 0.9;

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
  /** A mob landed a hit on a player. `knockback` is how hard it shoves them. */
  onPlayerHit(
    playerId: string,
    damage: number,
    fromX: number,
    fromZ: number,
    knockback: number,
  ): void;
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
  readonly def: MobDef;
  readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  readonly velocity: Vec3 = { x: 0, y: 0, z: 0 };
  health: number;
  yaw = 0;
  /** Head yaw relative to the body: animals look around while idle. */
  headYaw = 0;
  onGround = false;
  dead = false;
  /** Seconds of hurt flash left; doubles as a damage cooldown. */
  hurtTime = 0;
  /**
   * Seconds of shove left. While this is running the mob cannot steer, which
   * is the whole point of knockback: it interrupts. Without it the AI would
   * overwrite the shove on the very next frame and nothing would move.
   */
  knockbackTime = 0;
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
  /** Seconds left with the head down in the grass; 0 when not grazing. */
  grazeTime = 0;
  /** Sheep: fleece off, and how long until it grows back. */
  sheared = false;
  woolTimer = 0;
  /** Sheep: index into SHEEP_COLORS. */
  color = 0;
  /** Villagers: the spot they wander around. */
  home: Vec3 | null = null;

  private attackCooldown = 0;
  private reloadTime = 0;
  private strafeDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  private strafeTimer = 0;
  private wanderYaw = Math.random() * Math.PI * 2;
  private wanderTimer = 0;
  private moving = false;
  private fleeTime = 0;
  private fleeFrom: [number, number] = [0, 0];
  private lookTimer = 1 + Math.random() * 3;
  private lookTarget = 0;

  constructor(kind: MobKind, x: number, y: number, z: number, id?: number) {
    this.id = id ?? nextMobId++;
    this.kind = kind;
    this.def = MOB_DEFS[kind];
    this.health = this.def.maxHealth;
    this.position.x = x;
    this.position.y = y;
    this.position.z = z;
    this.yaw = Math.random() * Math.PI * 2;
    if (kind === 'sheep') this.color = pickSheepColor(Math.random);
  }

  get shape(): BodyShape {
    return this.def.shape;
  }

  takeDamage(
    amount: number,
    fromX: number,
    fromZ: number,
    attackerId: string | null,
    knockback = FIST_KNOCKBACK,
  ): void {
    if (this.hurtTime > 0 || this.dead) return;
    this.health -= amount;
    this.hurtTime = HURT_FLASH_S;
    this.lastAttackerId = attackerId;
    this.grazeTime = 0;
    this.shove(fromX, fromZ, knockback);

    if (!this.def.hostile) {
      this.fleeTime = FLEE_DURATION_S;
      this.fleeFrom = [fromX, fromZ];
    }
    if (this.health <= 0) this.dead = true;
  }

  /**
   * Push away from a point. The velocity decays rather than being cancelled,
   * so the mob slides a short way and recovers — see KNOCKBACK_DRAG for the
   * distance that works out to.
   */
  shove(fromX: number, fromZ: number, strength: number): void {
    const force = clampKnockback(strength);
    if (force === 0) return;
    const dx = this.position.x - fromX;
    const dz = this.position.z - fromZ;
    // Straight down on top of it: pick a direction rather than divide by zero.
    const len = Math.hypot(dx, dz);
    const nx = len > 1e-4 ? dx / len : Math.sin(this.yaw);
    const nz = len > 1e-4 ? dz / len : Math.cos(this.yaw);
    this.velocity.x = nx * force;
    this.velocity.z = nz * force;
    if (this.onGround) this.velocity.y = Math.max(this.velocity.y, knockbackLift(force));
    this.knockbackTime = KNOCKBACK_TIME_S;
  }

  update(dt: number, world: BlockQuery, players: SimPlayer[], events: SimEvents): void {
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.swingTime = Math.max(0, this.swingTime - dt);
    if (this.knockbackTime > 0) {
      this.knockbackTime = Math.max(0, this.knockbackTime - dt);
      const decay = knockbackDecay(dt);
      this.velocity.x *= decay;
      this.velocity.z *= decay;
    }

    if (this.sheared) {
      this.woolTimer = Math.max(0, this.woolTimer - dt);
      if (this.woolTimer === 0) this.sheared = false;
    }

    switch (this.kind) {
      case 'zombie':
        this.updateZombie(dt, world, players, events);
        break;
      case 'skeleton':
        this.updateSkeleton(dt, world, players, events);
        break;
      case 'villager':
        this.updateVillager(dt, world, players);
        break;
      default:
        this.updateAnimal(dt, world);
    }

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
      this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.def.speed * 0.3);
      return;
    }

    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const distance = Math.hypot(dx, dz) || 1;

    // Always face the target, whether closing, backing off or strafing.
    this.yaw = Math.atan2(dx / distance, dz / distance);

    const clearShot = this.canSee(world, target);

    if (distance < SKELETON_PREFERRED_MIN) {
      this.walkToward(world, -dx, -dz, this.def.speed); // too close: back off
    } else if (distance > SKELETON_PREFERRED_MAX || !clearShot) {
      this.walkToward(world, dx, dz, this.def.speed); // close in, or find an angle
      this.yaw = Math.atan2(dx / distance, dz / distance);
    } else if (this.drawTime === 0) {
      // In the pocket and not yet committed: circle, so it is a moving target.
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 1.2 + Math.random() * 1.6;
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.walkToward(world, -dz * this.strafeDir, dx * this.strafeDir, this.def.speed * 0.7);
      this.yaw = Math.atan2(dx / distance, dz / distance);
    } else {
      // Committed to the shot: plant the feet so the arrow goes where it aimed.
      this.halt();
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
    const target = this.nearestPlayer(players, ZOMBIE_DETECT_RANGE);

    if (target) {
      const dx = target.position.x - this.position.x;
      const dz = target.position.z - this.position.z;
      const dy = target.position.y - this.position.y;
      this.walkToward(world, dx, dz, this.def.speed);
      if (
        Math.hypot(dx, dz) < this.def.attackRange &&
        Math.abs(dy) < 2 &&
        this.attackCooldown === 0
      ) {
        events.onPlayerHit(
          target.id,
          this.def.attackDamage,
          this.position.x,
          this.position.z,
          this.def.knockback,
        );
        this.attackCooldown = this.def.attackCooldown;
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
    this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.def.speed * 0.35);
  }

  /**
   * Pigs, cows and sheep: stroll, stand, look around, and (for grazers) put
   * the head down to eat. A hit sends them running for a few seconds.
   */
  private updateAnimal(dt: number, world: BlockQuery): void {
    if (this.fleeTime > 0) {
      this.fleeTime -= dt;
      this.grazeTime = 0;
      this.headYaw = 0;
      this.walkToward(
        world,
        this.position.x - this.fleeFrom[0],
        this.position.z - this.fleeFrom[1],
        this.def.fleeSpeed,
      );
      return;
    }

    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      // Alternate between strolling and standing still.
      this.moving = !this.moving;
      this.wanderTimer = this.moving ? 2 + Math.random() * 3 : 2 + Math.random() * 5;
      if (this.moving) {
        this.wanderYaw = Math.random() * Math.PI * 2;
        this.grazeTime = 0;
      } else if (this.def.grazes && Math.random() < GRAZE_CHANCE && this.onGround) {
        this.grazeTime = GRAZE_MIN_S + Math.random() * (GRAZE_MAX_S - GRAZE_MIN_S);
        this.wanderTimer = Math.max(this.wanderTimer, this.grazeTime + 0.5);
      }
    }

    if (this.moving) {
      this.headYaw *= Math.max(0, 1 - dt * 6);
      this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.def.speed);
      return;
    }

    this.halt();
    if (this.grazeTime > 0) {
      this.grazeTime = Math.max(0, this.grazeTime - dt);
      this.headYaw *= Math.max(0, 1 - dt * 6);
      return;
    }
    this.lookAround(dt);
  }

  /**
   * Villagers keep to their village: they wander near home, turn to greet a
   * player who walks up, and run from any zombie that gets close.
   */
  private updateVillager(dt: number, world: BlockQuery, players: SimPlayer[]): void {
    if (this.fleeTime > 0) {
      this.fleeTime -= dt;
      this.headYaw = 0;
      this.walkToward(
        world,
        this.position.x - this.fleeFrom[0],
        this.position.z - this.fleeFrom[1],
        this.def.fleeSpeed,
      );
      return;
    }

    const home = this.home ?? this.position;
    const homeDx = home.x - this.position.x;
    const homeDz = home.z - this.position.z;
    const farFromHome = Math.hypot(homeDx, homeDz) > VILLAGER_ROAM;

    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0 || (farFromHome && this.moving && this.wanderTimer < 1)) {
      this.moving = !this.moving;
      this.wanderTimer = this.moving ? 2 + Math.random() * 4 : 1.5 + Math.random() * 4;
      if (this.moving) {
        // Strayed too far: head back rather than drifting off across the map.
        this.wanderYaw = farFromHome
          ? Math.atan2(homeDx, homeDz) + (Math.random() - 0.5) * 0.6
          : Math.random() * Math.PI * 2;
      }
    }

    if (this.moving) {
      this.headYaw *= Math.max(0, 1 - dt * 6);
      this.walkToward(world, Math.sin(this.wanderYaw), Math.cos(this.wanderYaw), this.def.speed);
      return;
    }

    this.halt();
    const visitor = this.nearestPlayer(players, VILLAGER_GREET_RANGE);
    if (visitor) {
      // Face the visitor with the whole body; the head follows the body.
      const dx = visitor.position.x - this.position.x;
      const dz = visitor.position.z - this.position.z;
      this.yaw = Math.atan2(dx, dz);
      this.headYaw *= Math.max(0, 1 - dt * 6);
      return;
    }
    this.lookAround(dt);
  }

  /** Idle head movement: pick a new direction every few seconds and ease to it. */
  private lookAround(dt: number): void {
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 1.5 + Math.random() * 3.5;
      this.lookTarget = Math.random() < 0.3 ? 0 : (Math.random() * 2 - 1) * LOOK_MAX;
    }
    this.headYaw += (this.lookTarget - this.headYaw) * Math.min(1, dt * 4);
  }

  /** Something hostile is near a villager: run from it. Called by the room. */
  scare(fromX: number, fromZ: number): void {
    if (this.kind !== 'villager') return;
    this.fleeTime = Math.max(this.fleeTime, 2.5);
    this.fleeFrom = [fromX, fromZ];
  }

  /** Is this villager within fear range of the given hostile position? */
  fears(x: number, z: number): boolean {
    if (this.kind !== 'villager') return false;
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    return dx * dx + dz * dz < VILLAGER_FEAR_RANGE * VILLAGER_FEAR_RANGE;
  }

  /**
   * Walk toward a horizontal direction, hopping one-block ledges the way
   * Minecraft mobs do. No pathfinding — enough to follow over uneven ground.
   */
  private walkToward(world: BlockQuery, dirX: number, dirZ: number, speed: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) {
      this.halt();
      return;
    }
    const nx = dirX / len;
    const nz = dirZ / len;
    this.yaw = Math.atan2(nx, nz);
    // Mid-shove the mob still turns to face where it wants to go, but its feet
    // are not its own: the knockback carries it until it wears off.
    if (this.knockbackTime > 0) return;
    this.velocity.x = nx * speed;
    this.velocity.z = nz * speed;

    if (this.onGround) {
      const ax = Math.floor(this.position.x + nx * (this.shape.halfWidth + 0.35));
      const az = Math.floor(this.position.z + nz * (this.shape.halfWidth + 0.35));
      const footY = Math.floor(this.position.y + 0.1);
      if (world.isSolidAt(ax, footY, az) && !world.isSolidAt(ax, footY + 1, az)) {
        this.velocity.y = JUMP_SPEED;
      }
    }
  }

  /** Stand still — unless a shove is carrying the mob, which outranks it. */
  private halt(): void {
    if (this.knockbackTime > 0) return;
    this.velocity.x = 0;
    this.velocity.z = 0;
  }

  private applyGravity(dt: number, world: BlockQuery): void {
    const inWater = isWater(
      world.getBlock(
        Math.floor(this.position.x),
        Math.floor(this.position.y + 0.3),
        Math.floor(this.position.z),
      ),
    );
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

  /** Behaviour flags for the wire (MOB_FLAG_*). */
  flags(): number {
    let f = 0;
    if (this.grazeTime > 0) f |= MOB_FLAG_GRAZING;
    if (this.sheared) f |= MOB_FLAG_SHEARED;
    if (this.hurtTime > 0) f |= MOB_FLAG_HURT;
    if (this.kind === 'sheep') f |= (this.color & 0x7) << MOB_FLAG_COLOR_SHIFT;
    return f;
  }

  /**
   * Shear a sheep: wool comes off and grows back later. Returns the wool, or
   * null when there was nothing to shear (not a sheep, or already bare).
   */
  shear(): LootRoll[] | null {
    if (this.kind !== 'sheep' || this.sheared || this.dead) return null;
    this.sheared = true;
    this.woolTimer = WOOL_REGROW_S;
    this.grazeTime = 0;
    return rollLoot(SHEAR_LOOT);
  }

  /** Loot table, rolled once on death — same numbers everywhere. */
  loot(): LootRoll[] {
    const out = rollLoot(this.def.loot);
    if (this.kind === 'sheep' && !this.sheared) out.push(...rollLoot(SHEEP_WOOL_LOOT));
    return out;
  }

  toSave(): SavedMob {
    const saved: SavedMob = {
      kind: this.kind,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      hp: this.health,
    };
    if (this.kind === 'sheep') {
      saved.color = this.color;
      if (this.sheared) {
        saved.sheared = true;
        saved.woolTimer = this.woolTimer;
      }
    }
    if (this.home) saved.home = { ...this.home };
    return saved;
  }

  static fromSave(saved: SavedMob): MobSim {
    const mob = new MobSim(saved.kind, saved.x, saved.y, saved.z);
    mob.yaw = saved.yaw;
    mob.health = Math.min(mob.def.maxHealth, saved.hp);
    if (saved.color !== undefined) mob.color = saved.color;
    if (saved.sheared) {
      mob.sheared = true;
      mob.woolTimer = saved.woolTimer ?? WOOL_REGROW_S;
    }
    if (saved.home) mob.home = { ...saved.home };
    return mob;
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
  /** Wear carried by a dropped tool, so throwing one does not repair it. */
  damage?: number;
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
