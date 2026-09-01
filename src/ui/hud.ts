// Bottom-of-screen HUD: hotbar (driven by the inventory), FPS counter, debug
// panel, toasts, and the underwater tint.

import type { Inventory } from '../items/inventory';
import { HOTBAR_SIZE } from '../items/inventory';
import { getItem } from '../items/items';
import { drawTileTo } from '../textures';

const ICON_PX = 32;
/** How long a hotbar slot must be held before it throws its stack. */
const SLOT_HOLD_MS = 500;

export class Hud {
  private readonly slots: HTMLElement[] = [];
  private readonly icons: HTMLCanvasElement[] = [];
  private readonly counts: HTMLElement[] = [];
  private readonly durabilities: HTMLElement[] = [];
  private readonly fpsEl = document.getElementById('fps')!;
  private readonly debugEl = document.getElementById('debug')!;
  private readonly toastEl = document.getElementById('toast')!;
  private readonly nameEl = document.getElementById('held-name')!;
  private readonly waterOverlayEl = document.getElementById('water-overlay')!;
  private toastTimer = 0;
  private nameTimer = 0;
  private frameTimes: number[] = [];
  private debugVisible = false;
  private lastVersion = -1;
  private lastNamed = '';

  constructor(
    private readonly inventory: Inventory,
    onSlotPicked: (index: number) => void,
    /** Long-press a slot to throw its stack — the touch equivalent of Ctrl+Q. */
    onSlotHeld?: (index: number) => void,
  ) {
    const hotbar = document.getElementById('hotbar')!;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';

      const icon = document.createElement('canvas');
      icon.width = ICON_PX;
      icon.height = ICON_PX;

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);

      const count = document.createElement('span');
      count.className = 'count';

      const durability = document.createElement('span');
      durability.className = 'durability';

      slot.append(icon, key, count, durability);

      // Tap selects; holding throws the stack, so a phone can hand items over
      // without a keyboard. The timer is cancelled by any lift or drag.
      let holdTimer = 0;
      const cancelHold = (): void => {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = 0;
        }
      };
      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onSlotPicked(i);
        if (!onSlotHeld) return;
        cancelHold();
        holdTimer = window.setTimeout(() => {
          holdTimer = 0;
          onSlotHeld(i);
        }, SLOT_HOLD_MS);
      });
      for (const event of ['pointerup', 'pointerleave', 'pointercancel']) {
        slot.addEventListener(event, cancelHold);
      }
      hotbar.append(slot);

      this.slots.push(slot);
      this.icons.push(icon);
      this.counts.push(count);
      this.durabilities.push(durability);
    }
    this.refresh();
  }

  /** Redraw the hotbar only when the inventory actually changed. */
  refresh(): void {
    if (this.inventory.version === this.lastVersion) return;
    this.lastVersion = this.inventory.version;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const stack = this.inventory.slots[i];
      const ctx = this.icons[i].getContext('2d')!;
      ctx.clearRect(0, 0, ICON_PX, ICON_PX);

      this.slots[i].classList.toggle('selected', i === this.inventory.selected);

      if (!stack) {
        this.counts[i].textContent = '';
        this.durabilities[i].style.display = 'none';
        continue;
      }

      const def = getItem(stack.id);
      if (def) drawTileTo(ctx, def.tile, 0, 0, ICON_PX);
      this.counts[i].textContent = stack.count > 1 ? String(stack.count) : '';

      const tool = def?.tool;
      if (tool && stack.damage) {
        const left = 1 - stack.damage / tool.durability;
        this.durabilities[i].style.display = 'block';
        this.durabilities[i].style.width = `${Math.max(0, left) * 100}%`;
        this.durabilities[i].style.background =
          left > 0.5 ? '#5ee45e' : left > 0.25 ? '#e4d15e' : '#e45e5e';
      } else {
        this.durabilities[i].style.display = 'none';
      }
    }

    // Name the held item briefly when the selection changes, like Minecraft.
    const held = this.inventory.selectedStack;
    const name = held ? (getItem(held.id)?.name ?? '') : '';
    if (name !== this.lastNamed) {
      this.lastNamed = name;
      this.nameEl.textContent = name;
      this.nameEl.style.opacity = name ? '1' : '0';
      clearTimeout(this.nameTimer);
      this.nameTimer = window.setTimeout(() => (this.nameEl.style.opacity = '0'), 1600);
    }
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debugEl.style.display = this.debugVisible ? 'block' : 'none';
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.style.opacity = '0'), 1500);
  }

  setUnderwater(underwater: boolean): void {
    this.waterOverlayEl.style.display = underwater ? 'block' : 'none';
  }

  updateFrameStats(dt: number, debugText: string): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length >= 30) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.fpsEl.textContent = `${Math.round(1 / avg)} FPS`;
      this.frameTimes = [];
    }
    if (this.debugVisible) this.debugEl.textContent = debugText;
  }
}

/** Shared helper for drawing an item into any slot-sized canvas. */
export function drawItemIcon(canvas: HTMLCanvasElement, itemId: string | null): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!itemId) return;
  const def = getItem(itemId);
  if (def) drawTileTo(ctx, def.tile, 0, 0, canvas.width);
}
