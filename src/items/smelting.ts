// Furnace registries: what burns, for how long, and what smelts into what.
//
// Both tables are keyed by item id and consulted by the furnace simulation on
// the server (and in singleplayer), so the file stays free of browser code.

import { SMELT_TIME_S } from '../constants.ts';
import { getItem } from './items.ts';

/** Seconds of heat one item of fuel provides. Coal smelts eight items. */
export const FUELS: Record<string, number> = {
  coal: SMELT_TIME_S * 8,
  log: SMELT_TIME_S * 1.5,
  planks: SMELT_TIME_S * 1.5,
  stick: SMELT_TIME_S * 0.5,
  crafting_table: SMELT_TIME_S * 1.5,
  chest: SMELT_TIME_S * 1.5,
  hay_bale: SMELT_TIME_S,
  wool: SMELT_TIME_S * 0.5,
  bed: SMELT_TIME_S,
  wooden_pickaxe: SMELT_TIME_S,
  wooden_axe: SMELT_TIME_S,
  wooden_sword: SMELT_TIME_S,
  wooden_hoe: SMELT_TIME_S,
  bow: SMELT_TIME_S * 1.5,
  shield: SMELT_TIME_S,
};

export interface SmeltingRecipe {
  input: string;
  output: string;
  count: number;
}

const SMELTING_TABLE: SmeltingRecipe[] = [
  { input: 'raw_iron', output: 'iron_ingot', count: 1 },
  { input: 'raw_gold', output: 'gold_ingot', count: 1 },
  { input: 'sand', output: 'glass', count: 1 },
  { input: 'cobblestone', output: 'stone', count: 1 },
  { input: 'stone', output: 'bricks', count: 1 },
  { input: 'log', output: 'coal', count: 1 },
  { input: 'raw_porkchop', output: 'cooked_porkchop', count: 1 },
  { input: 'raw_beef', output: 'cooked_beef', count: 1 },
  { input: 'raw_mutton', output: 'cooked_mutton', count: 1 },
].filter((r) => getItem(r.input) !== undefined && getItem(r.output) !== undefined);

const byInput = new Map(SMELTING_TABLE.map((r) => [r.input, r]));

export const SMELTING: readonly SmeltingRecipe[] = SMELTING_TABLE;

export function smeltResult(inputId: string): SmeltingRecipe | undefined {
  return byInput.get(inputId);
}

export function fuelSeconds(itemId: string): number {
  return FUELS[itemId] ?? 0;
}

export function isFuel(itemId: string): boolean {
  return fuelSeconds(itemId) > 0;
}
