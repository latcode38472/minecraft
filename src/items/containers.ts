// Slot interaction shared by the client (for prediction) and the server (the
// authority): clicking, shift-clicking, crafting from the grid, and opening
// or closing chests and furnaces.
//
// A player who has a screen open also has a `Holding`: the crafting grid in
// front of them and whatever is on the cursor. Both are real items the player
// owns, so closing the screen hands them back to the inventory (and drops
// anything that will not fit) rather than deleting them.
//
// Everything here is plain data manipulation. No DOM, no network, no Three.

import { getItem } from './items.ts';
import { ARMOR_ORDER, HOTBAR_SIZE, Inventory, type ItemStack } from './inventory.ts';
import { gridIds, matchRecipe, type Recipe } from './crafting.ts';
import { isFuel, smeltResult } from './smelting.ts';
import type { ClickButton, ContainerKind, SlotRef } from '../net/protocol.ts';

export const CHEST_SLOTS = 27;
export const FURNACE_SLOTS = 3;
export const FURNACE_INPUT = 0;
export const FURNACE_FUEL = 1;
export const FURNACE_OUTPUT = 2;

export interface Holding {
  gridSize: 2 | 3;
  /** gridSize² crafting cells, row-major. */
  craft: (ItemStack | null)[];
  cursor: ItemStack | null;
}

export interface ContainerSlots {
  kind: ContainerKind;
  slots: (ItemStack | null)[];
}

export interface ClickContext {
  inventory: Inventory;
  holding: Holding;
  /** The chest or furnace on screen, if any. */
  container: ContainerSlots | null;
}

export function createHolding(gridSize: 2 | 3 = 2): Holding {
  return { gridSize, craft: new Array(gridSize * gridSize).fill(null), cursor: null };
}

export function slotCount(kind: ContainerKind): number {
  return kind === 'chest' ? CHEST_SLOTS : FURNACE_SLOTS;
}

function maxStack(id: string): number {
  return getItem(id)?.maxStack ?? 64;
}

/** Two stacks that can share a slot: same item, neither carrying wear. */
function canMerge(a: ItemStack, b: ItemStack): boolean {
  return a.id === b.id && a.damage === undefined && b.damage === undefined && maxStack(a.id) > 1;
}

function clone(stack: ItemStack | null): ItemStack | null {
  return stack ? { ...stack } : null;
}

// --- Slot access ----------------------------------------------------------

function slotArray(ctx: ClickContext, kind: SlotRef['kind']): (ItemStack | null)[] | null {
  switch (kind) {
    case 'inv':
      return ctx.inventory.slots;
    case 'armor':
      return ctx.inventory.armor;
    case 'craft':
      return ctx.holding.craft;
    case 'container':
      return ctx.container?.slots ?? null;
    case 'result':
      return null;
  }
}

function getSlot(ctx: ClickContext, ref: SlotRef): ItemStack | null {
  const arr = slotArray(ctx, ref.kind);
  return arr && ref.index < arr.length ? arr[ref.index] : null;
}

function setSlot(ctx: ClickContext, ref: SlotRef, stack: ItemStack | null): void {
  const arr = slotArray(ctx, ref.kind);
  if (!arr || ref.index >= arr.length) return;
  arr[ref.index] = stack && stack.count > 0 ? stack : null;
}

/** Whether a slot exists in this context. */
function validRef(ctx: ClickContext, ref: SlotRef): boolean {
  if (ref.kind === 'result') return ref.index === 0;
  const arr = slotArray(ctx, ref.kind);
  return arr !== null && Number.isInteger(ref.index) && ref.index >= 0 && ref.index < arr.length;
}

/**
 * Can this stack go into this slot? Armour slots take their own piece only;
 * a furnace's fuel slot takes fuel, its output slot takes nothing.
 */
export function acceptsStack(ctx: ClickContext, ref: SlotRef, stack: ItemStack): boolean {
  if (ref.kind === 'armor') {
    const armor = getItem(stack.id)?.armor;
    return armor !== undefined && ARMOR_ORDER[ref.index] === armor.slot;
  }
  if (ref.kind === 'container' && ctx.container?.kind === 'furnace') {
    if (ref.index === FURNACE_OUTPUT) return false;
    if (ref.index === FURNACE_FUEL) return isFuel(stack.id);
  }
  return ref.kind !== 'result';
}

// --- Crafting result ------------------------------------------------------

export function craftResult(holding: Holding): Recipe | null {
  return matchRecipe(gridIds(holding.craft), holding.gridSize);
}

/** Take one output from the grid: consumes one of each cell. */
function consumeGrid(holding: Holding): void {
  for (let i = 0; i < holding.craft.length; i++) {
    const cell = holding.craft[i];
    if (!cell) continue;
    cell.count--;
    if (cell.count <= 0) holding.craft[i] = null;
  }
}

/** How many times the current grid can pay for its recipe. */
function craftableTimes(holding: Holding): number {
  let times = Infinity;
  for (const cell of holding.craft) if (cell) times = Math.min(times, cell.count);
  return times === Infinity ? 0 : times;
}

/**
 * Click the result slot: one craft onto the cursor (merging if the cursor
 * already holds the output). Returns true when something was crafted.
 */
function takeResult(ctx: ClickContext): boolean {
  const recipe = craftResult(ctx.holding);
  if (!recipe) return false;
  const cursor = ctx.holding.cursor;
  if (cursor) {
    const merges =
      cursor.id === recipe.output.id &&
      cursor.damage === undefined &&
      cursor.count + recipe.output.count <= maxStack(cursor.id);
    if (!merges) return false;
    cursor.count += recipe.output.count;
  } else {
    ctx.holding.cursor = { id: recipe.output.id, count: recipe.output.count };
  }
  consumeGrid(ctx.holding);
  return true;
}

/** Shift-click the result: craft as many as the grid allows straight into the inventory. */
function craftAll(ctx: ClickContext): boolean {
  const recipe = craftResult(ctx.holding);
  if (!recipe) return false;
  let crafted = 0;
  let times = craftableTimes(ctx.holding);
  while (times-- > 0) {
    // Stop when the inventory is full rather than destroying ingredients.
    const leftover = ctx.inventory.add(recipe.output.id, recipe.output.count);
    if (leftover > 0) {
      ctx.inventory.remove(recipe.output.id, recipe.output.count - leftover);
      break;
    }
    consumeGrid(ctx.holding);
    crafted++;
    if (craftResult(ctx.holding) !== recipe) break;
  }
  return crafted > 0;
}

/** Craft once (onto the cursor) or as many as possible (into the inventory). */
export function craftFromGrid(ctx: ClickContext, all: boolean): boolean {
  const changed = all ? craftAll(ctx) : takeResult(ctx);
  if (changed) ctx.inventory.version++;
  return changed;
}

// --- Clicking -------------------------------------------------------------

/**
 * Apply a click to a slot. Left: pick up / put down / merge / swap. Right:
 * take half / put one. Shift: quick-move to wherever makes sense. Returns
 * true when any stack changed.
 */
export function clickSlot(
  ctx: ClickContext,
  ref: SlotRef,
  button: ClickButton,
  shift: boolean,
): boolean {
  if (!validRef(ctx, ref)) return false;
  let changed: boolean;
  if (ref.kind === 'result') changed = shift ? craftAll(ctx) : takeResult(ctx);
  else if (shift) changed = quickMove(ctx, ref);
  else if (button === 1) changed = rightClick(ctx, ref);
  else changed = leftClick(ctx, ref);
  if (changed) ctx.inventory.version++;
  return changed;
}

function leftClick(ctx: ClickContext, ref: SlotRef): boolean {
  const cursor = ctx.holding.cursor;
  const slot = getSlot(ctx, ref);
  if (!cursor && !slot) return false;

  if (!cursor) {
    ctx.holding.cursor = slot;
    setSlot(ctx, ref, null);
    return true;
  }
  if (!acceptsStack(ctx, ref, cursor)) return false;
  if (!slot) {
    setSlot(ctx, ref, cursor);
    ctx.holding.cursor = null;
    return true;
  }
  if (canMerge(cursor, slot)) {
    const moved = Math.min(maxStack(slot.id) - slot.count, cursor.count);
    if (moved <= 0) return false;
    slot.count += moved;
    cursor.count -= moved;
    if (cursor.count <= 0) ctx.holding.cursor = null;
    return true;
  }
  // Different items: swap, but only if the slot's item may sit on the cursor
  // (always) and the cursor's item may sit in the slot (checked above).
  setSlot(ctx, ref, cursor);
  ctx.holding.cursor = slot;
  return true;
}

function rightClick(ctx: ClickContext, ref: SlotRef): boolean {
  const cursor = ctx.holding.cursor;
  const slot = getSlot(ctx, ref);
  if (!cursor && !slot) return false;

  if (!cursor) {
    // Take the larger half.
    const taken = Math.ceil(slot!.count / 2);
    ctx.holding.cursor = { ...slot!, count: taken };
    slot!.count -= taken;
    if (slot!.count <= 0) setSlot(ctx, ref, null);
    return true;
  }
  if (!acceptsStack(ctx, ref, cursor)) return false;
  if (!slot) {
    setSlot(ctx, ref, { ...cursor, count: 1 });
    cursor.count--;
    if (cursor.count <= 0) ctx.holding.cursor = null;
    return true;
  }
  if (canMerge(cursor, slot)) {
    if (slot.count >= maxStack(slot.id)) return false;
    slot.count++;
    cursor.count--;
    if (cursor.count <= 0) ctx.holding.cursor = null;
    return true;
  }
  setSlot(ctx, ref, cursor);
  ctx.holding.cursor = slot;
  return true;
}

/**
 * Merge a stack into a slot range, existing stacks first then empties.
 * Mutates `stack.count` down to what did not fit and returns whether any moved.
 */
function mergeIntoRange(
  ctx: ClickContext,
  kind: SlotRef['kind'],
  from: number,
  to: number,
  stack: ItemStack,
): boolean {
  const arr = slotArray(ctx, kind);
  if (!arr) return false;
  const before = stack.count;
  const cap = maxStack(stack.id);
  if (cap > 1) {
    for (let i = from; i < to && stack.count > 0; i++) {
      const target = arr[i];
      if (!target || !canMerge(stack, target)) continue;
      const moved = Math.min(cap - target.count, stack.count);
      target.count += moved;
      stack.count -= moved;
    }
  }
  for (let i = from; i < to && stack.count > 0; i++) {
    if (arr[i]) continue;
    if (!acceptsStack(ctx, { kind, index: i }, stack)) continue;
    const moved = Math.min(cap, stack.count);
    arr[i] = { ...stack, count: moved };
    stack.count -= moved;
  }
  return stack.count !== before;
}

/** Shift-click: move a stack to the place it most likely wants to go. */
function quickMove(ctx: ClickContext, ref: SlotRef): boolean {
  const stack = getSlot(ctx, ref);
  if (!stack) return false;
  const inv = ctx.inventory.slots.length;
  let moved = false;

  if (ref.kind === 'inv') {
    const container = ctx.container;
    if (container) {
      if (container.kind === 'furnace') {
        // Fuel goes to the fuel slot, everything smeltable to the input.
        if (isFuel(stack.id) && !smeltResult(stack.id)) {
          moved = mergeIntoRange(ctx, 'container', FURNACE_FUEL, FURNACE_FUEL + 1, stack);
        } else if (smeltResult(stack.id)) {
          moved = mergeIntoRange(ctx, 'container', FURNACE_INPUT, FURNACE_INPUT + 1, stack);
        } else if (isFuel(stack.id)) {
          moved = mergeIntoRange(ctx, 'container', FURNACE_FUEL, FURNACE_FUEL + 1, stack);
        }
      } else {
        moved = mergeIntoRange(ctx, 'container', 0, container.slots.length, stack);
      }
    } else {
      const armor = getItem(stack.id)?.armor;
      const armorIndex = armor ? ARMOR_ORDER.indexOf(armor.slot) : -1;
      if (armorIndex >= 0 && !ctx.inventory.armor[armorIndex]) {
        ctx.inventory.armor[armorIndex] = stack;
        setSlot(ctx, ref, null);
        return true;
      }
      // Hotbar <-> main inventory.
      moved =
        ref.index < HOTBAR_SIZE
          ? mergeIntoRange(ctx, 'inv', HOTBAR_SIZE, inv, stack)
          : mergeIntoRange(ctx, 'inv', 0, HOTBAR_SIZE, stack);
    }
  } else {
    // Armour, craft grid and container contents all come back to the
    // inventory: main rows first for containers, hotbar first for gear.
    moved = mergeIntoRange(ctx, 'inv', 0, inv, stack);
  }

  if (stack.count <= 0) setSlot(ctx, ref, null);
  return moved;
}

// --- Opening and closing --------------------------------------------------

/**
 * Empty the crafting grid and cursor back into the inventory. Whatever does
 * not fit is returned so the caller can drop it at the player's feet.
 */
export function closeHolding(ctx: ClickContext): ItemStack[] {
  const overflow: ItemStack[] = [];
  const giveBack = (stack: ItemStack | null): void => {
    if (!stack) return;
    const leftover = ctx.inventory.add(stack.id, stack.count, stack.damage);
    if (leftover > 0) overflow.push({ ...stack, count: leftover });
  };
  for (let i = 0; i < ctx.holding.craft.length; i++) {
    giveBack(ctx.holding.craft[i]);
    ctx.holding.craft[i] = null;
  }
  giveBack(ctx.holding.cursor);
  ctx.holding.cursor = null;
  ctx.inventory.version++;
  return overflow;
}

/**
 * Switch grid size (opening or leaving a crafting table), returning the old
 * grid's contents first so nothing is lost in the resize.
 */
export function setGridSize(ctx: ClickContext, size: 2 | 3): ItemStack[] {
  if (ctx.holding.gridSize === size) return [];
  const overflow = closeHolding(ctx);
  ctx.holding.gridSize = size;
  ctx.holding.craft = new Array(size * size).fill(null);
  return overflow;
}

/** Deep copy of a slot array, for snapshots and the wire. */
export function cloneSlots(slots: (ItemStack | null)[]): (ItemStack | null)[] {
  return slots.map(clone);
}

/** Validate an untrusted stack: a registered item and a sane count. */
export function sanitizeStack(raw: unknown): ItemStack | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string') return null;
  const def = getItem(s.id);
  if (!def) return null;
  if (!Number.isInteger(s.count) || (s.count as number) < 1) return null;
  const count = Math.min(def.maxStack, s.count as number);
  const stack: ItemStack = { id: s.id, count };
  if (Number.isInteger(s.damage) && (s.damage as number) >= 0) stack.damage = s.damage as number;
  return stack;
}

/** Validate an untrusted slot array to a fixed length. */
export function sanitizeSlots(raw: unknown, length: number): (ItemStack | null)[] {
  const out: (ItemStack | null)[] = new Array(length).fill(null);
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < length && i < raw.length; i++) out[i] = sanitizeStack(raw[i]);
  return out;
}
