// Authoritative multiplayer server for Voxelcraft.
//
// Run with:  npm run server        (node runs this .ts file directly)
//
// The server owns everything that matters: room membership, the world seed,
// the block edits, every player's inventory, the chests and furnaces, the mobs
// and dropped items, the clock and who is asleep. Clients predict their own
// inventory clicks for responsiveness and are corrected by the server's reply;
// they apply their own block edits immediately and the server relays them,
// reverting any it rejects.
//
// Worlds are saved to disk (see store.ts) and can be reopened by their host,
// with every player getting back the inventory and position they left with.
//
// It binds 0.0.0.0 by default so phones on the same Wi-Fi can connect.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BLOCKS, Block, isWater } from '../src/blocks.ts';
import { MAX_HEALTH, MAX_HUNGER, SAVE_INTERVAL_MS } from '../src/constants.ts';
import {
  clickSlot,
  closeHolding,
  craftFromGrid,
  createHolding,
  setGridSize,
  type ClickContext,
  type Holding,
} from '../src/items/containers.ts';
import { Inventory } from '../src/items/inventory.ts';
import { getItem } from '../src/items/items.ts';
import { arrowKnockback, attackKnockback, clampKnockback } from '../src/shared/combat.ts';
import { blockDrops, wearsTool } from '../src/shared/harvest.ts';
import { RoomSimulation, blockKey, type BlockEntity } from '../src/shared/roomsim.ts';
import { emptyWorldSave, type SavedPlayer, type WorldSave } from '../src/shared/save.ts';
import type { SimPlayer } from '../src/shared/mobsim.ts';
import { ServerWorld } from './world.ts';
import { WorldStore } from './store.ts';
import {
  CLIENT_TIMEOUT_MS,
  EDITS_PER_MESSAGE,
  MAX_CHUNK_REQUEST,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  RATE_LIMIT_EDITS_PER_SEC,
  MAX_ATTACK_RANGE,
  MAX_INTERACT_RANGE,
  MAX_ARROWS_PER_MESSAGE,
  MAX_DROPS_PER_MESSAGE,
  MAX_MOBS_PER_MESSAGE,
  SIM_HZ,
  MOB_SYNC_HZ,
  RATE_LIMIT_COMBAT_PER_SEC,
  RATE_LIMIT_OTHER_PER_SEC,
  RATE_LIMIT_STATE_PER_SEC,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  decodeMessage,
  encodeMessage,
  isFiniteNumber,
  isValidBlockCoord,
  isValidBlockId,
  isValidChunkKey,
  normalizeRoomCode,
  sanitizeDamage,
  sanitizeName,
  sanitizePlayerKey,
  sanitizePlayerState,
  sanitizeSeq,
  sanitizeSlotRef,
  sanitizeWorldId,
  sanitizeWorldName,
  type ChunkEditEntry,
  type InventoryStateData,
  type JoinErrorReason,
  type PlayerInfo,
  type PlayerRestoreData,
  type PlayerVitals,
  type ServerMessage,
  type WorldInfo,
  type WorldListEntry,
} from '../src/net/protocol.ts';

const PORT = Number(process.env.PORT ?? process.env.VOXEL_SERVER_PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = process.env.VOXEL_DATA_DIR ?? 'data/worlds';
/** Rooms with no players are kept in memory this long, then dropped (saved first). */
const EMPTY_ROOM_TTL_MS = 60_000;
/** How often a busy room is written to disk. */
const AUTOSAVE_MS = SAVE_INTERVAL_MS * 6;
const CHUNK_SIZE = 16;
/** Cap total stored edits per room so one client cannot exhaust server memory. */
const MAX_EDITS_PER_ROOM = 500_000;
/** Inventory clicks arrive in bursts; allow a generous rate. */
const RATE_LIMIT_INVENTORY_PER_SEC = 30;

interface RateBucket {
  tokens: number;
  last: number;
}

interface Client {
  id: string;
  socket: WebSocket;
  name: string;
  /** Stable per-browser key: what a player's saved data is filed under. */
  key: string;
  room: Room | null;
  isHost: boolean;
  colorIndex: number;
  lastSeen: number;
  /** Last position and look the client reported. */
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  spawn: { x: number; y: number; z: number } | null;
  /** Server-owned survival state — clients never set these directly. */
  health: number;
  hunger: number;
  dead: boolean;
  /** Server-owned inventory, crafting grid and cursor. */
  inventory: Inventory;
  holding: Holding;
  /** Block key of the chest or furnace this client has open, if any. */
  container: string | null;
  /** Last client action sequence number applied. */
  lastAck: number;
  /** Equipment tiers last broadcast, so gear only goes out when it changes. */
  lastEquipment: string;
  inventoryDirty: boolean;
  buckets: {
    state: RateBucket;
    edits: RateBucket;
    other: RateBucket;
    combat: RateBucket;
    inventory: RateBucket;
  };
}

interface Room {
  code: string;
  worldId: string;
  name: string;
  /** Player key of the world's owner, who can reopen it later. */
  hostKey: string;
  hostId: string;
  clients: Map<string, Client>;
  world: WorldInfo;
  serverWorld: ServerWorld;
  /** chunkKey -> (voxelIndex -> blockId). Mirrors the client's World.edits. */
  edits: Map<string, Map<number, number>>;
  editCount: number;
  emptySince: number | null;
  /** Authoritative mobs, drops, containers, crops and day/night for this room. */
  sim: RoomSimulation;
  lastSnapshotAt: number;
  lastSaveAt: number;
  /** Data of players who are not connected right now, by key. */
  offlinePlayers: Map<string, SavedPlayer>;
}

const rooms = new Map<string, Room>();
const store = new WorldStore(DATA_DIR);
let nextClientId = 1;

// --- Helpers ---

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function makeRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Astronomically unlikely; fail loudly rather than return a duplicate.
  throw new Error('Could not allocate a unique room code');
}

function makeWorldId(): string {
  return randomBytes(8).toString('hex');
}

function send(client: Client, msg: ServerMessage): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  client.socket.send(encodeMessage(msg));
}

function broadcast(room: Room, msg: ServerMessage, exceptId?: string): void {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) send(client, msg);
  }
}

function vitals(client: Client): PlayerVitals {
  return {
    id: client.id,
    health: client.health,
    hunger: client.hunger,
    dead: client.dead,
  };
}

function roomVitals(room: Room): PlayerVitals[] {
  return [...room.clients.values()].map(vitals);
}

function playerInfo(client: Client): PlayerInfo {
  return {
    id: client.id,
    name: client.name,
    isHost: client.isHost,
    colorIndex: client.colorIndex,
    equipment: client.inventory.equipmentTiers(),
  };
}

function roster(room: Room): PlayerInfo[] {
  return [...room.clients.values()].map(playerInfo);
}

function simPlayers(room: Room): SimPlayer[] {
  return [...room.clients.values()].map((c) => ({ id: c.id, position: c.pos, dead: c.dead }));
}

/** Lowest colour index not already taken in the room, so bodies stay distinct. */
function pickColorIndex(room: Room): number {
  const used = new Set([...room.clients.values()].map((c) => c.colorIndex));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

/** Token bucket: returns false when the caller is over its rate limit. */
function allow(bucket: RateBucket, perSecond: number): boolean {
  const now = Date.now();
  const elapsed = (now - bucket.last) / 1000;
  bucket.last = now;
  bucket.tokens = Math.min(perSecond, bucket.tokens + elapsed * perSecond);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function newBucket(perSecond: number): RateBucket {
  return { tokens: perSecond, last: Date.now() };
}

function chunkKeyFor(x: number, z: number): string {
  return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
}

/** Same flat index the client's Chunk.index uses: lx + lz*16 + y*256. */
function voxelIndexFor(x: number, y: number, z: number): number {
  const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
}

function recordEdit(room: Room, x: number, y: number, z: number, id: number): boolean {
  const key = chunkKeyFor(x, z);
  let chunk = room.edits.get(key);
  if (!chunk) {
    chunk = new Map();
    room.edits.set(key, chunk);
  }
  const index = voxelIndexFor(x, y, z);
  const isNew = !chunk.has(index);
  if (isNew && room.editCount >= MAX_EDITS_PER_ROOM) return false;
  chunk.set(index, id);
  if (isNew) room.editCount++;
  return true;
}

/** Pack a room's edits into messages of at most EDITS_PER_MESSAGE pairs. */
function sendEditsFor(client: Client, room: Room, keys: string[]): void {
  let batch: ChunkEditEntry[] = [];
  let pairs = 0;
  const flush = (done: boolean): void => {
    if (batch.length > 0 || done) {
      send(client, { t: 'chunk_edits', entries: batch, done });
      batch = [];
      pairs = 0;
    }
  };

  for (const key of keys) {
    const chunk = room.edits.get(key);
    if (!chunk || chunk.size === 0) continue;
    const data: number[] = [];
    for (const [index, id] of chunk) data.push(index, id);
    batch.push({ key, data });
    pairs += chunk.size;
    if (pairs >= EDITS_PER_MESSAGE) flush(false);
  }
  flush(true);
}

/**
 * How hard this client's hit shoves. Derived here, from the server's own copy
 * of what they are holding, so knockback cannot be forged; an arrow carries
 * its own strength because by the time it lands the bow may be put away.
 */
function hitKnockback(client: Client, ranged: boolean): number {
  return ranged ? arrowKnockback() : attackKnockback(client.inventory.selectedStack);
}

function withinReach(client: Client, x: number, y: number, z: number, range = MAX_INTERACT_RANGE): boolean {
  return Math.hypot(x + 0.5 - client.pos.x, y + 0.5 - (client.pos.y + 1), z + 0.5 - client.pos.z) <= range;
}

// --- Inventory authority ---

function inventoryState(client: Client): InventoryStateData {
  return {
    ack: client.lastAck,
    slots: client.inventory.serialize(),
    armor: client.inventory.serializeArmor(),
    cursor: client.holding.cursor ? { ...client.holding.cursor } : null,
    craft: client.holding.craft.map((s) => (s ? { ...s } : null)),
    gridSize: client.holding.gridSize,
    selected: client.inventory.selected,
  };
}

/** The container this client has open, or null when it is gone or out of reach. */
function openEntity(client: Client): BlockEntity | null {
  const room = client.room;
  if (!room || !client.container) return null;
  const entity = room.sim.containers.get(client.container);
  if (!entity || !withinReach(client, entity.x, entity.y, entity.z, MAX_INTERACT_RANGE + 2)) {
    closeContainer(client);
    return null;
  }
  return entity;
}

function clickContext(client: Client): ClickContext {
  const entity = openEntity(client);
  return {
    inventory: client.inventory,
    holding: client.holding,
    container: entity ? { kind: entity.kind, slots: entity.slots } : null,
  };
}

function closeContainer(client: Client): void {
  if (!client.container) return;
  client.container = null;
  send(client, { t: 'container_closed' });
}

/** Queue an inventory reply; sent once at the end of the message so bursts coalesce. */
function markInventory(client: Client): void {
  client.inventoryDirty = true;
}

function flushInventory(client: Client): void {
  if (!client.inventoryDirty) return;
  client.inventoryDirty = false;
  send(client, { t: 'inventory', ...inventoryState(client) });
  const room = client.room;
  if (!room) return;
  const gear = client.inventory.equipmentTiers();
  const key = gear.join(',');
  if (key !== client.lastEquipment) {
    client.lastEquipment = key;
    broadcast(room, { t: 'player_equipment', id: client.id, gear }, client.id);
  }
}

/** Send a container's contents to everyone looking at it. */
function syncContainer(room: Room, key: string): void {
  const entity = room.sim.containers.get(key);
  if (!entity) return;
  const state = room.sim.containerSnapshot(entity);
  for (const viewer of room.clients.values()) {
    if (viewer.container === key) send(viewer, { t: 'container', ...state });
  }
}

/** Throw a player's whole inventory on the ground where they died. */
function dropInventoryOnDeath(room: Room, client: Client): void {
  const at = client.pos;
  room.sim.scatterStacks(client.inventory.slots, at.x, at.y + 0.6, at.z);
  room.sim.scatterStacks(client.inventory.armor, at.x, at.y + 0.6, at.z);
  room.sim.scatterStacks([client.holding.cursor, ...client.holding.craft], at.x, at.y + 0.6, at.z);
  client.inventory.clear();
  client.holding = createHolding(2);
  closeContainer(client);
  room.sim.wake(client.id);
  markInventory(client);
}

function setDead(room: Room, client: Client): void {
  if (client.dead) return;
  client.dead = true;
  client.health = 0;
  dropInventoryOnDeath(room, client);
  flushInventory(client);
}

// --- Persistence ---

function savedPlayerFor(client: Client): SavedPlayer {
  return {
    key: client.key,
    name: client.name,
    x: client.pos.x,
    y: client.pos.y,
    z: client.pos.z,
    yaw: client.yaw,
    pitch: client.pitch,
    // A dead player comes back alive at spawn, never dead where they fell.
    health: client.dead ? MAX_HEALTH : client.health,
    hunger: client.dead ? MAX_HUNGER : client.hunger,
    selected: client.inventory.selected,
    inventory: client.inventory.serialize(),
    armor: client.inventory.serializeArmor(),
    ...(client.spawn ? { spawn: { ...client.spawn } } : {}),
  };
}

function buildSave(room: Room): WorldSave {
  const edits: Record<string, number[]> = {};
  for (const [key, chunk] of room.edits) {
    if (chunk.size === 0) continue;
    const pairs: number[] = [];
    for (const [index, id] of chunk) pairs.push(index, id);
    edits[key] = pairs;
  }
  const players: Record<string, SavedPlayer> = {};
  for (const [key, saved] of room.offlinePlayers) players[key] = saved;
  for (const client of room.clients.values()) players[client.key] = savedPlayerFor(client);
  return {
    ...emptyWorldSave(room.worldId, room.name, room.world.seed, room.hostKey),
    ...room.sim.serialize(),
    updated: Date.now(),
    edits,
    players,
  };
}

function saveRoom(room: Room): void {
  room.lastSaveAt = Date.now();
  store.save(buildSave(room)).catch((err) => log(`save failed for ${room.worldId}`, err));
}

function saveRoomSync(room: Room): void {
  try {
    store.saveSync(buildSave(room));
  } catch (err) {
    log(`save failed for ${room.worldId}`, err);
  }
}

// --- Rooms ---

function makeWorldInfo(seed: number, serverWorld: ServerWorld): WorldInfo {
  const spawn = serverWorld.terrain.findSpawnColumn();
  return { seed, spawn: { x: spawn.x, y: spawn.y, z: spawn.z }, generator: 'default' };
}

/** Build a live room from a save (or a fresh one when `save` is new). */
function openRoom(save: WorldSave): Room {
  const edits = new Map<string, Map<number, number>>();
  let editCount = 0;
  for (const [key, pairs] of Object.entries(save.edits)) {
    const chunk = new Map<number, number>();
    for (let i = 0; i + 1 < pairs.length; i += 2) chunk.set(pairs[i], pairs[i + 1]);
    edits.set(key, chunk);
    editCount += chunk.size;
  }
  const serverWorld = new ServerWorld(save.seed, edits);
  const room: Room = {
    code: makeRoomCode(),
    worldId: save.id,
    name: save.name,
    hostKey: save.host,
    hostId: '',
    clients: new Map(),
    world: makeWorldInfo(save.seed, serverWorld),
    serverWorld,
    edits,
    editCount,
    emptySince: Date.now(),
    sim: null as unknown as RoomSimulation,
    lastSnapshotAt: 0,
    lastSaveAt: Date.now(),
    offlinePlayers: new Map(Object.entries(save.players)),
  };
  // The simulation owns mobs, drops, containers and time for the life of the room.
  room.sim = new RoomSimulation(serverWorld, {
    damagePlayer: (playerId, amount, fromX, fromZ, knockback) => {
      const victim = room.clients.get(playerId);
      if (!victim || victim.dead) return;
      victim.health = Math.max(0, victim.health - amount);
      const died = victim.health <= 0;
      broadcast(room, {
        t: 'player_hurt',
        id: victim.id,
        damage: amount,
        by: 'mob',
        health: victim.health,
        dead: died,
      });
      send(victim, { t: 'knockback', fromX, fromZ, strength: clampKnockback(knockback) });
      if (room.sim.sleepers.has(victim.id)) {
        room.sim.wake(victim.id);
        send(victim, { t: 'sleep_result', sleeping: false, message: 'You were attacked in your sleep!' });
      }
      if (died) setDead(room, victim);
    },
    giveItems: (playerId, itemId, count, damage) => {
      const target = room.clients.get(playerId);
      if (!target || target.dead) return count;
      const leftover = target.inventory.add(itemId, count, damage);
      if (leftover < count) {
        markInventory(target);
        flushInventory(target);
      }
      return leftover;
    },
    onBlockChanged: (x, y, z, id) => {
      recordEdit(room, x, y, z, id);
      broadcast(room, { t: 'block_update', x, y, z, id, by: 'world' });
    },
    onWake: (playerId, reason) => {
      const client = room.clients.get(playerId);
      if (!client) return;
      const message =
        reason === 'morning' ? 'Good morning.' : reason === 'bed_gone' ? 'Your bed was broken.' : undefined;
      send(client, { t: 'sleep_result', sleeping: false, message });
    },
  });
  room.sim.restore(save);
  rooms.set(room.code, room);
  return room;
}

function roomForWorld(worldId: string): Room | undefined {
  for (const room of rooms.values()) if (room.worldId === worldId) return room;
  return undefined;
}

function restoreDataFor(saved: SavedPlayer): PlayerRestoreData {
  return {
    x: saved.x,
    y: saved.y,
    z: saved.z,
    yaw: saved.yaw,
    pitch: saved.pitch,
    health: saved.health,
    hunger: saved.hunger,
    ...(saved.spawn ? { spawn: saved.spawn } : {}),
  };
}

/** Put a client into a room, restoring their saved self if they have one. */
function enterRoom(client: Client, room: Room, name: string): PlayerRestoreData | undefined {
  // The same key already connected (a reconnect racing the old socket's
  // timeout): the old body leaves so the player is never in the room twice.
  for (const other of [...room.clients.values()]) {
    if (other.key === client.key && other.id !== client.id) {
      leaveRoom(other);
      other.socket.close(4001, 'replaced');
    }
  }

  client.name = name;
  client.colorIndex = pickColorIndex(room);
  client.room = room;
  client.inventory = new Inventory();
  client.holding = createHolding(2);
  client.container = null;
  client.lastAck = 0;
  client.dead = false;
  client.spawn = null;

  const saved = room.offlinePlayers.get(client.key);
  let restore: PlayerRestoreData | undefined;
  if (saved) {
    room.offlinePlayers.delete(client.key);
    client.inventory.load(saved.inventory, saved.selected, saved.armor);
    client.health = saved.health;
    client.hunger = saved.hunger;
    client.pos = { x: saved.x, y: saved.y, z: saved.z };
    client.yaw = saved.yaw;
    client.pitch = saved.pitch;
    client.spawn = saved.spawn ? { ...saved.spawn } : null;
    restore = restoreDataFor(saved);
  } else {
    client.health = MAX_HEALTH;
    client.hunger = MAX_HUNGER;
    client.pos = { x: room.world.spawn.x, y: room.world.spawn.y + 2, z: room.world.spawn.z };
  }
  client.lastEquipment = client.inventory.equipmentTiers().join(',');
  client.isHost = room.clients.size === 0 || client.key === room.hostKey;
  if (client.isHost) {
    // The owner takes the chair back; whoever was standing in is demoted.
    for (const other of room.clients.values()) other.isHost = false;
    room.hostId = client.id;
  }
  room.clients.set(client.id, client);
  room.emptySince = null;
  return restore;
}

function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  // Whatever was on the cursor or in the grid goes back in the bag first.
  closeHolding(clickContext(client));
  room.offlinePlayers.set(client.key, savedPlayerFor(client));
  room.clients.delete(client.id);
  room.sim.removePlayer(client.id);
  client.room = null;
  client.container = null;

  if (client.isHost) {
    client.isHost = false;
    const next = room.clients.values().next().value as Client | undefined;
    if (next) {
      // Host migration: the world goes on without its host.
      next.isHost = true;
      room.hostId = next.id;
      broadcast(room, { t: 'player_left', id: client.id, players: roster(room) });
      broadcast(room, { t: 'host_changed', id: next.id, players: roster(room) });
      log(`${client.name} left room ${room.code}; ${next.name} is now host`);
    }
  } else {
    broadcast(room, { t: 'player_left', id: client.id, players: roster(room) });
  }

  if (room.clients.size === 0) {
    room.emptySince = Date.now();
    saveRoom(room);
  }
  log(`${client.name} left room ${room.code} (${room.clients.size}/${MAX_PLAYERS})`);
}

function rejectJoin(client: Client, reason: JoinErrorReason, message: string): void {
  send(client, { t: 'join_error', reason, message });
}

/** Worlds this key owns or has played in: open rooms first, then saved ones. */
function worldListFor(key: string): WorldListEntry[] {
  const out: WorldListEntry[] = [];
  const seen = new Set<string>();
  for (const room of rooms.values()) {
    const played =
      room.hostKey === key ||
      room.offlinePlayers.has(key) ||
      [...room.clients.values()].some((c) => c.key === key);
    if (!played) continue;
    seen.add(room.worldId);
    out.push({
      id: room.worldId,
      name: room.name,
      host: room.hostKey === key ? 'You' : hostNameOf(room),
      players: room.clients.size,
      maxPlayers: MAX_PLAYERS,
      status: 'open',
      code: room.code,
      updated: Date.now(),
    });
  }
  for (const summary of store.list()) {
    if (seen.has(summary.id)) continue;
    if (summary.host !== key && !summary.playerKeys.includes(key)) continue;
    out.push({
      id: summary.id,
      name: summary.name,
      host: summary.host === key ? 'You' : 'A friend',
      players: 0,
      maxPlayers: MAX_PLAYERS,
      status: 'saved',
      updated: summary.updated,
    });
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, 50);
}

function hostNameOf(room: Room): string {
  const host = room.clients.get(room.hostId);
  if (host) return host.name;
  return room.offlinePlayers.get(room.hostKey)?.name ?? 'Host';
}

// --- Message handling ---

function handleMessage(client: Client, raw: string): void {
  client.lastSeen = Date.now();
  const msg = decodeMessage(raw);
  if (!msg) return; // malformed or oversized: ignore silently

  switch (msg.t) {
    case 'ping': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const time = typeof msg.time === 'number' ? msg.time : 0;
      send(client, { t: 'pong', time });
      return;
    }

    case 'list_worlds': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const key = sanitizePlayerKey(msg.key);
      if (!key) return;
      send(client, { t: 'world_list', worlds: worldListFor(key) });
      return;
    }

    case 'create_room': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      if (msg.version !== PROTOCOL_VERSION) {
        rejectJoin(client, 'bad_version', 'This game version is out of date.');
        return;
      }
      const key = sanitizePlayerKey(msg.key);
      if (!key) {
        rejectJoin(client, 'invalid', 'This game version is out of date.');
        return;
      }
      client.key = key;
      // One room per connection: a client cannot spawn rooms in a loop.
      if (client.room) leaveRoom(client);

      const worldId = msg.worldId === undefined ? null : sanitizeWorldId(msg.worldId);
      if (msg.worldId !== undefined && worldId === null) {
        rejectJoin(client, 'invalid', 'That world id is not valid.');
        return;
      }
      if (worldId) {
        openSavedWorld(client, worldId, sanitizeName(msg.name));
        return;
      }

      const save = emptyWorldSave(
        makeWorldId(),
        sanitizeWorldName(msg.worldName),
        Math.floor(Math.random() * 0xffffffff) >>> 0,
        key,
      );
      const room = openRoom(save);
      const restore = enterRoom(client, room, sanitizeName(msg.name));
      send(client, {
        t: 'room_created',
        code: room.code,
        self: playerInfo(client),
        world: room.world,
        players: roster(room),
        ...(restore ? { restore } : {}),
      });
      log(`${client.name} created world "${room.name}" ${room.worldId} as room ${room.code} (seed ${room.world.seed})`);
      saveRoom(room);
      return;
    }

    case 'join_room': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      if (msg.version !== PROTOCOL_VERSION) {
        rejectJoin(client, 'bad_version', 'This game version is out of date.');
        return;
      }
      const key = sanitizePlayerKey(msg.key);
      if (!key) {
        rejectJoin(client, 'invalid', 'This game version is out of date.');
        return;
      }
      client.key = key;
      const code = normalizeRoomCode(msg.code);
      if (!code) {
        rejectJoin(client, 'invalid', 'That room code is not valid.');
        return;
      }
      const room = rooms.get(code);
      if (!room) {
        rejectJoin(client, 'room_not_found', 'Room not found.');
        return;
      }
      if (client.room) leaveRoom(client);
      joinExisting(client, room, sanitizeName(msg.name));
      return;
    }

    case 'leave_room': {
      leaveRoom(client);
      return;
    }

    case 'player_state': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.state, RATE_LIMIT_STATE_PER_SEC)) return;
      const state = sanitizePlayerState(msg.s);
      if (!state) return;
      // Remember where they claim to be, so reach can be checked.
      client.pos.x = state.x;
      client.pos.y = state.y;
      client.pos.z = state.z;
      client.yaw = state.yaw;
      client.pitch = state.pitch;
      // What is in the hand is the server's call, not the packet's.
      const held = client.inventory.selectedStack;
      if (held) state.h = held.id;
      else delete state.h;
      broadcast(room, { t: 'player_state', id: client.id, s: state }, client.id);
      return;
    }

    case 'block_break': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.edits, RATE_LIMIT_EDITS_PER_SEC)) return;
      const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
      if (!isValidBlockCoord(x, y, z)) return;
      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      const current = room.serverWorld.getBlock(bx, by, bz);
      const def = BLOCKS[current];
      if (!withinReach(client, bx, by, bz) || current === Block.Air || !def.breakable) {
        // Put the block back on the sender's screen.
        send(client, { t: 'block_update', x: bx, y: by, z: bz, id: current, by: 'world' });
        return;
      }
      if (!recordEdit(room, bx, by, bz, Block.Air)) {
        send(client, { t: 'block_update', x: bx, y: by, z: bz, id: current, by: 'world' });
        send(client, { t: 'error', message: 'This world has too many changes.' });
        return;
      }
      const held = client.inventory.selectedStack;
      room.serverWorld.applyEdit(bx, by, bz, Block.Air);
      broadcast(room, { t: 'block_update', x: bx, y: by, z: bz, id: Block.Air, by: client.id }, client.id);
      room.sim.blockRemoved(bx, by, bz);
      // The drop is decided here, from the server's own copy of the hand, and
      // lands in the world where the block was: whoever walks over it gets it.
      for (const roll of blockDrops(def, held)) {
        room.sim.spawnDrop(roll.id, roll.count, bx + 0.5, by + 0.5, bz + 0.5);
      }
      if (wearsTool(def, held)) {
        client.inventory.damageSelected();
        markInventory(client);
        flushInventory(client);
      }
      return;
    }

    case 'block_place': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.edits, RATE_LIMIT_EDITS_PER_SEC)) return;
      const { x, y, z, id } = msg as { x: unknown; y: unknown; z: unknown; id: unknown };
      if (!isValidBlockCoord(x, y, z) || !isValidBlockId(id) || id === Block.Air) return;
      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      const current = room.serverWorld.getBlock(bx, by, bz);
      const revert = (): void =>
        send(client, { t: 'block_update', x: bx, y: by, z: bz, id: current, by: 'world' });
      const held = client.inventory.selectedStack;
      const heldDef = held ? getItem(held.id) : undefined;
      // You place what you hold: a block item, or seeds onto farmland.
      const placesBlock = heldDef?.block === id;
      const plants = heldDef?.plants === id;
      const below = room.serverWorld.getBlock(bx, by - 1, bz);
      const torch = id === Block.Torch;
      if (
        !heldDef ||
        (!placesBlock && !plants) ||
        !withinReach(client, bx, by, bz) ||
        (current !== Block.Air && !isWater(current)) ||
        (plants && below !== Block.Farmland) ||
        // A torch needs a full block under it, and will not stand in water.
        (torch && (isWater(current) || !BLOCKS[below].solid || BLOCKS[below].shape !== 'cube'))
      ) {
        revert();
        return;
      }
      if (!recordEdit(room, bx, by, bz, id)) {
        revert();
        send(client, { t: 'error', message: 'This world has too many changes.' });
        return;
      }
      room.serverWorld.applyEdit(bx, by, bz, id);
      room.sim.blockPlaced(bx, by, bz, id);
      client.inventory.consumeSelected();
      markInventory(client);
      flushInventory(client);
      broadcast(room, { t: 'block_update', x: bx, y: by, z: bz, id, by: client.id }, client.id);
      return;
    }

    case 'till': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.edits, RATE_LIMIT_EDITS_PER_SEC)) return;
      const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
      if (!isValidBlockCoord(x, y, z)) return;
      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      const current = room.serverWorld.getBlock(bx, by, bz);
      const held = client.inventory.selectedStack;
      const tool = held ? getItem(held.id)?.tool : undefined;
      const revert = (): void =>
        send(client, { t: 'block_update', x: bx, y: by, z: bz, id: current, by: 'world' });
      if (
        tool?.kind !== 'hoe' ||
        !withinReach(client, bx, by, bz) ||
        (current !== Block.Dirt && current !== Block.Grass) ||
        room.serverWorld.getBlock(bx, by + 1, bz) !== Block.Air
      ) {
        revert();
        return;
      }
      if (!recordEdit(room, bx, by, bz, Block.Farmland)) {
        revert();
        return;
      }
      room.serverWorld.applyEdit(bx, by, bz, Block.Farmland);
      client.inventory.damageSelected();
      markInventory(client);
      flushInventory(client);
      broadcast(room, { t: 'block_update', x: bx, y: by, z: bz, id: Block.Farmland, by: client.id }, client.id);
      return;
    }

    case 'attack_player': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      const targetId = typeof msg.target === 'string' ? msg.target : '';
      const victim = room.clients.get(targetId);
      const damage = sanitizeDamage(msg.damage);
      if (!victim || victim.id === client.id || victim.dead || damage === null) return;

      // Server-side reach check: the attacker cannot hit from across the map.
      const dist = Math.hypot(
        victim.pos.x - client.pos.x,
        victim.pos.y - client.pos.y,
        victim.pos.z - client.pos.z,
      );
      if (dist > MAX_ATTACK_RANGE) return;

      victim.health = Math.max(0, victim.health - damage);
      const died = victim.health <= 0;
      broadcast(room, {
        t: 'player_hurt',
        id: victim.id,
        damage,
        by: client.id,
        health: victim.health,
        dead: died,
      });
      // The shove comes from the server's own copy of the attacker's hand, so
      // a modified client cannot send itself a launcher.
      send(victim, {
        t: 'knockback',
        fromX: client.pos.x,
        fromZ: client.pos.z,
        strength: hitKnockback(client, msg.ranged === true),
      });
      if (died) setDead(room, victim);
      return;
    }

    case 'player_vitals': {
      // A client reports damage it took locally (falls, starvation, drowning).
      // The server records it so everyone agrees, but clamps the values.
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      if (!isFiniteNumber(msg.health)) return;
      if (client.dead) return; // only a respawn brings a player back
      client.health = Math.max(0, Math.min(MAX_HEALTH, msg.health));
      if (isFiniteNumber(msg.hunger)) {
        client.hunger = Math.max(0, Math.min(MAX_HUNGER, msg.hunger));
      }
      if (client.health <= 0 || msg.dead === true) setDead(room, client);
      broadcast(room, { t: 'player_vitals', vitals: roomVitals(room) });
      return;
    }

    case 'respawn': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      client.health = MAX_HEALTH;
      client.hunger = MAX_HUNGER;
      client.dead = false;
      broadcast(room, { t: 'player_respawned', id: client.id });
      broadcast(room, { t: 'player_vitals', vitals: roomVitals(room) });
      return;
    }

    case 'attack_mob': {
      // A player swung at a mob; the server owns mob health and arbitrates.
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      const damage = sanitizeDamage(msg.damage);
      if (damage === null || !Number.isInteger(msg.mob)) return;
      const mob = room.sim.mobs.get(msg.mob as number);
      if (!mob) return;
      // Reach check against the attacker's last reported position.
      const dist = Math.hypot(
        mob.position.x - client.pos.x,
        mob.position.y - client.pos.y,
        mob.position.z - client.pos.z,
      );
      if (dist > MAX_ATTACK_RANGE) return;
      room.sim.damageMob(
        msg.mob as number,
        damage,
        client.id,
        client.pos,
        hitKnockback(client, msg.ranged === true),
      );
      return;
    }

    case 'use_on_mob': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      if (!Number.isInteger(msg.mob)) return;
      const mob = room.sim.mobs.get(msg.mob as number);
      const held = client.inventory.selectedStack;
      if (!mob || !held || getItem(held.id)?.tool?.kind !== 'shears') return;
      if (
        Math.hypot(mob.position.x - client.pos.x, mob.position.y - client.pos.y, mob.position.z - client.pos.z) >
        MAX_INTERACT_RANGE
      ) {
        return;
      }
      if (room.sim.shearMob(mob.id, client.id)) {
        client.inventory.damageSelected();
        markInventory(client);
        flushInventory(client);
      }
      return;
    }

    case 'drop_item': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      const seq = sanitizeSeq(msg.seq);
      if (seq === null) return;
      client.lastAck = seq;
      const stack = client.inventory.selectedStack;
      if (stack) {
        const count = msg.all === true ? stack.count : 1;
        const damage = stack.damage;
        stack.count -= count;
        if (stack.count <= 0) client.inventory.slots[client.inventory.selected] = null;
        client.inventory.version++;
        room.sim.spawnDrop(stack.id, count, client.pos.x, client.pos.y + 1.2, client.pos.z, client.id, damage);
      }
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'select_slot': {
      if (!client.room) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      if (!Number.isInteger(msg.index)) return;
      client.inventory.selectSlot(msg.index as number);
      return;
    }

    case 'inv_click': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      const seq = sanitizeSeq(msg.seq);
      const slot = sanitizeSlotRef(msg.slot);
      if (seq === null || !slot) return;
      client.lastAck = seq;
      const ctx = clickContext(client);
      const button = msg.button === 1 ? 1 : 0;
      if (clickSlot(ctx, slot, button, msg.shift === true) && slot.kind === 'container' && client.container) {
        room.sim.dirtyContainers.add(client.container);
      }
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'inv_craft': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      const seq = sanitizeSeq(msg.seq);
      if (seq === null) return;
      client.lastAck = seq;
      craftFromGrid(clickContext(client), msg.all === true);
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'inv_close': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      const seq = sanitizeSeq(msg.seq);
      if (seq === null) return;
      client.lastAck = seq;
      const ctx = clickContext(client);
      const overflow = [...closeHolding(ctx), ...setGridSize(ctx, 2)];
      room.sim.scatterStacks(overflow, client.pos.x, client.pos.y + 1, client.pos.z);
      client.container = null;
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'open_container': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
      if (!isValidBlockCoord(x, y, z)) return;
      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      if (!withinReach(client, bx, by, bz)) return;
      const entity = room.sim.openContainer(bx, by, bz);
      if (!entity) return;
      const ctx = clickContext(client);
      room.sim.scatterStacks(setGridSize(ctx, 2), client.pos.x, client.pos.y + 1, client.pos.z);
      client.container = blockKey(bx, by, bz);
      send(client, { t: 'container', ...room.sim.containerSnapshot(entity) });
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'open_grid': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const size = msg.size === 3 ? 3 : 2;
      if (size === 3) {
        // A big grid needs a real crafting table within reach.
        const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
        if (!isValidBlockCoord(x, y, z)) return;
        const bx = x as number;
        const by = y as number;
        const bz = z as number;
        if (!withinReach(client, bx, by, bz) || room.serverWorld.getBlock(bx, by, bz) !== Block.CraftingTable) return;
      }
      closeContainer(client);
      const ctx = clickContext(client);
      room.sim.scatterStacks(setGridSize(ctx, size), client.pos.x, client.pos.y + 1, client.pos.z);
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'eat': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.inventory, RATE_LIMIT_INVENTORY_PER_SEC)) return;
      const seq = sanitizeSeq(msg.seq);
      if (seq === null) return;
      client.lastAck = seq;
      const stack = client.inventory.selectedStack;
      const food = stack ? getItem(stack.id)?.food : undefined;
      if (food && client.hunger < MAX_HUNGER) {
        client.hunger = Math.min(MAX_HUNGER, client.hunger + food.hunger);
        client.inventory.consumeSelected();
        send(client, { t: 'vitals_set', health: client.health, hunger: client.hunger });
        broadcast(room, { t: 'player_vitals', vitals: roomVitals(room) });
      }
      markInventory(client);
      flushInventory(client);
      return;
    }

    case 'sleep': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
      if (!isValidBlockCoord(x, y, z)) return;
      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      if (!withinReach(client, bx, by, bz)) return;
      // Sleeping also sets the respawn point, so a bed is home.
      const result = room.sim.trySleep(client.id, bx, by, bz, simPlayers(room));
      if (result.ok) client.spawn = { x: bx + 0.5, y: by + 1, z: bz + 0.5 };
      send(client, { t: 'sleep_result', sleeping: result.ok, message: result.message });
      return;
    }

    case 'wake': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      room.sim.wake(client.id);
      send(client, { t: 'sleep_result', sleeping: false });
      return;
    }

    case 'arrow_spawn': {
      const room = client.room;
      if (!room || client.dead) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      const { x, y, z, dx, dy, dz, speed } = msg as Record<string, unknown>;
      if (![x, y, z, dx, dy, dz, speed].every(isFiniteNumber)) return;
      broadcast(
        room,
        {
          t: 'arrow_spawn',
          by: client.id,
          x: x as number, y: y as number, z: z as number,
          dx: dx as number, dy: dy as number, dz: dz as number,
          speed: Math.max(1, Math.min(80, speed as number)),
          sentAt: Date.now(),
        },
        client.id,
      );
      return;
    }

    case 'chunk_edits_request': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const keys = msg.keys;
      if (!Array.isArray(keys)) return;
      const valid = keys.filter(isValidChunkKey).slice(0, MAX_CHUNK_REQUEST);
      sendEditsFor(client, room, valid);
      return;
    }

    default:
      return; // unknown type: ignore
  }
}

/** Join a room that is already loaded. */
function joinExisting(client: Client, room: Room, name: string): void {
  // The cap is enforced here, on the server, so a crafted packet cannot
  // squeeze a fourth player in. A returning key replaces its old body first.
  const returning = [...room.clients.values()].some((c) => c.key === client.key);
  if (!returning && room.clients.size >= MAX_PLAYERS) {
    rejectJoin(client, 'room_full', `This world already has ${MAX_PLAYERS} players.`);
    return;
  }
  const restore = enterRoom(client, room, name);
  send(client, {
    t: 'join_success',
    code: room.code,
    self: playerInfo(client),
    world: room.world,
    players: roster(room),
    ...(restore ? { restore } : {}),
  });
  // Ship the world's existing edits so late joiners see earlier changes.
  sendEditsFor(client, room, [...room.edits.keys()]);
  send(client, { t: 'inventory', ...inventoryState(client) });
  send(client, { t: 'player_vitals', vitals: roomVitals(room) });
  broadcast(room, { t: 'player_joined', player: playerInfo(client), players: roster(room) }, client.id);
  if (client.isHost && room.clients.size > 1) {
    broadcast(room, { t: 'host_changed', id: client.id, players: roster(room) }, client.id);
  }
  log(`${client.name} joined room ${room.code} (${room.clients.size}/${MAX_PLAYERS})`);
}

/** Reopen a saved world by id: only its owner may, and it may already be open. */
function openSavedWorld(client: Client, worldId: string, name: string): void {
  const live = roomForWorld(worldId);
  if (live) {
    if (live.hostKey !== client.key && !live.offlinePlayers.has(client.key)) {
      rejectJoin(client, 'not_owner', 'That world belongs to someone else.');
      return;
    }
    joinExisting(client, live, name);
    return;
  }
  const summary = store.get(worldId);
  if (!summary) {
    rejectJoin(client, 'world_not_found', 'That world is not on this server any more.');
    return;
  }
  if (summary.host !== client.key) {
    rejectJoin(client, 'not_owner', 'Only the world’s owner can open it.');
    return;
  }
  store
    .load(worldId)
    .then((save) => {
      if (client.socket.readyState !== WebSocket.OPEN) return;
      if (!save) {
        rejectJoin(client, 'world_not_found', 'That world could not be read.');
        return;
      }
      // Someone may have opened it while the file was loading.
      const raced = roomForWorld(worldId);
      const room = raced ?? openRoom(save);
      if (client.room) leaveRoom(client);
      const restore = enterRoom(client, room, name);
      send(client, {
        t: 'room_created',
        code: room.code,
        self: playerInfo(client),
        world: room.world,
        players: roster(room),
        ...(restore ? { restore } : {}),
      });
      sendEditsFor(client, room, [...room.edits.keys()]);
      send(client, { t: 'inventory', ...inventoryState(client) });
      log(`${client.name} reopened world "${room.name}" ${room.worldId} as room ${room.code}`);
    })
    .catch((err) => {
      log('failed to open world', err);
      rejectJoin(client, 'world_not_found', 'That world could not be read.');
    });
}

// --- Wiring ---

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // A tiny health endpoint doubles as a "is the server up?" check from a phone.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
        worlds: store.list().length,
        protocol: PROTOCOL_VERSION,
      }),
    );
    return;
  }
  // Opening the server's own address in a browser is a natural thing to try,
  // and a bare 404 makes a perfectly healthy server look broken. Say what this
  // is, where the game is, and whether the server is currently up.
  if (req.url === '/' || req.url === '') {
    const players = [...rooms.values()].reduce((n, r) => n + r.clients.size, 0);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voxelcraft server</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#1c2126; color:#e8e8e8;
         font:16px/1.6 ui-monospace,"Courier New",monospace; padding:24px; }
  main { max-width:34rem }
  h1 { font-size:1.4rem; margin:0 0 .25rem; letter-spacing:2px }
  .ok { color:#7ddc7d }
  .muted { color:#98a2ac }
  a { color:#8ec7ff }
  code { background:#272e35; padding:2px 6px; border-radius:4px }
</style>
<main>
  <h1>VOXELCRAFT</h1>
  <p class="ok">&#9679; Multiplayer server is running.</p>
  <p class="muted">
    ${rooms.size} room${rooms.size === 1 ? '' : 's'},
    ${players} player${players === 1 ? '' : 's'} online,
    ${store.list().length} saved world${store.list().length === 1 ? '' : 's'}.
  </p>
  <p>
    This address is the <em>server</em> — there is no game to play here. It is
    the value you give the game client as its server, over
    <code>wss://</code>.
  </p>
  <p class="muted">
    Machine-readable status: <a href="/health">/health</a>
  </p>
</main>`);
    return;
  }
  res.writeHead(404).end('Voxelcraft multiplayer server');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket: WebSocket) => {
  const client: Client = {
    id: `p${nextClientId++}`,
    socket,
    name: 'Player',
    key: '',
    room: null,
    isHost: false,
    colorIndex: 0,
    lastSeen: Date.now(),
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    spawn: null,
    health: MAX_HEALTH,
    hunger: MAX_HUNGER,
    dead: false,
    inventory: new Inventory(),
    holding: createHolding(2),
    container: null,
    lastAck: 0,
    lastEquipment: '0,0,0,0',
    inventoryDirty: false,
    buckets: {
      state: newBucket(RATE_LIMIT_STATE_PER_SEC),
      edits: newBucket(RATE_LIMIT_EDITS_PER_SEC),
      other: newBucket(RATE_LIMIT_OTHER_PER_SEC),
      combat: newBucket(RATE_LIMIT_COMBAT_PER_SEC),
      inventory: newBucket(RATE_LIMIT_INVENTORY_PER_SEC),
    },
  };

  socket.on('message', (data: unknown, isBinary: boolean) => {
    if (isBinary) return; // JSON transport only for now
    try {
      handleMessage(client, String(data));
    } catch (err) {
      // One bad message must never take the server down for everyone else.
      log('error handling message', err);
    }
  });

  socket.on('close', () => leaveRoom(client));
  socket.on('error', () => leaveRoom(client));
  socket.on('pong', () => {
    client.lastSeen = Date.now();
  });
});

// --- Authoritative simulation loop ---
// Every room with players steps at SIM_HZ and publishes a world snapshot at
// MOB_SYNC_HZ. Clients render what arrives and never simulate mobs themselves.
let lastSimAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastSimAt) / 1000);
  lastSimAt = now;

  for (const room of rooms.values()) {
    // An empty room stands still: no one to see it, nothing to spend on it.
    if (room.clients.size === 0) continue;
    const players = simPlayers(room);
    room.sim.update(dt, players);

    // Anything the simulation handed to players went out already; the rest of
    // its side effects are drained here at the snapshot rate.
    for (const key of room.sim.removedContainers.splice(0)) {
      for (const client of room.clients.values()) {
        if (client.container === key) closeContainer(client);
      }
    }

    if (now - room.lastSnapshotAt < 1000 / MOB_SYNC_HZ) continue;
    room.lastSnapshotAt = now;

    for (const key of room.sim.dirtyContainers) syncContainer(room, key);
    room.sim.dirtyContainers.clear();
    // Players who wandered off from an open chest get it closed for them.
    for (const client of room.clients.values()) openEntity(client);

    // Block changes the simulation made went out as block_update messages
    // through the onBlockChanged hook; the list only needs draining here.
    room.sim.blocks.length = 0;
    const sleep = room.sim.sleepSnapshot(players);
    broadcast(room, {
      t: 'world_state',
      time: Math.round(room.sim.timeOfDay * 10000) / 10000,
      mobs: room.sim.mobSnapshot().slice(0, MAX_MOBS_PER_MESSAGE),
      drops: room.sim.dropSnapshot().slice(0, MAX_DROPS_PER_MESSAGE),
      removedMobs: room.sim.removedMobs.splice(0),
      removedDrops: room.sim.removedDrops.splice(0),
      arrows: room.sim.arrowSnapshot().slice(0, MAX_ARROWS_PER_MESSAGE),
      removedArrows: room.sim.removedArrows.splice(0),
      mobDeaths: room.sim.mobDeaths.splice(0),
      ...(sleep ? { sleep } : {}),
    });

    if (now - room.lastSaveAt > AUTOSAVE_MS) saveRoom(room);
  }
}, 1000 / SIM_HZ);

// Drop silent connections (backgrounded mobile tabs that never came back) and
// unload rooms that have sat empty — they are already on disk.
setInterval(() => {
  const now = Date.now();
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
  for (const room of [...rooms.values()]) {
    for (const client of [...room.clients.values()]) {
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) {
        log(`dropping idle client ${client.id}`);
        client.socket.terminate();
        leaveRoom(client);
      }
    }
    if (room.clients.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      saveRoom(room);
      rooms.delete(room.code);
      log(`room ${room.code} unloaded (empty); world ${room.worldId} saved`);
    }
  }
}, 10_000);

function shutdown(): void {
  log('shutting down');
  for (const room of [...rooms.values()]) {
    // Everyone's inventory goes into the file before the socket drops.
    for (const client of [...room.clients.values()]) {
      closeHolding(clickContext(client));
    }
    saveRoomSync(room);
    broadcast(room, { t: 'room_closed', reason: 'server_shutdown', message: 'The server is restarting.' });
    for (const client of room.clients.values()) {
      client.room = null;
      setTimeout(() => client.socket.close(4000, 'server_shutdown'), 50);
    }
    room.clients.clear();
    rooms.delete(room.code);
  }
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}

store
  .init()
  .catch((err) => log(`could not index ${DATA_DIR}`, err))
  .then(() => {
    httpServer.listen(PORT, HOST, () => {
      log(`Voxelcraft multiplayer server listening on ws://${HOST}:${PORT}`);
      log(`Health check: http://${HOST}:${PORT}/health`);
      log(`Worlds are saved in ${store.dir} (${store.list().length} on disk)`);
    });
  });
