// Touch control scheme (Minecraft Pocket Edition style):
// - virtual joystick (bottom-left) moves, with analog magnitude
// - dragging anywhere else looks around
// - a quick tap breaks the targeted block; holding still places (repeating)
// - dedicated jump (hold) and sneak (toggle) buttons, pause button top-right
//
// One finger may own the joystick while another owns the look surface, tracked
// by pointerId. The tap/hold/drag decision per look-finger: travel beyond
// TOUCH_TAP_CANCEL_PX makes it a drag; releasing within TOUCH_TAP_MAX_MS with
// little travel is a tap; holding still past TOUCH_LONG_PRESS_MS starts placing.

import {
  TOUCH_LONG_PRESS_MS,
  TOUCH_TAP_CANCEL_PX,
  TOUCH_TAP_MAX_MS,
} from '../constants';

const JOYSTICK_DEAD_ZONE = 0.12;

export class TouchControls {
  moveForward = 0;
  moveStrafe = 0;
  jumpHeld = false;
  sneakOn = false;
  /** True while a long-press is active (place repeatedly). */
  placeHeld = false;
  onPause: (() => void) | null = null;

  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private breakTaps = 0;

  private lookPointer = -1;
  private lookStartX = 0;
  private lookStartY = 0;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookStartTime = 0;
  private lookDragging = false;
  private longPressTimer = 0;

  private joyPointer = -1;
  private readonly knob: HTMLElement;

  constructor(lookSurface: HTMLElement) {
    const root = document.createElement('div');
    root.id = 'touch-ui';
    root.innerHTML = `
      <div id="joystick"><div id="joystick-knob"></div></div>
      <div class="touch-btn" id="btn-jump">&#9650;</div>
      <div class="touch-btn" id="btn-sneak">&#9660;</div>
      <div class="touch-btn" id="btn-pause">&#10074;&#10074;</div>`;
    document.body.append(root);
    this.knob = root.querySelector<HTMLElement>('#joystick-knob')!;

    this.bindJoystick(root.querySelector<HTMLElement>('#joystick')!);
    this.bindButtons(root);
    this.bindLookSurface(lookSurface);
  }

  /** Accumulated look drag in pixels since the last call. */
  takeLookDelta(): [number, number] {
    const out: [number, number] = [this.lookDeltaX, this.lookDeltaY];
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return out;
  }

  /** Number of break taps since the last call. */
  takeBreakTaps(): number {
    const out = this.breakTaps;
    this.breakTaps = 0;
    return out;
  }

  private bindJoystick(joy: HTMLElement): void {
    const update = (clientX: number, clientY: number): void => {
      const r = joy.getBoundingClientRect();
      const radius = r.width / 2;
      let dx = (clientX - (r.left + radius)) / radius;
      let dy = (clientY - (r.top + radius)) / radius;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      const dead = len < JOYSTICK_DEAD_ZONE;
      this.moveStrafe = dead ? 0 : dx;
      this.moveForward = dead ? 0 : -dy;
      const knobRange = radius * 0.6;
      this.knob.style.transform = `translate(calc(-50% + ${dx * knobRange}px), calc(-50% + ${dy * knobRange}px))`;
    };
    const reset = (): void => {
      this.joyPointer = -1;
      this.moveForward = 0;
      this.moveStrafe = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
    };

    joy.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.joyPointer !== -1) return;
      this.joyPointer = e.pointerId;
      capturePointer(joy, e.pointerId);
      update(e.clientX, e.clientY);
    });
    joy.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.joyPointer) update(e.clientX, e.clientY);
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      joy.addEventListener(type, (e) => {
        if (e.pointerId === this.joyPointer) reset();
      });
    }
  }

  private bindButtons(root: HTMLElement): void {
    const jump = root.querySelector<HTMLElement>('#btn-jump')!;
    jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.jumpHeld = true;
      capturePointer(jump, e.pointerId);
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      jump.addEventListener(type, () => (this.jumpHeld = false));
    }

    const sneak = root.querySelector<HTMLElement>('#btn-sneak')!;
    sneak.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.sneakOn = !this.sneakOn;
      sneak.classList.toggle('on', this.sneakOn);
    });

    root.querySelector<HTMLElement>('#btn-pause')!.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onPause?.();
    });
  }

  private bindLookSurface(surface: HTMLElement): void {
    surface.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.lookPointer !== -1) return;
      e.preventDefault();
      this.lookPointer = e.pointerId;
      capturePointer(surface, e.pointerId);
      this.lookStartX = this.lookLastX = e.clientX;
      this.lookStartY = this.lookLastY = e.clientY;
      this.lookStartTime = performance.now();
      this.lookDragging = false;
      this.longPressTimer = window.setTimeout(() => {
        if (this.lookPointer === e.pointerId && !this.lookDragging) this.placeHeld = true;
      }, TOUCH_LONG_PRESS_MS);
    });

    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      this.lookDeltaX += e.clientX - this.lookLastX;
      this.lookDeltaY += e.clientY - this.lookLastY;
      this.lookLastX = e.clientX;
      this.lookLastY = e.clientY;
      const travel = Math.hypot(e.clientX - this.lookStartX, e.clientY - this.lookStartY);
      if (travel > TOUCH_TAP_CANCEL_PX && !this.placeHeld && !this.lookDragging) {
        this.lookDragging = true;
        clearTimeout(this.longPressTimer);
      }
    });

    surface.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      clearTimeout(this.longPressTimer);
      const quick = performance.now() - this.lookStartTime < TOUCH_TAP_MAX_MS;
      if (!this.lookDragging && !this.placeHeld && quick) this.breakTaps++;
      this.placeHeld = false;
      this.lookPointer = -1;
    });

    surface.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      clearTimeout(this.longPressTimer);
      this.placeHeld = false;
      this.lookPointer = -1;
    });
  }
}

/** setPointerCapture throws for pointer ids it doesn't know (e.g. synthetic events in tests). */
function capturePointer(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Capture is an enhancement (keeps events flowing off-element); safe to skip.
  }
}

/**
 * Heuristic: does this device want touch controls? Primary-pointer-coarse
 * catches phones/tablets; the fallback catches touch devices that don't
 * report it, while touchscreen laptops (which also have a fine pointer)
 * keep the desktop scheme.
 */
export function isTouchDevice(): boolean {
  if (matchMedia('(pointer: coarse)').matches) return true;
  return navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
}
