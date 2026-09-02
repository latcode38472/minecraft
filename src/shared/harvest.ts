// Block breaking rules shared by the client (to pace mining and predict the
// drop) and the server (which decides what a broken block actually yields).
//
// Loaded by Node: erasable TypeScript only, explicit .ts extensions.

import type { BlockDef } from '../blocks.ts';
import type { ItemStack } from '../items/inventory.ts';
import { getItem } from '../items/items.ts';
import { rollLoot, type LootRoll, type RandomSource } from './loot.ts';

/**
 * Seconds to break a block with the given held item. Matching the block's tool
 * class speeds it up; lacking the required tier makes it far slower AND
 * forfeits the drop, the way Minecraft handles stone without a pickaxe.
 */
export function breakTimeFor(def: BlockDef, stack: ItemStack | null): number {
  if (!def.breakable) return Infinity;
  const tool = stack ? getItem(stack.id)?.tool : undefined;
  const matches = tool !== undefined && def.tool !== null && tool.kind === def.tool;
  const speed = matches ? tool.speed : 1;
  const base = def.hardness * (canHarvest(def, stack) ? 1.5 : 5);
  return Math.max(0.05, base / speed);
}

/** Does the held item qualify to collect this block's drop? */
export function canHarvest(def: BlockDef, stack: ItemStack | null): boolean {
  if (def.minTier <= 0) return true;
  const tool = stack ? getItem(stack.id)?.tool : undefined;
  if (!tool || def.tool === null || tool.kind !== def.tool) return false;
  return tool.tier >= def.minTier;
}

/**
 * Everything a broken block yields for the given held item: its main drop
 * (when the tool qualifies) plus any chance-based extras such as apples from
 * leaves or seeds from ripe wheat.
 */
export function blockDrops(
  def: BlockDef,
  stack: ItemStack | null,
  rand: RandomSource = Math.random,
): LootRoll[] {
  if (!canHarvest(def, stack)) return [];
  const out: LootRoll[] = [];
  if (def.drop && def.dropCount > 0) out.push({ id: def.drop, count: def.dropCount });
  out.push(...rollLoot(def.loot, rand));
  return out;
}

/** Does breaking this block wear the tool? Only blocks that took real work do. */
export function wearsTool(def: BlockDef, stack: ItemStack | null): boolean {
  return stack !== null && getItem(stack.id)?.tool !== undefined && def.hardness > 0;
}
