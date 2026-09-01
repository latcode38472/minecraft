// Guest-side view of the host's mobs.
//
// Mobs are simulated only by the host — one simulation means everyone agrees
// about who is alive and where. Guests receive ~10 snapshots a second and
// interpolate between them, exactly as they do for remote players, so the
// motion still looks smooth at 60+ FPS.

import * as THREE from 'three';
import {
  INTERPOLATION_DELAY_MS,
  MOB_KIND_PIG,
  type MobStateData,
} from './protocol';
import {
  PIG_PARTS,
  ZOMBIE_PARTS,
  cachedGeometry,
  getMobHurtMaterial,
  getMobMaterial,
} from '../entities/models';

const SNAPSHOT_BUFFER = 16;
const SNAP_DISTANCE = 12;

interface MobSnapshot {
  time: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
}

/** Body sizes must match the real mobs so arrows and melee line up. */
const MOB_SHAPES = {
  [MOB_KIND_PIG]: { halfWidth: 0.45, height: 0.9 },
  zombie: { halfWidth: 0.3, height: 1.95 },
} as const;

export class RemoteMob {
  readonly mesh: THREE.Mesh;
  readonly position = new THREE.Vector3();
  readonly id: number;
  readonly kind: number;
  readonly halfWidth: number;
  readonly height: number;
  health: number;

  private readonly snapshots: MobSnapshot[] = [];
  private previousHp: number;

  constructor(state: MobStateData) {
    this.id = state.i;
    this.kind = state.k;
    const isPig = state.k === MOB_KIND_PIG;
    const shape = isPig ? MOB_SHAPES[MOB_KIND_PIG] : MOB_SHAPES.zombie;
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

  push(state: MobStateData, now: number): void {
    this.snapshots.push({ time: now, x: state.x, y: state.y, z: state.z, yaw: state.yaw, hp: state.hp });
    if (this.snapshots.length > SNAPSHOT_BUFFER) this.snapshots.shift();
    // A drop in health flashes the mob red, matching local mob feedback.
    if (state.hp < this.previousHp) this.hurtUntil = now + 400;
    this.previousHp = state.hp;
    this.health = state.hp;
  }

  private hurtUntil = 0;

  update(now: number): void {
    if (this.snapshots.length === 0) return;
    const target = now - INTERPOLATION_DELAY_MS;

    let older: MobSnapshot | null = null;
    let newer: MobSnapshot | null = null;
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
      const dist = Math.hypot(newer.x - older.x, newer.y - older.y, newer.z - older.z);
      if (dist > SNAP_DISTANCE) {
        ({ x, y, z, yaw } = newer);
      } else {
        x = older.x + (newer.x - older.x) * f;
        y = older.y + (newer.y - older.y) * f;
        z = older.z + (newer.z - older.z) * f;
        yaw = older.yaw + shortestAngle(older.yaw, newer.yaw) * f;
      }
    }

    this.position.set(x, y, z);
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = yaw;
    this.mesh.visible = true;
    this.mesh.material = now < this.hurtUntil ? getMobHurtMaterial() : getMobMaterial();
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class RemoteMobManager {
  private readonly mobs = new Map<number, RemoteMob>();
  /** Snapshots not seen in the latest update are dropped after this long. */
  private lastSeen = new Map<number, number>();

  constructor(private readonly scene: THREE.Scene) {}

  applySnapshot(states: MobStateData[], now: number): void {
    for (const state of states) {
      let mob = this.mobs.get(state.i);
      if (!mob) {
        mob = new RemoteMob(state);
        this.mobs.set(state.i, mob);
        this.scene.add(mob.mesh);
      }
      mob.push(state, now);
      this.lastSeen.set(state.i, now);
    }
  }

  remove(ids: number[]): void {
    for (const id of ids) {
      const mob = this.mobs.get(id);
      if (!mob) continue;
      this.scene.remove(mob.mesh);
      this.mobs.delete(id);
      this.lastSeen.delete(id);
    }
  }

  update(now: number): void {
    for (const mob of this.mobs.values()) mob.update(now);
    // Reap mobs the host stopped reporting (despawned out of its range).
    for (const [id, seen] of this.lastSeen) {
      if (now - seen > 6000) this.remove([id]);
    }
  }

  /** Nearest mob whose box the ray enters, for guest melee and arrows. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RemoteMob | null {
    let best: RemoteMob | null = null;
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

  get all(): RemoteMob[] {
    return [...this.mobs.values()];
  }

  clear(): void {
    this.remove([...this.mobs.keys()]);
  }
}

function rayBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  mob: RemoteMob,
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
