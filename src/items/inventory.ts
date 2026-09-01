// Player inventory: a flat slot array whose first HOTBAR_SIZE entries are the
// hotbar. Stacks merge up to each item's max stack size; tools stack to 1 and
// carry a `damage` counter for durability.

import { getItem } from './items';

export const HOTBAR_SIZE = 9;
export const INVENTORY_ROWS = 3;
export const INVENTORY_SIZE = HOTBAR_SIZE + INVENTORY_ROWS * HOTBAR_SIZE;

export interface ItemStack {
  id: string;
  count: number;
  /** Durability used so far; undefined for non-tools. */
  damage?: number;
}

export class Inventory {
  readonly slots: (ItemStack | null)[] = new Array(INVENTORY_SIZE).fill(null);
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
    this.version++;
  }

  serialize(): (ItemStack | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  load(data: (ItemStack | null)[] | undefined, selected = 0): void {
    if (!data) return;
    for (let i = 0; i < this.slots.length; i++) {
      const entry = data[i];
      this.slots[i] = entry && getItem(entry.id) ? { ...entry } : null;
    }
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, selected));
    this.version++;
  }
}
