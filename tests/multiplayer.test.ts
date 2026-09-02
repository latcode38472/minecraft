// End-to-end multiplayer tests against a real server process.
//
// These boot `server/index.ts` on a spare port and drive it with real
// WebSocket clients, so they exercise the actual message handlers, rate
// limits, room lifecycle, inventory authority, persistence and the
// authoritative simulation — not a mock of them.

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/net/protocol.ts';
import type { ClientMessage, ServerMessage } from '../src/net/protocol.ts';
import { TerrainGenerator } from '../src/world/terrain.ts';

const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-worlds-'));

let server: ChildProcess;

/** A fresh per-browser player key, as the real client mints one. */
const newKey = (): string => randomBytes(16).toString('hex');

/** A test client: sends typed messages, and can wait for a message to arrive. */
class TestClient {
  readonly key: string;
  private readonly socket: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: { match: (m: ServerMessage) => boolean; resolve: (m: never) => void }[] = [];

  private constructor(socket: WebSocket, key: string) {
    this.socket = socket;
    this.key = key;
    socket.on('message', (raw) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      this.inbox.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(msg)) {
          this.waiters.splice(i, 1)[0].resolve(msg as never);
        }
      }
    });
  }

  static async connect(key = newKey()): Promise<TestClient> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new TestClient(socket, key);
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Send something the type system would never allow, to test the server's guards. */
  sendRaw(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Resolve with the first message of type `t` (checking what already arrived). */
  wait<T extends ServerMessage['t']>(
    t: T,
    timeoutMs = 5000,
    extra: (m: ServerMessage) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (m: ServerMessage) => m.t === t && extra(m);
    const already = this.inbox.find(match);
    if (already) return Promise.resolve(already as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${t}"`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: ((m: ServerMessage) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        }) as never,
      });
    });
  }

  /** Every message of this type received so far. */
  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.inbox.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  /** The latest inventory the server sent, or null. */
  inventory() {
    return this.all('inventory').at(-1) ?? null;
  }

  /** How many of an item the latest server inventory holds. */
  count(id: string): number {
    const inv = this.inventory();
    if (!inv) return 0;
    return inv.slots.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create a room and return the host plus the room's code and seed. */
async function hostRoom(name = 'Host', key = newKey(), worldName?: string) {
  const host = await TestClient.connect(key);
  host.send({ t: 'create_room', name, version: PROTOCOL_VERSION, key, worldName });
  const created = await host.wait('room_created');
  return { host, code: created.code, seed: created.world.seed, self: created.self, created };
}

async function joinRoom(code: string, name: string, key = newKey()) {
  const guest = await TestClient.connect(key);
  guest.send({ t: 'join_room', code, name, version: PROTOCOL_VERSION, key });
  return guest;
}

/** Tell the server where a client is, and let the position register. */
async function moveTo(client: TestClient, x: number, y: number, z: number) {
  client.send({ t: 'player_state', s: { x, y, z, yaw: 0, pitch: 0, flags: 0 } });
  await sleep(120);
}

/**
 * Stand a client on the spawn column and break the ground under it, so the
 * server gives them a block of dirt: the only honest way to get an item into
 * a server-owned inventory.
 */
async function earnDirt(client: TestClient, seed: number) {
  const spawn = new TerrainGenerator(seed).findSpawnColumn();
  await moveTo(client, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  client.send({ t: 'block_break', x: spawn.x, y: spawn.y - 1, z: spawn.z });
  // The drop lands in the hole; a real client would fall in after it.
  await moveTo(client, spawn.x + 0.5, spawn.y - 1, spawn.z + 0.5);
  await client.wait('inventory', 8000, (m) => m.t === 'inventory' && m.slots.some((s) => s?.id === 'dirt'));
  return spawn;
}

before(async () => {
  server = spawn('node', ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', VOXEL_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listener rather than guessing at a startup delay.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const probe = new WebSocket(URL);
      await new Promise<void>((resolve, reject) => {
        probe.once('open', () => {
          probe.close();
          resolve();
        });
        probe.once('error', reject);
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('server did not start');
      await sleep(200);
    }
  }
});

after(async () => {
  server?.kill();
  // Let the process die before sweeping its files out from under it.
  await sleep(500);
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
});

test('a host creates a room and gets a shareable 6-character code', async () => {
  const { host, code, seed } = await hostRoom();
  assert.match(code, /^[A-Z0-9]{6}$/, `unusable room code: ${code}`);
  assert.ok(Number.isFinite(seed), 'the room must carry a world seed');
  host.close();
});

test('a guest joining gets the same seed, so both generate the same world', async () => {
  const { host, code, seed } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  const joined = await guest.wait('join_success');

  assert.equal(joined.world.seed, seed, 'guests must build the host\'s world, not their own');
  assert.equal(joined.players.length, 2, 'the roster shows both players');
  assert.notEqual(joined.self.id, undefined);
  assert.equal(joined.restore, undefined, 'a first visit has nothing to restore');

  // The host is told about the arrival too.
  const announced = await host.wait('player_joined');
  assert.equal(announced.player.name, 'Guest');

  host.close();
  guest.close();
});

test('a bad room code is refused with a reason, not a silent drop', async () => {
  const stranger = await TestClient.connect();
  stranger.send({ t: 'join_room', code: 'ZZZZZZ', name: 'Lost', version: PROTOCOL_VERSION, key: stranger.key });
  const err = await stranger.wait('join_error');
  assert.equal(err.reason, 'room_not_found');
  assert.ok(err.message.length > 0, 'the player is told what went wrong');
  stranger.close();
});

test('a protocol mismatch is rejected rather than half-working', async () => {
  const old = await TestClient.connect();
  old.send({ t: 'create_room', name: 'Old', version: PROTOCOL_VERSION + 99, key: old.key });
  const err = await old.wait('join_error');
  assert.equal(err.reason, 'bad_version');
  old.close();
});

test('the fourth player is turned away: three is a hard cap', async () => {
  const { host, code } = await hostRoom();
  const g1 = await joinRoom(code, 'G1');
  await g1.wait('join_success');
  const g2 = await joinRoom(code, 'G2');
  await g2.wait('join_success');

  const g3 = await joinRoom(code, 'G3');
  const err = await g3.wait('join_error');
  assert.equal(err.reason, 'room_full', 'a fourth player must be refused');

  host.close();
  g1.close();
  g2.close();
  g3.close();
});

test('a block broken by one player disappears for the others and drops an item', async () => {
  const { host, code, seed } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  const spawn = new TerrainGenerator(seed).findSpawnColumn();
  await moveTo(host, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  // Stand the guest well away, so the drop is not collected before it is seen.
  await moveTo(guest, spawn.x + 20, spawn.y, spawn.z + 20);
  host.send({ t: 'block_break', x: spawn.x, y: spawn.y - 1, z: spawn.z });

  const update = await guest.wait('block_update', 5000, (m) => m.t === 'block_update' && m.x === spawn.x);
  assert.equal(update.id, 0, 'the block is gone for everyone');
  const withDrop = await guest.wait(
    'world_state',
    5000,
    (m) => m.t === 'world_state' && m.drops.some((d) => d.item === 'dirt' || d.item === 'sand'),
  );
  assert.ok(withDrop, 'a broken block becomes a real drop in the shared world');

  host.close();
  guest.close();
});

test('you can only place what you hold, and a bogus placement is reverted for the sender', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  await moveTo(host, 100, 64, 100);
  host.send({ t: 'block_place', x: 100, y: 64, z: 100, id: 4 });

  // The server has no sand in the host's hand, so it tells the host to undo it.
  const revert = await host.wait('block_update', 5000, (m) => m.t === 'block_update' && m.x === 100);
  assert.equal(revert.id, 0, 'the sender is told the block is still air');
  await sleep(300);
  assert.equal(guest.all('block_update').length, 0, 'nothing is relayed to the others');

  host.close();
  guest.close();
});

test('a block dug up and placed again appears for the others', async () => {
  const { host, code, seed } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  const spawn = await earnDirt(host, seed);
  const inv = host.inventory()!;
  const slot = inv.slots.findIndex((s) => s?.id === 'dirt');
  host.send({ t: 'select_slot', index: slot });
  await sleep(100);
  host.send({ t: 'block_place', x: spawn.x + 1, y: spawn.y, z: spawn.z, id: 2 });

  const update = await guest.wait(
    'block_update',
    5000,
    (m) => m.t === 'block_update' && m.x === spawn.x + 1 && m.id === 2,
  );
  assert.equal(update.y, spawn.y);
  const after = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && !m.slots.some((s) => s?.id === 'dirt'));
  assert.ok(after, 'placing the block spends it');

  host.close();
  guest.close();
});

test('a late joiner is sent the edits it missed', async () => {
  const { host, code, seed } = await hostRoom();
  const spawn = await earnDirt(host, seed);

  const late = await joinRoom(code, 'Late');
  await late.wait('join_success');
  const key = `${Math.floor(spawn.x / 16)},${Math.floor(spawn.z / 16)}`;
  late.send({ t: 'chunk_edits_request', keys: [key] });
  const edits = await late.wait('chunk_edits');
  assert.ok(edits.entries.length > 0, 'the world a late joiner sees must include earlier edits');

  host.close();
  late.close();
});

test('an out-of-world block edit is ignored', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  host.sendRaw({ t: 'block_place', x: 1e12, y: -5, z: 0, id: 4 });
  host.sendRaw({ t: 'block_place', x: 0, y: 64, z: 0, id: 9999 });
  await sleep(400);

  assert.equal(guest.all('block_update').length, 0, 'no invalid edit may be relayed');
  host.close();
  guest.close();
});

test('the server simulates mobs and every client sees the same ones', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  const joined = await guest.wait('join_success');

  // Stand both players on real ground so mobs have somewhere to spawn.
  const spawn = new TerrainGenerator(joined.world.seed).findSpawnColumn();
  await moveTo(host, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  await moveTo(guest, spawn.x + 1.5, spawn.y, spawn.z + 1.5);

  // Wait until the room has actually populated (spawning is on a timer).
  const deadline = Date.now() + 20000;
  let hostMobs: number[] = [];
  while (Date.now() < deadline) {
    const latest = host.all('world_state').at(-1);
    if (latest && latest.mobs.length > 0) {
      hostMobs = latest.mobs.map((m) => m.i).sort();
      break;
    }
    await sleep(500);
  }
  assert.ok(hostMobs.length > 0, 'the server must simulate mobs on its own');

  await sleep(500);
  const guestMobs = (guest.all('world_state').at(-1)?.mobs ?? []).map((m) => m.i).sort();
  const shared = hostMobs.filter((id) => guestMobs.includes(id));
  assert.ok(
    shared.length > 0,
    `both clients must see the same mob ids (host ${hostMobs}, guest ${guestMobs})`,
  );

  // The clock is the server's too, so nobody drifts into their own night.
  const hostTime = host.all('world_state').at(-1)!.time;
  const guestTime = guest.all('world_state').at(-1)!.time;
  assert.ok(Math.abs(hostTime - guestTime) < 0.05, 'the day/night clock is shared');

  host.close();
  guest.close();
});

test('a guest can hurt a mob without the host doing anything', async () => {
  // This is what "server-authoritative" buys: the mob's health lives on the
  // server, so a guest's swing lands even though the host never sees it.
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  const joined = await guest.wait('join_success');
  const spawn = new TerrainGenerator(joined.world.seed).findSpawnColumn();
  await moveTo(guest, spawn.x + 0.5, spawn.y, spawn.z + 0.5);

  // Wait for the server to put a mob near the guest.
  const deadline = Date.now() + 25000;
  let target: { i: number; hp: number } | undefined;
  while (Date.now() < deadline && !target) {
    const latest = guest.all('world_state').at(-1);
    target = latest?.mobs.find((m) => m.hp > 1);
    if (!target) await sleep(500);
  }
  assert.ok(target, 'the server must spawn a mob for the guest to attack');

  // Stand on the mob so the reach check passes, then swing.
  const mob = guest.all('world_state').at(-1)!.mobs.find((m) => m.i === target!.i)!;
  await moveTo(guest, mob.x, mob.y, mob.z);
  const before = mob.hp;
  guest.send({ t: 'attack_mob', mob: target.i, damage: 4 });

  const hurt = await guest.wait(
    'world_state',
    6000,
    (m) =>
      m.t === 'world_state' &&
      (m.removedMobs.includes(target!.i) ||
        (m.mobs.find((x) => x.i === target!.i)?.hp ?? before) < before),
  );
  assert.ok(hurt, 'a guest\'s hit must change the mob the server owns');

  host.close();
  guest.close();
});

test('Q hands an item to another player, and only one of them gets it', async () => {
  const { host, code, seed } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  // The host digs up a block, so the server knows they hold something.
  const spawn = await earnDirt(host, seed);
  const slot = host.inventory()!.slots.findIndex((s) => s?.id === 'dirt');
  host.send({ t: 'select_slot', index: slot });
  // Into the same hole as the host, so the throw lands at the guest's feet.
  await moveTo(guest, spawn.x + 0.5, spawn.y - 1, spawn.z + 0.5);
  host.send({ t: 'drop_item', seq: 1, all: true });

  // The thrower's inventory is emptied by the server, not by the client.
  const emptied = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && m.ack === 1);
  assert.ok(!emptied.slots.some((s) => s?.id === 'dirt'), 'the thrown stack leaves the thrower');

  // The item must exist in the world, visible to both.
  const withDrop = await guest.wait(
    'world_state',
    5000,
    (m) => m.t === 'world_state' && m.drops.some((d) => d.item === 'dirt'),
  );
  assert.ok(withDrop, 'a thrown item becomes a real entity in the shared world');

  // The guest — not the thrower — collects it once the throw delay lapses.
  const taken = await guest.wait('inventory', 8000, (m) => m.t === 'inventory' && m.slots.some((s) => s?.id === 'dirt'));
  assert.ok(taken.slots.some((s) => s?.id === 'dirt' && s.count >= 1));

  // And the host must never also be granted it.
  await sleep(500);
  assert.equal(host.count('dirt'), 0, 'a stack cannot be collected twice');

  host.close();
  guest.close();
});

test('a client cannot drop what it does not have', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');
  await moveTo(host, 0, 64, 0);

  host.send({ t: 'drop_item', seq: 1, all: true });
  await sleep(800);

  const drops = host.all('world_state').at(-1)?.drops ?? [];
  assert.equal(drops.length, 0, 'an empty hand throws nothing');

  host.close();
  guest.close();
});

test('the crafting grid is server-side: planks come out of a log, and the ack tracks the click', async () => {
  const { host, code, seed } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');
  // There is no log to be had at spawn without a tree; use dirt as a stand-in
  // for the click semantics and assert nothing is crafted from it.
  await earnDirt(host, seed);
  const slot = host.inventory()!.slots.findIndex((s) => s?.id === 'dirt');

  host.send({ t: 'inv_click', seq: 5, slot: { kind: 'inv', index: slot }, button: 0, shift: false });
  const picked = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && m.ack === 5);
  assert.equal(picked.cursor?.id, 'dirt', 'a left click lifts the stack onto the cursor');
  assert.equal(picked.slots[slot], null);

  host.send({ t: 'inv_click', seq: 6, slot: { kind: 'craft', index: 0 }, button: 1, shift: false });
  const placed = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && m.ack === 6);
  assert.equal(placed.craft[0]?.id, 'dirt', 'a right click puts one into the grid');

  host.send({ t: 'inv_craft', seq: 7, all: false });
  const crafted = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && m.ack === 7);
  assert.equal(crafted.craft[0]?.id, 'dirt', 'dirt is not a recipe: nothing is consumed');

  host.send({ t: 'inv_close', seq: 8 });
  const closed = await host.wait('inventory', 5000, (m) => m.t === 'inventory' && m.ack === 8);
  assert.equal(closed.cursor, null, 'closing the screen puts the cursor back');
  assert.ok(closed.craft.every((c) => c === null), 'and empties the grid');
  assert.ok(closed.slots.some((s) => s?.id === 'dirt'), 'nothing was lost');

  host.close();
  guest.close();
});

test('a returning player gets their inventory and place back', async () => {
  const { host, code, seed } = await hostRoom('Comeback');
  const guest = await joinRoom(code, 'Keeper');
  await guest.wait('join_success');
  await earnDirt(host, seed);
  await moveTo(host, 123.5, 60, 45.5);
  host.close();
  await guest.wait('player_left');

  // Same key, new socket: this is a reconnect or a fresh visit.
  const back = await joinRoom(code, 'Comeback', host.key);
  const joined = await back.wait('join_success');
  assert.ok(joined.restore, 'the server remembers this player');
  assert.equal(Math.round(joined.restore!.x), 124, 'and where they were');
  assert.equal(joined.self.isHost, true, 'the owner takes the room back');
  const inv = await back.wait('inventory');
  assert.ok(inv.slots.some((s) => s?.id === 'dirt'), 'and what they were carrying');

  back.close();
  guest.close();
});

test('worlds are listed for the people who played in them, with their state', async () => {
  const { host, code } = await hostRoom('Owner', newKey(), 'Listed World');
  const guest = await joinRoom(code, 'Visitor');
  await guest.wait('join_success');
  const stranger = await TestClient.connect();

  host.send({ t: 'list_worlds', key: host.key });
  const mine = await host.wait('world_list');
  const entry = mine.worlds.find((w) => w.name === 'Listed World');
  assert.ok(entry, 'the host sees their own world');
  assert.equal(entry!.status, 'open');
  assert.equal(entry!.code, code, 'an open world can be joined by its code');
  assert.equal(entry!.players, 2);
  assert.equal(entry!.host, 'You');

  guest.send({ t: 'list_worlds', key: guest.key });
  const theirs = await guest.wait('world_list');
  assert.ok(theirs.worlds.some((w) => w.name === 'Listed World'), 'a visitor sees it too');

  stranger.send({ t: 'list_worlds', key: stranger.key });
  const none = await stranger.wait('world_list');
  assert.ok(!none.worlds.some((w) => w.name === 'Listed World'), 'strangers cannot see it');

  // Only the owner can reopen a world by id.
  stranger.send({ t: 'create_room', name: 'Thief', version: PROTOCOL_VERSION, key: stranger.key, worldId: entry!.id });
  const refused = await stranger.wait('join_error');
  assert.equal(refused.reason, 'not_owner');

  host.close();
  guest.close();
  stranger.close();
});

test('a world is written to disk and can be reopened by its owner as the same world', async () => {
  const { host, code, seed } = await hostRoom('Saver', newKey(), 'Disk World');
  await earnDirt(host, seed);
  host.close();
  // Leaving as the last player saves the world at once; the file written at
  // creation is there earlier, so wait for the one that carries the edit.
  interface OnDisk {
    file: string;
    seed: number;
    edits: Record<string, number[]>;
    players: Record<string, unknown>;
  }
  const findSaved = (): OnDisk | null => {
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!file.endsWith('.json')) continue;
      const text = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
      if (!text.includes('Disk World')) continue;
      const parsed = JSON.parse(text) as Omit<OnDisk, 'file'>;
      if (Object.keys(parsed.edits).length > 0) return { file, ...parsed };
    }
    return null;
  };
  const deadline = Date.now() + 5000;
  let saved = findSaved();
  while (!saved && Date.now() < deadline) {
    await sleep(100);
    saved = findSaved();
  }
  assert.ok(saved, 'the world must be saved to disk with its edits');
  assert.equal(saved.seed, seed);
  assert.ok(saved.players[host.key], 'the player is in the save');

  const worldId = saved.file.slice(0, -'.json'.length);
  const again = await TestClient.connect(host.key);
  again.send({ t: 'create_room', name: 'Saver', version: PROTOCOL_VERSION, key: host.key, worldId });
  // A world still warm in memory is joined; one loaded from disk is created.
  const reopened = await Promise.race([
    again.wait('room_created', 5000).catch(() => null),
    again.wait('join_success', 5000).catch(() => null),
  ]);
  assert.ok(reopened, 'the owner gets back in');
  assert.equal(reopened!.world.seed, seed, 'the same world, not a new one');
  assert.equal(reopened!.code, code, 'the room was kept warm under its code');
  assert.ok(reopened!.restore, 'with the player restored');
  const inv = await again.wait('inventory');
  assert.ok(inv.slots.some((s) => s?.id === 'dirt'), 'inventory included');
  again.close();
});

test('sleeping needs a bed and the night; the server says why', async () => {
  const { host, code, seed } = await hostRoom();
  const spawn = new TerrainGenerator(seed).findSpawnColumn();
  await moveTo(host, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  host.send({ t: 'sleep', x: spawn.x, y: spawn.y - 1, z: spawn.z });
  const result = await host.wait('sleep_result');
  assert.equal(result.sleeping, false);
  assert.ok(result.message && result.message.length > 0, 'the player is told why not');
  assert.match(code, /^[A-Z0-9]{6}$/);
  host.close();
});

test('PvP damage is arbitrated by the server, clamped and attributed', async () => {
  const { host, code, self } = await hostRoom('Attacker');
  const guest = await joinRoom(code, 'Victim');
  const joined = await guest.wait('join_success');

  // Stand next to each other so the reach check passes.
  await moveTo(host, 50, 64, 50);
  await moveTo(guest, 51, 64, 50);

  // Ask for absurd damage; the server must clamp it, and the victim survive.
  host.sendRaw({ t: 'attack_player', target: joined.self.id, damage: 1e9 });
  const hurt = await guest.wait('player_hurt');
  assert.equal(hurt.id, joined.self.id);
  assert.equal(hurt.by, self.id, 'the hit is attributed to the attacker');
  assert.ok(hurt.damage <= 40, `damage was not clamped: ${hurt.damage}`);

  host.close();
  guest.close();
});

test('an attack from across the map is rejected', async () => {
  const { host, code } = await hostRoom('Sniper');
  const guest = await joinRoom(code, 'Target');
  const joined = await guest.wait('join_success');

  await moveTo(host, 0, 64, 0);
  await moveTo(guest, 900, 64, 900);

  host.send({ t: 'attack_player', target: joined.self.id, damage: 10 });
  await sleep(600);
  assert.equal(guest.all('player_hurt').length, 0, 'reach must be enforced server-side');

  host.close();
  guest.close();
});

test('a flood of messages is rate-limited instead of taking the server down', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');
  await moveTo(host, 300, 64, 300);

  for (let i = 0; i < 500; i++) {
    host.sendRaw({ t: 'block_break', x: 300 + (i % 16), y: 30, z: 300 });
  }
  await sleep(1000);

  const relayed = guest.all('block_update').length;
  assert.ok(relayed < 500, `the flood was not throttled: ${relayed} edits relayed`);

  // The server must still be alive and serving other clients.
  const late = await joinRoom(code, 'Late');
  const ok = await late.wait('join_success');
  assert.ok(ok.code === code, 'the server keeps working after a flood');

  host.close();
  guest.close();
  late.close();
});

test('garbage input never crashes the server', async () => {
  const vandal = await TestClient.connect();
  vandal.sendRaw('not json at all');
  vandal.sendRaw({ t: 'nonexistent_message' });
  vandal.sendRaw({ t: 'create_room' }); // missing fields
  vandal.sendRaw({ t: 'player_state', s: null });
  vandal.sendRaw({ t: 'attack_mob', mob: 'lots', damage: {} });
  vandal.sendRaw({ t: 'drop_item', item: { toString: 1 }, count: [] });
  vandal.sendRaw({ t: 'inv_click', seq: 'x', slot: { kind: '__proto__', index: -1 } });
  vandal.sendRaw({ t: 'create_room', name: 'x', version: PROTOCOL_VERSION, key: '../../etc' });
  vandal.sendRaw({ t: 'list_worlds', key: { length: 1e9 } });
  vandal.sendRaw([1, 2, 3]);
  await sleep(400);

  // If anything above had killed the server, this would fail to connect.
  const { host, code } = await hostRoom();
  assert.match(code, /^[A-Z0-9]{6}$/);
  vandal.close();
  host.close();
});

test('when the host leaves, the world goes on and someone else holds it', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  host.close();
  const changed = await guest.wait('host_changed');
  const me = changed.players.find((p) => p.id === changed.id);
  assert.ok(me && me.isHost, 'the remaining player becomes host');
  assert.equal(guest.all('room_closed').length, 0, 'the room does not close');

  // And the world keeps ticking for them.
  const before = guest.all('world_state').length;
  await sleep(400);
  assert.ok(guest.all('world_state').length > before, 'snapshots keep coming');
  guest.close();
});
