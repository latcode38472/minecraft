// Player inventory: a flat slot array whose first HOTBAR_SIZE entries are the
// hotbar. Stacks merge up to each item's max stack size; tools stack to 1 and
// carry a `damage` counter for durability.

import { getItem } from './items.ts';

export const HOTBAR_SIZE = 9;
export const INVENTORY_ROWS = 3;
export const INVENTORY_SIZE = HOTBAR_SIZE + INVENTORY_ROWS * HOTBAR_SIZE;
/** Armour lives in its own four slots, indexed by ARMOR_ORDER. */
export const ARMOR_ORDER = ['head', 'chest', 'legs', 'feet'] as const;
export type ArmorSlotName = (typeof ARMOR_ORDER)[number];
export const ARMOR_SLOT_COUNT = ARMOR_ORDER.length;

export interface ItemStack {
  id: string;
  count: number;
  /** Durability used so far; undefined for non-tools. */
  damage?: number;
}

export class Inventory {
  readonly slots: (ItemStack | null)[] = new Array(INVENTORY_SIZE).fill(null);
  /** Equipped armour, parallel to ARMOR_ORDER. */
  readonly armor: (ItemStack | null)[] = new Array(ARMOR_SLOT_COUNT).fill(null);
  selected = 0;
  /** Bumped on every mutation so UIs can re-render only when needed. */
  version = 0;

  get selectedStack(): ItemStack | null {
    return this.slots[this.selected];
  }

  selectSlot(index: number): void {
    if (index < 0 || index >= HOTBAR_SIZE) return;
    this.selected = index;
    this.version++;
  }

  cycleSelection(delta: number): void {
    this.selectSlot((this.selected + delta + HOTBAR_SIZE * 100) % HOTBAR_SIZE);
  }

  /** Total count of an item across all slots. */
  count(id: string): number {
    let total = 0;
    for (const slot of this.slots) if (slot?.id === id) total += slot.count;
    return total;
  }

  /**
   * Insert items, merging into existing stacks first (hotbar first so picked-up
   * blocks land where the player can use them). Returns the number left over.
   */
  add(id: string, count: number, damage?: number): number {
    const def = getItem(id);
    if (!def || count <= 0) return count;
    let remaining = count;

    if (def.maxStack > 1) {
      for (const slot of this.slots) {
        if (remaining === 0) break;
        if (slot?.id !== id || slot.count >= def.maxStack) continue;
        const space = def.maxStack - slot.count;
        const moved = Math.min(space, remaining);
        slot.count += moved;
        remaining -= moved;
      }
    }

    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(def.maxStack, remaining);
      this.slots[i] = { id, count: moved, ...(damage !== undefined ? { damage } : {}) };
      remaining -= moved;
    }

    if (remaining !== count) this.version++;
    return remaining;
  }

  /** Remove up to `count` of an item; returns how many were actually removed. */
  remove(id: string, count: number): number {
    let remaining = count;
    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      const slot = this.slots[i];
      if (slot?.id !== id) continue;
      const taken = Math.min(slot.count, remaining);
      slot.count -= taken;
      remaining -= taken;
      if (slot.count === 0) this.slots[i] = null;
    }
    if (remaining !== count) this.version++;
    return count - remaining;
  }

  /**
   * Equipped armour as one tier per slot (0 = empty), in ARMOR_ORDER.
   * This is what gets sent to other players so they can draw the gear.
   */
  equipmentTiers(): number[] {
    return this.armor.map((stack) => (stack ? (getItem(stack.id)?.armor?.tier ?? 0) : 0));
  }

  /** Total armour points from equipped pieces (0 = unarmoured). */
  armorPoints(): number {
    let total = 0;
    for (const stack of this.armor) {
      if (!stack) continue;
      total += getItem(stack.id)?.armor?.points ?? 0;
    }
    return total;
  }

  /**
   * Equip a piece from an inventory slot, swapping out whatever it replaces.
   * Returns false if the item isn't armour.
   */
  equipFromSlot(slotIndex: number): boolean {
    const stack = this.slots[slotIndex];
    const armor = stack ? getItem(stack.id)?.armor : undefined;
    if (!stack || !armor) return false;
    const target = ARMOR_ORDER.indexOf(armor.slot);
    if (target < 0) return false;
    const previous = this.armor[target];
    this.armor[target] = stack;
    this.slots[slotIndex] = previous;
    this.version++;
    return true;
  }

  /** Move an equipped piece back into the first free inventory slot. */
  unequip(armorIndex: number): boolean {
    const stack = this.armor[armorIndex];
    if (!stack) return false;
    const free = this.slots.indexOf(null);
    if (free < 0) return false;
    this.slots[free] = stack;
    this.armor[armorIndex] = null;
    this.version++;
    return true;
  }

  /**
   * Wear down armour when damage is taken; pieces break and vanish at zero.
   * Returns the ids of any pieces that broke.
   */
  damageArmor(amount = 1): string[] {
    const broken: string[] = [];
    for (let i = 0; i < this.armor.length; i++) {
      const stack = this.armor[i];
      if (!stack) continue;
      const def = getItem(stack.id);
      if (!def?.armor) continue;
      stack.damage = (stack.damage ?? 0) + amount;
      if (stack.damage >= def.armor.durability) {
        broken.push(stack.id);
        this.armor[i] = null;
      }
    }
    if (this.armor.some(Boolean) || broken.length) this.version++;
    return broken;
  }

  /** Consume one of the selected stack (placing a block, eating). */
  consumeSelected(): void {
    const slot = this.slots[this.selected];
    if (!slot) return;
    slot.count--;
    if (slot.count <= 0) this.slots[this.selected] = null;
    this.version++;
  }

  /**
   * Apply tool wear to the selected stack; the tool breaks when it runs out.
   * Returns true if the tool broke.
   */
  damageSelected(amount = 1): boolean {
    const slot = this.slots[this.selected];
    if (!slot) return false;
    const def = getItem(slot.id);
    if (!def?.tool) return false;
    slot.damage = (slot.damage ?? 0) + amount;
    this.version++;
    if (slot.damage >= def.tool.durability) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  /** Move or merge one slot into another (inventory drag-and-drop). */
  moveStack(from: number, to: number): void {
    if (from === to || !this.inRange(from) || !this.inRange(to)) return;
    const src = this.slots[from];
    if (!src) return;
    const dst = this.slots[to];
    if (dst && dst.id === src.id && dst.damage === undefined && src.damage === undefined) {
      const max = getItem(src.id)?.maxStack ?? 64;
      const moved = Math.min(max - dst.count, src.count);
      dst.count += moved;
      src.count -= moved;
      if (src.count === 0) this.slots[from] = null;
    } else {
      this.slots[from] = dst;
      this.slots[to] = src;
    }
    this.version++;
  }

  private inRange(i: number): boolean {
    return i >= 0 && i < this.slots.length;
  }

  clear(): void {
    this.slots.fill(null);
    this.armor.fill(null);
    this.version++;
  }

  serialize(): (ItemStack | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  serializeArmor(): (ItemStack | null)[] {
    return this.armor.map((s) => (s ? { ...s } : null));
  }

  load(
    data: (ItemStack | null)[] | undefined,
    selected = 0,
    armor?: (ItemStack | null)[],
  ): void {
    if (data) {
      for (let i = 0; i < this.slots.length; i++) {
        const entry = data[i];
        this.slots[i] = entry && getItem(entry.id) ? { ...entry } : null;
      }
    }
    if (armor) {
      for (let i = 0; i < this.armor.length; i++) {
        const entry = armor[i];
        // Only accept a piece that actually belongs in this slot.
        const def = entry ? getItem(entry.id) : undefined;
        const fits = def?.armor && ARMOR_ORDER.indexOf(def.armor.slot) === i;
        this.armor[i] = fits && entry ? { ...entry } : null;
      }
    }
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, selected));
    this.version++;
  }
}
