// Survival HUD: hearts, hunger, mining progress, hurt flash and death screen.
// Hearts and drumsticks are drawn as inline SVG so they stay crisp at any DPI.

import { AIR_BUBBLES, MAX_AIR, MAX_HEALTH, MAX_HUNGER } from '../constants';
import type { Survival } from '../player/survival';

const HEART_PATH =
  'M8 14.5 1.8 8.4A3.9 3.9 0 0 1 8 3.6a3.9 3.9 0 0 1 6.2 4.8Z';
const FOOD_PATH =
  'M4.2 2.2c1.6 0 2.4 1.2 2.4 2.8v3.4h1.1V5c0-1.6.9-2.8 2.4-2.8 1.7 0 2.6 1.4 2.6 3.2 0 2.6-1.9 4.3-4 4.9v2.5c0 .6-.5 1-1 1h-1c-.6 0-1-.4-1-1v-2.5c-2.1-.6-4-2.3-4-4.9 0-1.8.9-3.2 2.5-3.2Z';
/** A bubble: a ring with the highlight bitten out of the upper left. */
const BUBBLE_PATH =
  'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Zm-1.4 2.1a3.4 3.4 0 0 0-2.4 2.6 1 1 0 0 0 2 .3 1.5 1.5 0 0 1 1-1 1 1 0 0 0-.6-1.9Z';

function icons(container: HTMLElement, count: number, path: string, cls: string): SVGElement[] {
  const out: SVGElement[] = [];
  for (let i = 0; i < count; i++) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
    container.append(svg);
    out.push(svg);
  }
  return out;
}

export class StatusUi {
  private readonly hearts: SVGElement[];
  private readonly foods: SVGElement[];
  private readonly bubbles: SVGElement[];
  private readonly airEl = document.getElementById('air-bar')!;
  private readonly flashEl = document.getElementById('hurt-flash')!;
  private readonly deathEl = document.getElementById('death')!;
  private readonly deathMsgEl = document.getElementById('death-msg')!;
  private readonly progressEl = document.getElementById('break-progress')!;
  private readonly progressBarEl = document.getElementById('break-progress-bar')!;
  private readonly bowEl = document.getElementById('bow-charge')!;
  private readonly bowBarEl = document.getElementById('bow-charge-bar')!;
  private lastVersion = -1;

  constructor(onRespawn: () => void) {
    // Half-units: each icon represents 2 health/hunger points.
    this.hearts = icons(document.getElementById('health-bar')!, MAX_HEALTH / 2, HEART_PATH, 'heart');
    this.foods = icons(document.getElementById('hunger-bar')!, MAX_HUNGER / 2, FOOD_PATH, 'food');
    this.bubbles = icons(this.airEl, AIR_BUBBLES, BUBBLE_PATH, 'bubble');
    document.getElementById('respawn-btn')!.addEventListener('click', onRespawn);
  }

  update(survival: Survival, breakProgress: number, bowCharge = 0): void {
    if (survival.version !== this.lastVersion) {
      this.lastVersion = survival.version;
      setBar(this.hearts, survival.health);
      setBar(this.foods, survival.hunger);
      // setBar counts in half-icons, so scale air onto the same footing.
      setBar(this.bubbles, (survival.air / MAX_AIR) * AIR_BUBBLES * 2);
      // The bar only exists while you are short of breath.
      this.airEl.classList.toggle('visible', survival.air < MAX_AIR);
    }

    this.flashEl.style.opacity = String(Math.min(0.55, survival.hurtFlash * 1.4));

    const mining = breakProgress > 0 && breakProgress < 1;
    this.progressEl.style.display = mining ? 'block' : 'none';
    if (mining) this.progressBarEl.style.width = `${Math.min(1, breakProgress) * 100}%`;

    const drawing = bowCharge > 0;
    this.bowEl.style.display = drawing ? 'block' : 'none';
    if (drawing) {
      this.bowBarEl.style.width = `${Math.min(1, bowCharge) * 100}%`;
      // Green once the shot is worth taking.
      this.bowBarEl.style.background = bowCharge > 0.85 ? '#6fd36f' : '#d3c46f';
    }
  }

  showDeath(message: string): void {
    this.deathMsgEl.textContent = message;
    this.deathEl.style.display = 'flex';
  }

  hideDeath(): void {
    this.deathEl.style.display = 'none';
  }
}

/** Fill icons left to right; the icon straddling the value shows as half. */
function setBar(iconEls: SVGElement[], value: number): void {
  iconEls.forEach((el, i) => {
    const filled = value - i * 2;
    el.classList.toggle('full', filled >= 2);
    el.classList.toggle('half', filled >= 1 && filled < 2);
    el.classList.toggle('empty', filled < 1);
  });
}
