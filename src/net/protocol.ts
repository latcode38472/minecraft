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
export const PING_INTERVAL_MS = 2000;
/** Server drops a connection that has not been heard from in this long. */
export const CLIENT_TIMEOUT_MS = 30_000;

/** Movement flags packed into one integer so state packets stay small. */
export const FLAG_MOVING = 1;
export const FLAG_JUMPING = 2;
export const FLAG_GROUNDED = 4;
export const FLAG_SNEAKING = 8;

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
}

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
  | { t: 'ping'; time: number };

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
  | { t: 'error'; message: string };

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
  const flags = isFiniteNumber(s.flags) ? Math.floor(s.flags) & 0xf : 0;
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

/** Chunk keys are "cx,cz" — validated so they can safely index server maps. */
export function isValidChunkKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 32) return false;
  return /^-?\d{1,9},-?\d{1,9}$/.test(key);
}
