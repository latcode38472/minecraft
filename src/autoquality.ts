// Adaptive quality for weaker devices (enabled on touch): sample the real
// frame rate and walk a quality ladder — each step lowers render resolution
// or view distance — downgrading quickly when FPS drops and upgrading only
// after a sustained smooth period, so it settles instead of oscillating.

import { MIN_VIEW_DISTANCE } from './constants';

export interface AutoQualityHooks {
  setViewDistance(v: number): void;
  setPixelScale(scale: number): void;
  /**
   * Turn limb animation on/off. Articulated bodies cost a few draw calls each;
   * dropping them is the last thing tried, because a world of sliding statues
   * is a bigger loss than a slightly blurrier one.
   */
  setAnimatedLimbs(on: boolean): void;
  notify(message: string): void;
}

interface QualityLevel {
  scale: number;
  viewDistance: number;
  animatedLimbs: boolean;
}

/**
 * Fraction of the ladder that keeps animated limbs. Below this the device is
 * struggling badly enough that draw calls are worth trading for motion.
 */
const LIMBS_UNTIL = 0.6;

const WARMUP_S = 6; // ignore initial world streaming
const SAMPLE_WINDOW_S = 1;
const DOWNGRADE_FPS = 45;
const UPGRADE_FPS = 56;
const DOWNGRADE_COOLDOWN_S = 3;
const UPGRADE_HOLD_S = 8; // smooth seconds required before stepping back up
const PIXEL_SCALES = [1, 0.8, 0.66];

export class AutoQuality {
  enabled = true;
  private readonly levels: QualityLevel[] = [];
  private level = 0;
  private elapsed = 0;
  private cooldown = 0;
  private goodTime = 0;
  private windowTime = 0;
  private windowFrames = 0;

  constructor(
    baseViewDistance: number,
    private readonly hooks: AutoQualityHooks,
  ) {
    // Ladder alternates resolution and view-distance cuts, resolution first
    // (fill rate is the usual phone bottleneck and the cut is less visible).
    let scaleIdx = 0;
    let vd = baseViewDistance;
    this.levels.push({ scale: PIXEL_SCALES[0], viewDistance: vd, animatedLimbs: true });
    while (scaleIdx < PIXEL_SCALES.length - 1 || vd > MIN_VIEW_DISTANCE) {
      if (scaleIdx < PIXEL_SCALES.length - 1) {
        scaleIdx++;
        this.levels.push({ scale: PIXEL_SCALES[scaleIdx], viewDistance: vd, animatedLimbs: true });
      }
      if (vd > MIN_VIEW_DISTANCE) {
        vd--;
        this.levels.push({ scale: PIXEL_SCALES[scaleIdx], viewDistance: vd, animatedLimbs: true });
      }
    }
    // Mark the bottom of the ladder as the no-animation band.
    const keepFrom = Math.ceil(this.levels.length * LIMBS_UNTIL);
    for (let i = keepFrom; i < this.levels.length; i++) this.levels[i].animatedLimbs = false;
  }

  /** Call once per frame with the frame's delta time in seconds. */
  update(dt: number): void {
    if (!this.enabled) return;
    this.elapsed += dt;
    if (this.elapsed < WARMUP_S) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (dt > 0.25) {
      // A single huge hitch (tab switch, GC) shouldn't poison the sample.
      this.windowTime = 0;
      this.windowFrames = 0;
      return;
    }
    this.windowTime += dt;
    this.windowFrames++;
    if (this.windowTime < SAMPLE_WINDOW_S) return;

    const fps = this.windowFrames / this.windowTime;
    this.windowTime = 0;
    this.windowFrames = 0;

    if (fps < DOWNGRADE_FPS && this.cooldown === 0 && this.level < this.levels.length - 1) {
      this.level++;
      this.apply('Auto quality lowered');
      this.cooldown = DOWNGRADE_COOLDOWN_S;
      this.goodTime = 0;
    } else if (fps > UPGRADE_FPS && this.level > 0) {
      this.goodTime += SAMPLE_WINDOW_S;
      if (this.goodTime >= UPGRADE_HOLD_S) {
        this.level--;
        this.apply('Auto quality raised');
        this.goodTime = 0;
        this.cooldown = DOWNGRADE_COOLDOWN_S;
      }
    } else {
      this.goodTime = 0;
    }
  }

  /** Hand control back to the user (manual view-distance change). */
  disable(): void {
    this.enabled = false;
    this.hooks.setPixelScale(1);
    this.hooks.setAnimatedLimbs(true);
  }

  get currentLevel(): number {
    return this.level;
  }

  private apply(prefix: string): void {
    const q = this.levels[this.level];
    this.hooks.setViewDistance(q.viewDistance);
    this.hooks.setPixelScale(q.scale);
    this.hooks.setAnimatedLimbs(q.animatedLimbs);
    const res = q.scale < 1 ? `, ${Math.round(q.scale * 100)}% res` : '';
    this.hooks.notify(`${prefix} (view ${q.viewDistance}${res})`);
  }
}
