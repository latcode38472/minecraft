// Wire protocol shared by the browser client and the Node server.
//
// This file is imported by BOTH sides, so it must contain only erasable
// TypeScript (types, interfaces, plain consts) — no `enum`, no decorators,
// no parameter properties — because the server runs it through Node's native
// type stripping. It also deliberately imports nothing from the game, so the
// server never has to pull in Three.js or browser-only modules.
//
// Encoding is JSON today. Everything goes through encodeMessage/decodeMessage
// so a binary codec can replace the transport without touching game code.

export const PROTOCOL_VERSION = 3;

/** Hard room cap: one host plus two guests. Enforced server-side. */
export const MAX_PLAYERS = 3;

export const ROOM_CODE_LENGTH = 6;
/** Unambiguous alphabet: no O/0, I/1, so codes survive being read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const NAME_MAX_LENGTH = 16;
export const DEFAULT_NAME = 'Player';

// --- Abuse limits (enforced server-side) ---
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Token-bucket sizes, messages per second. */
export const RATE_LIMIT_STATE_PER_SEC = 30;
export const RATE_LIMIT_EDITS_PER_SEC = 40;
export const RATE_LIMIT_OTHER_PER_SEC = 15;
/** Chunk keys a client may ask for in one request. */
export const MAX_CHUNK_REQUEST = 64;
/** Edits packed into a single chunk_edits message. */
export const EDITS_PER_MESSAGE = 2000;

// --- World bounds used for validating edits ---
// These mirror the game's own constants; the client asserts they agree at
// startup (see session.ts) so the two can never silently drift apart.
export const WORLD_HEIGHT_LIMIT = 72;
export const MAX_BLOCK_ID = 42;
export const MAX_HORIZONTAL_COORD = 30_000_000;

/** Longest item id accepted from the wire; registry ids are far shorter. */
export const ITEM_ID_MAX_LENGTH = 40;
/** World names are shown in the world list, so they get the same scrub as names. */
export const WORLD_NAME_MAX_LENGTH = 24;
/** A world id is a hex string the server minted; anything else is rejected. */
export const WORLD_ID_PATTERN = /^[a-f0-9]{8,32}$/;
/** Player keys are minted by the client once and reused across sessions. */
export const PLAYER_KEY_PATTERN = /^[a-f0-9]{16,64}$/;

/** Client state send rate; remote players are interpolated between these. */
export const STATE_SEND_HZ = 15;
/** How far behind live the interpolator renders remote players. */
export const INTERPOLATION_DELAY_MS = 120;

/**
 * The clock every inbound snapshot is stamped with, and the one interpolation
 * compares against. It MUST be the same clock the frame loop uses.
 *
 * `Date.now()` and `performance.now()` have completely different epochs, so
 * mixing them silently breaks interpolation: no snapshot ever compares as "old
 * enough" to render, and bodies fall back to the oldest sample in the buffer —
 * a second or more behind, with no smoothing at all. It is also monotonic,
 * which a wall clock is not; an NTP correction would reorder the buffer.
 */
export function receiveClock(): number {
  return performance.now();
}
export const PING_INTERVAL_MS = 2000;
/** Server drops a connection that has not been heard from in this long. */
export const CLIENT_TIMEOUT_MS = 30_000;

/** Movement flags packed into one integer so state packets stay small. */
export const FLAG_MOVING = 1;
export const FLAG_JUMPING = 2;
export const FLAG_GROUNDED = 4;
export const FLAG_SNEAKING = 8;
/** Mid-swing: mining or attacking. Drives the arm animation on other screens. */
export const FLAG_SWINGING = 16;
/** Using the held item: eating, drawing a bow, raising a shield. */
export const FLAG_USING = 32;
/** Just took a hit: other screens flash the body red and knock it back a step. */
export const FLAG_HURT = 64;
/** Lying dead; the body topples instead of standing at the death spot. */
export const FLAG_DEAD = 128;
/** In bed; the body lies flat on the bed block. */
export const FLAG_SLEEPING = 256;
/** Running: other clients widen the gait rather than guessing from speed. */
export const FLAG_SPRINTING = 512;
/** Mask applied to inbound flags — widen this when adding a flag above. */
export const FLAG_MASK = 0x3ff;

export interface WorldInfo {
  seed: number;
  spawn: { x: number; y: number; z: number };
  /** Reserved for future world-gen options; present so adding one is not a break. */
  generator: 'default';
}

export interface PlayerInfo {
  id: string;
  name: string;
  isHost: boolean;
  /** Stable 0-based index used to pick a body colour. */
  colorIndex: number;
  /** Armour tier per slot (head, chest, legs, feet); 0 = nothing worn. */
  equipment: number[];
}

export const ARMOR_SLOTS_ON_WIRE = 4;

/** Server-tracked combat state, broadcast so everyone sees the same health. */
export interface PlayerVitals {
  id: string;
  health: number;
  hunger: number;
  dead: boolean;
}

/** Compact mob snapshot broadcast by the host. */
export interface MobStateData {
  /** Host-assigned mob id, unique within the room. */
  i: number;
  /** Mob kind: see MOB_KIND_* below. */
  k: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Current health, so guests can show hurt flashes and remove corpses. */
  hp: number;
  /**
   * 1 while the mob is mid-swing. Omitted the rest of the time, so the common
   * case costs nothing on a snapshot sent twenty times a second.
   */
  s?: 1;
  /**
   * A skeleton's bow draw, 0..1, present only while it is actually drawing.
   * Clients animate the pull from this, which is what lets a player see a shot
   * coming and take cover instead of being hit out of nowhere.
   */
  d?: number;
  /** Behaviour flags (MOB_FLAG_*), omitted when zero. */
  f?: number;
  /** Head yaw relative to the body while looking around; omitted when zero. */
  hy?: number;
}

/** Head down, eating grass. */
export const MOB_FLAG_GRAZING = 1;
/** A sheep with its wool off. */
export const MOB_FLAG_SHEARED = 2;
/** Just took damage: flash red on every screen. */
export const MOB_FLAG_HURT = 4;
/** Sheep colour, a small palette index shifted into the flags. */
export const MOB_FLAG_COLOR_SHIFT = 4;
export const MOB_FLAG_COLOR_MASK = 0x7;

/** An arrow fired by a mob, in flight. */
export interface ArrowStateData {
  i: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export const MOB_KIND_ZOMBIE = 0;
export const MOB_KIND_PIG = 1;
export const MOB_KIND_SKELETON = 2;
export const MOB_KIND_COW = 3;
export const MOB_KIND_SHEEP = 4;
export const MOB_KIND_VILLAGER = 5;
/** Server world-snapshot rate; clients interpolate between these. */
export const MOB_SYNC_HZ = 10;
/** How often the server steps its authoritative simulation. */
export const SIM_HZ = 20;
export const MAX_DROPS_PER_MESSAGE = 80;
export const MAX_ARROWS_PER_MESSAGE = 40;

/** A dropped item lying in the world, owned by the server. */
export interface DropStateData {
  i: number;
  item: string;
  n: number;
  x: number;
  y: number;
  z: number;
}
/** One authoritative tick of everything the world owns but players don't. */
export interface WorldStateData {
  /** Day/night phase, 0..1. The server owns the clock. */
  time: number;
  mobs: MobStateData[];
  drops: DropStateData[];
  removedMobs: number[];
  removedDrops: number[];
  /** Arrows fired by mobs; player arrows are relayed separately. */
  arrows: ArrowStateData[];
  removedArrows: number[];
  /** Mobs that died this tick: where (for the sound) and which (for the topple). */
  mobDeaths: { i: number; k: number; x: number; y: number; z: number }[];
  /** Blocks the simulation changed on its own this tick (crops, lit furnaces). */
  blocks?: { x: number; y: number; z: number; id: number }[];
  /** Who is in bed and how many sleepers a night skip needs; omitted when nobody is. */
  sleep?: SleepStateData;
}

export interface SleepStateData {
  sleeping: string[];
  needed: number;
}

/** One inventory or container slot addressed on the wire. */
export interface SlotRef {
  kind: 'inv' | 'armor' | 'craft' | 'result' | 'container';
  index: number;
}

export interface WireStack {
  id: string;
  count: number;
  damage?: number;
}

/** Container kinds a client can have open. */
export type ContainerKind = 'chest' | 'furnace';

/** Everything the server knows about one player's inventory, sent after each change. */
export interface InventoryStateData {
  /** Sequence number of the last client action this state reflects. */
  ack: number;
  slots: (WireStack | null)[];
  armor: (WireStack | null)[];
  cursor: WireStack | null;
  craft: (WireStack | null)[];
  gridSize: 2 | 3;
  selected: number;
}

export interface ContainerStateData {
  x: number;
  y: number;
  z: number;
  kind: ContainerKind;
  slots: (WireStack | null)[];
  /** Furnace only: seconds of fuel left, the fuel item's full burn, and smelt progress 0..1. */
  burn?: number;
  burnMax?: number;
  progress?: number;
}

/** Where a returning player was when they last left, and how they were doing. */
export interface PlayerRestoreData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  hunger: number;
  spawn?: { x: number; y: number; z: number };
}

export interface WorldListEntry {
  id: string;
  name: string;
  host: string;
  players: number;
  maxPlayers: number;
  /** Open rooms can be joined by code; saved worlds wait for their host. */
  status: 'open' | 'saved';
  code?: string;
  /** Last played, as a Unix time in ms. */
  updated: number;
}

export const MAX_MOBS_PER_MESSAGE = 40;
/** Server-side sanity bound on a single damage packet. */
export const MAX_DAMAGE_PER_HIT = 40;
/** Melee/arrow hits are rejected beyond this range from the attacker. */
export const MAX_ATTACK_RANGE = 24;
/** Block edits and container use must happen within this far of the sender. */
export const MAX_INTERACT_RANGE = 9;
export const RATE_LIMIT_COMBAT_PER_SEC = 20;

export interface PlayerStateData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  /** Held item id, so other players see what is in your hand; absent when empty. */
  h?: string;
}

export type JoinErrorReason =
  | 'room_full'
  | 'room_not_found'
  | 'bad_version'
  | 'invalid'
  | 'world_not_found'
  | 'not_owner';

/** One chunk's edits: the chunk key plus flat [voxelIndex, blockId] pairs. */
export interface ChunkEditEntry {
  key: string;
  /** Flat pairs — half the JSON of an array of objects. */
  data: number[];
}

/** How a slot was clicked: 0 left (take/put all), 1 right (half/one). */
export type ClickButton = 0 | 1;

// --- Client -> server ---
export type ClientMessage =
  | {
      t: 'create_room';
      name: string;
      version: number;
      /** Stable per-browser key so the same person gets their inventory back. */
      key: string;
      /** Reopen this saved world (must belong to `key`) instead of making a new one. */
      worldId?: string;
      worldName?: string;
    }
  | { t: 'join_room'; code: string; name: string; version: number; key: string }
  | { t: 'leave_room' }
  | { t: 'list_worlds'; key: string }
  | { t: 'player_state'; s: PlayerStateData }
  | { t: 'block_break'; x: number; y: number; z: number }
  | { t: 'block_place'; x: number; y: number; z: number; id: number }
  | { t: 'chunk_edits_request'; keys: string[] }
  | { t: 'ping'; time: number }
  // Combat. `ranged` marks an arrow hit, so the server knows to use the
  // arrow's knockback rather than whatever is in the attacker's hand now.
  | { t: 'attack_player'; target: string; damage: number; ranged?: boolean }
  | { t: 'player_vitals'; health: number; hunger: number; dead: boolean }
  | { t: 'respawn' }
  // Server-authoritative world
  | { t: 'attack_mob'; mob: number; damage: number; ranged?: boolean }
  /** Use the held item on a mob: shears on a sheep. */
  | { t: 'use_on_mob'; mob: number }
  /** Throw the held stack (or one of it) into the world. */
  | { t: 'drop_item'; seq: number; all: boolean }
  | {
      t: 'arrow_spawn';
      x: number; y: number; z: number;
      dx: number; dy: number; dz: number;
      speed: number;
    }
  // Server-authoritative inventory. Every action carries a client sequence
  // number; the server's inventory reply echoes the last one it applied.
  | { t: 'select_slot'; index: number }
  | { t: 'inv_click'; seq: number; slot: SlotRef; button: ClickButton; shift: boolean }
  | { t: 'inv_craft'; seq: number; all: boolean }
  | { t: 'inv_close'; seq: number }
  | { t: 'open_container'; x: number; y: number; z: number }
  /** A 3x3 grid needs a crafting table in reach; its position is given. */
  | { t: 'open_grid'; size: 2 | 3; x?: number; y?: number; z?: number }
  /** Turn dirt or grass into farmland with the held hoe. */
  | { t: 'till'; x: number; y: number; z: number }
  | { t: 'eat'; seq: number }
  | { t: 'sleep'; x: number; y: number; z: number }
  | { t: 'wake' };

// --- Server -> client ---
export type ServerMessage =
  | {
      t: 'room_created';
      code: string;
      self: PlayerInfo;
      world: WorldInfo;
      players: PlayerInfo[];
      /** Present when this key has played this world before. */
      restore?: PlayerRestoreData;
    }
  | {
      t: 'join_success';
      code: string;
      self: PlayerInfo;
      world: WorldInfo;
      players: PlayerInfo[];
      restore?: PlayerRestoreData;
    }
  | { t: 'join_error'; reason: JoinErrorReason; message: string }
  | { t: 'world_list'; worlds: WorldListEntry[] }
  | { t: 'player_joined'; player: PlayerInfo; players: PlayerInfo[] }
  | { t: 'player_left'; id: string; players: PlayerInfo[] }
  /** The host left and another player now holds the room. */
  | { t: 'host_changed'; id: string; players: PlayerInfo[] }
  | { t: 'player_state'; id: string; s: PlayerStateData }
  | { t: 'world_info'; world: WorldInfo }
  | { t: 'block_update'; x: number; y: number; z: number; id: number; by: string }
  | { t: 'chunk_edits'; entries: ChunkEditEntry[]; done: boolean }
  | { t: 'room_closed'; reason: 'host_left' | 'server_shutdown'; message: string }
  | { t: 'pong'; time: number }
  | { t: 'error'; message: string }
  // Combat
  | { t: 'player_hurt'; id: string; damage: number; by: string; health: number; dead: boolean }
  | { t: 'player_equipment'; id: string; gear: number[] }
  | { t: 'player_vitals'; vitals: PlayerVitals[] }
  | { t: 'player_respawned'; id: string }
  /**
   * Something hit you: shove the local player away from it. `strength` is the
   * weapon's knockback, so a diamond axe moves you further than a fist.
   */
  | { t: 'knockback'; fromX: number; fromZ: number; strength: number }
  // Server-authoritative world: one snapshot carries time, mobs and drops.
  | ({ t: 'world_state' } & WorldStateData)
  | {
      t: 'arrow_spawn';
      by: string;
      x: number; y: number; z: number;
      dx: number; dy: number; dz: number;
      speed: number;
      /** Server receive time, so receivers can fast-forward out the latency. */
      sentAt: number;
    }
  // Server-authoritative inventory and containers.
  | ({ t: 'inventory' } & InventoryStateData)
  | ({ t: 'container' } & ContainerStateData)
  /** The container you had open is gone (broken, or too far away now). */
  | { t: 'container_closed' }
  /** Your health/hunger as the server sees them, after eating or sleeping. */
  | { t: 'vitals_set'; health: number; hunger: number }
  /** You got into (or out of) bed; the client shows the dark overlay. */
  | { t: 'sleep_result'; sleeping: boolean; message?: string };

export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse untrusted input. Returns null for anything that isn't a tagged object. */
export function decodeMessage(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return typeof obj.t === 'string' ? obj : null;
}

// --- Validation helpers (used by the server on every inbound message) ---

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True when the coordinates address a real, editable voxel. */
export function isValidBlockCoord(x: unknown, y: unknown, z: unknown): boolean {
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return false;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
  if (y < 0 || y >= WORLD_HEIGHT_LIMIT) return false;
  return Math.abs(x) <= MAX_HORIZONTAL_COORD && Math.abs(z) <= MAX_HORIZONTAL_COORD;
}

export function isValidBlockId(id: unknown): id is number {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) <= MAX_BLOCK_ID;
}

/** Player state must be finite and in-world; angles are wrapped, not rejected. */
export function sanitizePlayerState(raw: unknown): PlayerStateData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y) || !isFiniteNumber(s.z)) return null;
  if (!isFiniteNumber(s.yaw) || !isFiniteNumber(s.pitch)) return null;
  if (Math.abs(s.x) > MAX_HORIZONTAL_COORD || Math.abs(s.z) > MAX_HORIZONTAL_COORD) return null;
  if (s.y < -64 || s.y > WORLD_HEIGHT_LIMIT + 64) return null;
  const flags = isFiniteNumber(s.flags) ? Math.floor(s.flags) & FLAG_MASK : 0;
  const out: PlayerStateData = {
    x: s.x,
    y: s.y,
    z: s.z,
    yaw: wrapAngle(s.yaw),
    pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, s.pitch)),
    flags,
  };
  if (isItemId(s.h)) out.h = s.h;
  return out;
}

/** Item ids are short registry keys; the receiver still checks the registry. */
export function isItemId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ITEM_ID_MAX_LENGTH;
}

export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

/**
 * Strip a display name to printable characters and clamp its length.
 * Returns DEFAULT_NAME when nothing usable survives.
 */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const cleaned = raw
    // Drop control characters, then keep only letters, digits, underscore,
    // space, hyphen and dot: no markup and no zero-width tricks survive.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^\w \-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : DEFAULT_NAME;
}

export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Armour tiers arrive as four small ints; anything else is discarded. */
export function sanitizeEquipment(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== ARMOR_SLOTS_ON_WIRE) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3) return null;
    out.push(v as number);
  }
  return out;
}

const SLOT_KINDS: SlotRef['kind'][] = ['inv', 'armor', 'craft', 'result', 'container'];
/** Largest slot index on any container (a chest has 27). */
export const MAX_SLOT_INDEX = 63;

/** A slot reference is a known kind plus a small non-negative index. */
export function sanitizeSlotRef(raw: unknown): SlotRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!SLOT_KINDS.includes(s.kind as SlotRef['kind'])) return null;
  if (!Number.isInteger(s.index) || (s.index as number) < 0 || (s.index as number) > MAX_SLOT_INDEX) {
    return null;
  }
  return { kind: s.kind as SlotRef['kind'], index: s.index as number };
}

/** Client sequence numbers are small non-negative integers. */
export function sanitizeSeq(raw: unknown): number | null {
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) < 2 ** 31
    ? (raw as number)
    : null;
}

export function sanitizePlayerKey(raw: unknown): string | null {
  return typeof raw === 'string' && PLAYER_KEY_PATTERN.test(raw) ? raw : null;
}

export function sanitizeWorldId(raw: unknown): string | null {
  return typeof raw === 'string' && WORLD_ID_PATTERN.test(raw) ? raw : null;
}

/** World names get the display-name scrub, with a longer cap and a different default. */
export function sanitizeWorldName(raw: unknown, fallback = 'New World'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[^\w \-.']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WORLD_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Damage values are clamped, never trusted verbatim. */
export function sanitizeDamage(raw: unknown): number | null {
  if (!isFiniteNumber(raw) || raw <= 0) return null;
  return Math.min(MAX_DAMAGE_PER_HIT, raw);
}

/** Chunk keys are "cx,cz" — validated so they can safely index server maps. */
export function isValidChunkKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 32) return false;
  return /^-?\d{1,9},-?\d{1,9}$/.test(key);
}
