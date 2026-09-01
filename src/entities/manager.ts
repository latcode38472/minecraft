// Entity lifecycle: updates, scene membership, mob spawning/despawning, and
// the ray-vs-mob query the player's attacks use.

import * as THREE from 'three';
import { Block, isSolid } from '../blocks';
import {
  MAX_MOBS,
  MOB_DESPAWN_DISTANCE,
  MOB_SPAWN_INTERVAL_S,
  MOB_SPAWN_MAX_DISTANCE,
  MOB_SPAWN_MIN_DISTANCE,
  NIGHT_END,
  NIGHT_START,
} from '../constants';
import type { World } from '../world/world';
import { Entity, Mob, type EntityContext } from './entity';
import { ItemDrop } from './itemdrop';
import { Pig } from './pig';
import { Zombie } from './zombie';

const MAX_DROPS = 80;
const MAX_HOSTILE = 12;
const MAX_PASSIVE = 10;

export interface MobHit {
  mob: Mob;
  distance: number;
}

export function isNightTime(timeOfDay: number): boolean {
  return timeOfDay >= NIGHT_START || timeOfDay < NIGHT_END;
}

export class EntityManager {
  readonly entities: Entity[] = [];
  private spawnTimer = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
  ) {}

  add(entity: Entity): void {
    this.entities.push(entity);
    this.scene.add(entity.object);
  }

  spawnDrop(id: string, count: number, x: number, y: number, z: number, damage?: number): void {
    const drops = this.entities.filter((e) => e instanceof ItemDrop);
    if (drops.length >= MAX_DROPS) this.remove(drops[0]);
    const drop = new ItemDrop(id, count, damage);
    drop.position.set(x, y, z);
    // A little scatter so a stack of drops doesn't stack into one pixel.
    drop.velocity.set((Math.random() - 0.5) * 1.5, 2.2, (Math.random() - 0.5) * 1.5);
    this.add(drop);
  }

  private remove(entity: Entity): void {
    const index = this.entities.indexOf(entity);
    if (index === -1) return;
    this.entities.splice(index, 1);
    this.scene.remove(entity.object);
    entity.dispose();
  }

  update(ctx: EntityContext, timeOfDay: number): void {
    for (const entity of this.entities) entity.update(ctx);

    // Reap dead and far-away entities (iterate backwards: we splice as we go).
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i];
      const far =
        entity.position.distanceToSquared(ctx.playerPos) >
        MOB_DESPAWN_DISTANCE * MOB_DESPAWN_DISTANCE;
      if (entity.dead) {
        if (entity instanceof Mob) {
          entity.dropLoot(ctx);
          ctx.onMobDeath();
        }
        this.remove(entity);
      } else if (far) {
        this.remove(entity);
      }
    }

    this.spawnTimer -= ctx.dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = MOB_SPAWN_INTERVAL_S;
      this.trySpawnMob(ctx.playerPos, isNightTime(timeOfDay));
    }
  }

  /** Nearest mob whose bounding box the ray enters, within `maxDist`. */
  raycastMob(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): MobHit | null {
    let best: MobHit | null = null;
    for (const entity of this.entities) {
      if (!(entity instanceof Mob)) continue;
      const t = rayBoxDistance(origin, dir, entity, maxDist);
      if (t !== null && (!best || t < best.distance)) best = { mob: entity, distance: t };
    }
    return best;
  }

  get mobCount(): number {
    return this.entities.reduce((n, e) => n + (e instanceof Mob ? 1 : 0), 0);
  }

  private trySpawnMob(playerPos: THREE.Vector3, night: boolean): void {
    const mobs = this.entities.filter((e): e is Mob => e instanceof Mob);
    if (mobs.length >= MAX_MOBS) return;
    const hostile = night;
    const existing = mobs.filter((m) =>
      hostile ? m instanceof Zombie : m instanceof Pig,
    ).length;
    if (existing >= (hostile ? MAX_HOSTILE : MAX_PASSIVE)) return;

    const spot = this.findSpawnSpot(playerPos);
    if (!spot) return;
    const mob = hostile ? new Zombie() : new Pig();
    mob.position.copy(spot);
    mob.yaw = Math.random() * Math.PI * 2;
    this.add(mob);
  }

  /**
   * Look for a standing spot on loaded ground, ringed around the player.
   * Unloaded chunks read as air here, so they simply fail the ground test.
   */
  private findSpawnSpot(playerPos: THREE.Vector3): THREE.Vector3 | null {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist =
        MOB_SPAWN_MIN_DISTANCE + Math.random() * (MOB_SPAWN_MAX_DISTANCE - MOB_SPAWN_MIN_DISTANCE);
      const x = Math.floor(playerPos.x + Math.cos(angle) * dist);
      const z = Math.floor(playerPos.z + Math.sin(angle) * dist);
      const surface = this.world.terrain.heightAt(x, z);

      // Scan a window around the generated surface for real (possibly edited) ground.
      for (let y = surface + 6; y >= Math.max(1, surface - 8); y--) {
        const ground = this.world.getBlock(x, y, z);
        if (!isSolid(ground) || ground === Block.Leaves) continue;
        const feet = this.world.getBlock(x, y + 1, z);
        const head = this.world.getBlock(x, y + 2, z);
        if (feet !== Block.Air || head !== Block.Air) break;
        return new THREE.Vector3(x + 0.5, y + 1, z + 0.5);
      }
    }
    return null;
  }

  clear(): void {
    for (const entity of [...this.entities]) this.remove(entity);
  }
}

/**
 * Slab-method ray/AABB test against a mob's body box. Returns the entry
 * distance, or null when the ray misses or the hit is beyond `maxDist`.
 */
function rayBoxDistance(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  mob: Mob,
  maxDist: number,
): number | null {
  const pad = 0.1; // forgiving hitbox, so glancing aim still connects
  const min = [
    mob.position.x - mob.shape.halfWidth - pad,
    mob.position.y - pad,
    mob.position.z - mob.shape.halfWidth - pad,
  ];
  const max = [
    mob.position.x + mob.shape.halfWidth + pad,
    mob.position.y + mob.shape.height + pad,
    mob.position.z + mob.shape.halfWidth + pad,
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
