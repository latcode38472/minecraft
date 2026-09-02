// The player's inventory as the game acts on it: slots, the crafting grid,
// the cursor stack and whichever chest or furnace is open.
//
// Singleplayer applies every action directly with the shared slot code and
// the local simulation. Multiplayer applies the same code as a prediction,
// sends the action to the server tagged with a sequence number, and takes the
// server's reply as the truth once it has caught up with the last thing we
// sent — so the screen never lags a click, and never disagrees with the server
// for longer than a round trip.

import {
  clickSlot,
  closeHolding,
  craftFromGrid,
  createHolding,
  setGridSize,
  type ClickContext,
  type ContainerSlots,
  type Holding,
} from '../items/containers';
import { Inventory, type ItemStack } from '../items/inventory';
import { getItem } from '../items/items';
import type {
  ClickButton,
  ContainerStateData,
  InventoryStateData,
  SlotRef,
} from '../net/protocol';
import type { MultiplayerSession } from '../net/session';
import type { BlockEntity, RoomSimulation } from '../shared/roomsim';

export interface InventoryControllerHooks {
  /** Feed the player; returns false when already full so the food is kept. */
  eat(hunger: number): boolean;
  /** Something changed on screen. */
  onChange(): void;
  /** Loot the local world could not fit anywhere else. */
  spawnDrop(id: string, count: number, damage?: number): void;
}

/** Where the open container's contents come from. */
interface OpenContainer {
  x: number;
  y: number;
  z: number;
  slots: ContainerSlots;
  /** Singleplayer: the live entity, read each frame for furnace progress. */
  entity: BlockEntity | null;
  /** Multiplayer: the last furnace state the server sent. */
  burn: number;
  burnMax: number;
  progress: number;
}

export class InventoryController {
  readonly inventory: Inventory;
  readonly holding: Holding = createHolding(2);
  container: OpenContainer | null = null;
  /** Bumped whenever the crafting grid, cursor or container changed. */
  version = 0;

  private seq = 0;
  private session: MultiplayerSession | null = null;
  private localSim: RoomSimulation | null = null;
  private readonly hooks: InventoryControllerHooks;

  constructor(inventory: Inventory, hooks: InventoryControllerHooks) {
    this.inventory = inventory;
    this.hooks = hooks;
  }

  /** Multiplayer: actions go to the server; singleplayer: to the local sim. */
  attach(session: MultiplayerSession | null, localSim: RoomSimulation | null): void {
    this.session = session;
    this.localSim = localSim;
  }

  get context(): ClickContext {
    return { inventory: this.inventory, holding: this.holding, container: this.container?.slots ?? null };
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  private changed(): void {
    this.version++;
    this.inventory.version++;
    this.hooks.onChange();
  }

  // --- Slot actions -------------------------------------------------------

  click(ref: SlotRef, button: ClickButton, shift: boolean): void {
    const seq = this.nextSeq();
    clickSlot(this.context, ref, button, shift);
    this.session?.clickSlot(seq, ref, button, shift);
    this.changed();
  }

  craft(all: boolean): void {
    const seq = this.nextSeq();
    craftFromGrid(this.context, all);
    this.session?.craft(seq, all);
    this.changed();
  }

  /**
   * Fill the crafting grid for a recipe from the inventory, one cell at a
   * time, using the same clicks a player would make — so it works identically
   * in both modes and the server never needs to know about recipes.
   */
  fillGrid(cells: (string | null)[]): void {
    const width = this.holding.gridSize;
    if (cells.length !== width * width) return;
    for (let i = 0; i < cells.length; i++) {
      const want = cells[i];
      const have = this.holding.craft[i];
      if (have && (!want || have.id !== want)) return; // grid is in the way
      if (!want || have) continue;
      const source = this.inventory.slots.findIndex((s) => s?.id === want && s.damage === undefined);
      if (source < 0) return;
      // Pick the stack up, drop one into the cell, put the rest back.
      this.click({ kind: 'inv', index: source }, 0, false);
      this.click({ kind: 'craft', index: i }, 1, false);
      if (this.holding.cursor) this.click({ kind: 'inv', index: source }, 0, false);
    }
  }

  /** Empty the grid and cursor back into the bag and close any container. */
  close(): void {
    const seq = this.nextSeq();
    const ctx = this.context;
    const overflow = [...closeHolding(ctx), ...setGridSize(ctx, 2)];
    for (const stack of overflow) this.hooks.spawnDrop(stack.id, stack.count, stack.damage);
    this.container = null;
    this.session?.closeInventory(seq);
    this.changed();
  }

  /** Switch to the pocket grid or a crafting table's 3x3. */
  openGrid(size: 2 | 3, at?: { x: number; y: number; z: number }): void {
    this.container = null;
    const overflow = setGridSize(this.context, size);
    for (const stack of overflow) this.hooks.spawnDrop(stack.id, stack.count, stack.damage);
    this.session?.openGrid(size, at);
    this.changed();
  }

  /** Look into the chest or furnace at a position. Returns false if there is none. */
  openContainer(x: number, y: number, z: number): boolean {
    const overflow = setGridSize(this.context, 2);
    for (const stack of overflow) this.hooks.spawnDrop(stack.id, stack.count, stack.damage);
    if (this.localSim) {
      const entity = this.localSim.openContainer(x, y, z);
      if (!entity) return false;
      this.container = {
        x,
        y,
        z,
        slots: { kind: entity.kind, slots: entity.slots },
        entity,
        burn: 0,
        burnMax: 0,
        progress: 0,
      };
      this.changed();
      return true;
    }
    if (!this.session) return false;
    // The contents arrive from the server; until then show an empty chest.
    this.session.openContainer(x, y, z);
    return true;
  }

  /** Eat the held item. Returns false when nothing happened. */
  eatHeld(): boolean {
    const stack = this.inventory.selectedStack;
    const food = stack ? getItem(stack.id)?.food : undefined;
    if (!food) return false;
    if (!this.hooks.eat(food.hunger)) return false;
    const seq = this.nextSeq();
    this.inventory.consumeSelected();
    this.session?.eat(seq);
    this.changed();
    return true;
  }

  /** Throw the held stack, or one of it, into the world. Returns what was thrown. */
  dropHeld(all: boolean): { id: string; count: number } | null {
    const stack = this.inventory.selectedStack;
    if (!stack) return null;
    const count = all ? stack.count : 1;
    const thrown = { id: stack.id, count, damage: stack.damage };
    const seq = this.nextSeq();
    stack.count -= count;
    if (stack.count <= 0) this.inventory.slots[this.inventory.selected] = null;
    if (this.session) this.session.dropItem(seq, all);
    else this.hooks.spawnDrop(thrown.id, thrown.count, thrown.damage);
    this.changed();
    return thrown;
  }

  selectSlot(index: number): void {
    if (index === this.inventory.selected) return;
    this.inventory.selectSlot(index);
    this.session?.selectSlot(index);
    this.hooks.onChange();
  }

  // --- Server replies -----------------------------------------------------

  /**
   * The server's view of our inventory. Applied only once it reflects our
   * latest action, so a reply to an older click cannot undo a newer one.
   * Replies with no client action behind them (a pickup) always apply.
   */
  applyServerState(state: InventoryStateData): void {
    if (state.ack !== this.seq && state.ack !== 0) return;
    this.inventory.load(state.slots, state.selected, state.armor);
    // Selected slot is the one thing the local player owns outright.
    if (state.ack === 0) this.inventory.selected = Math.max(0, Math.min(8, this.inventory.selected));
    this.holding.cursor = clone(state.cursor);
    if (state.gridSize !== this.holding.gridSize) {
      this.holding.gridSize = state.gridSize;
      this.holding.craft = new Array(state.gridSize * state.gridSize).fill(null);
    }
    for (let i = 0; i < this.holding.craft.length; i++) this.holding.craft[i] = clone(state.craft[i] ?? null);
    this.changed();
  }

  applyContainerState(state: ContainerStateData): void {
    const same =
      this.container && this.container.x === state.x && this.container.y === state.y && this.container.z === state.z;
    const slots = state.slots.map(clone);
    if (same && this.container) {
      this.container.slots.kind = state.kind;
      this.container.slots.slots = slots;
    } else {
      this.container = {
        x: state.x,
        y: state.y,
        z: state.z,
        slots: { kind: state.kind, slots },
        entity: null,
        burn: 0,
        burnMax: 0,
        progress: 0,
      };
    }
    this.container.burn = state.burn ?? 0;
    this.container.burnMax = state.burnMax ?? 0;
    this.container.progress = state.progress ?? 0;
    this.changed();
  }

  /** The server shut our container (it broke, or we walked away). */
  containerClosed(): void {
    if (!this.container) return;
    this.container = null;
    this.changed();
  }

  /** Furnace heat for the screen, whichever mode supplies it. */
  furnaceState(): { burn: number; burnMax: number; progress: number } | null {
    const c = this.container;
    if (!c || c.slots.kind !== 'furnace') return null;
    if (c.entity) return { burn: c.entity.burn, burnMax: c.entity.burnMax, progress: c.entity.progress };
    return { burn: c.burn, burnMax: c.burnMax, progress: c.progress };
  }

  /** Singleplayer: drop everything on death. Multiplayer: the server does it. */
  dropEverything(): ItemStack[] {
    const all: ItemStack[] = [];
    for (const stack of [...this.inventory.slots, ...this.inventory.armor, this.holding.cursor, ...this.holding.craft]) {
      if (stack) all.push({ ...stack });
    }
    this.inventory.clear();
    this.holding.cursor = null;
    this.holding.craft.fill(null);
    this.container = null;
    this.changed();
    return all;
  }
}

function clone(stack: ItemStack | null): ItemStack | null {
  return stack ? { ...stack } : null;
}
