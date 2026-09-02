// Recipe registry and grid matching.
//
// Recipes are either shaped (a pattern laid out on the grid, matched in any
// position and mirrored) or shapeless (a bag of ingredients in any cells). A
// 2x2 grid comes with the inventory; a 3x3 needs a crafting table. Smelting
// lives in smelting.ts, since a furnace is a machine rather than a grid.
//
// The same matcher runs on the client (to show the result and predict the
// craft) and on the server (which is the authority on what you actually get),
// so it must stay free of browser and Node specifics.

import type { ItemStack } from './inventory.ts';
import { getItem } from './items.ts';

export interface Ingredient {
  id: string;
  count: number;
}

export interface Recipe {
  id: string;
  output: Ingredient;
  /** Rows of single-character keys; '.' is an empty cell. */
  pattern?: string[];
  /** Maps pattern characters to item ids. */
  keys?: Record<string, string>;
  /** Shapeless: ingredient ids, one entry per cell (repeat for several). */
  shapeless?: string[];
  /** Smallest grid the recipe fits in: 2 for pocket crafting, 3 for a table. */
  gridSize: 2 | 3;
  /** Total ingredient list, for the recipe book and quick crafting. */
  inputs: Ingredient[];
}

/** Cells as item ids (null for empty), row-major over a `width` wide grid. */
export type GridCells = (string | null)[];

function tally(ids: string[]): Ingredient[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count }));
}

function shaped(
  id: string,
  output: Ingredient,
  pattern: string[],
  keys: Record<string, string>,
): Recipe {
  const height = pattern.length;
  const width = Math.max(...pattern.map((row) => row.length));
  const ids: string[] = [];
  for (const row of pattern) {
    for (const ch of row) {
      if (ch === '.') continue;
      const item = keys[ch];
      if (!item) throw new Error(`Recipe ${id}: no key for '${ch}'`);
      ids.push(item);
    }
  }
  return {
    id,
    output,
    pattern,
    keys,
    gridSize: width <= 2 && height <= 2 ? 2 : 3,
    inputs: tally(ids),
  };
}

function shapeless(id: string, output: Ingredient, ids: string[]): Recipe {
  return { id, output, shapeless: ids, gridSize: ids.length <= 4 ? 2 : 3, inputs: tally(ids) };
}

const out = (id: string, count = 1): Ingredient => ({ id, count });

/** Tool recipes share their shapes; only the head material changes. */
const TOOL_MATERIALS: [string, string][] = [
  ['wooden', 'planks'],
  ['stone', 'cobblestone'],
  ['iron', 'iron_ingot'],
  ['diamond', 'diamond'],
];

const ARMOR_MATERIALS: [string, string][] = [
  ['leather', 'leather'],
  ['iron', 'iron_ingot'],
  ['diamond', 'diamond'],
];

export const RECIPES: Recipe[] = [
  // Basics, craftable in the pocket grid.
  shapeless('planks', out('planks', 4), ['log']),
  shaped('sticks', out('stick', 4), ['P', 'P'], { P: 'planks' }),
  shaped('crafting_table', out('crafting_table'), ['PP', 'PP'], { P: 'planks' }),
  shaped('bread', out('bread'), ['WWW'], { W: 'wheat' }),
  shaped('hay_bale', out('hay_bale'), ['WWW', 'WWW', 'WWW'], { W: 'wheat' }),
  shapeless('wheat_from_hay', out('wheat', 9), ['hay_bale']),
  shaped('bed', out('bed'), ['WWW', 'PPP'], { W: 'wool', P: 'planks' }),
  shaped('chest', out('chest'), ['PPP', 'P.P', 'PPP'], { P: 'planks' }),
  shaped('furnace', out('furnace'), ['CCC', 'C.C', 'CCC'], { C: 'cobblestone' }),
  shaped('shears', out('shears'), ['.I', 'I.'], { I: 'iron_ingot' }),

  // Tools.
  ...TOOL_MATERIALS.flatMap(([tier, mat]) => [
    shaped(`${tier}_pickaxe`, out(`${tier}_pickaxe`), ['MMM', '.S.', '.S.'], { M: mat, S: 'stick' }),
    shaped(`${tier}_axe`, out(`${tier}_axe`), ['MM', 'MS', '.S'], { M: mat, S: 'stick' }),
    shaped(`${tier}_sword`, out(`${tier}_sword`), ['M', 'M', 'S'], { M: mat, S: 'stick' }),
    shaped(`${tier}_hoe`, out(`${tier}_hoe`), ['MM', '.S', '.S'], { M: mat, S: 'stick' }),
  ]),

  // Ranged and defence.
  shaped('bow', out('bow'), ['.SW', 'S.W', '.SW'], { S: 'stick', W: 'string' }),
  shapeless('flint', out('flint'), ['gravel', 'gravel']),
  shaped('arrows', out('arrow', 4), ['F', 'S'], { F: 'flint', S: 'stick' }),
  shaped('shield', out('shield'), ['PIP', 'PPP', '.P.'], { P: 'planks', I: 'iron_ingot' }),

  // Armour.
  ...ARMOR_MATERIALS.flatMap(([tier, mat]) => [
    shaped(`${tier}_helmet`, out(`${tier}_helmet`), ['MMM', 'M.M'], { M: mat }),
    shaped(`${tier}_chestplate`, out(`${tier}_chestplate`), ['M.M', 'MMM', 'MMM'], { M: mat }),
    shaped(`${tier}_leggings`, out(`${tier}_leggings`), ['MMM', 'M.M', 'M.M'], { M: mat }),
    shaped(`${tier}_boots`, out(`${tier}_boots`), ['M.M', 'M.M'], { M: mat }),
  ]),
].filter((recipe) => {
  // Recipes whose ingredients or output are not registered items are dropped
  // here rather than surfacing as an unusable entry in the recipe book.
  const known = [recipe.output, ...recipe.inputs].every((ing) => getItem(ing.id) !== undefined);
  return known;
});

const byId = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

export function getRecipe(id: string): Recipe | undefined {
  return byId.get(id);
}

/** Recipes that fit on a grid of the given size. */
export function recipesForGrid(gridSize: 2 | 3): Recipe[] {
  return RECIPES.filter((recipe) => recipe.gridSize <= gridSize);
}

/**
 * Find the recipe the grid currently spells out, or null. `cells` is
 * row-major, `width` cells to a row (2 or 3).
 */
export function matchRecipe(cells: GridCells, width: number): Recipe | null {
  const filled = cells.filter((cell) => cell !== null).length;
  if (filled === 0) return null;
  for (const recipe of RECIPES) {
    if (recipe.shapeless) {
      if (matchesShapeless(recipe.shapeless, cells)) return recipe;
    } else if (matchesShaped(recipe, cells, width)) {
      return recipe;
    }
  }
  return null;
}

function matchesShapeless(ids: string[], cells: GridCells): boolean {
  const present = cells.filter((cell): cell is string => cell !== null);
  if (present.length !== ids.length) return false;
  const remaining = [...ids];
  for (const id of present) {
    const at = remaining.indexOf(id);
    if (at < 0) return false;
    remaining.splice(at, 1);
  }
  return remaining.length === 0;
}

function matchesShaped(recipe: Recipe, cells: GridCells, width: number): boolean {
  const pattern = recipe.pattern!;
  const keys = recipe.keys!;
  const height = cells.length / width;
  // Bounding box of what the player laid out.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cells[y * width + x] === null) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return false;
  const pw = Math.max(...pattern.map((row) => row.length));
  const ph = pattern.length;
  if (maxX - minX + 1 !== pw || maxY - minY + 1 !== ph) return false;

  const test = (mirrored: boolean): boolean => {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const ch = pattern[y][mirrored ? pw - 1 - x : x] ?? '.';
        const want = ch === '.' ? null : keys[ch];
        const have = cells[(minY + y) * width + (minX + x)];
        if (want !== have) return false;
      }
    }
    return true;
  };
  return test(false) || test(true);
}

/** Ids of the stacks in a grid, in the form the matcher wants. */
export function gridIds(stacks: (ItemStack | null)[]): GridCells {
  return stacks.map((stack) => (stack ? stack.id : null));
}

/** Could `inputs` be paid out of these stacks? Used by the recipe book. */
export function hasIngredients(
  inputs: Ingredient[],
  countOf: (id: string) => number,
): boolean {
  return inputs.every((ing) => countOf(ing.id) >= ing.count);
}
