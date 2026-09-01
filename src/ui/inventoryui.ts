// Inventory screen (E): the 27-slot main grid, the hotbar row, and a recipe
// list filtered to the station the player opened it from. Click a slot to pick
// a stack up, click again to drop it — the same gesture works with a mouse or
// a finger.

import { HOTBAR_SIZE, INVENTORY_SIZE, type Inventory } from '../items/inventory';
import { canCraft, craft, recipesFor, type Recipe, type Station } from '../items/crafting';
import { getItem } from '../items/items';
import { drawItemIcon } from './hud';

const SLOT_ICON_PX = 32;

export class InventoryUi {
  open = false;
  station: Station = 'none';

  private readonly rootEl = document.getElementById('inventory')!;
  private readonly gridEl = document.getElementById('inv-grid')!;
  private readonly hotbarEl = document.getElementById('inv-hotbar')!;
  private readonly recipesEl = document.getElementById('recipe-list')!;
  private readonly titleEl = document.getElementById('inv-title')!;
  private readonly slotEls: HTMLElement[] = [];
  private readonly slotCanvases: HTMLCanvasElement[] = [];
  private readonly slotCounts: HTMLElement[] = [];
  /** Index of the slot the player picked up from, or -1. */
  private heldSlot = -1;
  private lastVersion = -1;

  constructor(
    private readonly inventory: Inventory,
    private readonly onChange: () => void,
  ) {
    // Main grid first (slots 9+), then the hotbar row (slots 0-8) beneath it,
    // matching where they appear on screen.
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) this.buildSlot(i, this.gridEl);
    for (let i = 0; i < HOTBAR_SIZE; i++) this.buildSlot(i, this.hotbarEl);
    document.getElementById('inv-close')!.addEventListener('click', () => this.close());
  }

  private buildSlot(index: number, parent: HTMLElement): void {
    const el = document.createElement('div');
    el.className = 'inv-slot';
    const canvas = document.createElement('canvas');
    canvas.width = SLOT_ICON_PX;
    canvas.height = SLOT_ICON_PX;
    const count = document.createElement('span');
    count.className = 'count';
    el.append(canvas, count);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.clickSlot(index);
    });
    parent.append(el);
    // Slots are created out of order, so index them explicitly.
    this.slotEls[index] = el;
    this.slotCanvases[index] = canvas;
    this.slotCounts[index] = count;
  }

  private clickSlot(index: number): void {
    if (this.heldSlot === -1) {
      if (this.inventory.slots[index]) this.heldSlot = index;
    } else {
      this.inventory.moveStack(this.heldSlot, index);
      this.heldSlot = -1;
    }
    this.render(true);
    this.onChange();
  }

  toggle(station: Station = 'none'): void {
    if (this.open) this.close();
    else this.show(station);
  }

  show(station: Station): void {
    this.open = true;
    this.station = station;
    this.heldSlot = -1;
    this.titleEl.textContent =
      station === 'table' ? 'Crafting Table' : station === 'furnace' ? 'Furnace' : 'Inventory';
    this.rootEl.style.display = 'flex';
    this.render(true);
  }

  close(): void {
    this.open = false;
    this.heldSlot = -1;
    this.rootEl.style.display = 'none';
  }

  /** Re-render only when the inventory changed, unless forced. */
  render(force = false): void {
    if (!this.open) return;
    if (!force && this.inventory.version === this.lastVersion) return;
    this.lastVersion = this.inventory.version;

    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const stack = this.inventory.slots[i];
      drawItemIcon(this.slotCanvases[i], stack?.id ?? null);
      this.slotCounts[i].textContent = stack && stack.count > 1 ? String(stack.count) : '';
      this.slotEls[i].classList.toggle('held', i === this.heldSlot);
      this.slotEls[i].classList.toggle('hotbar-slot', i < HOTBAR_SIZE);
      this.slotEls[i].title = stack ? (getItem(stack.id)?.name ?? '') : '';
    }

    this.renderRecipes();
  }

  private renderRecipes(): void {
    this.recipesEl.replaceChildren();
    const recipes = recipesFor(this.station);
    const craftable = recipes.filter((r) => canCraft(this.inventory, r));
    const locked = recipes.filter((r) => !canCraft(this.inventory, r));

    if (recipes.length === 0) {
      this.recipesEl.append(hint('Nothing can be made here.'));
      return;
    }

    for (const recipe of [...craftable, ...locked]) {
      this.recipesEl.append(this.buildRecipeRow(recipe, craftable.includes(recipe)));
    }

    if (this.station === 'none') {
      this.recipesEl.append(
        hint('Place a crafting table and use it to unlock tools and weapons.'),
      );
    }
  }

  private buildRecipeRow(recipe: Recipe, affordable: boolean): HTMLElement {
    const row = document.createElement('button');
    row.className = `recipe${affordable ? '' : ' locked'}`;
    row.disabled = !affordable;

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
    text.innerHTML =
      `<strong>${outName}${recipe.output.count > 1 ? ` x${recipe.output.count}` : ''}</strong>` +
      `<em>${cost}</em>`;

    row.append(icon, text);
    row.addEventListener('click', () => {
      if (craft(this.inventory, recipe)) {
        this.render(true);
        this.onChange();
      }
    });
    return row;
  }
}

function hint(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'recipe-hint';
  el.textContent = text;
  return el;
}
