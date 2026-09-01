// Glue between the network client and the running game.
//
// Owns: the roster, remote player visuals, outbound state throttling, and
// applying inbound block edits to the world. Created only in multiplayer, so
// singleplayer never touches any of this.

import type * as THREE from 'three';
import { BLOCKS } from '../blocks';
import { WORLD_HEIGHT } from '../constants';
import type { Player } from '../player/player';
import type { World } from '../world/world';
import { NetClient, type ConnectionStatus } from './client';
import {
  FLAG_GROUNDED,
  FLAG_JUMPING,
  FLAG_MOVING,
  FLAG_SNEAKING,
  MAX_BLOCK_ID,
  MAX_CHUNK_REQUEST,
  MAX_MOBS_PER_MESSAGE,
  MOB_KIND_PIG,
  MOB_KIND_ZOMBIE,
  MOB_SYNC_HZ,
  PROTOCOL_VERSION,
  STATE_SEND_HZ,
  WORLD_HEIGHT_LIMIT,
  type MobStateData,
  type PlayerInfo,
  type PlayerVitals,
  type ServerMessage,
  type WorldInfo,
} from './protocol';
import { RemotePlayerManager, separateFromRemotePlayers } from './remoteplayers';
import { RemoteMobManager } from './remotemobs';

const STATE_INTERVAL_MS = 1000 / STATE_SEND_HZ;
/** Skip a state send when nothing meaningful moved. */
const POSITION_EPSILON = 0.01;
const ANGLE_EPSILON = 0.01;
/** Chunk-edit requests are batched over this window to avoid a burst per chunk. */
const CHUNK_REQUEST_FLUSH_MS = 120;

export interface SessionEvents {
  onRosterChange(players: PlayerInfo[]): void;
  onRoomClosed(message: string): void;
  onStatusChange(status: ConnectionStatus): void;
  onNotice(message: string): void;
  /** Another player hit us: apply the damage locally. */
  onDamaged(amount: number, byName: string): void;
  /** The host is told a guest hit one of its mobs. */
  onMobAttacked(mobId: number, damage: number, byId: string): void;
  /**
   * Someone else fired an arrow; spawn a copy locally. `ageMs` is how long ago
   * the server saw it, so the receiver can fast-forward out the latency.
   */
  onRemoteArrow(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    speed: number, ownerId: string, ageMs: number,
  ): void;
  /** Loot the host awarded us for a mob we killed. */
  onLootGranted(items: { id: string; count: number }[]): void;
}

export class MultiplayerSession {
  readonly remotePlayers: RemotePlayerManager;
  /** Host-simulated mobs, rendered on guests only. */
  readonly remoteMobs: RemoteMobManager;
  /** Server-tracked health for every player, for name-plate health bars. */
  vitals = new Map<string, PlayerVitals>();
  readonly world: WorldInfo;
  readonly code: string;
  self: PlayerInfo;
  players: PlayerInfo[] = [];
  /** Set once the host leaves or the server shuts the room down. */
  ended = false;

  private lastStateSentAt = 0;
  private lastMobSyncAt = 0;
  private lastVitalsSentAt = 0;
  private pendingMobRemovals: number[] = [];
  private lastEquipmentSent = '';
  private readonly lastSent = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, flags: -1 };
  /** Chunks we've already asked the server about, so we ask at most once each. */
  private readonly requestedChunks = new Set<string>();
  private pendingChunkRequests: string[] = [];
  private chunkRequestTimer = 0;

  constructor(
    private readonly net: NetClient,
    private readonly gameWorld: World,
    private readonly player: Player,
    scene: THREE.Scene,
    code: string,
    self: PlayerInfo,
    world: WorldInfo,
    players: PlayerInfo[],
    private readonly events: SessionEvents,
  ) {
    this.remotePlayers = new RemotePlayerManager(scene);
    this.remoteMobs = new RemoteMobManager(scene);
    this.code = code;
    this.self = self;
    this.world = world;
    this.players = players;

    assertProtocolMatchesGame();

    this.remotePlayers.sync(players, self.id);
    for (const p of players) this.remotePlayers.applyEquipment(p.id, p.equipment);
    this.events.onRosterChange(players);

    // Local edits go out; remote edits come back in through onMessage.
    this.gameWorld.persistEdits = false; // server is authoritative for this world
    this.gameWorld.onLocalEdit = (x, y, z, id) => this.sendEdit(x, y, z, id);
    this.gameWorld.onChunkCreated = (key) => this.requestChunkEdits(key);

    this.net.onMessage = (msg) => this.handle(msg);
    this.net.onStatusChange = (status) => {
      // A socket that comes back after a drop is still outside the room: the
      // server has no memory of us, so re-issue the join before reporting up.
      if (status === 'connected' && !this.ended) this.rejoin();
      this.events.onStatusChange(status);
    };

    // Chunks streamed in before the session existed still need their edits.
    for (const key of this.gameWorld.chunks.keys()) this.requestChunkEdits(key);
  }

  get ping(): number | null {
    return this.net.ping;
  }

  get status(): ConnectionStatus {
    return this.net.status;
  }

  get playerCount(): number {
    return this.players.length;
  }

  get isHost(): boolean {
    return this.self.isHost;
  }

  /**
   * Per-frame: throttle our state upward, interpolate everyone else.
   * Yaw/pitch come from the camera, which is the same for keyboard and touch —
   * that is what makes the two control schemes produce identical network state.
   */
  update(now: number, dt: number, yaw: number, pitch: number, playing: boolean): void {
    this.maybeSendState(now, yaw, pitch);
    this.remotePlayers.update(now, dt);
    // Guests render the host's mobs; the host renders its own real ones.
    if (!this.isHost) this.remoteMobs.update(now);
    // Only nudge the local player apart while they are actually in control;
    // shoving a paused or dead player around would be surprising.
    if (playing) {
      separateFromRemotePlayers(this.player.position, this.remotePlayers.all, dt);
    }
  }

  leave(): void {
    this.detach();
    this.net.close();
  }

  /** Unhook from the game world so a later singleplayer session is unaffected. */
  private detach(): void {
    this.gameWorld.onLocalEdit = null;
    this.gameWorld.onChunkCreated = null;
    this.gameWorld.persistEdits = true;
    this.remotePlayers.clear();
    this.remoteMobs.clear();
    clearTimeout(this.chunkRequestTimer);
    this.net.onMessage = null;
  }

  private maybeSendState(now: number, yaw: number, pitch: number): void {
    if (now - this.lastStateSentAt < STATE_INTERVAL_MS) return;
    if (!this.net.isOpen) return;

    const p = this.player.position;
    let flags = 0;
    if (Math.hypot(this.player.velocity.x, this.player.velocity.z) > 0.5) flags |= FLAG_MOVING;
    if (!this.player.onGround) flags |= FLAG_JUMPING;
    if (this.player.onGround) flags |= FLAG_GROUNDED;
    if (this.player.sneaking) flags |= FLAG_SNEAKING;

    // Idle players cost nothing: skip the packet when nothing changed.
    const moved =
      Math.abs(p.x - this.lastSent.x) > POSITION_EPSILON ||
      Math.abs(p.y - this.lastSent.y) > POSITION_EPSILON ||
      Math.abs(p.z - this.lastSent.z) > POSITION_EPSILON ||
      Math.abs(yaw - this.lastSent.yaw) > ANGLE_EPSILON ||
      Math.abs(pitch - this.lastSent.pitch) > ANGLE_EPSILON ||
      flags !== this.lastSent.flags;
    if (!moved) return;

    this.lastStateSentAt = now;
    this.lastSent.x = p.x;
    this.lastSent.y = p.y;
    this.lastSent.z = p.z;
    this.lastSent.yaw = yaw;
    this.lastSent.pitch = pitch;
    this.lastSent.flags = flags;

    // Round to centimetres/milliradians: same visual result, smaller packets.
    this.net.send({
      t: 'player_state',
      s: {
        x: round(p.x, 2),
        y: round(p.y, 2),
        z: round(p.z, 2),
        yaw: round(yaw, 3),
        pitch: round(pitch, 3),
        flags,
      },
    });
  }

  /** Host only: publish a snapshot of every live mob at MOB_SYNC_HZ. */
  syncMobs(now: number, mobs: { id: number; kind: 'zombie' | 'pig'; x: number; y: number; z: number; yaw: number; hp: number }[]): void {
    if (!this.isHost || !this.net.isOpen) return;
    if (this.pendingMobRemovals.length > 0) {
      this.net.send({ t: 'mob_removed', ids: this.pendingMobRemovals.splice(0, MAX_MOBS_PER_MESSAGE) });
    }
    if (now - this.lastMobSyncAt < 1000 / MOB_SYNC_HZ) return;
    this.lastMobSyncAt = now;
    const payload: MobStateData[] = mobs.slice(0, MAX_MOBS_PER_MESSAGE).map((m) => ({
      i: m.id,
      k: m.kind === 'pig' ? MOB_KIND_PIG : MOB_KIND_ZOMBIE,
      x: round(m.x, 2),
      y: round(m.y, 2),
      z: round(m.z, 2),
      yaw: round(m.yaw, 2),
      hp: Math.max(0, Math.round(m.hp)),
    }));
    this.net.send({ t: 'mob_state', mobs: payload });
  }

  /** Host only: tell guests a mob is gone (died or despawned). */
  noteMobRemoved(id: number): void {
    if (this.isHost) this.pendingMobRemovals.push(id);
  }

  /** Melee or arrow hit on another player; the server arbitrates. */
  attackPlayer(targetId: string, damage: number): void {
    this.net.send({ t: 'attack_player', target: targetId, damage });
  }

  /** Guest hit one of the host's mobs; relayed to the host to apply. */
  attackMob(mobId: number, damage: number): void {
    this.net.send({ t: 'attack_mob', mob: mobId, damage });
  }

  /** Share a fired arrow so everyone sees the projectile. */
  sendArrow(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    speed: number,
  ): void {
    this.net.send({
      t: 'arrow_spawn',
      x: round(x, 2), y: round(y, 2), z: round(z, 2),
      dx: round(dx, 3), dy: round(dy, 3), dz: round(dz, 3),
      speed: round(speed, 1),
    });
  }

  /** Report our own health and hunger so the room agrees. */
  sendVitals(now: number, health: number, hunger: number, dead: boolean): void {
    if (now - this.lastVitalsSentAt < 250) return;
    this.lastVitalsSentAt = now;
    this.net.send({ t: 'player_vitals', health, hunger, dead });
  }

  /** Publish worn armour; only sent when it actually changes. */
  sendEquipment(gear: number[]): void {
    const key = gear.join(',');
    if (key === this.lastEquipmentSent) return;
    this.lastEquipmentSent = key;
    this.net.send({ t: 'equipment', gear });
  }

  /** Host only: hand a dead mob's loot to the guest that killed it. */
  grantLoot(toId: string, items: { id: string; count: number }[]): void {
    if (!this.isHost || items.length === 0) return;
    this.net.send({ t: 'loot_grant', to: toId, items });
  }

  sendRespawn(): void {
    this.net.send({ t: 'respawn' });
  }

  private sendEdit(x: number, y: number, z: number, id: number): void {
    if (!this.net.isOpen) return;
    if (id === 0) this.net.send({ t: 'block_break', x, y, z });
    else this.net.send({ t: 'block_place', x, y, z, id });
  }

  /** Ask once per chunk; requests are coalesced into batched messages. */
  private requestChunkEdits(key: string): void {
    if (this.requestedChunks.has(key)) return;
    this.requestedChunks.add(key);
    this.pendingChunkRequests.push(key);
    this.scheduleChunkRequestFlush();
  }

  private scheduleChunkRequestFlush(): void {
    if (this.chunkRequestTimer) return;
    this.chunkRequestTimer = window.setTimeout(() => {
      this.chunkRequestTimer = 0;
      const keys = this.pendingChunkRequests.splice(0, MAX_CHUNK_REQUEST);
      // Anything above the per-message cap stays queued for the next flush.
      if (this.pendingChunkRequests.length > 0) this.scheduleChunkRequestFlush();
      if (keys.length > 0 && this.net.isOpen) {
        this.net.send({ t: 'chunk_edits_request', keys });
      }
    }, CHUNK_REQUEST_FLUSH_MS);
  }

  /** Re-enter the room after the socket dropped and came back. */
  private rejoin(): void {
    // The session only exists after a successful join, and NetClient does not
    // re-fire an unchanged status, so any 'connected' seen here is a reconnect.
    if (this.ended || !this.net.isOpen) return;
    this.net.send({
      t: 'join_room',
      code: this.code,
      name: this.self.name,
      version: PROTOCOL_VERSION,
    });
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'join_success': {
        // Reconnected: we get a fresh player id, and may have missed edits
        // while offline, so forget what we've requested and ask again.
        this.self = msg.self;
        this.players = msg.players;
        this.remotePlayers.sync(msg.players, this.self.id);
        this.events.onRosterChange(msg.players);
        this.requestedChunks.clear();
        this.pendingChunkRequests.length = 0;
        for (const key of this.gameWorld.chunks.keys()) this.requestChunkEdits(key);
        this.events.onNotice('Reconnected.');
        return;
      }
      case 'join_error': {
        // The room filled up or ended while we were away.
        this.ended = true;
        this.detach();
        this.net.close();
        this.events.onRoomClosed(msg.message);
        return;
      }
      case 'player_joined': {
        this.players = msg.players;
        this.remotePlayers.sync(msg.players, this.self.id);
        for (const p of msg.players) this.remotePlayers.applyEquipment(p.id, p.equipment);
        this.events.onRosterChange(msg.players);
        this.events.onNotice(`${msg.player.name} joined the world.`);
        return;
      }
      case 'player_left': {
        const who = this.players.find((p) => p.id === msg.id);
        this.players = msg.players;
        this.remotePlayers.sync(msg.players, this.self.id);
        this.events.onRosterChange(msg.players);
        if (who) this.events.onNotice(`${who.name} left the world.`);
        return;
      }
      case 'player_state': {
        // Ignore state for anyone not on the roster (stale or spoofed id).
        this.remotePlayers.applyState(msg.id, msg.s, Date.now());
        return;
      }
      case 'block_update': {
        if (!isSaneEdit(msg.x, msg.y, msg.z, msg.id)) return;
        this.gameWorld.applyRemoteEdit(msg.x, msg.y, msg.z, msg.id);
        return;
      }
      case 'chunk_edits': {
        for (const entry of msg.entries) {
          if (!Array.isArray(entry.data)) continue;
          this.gameWorld.applyChunkEdits(entry.key, entry.data);
        }
        return;
      }
      case 'player_hurt': {
        const existing = this.vitals.get(msg.id);
        this.vitals.set(msg.id, {
          id: msg.id,
          health: msg.health,
          hunger: existing?.hunger ?? 20,
          dead: msg.dead,
        });
        this.remotePlayers.applyHealth(msg.id, msg.health);
        if (msg.id === this.self.id) {
          const attacker = this.players.find((p) => p.id === msg.by);
          this.events.onDamaged(msg.damage, attacker?.name ?? 'someone');
        }
        return;
      }
      case 'player_vitals': {
        for (const v of msg.vitals) {
          this.vitals.set(v.id, v);
          this.remotePlayers.applyHealth(v.id, v.health);
        }
        return;
      }
      case 'player_respawned': {
        this.vitals.set(msg.id, { id: msg.id, health: 20, hunger: 20, dead: false });
        this.remotePlayers.applyHealth(msg.id, 20);
        return;
      }
      case 'mob_state': {
        if (!this.isHost) this.remoteMobs.applySnapshot(msg.mobs, Date.now());
        return;
      }
      case 'mob_removed': {
        if (!this.isHost) this.remoteMobs.remove(msg.ids);
        return;
      }
      case 'attack_mob': {
        // Host applies a guest's hit to the real mob it owns.
        if (this.isHost) this.events.onMobAttacked(msg.mob, msg.damage, msg.by);
        return;
      }
      case 'arrow_spawn': {
        // Fast-forward by the trip time so the arrow appears where it really is
        // rather than trailing the shooter's view by a round trip.
        const age = Math.max(0, Math.min(2000, Date.now() - msg.sentAt));
        this.events.onRemoteArrow(
          msg.x, msg.y, msg.z, msg.dx, msg.dy, msg.dz, msg.speed, msg.by, age,
        );
        return;
      }
      case 'player_equipment': {
        this.remotePlayers.applyEquipment(msg.id, msg.gear);
        return;
      }
      case 'loot_grant': {
        this.events.onLootGranted(msg.items);
        return;
      }
      case 'room_closed': {
        // Close the socket too, or the reconnect loop would resurrect it and
        // overwrite this notice with a misleading "Connected".
        this.ended = true;
        this.detach();
        this.net.close();
        this.events.onRoomClosed(msg.message);
        return;
      }
      case 'error': {
        this.events.onNotice(msg.message);
        return;
      }
      default:
        return;
    }
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Defence in depth: the server validates too, but never trust the wire. */
function isSaneEdit(x: number, y: number, z: number, id: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  return Number.isInteger(id) && id >= 0 && id < BLOCKS.length;
}

/**
 * The protocol hardcodes world limits so the server never imports game code.
 * Warn loudly if the game outgrows them, since edits would then be rejected.
 */
function assertProtocolMatchesGame(): void {
  if (WORLD_HEIGHT !== WORLD_HEIGHT_LIMIT) {
    console.warn(
      `[net] WORLD_HEIGHT (${WORLD_HEIGHT}) != protocol WORLD_HEIGHT_LIMIT (${WORLD_HEIGHT_LIMIT}); update protocol.ts`,
    );
  }
  if (BLOCKS.length - 1 !== MAX_BLOCK_ID) {
    console.warn(
      `[net] block count (${BLOCKS.length - 1}) != protocol MAX_BLOCK_ID (${MAX_BLOCK_ID}); update protocol.ts`,
    );
  }
}
