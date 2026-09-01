// Dropped items: a small spinning cube textured with the item's atlas tile.
// Geometry is cached per tile so a hundred dropped cobblestones share one
// buffer, and the whole entity is deleted once collected or aged out.

import * as THREE from 'three';
import { ITEM_DESPAWN_S, ITEM_PICKUP_DELAY_S, ITEM_PICKUP_RADIUS } from '../constants';
import { getItem } from '../items/items';
import type { BodyShape } from '../physics';
import { getAtlasTexture, tileUVRect } from '../textures';
import { Entity, type EntityContext } from './entity';

const SIZE = 0.3;
const geometryCache = new Map<number, THREE.BufferGeometry>();
let dropMaterial: THREE.MeshLambertMaterial | null = null;

function dropGeometry(tile: number): THREE.BufferGeometry {
  let geo = geometryCache.get(tile);
  if (!geo) {
    geo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
    // Remap the box's per-face [0,1] UVs onto this item's atlas tile.
    const [u0, v0, u1, v1] = tileUVRect(tile);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    }
    uv.needsUpdate = true;
    geometryCache.set(tile, geo);
  }
  return geo;
}

function getDropMaterial(): THREE.MeshLambertMaterial {
  if (!dropMaterial) {
    dropMaterial = new THREE.MeshLambertMaterial({
      map: getAtlasTexture(),
      // Tool icons have transparent pixels; alpha test keeps them cut out
      // without needing the transparent render pass.
      alphaTest: 0.5,
    });
  }
  return dropMaterial;
}

export class ItemDrop extends Entity {
  readonly shape: BodyShape = { halfWidth: SIZE / 2, height: SIZE };
  readonly object: THREE.Mesh;
  readonly itemId: string;
  count: number;
  readonly damage: number | undefined;

  constructor(itemId: string, count: number, damage?: number) {
    super();
    this.itemId = itemId;
    this.count = count;
    this.damage = damage;
    const tile = getItem(itemId)?.tile ?? 0;
    this.object = new THREE.Mesh(dropGeometry(tile), getDropMaterial());
  }

  update(ctx: EntityContext): void {
    this.age += ctx.dt;
    if (this.age > ITEM_DESPAWN_S) {
      this.dead = true;
      return;
    }

    this.applyGravity(ctx);
    if (this.onGround) {
      this.velocity.x *= 0.7;
      this.velocity.z *= 0.7;
    }

    // A short delay stops a drop from flying straight back into the inventory
    // of the player who just threw or dropped it.
    if (this.age > ITEM_PICKUP_DELAY_S) {
      const dx = ctx.playerPos.x - this.position.x;
      const dy = ctx.playerPos.y + 0.9 - (this.position.y + SIZE / 2);
      const dz = ctx.playerPos.z - this.position.z;
      if (dx * dx + dy * dy + dz * dz < ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS) {
        const leftover = ctx.collectItem(this.itemId, this.count, this.damage);
        if (leftover === 0) {
          this.dead = true;
          return;
        }
        this.count = leftover;
      }
    }

    this.object.position.set(
      this.position.x,
      this.position.y + SIZE / 2 + Math.sin(this.age * 2.5) * 0.06,
      this.position.z,
    );
    this.object.rotation.y = this.age * 1.8;
  }
}
