// Renders the world's mobs and dropped items from simulation snapshots.
//
// One view layer serves both modes. In multiplayer the snapshots arrive from
// the server ~10 times a second and are interpolated so motion stays smooth;
// in singleplayer the local simulation feeds it every frame, so it renders
// positions directly with no added latency.

import * as THREE from 'three';
import { INTERPOLATION_DELAY_MS, MOB_KIND_PIG, type DropStateData, type MobStateData } from '../net/protocol';
import {
  PIG_PARTS,
  ZOMBIE_PARTS,
  cachedGeometry,
  getMobHurtMaterial,
  getMobMaterial,
} from '../entities/models';
import { getItem } from '../items/items';
import { getAtlasTexture, tileUVRect } from '../textures';

const SNAPSHOT_BUFFER = 16;
/** Beyond this gap we snap instead of interpolating (teleport or long stall). */
const SNAP_DISTANCE = 12;
const DROP_SIZE = 0.3;

const MOB_SHAPES = {
  pig: { halfWidth: 0.45, height: 0.9 },
  zombie: { halfWidth: 0.3, height: 1.95 },
} as const;

interface Snapshot {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Shared interpolation buffer used by both mobs and drops. */
class Interpolated {
  readonly position = new THREE.Vector3();
  yaw = 0;
  protected readonly snapshots: Snapshot[] = [];

  push(x: number, y: number, z: number, yaw: number, now: number): void {
    this.snapshots.push({ time: now, x, y, z, yaw });
    if (this.snapshots.length > SNAPSHOT_BUFFER) this.snapshots.shift();
  }

  /** Direct mode (singleplayer): no buffering, no delay. */
  set(x: number, y: number, z: number, yaw: number): void {
    this.position.set(x, y, z);
    this.yaw = yaw;
  }

  /** Render as of INTERPOLATION_DELAY_MS ago, blending the straddling pair. */
  interpolate(now: number): boolean {
    if (this.snapshots.length === 0) return false;
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
    if (!older) older = this.snapshots[0];

    let { x, y, z, yaw } = older;
    if (newer && newer.time > older.time) {
      const f = Math.max(0, Math.min(1, (target - older.time) / (newer.time - older.time)));
      if (Math.hypot(newer.x - older.x, newer.y - older.y, newer.z - older.z) > SNAP_DISTANCE) {
        ({ x, y, z, yaw } = newer);
      } else {
        x = older.x + (newer.x - older.x) * f;
        y = older.y + (newer.y - older.y) * f;
        z = older.z + (newer.z - older.z) * f;
        yaw = older.yaw + shortestAngle(older.yaw, newer.yaw) * f;
      }
    }
    this.position.set(x, y, z);
    this.yaw = yaw;
    return true;
  }
}

export class MobView extends Interpolated {
  readonly mesh: THREE.Mesh;
  readonly id: number;
  readonly kind: number;
  readonly halfWidth: number;
  readonly height: number;
  health: number;
  private hurtUntil = 0;
  private previousHp: number;

  constructor(state: MobStateData) {
    super();
    this.id = state.i;
    this.kind = state.k;
    const isPig = state.k === MOB_KIND_PIG;
    const shape = isPig ? MOB_SHAPES.pig : MOB_SHAPES.zombie;
    this.halfWidth = shape.halfWidth;
    this.height = shape.height;
    this.health = state.hp;
    this.previousHp = state.hp;
    this.mesh = new THREE.Mesh(
      isPig ? cachedGeometry('pig', PIG_PARTS) : cachedGeometry('zombie', ZOMBIE_PARTS),
      getMobMaterial(),
    );
    this.mesh.visible = false;
  }

  apply(state: MobStateData, now: number, direct: boolean): void {
    // A drop in health flashes the mob red, matching local combat feedback.
    if (state.hp < this.previousHp) this.hurtUntil = now + 400;
    this.previousHp = state.hp;
    this.health = state.hp;
    if (direct) this.set(state.x, state.y, state.z, state.yaw);
    else this.push(state.x, state.y, state.z, state.yaw, now);
  }

  render(now: number, direct: boolean): void {
    if (!direct && !this.interpolate(now)) return;
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    this.mesh.visible = true;
    this.mesh.material = now < this.hurtUntil ? getMobHurtMaterial() : getMobMaterial();
  }
}

const dropGeometryCache = new Map<number, THREE.BufferGeometry>();
let dropMaterial: THREE.MeshLambertMaterial | null = null;

function dropGeometry(tile: number): THREE.BufferGeometry {
  let geo = dropGeometryCache.get(tile);
  if (!geo) {
    geo = new THREE.BoxGeometry(DROP_SIZE, DROP_SIZE, DROP_SIZE);
    // Remap the box's per-face [0,1] UVs onto this item's atlas tile.
    const [u0, v0, u1, v1] = tileUVRect(tile);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    }
    uv.needsUpdate = true;
    dropGeometryCache.set(tile, geo);
  }
  return geo;
}

function getDropMaterial(): THREE.MeshLambertMaterial {
  if (!dropMaterial) {
    // Tool icons have transparent pixels; alpha test cuts them out without
    // needing the transparent render pass.
    dropMaterial = new THREE.MeshLambertMaterial({ map: getAtlasTexture(), alphaTest: 0.5 });
  }
  return dropMaterial;
}

export class DropView extends Interpolated {
  readonly mesh: THREE.Mesh;
  readonly id: number;
  count: number;
  private spin = Math.random() * Math.PI * 2;

  constructor(state: DropStateData) {
    super();
    this.id = state.i;
    this.count = state.n;
    const tile = getItem(state.item)?.tile ?? 0;
    this.mesh = new THREE.Mesh(dropGeometry(tile), getDropMaterial());
    this.mesh.visible = false;
  }

  apply(state: DropStateData, now: number, direct: boolean): void {
    this.count = state.n;
    if (direct) this.set(state.x, state.y, state.z, 0);
    else this.push(state.x, state.y, state.z, 0, now);
  }

  render(now: number, dt: number, direct: boolean): void {
    if (!direct && !this.interpolate(now)) return;
    this.spin += dt * 1.8;
    this.mesh.position.set(
      this.position.x,
      this.position.y + DROP_SIZE / 2 + Math.sin(this.spin * 1.4) * 0.06,
      this.position.z,
    );
    this.mesh.rotation.y = this.spin;
    this.mesh.visible = true;
  }
}

/**
 * Owns every mob and dropped item in the scene, whether they come from the
 * server or the local simulation.
 */
export class WorldView {
  /** True in singleplayer: render exactly what the simulation says, now. */
  direct = false;

  private readonly mobs = new Map<number, MobView>();
  private readonly drops = new Map<number, DropView>();
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  applyMobs(states: MobStateData[], now: number): void {
    for (const state of states) {
      let mob = this.mobs.get(state.i);
      if (!mob) {
        mob = new MobView(state);
        this.mobs.set(state.i, mob);
        this.scene.add(mob.mesh);
      }
      mob.apply(state, now, this.direct);
    }
  }

  applyDrops(states: DropStateData[], now: number): void {
    for (const state of states) {
      let drop = this.drops.get(state.i);
      if (!drop) {
        drop = new DropView(state);
        this.drops.set(state.i, drop);
        this.scene.add(drop.mesh);
      }
      drop.apply(state, now, this.direct);
    }
  }

  removeMobs(ids: number[]): void {
    for (const id of ids) {
      const mob = this.mobs.get(id);
      if (!mob) continue;
      this.scene.remove(mob.mesh);
      this.mobs.delete(id);
    }
  }

  removeDrops(ids: number[]): void {
    for (const id of ids) {
      const drop = this.drops.get(id);
      if (!drop) continue;
      this.scene.remove(drop.mesh);
      this.drops.delete(id);
    }
  }

  /** Drop anything the latest snapshot didn't mention (server went quiet). */
  retainMobs(liveIds: Set<number>): void {
    for (const id of [...this.mobs.keys()]) if (!liveIds.has(id)) this.removeMobs([id]);
  }

  retainDrops(liveIds: Set<number>): void {
    for (const id of [...this.drops.keys()]) if (!liveIds.has(id)) this.removeDrops([id]);
  }

  update(now: number, dt: number): void {
    for (const mob of this.mobs.values()) mob.render(now, this.direct);
    for (const drop of this.drops.values()) drop.render(now, dt, this.direct);
  }

  /** Nearest mob under the ray, for melee and arrows. */
  raycastMob(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): MobView | null {
    let best: MobView | null = null;
    let bestT = Infinity;
    for (const mob of this.mobs.values()) {
      if (!mob.mesh.visible) continue;
      const t = rayBox(origin, dir, mob, maxDist);
      if (t !== null && t < bestT) {
        bestT = t;
        best = mob;
      }
    }
    return best;
  }

  get allMobs(): MobView[] {
    return [...this.mobs.values()];
  }

  get mobCount(): number {
    return this.mobs.size;
  }

  get dropCount(): number {
    return this.drops.size;
  }

  clear(): void {
    this.removeMobs([...this.mobs.keys()]);
    this.removeDrops([...this.drops.keys()]);
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function rayBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  mob: MobView,
  maxDist: number,
): number | null {
  const pad = 0.1;
  const min = [
    mob.position.x - mob.halfWidth - pad,
    mob.position.y - pad,
    mob.position.z - mob.halfWidth - pad,
  ];
  const max = [
    mob.position.x + mob.halfWidth + pad,
    mob.position.y + mob.height + pad,
    mob.position.z + mob.halfWidth + pad,
  ];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  let tMin = 0;
  let tMax = maxDist;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-8) {
      if (o[axis] < min[axis] || o[axis] > max[axis]) return null;
      continue;
    }
    const inv = 1 / d[axis];
    let t1 = (min[axis] - o[axis]) * inv;
    let t2 = (max[axis] - o[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}
