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
  FLAG_DEAD,
  FLAG_GROUNDED,
  FLAG_HURT,
  FLAG_JUMPING,
  FLAG_MOVING,
  FLAG_SLEEPING,
  FLAG_SNEAKING,
  FLAG_SPRINTING,
  FLAG_SWINGING,
  FLAG_USING,
  MAX_BLOCK_ID,
  MAX_CHUNK_REQUEST,
  PROTOCOL_VERSION,
  STATE_SEND_HZ,
  receiveClock,
  WORLD_HEIGHT_LIMIT,
  type ClickButton,
  type ContainerStateData,
  type InventoryStateData,
  type PlayerInfo,
  type PlayerVitals,
  type ServerMessage,
  type SlotRef,
  type WorldInfo,
  type WorldStateData,
} from './protocol';
import { RemotePlayerManager, separateFromRemotePlayers } from './remoteplayers';

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
  /** An authoritative world snapshot: time, mobs and dropped items. */
  onWorldState(state: WorldStateData): void;
  /** Something hit us; shove the local player away from it. */
  onKnockback(fromX: number, fromZ: number, strength: number): void;
  /**
   * Someone else fired an arrow; spawn a copy locally. `ageMs` is how long ago
   * the server saw it, so the receiver can fast-forward out the latency.
   */
  onRemoteArrow(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    speed: number, ownerId: string, ageMs: number,
  ): void;
  /** The server's copy of our inventory, after one of our actions or a pickup. */
  onInventory(state: InventoryStateData): void;
  /** The chest or furnace we have open changed. */
  onContainer(state: ContainerStateData): void;
  onContainerClosed(): void;
  /** Our health and hunger as the server now has them (eating, sleeping). */
  onVitalsSet(health: number, hunger: number): void;
  onSleepResult(sleeping: boolean, message?: string): void;
}

/** Local-player facts the state packet carries beyond position and look. */
export interface StateFlags {
  swinging: boolean;
  using: boolean;
  hurt: boolean;
  dead: boolean;
  sleeping: boolean;
}

export class MultiplayerSession {
  readonly remotePlayers: RemotePlayerManager;
  /** Server-tracked health for every player, for name-plate health bars. */
  vitals = new Map<string, PlayerVitals>();
  readonly world: WorldInfo;
  readonly code: string;
  self: PlayerInfo;
  players: PlayerInfo[] = [];
  /** Set once the server shuts the room down. */
  ended = false;
  /**
   * Set by the game loop each frame; sent to other clients so they animate
   * our body. Kept as fields rather than `update` arguments because they
   * change independently of position and look.
   */
  readonly flags: StateFlags = { swinging: false, using: false, hurt: false, dead: false, sleeping: false };

  private lastStateSentAt = 0;
  private lastVitalsSentAt = 0;
  private readonly lastSent = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, flags: -1, held: '' };
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
    /** Our stable player key, needed to rejoin after a reconnect. */
    private readonly key: string,
    private readonly events: SessionEvents,
  ) {
    this.remotePlayers = new RemotePlayerManager(scene);
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
    if (this.player.sprinting) flags |= FLAG_SPRINTING;
    if (this.flags.swinging) flags |= FLAG_SWINGING;
    if (this.flags.using) flags |= FLAG_USING;
    if (this.flags.hurt) flags |= FLAG_HURT;
    if (this.flags.dead) flags |= FLAG_DEAD;
    if (this.flags.sleeping) flags |= FLAG_SLEEPING;

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
    // The held item is filled in by the server from its own copy of the hand.
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

  // --- Inventory and world actions (server-authoritative) -----------------

  /** Throw the held stack, or one of it (vanilla's Q / Ctrl+Q). */
  dropItem(seq: number, all: boolean): void {
    this.net.send({ t: 'drop_item', seq, all });
  }

  selectSlot(index: number): void {
    this.net.send({ t: 'select_slot', index });
  }

  clickSlot(seq: number, slot: SlotRef, button: ClickButton, shift: boolean): void {
    this.net.send({ t: 'inv_click', seq, slot, button, shift });
  }

  craft(seq: number, all: boolean): void {
    this.net.send({ t: 'inv_craft', seq, all });
  }

  closeInventory(seq: number): void {
    this.net.send({ t: 'inv_close', seq });
  }

  openContainer(x: number, y: number, z: number): void {
    this.net.send({ t: 'open_container', x, y, z });
  }

  openGrid(size: 2 | 3, at?: { x: number; y: number; z: number }): void {
    this.net.send({ t: 'open_grid', size, ...(at ?? {}) });
  }

  till(x: number, y: number, z: number): void {
    this.net.send({ t: 'till', x, y, z });
  }

  eat(seq: number): void {
    this.net.send({ t: 'eat', seq });
  }

  sleep(x: number, y: number, z: number): void {
    this.net.send({ t: 'sleep', x, y, z });
  }

  wake(): void {
    this.net.send({ t: 'wake' });
  }

  /**
   * Melee or arrow hit on another player; the server arbitrates. `ranged`
   * tells it the shove is an arrow's rather than the held item's — the server
   * looks the strength itself up either way.
   */
  attackPlayer(targetId: string, damage: number, ranged = false): void {
    this.net.send({ t: 'attack_player', target: targetId, damage, ...(ranged ? { ranged } : {}) });
  }

  /** Hit a mob; the server owns mob health and arbitrates the swing. */
  attackMob(mobId: number, damage: number, ranged = false): void {
    this.net.send({ t: 'attack_mob', mob: mobId, damage, ...(ranged ? { ranged } : {}) });
  }

  /** Use the held item on a mob: shears on a sheep. */
  useOnMob(mobId: number): void {
    this.net.send({ t: 'use_on_mob', mob: mobId });
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
      key: this.key,
    });
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'join_success': {
        // Reconnected: we get a fresh player id, and may have missed edits
        // while offline, so forget what we've requested and ask again. Our
        // inventory follows in its own message, keyed by the player key.
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
      case 'host_changed': {
        this.players = msg.players;
        const me = msg.players.find((p) => p.id === this.self.id);
        if (me) this.self = me;
        this.events.onRosterChange(msg.players);
        const host = msg.players.find((p) => p.id === msg.id);
        if (host && host.id !== this.self.id) this.events.onNotice(`${host.name} is now the host.`);
        else if (host) this.events.onNotice('You are now the host.');
        return;
      }
      case 'player_state': {
        // Ignore state for anyone not on the roster (stale or spoofed id).
        // Stamped with the SAME clock the frame loop interpolates against —
        // see receiveClock().
        this.remotePlayers.applyState(msg.id, msg.s, receiveClock());
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
          this.events.onDamaged(msg.damage, attacker?.name ?? (msg.by === 'mob' ? 'A mob' : 'someone'));
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
      case 'world_state': {
        // The server owns mobs, dropped items and the clock.
        const { t: _t, ...state } = msg;
        this.events.onWorldState(state);
        return;
      }
      case 'knockback': {
        this.events.onKnockback(msg.fromX, msg.fromZ, msg.strength);
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
      case 'inventory': {
        const { t: _t, ...state } = msg;
        this.events.onInventory(state);
        return;
      }
      case 'container': {
        const { t: _t, ...state } = msg;
        this.events.onContainer(state);
        return;
      }
      case 'container_closed': {
        this.events.onContainerClosed();
        return;
      }
      case 'vitals_set': {
        this.events.onVitalsSet(msg.health, msg.hunger);
        return;
      }
      case 'sleep_result': {
        this.events.onSleepResult(msg.sleeping, msg.message);
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
