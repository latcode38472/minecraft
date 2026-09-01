// Where the held item sits in front of the camera, frame by frame.
//
// Split out of Viewmodel because it is pure maths on numbers: no THREE objects,
// no DOM, no textures. That makes every curve here directly testable, which
// matters — animation is the one part of the game where "looks wrong" is easy
// to see and hard to describe.
//
// Everything is expressed in view space: +x right, +y up, -z forward.

/** What the hand is doing. Each has its own curve; see `applyStrike`. */
export type StrikeKind = 'mine' | 'attack' | 'use' | 'eat';

/** Which of the three rest poses applies. */
export type HoldKind = 'hand' | 'block' | 'item';

/**
 * How the held thing is brought to bear. A sword has an edge and sweeps it
 * across the target; a pickaxe or axe is swung overhead and brought down; a
 * fist, a block or an apple simply goes forward.
 */
export type SwingStyle = 'sweep' | 'chop' | 'jab';

export interface HandPose {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

export interface HandFrame {
  dt: number;
  hold: HoldKind;
  /** How an attack with this item is delivered. */
  style: SwingStyle;
  /** Horizontal speed in blocks/second, for the walking sway. */
  speed: number;
  /** Vertical velocity in blocks/second, for the jump and landing bob. */
  velocityY: number;
  onGround: boolean;
  /** Bow draw, 0..1. */
  bowCharge: number;
  /** Shield raised. */
  blocking: boolean;
}

/**
 * How long each stroke lasts. Mining matches the rate the miner re-triggers at
 * so consecutive strokes join into one continuous action instead of stuttering;
 * eating is long because it is a held activity, not a hit.
 */
export const MINE_STRIKE_S = 0.3;
const STRIKE_S: Record<StrikeKind, number> = {
  mine: MINE_STRIKE_S,
  attack: 0.34,
  use: 0.22,
  eat: 0.9,
};

/** Seconds to lower the old item off-screen and raise the new one back up. */
const EQUIP_S = 0.26;
/** Seconds for the hand to recover from hitting the ground. */
const LAND_S = 0.32;
/** Fall speed, in blocks/second, that produces a full-strength landing bob. */
const LAND_FULL_SPEED = 14;

/**
 * Where the model rests when idle.
 *
 * An item sits in the lower-right quadrant with its bottom edge running off
 * screen, the way a held tool does. Blocks are held further out so a full cube
 * does not dominate the view. An empty hand sits lower still and angled, so the
 * forearm runs off the bottom-right corner — seen end-on at the item pose it
 * reads as a floating plank instead of an arm.
 */
const REST: Record<HoldKind, HandPose> = {
  item: { x: 0.33, y: -0.3, z: -0.62, rotX: -0.5, rotY: -0.35, rotZ: 0.9 },
  block: { x: 0.4, y: -0.36, z: -0.78, rotX: -0.15, rotY: 0.6, rotZ: 0 },
  hand: { x: 0.46, y: -0.5, z: -0.72, rotX: -0.35, rotY: -0.5, rotZ: 0.12 },
};

/** Where a held item is brought to be eaten: up, in, and turned toward you. */
const EAT_POSE: HandPose = { x: 0.17, y: -0.28, z: -0.44, rotX: -0.55, rotY: -0.3, rotZ: 0.55 };

/**
 * A swing: out fast, back slowly.
 *
 * `sharpness` warps the time axis before the sine. Below 0.5 the blow leaves
 * rest almost instantly and spends most of the stroke recovering; at 1 it is a
 * plain symmetrical sine, which reads as a limp wave. Minecraft uses 0.5.
 */
function frontLoaded(p: number, sharpness: number): number {
  if (p <= 0 || p >= 1) return 0;
  return Math.sin(p ** sharpness * Math.PI);
}

/**
 * The standard swing, peaking a quarter of the way through. Used for anything
 * that starts from rest, where an abrupt departure is exactly right.
 */
export function strikeArc(p: number): number {
  return frontLoaded(p, 0.5);
}

/**
 * A pick swing: a short wind-up backwards, then the blow.
 *
 * Returns negative through the wind-up and positive through the strike, so one
 * number drives the whole motion, and both halves reach zero where they join.
 *
 * The blow is deliberately blunter than `strikeArc`. Following a wind-up that
 * has just decelerated to a stop, the square root's vertical departure covers
 * three quarters of the swing inside a single 60fps frame, which reads as the
 * tool teleporting rather than striking.
 */
/**
 * Nearly a third of the stroke is anticipation. That sounds generous, but the
 * whole stroke is 0.3s: at a fifth it lasted 54ms, peaking inside the first
 * two frames at 60fps and vanishing entirely on a phone holding 20 — so the
 * tool appeared to jump straight into the block with no swing behind it.
 */
const WINDUP_FRACTION = 0.3;
const WINDUP_DEPTH = 0.35;
const CHOP_SHARPNESS = 0.65;
export function chopArc(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < WINDUP_FRACTION) {
    return -Math.sin((p / WINDUP_FRACTION) * Math.PI) * WINDUP_DEPTH;
  }
  return frontLoaded((p - WINDUP_FRACTION) / (1 - WINDUP_FRACTION), CHOP_SHARPNESS);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Drives the held model. Holds all the animation state — stroke, item swap,
 * sway, landing — and turns it into one pose per frame.
 *
 * The timers advance on every call whether or not the model is being drawn:
 * other players read `swinging` off this to animate our arm on their screens,
 * so hiding the viewmodel for performance must not make us look motionless to
 * everyone else.
 */
export class HandAnimator {
  private kind: StrikeKind | null = null;
  private strikeTimer = 0;
  private strikeLength = 1;
  private equipTimer = 0;
  private swapPending = false;
  private swayPhase = 0;
  private sway = 0;
  private time = 0;
  private landTimer = 0;
  private landStrength = 0;
  private wasOnGround = true;
  private fallSpeed = 0;
  private bobY = 0;

  /** Begin a stroke. Re-triggering restarts it, so held actions loop. */
  strike(kind: StrikeKind): void {
    this.kind = kind;
    this.strikeLength = STRIKE_S[kind];
    this.strikeTimer = this.strikeLength;
  }

  /**
   * Begin the item-swap dip. The caller must poll `takeSwap` and rebuild the
   * model when it returns true, which is the instant the hand is furthest out
   * of frame — so the swap itself is never seen.
   */
  equip(): void {
    this.equipTimer = EQUIP_S;
    this.swapPending = false;
  }

  /** True exactly once per swap, at the bottom of the dip. */
  takeSwap(): boolean {
    const due = this.swapPending;
    this.swapPending = false;
    return due;
  }

  /**
   * Is an arm-swing in progress? Eating is deliberately excluded: it moves the
   * hand but it is not a swing, and remote players should not see an arm
   * flailing while someone has a sandwich.
   */
  get swinging(): boolean {
    return this.strikeTimer > 0 && this.kind !== 'eat';
  }

  get striking(): boolean {
    return this.strikeTimer > 0;
  }

  /** Advance every clock, then compose the pose they describe. */
  pose(frame: HandFrame): HandPose {
    this.advance(frame);

    const out = { ...REST[frame.hold] };
    this.applySway(frame, out);
    if (this.strikeTimer > 0 && this.kind) {
      applyStrike(this.kind, 1 - this.strikeTimer / this.strikeLength, frame.style, out);
    }
    this.applyEquip(out);
    this.applyBowAndShield(frame, out);
    this.applyBodyMotion(out);
    return out;
  }

  private advance(frame: HandFrame): void {
    const dt = frame.dt;
    this.time += dt;
    this.strikeTimer = Math.max(0, this.strikeTimer - dt);

    if (this.equipTimer > 0) {
      const before = this.equipTimer;
      this.equipTimer = Math.max(0, this.equipTimer - dt);
      const half = EQUIP_S / 2;
      if (before > half && this.equipTimer <= half) this.swapPending = true;
    }

    // Sway follows distance walked, not time, so it stays in step with the legs
    // at any speed and stops dead when you do.
    this.swayPhase += frame.speed * dt * 3.6;
    const target = Math.min(1, frame.speed / 4.5);
    this.sway += (target - this.sway) * Math.min(1, dt * 8);

    // The hand trails the body vertically: jumping lifts it, falling drops it.
    const bobTarget = clamp(-frame.velocityY * 0.01, -0.09, 0.09);
    this.bobY += (bobTarget - this.bobY) * Math.min(1, dt * 9);

    // Landing reads off the last airborne speed: by the time onGround flips,
    // the collision has already zeroed the velocity this frame.
    this.landTimer = Math.max(0, this.landTimer - dt);
    if (frame.onGround && !this.wasOnGround) {
      const impact = Math.min(1, Math.abs(this.fallSpeed) / LAND_FULL_SPEED);
      if (impact > 0.15) {
        this.landTimer = LAND_S;
        this.landStrength = impact;
      }
    }
    this.wasOnGround = frame.onGround;
    if (!frame.onGround) this.fallSpeed = frame.velocityY;
  }

  private applySway(frame: HandFrame, out: HandPose): void {
    out.x += Math.cos(this.swayPhase) * 0.045 * this.sway;
    out.y += Math.abs(Math.sin(this.swayPhase)) * -0.035 * this.sway;
    out.rotZ += Math.cos(this.swayPhase) * 0.06 * this.sway;
    void frame;
  }

  private applyEquip(out: HandPose): void {
    if (this.equipTimer <= 0) return;
    const dip = Math.sin((this.equipTimer / EQUIP_S) * Math.PI);
    out.y -= dip * 0.55;
    out.z += dip * 0.1;
    out.rotX += dip * 0.7;
  }

  /** A drawn bow or a raised shield owns the hand outright. */
  private applyBowAndShield(frame: HandFrame, out: HandPose): void {
    if (frame.bowCharge > 0) {
      const rest = REST[frame.hold];
      const c = frame.bowCharge;
      out.x = rest.x - 0.18 * c;
      out.y = rest.y + 0.12 * c;
      out.z = rest.z + 0.22 * c;
      out.rotY = -0.35 + 0.35 * c;
      out.rotZ = 0.9 - 0.75 * c;
      // A slight tremble at full draw, the way a held bow shakes.
      if (c > 0.95) out.x += Math.sin(this.time * 42) * 0.004;
    }
    if (frame.blocking) {
      out.x = 0.16;
      out.y = -0.3;
      out.z = -0.55;
      out.rotX = 0;
      out.rotY = 0.5;
      out.rotZ = 0;
    }
  }

  /** Breathing, vertical lag and the landing jolt — applied over everything. */
  private applyBodyMotion(out: HandPose): void {
    out.y += this.bobY;

    if (this.landTimer > 0) {
      // Squared so the jolt lands hardest on the first frame and eases out.
      const drop = (this.landTimer / LAND_S) ** 2 * this.landStrength;
      out.y -= drop * 0.13;
      out.rotX += drop * 0.25;
    }

    // A standing hand should still be alive. Fades out as soon as you move,
    // where the walking sway takes over.
    const calm = 1 - this.sway;
    out.y += Math.sin(this.time * 1.5) * 0.005 * calm;
    out.x += Math.cos(this.time * 1.1) * 0.004 * calm;
  }
}

/** The per-action curves. `p` runs 0 at the start of the stroke to 1 at its end. */
function applyStrike(kind: StrikeKind, p: number, style: SwingStyle, out: HandPose): void {
  switch (kind) {
    case 'mine': {
      // Mining is a chop whatever is in your hand — even a bare fist beats down
      // on the block rather than punching at it.
      applyChop(p, out, 1);
      return;
    }
    case 'attack': {
      if (style === 'chop') {
        // Heavier than a mining blow: this one is meant to land on something.
        applyChop(p, out, 1.25);
        return;
      }
      const a = strikeArc(p);
      if (style === 'sweep') {
        // A sword sweeps across the view and rolls over as it goes.
        out.x -= a * 0.34;
        out.y += Math.sin(p * Math.PI) * 0.11;
        out.z -= a * 0.12;
        out.rotX -= a * 0.3;
        out.rotY += a * 1.45;
        out.rotZ -= a * 1.0;
      } else {
        // A fist, a block or a piece of food goes straight out instead.
        out.z -= a * 0.36;
        out.x -= a * 0.1;
        out.y += a * 0.05;
        out.rotX -= a * 0.55;
        out.rotZ += a * 0.2;
      }
      return;
    }
    case 'use': {
      // A short shove: placing a block, opening a crafting table. Lighter than
      // a blow, but it still has to be visible — this is the feedback that the
      // click registered at all.
      const a = strikeArc(p);
      out.z -= a * 0.22;
      out.y -= a * 0.07;
      out.rotX -= a * 0.75;
      return;
    }
    case 'eat': {
      // Rise to the mouth, wobble there, drop away again.
      const inOut = Math.min(1, Math.min(p, 1 - p) * 6);
      out.x = lerp(out.x, EAT_POSE.x, inOut);
      out.y = lerp(out.y, EAT_POSE.y, inOut);
      out.z = lerp(out.z, EAT_POSE.z, inOut);
      out.rotX = lerp(out.rotX, EAT_POSE.rotX, inOut);
      out.rotY = lerp(out.rotY, EAT_POSE.rotY, inOut);
      out.rotZ = lerp(out.rotZ, EAT_POSE.rotZ, inOut);
      out.rotZ += Math.sin(p * 46) * 0.16 * inOut;
      out.y += Math.sin(p * 52) * 0.014 * inOut;
      out.x += Math.cos(p * 41) * 0.01 * inOut;
      return;
    }
  }
}

/**
 * Wind the tool up over your shoulder, then bring it down through the target.
 *
 * `chopArc` is negative through the wind-up and positive through the blow, so
 * one term both raises the tool and then drives it down. `weight` scales how
 * far it travels without changing the timing, so a blow meant to land on a mob
 * is heavier than one chipping at stone but still reads as the same action.
 */
function applyChop(p: number, out: HandPose, weight: number): void {
  const c = chopArc(p);
  const hit = Math.max(0, c);
  out.y -= c * 0.2 * weight;
  out.z -= hit * 0.24 * weight;
  out.x -= hit * 0.06 * weight;
  out.rotX -= c * 1.35 * weight;
  out.rotZ += c * 0.3 * weight;
  // Chatter while the tool is biting, strongest at the moment of contact.
  const bite = hit * hit;
  out.x += Math.sin(p * 78) * 0.008 * bite;
  out.y += Math.cos(p * 91) * 0.008 * bite;
}
