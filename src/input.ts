// Keyboard/mouse state tracker. Held keys are polled via isDown(); discrete
// presses (hotbar digits, toggles) are consumed via takePresses().

export class Input {
  private readonly down = new Set<string>();
  private pressed: string[] = [];
  /** Accumulated mouse-wheel steps since last consume (+1 per notch down). */
  private wheelSteps = 0;

  constructor() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.push(e.code);
      if (e.code === 'F3') e.preventDefault();
    });
    document.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('wheel', (e) => {
      this.wheelSteps += Math.sign(e.deltaY);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  takePresses(): string[] {
    const out = this.pressed;
    this.pressed = [];
    return out;
  }

  takeWheelSteps(): number {
    const out = this.wheelSteps;
    this.wheelSteps = 0;
    return out;
  }
}
