// Room simulation: mobs, item drops, block entities, crops, beds and the
// day/night clock.
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
  CROP_GROWTH_MEAN_S,
  DAY_LENGTH_SECONDS,
  FIST_KNOCKBACK,
  MAX_MOBS,
  MOB_DESPAWN_DISTANCE,
  MOB_SPAWN_INTERVAL_S,
  MOB_SPAWN_MAX_DISTANCE,
  MOB_SPAWN_MIN_DISTANCE,
  SLEEP_DURATION_S,
  SLEEP_END,
  SLEEP_START,
  SLEEP_WAKE_TIME,
  SMELT_TIME_S,
  START_TIME_OF_DAY,
} from '../constants.ts';
import { Block, BLOCKS, isCrop, isFurnace } from '../blocks.ts';
import { getItem } from '../items/items.ts';
import { FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, cloneSlots, slotCount } from '../items/containers.ts';
import type { ItemStack } from '../items/inventory.ts';
import { fuelSeconds, smeltResult } from '../items/smelting.ts';
import type {
  ArrowStateData,
  ContainerKind,
  DropStateData,
  MobStateData,
  SleepStateData,
} from '../net/protocol.ts';
import { arrowKnockback } from './combat.ts';
import { blockDrops } from './harvest.ts';
import { VILLAGE_CHEST_LOOT, positionSeed, rollLoot, seededRandom, type LootRoll } from './loot.ts';
import { MOB_DEFS, pickSpawnKind, type MobKind } from './mobs.ts';
import { ArrowSim, DropSim, MobSim, SKELETON_DRAW_S, isNightTime, type SimPlayer } from './mobsim.ts';
import type { SavedContainer, SavedSimState } from './save.ts';
import type { BlockQuery, Vec3 } from './voxel.ts';

/** A village as the simulation needs to know it: where, and how big. */
export interface VillageInfo {
  id: string;
  x: number;
  z: number;
  radius: number;
}

/** What a simulation needs from a world: block lookups plus a spawn probe. */
export interface SimWorld extends BlockQuery {
  /** World seed, so village chests roll the same loot for everyone. */
  readonly seed: number;
  /** Standing height at this column, or null if it is water/blocked/unloaded. */
  surfaceAt(x: number, z: number): number | null;
  /** Free chunks nobody is near. A no-op where the client already streams. */
  evict?(playerPositions: Vec3[]): void;
  /** Mirror an accepted block edit. */
  applyEdit?(x: number, y: number, z: number, id: number): void;
  /** True when this position has never been edited: it is generated terrain. */
  isNaturalBlock?(x: number, y: number, z: number): boolean;
  /** Crop positions in chunks generated (or edits loaded) since the last call. */
  drainNewCrops?(): Vec3[];
  /** Villages whose centre lies within `radius` of the point. */
  villagesNear?(x: number, z: number, radius: number): VillageInfo[];
}

const MAX_HOSTILE = 12;
/** Mob arrows in flight at once, so a pack of skeletons cannot flood the wire. */
const MAX_ARROWS = 40;
const MAX_PASSIVE = 12;
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
/** Mobs farther than this from every player stand still: nobody can see them. */
const MOB_SIM_RANGE = 64;
/** Crops only grow while someone is around to farm them. */
const CROP_TICK_RANGE = 48;
/** Villages within this far of a player get their villagers topped up. */
const VILLAGE_ACTIVE_RANGE = 64;
const VILLAGERS_PER_VILLAGE = 4;
/** Herd members spawn within this many blocks of the first one. */
const HERD_SPREAD = 3;

export type WakeReason = 'morning' | 'bed_gone' | 'dead';

export interface SimulationHooks {
  /**
   * A mob hit a player; the room applies it to that player's health and
   * shoves them away from (fromX, fromZ) with the given knockback strength.
   */
  damagePlayer(
    playerId: string,
    amount: number,
    fromX: number,
    fromZ: number,
    knockback: number,
  ): void;
  /** A player walked over a drop; return how many items did NOT fit. */
  giveItems(playerId: string, itemId: string, count: number, damage?: number): number;
  /** The simulation changed a block by itself: a crop grew, a furnace lit. */
  onBlockChanged?(x: number, y: number, z: number, id: number): void;
  /** A sleeping player was got out of bed by the simulation. */
  onWake?(playerId: string, reason: WakeReason): void;
}

/** A chest or furnace with contents; furnaces also carry their heat. */
export interface BlockEntity {
  x: number;
  y: number;
  z: number;
  kind: ContainerKind;
  slots: (ItemStack | null)[];
  /** Furnace: seconds of fuel left, what the current fuel item was worth, smelt progress 0..1. */
  burn: number;
  burnMax: number;
  progress: number;
}

export interface SleepAttempt {
  ok: boolean;
  message?: string;
}

export function blockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** Can anyone get into bed at this time of day? */
export function isSleepTime(timeOfDay: number): boolean {
  return timeOfDay >= SLEEP_START || timeOfDay < SLEEP_END;
}

export class RoomSimulation {
  readonly world: SimWorld;
  readonly mobs = new Map<number, MobSim>();
  readonly drops = new Map<number, DropSim>();
  /** Arrows fired by mobs. Player arrows stay client-side; see ArrowSim. */
  readonly arrows = new Map<number, ArrowSim>();
  /** Chests and furnaces, by block position, created the first time they are opened. */
  readonly containers = new Map<string, BlockEntity>();
  /** Growing crops, by block position. Ripe ones drop out; nothing scans the world. */
  readonly crops = new Map<string, Vec3>();
  /** Who is in which bed. */
  readonly sleepers = new Map<string, Vec3>();
  timeOfDay = START_TIME_OF_DAY;
  /** Ids removed since the last drain, so clients can delete them. */
  readonly removedMobs: number[] = [];
  readonly removedDrops: number[] = [];
  readonly removedArrows: number[] = [];
  /** Container keys whose block is gone; viewers must close their screens. */
  readonly removedContainers: string[] = [];
  /** Containers whose contents or heat changed since the last drain. */
  readonly dirtyContainers = new Set<string>();
  /** Blocks the simulation changed itself since the last drain. */
  readonly blocks: { x: number; y: number; z: number; id: number }[] = [];
  /**
   * Where mobs died since the last drain, and which kind. Removal alone does
   * not say why — a mob can also despawn — so deaths are reported separately
   * for the sound and the topple animation.
   */
  readonly mobDeaths: { i: number; k: number; x: number; y: number; z: number }[] = [];

  private spawnTimer = 0;
  private sleepTimer = 0;

  private readonly hooks: SimulationHooks;

  constructor(world: SimWorld, hooks: SimulationHooks) {
    this.world = world;
    this.hooks = hooks;
  }

  /** Advance the whole room by `dt` seconds. */
  update(dt: number, players: SimPlayer[]): void {
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH_SECONDS) % 1;

    for (const crop of this.world.drainNewCrops?.() ?? []) this.registerCrop(crop.x, crop.y, crop.z);

    const events = {
      onPlayerHit: (id: string, damage: number, fromX: number, fromZ: number, knockback: number) =>
        this.hooks.damagePlayer(id, damage, fromX, fromZ, knockback),
      onMobDied: () => {},
      onMobShoot: (from: Vec3, dir: Vec3, speed: number, damage: number, shooterId: number) => {
        if (this.arrows.size >= MAX_ARROWS) return;
        const arrow = new ArrowSim(from, dir, speed, damage, shooterId);
        this.arrows.set(arrow.id, arrow);
      },
    };

    const rangeSq = MOB_SIM_RANGE * MOB_SIM_RANGE;
    for (const mob of this.mobs.values()) {
      // A mob nobody is near stands still: it cannot be seen, and simulating
      // it would drag chunks into memory for no one.
      if (nearestDistanceSq(mob.position, players) > rangeSq) continue;
      mob.update(dt, this.world, players, events);
    }
    this.scareVillagers();

    this.reapMobs(players);
    this.updateArrows(dt, players);
    this.updateDrops(dt, players);
    this.updateFurnaces(dt);
    this.updateCrops(dt, players);
    this.updateSleep(dt, players);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = MOB_SPAWN_INTERVAL_S;
      this.trySpawn(players);
    }

    this.world.evict?.(players.map((p) => p.position));
  }

  /** Villagers run from any zombie that gets close. */
  private scareVillagers(): void {
    let zombies: MobSim[] | null = null;
    for (const mob of this.mobs.values()) {
      if (mob.kind !== 'villager') continue;
      zombies ??= [...this.mobs.values()].filter((m) => m.kind === 'zombie' && !m.dead);
      for (const zombie of zombies) {
        if (mob.fears(zombie.position.x, zombie.position.z)) {
          mob.scare(zombie.position.x, zombie.position.z);
          break;
        }
      }
    }
  }

  /** Fly every mob arrow, and apply what it hits. */
  private updateArrows(dt: number, players: SimPlayer[]): void {
    for (const [id, arrow] of [...this.arrows]) {
      const hit = arrow.update(dt, this.world, players);
      if (hit) {
        this.hooks.damagePlayer(
          hit.id,
          arrow.damage,
          arrow.position.x,
          arrow.position.z,
          arrowKnockback(),
        );
      }
      if (arrow.dead) {
        this.arrows.delete(id);
        this.removedArrows.push(id);
      }
    }
  }

  private reapMobs(players: SimPlayer[]): void {
    for (const [id, mob] of [...this.mobs]) {
      if (mob.dead) {
        // Loot goes to whoever landed the killing blow; if they cannot carry
        // it (or nobody is credited) it falls on the ground where it died.
        this.grantLoot(mob.loot(), mob.lastAttackerId, mob.position.x, mob.position.y + 0.4, mob.position.z);
        this.mobs.delete(id);
        this.removedMobs.push(id);
        this.mobDeaths.push({
          i: mob.id,
          k: mob.def.wire,
          x: round(mob.position.x),
          y: round(mob.position.y),
          z: round(mob.position.z),
        });
        continue;
      }
      // Despawn mobs nobody is near, so a room does not accumulate them.
      // Villagers stay with their village.
      if (players.length === 0 || mob.def.persistent) continue;
      if (nearestDistanceSq(mob.position, players) > MOB_DESPAWN_DISTANCE * MOB_DESPAWN_DISTANCE) {
        this.mobs.delete(id);
        this.removedMobs.push(id);
      }
    }
  }

  /** Hand loot to a player, dropping whatever they cannot carry where it came from. */
  private grantLoot(loot: LootRoll[], playerId: string | null, x: number, y: number, z: number): void {
    for (const entry of loot) {
      let remaining = entry.count;
      if (playerId) remaining = this.hooks.giveItems(playerId, entry.id, entry.count);
      if (remaining > 0) this.spawnDrop(entry.id, remaining, x, y, z);
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

        const leftover = this.hooks.giveItems(player.id, drop.itemId, drop.count, drop.damage);
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

  spawnDrop(
    itemId: string,
    count: number,
    x: number,
    y: number,
    z: number,
    ownerId?: string,
    damage?: number,
  ): DropSim | null {
    if (count <= 0 || !getItem(itemId)) return null;
    if (this.drops.size >= MAX_DROPS) {
      // Make room by retiring the oldest drop.
      const oldest = [...this.drops.values()].sort((a, b) => b.age - a.age)[0];
      if (oldest) {
        this.drops.delete(oldest.id);
        this.removedDrops.push(oldest.id);
      }
    }
    const drop = new DropSim(itemId, count, x, y, z, ownerId ?? null);
    if (damage !== undefined) drop.damage = damage;
    this.drops.set(drop.id, drop);
    return drop;
  }

  /** Throw a set of stacks on the ground, e.g. a dead player's inventory. */
  scatterStacks(stacks: (ItemStack | null)[], x: number, y: number, z: number): void {
    for (const stack of stacks) {
      if (!stack) continue;
      this.spawnDrop(stack.id, stack.count, x, y, z, undefined, stack.damage);
    }
  }

  /**
   * Apply damage from a player to a mob; returns true if it connected.
   * `knockback` is the shove the attacker's weapon carries — the caller looks
   * it up, because only it knows what was in the attacker's hand.
   */
  damageMob(
    mobId: number,
    damage: number,
    attackerId: string,
    from: Vec3,
    knockback = FIST_KNOCKBACK,
  ): boolean {
    const mob = this.mobs.get(mobId);
    if (!mob || mob.dead) return false;
    // The client already paced the swing; don't double-gate on hurt time.
    mob.hurtTime = 0;
    mob.takeDamage(damage, from.x, from.z, attackerId, knockback);
    return true;
  }

  /**
   * Shear a sheep with whatever the caller has verified are shears. The wool
   * goes to the player, or on the ground if their hands are full. Returns
   * false when there was nothing to shear.
   */
  shearMob(mobId: number, playerId: string): boolean {
    const mob = this.mobs.get(mobId);
    if (!mob) return false;
    const wool = mob.shear();
    if (!wool) return false;
    this.grantLoot(wool, playerId, mob.position.x, mob.position.y + 0.6, mob.position.z);
    return true;
  }

  // --- Spawning ---------------------------------------------------------

  private trySpawn(players: SimPlayer[]): void {
    if (players.length === 0) return;
    const night = isNightTime(this.timeOfDay);
    // Villagers appear by day; at night the village belongs to the zombies.
    if (!night) this.spawnVillagers(players);
    if (this.mobs.size >= MAX_MOBS) return;
    let hostiles = 0;
    let passives = 0;
    for (const mob of this.mobs.values()) {
      if (mob.def.hostile) hostiles++;
      else if (mob.kind !== 'villager') passives++;
    }
    if (night ? hostiles >= MAX_HOSTILE : passives >= MAX_PASSIVE) return;
    const kind = pickSpawnKind(night ? 'night' : 'day', Math.random);
    if (!kind) return;
    const rule = MOB_DEFS[kind].spawn;

    // Spawn in a ring around a random player, on real ground.
    const anchor = players[Math.floor(Math.random() * players.length)];
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist =
        MOB_SPAWN_MIN_DISTANCE + Math.random() * (MOB_SPAWN_MAX_DISTANCE - MOB_SPAWN_MIN_DISTANCE);
      const x = Math.floor(anchor.position.x + Math.cos(angle) * dist);
      const z = Math.floor(anchor.position.z + Math.sin(angle) * dist);
      const y = this.canSpawnAt(x, z, rule.needsGrass);
      if (y === null) continue;

      // Animals arrive as a small herd; a lone cow in a field looks lost.
      const size = rule.group[0] + Math.floor(Math.random() * (rule.group[1] - rule.group[0] + 1));
      this.addMob(new MobSim(kind, x + 0.5, y, z + 0.5));
      for (let i = 1; i < size && this.mobs.size < MAX_MOBS; i++) {
        const hx = x + Math.floor(Math.random() * (HERD_SPREAD * 2 + 1)) - HERD_SPREAD;
        const hz = z + Math.floor(Math.random() * (HERD_SPREAD * 2 + 1)) - HERD_SPREAD;
        const hy = this.canSpawnAt(hx, hz, rule.needsGrass);
        if (hy === null || Math.abs(hy - y) > 3) continue;
        this.addMob(new MobSim(kind, hx + 0.5, hy, hz + 0.5));
      }
      return;
    }
  }

  /** Standing height for a spawn at this column, or null when unsuitable. */
  private canSpawnAt(x: number, z: number, needsGrass: boolean): number | null {
    const y = this.world.surfaceAt(x, z);
    if (y === null) return null;
    // Never spawn in water or on leaves; animals want grass under their feet.
    const ground = this.world.getBlock(x, y - 1, z);
    if (ground === Block.Water || ground === Block.Leaves) return null;
    if (needsGrass && ground !== Block.Grass) return null;
    return y;
  }

  /** Villages near a player keep a few villagers about, until they have enough. */
  private spawnVillagers(players: SimPlayer[]): void {
    if (!this.world.villagesNear) return;
    const seen = new Set<string>();
    for (const player of players) {
      for (const village of this.world.villagesNear(player.position.x, player.position.z, VILLAGE_ACTIVE_RANGE)) {
        if (seen.has(village.id)) continue;
        seen.add(village.id);
        const reach = (village.radius + 8) * (village.radius + 8);
        let count = 0;
        for (const mob of this.mobs.values()) {
          if (mob.kind !== 'villager' || !mob.home) continue;
          const dx = mob.home.x - village.x;
          const dz = mob.home.z - village.z;
          if (dx * dx + dz * dz <= reach) count++;
        }
        if (count >= VILLAGERS_PER_VILLAGE) continue;
        for (let attempt = 0; attempt < 8; attempt++) {
          const angle = Math.random() * Math.PI * 2;
          const dist = 2 + Math.random() * village.radius * 0.7;
          const x = Math.floor(village.x + Math.cos(angle) * dist);
          const z = Math.floor(village.z + Math.sin(angle) * dist);
          const y = this.canSpawnAt(x, z, false);
          if (y === null) continue;
          const villager = new MobSim('villager', x + 0.5, y, z + 0.5);
          villager.home = { x: village.x, y, z: village.z };
          this.addMob(villager);
          return; // one at a time, so a village fills gently
        }
      }
    }
  }

  addMob(mob: MobSim): void {
    this.mobs.set(mob.id, mob);
  }

  // --- Block entities -----------------------------------------------------

  /**
   * The chest or furnace at this position, creating it on first use. A chest
   * that is untouched terrain — a village chest — is stocked from its loot
   * table, seeded by position so everyone finds the same things in it.
   */
  openContainer(x: number, y: number, z: number): BlockEntity | null {
    const id = this.world.getBlock(x, y, z);
    const kind: ContainerKind | null = id === Block.Chest ? 'chest' : isFurnace(id) ? 'furnace' : null;
    if (!kind) return null;
    const key = blockKey(x, y, z);
    const existing = this.containers.get(key);
    if (existing && existing.kind === kind) return existing;

    const entity: BlockEntity = {
      x,
      y,
      z,
      kind,
      slots: new Array(slotCount(kind)).fill(null),
      burn: 0,
      burnMax: 0,
      progress: 0,
    };
    if (kind === 'chest' && this.world.isNaturalBlock?.(x, y, z)) {
      const rand = seededRandom(positionSeed(this.world.seed, x, y, z));
      for (const roll of rollLoot(VILLAGE_CHEST_LOOT, rand)) {
        const start = Math.floor(rand() * entity.slots.length);
        for (let i = 0; i < entity.slots.length; i++) {
          const slot = (start + i) % entity.slots.length;
          if (entity.slots[slot]) continue;
          entity.slots[slot] = { id: roll.id, count: roll.count };
          break;
        }
      }
    }
    this.containers.set(key, entity);
    return entity;
  }

  /**
   * A block was taken out of the world: spill any container that was there,
   * forget any crop, wake anyone sleeping in that bed, and break a crop that
   * was standing on it.
   */
  blockRemoved(x: number, y: number, z: number): void {
    const key = blockKey(x, y, z);
    const entity = this.containers.get(key);
    if (entity) {
      this.scatterStacks(entity.slots, x + 0.5, y + 0.5, z + 0.5);
      this.containers.delete(key);
      this.dirtyContainers.delete(key);
      this.removedContainers.push(key);
    }
    this.crops.delete(key);
    for (const [playerId, bed] of [...this.sleepers]) {
      if (bed.x === x && bed.y === y && bed.z === z) this.wake(playerId, 'bed_gone');
    }
    const above = this.world.getBlock(x, y + 1, z);
    if (isCrop(above)) {
      for (const roll of blockDrops(BLOCKS[above], null)) {
        this.spawnDrop(roll.id, roll.count, x + 0.5, y + 1.3, z + 0.5);
      }
      this.setBlock(x, y + 1, z, Block.Air);
      this.crops.delete(blockKey(x, y + 1, z));
    }
  }

  /** A block was put into the world; crops start growing from here. */
  blockPlaced(x: number, y: number, z: number, id: number): void {
    const key = blockKey(x, y, z);
    if (this.containers.has(key)) this.blockRemoved(x, y, z);
    if (isCrop(id)) this.registerCrop(x, y, z);
    else this.crops.delete(key);
  }

  registerCrop(x: number, y: number, z: number): void {
    const id = this.world.getBlock(x, y, z);
    if (!isCrop(id) || BLOCKS[id].growsInto === null) return;
    this.crops.set(blockKey(x, y, z), { x, y, z });
  }

  /** Change a block on the simulation's own initiative and tell everyone. */
  private setBlock(x: number, y: number, z: number, id: number): void {
    this.world.applyEdit?.(x, y, z, id);
    this.blocks.push({ x, y, z, id });
    this.hooks.onBlockChanged?.(x, y, z, id);
  }

  /**
   * Furnaces burn fuel and turn input into output. Fuel keeps burning once
   * lit whether or not there is anything to smelt, as in Minecraft, so idle
   * heat is a real cost. Progress cools twice as fast as it heats when the
   * fire goes out.
   */
  private updateFurnaces(dt: number): void {
    for (const [key, furnace] of this.containers) {
      if (furnace.kind !== 'furnace') continue;
      const wasLit = furnace.burn > 0;
      let changed = false;

      if (furnace.burn > 0) furnace.burn = Math.max(0, furnace.burn - dt);

      const input = furnace.slots[FURNACE_INPUT];
      const recipe = input ? smeltResult(input.id) : undefined;
      const output = furnace.slots[FURNACE_OUTPUT];
      const roomForOutput =
        recipe !== undefined &&
        (!output ||
          (output.id === recipe.output &&
            output.damage === undefined &&
            output.count + recipe.count <= (getItem(output.id)?.maxStack ?? 64)));
      const canSmelt = recipe !== undefined && roomForOutput;

      if (furnace.burn <= 0 && canSmelt) {
        const fuel = furnace.slots[FURNACE_FUEL];
        const seconds = fuel ? fuelSeconds(fuel.id) : 0;
        if (fuel && seconds > 0) {
          furnace.burn = seconds;
          furnace.burnMax = seconds;
          fuel.count--;
          if (fuel.count <= 0) furnace.slots[FURNACE_FUEL] = null;
          changed = true;
        }
      }

      if (furnace.burn > 0 && canSmelt && input && recipe) {
        furnace.progress += dt / SMELT_TIME_S;
        if (furnace.progress >= 1) {
          furnace.progress = 0;
          input.count--;
          if (input.count <= 0) furnace.slots[FURNACE_INPUT] = null;
          if (output) output.count += recipe.count;
          else furnace.slots[FURNACE_OUTPUT] = { id: recipe.output, count: recipe.count };
          changed = true;
        }
      } else if (furnace.progress > 0) {
        furnace.progress = Math.max(0, furnace.progress - (dt / SMELT_TIME_S) * 2);
      }

      const lit = furnace.burn > 0;
      if (lit !== wasLit) {
        // Only swap the block if it is still a furnace: someone may have broken
        // it this tick, in which case blockRemoved already cleaned up.
        if (isFurnace(this.world.getBlock(furnace.x, furnace.y, furnace.z))) {
          this.setBlock(furnace.x, furnace.y, furnace.z, lit ? Block.LitFurnace : Block.Furnace);
        }
        changed = true;
      }
      // Anyone watching the furnace needs the arrow and flame to move.
      if (changed || lit || furnace.progress > 0) this.dirtyContainers.add(key);
    }
  }

  /** Crops near a player advance a stage now and then; ripe ones stop ticking. */
  private updateCrops(dt: number, players: SimPlayer[]): void {
    if (this.crops.size === 0) return;
    const rangeSq = CROP_TICK_RANGE * CROP_TICK_RANGE;
    const chance = dt / CROP_GROWTH_MEAN_S;
    for (const [key, at] of this.crops) {
      if (nearestDistanceSq(at, players) > rangeSq) continue;
      const id = this.world.getBlock(at.x, at.y, at.z);
      const next = isCrop(id) ? BLOCKS[id].growsInto : null;
      if (next === null) {
        this.crops.delete(key);
        continue;
      }
      if (Math.random() >= chance) continue;
      this.setBlock(at.x, at.y, at.z, next);
      if (BLOCKS[next].growsInto === null) this.crops.delete(key);
    }
  }

  // --- Beds ---------------------------------------------------------------

  /** A player tries to get into the bed at this position. */
  trySleep(playerId: string, x: number, y: number, z: number, players: SimPlayer[]): SleepAttempt {
    const player = players.find((p) => p.id === playerId);
    if (!player || player.dead) return { ok: false };
    if (!isSleepTime(this.timeOfDay)) return { ok: false, message: 'You can only sleep at night.' };
    if (this.world.getBlock(x, y, z) !== Block.Bed) return { ok: false, message: 'That is not a bed.' };
    for (const [other, bed] of this.sleepers) {
      if (other !== playerId && bed.x === x && bed.y === y && bed.z === z) {
        return { ok: false, message: 'This bed is occupied.' };
      }
    }
    this.sleepers.set(playerId, { x, y, z });
    return { ok: true };
  }

  /** Get a player out of bed. Silent when they were not in one. */
  wake(playerId: string, reason: WakeReason | null = null): void {
    if (!this.sleepers.delete(playerId)) return;
    if (reason) this.hooks.onWake?.(playerId, reason);
  }

  /** Forget a player who left the room. */
  removePlayer(playerId: string): void {
    this.sleepers.delete(playerId);
  }

  /**
   * When every living player is in bed for a few seconds the night is
   * skipped. Anyone who dies, leaves or loses their bed drops out, and dawn
   * wakes whoever is left.
   */
  private updateSleep(dt: number, players: SimPlayer[]): void {
    if (this.sleepers.size === 0) {
      this.sleepTimer = 0;
      return;
    }
    for (const [playerId, bed] of [...this.sleepers]) {
      const player = players.find((p) => p.id === playerId);
      if (!player) {
        this.sleepers.delete(playerId);
        continue;
      }
      if (player.dead) {
        this.wake(playerId, 'dead');
        continue;
      }
      if (this.world.getBlock(bed.x, bed.y, bed.z) !== Block.Bed) this.wake(playerId, 'bed_gone');
    }
    if (!isSleepTime(this.timeOfDay)) {
      for (const playerId of [...this.sleepers.keys()]) this.wake(playerId, 'morning');
      this.sleepTimer = 0;
      return;
    }
    const living = players.filter((p) => !p.dead).length;
    if (living === 0 || this.sleepers.size < living) {
      this.sleepTimer = 0;
      return;
    }
    this.sleepTimer += dt;
    if (this.sleepTimer < SLEEP_DURATION_S) return;
    this.sleepTimer = 0;
    this.timeOfDay = SLEEP_WAKE_TIME;
    for (const playerId of [...this.sleepers.keys()]) this.wake(playerId, 'morning');
  }

  sleepSnapshot(players: SimPlayer[]): SleepStateData | undefined {
    if (this.sleepers.size === 0) return undefined;
    return {
      sleeping: [...this.sleepers.keys()],
      needed: players.filter((p) => !p.dead).length,
    };
  }

  // --- Snapshots ----------------------------------------------------------

  /** Compact snapshots for the wire. */
  mobSnapshot(): MobStateData[] {
    const out: MobStateData[] = [];
    for (const mob of this.mobs.values()) {
      const flags = mob.flags();
      const headYaw = round(mob.headYaw);
      out.push({
        i: mob.id,
        k: mob.def.wire,
        x: round(mob.position.x),
        y: round(mob.position.y),
        z: round(mob.position.z),
        yaw: round(mob.yaw),
        hp: Math.max(0, Math.round(mob.health)),
        // All only present when they apply, so an idle mob adds nothing.
        ...(mob.swingTime > 0 ? { s: 1 as const } : {}),
        ...(mob.drawTime > 0
          ? { d: round(Math.min(1, mob.drawTime / SKELETON_DRAW_S)) }
          : {}),
        ...(flags !== 0 ? { f: flags } : {}),
        ...(headYaw !== 0 ? { hy: headYaw } : {}),
      });
    }
    return out;
  }

  /** Arrows in flight, so every client sees the same shot from the same place. */
  arrowSnapshot(): ArrowStateData[] {
    const out: ArrowStateData[] = [];
    for (const arrow of this.arrows.values()) {
      out.push({
        i: arrow.id,
        x: round(arrow.position.x),
        y: round(arrow.position.y),
        z: round(arrow.position.z),
        yaw: round(arrow.yaw),
        pitch: round(arrow.pitch),
      });
    }
    return out;
  }

  dropSnapshot(): DropStateData[] {
    const out: DropStateData[] = [];
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

  /** One container as the wire and the save file see it. */
  containerSnapshot(entity: BlockEntity): SavedContainer {
    const out: SavedContainer = {
      x: entity.x,
      y: entity.y,
      z: entity.z,
      kind: entity.kind,
      slots: cloneSlots(entity.slots),
    };
    if (entity.kind === 'furnace') {
      out.burn = round(entity.burn);
      out.burnMax = round(entity.burnMax);
      out.progress = round(entity.progress);
    }
    return out;
  }

  // --- Persistence --------------------------------------------------------

  /** Everything worth keeping when the world is put away. */
  serialize(): SavedSimState {
    const containers: SavedContainer[] = [];
    for (const entity of this.containers.values()) {
      // Empty, cold furnaces and empty chests are recreated on demand; a
      // village chest that was never opened must NOT be written out as empty,
      // and one that was emptied keeps an entry so it is not restocked.
      containers.push(this.containerSnapshot(entity));
    }
    return {
      timeOfDay: this.timeOfDay,
      containers,
      mobs: [...this.mobs.values()].filter((m) => !m.dead).map((m) => m.toSave()),
      drops: [...this.drops.values()].map((d) => ({
        item: d.itemId,
        count: d.count,
        x: d.position.x,
        y: d.position.y,
        z: d.position.z,
        age: d.age,
        ...(d.damage !== undefined ? { damage: d.damage } : {}),
      })),
    };
  }

  /** Load a saved state, replacing whatever the room holds. */
  restore(state: SavedSimState): void {
    this.timeOfDay = state.timeOfDay;
    this.containers.clear();
    for (const saved of state.containers) {
      this.containers.set(blockKey(saved.x, saved.y, saved.z), {
        x: saved.x,
        y: saved.y,
        z: saved.z,
        kind: saved.kind,
        slots: cloneSlots(saved.slots),
        burn: saved.burn ?? 0,
        burnMax: saved.burnMax ?? 0,
        progress: saved.progress ?? 0,
      });
    }
    this.mobs.clear();
    for (const saved of state.mobs) this.addMob(MobSim.fromSave(saved));
    this.drops.clear();
    for (const saved of state.drops) {
      const drop = new DropSim(saved.item, saved.count, saved.x, saved.y, saved.z);
      drop.age = saved.age;
      drop.velocity.x = 0;
      drop.velocity.y = 0;
      drop.velocity.z = 0;
      if (saved.damage !== undefined) drop.damage = saved.damage;
      this.drops.set(drop.id, drop);
    }
    this.sleepers.clear();
    this.sleepTimer = 0;
  }

  /** Kinds of every living mob, for tests and the debug overlay. */
  mobKinds(): MobKind[] {
    return [...this.mobs.values()].map((m) => m.kind);
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function nearestDistanceSq(at: Vec3, players: SimPlayer[]): number {
  let best = Infinity;
  for (const p of players) {
    const dx = p.position.x - at.x;
    const dy = p.position.y - at.y;
    const dz = p.position.z - at.z;
    const sq = dx * dx + dy * dy + dz * dz;
    if (sq < best) best = sq;
  }
  return best;
}
