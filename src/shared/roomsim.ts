// Room simulation: mobs, item drops, and the day/night clock.
//
// This class is the single implementation of world-entity behaviour. The
// multiplayer server runs it authoritatively and broadcasts snapshots; the
// browser runs the very same class locally for singleplayer. Clients never
// simulate mobs in multiplayer, so everyone sees the same creatures in the
// same places and nothing depends on a host's browser tab staying awake.
//
// It needs only a SimWorld (block lookups plus a surface probe), which both
// the server's chunk cache and the client's streaming World satisfy.

import {
  DAY_LENGTH_SECONDS,
  MAX_MOBS,
  MOB_DESPAWN_DISTANCE,
  MOB_SPAWN_INTERVAL_S,
  MOB_SPAWN_MAX_DISTANCE,
  MOB_SPAWN_MIN_DISTANCE,
  START_TIME_OF_DAY,
} from '../constants.ts';
import { Block } from '../blocks.ts';
import { DropSim, MobSim, isNightTime, type SimPlayer } from './mobsim.ts';
import type { BlockQuery, Vec3 } from './voxel.ts';

/** What a simulation needs from a world: block lookups plus a spawn probe. */
export interface SimWorld extends BlockQuery {
  /** Standing height at this column, or null if it is water/blocked/unloaded. */
  surfaceAt(x: number, z: number): number | null;
  /** Free chunks nobody is near. A no-op where the client already streams. */
  evict?(playerPositions: Vec3[]): void;
  /** Mirror an accepted block edit. The client's World applies edits itself. */
  applyEdit?(x: number, y: number, z: number, id: number): void;
}

const MAX_HOSTILE = 12;
const MAX_PASSIVE = 10;
const MAX_DROPS = 120;
/** Drops vanish after this long, like Minecraft's 5-minute despawn. */
const DROP_DESPAWN_S = 300;
/** Nobody can pick a fresh drop up for this long (vanilla's 10-tick delay). */
const DROP_PICKUP_DELAY_S = 0.5;
/**
 * A thrown item stays out of its thrower's reach for this long, so Q actually
 * hands the item over instead of it snapping straight back — vanilla's 2s.
 */
const THROWER_PICKUP_DELAY_S = 2;
const DROP_PICKUP_RADIUS = 1.6;

export interface SimulationHooks {
  /** A mob hit a player; the room applies it to that player's health. */
  damagePlayer(playerId: string, amount: number, fromX: number, fromZ: number): void;
  /** A player walked over a drop; return how many items did NOT fit. */
  giveItems(playerId: string, itemId: string, count: number): number;
}

export class RoomSimulation {
  readonly world: SimWorld;
  readonly mobs = new Map<number, MobSim>();
  readonly drops = new Map<number, DropSim>();
  timeOfDay = START_TIME_OF_DAY;
  /** Ids removed since the last drain, so clients can delete them. */
  readonly removedMobs: number[] = [];
  readonly removedDrops: number[] = [];
  /**
   * Where mobs died since the last drain. Removal alone doesn't say why — a
   * mob can also despawn — so deaths are reported separately for the sound.
   */
  readonly mobDeaths: { x: number; y: number; z: number }[] = [];

  private spawnTimer = 0;

  private readonly hooks: SimulationHooks;

  constructor(world: SimWorld, hooks: SimulationHooks) {
    this.world = world;
    this.hooks = hooks;
  }

  /** Advance the whole room by `dt` seconds. */
  update(dt: number, players: SimPlayer[]): void {
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH_SECONDS) % 1;

    const events = {
      onPlayerHit: (id: string, damage: number, fromX: number, fromZ: number) =>
        this.hooks.damagePlayer(id, damage, fromX, fromZ),
      onMobDied: () => {},
    };

    for (const mob of this.mobs.values()) {
      mob.update(dt, this.world, players, events);
    }

    this.reapMobs(players);
    this.updateDrops(dt, players);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = MOB_SPAWN_INTERVAL_S;
      this.trySpawn(players);
    }

    this.world.evict?.(players.map((p) => p.position));
  }

  private reapMobs(players: SimPlayer[]): void {
    for (const [id, mob] of [...this.mobs]) {
      if (mob.dead) {
        // Loot goes to whoever landed the killing blow; if they cannot carry
        // it (or nobody is credited) it falls on the ground where it died.
        const loot = mob.loot();
        for (const entry of loot) {
          let remaining = entry.count;
          if (mob.lastAttackerId) {
            remaining = this.hooks.giveItems(mob.lastAttackerId, entry.id, entry.count);
          }
          if (remaining > 0) {
            this.spawnDrop(entry.id, remaining, mob.position.x, mob.position.y + 0.4, mob.position.z);
          }
        }
        this.mobs.delete(id);
        this.removedMobs.push(id);
        this.mobDeaths.push({
          x: round(mob.position.x),
          y: round(mob.position.y),
          z: round(mob.position.z),
        });
        continue;
      }
      // Despawn mobs nobody is near, so a room does not accumulate them.
      if (players.length === 0) continue;
      const nearest = Math.min(
        ...players.map((p) => distanceSq(p.position, mob.position)),
      );
      if (nearest > MOB_DESPAWN_DISTANCE * MOB_DESPAWN_DISTANCE) {
        this.mobs.delete(id);
        this.removedMobs.push(id);
      }
    }
  }

  private updateDrops(dt: number, players: SimPlayer[]): void {
    for (const [id, drop] of [...this.drops]) {
      drop.update(dt, this.world);

      if (drop.age > DROP_DESPAWN_S) {
        this.drops.delete(id);
        this.removedDrops.push(id);
        continue;
      }

      if (drop.age < DROP_PICKUP_DELAY_S) continue;

      // Server-side pickup: exactly one player can ever claim a stack.
      for (const player of players) {
        if (player.dead) continue;
        if (drop.age < THROWER_PICKUP_DELAY_S && drop.ownerId === player.id) continue;
        const dx = player.position.x - drop.position.x;
        const dy = player.position.y + 0.9 - drop.position.y;
        const dz = player.position.z - drop.position.z;
        if (dx * dx + dy * dy + dz * dz > DROP_PICKUP_RADIUS * DROP_PICKUP_RADIUS) continue;

        const leftover = this.hooks.giveItems(player.id, drop.itemId, drop.count);
        if (leftover === 0) {
          this.drops.delete(id);
          this.removedDrops.push(id);
        } else {
          drop.count = leftover;
        }
        break;
      }
    }
  }

  spawnDrop(itemId: string, count: number, x: number, y: number, z: number, ownerId?: string): DropSim | null {
    if (this.drops.size >= MAX_DROPS) {
      // Make room by retiring the oldest drop.
      const oldest = [...this.drops.values()].sort((a, b) => b.age - a.age)[0];
      if (oldest) {
        this.drops.delete(oldest.id);
        this.removedDrops.push(oldest.id);
      }
    }
    const drop = new DropSim(itemId, count, x, y, z, ownerId ?? null);
    this.drops.set(drop.id, drop);
    return drop;
  }

  /** Apply damage from a player to a mob; returns true if it connected. */
  damageMob(mobId: number, damage: number, attackerId: string, from: Vec3): boolean {
    const mob = this.mobs.get(mobId);
    if (!mob || mob.dead) return false;
    // The client already paced the swing; don't double-gate on hurt time.
    mob.hurtTime = 0;
    mob.takeDamage(damage, from.x, from.z, attackerId);
    return true;
  }

  private trySpawn(players: SimPlayer[]): void {
    if (players.length === 0 || this.mobs.size >= MAX_MOBS) return;
    const hostile = isNightTime(this.timeOfDay);
    let existing = 0;
    for (const mob of this.mobs.values()) {
      if ((mob.kind === 'zombie') === hostile) existing++;
    }
    if (existing >= (hostile ? MAX_HOSTILE : MAX_PASSIVE)) return;

    // Spawn in a ring around a random player, on real ground.
    const anchor = players[Math.floor(Math.random() * players.length)];
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist =
        MOB_SPAWN_MIN_DISTANCE + Math.random() * (MOB_SPAWN_MAX_DISTANCE - MOB_SPAWN_MIN_DISTANCE);
      const x = Math.floor(anchor.position.x + Math.cos(angle) * dist);
      const z = Math.floor(anchor.position.z + Math.sin(angle) * dist);
      const y = this.world.surfaceAt(x, z);
      if (y === null) continue;
      // Never spawn in water or on leaves.
      const ground = this.world.getBlock(x, y - 1, z);
      if (ground === Block.Water || ground === Block.Leaves) continue;

      const mob = new MobSim(hostile ? 'zombie' : 'pig', x + 0.5, y, z + 0.5);
      this.mobs.set(mob.id, mob);
      return;
    }
  }

  /** Compact snapshots for the wire. */
  mobSnapshot(): { i: number; k: number; x: number; y: number; z: number; yaw: number; hp: number }[] {
    const out = [];
    for (const mob of this.mobs.values()) {
      out.push({
        i: mob.id,
        k: mob.kind === 'pig' ? 1 : 0,
        x: round(mob.position.x),
        y: round(mob.position.y),
        z: round(mob.position.z),
        yaw: round(mob.yaw),
        hp: Math.max(0, Math.round(mob.health)),
      });
    }
    return out;
  }

  dropSnapshot(): { i: number; item: string; n: number; x: number; y: number; z: number }[] {
    const out = [];
    for (const drop of this.drops.values()) {
      out.push({
        i: drop.id,
        item: drop.itemId,
        n: drop.count,
        x: round(drop.position.x),
        y: round(drop.position.y),
        z: round(drop.position.z),
      });
    }
    return out;
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
