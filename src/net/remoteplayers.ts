// Visual representation of other players: a blocky body reusing the mob model
// builder, a floating name label, and snapshot interpolation so remote motion
// stays smooth at 60+ FPS despite arriving ~15 times a second.

import * as THREE from 'three';
import {
  FLAG_JUMPING,
  FLAG_MOVING,
  FLAG_SWINGING,
  INTERPOLATION_DELAY_MS,
  type PlayerInfo,
  type PlayerStateData,
} from './protocol';
import {
  Rig,
  WALK_PHASE_PER_BLOCK,
  type BoxPart,
  type RigSegment,
} from '../entities/models';
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from '../constants';

/** How long one attack/mining stroke plays on a remote body. */
const SWING_TIME_S = 0.3;

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

/** Armour tier colours, indexed 1..3 (0 = nothing worn). */
const ARMOR_COLORS = [0, 0xa06a3c, 0xd8d8d8, 0x5cdbd5];
/** How far armour boxes are inflated past the body, so they read as worn. */
const ARMOR_PAD = 0.06;

/**
 * A player body as jointed segments. Limb boxes hang below their pivot so a
 * rotation about the shoulder or hip reads as a swing, not a spin.
 *
 * Armour is drawn as slightly larger shells over the body parts, so a glance
 * tells you how well protected another player is — and because each shell
 * lives in the same segment as the limb it covers, it swings along with it.
 */
function playerSegments(color: number, gear: number[]): RigSegment[] {
  const skin = 0xd8b18a;
  const legColor = 0x394a6b;
  const [headTier, chestTier, legsTier, feetTier] = gear;

  const head: BoxPart[] = [{ pos: [0, 0.25, 0], size: [0.5, 0.5, 0.5], color: skin }];
  if (headTier > 0) {
    head.push({
      pos: [0, 0.25, 0],
      size: [0.5 + ARMOR_PAD, 0.5 + ARMOR_PAD, 0.5 + ARMOR_PAD],
      color: ARMOR_COLORS[headTier],
    });
  }

  const torso: BoxPart[] = [{ pos: [0, 1.0, 0], size: [0.55, 0.7, 0.28], color }];
  if (chestTier > 0) {
    torso.push({
      pos: [0, 1.0, 0],
      size: [0.55 + ARMOR_PAD, 0.7 + ARMOR_PAD * 0.5, 0.28 + ARMOR_PAD],
      color: ARMOR_COLORS[chestTier],
    });
  }

  const arm = (): BoxPart[] => {
    const parts: BoxPart[] = [{ pos: [0, -0.35, 0], size: [0.24, 0.7, 0.24], color }];
    // A pauldron on the upper arm, rotating with the shoulder.
    if (chestTier > 0) {
      parts.push({
        pos: [0, -0.17, 0],
        size: [0.24 + ARMOR_PAD, 0.3, 0.24 + ARMOR_PAD],
        color: ARMOR_COLORS[chestTier],
      });
    }
    return parts;
  };

  const leg = (): BoxPart[] => {
    const parts: BoxPart[] = [{ pos: [0, -0.33, 0], size: [0.26, 0.65, 0.26], color: legColor }];
    if (legsTier > 0) {
      parts.push({
        pos: [0, -0.19, 0],
        size: [0.26 + ARMOR_PAD, 0.42, 0.26 + ARMOR_PAD],
        color: ARMOR_COLORS[legsTier],
      });
    }
    if (feetTier > 0) {
      parts.push({
        pos: [0, -0.55, 0],
        size: [0.26 + ARMOR_PAD, 0.2, 0.26 + ARMOR_PAD * 2],
        color: ARMOR_COLORS[feetTier],
      });
    }
    return parts;
  };

  return [
    { name: 'head', pivot: [0, 1.37, 0], parts: head },
    { name: 'torso', pivot: [0, 0, 0], parts: torso },
    { name: 'armL', pivot: [-0.4, 1.35, 0], parts: arm() },
    { name: 'armR', pivot: [0.4, 1.35, 0], parts: arm() },
    { name: 'legL', pivot: [-0.14, 0.65, 0], parts: leg() },
    { name: 'legR', pivot: [0.14, 0.65, 0], parts: leg() },
  ];
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

  /** Public so tests can inspect the pose; treat as read-only. */
  rig: Rig;
  private readonly label: THREE.Sprite;
  private readonly healthBar: THREE.Mesh;
  private readonly snapshots: Snapshot[] = [];
  private gear: number[];
  private articulated: boolean;

  /** Gait position, advanced by distance walked rather than by time. */
  private walkPhase = 0;
  private walkAmount = 0;
  private swingTime = 0;
  private readonly lastRendered = new THREE.Vector3();
  private hasRendered = false;

  constructor(info: PlayerInfo, articulated = true) {
    this.info = info;
    this.articulated = articulated;
    this.gear = normalizeGear(info.equipment);
    this.rig = this.buildRig();
    this.label = makeNameLabel(info.name);
    this.healthBar = makeHealthBar();
    this.group.add(this.rig.group, this.label, this.healthBar);
    this.group.visible = false; // until the first snapshot arrives
  }

  private buildRig(): Rig {
    // Cache key covers colour and armour, so two players in identical gear
    // share every buffer.
    return new Rig(
      `player|${this.info.colorIndex}|${this.gear.join(',')}`,
      () => playerSegments(BODY_COLORS[this.info.colorIndex % BODY_COLORS.length], this.gear),
      this.articulated,
    );
  }

  private rebuild(): void {
    this.group.remove(this.rig.group);
    this.rig.dispose();
    this.rig = this.buildRig();
    this.group.add(this.rig.group);
  }

  /** Swap in new armour; geometry is shared per (colour, gear) combination. */
  setEquipment(gear: number[]): void {
    const next = normalizeGear(gear);
    if (next.join(',') === this.gear.join(',')) return;
    this.gear = next;
    this.rebuild();
  }

  /** Turn limb animation on or off (the quality ladder's last resort). */
  setArticulated(on: boolean): void {
    if (on === this.articulated) return;
    this.articulated = on;
    this.rebuild();
  }

  /** Show a small bar under the name when the player is hurt. */
  setHealth(health: number, maxHealth = 20): void {
    const fraction = Math.max(0, Math.min(1, health / maxHealth));
    this.healthBar.visible = fraction < 1;
    this.healthBar.scale.x = Math.max(0.001, fraction);
    // Slide the shrinking bar so it drains from the right, not the centre.
    this.healthBar.position.x = -(1 - fraction) * HEALTH_BAR_WIDTH * 0.5;
    const mat = this.healthBar.material as THREE.MeshBasicMaterial;
    mat.color.setHex(fraction > 0.5 ? 0x4ad24a : fraction > 0.25 ? 0xd2c94a : 0xd24a4a);
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

    const flags = (newer ?? older).flags;
    const jumping = (flags & FLAG_JUMPING) !== 0;

    // Drive the gait from distance actually covered on screen, so the legs
    // match the ground however jittery the packets were. FLAG_MOVING gates it
    // so a player being shoved around does not appear to stroll.
    const moving = (flags & FLAG_MOVING) !== 0;
    if (this.hasRendered) {
      const stepped = Math.hypot(x - this.lastRendered.x, z - this.lastRendered.z);
      this.walkPhase += stepped * WALK_PHASE_PER_BLOCK;
      const speed = dt > 0 ? stepped / dt : 0;
      const target = moving ? Math.min(1, speed / 4) : 0;
      this.walkAmount += (target - this.walkAmount) * Math.min(1, dt * 9);
    }
    this.lastRendered.set(x, y, z);
    this.hasRendered = true;

    // Start a stroke whenever the flag is up and the last one has finished.
    //
    // Deliberately NOT edge-triggered: the flag is a level sampled ~15 times a
    // second, and someone mining continuously holds it up with only millisecond
    // gaps between strokes. Edge-triggering would show one swing and then a
    // frozen arm for the rest of the dig. Replaying while it is held gives the
    // repeated strokes that mining actually looks like, and a single swing
    // still plays once because the flag clears before the stroke ends.
    if ((flags & FLAG_SWINGING) !== 0 && this.swingTime === 0) this.swingTime = SWING_TIME_S;
    this.swingTime = Math.max(0, this.swingTime - dt);
    const swing = this.swingTime > 0 ? 1 - this.swingTime / SWING_TIME_S : 0;

    this.rig.pose(this.walkPhase, this.walkAmount, swing, pitch);

    // A jumping body lifts slightly; the label rides along with it.
    const lift = jumping ? 0.05 : 0;
    this.rig.group.position.y = lift;
    this.label.position.y = PLAYER_HEIGHT + 0.45 + lift;
    this.healthBar.position.y = PLAYER_HEIGHT + 0.24 + lift;
  }

  dispose(): void {
    // Body geometry is shared per (colour, gear); these two are per-player.
    this.label.material.map?.dispose();
    this.label.material.dispose();
    this.healthBar.geometry.dispose();
    (this.healthBar.material as THREE.Material).dispose();
  }
}

const HEALTH_BAR_WIDTH = 0.7;

/** A flat quad that always faces the camera, used as a tiny health bar. */
function makeHealthBar(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, 0.08);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: 0x4ad24a, depthTest: false, transparent: true }),
  );
  mesh.position.y = PLAYER_HEIGHT + 0.24;
  mesh.renderOrder = 2;
  mesh.visible = false;
  mesh.onBeforeRender = (_r, _s, camera) => {
    // Billboard: copy the camera's orientation each frame.
    mesh.quaternion.copy(camera.quaternion);
  };
  return mesh;
}

function normalizeGear(gear: number[] | undefined): number[] {
  const out = [0, 0, 0, 0];
  if (!Array.isArray(gear)) return out;
  for (let i = 0; i < 4; i++) {
    const v = gear[i];
    out[i] = Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0;
  }
  return out;
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class RemotePlayerManager {
  private readonly players = new Map<string, RemotePlayer>();
  /** Remembered so players joining after a quality change match everyone else. */
  private articulated = true;

  constructor(private readonly scene: THREE.Scene) {}

  add(info: PlayerInfo): void {
    if (this.players.has(info.id)) return; // never duplicate a player
    const player = new RemotePlayer(info, this.articulated);
    this.players.set(info.id, player);
    this.scene.add(player.group);
  }

  /** Turn limb animation on or off for present and future bodies alike. */
  setArticulated(on: boolean): void {
    this.articulated = on;
    for (const player of this.players.values()) player.setArticulated(on);
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

  applyEquipment(id: string, gear: number[]): void {
    this.players.get(id)?.setEquipment(gear);
  }

  applyHealth(id: string, health: number): void {
    this.players.get(id)?.setHealth(health);
  }

  get(id: string): RemotePlayer | undefined {
    return this.players.get(id);
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
