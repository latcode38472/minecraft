// Visual representation of other players: a blocky body reusing the mob model
// builder, a floating name label, and snapshot interpolation so remote motion
// stays smooth at 60+ FPS despite arriving ~15 times a second.

import * as THREE from 'three';
import {
  FLAG_JUMPING,
  FLAG_MOVING,
  INTERPOLATION_DELAY_MS,
  type PlayerInfo,
  type PlayerStateData,
} from './protocol';
import { buildBoxGeometry, getMobMaterial, type BoxPart } from '../entities/models';
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from '../constants';

/** One colour per room slot so the three players are always distinguishable. */
const BODY_COLORS = [0x4f8fd6, 0xd6644f, 0x63b558];
const SNAPSHOT_BUFFER = 20;
/** Beyond this gap we snap instead of interpolating (teleport or long stall). */
const SNAP_DISTANCE = 12;

interface Snapshot {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
}

function playerParts(color: number): BoxPart[] {
  const skin = 0xd8b18a;
  const legs = 0x394a6b;
  return [
    { pos: [0, 1.62, 0], size: [0.5, 0.5, 0.5], color: skin }, // head
    { pos: [0, 1.0, 0], size: [0.55, 0.7, 0.28], color }, // torso
    { pos: [-0.4, 1.0, 0], size: [0.24, 0.7, 0.24], color }, // arms
    { pos: [0.4, 1.0, 0], size: [0.24, 0.7, 0.24], color },
    { pos: [-0.14, 0.32, 0], size: [0.26, 0.65, 0.26], color: legs }, // legs
    { pos: [0.14, 0.32, 0], size: [0.26, 0.65, 0.26], color: legs },
  ];
}

const geometryCache = new Map<number, THREE.BufferGeometry>();

function bodyGeometry(colorIndex: number): THREE.BufferGeometry {
  let geo = geometryCache.get(colorIndex);
  if (!geo) {
    geo = buildBoxGeometry(playerParts(BODY_COLORS[colorIndex % BODY_COLORS.length]));
    geometryCache.set(colorIndex, geo);
  }
  return geo;
}

/** Render a name onto a canvas sprite that always faces the camera. */
function makeNameLabel(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = 'bold 40px "Courier New", monospace';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(name).width) + 32;
  canvas.width = width;
  canvas.height = 64;

  const draw = ctx;
  draw.font = font;
  draw.textAlign = 'center';
  draw.textBaseline = 'middle';
  draw.fillStyle = 'rgba(0,0,0,0.55)';
  draw.fillRect(0, 0, canvas.width, canvas.height);
  draw.fillStyle = '#ffffff';
  draw.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  // Keep glyph aspect ratio; 0.5 world units tall reads well at a distance.
  sprite.scale.set((canvas.width / canvas.height) * 0.5, 0.5, 1);
  sprite.position.y = PLAYER_HEIGHT + 0.45;
  sprite.renderOrder = 2;
  return sprite;
}

export class RemotePlayer {
  readonly group = new THREE.Group();
  readonly info: PlayerInfo;
  /** Latest interpolated position; used for player-vs-player separation. */
  readonly position = new THREE.Vector3();

  private readonly body: THREE.Mesh;
  private readonly label: THREE.Sprite;
  private readonly snapshots: Snapshot[] = [];
  private bobPhase = 0;

  constructor(info: PlayerInfo) {
    this.info = info;
    this.body = new THREE.Mesh(bodyGeometry(info.colorIndex), getMobMaterial());
    this.label = makeNameLabel(info.name);
    this.group.add(this.body, this.label);
    this.group.visible = false; // until the first snapshot arrives
  }

  pushState(state: PlayerStateData, now: number): void {
    this.snapshots.push({ time: now, ...state });
    if (this.snapshots.length > SNAPSHOT_BUFFER) this.snapshots.shift();
  }

  /**
   * Render the player as they were INTERPOLATION_DELAY_MS ago, blending the two
   * snapshots that straddle that moment. Rendering slightly in the past is what
   * lets the motion stay continuous between packets.
   */
  update(now: number, dt: number): void {
    if (this.snapshots.length === 0) return;
    const target = now - INTERPOLATION_DELAY_MS;

    let older: Snapshot | null = null;
    let newer: Snapshot | null = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].time <= target) {
        older = this.snapshots[i];
        newer = this.snapshots[i + 1] ?? null;
        break;
      }
    }
    // Before the buffer covers the delay, hold at the oldest known sample.
    if (!older) older = this.snapshots[0];

    let x = older.x;
    let y = older.y;
    let z = older.z;
    let yaw = older.yaw;
    let pitch = older.pitch;

    if (newer && newer.time > older.time) {
      const span = newer.time - older.time;
      const f = Math.max(0, Math.min(1, (target - older.time) / span));
      const dist = Math.hypot(newer.x - older.x, newer.y - older.y, newer.z - older.z);
      if (dist > SNAP_DISTANCE) {
        x = newer.x;
        y = newer.y;
        z = newer.z;
        yaw = newer.yaw;
        pitch = newer.pitch;
      } else {
        x = older.x + (newer.x - older.x) * f;
        y = older.y + (newer.y - older.y) * f;
        z = older.z + (newer.z - older.z) * f;
        yaw = older.yaw + shortestAngle(older.yaw, newer.yaw) * f;
        pitch = older.pitch + (newer.pitch - older.pitch) * f;
      }
    }

    this.position.set(x, y, z);
    this.group.position.set(x, y, z);
    // Models face +Z; yaw here matches the local camera's convention.
    this.group.rotation.y = yaw + Math.PI;
    this.group.visible = true;

    // A little walk bob and head tilt so remote players read as alive.
    const flags = (newer ?? older).flags;
    const moving = (flags & FLAG_MOVING) !== 0;
    const jumping = (flags & FLAG_JUMPING) !== 0;
    this.bobPhase = moving ? this.bobPhase + dt * 9 : 0;
    const bob = moving ? Math.abs(Math.sin(this.bobPhase)) * 0.06 : 0;
    this.body.position.y = bob + (jumping ? 0.05 : 0);
    this.body.rotation.x = Math.max(-0.5, Math.min(0.5, pitch)) * 0.15;
    this.label.position.y = PLAYER_HEIGHT + 0.45 + bob;
  }

  dispose(): void {
    // Geometry is shared per colour; only the label is per-player.
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class RemotePlayerManager {
  private readonly players = new Map<string, RemotePlayer>();

  constructor(private readonly scene: THREE.Scene) {}

  add(info: PlayerInfo): void {
    if (this.players.has(info.id)) return; // never duplicate a player
    const player = new RemotePlayer(info);
    this.players.set(info.id, player);
    this.scene.add(player.group);
  }

  remove(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    this.scene.remove(player.group);
    player.dispose();
    this.players.delete(id);
  }

  /** Reconcile against an authoritative roster, dropping ghosts. */
  sync(roster: PlayerInfo[], selfId: string): void {
    const alive = new Set<string>();
    for (const info of roster) {
      if (info.id === selfId) continue;
      alive.add(info.id);
      this.add(info);
    }
    for (const id of [...this.players.keys()]) {
      if (!alive.has(id)) this.remove(id);
    }
  }

  applyState(id: string, state: PlayerStateData, now: number): void {
    this.players.get(id)?.pushState(state, now);
  }

  update(now: number, dt: number): void {
    for (const player of this.players.values()) player.update(now, dt);
  }

  get all(): RemotePlayer[] {
    return [...this.players.values()];
  }

  get count(): number {
    return this.players.size;
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id);
  }
}

/**
 * Push the local player out of remote players they overlap.
 *
 * This runs AFTER terrain collision and only nudges horizontally, so it cannot
 * interfere with voxel collision or launch anyone through the ground — the
 * worst case is a soft shove. Remote bodies are otherwise non-solid.
 */
export function separateFromRemotePlayers(
  localPos: THREE.Vector3,
  remotes: RemotePlayer[],
  dt: number,
): void {
  const minDistance = PLAYER_HALF_WIDTH * 2 + 0.1;
  for (const remote of remotes) {
    if (!remote.group.visible) continue;
    // Only push when the two bodies actually overlap vertically.
    if (Math.abs(remote.position.y - localPos.y) > PLAYER_HEIGHT * 0.9) continue;
    const dx = localPos.x - remote.position.x;
    const dz = localPos.z - remote.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist >= minDistance) continue;
    const push = (minDistance - dist) * Math.min(1, dt * 12);
    if (dist < 1e-4) {
      // Exactly co-located: pick a deterministic direction instead of NaN.
      localPos.x += push;
    } else {
      localPos.x += (dx / dist) * push;
      localPos.z += (dz / dist) * push;
    }
  }
}
