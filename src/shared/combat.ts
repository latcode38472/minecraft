// How hard a hit shoves what it lands on.
//
// One place decides this for every way of dealing damage, so the client can
// predict a shove and the server can apply the real one from its own copy of
// the attacker's hand without the two drifting apart. The numbers themselves
// live with the things that carry them: `attack.knockback` on an item, and
// `knockback` on a mob definition.
//
// Loaded by Node as well as the browser: erasable TypeScript only.

import {
  ARROW_KNOCKBACK,
  FIST_KNOCKBACK,
  KNOCKBACK_DRAG,
  KNOCKBACK_LIFT_BASE,
  KNOCKBACK_LIFT_PER_STRENGTH,
  MAX_KNOCKBACK,
} from '../constants.ts';
import type { ItemStack } from '../items/inventory.ts';
import { getItem } from '../items/items.ts';

/** What the item in this hand shoves with. An empty hand is a bare fist. */
export function attackKnockback(held: ItemStack | null | undefined): number {
  const strength = held ? getItem(held.id)?.attack?.knockback : undefined;
  return clampKnockback(strength ?? FIST_KNOCKBACK);
}

/** An arrow's shove. Fixed, so a hit lands the same wherever it is judged. */
export function arrowKnockback(): number {
  return ARROW_KNOCKBACK;
}

/** Nothing is ever shoved harder than the cap, whatever asks for it. */
export function clampKnockback(strength: number): number {
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  return Math.min(strength, MAX_KNOCKBACK);
}

/** The upward pop that comes with a shove; heavier hits lift a little more. */
export function knockbackLift(strength: number): number {
  return KNOCKBACK_LIFT_BASE + clampKnockback(strength) * KNOCKBACK_LIFT_PER_STRENGTH;
}

/**
 * How far a shove of this strength carries, in blocks.
 *
 * The velocity decays exponentially, so the distance is the integral of
 * `strength · e^(−drag·t)` — that is, `strength / drag`. Exposed because it is
 * the number that actually matters when tuning: it is what a player sees.
 */
export function knockbackDistance(strength: number): number {
  return clampKnockback(strength) / KNOCKBACK_DRAG;
}

/** One frame of decay applied to a shove in flight. */
export function knockbackDecay(dt: number): number {
  return Math.exp(-KNOCKBACK_DRAG * dt);
}
