// Crafting and smelting recipes.
//
// Recipes are a flat list rather than a 3x3 grid: the UI shows what you can
// make and you pick it. That keeps the data trivially extensible and avoids
// grid-shape collisions (a pickaxe and an axe use the same ingredients in
// Minecraft and are told apart only by their layout).

import type { Inventory } from './inventory';

export type Station = 'none' | 'table' | 'furnace';

export interface Ingredient {
  id: string;
  count: number;
}

export interface Recipe {
  id: string;
  output: Ingredient;
  inputs: Ingredient[];
  station: Station;
}

const r = (
  id: string,
  output: Ingredient,
  inputs: Ingredient[],
  station: Station = 'none',
): Recipe => ({ id, output, inputs, station });

const i = (id: string, count = 1): Ingredient => ({ id, count });

export const RECIPES: Recipe[] = [
  // Hand-craftable basics
  r('planks', i('planks', 4), [i('log')]),
  r('sticks', i('stick', 4), [i('planks', 2)]),
  r('crafting_table', i('crafting_table'), [i('planks', 4)]),

  // Crafting table
  r('furnace', i('furnace'), [i('cobblestone', 8)], 'table'),
  r('wooden_pickaxe', i('wooden_pickaxe'), [i('planks', 3), i('stick', 2)], 'table'),
  r('stone_pickaxe', i('stone_pickaxe'), [i('cobblestone', 3), i('stick', 2)], 'table'),
  r('iron_pickaxe', i('iron_pickaxe'), [i('iron_ingot', 3), i('stick', 2)], 'table'),
  r('diamond_pickaxe', i('diamond_pickaxe'), [i('diamond', 3), i('stick', 2)], 'table'),
  r('wooden_axe', i('wooden_axe'), [i('planks', 3), i('stick', 2)], 'table'),
  r('stone_axe', i('stone_axe'), [i('cobblestone', 3), i('stick', 2)], 'table'),
  r('iron_axe', i('iron_axe'), [i('iron_ingot', 3), i('stick', 2)], 'table'),
  r('diamond_axe', i('diamond_axe'), [i('diamond', 3), i('stick', 2)], 'table'),
  r('wooden_sword', i('wooden_sword'), [i('planks', 2), i('stick')], 'table'),
  r('stone_sword', i('stone_sword'), [i('cobblestone', 2), i('stick')], 'table'),
  r('iron_sword', i('iron_sword'), [i('iron_ingot', 2), i('stick')], 'table'),
  r('diamond_sword', i('diamond_sword'), [i('diamond', 2), i('stick')], 'table'),

  // Furnace — coal is the fuel, consumed with the input.
  r('iron_ingot', i('iron_ingot'), [i('raw_iron'), i('coal')], 'furnace'),
  r('gold_ingot', i('gold_ingot'), [i('raw_gold'), i('coal')], 'furnace'),
  r('glass', i('glass'), [i('sand'), i('coal')], 'furnace'),
  r('smooth_stone', i('stone'), [i('cobblestone'), i('coal')], 'furnace'),
  r('bricks', i('bricks', 2), [i('cobblestone', 4), i('coal')], 'furnace'),
  r('cooked_porkchop', i('cooked_porkchop'), [i('raw_porkchop'), i('coal')], 'furnace'),
];

/** Recipes usable at the given station; hand recipes are available everywhere. */
export function recipesFor(station: Station): Recipe[] {
  return RECIPES.filter((recipe) => recipe.station === 'none' || recipe.station === station);
}

export function canCraft(inv: Inventory, recipe: Recipe): boolean {
  return recipe.inputs.every((input) => inv.count(input.id) >= input.count);
}

/** Consume inputs and grant the output. Returns false if it didn't fit or wasn't affordable. */
export function craft(inv: Inventory, recipe: Recipe): boolean {
  if (!canCraft(inv, recipe)) return false;
  for (const input of recipe.inputs) inv.remove(input.id, input.count);
  const leftover = inv.add(recipe.output.id, recipe.output.count);
  if (leftover > 0) {
    // Inventory full: refund so the player never loses materials.
    for (const input of recipe.inputs) inv.add(input.id, input.count);
    inv.remove(recipe.output.id, recipe.output.count - leftover);
    return false;
  }
  return true;
}
