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

export const PROTOCOL_VERSION = 1;

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
export const MAX_BLOCK_ID = 19;
export const MAX_HORIZONTAL_COORD = 30_000_000;

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
/** Mask applied to inbound flags — widen this when adding a flag above. */
export const FLAG_MASK = 0x1f;

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
  /** Mob kind: 0 zombie, 1 pig. */
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
}

export const MOB_KIND_ZOMBIE = 0;
export const MOB_KIND_PIG = 1;
/** Server world-snapshot rate; clients interpolate between these. */
export const MOB_SYNC_HZ = 10;
/** How often the server steps its authoritative simulation. */
export const SIM_HZ = 20;
export const MAX_DROPS_PER_MESSAGE = 80;

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
  /** Where mobs died this tick, so clients can play the sound. */
  mobDeaths: { x: number; y: number; z: number }[];
}

export const MAX_MOBS_PER_MESSAGE = 40;
/** Server-side sanity bound on a single damage packet. */
export const MAX_DAMAGE_PER_HIT = 40;
/** Melee/arrow hits are rejected beyond this range from the attacker. */
export const MAX_ATTACK_RANGE = 24;
/**
 * A positioned drop (from a mined block) must land within this far of the
 * sender. Reach is 5 blocks; the slack absorbs a stale position report.
 */
export const MAX_DROP_RANGE = 9;
export const RATE_LIMIT_COMBAT_PER_SEC = 20;

export interface PlayerStateData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
}

export type JoinErrorReason = 'room_full' | 'room_not_found' | 'bad_version' | 'invalid';

/** One chunk's edits: the chunk key plus flat [voxelIndex, blockId] pairs. */
export interface ChunkEditEntry {
  key: string;
  /** Flat pairs — half the JSON of an array of objects. */
  data: number[];
}

// --- Client -> server ---
export type ClientMessage =
  | { t: 'create_room'; name: string; version: number }
  | { t: 'join_room'; code: string; name: string; version: number }
  | { t: 'leave_room' }
  | { t: 'player_state'; s: PlayerStateData }
  | { t: 'block_break'; x: number; y: number; z: number }
  | { t: 'block_place'; x: number; y: number; z: number; id: number }
  | { t: 'chunk_edits_request'; keys: string[] }
  | { t: 'ping'; time: number }
  // Combat
  | { t: 'attack_player'; target: string; damage: number }
  | { t: 'player_vitals'; health: number; hunger: number; dead: boolean }
  | { t: 'equipment'; gear: number[] }
  | { t: 'respawn' }
  // Server-authoritative world
  | { t: 'attack_mob'; mob: number; damage: number }
  /** Throw an item into the world (vanilla's Q), for handing items to others. */
  | { t: 'drop_item'; item: string; count: number; p?: [number, number, number] }
  | {
      t: 'arrow_spawn';
      x: number; y: number; z: number;
      dx: number; dy: number; dz: number;
      speed: number;
    };

// --- Server -> client ---
export type ServerMessage =
  | { t: 'room_created'; code: string; self: PlayerInfo; world: WorldInfo; players: PlayerInfo[] }
  | { t: 'join_success'; code: string; self: PlayerInfo; world: WorldInfo; players: PlayerInfo[] }
  | { t: 'join_error'; reason: JoinErrorReason; message: string }
  | { t: 'player_joined'; player: PlayerInfo; players: PlayerInfo[] }
  | { t: 'player_left'; id: string; players: PlayerInfo[] }
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
  | { t: 'loot_grant'; items: { id: string; count: number }[] }
  | { t: 'player_vitals'; vitals: PlayerVitals[] }
  | { t: 'player_respawned'; id: string }
  /** A mob hit you: shove the local player away from it. */
  | { t: 'knockback'; fromX: number; fromZ: number }
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
    };

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
  return {
    x: s.x,
    y: s.y,
    z: s.z,
    yaw: wrapAngle(s.yaw),
    pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, s.pitch)),
    flags,
  };
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

/**
 * A thrown item, or the drop from a block the sender just mined. The id is
 * checked against the registry by the receiver, and `p` — present only for
 * block drops — is range-checked against the sender's own position, so it can
 * never place items across the map.
 */
export function sanitizeDropRequest(
  raw: Record<string, unknown>,
): { item: string; count: number; p: [number, number, number] | null } | null {
  if (typeof raw.item !== 'string' || raw.item.length > 40) return null;
  if (!Number.isInteger(raw.count) || (raw.count as number) < 1 || (raw.count as number) > 64) {
    return null;
  }
  let p: [number, number, number] | null = null;
  if (raw.p !== undefined) {
    if (!Array.isArray(raw.p) || raw.p.length !== 3) return null;
    for (const v of raw.p) if (!Number.isFinite(v)) return null;
    p = [raw.p[0] as number, raw.p[1] as number, raw.p[2] as number];
  }
  return { item: raw.item, count: raw.count as number, p };
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
