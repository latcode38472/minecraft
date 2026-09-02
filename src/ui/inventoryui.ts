// Inventory screen (E): armour, the crafting grid (2x2 from the pocket, 3x3
// at a table), the open chest or furnace, the 27-slot main grid and the
// hotbar row. Clicks pick stacks up onto a cursor that follows the pointer;
// right-click takes half or puts one; shift-click quick-moves. A recipe book
// on the right fills the grid for you.
//
// All slot logic lives in the InventoryController; this file only draws.

import { ARMOR_SLOT_COUNT, HOTBAR_SIZE, INVENTORY_SIZE } from '../items/inventory';
import { CHEST_SLOTS, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, craftResult } from '../items/containers';
import { hasIngredients, recipesForGrid, type Recipe } from '../items/crafting';
import { getItem } from '../items/items';
import type { InventoryController } from '../game/inventoryctl';
import type { ClickButton, SlotRef } from '../net/protocol';
import { drawItemIcon } from './hud';

const SLOT_ICON_PX = 32;
/** A touch held this long on a slot counts as a right-click. */
const LONG_PRESS_MS = 320;

interface SlotView {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  count: HTMLElement;
  durability: HTMLElement;
}

export class InventoryUi {
  open = false;

  private readonly rootEl = document.getElementById('inventory')!;
  private readonly titleEl = document.getElementById('inv-title')!;
  private readonly gridEl = document.getElementById('inv-grid')!;
  private readonly hotbarEl = document.getElementById('inv-hotbar')!;
  private readonly armorEl = document.getElementById('inv-armor')!;
  private readonly craftGridEl = document.getElementById('inv-craft-grid')!;
  private readonly craftResultEl = document.getElementById('inv-craft-result')!;
  private readonly craftTitleEl = document.getElementById('inv-craft-title')!;
  private readonly containerEl = document.getElementById('inv-container')!;
  private readonly containerTitleEl = document.getElementById('inv-container-title')!;
  private readonly chestGridEl = document.getElementById('inv-chest-grid')!;
  private readonly furnaceEl = document.getElementById('inv-furnace')!;
  private readonly flameBarEl = document.getElementById('furnace-flame-bar')!;
  private readonly arrowBarEl = document.getElementById('furnace-arrow-bar')!;
  private readonly recipesEl = document.getElementById('recipe-list')!;
  private readonly cursorEl = document.getElementById('inv-cursor')!;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly cursorCount: HTMLElement;

  private readonly invSlots: SlotView[] = [];
  private readonly armorSlots: SlotView[] = [];
  private readonly chestSlots: SlotView[] = [];
  private readonly furnaceSlots: SlotView[] = [];
  private craftSlots: SlotView[] = [];
  private resultSlot: SlotView;
  private craftGridSize = 0;
  private lastVersion = -1;
  private lastInventoryVersion = -1;
  private lastRecipeKey = '';

  constructor(
    private readonly ctl: InventoryController,
    private readonly onClose: () => void,
  ) {
    // Main grid first (slots 9+), then the hotbar row (slots 0-8) beneath it,
    // matching where they appear on screen.
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) this.invSlots[i] = this.buildSlot({ kind: 'inv', index: i }, this.gridEl);
    for (let i = 0; i < HOTBAR_SIZE; i++) this.invSlots[i] = this.buildSlot({ kind: 'inv', index: i }, this.hotbarEl);
    const labels = ['Head', 'Body', 'Legs', 'Feet'];
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      const slot = this.buildSlot({ kind: 'armor', index: i }, this.armorEl, 'armor-slot');
      slot.el.title = `${labels[i]} armour`;
      const hint = document.createElement('span');
      hint.className = 'armor-hint';
      hint.textContent = labels[i];
      slot.el.append(hint);
      this.armorSlots.push(slot);
    }
    for (let i = 0; i < CHEST_SLOTS; i++) this.chestSlots.push(this.buildSlot({ kind: 'container', index: i }, this.chestGridEl));
    this.furnaceSlots[FURNACE_INPUT] = this.buildSlot({ kind: 'container', index: FURNACE_INPUT }, document.getElementById('furnace-input')!);
    this.furnaceSlots[FURNACE_FUEL] = this.buildSlot({ kind: 'container', index: FURNACE_FUEL }, document.getElementById('furnace-fuel')!);
    this.furnaceSlots[FURNACE_OUTPUT] = this.buildSlot({ kind: 'container', index: FURNACE_OUTPUT }, document.getElementById('furnace-output')!, 'result');
    this.resultSlot = this.buildSlot({ kind: 'result', index: 0 }, this.craftResultEl, 'result');

    this.cursorCanvas = document.createElement('canvas');
    this.cursorCanvas.width = SLOT_ICON_PX;
    this.cursorCanvas.height = SLOT_ICON_PX;
    this.cursorCount = document.createElement('span');
    this.cursorCount.className = 'count';
    this.cursorEl.append(this.cursorCanvas, this.cursorCount);
    this.rootEl.addEventListener('pointermove', (e) => this.moveCursor(e.clientX, e.clientY));
    this.rootEl.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('inv-close')!.addEventListener('click', () => this.close());
  }

  private buildSlot(ref: SlotRef, parent: HTMLElement, extraClass = ''): SlotView {
    const el = document.createElement('div');
    el.className = `inv-slot${extraClass ? ` ${extraClass}` : ''}`;
    const canvas = document.createElement('canvas');
    canvas.width = SLOT_ICON_PX;
    canvas.height = SLOT_ICON_PX;
    const count = document.createElement('span');
    count.className = 'count';
    const durability = document.createElement('span');
    durability.className = 'durability';
    el.append(canvas, count, durability);

    // Mouse: left/right buttons. Touch: a tap is a left click, a long press a
    // right click, so phones can split stacks too.
    let pressTimer = 0;
    let handled = false;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.moveCursor(e.clientX, e.clientY);
      handled = false;
      if (e.pointerType === 'mouse') {
        this.clickSlot(ref, e.button === 2 ? 1 : 0, e.shiftKey);
        handled = true;
        return;
      }
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        handled = true;
        this.clickSlot(ref, 1, false);
      }, LONG_PRESS_MS);
    });
    const finish = (e: PointerEvent): void => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = 0;
      }
      if (e.type === 'pointerup' && !handled && e.pointerType !== 'mouse') {
        handled = true;
        this.clickSlot(ref, 0, false);
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('pointerleave', finish);
    parent.append(el);
    return { el, canvas, count, durability };
  }

  private clickSlot(ref: SlotRef, button: ClickButton, shift: boolean): void {
    if (!this.open) return;
    if (ref.kind === 'result') this.ctl.craft(shift);
    else this.ctl.click(ref, button, shift);
    this.render(true);
  }

  private moveCursor(x: number, y: number): void {
    this.cursorEl.style.left = `${x}px`;
    this.cursorEl.style.top = `${y}px`;
  }

  show(): void {
    this.open = true;
    this.rootEl.style.display = 'flex';
    this.render(true);
  }

  /** Hide the screen; the controller hands the grid and cursor back. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.rootEl.style.display = 'none';
    this.cursorEl.style.display = 'none';
    this.onClose();
  }

  /** Re-render only when something changed, unless forced. */
  render(force = false): void {
    if (!this.open) return;
    this.renderFurnaceBars();
    if (
      !force &&
      this.ctl.version === this.lastVersion &&
      this.ctl.inventory.version === this.lastInventoryVersion
    ) {
      return;
    }
    this.lastVersion = this.ctl.version;
    this.lastInventoryVersion = this.ctl.inventory.version;

    const inv = this.ctl.inventory;
    const holding = this.ctl.holding;
    const container = this.ctl.container;

    this.titleEl.textContent =
      container?.slots.kind === 'chest'
        ? 'Chest'
        : container?.slots.kind === 'furnace'
          ? 'Furnace'
          : holding.gridSize === 3
            ? 'Crafting Table'
            : 'Inventory';

    for (let i = 0; i < INVENTORY_SIZE; i++) {
      this.drawSlot(this.invSlots[i], inv.slots[i]);
      this.invSlots[i].el.classList.toggle('hotbar-slot', i < HOTBAR_SIZE);
      this.invSlots[i].el.classList.toggle('selected', i === inv.selected);
    }
    for (let i = 0; i < ARMOR_SLOT_COUNT; i++) {
      this.drawSlot(this.armorSlots[i], inv.armor[i]);
      this.armorSlots[i].el.classList.toggle('filled', inv.armor[i] !== null);
    }
    const points = inv.armorPoints();
    document.getElementById('inv-armor-points')!.textContent =
      points > 0 ? `Armour: ${points}` : 'No armour';

    // Crafting grid, rebuilt only when its size changes.
    if (this.craftGridSize !== holding.gridSize) {
      this.craftGridSize = holding.gridSize;
      this.craftGridEl.replaceChildren();
      this.craftGridEl.style.setProperty('--cols', String(holding.gridSize));
      this.craftSlots = [];
      for (let i = 0; i < holding.gridSize * holding.gridSize; i++) {
        this.craftSlots.push(this.buildSlot({ kind: 'craft', index: i }, this.craftGridEl));
      }
    }
    for (let i = 0; i < this.craftSlots.length; i++) this.drawSlot(this.craftSlots[i], holding.craft[i]);
    const recipe = craftResult(holding);
    this.drawSlot(this.resultSlot, recipe ? { id: recipe.output.id, count: recipe.output.count } : null);
    this.craftTitleEl.textContent = holding.gridSize === 3 ? 'CRAFTING (3x3)' : 'CRAFTING (2x2)';

    // Container section.
    const kind = container?.slots.kind ?? null;
    this.containerEl.hidden = kind === null;
    this.chestGridEl.hidden = kind !== 'chest';
    this.furnaceEl.hidden = kind !== 'furnace';
    if (container && kind === 'chest') {
      this.containerTitleEl.textContent = 'CHEST';
      for (let i = 0; i < CHEST_SLOTS; i++) this.drawSlot(this.chestSlots[i], container.slots.slots[i] ?? null);
    } else if (container && kind === 'furnace') {
      this.containerTitleEl.textContent = 'FURNACE';
      for (let i = 0; i < this.furnaceSlots.length; i++) {
        this.drawSlot(this.furnaceSlots[i], container.slots.slots[i] ?? null);
      }
    }

    // Cursor stack rides with the pointer.
    const cursor = holding.cursor;
    this.cursorEl.style.display = cursor ? 'block' : 'none';
    if (cursor) {
      drawItemIcon(this.cursorCanvas, cursor.id);
      this.cursorCount.textContent = cursor.count > 1 ? String(cursor.count) : '';
    }

    this.renderRecipes();
  }

  private drawSlot(view: SlotView, stack: { id: string; count: number; damage?: number } | null): void {
    drawItemIcon(view.canvas, stack?.id ?? null);
    view.count.textContent = stack && stack.count > 1 ? String(stack.count) : '';
    view.el.title = stack ? (getItem(stack.id)?.name ?? '') : '';
    const tool = stack ? getItem(stack.id)?.tool : undefined;
    const armor = stack ? getItem(stack.id)?.armor : undefined;
    const durability = tool?.durability ?? armor?.durability;
    if (stack && stack.damage && durability) {
      const left = 1 - stack.damage / durability;
      view.durability.style.display = 'block';
      view.durability.style.width = `${Math.max(0, left) * 100}%`;
      view.durability.style.background =
        left > 0.5 ? '#5ee45e' : left > 0.25 ? '#e4d15e' : '#e45e5e';
    } else {
      view.durability.style.display = 'none';
    }
  }

  private renderFurnaceBars(): void {
    const state = this.ctl.furnaceState();
    if (!state) return;
    const flame = state.burnMax > 0 ? Math.max(0, Math.min(1, state.burn / state.burnMax)) : 0;
    this.flameBarEl.style.height = `${flame * 100}%`;
    this.arrowBarEl.style.width = `${Math.max(0, Math.min(1, state.progress)) * 100}%`;
  }

  private renderRecipes(): void {
    const inv = this.ctl.inventory;
    const gridSize = this.ctl.holding.gridSize;
    const recipes = recipesForGrid(gridSize);
    const countOf = (id: string): number => inv.count(id);
    // Only rebuild the list when affordability actually changed.
    const key = `${gridSize}|${recipes.map((r) => (hasIngredients(r.inputs, countOf) ? 1 : 0)).join('')}`;
    if (key === this.lastRecipeKey) return;
    this.lastRecipeKey = key;

    this.recipesEl.replaceChildren();
    const craftable = recipes.filter((r) => hasIngredients(r.inputs, countOf));
    const locked = recipes.filter((r) => !hasIngredients(r.inputs, countOf));
    for (const recipe of [...craftable, ...locked]) {
      this.recipesEl.append(this.buildRecipeRow(recipe, craftable.includes(recipe)));
    }
    if (gridSize === 2) {
      this.recipesEl.append(hint('Use a crafting table for the 3x3 recipes: tools, armour, chests, beds.'));
    }
  }

  private buildRecipeRow(recipe: Recipe, affordable: boolean): HTMLElement {
    const row = document.createElement('button');
    row.className = `recipe${affordable ? '' : ' locked'}`;
    row.disabled = !affordable;
    row.type = 'button';

    const icon = document.createElement('canvas');
    icon.width = SLOT_ICON_PX;
    icon.height = SLOT_ICON_PX;
    drawItemIcon(icon, recipe.output.id);

    const text = document.createElement('span');
    text.className = 'recipe-text';
    const outName = getItem(recipe.output.id)?.name ?? recipe.output.id;
    const cost = recipe.inputs
      .map((i) => `${i.count} ${getItem(i.id)?.name ?? i.id}`)
      .join(' + ');
    const strong = document.createElement('strong');
    strong.textContent = `${outName}${recipe.output.count > 1 ? ` x${recipe.output.count}` : ''}`;
    const em = document.createElement('em');
    em.textContent = cost;
    text.append(strong, em);

    row.append(icon, text);
    row.addEventListener('click', () => {
      this.ctl.fillGrid(recipeCells(recipe, this.ctl.holding.gridSize));
      this.render(true);
    });
    return row;
  }
}

/** Lay a recipe out on a grid of the given size, top-left aligned. */
export function recipeCells(recipe: Recipe, gridSize: 2 | 3): (string | null)[] {
  const cells: (string | null)[] = new Array(gridSize * gridSize).fill(null);
  if (recipe.shapeless) {
    recipe.shapeless.forEach((id, i) => {
      if (i < cells.length) cells[i] = id;
    });
    return cells;
  }
  const pattern = recipe.pattern ?? [];
  const keys = recipe.keys ?? {};
  for (let y = 0; y < pattern.length && y < gridSize; y++) {
    for (let x = 0; x < pattern[y].length && x < gridSize; x++) {
      const ch = pattern[y][x];
      if (ch !== '.') cells[y * gridSize + x] = keys[ch] ?? null;
    }
  }
  return cells;
}

function hint(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'recipe-hint';
  el.textContent = text;
  return el;
}
