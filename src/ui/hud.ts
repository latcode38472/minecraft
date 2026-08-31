// DOM overlay: hotbar with atlas-drawn icons, FPS counter, debug panel, toasts.

import { BLOCKS, HOTBAR_BLOCKS } from '../blocks';
import { TILE_PX, ATLAS_TILES, getAtlasCanvas } from '../textures';

export class Hud {
  selectedSlot = 0;

  private readonly slots: HTMLElement[] = [];
  private readonly fpsEl = document.getElementById('fps')!;
  private readonly debugEl = document.getElementById('debug')!;
  private readonly toastEl = document.getElementById('toast')!;
  private readonly waterOverlayEl = document.getElementById('water-overlay')!;
  private toastTimer = 0;
  private frameTimes: number[] = [];
  private debugVisible = false;

  constructor() {
    const hotbar = document.getElementById('hotbar')!;
    const atlas = getAtlasCanvas();
    HOTBAR_BLOCKS.forEach((blockId, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      const icon = document.createElement('canvas');
      icon.width = TILE_PX;
      icon.height = TILE_PX;
      const ctx = icon.getContext('2d')!;
      const tile = BLOCKS[blockId].tiles.side;
      ctx.drawImage(
        atlas,
        (tile % ATLAS_TILES) * TILE_PX,
        Math.floor(tile / ATLAS_TILES) * TILE_PX,
        TILE_PX,
        TILE_PX,
        0,
        0,
        TILE_PX,
        TILE_PX,
      );
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      slot.append(icon, key);
      slot.title = BLOCKS[blockId].name;
      hotbar.append(slot);
      this.slots.push(slot);
    });
    this.selectSlot(0);
  }

  selectSlot(index: number): void {
    if (index < 0 || index >= this.slots.length) return;
    this.slots[this.selectedSlot].classList.remove('selected');
    this.selectedSlot = index;
    this.slots[index].classList.add('selected');
  }

  cycleSlot(delta: number): void {
    const n = this.slots.length;
    this.selectSlot((this.selectedSlot + delta + n * 100) % n);
  }

  get selectedBlock(): number {
    return HOTBAR_BLOCKS[this.selectedSlot];
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
