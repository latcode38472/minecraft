// Authoritative multiplayer server for Voxelcraft.
//
// Run with:  npm run server        (node runs this .ts file directly)
//
// The server owns room membership, the world seed, and the authoritative set
// of block edits. Clients apply their own edits immediately for responsiveness
// and the server relays them; the server's copy is what late joiners receive,
// so it is the source of truth for world state.
//
// It binds 0.0.0.0 by default so phones on the same Wi-Fi can connect.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomSimulation } from '../src/shared/roomsim.ts';
import { ServerWorld } from './world.ts';
import {
  CLIENT_TIMEOUT_MS,
  EDITS_PER_MESSAGE,
  MAX_CHUNK_REQUEST,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  RATE_LIMIT_EDITS_PER_SEC,
  MAX_ATTACK_RANGE,
  MAX_DROP_RANGE,
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
  sanitizeDropRequest,
  sanitizeEquipment,
  sanitizeName,
  sanitizePlayerState,
  type ChunkEditEntry,
  type JoinErrorReason,
  type PlayerInfo,
  type PlayerVitals,
  type ServerMessage,
  type WorldInfo,
} from '../src/net/protocol.ts';

const PORT = Number(process.env.PORT ?? process.env.VOXEL_SERVER_PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
/** Rooms with no players are swept after this long (guards against leaks). */
const EMPTY_ROOM_TTL_MS = 60_000;
const CHUNK_SIZE = 16;
/** Cap total stored edits per room so one client cannot exhaust server memory. */
const MAX_EDITS_PER_ROOM = 500_000;

interface RateBucket {
  tokens: number;
  last: number;
}

interface Client {
  id: string;
  socket: WebSocket;
  name: string;
  room: Room | null;
  isHost: boolean;
  colorIndex: number;
  lastSeen: number;
  /** Last position the client reported, used to validate attack range. */
  pos: { x: number; y: number; z: number };
  /** Server-owned combat state — clients never set this directly. */
  health: number;
  hunger: number;
  dead: boolean;
  /** Armour tier per slot, mirrored so late joiners see worn gear. */
  equipment: number[];
  buckets: { state: RateBucket; edits: RateBucket; other: RateBucket; combat: RateBucket };
}

const MAX_HEALTH = 20;
const MAX_HUNGER = 20;

interface Room {
  code: string;
  hostId: string;
  clients: Map<string, Client>;
  world: WorldInfo;
  /** chunkKey -> (voxelIndex -> blockId). Mirrors the client's World.edits. */
  edits: Map<string, Map<number, number>>;
  editCount: number;
  emptySince: number | null;
  /** Authoritative mobs, drops and day/night for this room. */
  sim: RoomSimulation;
  lastSnapshotAt: number;
}

const rooms = new Map<string, Room>();
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

function makeWorldInfo(): WorldInfo {
  // The server picks the seed so every client in the room provably shares one.
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  // Spawn Y is resolved client-side from the terrain function; the server only
  // fixes the column so all players land in the same place.
  return { seed, spawn: { x: 8, y: 0, z: 8 }, generator: 'default' };
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
    equipment: client.equipment,
  };
}

function roster(room: Room): PlayerInfo[] {
  return [...room.clients.values()].map(playerInfo);
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

function closeRoom(room: Room, reason: 'host_left' | 'server_shutdown', message: string): void {
  broadcast(room, { t: 'room_closed', reason, message });
  for (const client of room.clients.values()) {
    client.room = null;
    client.isHost = false;
    // Let the message flush before dropping the socket.
    setTimeout(() => client.socket.close(4000, reason), 50);
  }
  room.clients.clear();
  rooms.delete(room.code);
  log(`room ${room.code} closed (${reason})`);
}

function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  client.room = null;

  if (client.isHost) {
    client.isHost = false;
    if (room.clients.size > 0) {
      // No host migration by design: the room ends with its host.
      closeRoom(room, 'host_left', 'The host left the world.');
    } else {
      rooms.delete(room.code);
      log(`room ${room.code} removed (empty, host left)`);
    }
    return;
  }

  broadcast(room, { t: 'player_left', id: client.id, players: roster(room) });
  if (room.clients.size === 0) room.emptySince = Date.now();
  log(`${client.name} left room ${room.code} (${room.clients.size}/${MAX_PLAYERS})`);
}

function rejectJoin(client: Client, reason: JoinErrorReason, message: string): void {
  send(client, { t: 'join_error', reason, message });
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

    case 'create_room': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      if (msg.version !== PROTOCOL_VERSION) {
        rejectJoin(client, 'bad_version', 'This game version is out of date.');
        return;
      }
      // One room per connection: a client cannot spawn rooms in a loop.
      if (client.room) leaveRoom(client);

      const edits = new Map<string, Map<number, number>>();
      const world = makeWorldInfo();
      const room: Room = {
        code: makeRoomCode(),
        hostId: client.id,
        clients: new Map(),
        world,
        edits,
        editCount: 0,
        emptySince: null,
        sim: null as unknown as RoomSimulation,
        lastSnapshotAt: 0,
      };
      // The simulation owns mobs, drops and time for the life of the room.
      room.sim = new RoomSimulation(new ServerWorld(world.seed, edits), {
        damagePlayer: (playerId, amount, fromX, fromZ) => {
          const victim = room.clients.get(playerId);
          if (!victim || victim.dead) return;
          victim.health = Math.max(0, victim.health - amount);
          if (victim.health <= 0) victim.dead = true;
          broadcast(room, {
            t: 'player_hurt',
            id: victim.id,
            damage: amount,
            by: 'mob',
            health: victim.health,
            dead: victim.dead,
          });
          send(victim, { t: 'knockback', fromX, fromZ });
        },
        giveItems: (playerId, itemId, count) => {
          const target = room.clients.get(playerId);
          if (!target) return count;
          // The server does not model inventories; the client re-drops
          // anything that does not fit, which closes the loop honestly.
          send(target, { t: 'loot_grant', items: [{ id: itemId, count }] });
          return 0;
        },
      });
      client.name = sanitizeName(msg.name);
      client.isHost = true;
      client.colorIndex = 0;
      client.health = MAX_HEALTH;
      client.hunger = MAX_HUNGER;
      client.dead = false;
      client.equipment = [0, 0, 0, 0];
      client.room = room;
      room.clients.set(client.id, client);
      rooms.set(room.code, room);

      send(client, {
        t: 'room_created',
        code: room.code,
        self: playerInfo(client),
        world: room.world,
        players: roster(room),
      });
      log(`${client.name} created room ${room.code} (seed ${room.world.seed})`);
      return;
    }

    case 'join_room': {
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      if (msg.version !== PROTOCOL_VERSION) {
        rejectJoin(client, 'bad_version', 'This game version is out of date.');
        return;
      }
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
      // The cap is enforced here, on the server, so a crafted packet cannot
      // squeeze a fourth player in.
      if (room.clients.size >= MAX_PLAYERS) {
        rejectJoin(client, 'room_full', 'This world already has 3 players.');
        return;
      }
      if (client.room) leaveRoom(client);

      client.name = sanitizeName(msg.name);
      client.isHost = false;
      client.colorIndex = pickColorIndex(room);
      client.health = MAX_HEALTH;
      client.hunger = MAX_HUNGER;
      client.dead = false;
      client.equipment = [0, 0, 0, 0];
      client.room = room;
      room.clients.set(client.id, client);
      room.emptySince = null;

      send(client, {
        t: 'join_success',
        code: room.code,
        self: playerInfo(client),
        world: room.world,
        players: roster(room),
      });
      // Ship the world's existing edits so late joiners see earlier changes.
      sendEditsFor(client, room, [...room.edits.keys()]);
      broadcast(room, { t: 'player_joined', player: playerInfo(client), players: roster(room) },
        client.id);
      log(`${client.name} joined room ${room.code} (${room.clients.size}/${MAX_PLAYERS})`);
      return;
    }

    case 'leave_room': {
      leaveRoom(client);
      return;
    }

    case 'player_state': {
      if (!client.room) return;
      if (!allow(client.buckets.state, RATE_LIMIT_STATE_PER_SEC)) return;
      const state = sanitizePlayerState(msg.s);
      if (!state) return;
      // Remember where they claim to be, so attack range can be checked.
      client.pos.x = state.x;
      client.pos.y = state.y;
      client.pos.z = state.z;
      broadcast(client.room, { t: 'player_state', id: client.id, s: state }, client.id);
      return;
    }

    case 'block_break':
    case 'block_place': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.edits, RATE_LIMIT_EDITS_PER_SEC)) return;
      const { x, y, z } = msg as { x: unknown; y: unknown; z: unknown };
      if (!isValidBlockCoord(x, y, z)) return;
      const id = msg.t === 'block_break' ? 0 : (msg as { id: unknown }).id;
      if (!isValidBlockId(id)) return;

      const bx = x as number;
      const by = y as number;
      const bz = z as number;
      if (!recordEdit(room, bx, by, bz, id)) {
        send(client, { t: 'error', message: 'This world has too many changes.' });
        return;
      }
      room.sim.world.applyEdit?.(bx, by, bz, id);
      broadcast(room, { t: 'block_update', x: bx, y: by, z: bz, id, by: client.id }, client.id);
      return;
    }

    case 'player_state': {
      // (handled above; kept for exhaustiveness)
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
      if (victim.health <= 0) victim.dead = true;
      broadcast(room, {
        t: 'player_hurt',
        id: victim.id,
        damage,
        by: client.id,
        health: victim.health,
        dead: victim.dead,
      });
      return;
    }

    case 'player_vitals': {
      // A client reports damage it took locally (falls, mobs, starvation).
      // The server records it so everyone agrees, but clamps the values.
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      if (!isFiniteNumber(msg.health)) return;
      client.health = Math.max(0, Math.min(MAX_HEALTH, msg.health));
      if (isFiniteNumber(msg.hunger)) {
        client.hunger = Math.max(0, Math.min(MAX_HUNGER, msg.hunger));
      }
      client.dead = client.health <= 0 || msg.dead === true;
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

    case 'equipment': {
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.other, RATE_LIMIT_OTHER_PER_SEC)) return;
      const gear = sanitizeEquipment(msg.gear);
      if (!gear) return;
      client.equipment = gear;
      broadcast(room, { t: 'player_equipment', id: client.id, gear }, client.id);
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
      room.sim.damageMob(msg.mob as number, damage, client.id, client.pos);
      return;
    }

    case 'drop_item': {
      // Two callers: vanilla's Q (thrown from the player, so it carries an
      // owner and cannot be re-grabbed for a moment), and the drop from a block
      // the sender just mined (positioned, and free for anyone to collect).
      const room = client.room;
      if (!room) return;
      if (!allow(client.buckets.combat, RATE_LIMIT_COMBAT_PER_SEC)) return;
      const request = sanitizeDropRequest(msg);
      if (!request) return;
      if (!request.p) {
        room.sim.spawnDrop(
          request.item, request.count,
          client.pos.x, client.pos.y + 1.2, client.pos.z,
          client.id,
        );
        return;
      }
      // A positioned drop must be within arm's reach of where the sender says
      // they are, so nobody can conjure items on the far side of the world.
      const [dx, dy, dz] = request.p;
      if (Math.hypot(dx - client.pos.x, dy - client.pos.y, dz - client.pos.z) > MAX_DROP_RANGE) {
        return;
      }
      room.sim.spawnDrop(request.item, request.count, dx, dy, dz);
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
    ${players} player${players === 1 ? '' : 's'} online.
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
    room: null,
    isHost: false,
    colorIndex: 0,
    lastSeen: Date.now(),
    pos: { x: 0, y: 0, z: 0 },
    health: MAX_HEALTH,
    hunger: MAX_HUNGER,
    dead: false,
    equipment: [0, 0, 0, 0],
    buckets: {
      state: newBucket(RATE_LIMIT_STATE_PER_SEC),
      edits: newBucket(RATE_LIMIT_EDITS_PER_SEC),
      other: newBucket(RATE_LIMIT_OTHER_PER_SEC),
      combat: newBucket(RATE_LIMIT_COMBAT_PER_SEC),
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
// Every room steps at SIM_HZ and publishes a world snapshot at MOB_SYNC_HZ.
// Clients render what arrives and never simulate mobs themselves.
let lastSimAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastSimAt) / 1000);
  lastSimAt = now;

  for (const room of rooms.values()) {
    const players = [...room.clients.values()].map((c) => ({
      id: c.id,
      position: c.pos,
      dead: c.dead,
    }));
    room.sim.update(dt, players);

    if (now - room.lastSnapshotAt < 1000 / MOB_SYNC_HZ) continue;
    room.lastSnapshotAt = now;
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
    });
  }
}, 1000 / SIM_HZ);

// Drop silent connections (backgrounded mobile tabs that never came back) and
// sweep rooms that have sat empty.
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
      rooms.delete(room.code);
      log(`room ${room.code} swept (empty)`);
    }
  }
}, 10_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('shutting down');
    for (const room of [...rooms.values()]) {
      closeRoom(room, 'server_shutdown', 'The server is restarting.');
    }
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}

httpServer.listen(PORT, HOST, () => {
  log(`Voxelcraft multiplayer server listening on ws://${HOST}:${PORT}`);
  log(`Health check: http://${HOST}:${PORT}/health`);
});
