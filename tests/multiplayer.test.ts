// End-to-end multiplayer tests against a real server process.
//
// These boot `server/index.ts` on a spare port and drive it with real
// WebSocket clients, so they exercise the actual message handlers, rate
// limits, room lifecycle and authoritative simulation — not a mock of them.

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '../src/net/protocol.ts';
import type { ClientMessage, ServerMessage } from '../src/net/protocol.ts';

const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server: ChildProcess;

/** A test client: sends typed messages, and can wait for a message to arrive. */
class TestClient {
  private readonly socket: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: { match: (m: ServerMessage) => boolean; resolve: (m: never) => void }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
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

  static async connect(): Promise<TestClient> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new TestClient(socket);
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

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create a room and return the host plus the room's code and seed. */
async function hostRoom(name = 'Host') {
  const host = await TestClient.connect();
  host.send({ t: 'create_room', name, version: PROTOCOL_VERSION });
  const created = await host.wait('room_created');
  return { host, code: created.code, seed: created.world.seed, self: created.self };
}

async function joinRoom(code: string, name: string) {
  const guest = await TestClient.connect();
  guest.send({ t: 'join_room', code, name, version: PROTOCOL_VERSION });
  return guest;
}

/** Tell the server where a client is, and let the position register. */
async function moveTo(client: TestClient, x: number, y: number, z: number) {
  client.send({ t: 'player_state', s: { x, y, z, yaw: 0, pitch: 0, flags: 0 } });
  await sleep(120);
}

before(async () => {
  server = spawn('node', ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
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

after(() => {
  server?.kill();
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

  // The host is told about the arrival too.
  const announced = await host.wait('player_joined');
  assert.equal(announced.player.name, 'Guest');

  host.close();
  guest.close();
});

test('a bad room code is refused with a reason, not a silent drop', async () => {
  const stranger = await TestClient.connect();
  stranger.send({ t: 'join_room', code: 'ZZZZZZ', name: 'Lost', version: PROTOCOL_VERSION });
  const err = await stranger.wait('join_error');
  assert.equal(err.reason, 'room_not_found');
  assert.ok(err.message.length > 0, 'the player is told what went wrong');
  stranger.close();
});

test('a protocol mismatch is rejected rather than half-working', async () => {
  const old = await TestClient.connect();
  old.send({ t: 'create_room', name: 'Old', version: PROTOCOL_VERSION + 99 });
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

test('a block placed by one player appears for the others', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  await moveTo(host, 100, 64, 100);
  host.send({ t: 'block_place', x: 100, y: 64, z: 100, id: 4 });

  const update = await guest.wait('block_update', 5000, (m) => m.t === 'block_update' && m.x === 100);
  assert.equal(update.y, 64);
  assert.equal(update.z, 100);
  assert.equal(update.id, 4);

  host.close();
  guest.close();
});

test('a late joiner is sent the edits it missed', async () => {
  const { host, code } = await hostRoom();
  await moveTo(host, 200, 64, 200);
  host.send({ t: 'block_place', x: 200, y: 64, z: 200, id: 4 });
  await sleep(200);

  const late = await joinRoom(code, 'Late');
  await late.wait('join_success');
  // Chunk 12,12 holds x=200,z=200 with 16-wide chunks.
  late.send({ t: 'chunk_edits_request', keys: ['12,12'] });
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
  const { TerrainGenerator } = await import('../src/world/terrain.ts');
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
  const { TerrainGenerator } = await import('../src/world/terrain.ts');
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
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  const joined = await guest.wait('join_success');
  const { TerrainGenerator } = await import('../src/world/terrain.ts');
  const spawn = new TerrainGenerator(joined.world.seed).findSpawnColumn();

  // Both players standing together; the host throws a stack down.
  await moveTo(host, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  await moveTo(guest, spawn.x + 0.5, spawn.y, spawn.z + 0.5);
  host.send({ t: 'drop_item', item: 'diamond', count: 3 });

  // The item must exist in the world, visible to both.
  const withDrop = await guest.wait(
    'world_state',
    5000,
    (m) => m.t === 'world_state' && m.drops.some((d) => d.item === 'diamond'),
  );
  assert.ok(withDrop, 'a thrown item becomes a real entity in the shared world');

  // The guest — not the thrower — collects it once the throw delay lapses.
  const grant = await guest.wait('loot_grant', 8000);
  assert.deepEqual(grant.items, [{ id: 'diamond', count: 3 }]);

  // And the host must never also be granted it.
  await sleep(500);
  assert.equal(host.all('loot_grant').length, 0, 'a stack cannot be collected twice');

  host.close();
  guest.close();
});

test('a client cannot conjure items across the map', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');
  await moveTo(host, 0, 64, 0);

  // A positioned drop far outside reach must be dropped on the floor.
  host.send({ t: 'drop_item', item: 'diamond', count: 64, p: [5000, 64, 5000] });
  await sleep(800);

  const drops = host.all('world_state').at(-1)?.drops ?? [];
  assert.ok(
    !drops.some((d) => d.x > 1000),
    'a drop request beyond reach must be rejected',
  );

  host.close();
  guest.close();
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
    host.send({ t: 'block_place', x: 300 + (i % 16), y: 64, z: 300, id: 4 });
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
  vandal.sendRaw([1, 2, 3]);
  await sleep(400);

  // If anything above had killed the server, this would fail to connect.
  const { host, code } = await hostRoom();
  assert.match(code, /^[A-Z0-9]{6}$/);
  vandal.close();
  host.close();
});

test('when the host leaves, the room closes and guests are told why', async () => {
  const { host, code } = await hostRoom();
  const guest = await joinRoom(code, 'Guest');
  await guest.wait('join_success');

  host.close();
  const closed = await guest.wait('room_closed');
  assert.equal(closed.reason, 'host_left');
  assert.ok(closed.message.length > 0, 'guests get an explanation, not a dead socket');

  guest.close();
});
