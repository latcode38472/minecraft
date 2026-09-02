// Save schema: what a world looks like at rest.
//
// The same shape is written by the server (one JSON file per world) and by
// the browser (IndexedDB, singleplayer). Everything is validated on the way
// back in, field by field with defaults, so a save from an older version, a
// hand-edited file or a half-written one loads as far as it can rather than
// crashing the room. `version` is bumped whenever the layout changes; the
// upgrade path lives in `validateWorldSave`.
//
// Loaded by Node as well as the browser: erasable TypeScript only.

import { isValidBlockId, isValidChunkKey, type ContainerKind } from '../net/protocol.ts';
import { sanitizeSlots, sanitizeStack, slotCount } from '../items/containers.ts';
import { ARMOR_SLOT_COUNT, INVENTORY_SIZE, type ItemStack } from '../items/inventory.ts';
import { MAX_HEALTH, MAX_HUNGER, START_TIME_OF_DAY } from '../constants.ts';
import { isMobKind, type MobKind } from './mobs.ts';

export const SAVE_VERSION = 2;

export type SavedStack = ItemStack;

export interface SavedPlayer {
  /** The stable per-browser key the player joined with. */
  key: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  hunger: number;
  selected: number;
  inventory: (SavedStack | null)[];
  armor: (SavedStack | null)[];
  spawn?: { x: number; y: number; z: number };
}

export interface SavedMob {
  /** Kind by name, never by wire number, so a reordering cannot mutate a save. */
  kind: MobKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  /** Sheep only. */
  color?: number;
  sheared?: boolean;
  woolTimer?: number;
  /** Villagers only: the spot they wander around. */
  home?: { x: number; y: number; z: number };
}

export interface SavedDrop {
  item: string;
  count: number;
  x: number;
  y: number;
  z: number;
  age: number;
  damage?: number;
}

export interface SavedContainer {
  x: number;
  y: number;
  z: number;
  kind: ContainerKind;
  slots: (SavedStack | null)[];
  burn?: number;
  burnMax?: number;
  progress?: number;
}

/** Everything the simulation owns; the part of a save that is not terrain. */
export interface SavedSimState {
  timeOfDay: number;
  containers: SavedContainer[];
  mobs: SavedMob[];
  drops: SavedDrop[];
}

export interface WorldSave extends SavedSimState {
  version: number;
  id: string;
  name: string;
  seed: number;
  /** Last write, Unix ms. */
  updated: number;
  /** Player key of whoever owns the world (may host it again later). */
  host: string;
  /** Chunk key -> flat [voxelIndex, blockId] pairs. */
  edits: Record<string, number[]>;
  players: Record<string, SavedPlayer>;
}

// --- Validation -------------------------------------------------------------

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function str(v: unknown, fallback: string, maxLength = 64): string {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, maxLength) : fallback;
}

function vec3(v: unknown): { x: number; y: number; z: number } | undefined {
  if (!isRecord(v)) return undefined;
  if (![v.x, v.y, v.z].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x: v.x as number, y: v.y as number, z: v.z as number };
}

/** Edits are only kept when every pair is a real voxel index and block id. */
export function validateEdits(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidChunkKey(key) || !Array.isArray(value)) continue;
    const pairs: number[] = [];
    for (let i = 0; i + 1 < value.length; i += 2) {
      const index = value[i];
      const id = value[i + 1];
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= 16 * 16 * 72) continue;
      if (!isValidBlockId(id)) continue;
      pairs.push(index as number, id as number);
    }
    if (pairs.length > 0) out[key] = pairs;
  }
  return out;
}

export function validatePlayer(raw: unknown, key: string): SavedPlayer | null {
  if (!isRecord(raw)) return null;
  const position = { x: num(raw.x, 0), y: num(raw.y, 40, -64, 320), z: num(raw.z, 0) };
  return {
    key,
    name: str(raw.name, 'Player', 16),
    ...position,
    yaw: num(raw.yaw, 0),
    pitch: num(raw.pitch, 0, -Math.PI / 2, Math.PI / 2),
    health: num(raw.health, MAX_HEALTH, 0, MAX_HEALTH),
    hunger: num(raw.hunger, MAX_HUNGER, 0, MAX_HUNGER),
    selected: Math.floor(num(raw.selected, 0, 0, 8)),
    inventory: sanitizeSlots(raw.inventory, INVENTORY_SIZE),
    armor: sanitizeSlots(raw.armor, ARMOR_SLOT_COUNT),
    spawn: vec3(raw.spawn),
  };
}

export function validateMob(raw: unknown): SavedMob | null {
  if (!isRecord(raw) || !isMobKind(raw.kind)) return null;
  const mob: SavedMob = {
    kind: raw.kind,
    x: num(raw.x, 0),
    y: num(raw.y, 40, -64, 320),
    z: num(raw.z, 0),
    yaw: num(raw.yaw, 0),
    hp: num(raw.hp, 1, 0.5, 1000),
  };
  if (typeof raw.color === 'number') mob.color = Math.floor(num(raw.color, 0, 0, 7));
  if (raw.sheared === true) mob.sheared = true;
  if (typeof raw.woolTimer === 'number') mob.woolTimer = num(raw.woolTimer, 0, 0, 100000);
  const home = vec3(raw.home);
  if (home) mob.home = home;
  return mob;
}

export function validateDrop(raw: unknown): SavedDrop | null {
  if (!isRecord(raw)) return null;
  const stack = sanitizeStack({ id: raw.item, count: raw.count, damage: raw.damage });
  if (!stack) return null;
  const drop: SavedDrop = {
    item: stack.id,
    count: stack.count,
    x: num(raw.x, 0),
    y: num(raw.y, 40, -64, 320),
    z: num(raw.z, 0),
    age: num(raw.age, 0, 0, 100000),
  };
  if (stack.damage !== undefined) drop.damage = stack.damage;
  return drop;
}

export function validateContainer(raw: unknown): SavedContainer | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== 'chest' && raw.kind !== 'furnace') return null;
  if (![raw.x, raw.y, raw.z].every(Number.isInteger)) return null;
  const kind = raw.kind as ContainerKind;
  const container: SavedContainer = {
    x: raw.x as number,
    y: raw.y as number,
    z: raw.z as number,
    kind,
    slots: sanitizeSlots(raw.slots, slotCount(kind)),
  };
  if (kind === 'furnace') {
    container.burn = num(raw.burn, 0, 0, 100000);
    container.burnMax = num(raw.burnMax, 0, 0, 100000);
    container.progress = num(raw.progress, 0, 0, 1);
  }
  return container;
}

function validateList<T>(raw: unknown, validate: (v: unknown) => T | null, limit: number): T[] {
  const out: T[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const valid = validate(entry);
    if (valid) out.push(valid);
    if (out.length >= limit) break;
  }
  return out;
}

export function validateSimState(raw: unknown): SavedSimState {
  const r = isRecord(raw) ? raw : {};
  return {
    timeOfDay: num(r.timeOfDay, START_TIME_OF_DAY, 0, 1) % 1,
    containers: validateList(r.containers, validateContainer, 4096),
    mobs: validateList(r.mobs, validateMob, 256),
    drops: validateList(r.drops, validateDrop, 256),
  };
}

/**
 * Turn whatever was on disk into a well-formed save, or null when it is not
 * a save at all. Missing pieces get defaults; a v1 save (terrain + clock only)
 * upgrades to v2 by gaining empty containers, mobs, drops and players.
 */
export function validateWorldSave(raw: unknown): WorldSave | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.seed !== 'number' || !Number.isFinite(raw.seed)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;

  const players: Record<string, SavedPlayer> = {};
  if (isRecord(raw.players)) {
    for (const [key, value] of Object.entries(raw.players)) {
      const player = validatePlayer(value, key);
      if (player) players[key] = player;
    }
  }

  return {
    ...validateSimState(raw),
    version: SAVE_VERSION,
    id: raw.id,
    name: str(raw.name, 'World', 24),
    seed: Math.floor(raw.seed),
    updated: num(raw.updated, 0, 0),
    host: str(raw.host, '', 64),
    edits: validateEdits(raw.edits),
    players,
  };
}

export function emptyWorldSave(id: string, name: string, seed: number, host: string): WorldSave {
  return {
    version: SAVE_VERSION,
    id,
    name,
    seed,
    timeOfDay: START_TIME_OF_DAY,
    updated: Date.now(),
    host,
    edits: {},
    containers: [],
    mobs: [],
    drops: [],
    players: {},
  };
}
