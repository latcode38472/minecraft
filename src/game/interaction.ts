// Everything the crosshair does: mining with per-block progress, placing,
// attacking mobs, eating, tilling, planting, shearing, and using blocks
// (crafting tables, furnaces, chests, beds).

import * as THREE from 'three';
import { BLOCKS, Block, isCrop, isFurnace, type BlockDef } from '../blocks';
import {
  ARROW_MIN_CHARGE,
  FIST_COOLDOWN_S,
  FIST_DAMAGE,
  PLACE_REPEAT_MS,
  PLAYER_ATTACK_RANGE,
  REACH_DISTANCE,
} from '../constants';
import type { Inventory, ItemStack } from '../items/inventory';
import { getItem } from '../items/items';
import type { Player } from '../player/player';
import { raycastVoxel, type RayHit } from '../raycast';
import { breakTimeFor, canHarvest } from '../shared/harvest';
import type { World } from '../world/world';
import { MINE_STRIKE_S, type StrikeKind } from './handpose';

export { breakTimeFor, canHarvest };

/**
 * Seconds between arm swings while a block is being mined. Matching the stroke
 * length exactly means consecutive strokes join into one continuous swing
 * instead of pausing between blows.
 */
const SWING_INTERVAL_S = MINE_STRIKE_S;

/** Anything alive the local player can shoot or hit: a mob or another player. */
export interface CombatTarget {
  id: string;
  position: THREE.Vector3;
  halfWidth: number;
  height: number;
  /** Mob kind by name, so the right-click knows a sheep from a cow. */
  kind?: string;
}

/** Blocks that open a screen or do something when used. */
export type UsableBlock = 'table' | 'furnace' | 'chest' | 'bed';

export interface InteractionHooks {
  /** A block left the world; the owner of the world decides the drop. */
  onBreakBlock(hit: RayHit, def: BlockDef, held: ItemStack | null): void;
  onPlaceBlock(def: BlockDef, x: number, y: number, z: number): void;
  onAttack(): void;
  /**
   * Start a hand animation: repeatedly while mining, once per landed hit, once
   * per placed block, and once when food is eaten. Separate from onAttack,
   * which is the sound and fires only on hits.
   */
  onSwing(kind: StrikeKind): void;
  /**
   * Everything that can be hit: simulated mobs plus any remote players. Mob
   * ids are prefixed "mob:" so one list serves both.
   */
  combatTargets(): CombatTarget[];
  /** Melee or arrow hit — routed to whichever simulation owns the target. */
  onHitTarget(id: string, damage: number): void;
  /** Right-click on a mob with something in hand (shears on a sheep). */
  onUseOnTarget(id: string): boolean;
  /** Fire an arrow from the eye along `dir`, with the given draw strength. */
  fireArrow(origin: THREE.Vector3, dir: THREE.Vector3, charge: number): void;
  /** Eat the held item; returns false when nothing happened. */
  tryEat(): boolean;
  /** Use a block with a screen or a function. */
  onUseBlock(kind: UsableBlock, hit: RayHit): void;
  /** Hoe on dirt or grass. */
  onTill(hit: RayHit): void;
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

export class Interaction {
  /** Currently targeted block, for the highlight box. */
  target: RayHit | null = null;
  /** 0..1 progress on the block being mined. */
  breakProgress = 0;
  /** 0..1 bow draw, for the HUD indicator. */
  bowCharge = 0;
  /** True while a shield is raised (slows movement, absorbs damage). */
  blocking = false;
  /** Seconds left of the "using" pose other players see. */
  useTime = 0;

  private miningKey = '';
  private attackCooldown = 0;
  private nextUseAt = 0;
  private drawingBow = false;
  /** Counts down between mining strokes, so the arm swings in a rhythm. */
  private swingTimer = 0;

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
    this.useTime = Math.max(0, this.useTime - dt);

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
    if (this.blocking || this.drawingBow) this.useTime = 0.2;

    // A mob or player in front of the block takes the hit instead of the block.
    const combatHit = this.raycastTargets();
    const blockDist = this.target ? this.eye.distanceTo(this.targetCentre(this.target)) : Infinity;
    const combatInFront = (combatHit?.distance ?? Infinity) < blockDist;

    this.swingTimer = Math.max(0, this.swingTimer - dt);

    if (input.mining && combatInFront) {
      this.attackTarget(combatHit!.target);
      this.resetMining();
    } else if (input.mining && this.target) {
      this.tickMining(dt, this.target);
      // Keep swinging for as long as the block is being worked on.
      if (this.swingTimer === 0) {
        this.swingTimer = SWING_INTERVAL_S;
        this.hooks.onSwing('mine');
      }
    } else {
      this.resetMining();
    }

    // A drawn bow or a raised shield owns the use button; don't also place.
    if (heldDef?.ranged || heldDef?.blocking) return;

    const wantUse = input.useTaps > 0 || (input.using && nowMs >= this.nextUseAt);
    if (wantUse) {
      if (combatInFront && input.useTaps > 0) {
        if (!this.useOnTarget(combatHit!.target)) this.attackTarget(combatHit!.target);
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
    this.hooks.onSwing('attack');
  }

  /** Shears on a sheep; anything else falls through to an attack. */
  private useOnTarget(target: CombatTarget): boolean {
    const stack = this.inventory.selectedStack;
    if (!stack || getItem(stack.id)?.tool?.kind !== 'shears' || target.kind !== 'sheep') return false;
    if (!this.hooks.onUseOnTarget(target.id)) return false;
    this.hooks.onSwing('use');
    this.useTime = 0.3;
    return true;
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
    this.hooks.onBreakBlock(hit, def, stack);
  }

  /** Right-click / tap: use a block, till, eat, or place the held item. */
  private tryUse(): boolean {
    const stack = this.inventory.selectedStack;
    const def = stack ? getItem(stack.id) : undefined;

    // Using a block beats placing on it — unless sneaking, so a chest can be
    // built against a chest.
    if (this.target && !this.player.sneaking) {
      const usable = usableBlockAt(this.target.id);
      if (usable) {
        this.hooks.onUseBlock(usable, this.target);
        this.hooks.onSwing('use');
        this.useTime = 0.3;
        return true;
      }
    }

    if (!stack || !def) return false;

    if (def.food) {
      if (!this.hooks.tryEat()) return false;
      this.hooks.onSwing('eat');
      this.useTime = 0.9;
      return true;
    }

    if (!this.target) return false;

    if (def.tool?.kind === 'hoe') {
      const id = this.target.id;
      const above = this.world.getBlock(this.target.x, this.target.y + 1, this.target.z);
      if ((id === Block.Dirt || id === Block.Grass) && above === Block.Air) {
        this.hooks.onTill(this.target);
        this.hooks.onSwing('use');
        this.useTime = 0.3;
        return true;
      }
      return false;
    }

    const block = def.block ?? def.plants;
    if (block === undefined) return false;
    if (!this.placeBlock(block, def.plants !== undefined)) return false;
    this.hooks.onSwing('use');
    this.useTime = 0.3;
    return true;
  }

  private placeBlock(block: Block, isSeed: boolean): boolean {
    const hit = this.target!;
    const px = hit.x + hit.normal[0];
    const py = hit.y + hit.normal[1];
    const pz = hit.z + hit.normal[2];

    const occupied = this.world.getBlock(px, py, pz);
    if (occupied !== Block.Air && occupied !== Block.Water) return false;
    const below = this.world.getBlock(px, py - 1, pz);
    // Seeds only take in tilled soil; crops and beds need something under them.
    if (isSeed || isCrop(block)) {
      if (below !== Block.Farmland) return false;
    } else if (block === Block.Bed && !BLOCKS[below].solid) {
      return false;
    }
    // Never seal the player inside a block.
    if (BLOCKS[block].solid && this.player.intersectsBlock(px, py, pz)) return false;
    if (!this.world.setBlock(px, py, pz, block)) return false;

    this.inventory.consumeSelected();
    this.hooks.onPlaceBlock(BLOCKS[block], px, py, pz);
    return true;
  }
}

/** What using a block does, if anything. */
export function usableBlockAt(id: number): UsableBlock | null {
  if (id === Block.CraftingTable) return 'table';
  if (isFurnace(id)) return 'furnace';
  if (id === Block.Chest) return 'chest';
  if (id === Block.Bed) return 'bed';
  return null;
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
