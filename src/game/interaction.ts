// Everything the crosshair does: mining with per-block progress, placing,
// attacking mobs, eating, and opening crafting stations.

import * as THREE from 'three';
import { BLOCKS, Block, type BlockDef } from '../blocks';
import {
  ARROW_MIN_CHARGE,
  FIST_COOLDOWN_S,
  FIST_DAMAGE,
  PLACE_REPEAT_MS,
  PLAYER_ATTACK_RANGE,
  REACH_DISTANCE,
} from '../constants';
import type { Station } from '../items/crafting';
import type { Inventory, ItemStack } from '../items/inventory';
import { getItem } from '../items/items';
import type { Player } from '../player/player';
import { raycastVoxel, type RayHit } from '../raycast';
import type { World } from '../world/world';

/** Anything alive the local player can shoot or hit: a mob or another player. */
export interface CombatTarget {
  id: string;
  position: THREE.Vector3;
  halfWidth: number;
  height: number;
}

export interface InteractionHooks {
  onBreakBlock(def: BlockDef): void;
  onPlaceBlock(def: BlockDef): void;
  onAttack(): void;
  /**
   * Everything that can be hit: simulated mobs plus any remote players. Mob
   * ids are prefixed "mob:" so one list serves both.
   */
  combatTargets(): CombatTarget[];
  /** Melee or arrow hit — routed to whichever simulation owns the target. */
  onHitTarget(id: string, damage: number): void;
  /** Fire an arrow from the eye along `dir`, with the given draw strength. */
  fireArrow(origin: THREE.Vector3, dir: THREE.Vector3, charge: number): void;
  /** Spawn a block's drop into the simulation that owns the world. */
  spawnDrop(id: string, count: number, x: number, y: number, z: number): void;
  /** Feed the player; returns false when already full so the food is kept. */
  tryEat(hunger: number): boolean;
  onOpenStation(station: Station): void;
  toast(message: string): void;
}

export interface ActionInput {
  /** Held: mine the targeted block. */
  mining: boolean;
  /** Held (mouse) or tapped (touch): place / use. */
  using: boolean;
  /** Edge-triggered use, for touch taps and single clicks. */
  useTaps: number;
}

/**
 * Seconds to break a block with the given held item. Matching the block's tool
 * class speeds it up; lacking the required tier makes it far slower AND
 * forfeits the drop, the way Minecraft handles stone without a pickaxe.
 */
export function breakTimeFor(def: BlockDef, stack: ItemStack | null): number {
  if (!def.breakable) return Infinity;
  const tool = stack ? getItem(stack.id)?.tool : undefined;
  const matches = tool !== undefined && def.tool !== null && tool.kind === def.tool;
  const speed = matches ? tool.speed : 1;
  const base = def.hardness * (canHarvest(def, stack) ? 1.5 : 5);
  return Math.max(0.05, base / speed);
}

/** Does the held item qualify to collect this block's drop? */
export function canHarvest(def: BlockDef, stack: ItemStack | null): boolean {
  if (def.minTier <= 0) return true;
  const tool = stack ? getItem(stack.id)?.tool : undefined;
  if (!tool || def.tool === null || tool.kind !== def.tool) return false;
  return tool.tier >= def.minTier;
}

export class Interaction {
  /** Currently targeted block, for the highlight box. */
  target: RayHit | null = null;
  /** 0..1 progress on the block being mined. */
  breakProgress = 0;
  /** 0..1 bow draw, for the HUD indicator. */
  bowCharge = 0;
  /** True while a shield is raised (slows movement, absorbs damage). */
  blocking = false;

  private miningKey = '';
  private attackCooldown = 0;
  private nextUseAt = 0;
  private drawingBow = false;

  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly world: World,
    private readonly player: Player,
    private readonly inventory: Inventory,
    private readonly hooks: InteractionHooks,
  ) {}

  update(
    dt: number,
    nowMs: number,
    eye: THREE.Vector3,
    dir: THREE.Vector3,
    input: ActionInput,
  ): void {
    this.eye.copy(eye);
    this.dir.copy(dir);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    this.target = raycastVoxel(this.world, this.eye, this.dir, REACH_DISTANCE);

    const held = this.inventory.selectedStack;
    const heldDef = held ? getItem(held.id) : undefined;

    // --- Shield: holding "use" raises it instead of placing ---
    this.blocking = heldDef?.blocking !== undefined && input.using;

    // --- Bow: holding "use" draws it; releasing fires ---
    if (heldDef?.ranged) {
      this.updateBow(dt, heldDef.ranged, input.using);
    } else if (this.drawingBow) {
      this.cancelBow();
    }

    // A mob or player in front of the block takes the hit instead of the block.
    const combatHit = this.raycastTargets();
    const blockDist = this.target ? this.eye.distanceTo(this.targetCentre(this.target)) : Infinity;
    const combatInFront = (combatHit?.distance ?? Infinity) < blockDist;

    if (input.mining && combatInFront) {
      this.attackTarget(combatHit!.target);
      this.resetMining();
    } else if (input.mining && this.target) {
      this.tickMining(dt, this.target);
    } else {
      this.resetMining();
    }

    // A drawn bow or a raised shield owns the use button; don't also place.
    if (heldDef?.ranged || heldDef?.blocking) return;

    const wantUse = input.useTaps > 0 || (input.using && nowMs >= this.nextUseAt);
    if (wantUse) {
      if (combatInFront && input.useTaps > 0) {
        this.attackTarget(combatHit!.target);
      } else if (this.tryUse()) {
        this.nextUseAt = nowMs + PLACE_REPEAT_MS;
      }
    }
  }

  /** Charge while held, fire on release. Cancels if the shot is too weak. */
  private updateBow(
    dt: number,
    ranged: NonNullable<ReturnType<typeof getItem>>['ranged'] & object,
    held: boolean,
  ): void {
    if (held) {
      if (this.inventory.count(ranged.ammo) === 0) {
        this.bowCharge = 0;
        this.drawingBow = false;
        return;
      }
      this.drawingBow = true;
      this.bowCharge = Math.min(1, this.bowCharge + dt / ranged.drawTime);
      return;
    }
    if (!this.drawingBow) return;

    const charge = this.bowCharge;
    this.cancelBow();
    if (charge < ARROW_MIN_CHARGE) return;
    if (this.inventory.remove(ranged.ammo, 1) === 0) return;

    this.hooks.fireArrow(this.eye, this.dir, charge);
    if (this.inventory.damageSelected()) this.hooks.toast('Your bow broke!');
  }

  private cancelBow(): void {
    this.drawingBow = false;
    this.bowCharge = 0;
  }

  /** Nearest mob or player under the crosshair, within melee reach. */
  private raycastTargets(): { target: CombatTarget; distance: number } | null {
    let best: { target: CombatTarget; distance: number } | null = null;
    for (const target of this.hooks.combatTargets()) {
      const t = rayHitsBox(this.eye, this.dir, target, PLAYER_ATTACK_RANGE);
      if (t !== null && (!best || t < best.distance)) best = { target, distance: t };
    }
    return best;
  }

  private attackTarget(target: CombatTarget): void {
    if (this.attackCooldown > 0) return;
    const stack = this.inventory.selectedStack;
    const attack = stack ? getItem(stack.id)?.attack : undefined;
    const damage = attack?.damage ?? FIST_DAMAGE;
    this.attackCooldown = attack?.cooldown ?? FIST_COOLDOWN_S;

    this.hooks.onHitTarget(target.id, damage);
    if (stack && getItem(stack.id)?.tool) {
      if (this.inventory.damageSelected()) this.hooks.toast('Your weapon broke!');
    }
    this.hooks.onAttack();
  }

  private targetCentre(hit: RayHit): THREE.Vector3 {
    return this.scratch.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  }

  private resetMining(): void {
    this.miningKey = '';
    this.breakProgress = 0;
  }

  private tickMining(dt: number, hit: RayHit): void {
    const key = `${hit.x},${hit.y},${hit.z}`;
    if (key !== this.miningKey) {
      this.miningKey = key;
      this.breakProgress = 0;
    }
    const def = BLOCKS[hit.id];
    const time = breakTimeFor(def, this.inventory.selectedStack);
    if (!Number.isFinite(time)) return;

    this.breakProgress += dt / time;
    if (this.breakProgress < 1) return;

    this.breakBlock(hit, def);
    this.resetMining();
  }

  private breakBlock(hit: RayHit, def: BlockDef): void {
    const stack = this.inventory.selectedStack;
    if (!this.world.setBlock(hit.x, hit.y, hit.z, Block.Air)) return;

    if (def.drop && canHarvest(def, stack)) {
      this.hooks.spawnDrop(def.drop, def.dropCount, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    }
    // Tools only wear out on blocks that actually needed them.
    if (stack && getItem(stack.id)?.tool && def.hardness > 0) {
      if (this.inventory.damageSelected()) this.hooks.toast('Your tool broke!');
    }
    this.hooks.onBreakBlock(def);
  }

  /** Right-click / tap: use a station, eat, or place the held block. */
  private tryUse(): boolean {
    // Using a crafting station beats placing a block on it.
    if (this.target) {
      if (this.target.id === Block.CraftingTable) {
        this.hooks.onOpenStation('table');
        return true;
      }
      if (this.target.id === Block.Furnace) {
        this.hooks.onOpenStation('furnace');
        return true;
      }
    }

    const stack = this.inventory.selectedStack;
    if (!stack) return false;
    const def = getItem(stack.id);
    if (!def) return false;

    if (def.food) {
      if (!this.hooks.tryEat(def.food.hunger)) return false;
      this.inventory.consumeSelected();
      return true;
    }

    if (def.block === undefined || !this.target) return false;
    return this.placeBlock(def.block);
  }

  private placeBlock(block: Block): boolean {
    const hit = this.target!;
    const px = hit.x + hit.normal[0];
    const py = hit.y + hit.normal[1];
    const pz = hit.z + hit.normal[2];

    const occupied = this.world.getBlock(px, py, pz);
    if (occupied !== Block.Air && occupied !== Block.Water) return false;
    // Never seal the player inside a block.
    if (BLOCKS[block].solid && this.player.intersectsBlock(px, py, pz)) return false;
    if (!this.world.setBlock(px, py, pz, block)) return false;

    this.inventory.consumeSelected();
    this.hooks.onPlaceBlock(BLOCKS[block]);
    return true;
  }
}


/** Slab-method ray/AABB test, shared by melee targeting and arrows. */
function rayHitsBox(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  target: CombatTarget,
  maxDist: number,
): number | null {
  const pad = 0.1;
  const min = [
    target.position.x - target.halfWidth - pad,
    target.position.y - pad,
    target.position.z - target.halfWidth - pad,
  ];
  const max = [
    target.position.x + target.halfWidth + pad,
    target.position.y + target.height + pad,
    target.position.z + target.halfWidth + pad,
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
