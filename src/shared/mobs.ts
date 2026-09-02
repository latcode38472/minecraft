// Mob registry: every kind of creature, its numbers, and its spawn rules.
//
// The simulation (mobsim.ts) reads behaviour from here; the wire encodes a
// kind as its `wire` number; saves store the kind by name so a reordering can
// never turn a saved cow into a zombie.

import {
  MOB_KIND_COW,
  MOB_KIND_PIG,
  MOB_KIND_SHEEP,
  MOB_KIND_SKELETON,
  MOB_KIND_VILLAGER,
  MOB_KIND_ZOMBIE,
} from '../net/protocol.ts';
import { MOB_LOOT, type LootTable } from './loot.ts';
import type { BodyShape } from './voxel.ts';

export type MobKind = 'zombie' | 'skeleton' | 'pig' | 'cow' | 'sheep' | 'villager';

export type SpawnTime = 'day' | 'night' | 'village' | 'never';

export interface SpawnRule {
  /** When natural spawning may pick this kind. */
  time: SpawnTime;
  /** Relative pick weight among kinds sharing a spawn time. */
  weight: number;
  /** Herd size range. */
  group: [number, number];
  /** Passive mobs only spawn on grass; hostiles anywhere solid. */
  needsGrass: boolean;
}

export interface MobDef {
  kind: MobKind;
  wire: number;
  hostile: boolean;
  maxHealth: number;
  shape: BodyShape;
  /** Walking speed, blocks per second. */
  speed: number;
  /** Speed when running from a hit (animals) or charging (hostiles). */
  fleeSpeed: number;
  /** Melee attackers only. */
  attackDamage: number;
  attackRange: number;
  attackCooldown: number;
  /** Animals drop their head to eat grass now and then. */
  grazes: boolean;
  /** Never despawned for being far away — villagers stay with their village. */
  persistent: boolean;
  loot: LootTable;
  spawn: SpawnRule;
}

const TALL: BodyShape = { halfWidth: 0.3, height: 1.95 };

export const MOB_DEFS: Record<MobKind, MobDef> = {
  zombie: {
    kind: 'zombie',
    wire: MOB_KIND_ZOMBIE,
    hostile: true,
    maxHealth: 20,
    shape: TALL,
    // Slower than the player's 4.3, so running away always works.
    speed: 2.4,
    fleeSpeed: 2.4,
    attackDamage: 3,
    attackRange: 1.7,
    attackCooldown: 1.1,
    grazes: false,
    persistent: false,
    loot: MOB_LOOT.zombie,
    spawn: { time: 'night', weight: 65, group: [1, 2], needsGrass: false },
  },
  skeleton: {
    kind: 'skeleton',
    wire: MOB_KIND_SKELETON,
    hostile: true,
    maxHealth: 16,
    shape: TALL,
    speed: 2.6,
    fleeSpeed: 2.6,
    // Damage comes from the arrow, not from touching you.
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
    grazes: false,
    persistent: false,
    loot: MOB_LOOT.skeleton,
    spawn: { time: 'night', weight: 35, group: [1, 1], needsGrass: false },
  },
  pig: {
    kind: 'pig',
    wire: MOB_KIND_PIG,
    hostile: false,
    maxHealth: 10,
    shape: { halfWidth: 0.45, height: 0.9 },
    speed: 0.9,
    fleeSpeed: 2.8,
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
    grazes: false,
    persistent: false,
    loot: MOB_LOOT.pig,
    spawn: { time: 'day', weight: 35, group: [1, 3], needsGrass: true },
  },
  cow: {
    kind: 'cow',
    wire: MOB_KIND_COW,
    hostile: false,
    maxHealth: 10,
    shape: { halfWidth: 0.45, height: 1.4 },
    speed: 0.8,
    fleeSpeed: 2.6,
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
    grazes: true,
    persistent: false,
    loot: MOB_LOOT.cow,
    spawn: { time: 'day', weight: 30, group: [2, 4], needsGrass: true },
  },
  sheep: {
    kind: 'sheep',
    wire: MOB_KIND_SHEEP,
    hostile: false,
    maxHealth: 8,
    shape: { halfWidth: 0.45, height: 1.3 },
    speed: 0.9,
    fleeSpeed: 2.6,
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
    grazes: true,
    persistent: false,
    loot: MOB_LOOT.sheep,
    spawn: { time: 'day', weight: 35, group: [2, 4], needsGrass: true },
  },
  villager: {
    kind: 'villager',
    wire: MOB_KIND_VILLAGER,
    hostile: false,
    maxHealth: 20,
    shape: TALL,
    speed: 1.4,
    fleeSpeed: 3.0,
    attackDamage: 0,
    attackRange: 0,
    attackCooldown: 0,
    grazes: false,
    persistent: true,
    loot: MOB_LOOT.villager,
    spawn: { time: 'village', weight: 1, group: [1, 1], needsGrass: false },
  },
};

export const MOB_KINDS: MobKind[] = Object.keys(MOB_DEFS) as MobKind[];

const byWire = new Map<number, MobKind>(MOB_KINDS.map((k) => [MOB_DEFS[k].wire, k]));

export function mobKindFromWire(wire: number): MobKind | undefined {
  return byWire.get(wire);
}

export function isMobKind(v: unknown): v is MobKind {
  return typeof v === 'string' && v in MOB_DEFS;
}

/** Pick a kind for a natural spawn at the given time, weighted, or null. */
export function pickSpawnKind(time: SpawnTime, rand: () => number): MobKind | null {
  const candidates = MOB_KINDS.filter((k) => MOB_DEFS[k].spawn.time === time);
  const total = candidates.reduce((sum, k) => sum + MOB_DEFS[k].spawn.weight, 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const kind of candidates) {
    roll -= MOB_DEFS[kind].spawn.weight;
    if (roll < 0) return kind;
  }
  return candidates[candidates.length - 1] ?? null;
}

/** Sheep come in a few natural fleece colours; index into this palette. */
export const SHEEP_COLORS = [0xe8e8e8, 0xe8e8e8, 0xe8e8e8, 0xe8e8e8, 0x8a8a8a, 0x3a3a3a, 0x8b5a2b, 0xf0dcc8];

export function pickSheepColor(rand: () => number): number {
  return Math.floor(rand() * SHEEP_COLORS.length);
}
