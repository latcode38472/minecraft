// Renders the world's mobs and dropped items from simulation snapshots.
//
// One view layer serves both modes. In multiplayer the snapshots arrive from
// the server ~10 times a second and are interpolated so motion stays smooth;
// in singleplayer the local simulation feeds it every frame, so it renders
// positions directly with no added latency.

import * as THREE from 'three';
import {
  INTERPOLATION_DELAY_MS,
  MOB_FLAG_COLOR_MASK,
  MOB_FLAG_COLOR_SHIFT,
  MOB_FLAG_GRAZING,
  MOB_FLAG_HURT,
  MOB_FLAG_SHEARED,
  type ArrowStateData,
  type DropStateData,
  type MobStateData,
} from '../net/protocol';
import {
  COW_SEGMENTS,
  PIG_SEGMENTS,
  Rig,
  SHEEP_SEGMENTS,
  SKELETON_BOW_SEGMENTS,
  SKELETON_SEGMENTS,
  VILLAGER_SEGMENTS,
  WALK_PHASE_PER_BLOCK,
  ZOMBIE_SEGMENTS,
  buildBoxGeometry,
  getMobHurtMaterial,
  getMobMaterial,
} from '../entities/models';
import { getItem } from '../items/items';
import { MOB_DEFS, SHEEP_COLORS, mobKindFromWire, type MobKind } from '../shared/mobs';
import { getAtlasTexture, tileUVRect } from '../textures';

const SNAPSHOT_BUFFER = 16;
/** Beyond this gap we snap instead of interpolating (teleport or long stall). */
const SNAP_DISTANCE = 12;
const DROP_SIZE = 0.3;
/** How long a mob holds its attack pose, so a swing is visible between ticks. */
const ATTACK_POSE_MS = 300;
/** How long a dead mob takes to keel over and fade before it is removed. */
const DEATH_MS = 700;

/** How far the bowstring is pulled back at full draw, in blocks. */
const BOW_PULL = 0.22;

/** Flag bits that change the model itself rather than its pose. */
const MODEL_FLAGS = MOB_FLAG_SHEARED | (MOB_FLAG_COLOR_MASK << MOB_FLAG_COLOR_SHIFT);

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
  readonly object = new THREE.Group();
  readonly id: number;
  readonly kind: number;
  readonly kindName: MobKind;
  readonly halfWidth: number;
  readonly height: number;
  health: number;
  /** Behaviour flags from the last snapshot (MOB_FLAG_*). */
  flags: number;
  /** Set once the mob has died and is keeling over; it can no longer be hit. */
  dying = false;
  /** Set when the death animation has played out and the view can go. */
  finished = false;

  /** Public so tools and tests can inspect the pose; treat as read-only. */
  rig: Rig;
  private hurtUntil = 0;
  private hurtActive = false;
  private previousHp: number;
  private attackUntil = 0;
  private deathStart = 0;
  /** Gait position, advanced by distance travelled rather than by time. */
  private walkPhase = 0;
  private walkAmount = 0;
  private headYaw = 0;
  private shownHeadYaw = 0;
  private graze = 0;
  private readonly lastRendered = new THREE.Vector3();
  private hasRendered = false;
  /** The bow, when this mob carries one. Parented to the arms segment. */
  private bow: Rig | null = null;
  /** Latest reported bow draw, 0..1. */
  private draw = 0;
  private articulated: boolean;

  constructor(state: MobStateData, articulated: boolean) {
    super();
    this.id = state.i;
    this.kind = state.k;
    this.kindName = mobKindFromWire(state.k) ?? 'zombie';
    const shape = MOB_DEFS[this.kindName].shape;
    this.halfWidth = shape.halfWidth;
    this.height = shape.height;
    this.health = state.hp;
    this.previousHp = state.hp;
    this.flags = state.f ?? 0;
    this.articulated = articulated;
    this.rig = this.buildRig();
    this.object.visible = false;
  }

  /** The body is built straight into `object`, so a rebuild swaps nothing in the scene. */
  private buildRig(): Rig {
    const articulated = this.articulated;
    const group = this.object;
    switch (this.kindName) {
      case 'pig':
        return new Rig('pig', PIG_SEGMENTS, articulated, group);
      case 'cow':
        return new Rig('cow', COW_SEGMENTS, articulated, group);
      case 'sheep': {
        const color = (this.flags >> MOB_FLAG_COLOR_SHIFT) & MOB_FLAG_COLOR_MASK;
        const sheared = (this.flags & MOB_FLAG_SHEARED) !== 0;
        const wool = SHEEP_COLORS[color] ?? SHEEP_COLORS[0];
        return new Rig(`sheep|${color}|${sheared ? 1 : 0}`, () => SHEEP_SEGMENTS(wool, sheared), articulated, group);
      }
      case 'villager':
        return new Rig('villager', VILLAGER_SEGMENTS, articulated, group);
      case 'skeleton': {
        const rig = new Rig('skeleton', SKELETON_SEGMENTS, articulated, group);
        // A skeleton carries a bow in the hands the arms rig moves, so parenting
        // it to that segment makes it follow the aim for free.
        this.bow = new Rig('skeleton-bow', SKELETON_BOW_SEGMENTS, articulated);
        this.bow.group.position.set(0, -0.52, 0.22);
        this.bow.group.rotation.y = Math.PI / 2;
        const hands = rig.segments.get('arms');
        if (hands) hands.add(this.bow.group);
        else rig.group.add(this.bow.group); // merged rig: still show the bow
        return rig;
      }
      default:
        return new Rig('zombie', ZOMBIE_SEGMENTS, articulated, group);
    }
  }

  /** Swap the model (sheared, quality change) while keeping everything else. */
  private rebuildRig(): void {
    this.rig.dispose(); // empties the shared group
    this.bow = null;
    this.rig = this.buildRig();
    if (this.hurtActive) this.rig.setMaterial(getMobHurtMaterial());
  }

  setArticulated(on: boolean): void {
    if (on === this.articulated) return;
    this.articulated = on;
    this.rebuildRig();
  }

  apply(state: MobStateData, now: number, direct: boolean): void {
    // A drop in health flashes the mob red, matching local combat feedback.
    const flags = state.f ?? 0;
    if (state.hp < this.previousHp || (flags & MOB_FLAG_HURT && !(this.flags & MOB_FLAG_HURT))) {
      this.hurtUntil = now + 400;
    }
    this.previousHp = state.hp;
    this.health = state.hp;
    // A sheep losing (or regrowing) its wool is a different model.
    if ((flags & MODEL_FLAGS) !== (this.flags & MODEL_FLAGS)) {
      this.flags = flags;
      this.rebuildRig();
    }
    this.flags = flags;
    this.headYaw = state.hy ?? 0;
    // The simulation reports a swing; hold the pose long enough to be seen
    // even when it lands between two snapshots.
    if (state.s) this.attackUntil = Math.max(this.attackUntil, now + ATTACK_POSE_MS);
    // The draw is a level, not an event: it arrives on every snapshot while the
    // bow is bent and is simply absent once it is loosed.
    this.draw = state.d ?? 0;
    if (direct) this.set(state.x, state.y, state.z, state.yaw);
    else this.push(state.x, state.y, state.z, state.yaw, now);
  }

  /** Start the death animation where the mob last stood. */
  kill(now: number): void {
    if (this.dying) return;
    this.dying = true;
    this.deathStart = now;
    this.hurtUntil = now + DEATH_MS;
  }

  render(now: number, dt: number, direct: boolean): void {
    if (!this.dying && !direct && !this.interpolate(now)) return;
    this.object.position.copy(this.position);
    this.object.rotation.set(0, this.yaw, 0);
    this.object.visible = true;

    if (this.dying) {
      // Keel over sideways and sink a little, then go.
      const t = Math.min(1, (now - this.deathStart) / DEATH_MS);
      const ease = 1 - (1 - t) * (1 - t);
      this.object.rotation.z = (ease * Math.PI) / 2;
      this.object.position.y += ease * -0.15 + Math.sin(ease * Math.PI) * 0.1;
      if (t >= 1) this.finished = true;
    } else if (this.hasRendered) {
      // Derive the gait from how far the body actually moved since last frame.
      // Nothing about the walk cycle travels over the wire.
      const moved = Math.hypot(
        this.position.x - this.lastRendered.x,
        this.position.z - this.lastRendered.z,
      );
      this.walkPhase += moved * WALK_PHASE_PER_BLOCK;
      const speed = dt > 0 ? moved / dt : 0;
      const target = Math.min(1, speed / 2.2);
      this.walkAmount += (target - this.walkAmount) * Math.min(1, dt * 9);
    }
    this.lastRendered.copy(this.position);
    this.hasRendered = true;

    // Idle behaviours ease in and out so a head never snaps.
    const grazing = (this.flags & MOB_FLAG_GRAZING) !== 0 && !this.dying;
    this.graze += ((grazing ? 1 : 0) - this.graze) * Math.min(1, dt * 5);
    this.shownHeadYaw += (this.headYaw - this.shownHeadYaw) * Math.min(1, dt * 6);

    const attack = now < this.attackUntil ? 1 - (this.attackUntil - now) / ATTACK_POSE_MS : 0;
    // A drawn bow outranks a swing: an archer mid-draw is not also punching.
    this.rig.pose(this.walkPhase, this.walkAmount, this.draw > 0 ? 0 : attack, 0, this.draw, {
      headYaw: this.shownHeadYaw,
      graze: this.graze,
    });
    if (this.bow) {
      // Pull the string back as the draw builds, and let it snap forward on
      // release — the visible difference between aiming and having fired.
      const nock = this.bow.segments.get('arms');
      if (nock) nock.position.z = -this.draw * BOW_PULL;
      this.bow.group.visible = true;
    }

    // Swap materials only on the frames the flash starts or ends.
    const hurt = now < this.hurtUntil;
    if (hurt !== this.hurtActive) {
      this.hurtActive = hurt;
      this.rig.setMaterial(hurt ? getMobHurtMaterial() : getMobMaterial());
    }
  }

  dispose(): void {
    this.rig.dispose();
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

let arrowGeometry: THREE.BufferGeometry | null = null;

/** Shaft, head and fletching, modelled along +Z so it can be aimed directly. */
function getArrowGeometry(): THREE.BufferGeometry {
  if (!arrowGeometry) {
    arrowGeometry = buildBoxGeometry([
      { pos: [0, 0, 0], size: [0.05, 0.05, 0.72], color: 0x9a6b3f },
      { pos: [0, 0, 0.4], size: [0.08, 0.08, 0.14], color: 0xc9c9c9 },
      { pos: [0, 0, -0.28], size: [0.015, 0.14, 0.18], color: 0xeeeeee },
      { pos: [0, 0, -0.28], size: [0.14, 0.015, 0.18], color: 0xeeeeee },
    ]);
  }
  return arrowGeometry;
}

/**
 * An arrow fired by a mob. Unlike a player's arrow — which is a local effect on
 * the shooter's machine — this one is simulated by whoever owns the world, so
 * every client sees the same shot on the same path.
 */
export class ArrowView extends Interpolated {
  readonly mesh: THREE.Mesh;
  readonly id: number;
  private pitch = 0;

  constructor(state: ArrowStateData) {
    super();
    this.id = state.i;
    this.mesh = new THREE.Mesh(getArrowGeometry(), getMobMaterial());
    this.mesh.visible = false;
  }

  apply(state: ArrowStateData, now: number, direct: boolean): void {
    this.pitch = state.pitch;
    if (direct) this.set(state.x, state.y, state.z, state.yaw);
    else this.push(state.x, state.y, state.z, state.yaw, now);
  }

  render(now: number, direct: boolean): void {
    if (!direct && !this.interpolate(now)) return;
    this.mesh.position.copy(this.position);
    // YXZ so pitch tilts the shaft without rolling it.
    this.mesh.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.mesh.visible = true;
  }
}

/**
 * Owns every mob, dropped item and mob arrow in the scene, whether they come
 * from the server or the local simulation.
 */
export class WorldView {
  /** True in singleplayer: render exactly what the simulation says, now. */
  direct = false;

  private readonly mobs = new Map<number, MobView>();
  private readonly drops = new Map<number, DropView>();
  private readonly arrows = new Map<number, ArrowView>();
  private readonly scene: THREE.Scene;
  /** Whether new mobs get swinging limbs; see setArticulated. */
  private articulated = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Turn limb animation on or off. Articulated bodies cost a few draw calls
   * each; the quality ladder drops them on devices that cannot spare it.
   * Existing mobs are rebuilt in place so the change takes effect immediately.
   */
  setArticulated(on: boolean): void {
    if (on === this.articulated) return;
    this.articulated = on;
    for (const mob of this.mobs.values()) mob.setArticulated(on);
  }

  applyMobs(states: MobStateData[], now: number): void {
    for (const state of states) {
      let mob = this.mobs.get(state.i);
      if (!mob) {
        mob = new MobView(state, this.articulated);
        this.mobs.set(state.i, mob);
        this.scene.add(mob.object);
      }
      mob.apply(state, now, this.direct);
    }
  }

  /** Mobs that died this tick keel over instead of vanishing. */
  killMobs(deaths: { i: number }[]): void {
    const now = performance.now();
    for (const death of deaths) this.mobs.get(death.i)?.kill(now);
  }

  applyArrows(states: ArrowStateData[], now: number): void {
    for (const state of states) {
      let arrow = this.arrows.get(state.i);
      if (!arrow) {
        arrow = new ArrowView(state);
        this.arrows.set(state.i, arrow);
        this.scene.add(arrow.mesh);
      }
      arrow.apply(state, now, this.direct);
    }
  }

  removeArrows(ids: number[]): void {
    for (const id of ids) {
      const arrow = this.arrows.get(id);
      if (!arrow) continue;
      this.scene.remove(arrow.mesh);
      this.arrows.delete(id);
    }
  }

  retainArrows(liveIds: Set<number>): void {
    for (const id of [...this.arrows.keys()]) if (!liveIds.has(id)) this.removeArrows([id]);
  }

  get arrowCount(): number {
    return this.arrows.size;
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

  /** Remove mobs; one mid-death stays until its animation has finished. */
  removeMobs(ids: number[], force = false): void {
    for (const id of ids) {
      const mob = this.mobs.get(id);
      if (!mob || (mob.dying && !mob.finished && !force)) continue;
      this.scene.remove(mob.object);
      mob.dispose();
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
    for (const mob of this.mobs.values()) mob.render(now, dt, this.direct);
    for (const drop of this.drops.values()) drop.render(now, dt, this.direct);
    for (const arrow of this.arrows.values()) arrow.render(now, this.direct);
    for (const [id, mob] of this.mobs) if (mob.finished) this.removeMobs([id], true);
  }

  /** Nearest mob under the ray, for melee and arrows. */
  raycastMob(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): MobView | null {
    let best: MobView | null = null;
    let bestT = Infinity;
    for (const mob of this.mobs.values()) {
      if (!mob.object.visible || mob.dying) continue;
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
    this.removeMobs([...this.mobs.keys()], true);
    this.removeDrops([...this.drops.keys()]);
    this.removeArrows([...this.arrows.keys()]);
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
