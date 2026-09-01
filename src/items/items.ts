// Item registry. Items are keyed by string id so recipes, drops and saves stay
// readable and new items can be added in one place. Anything with a `block`
// can be placed; anything with a `tool` mines faster; anything with `attack`
// hits harder than a fist; anything with `food` restores hunger.

import { Block, type ToolKind } from '../blocks';
import { ItemTile } from '../textures';
import { BLOCKS } from '../blocks';

/** Tool tiers: 0 hand, 1 wood, 2 stone, 3 iron, 4 diamond. */
export const TIER_HAND = 0;

export interface ToolStats {
  kind: ToolKind;
  tier: number;
  /** Mining speed multiplier against blocks this tool suits. */
  speed: number;
  durability: number;
}

export interface ItemDef {
  id: string;
  name: string;
  tile: number;
  maxStack: number;
  block?: Block;
  tool?: ToolStats;
  attack?: { damage: number; cooldown: number };
  food?: { hunger: number };
}

const items = new Map<string, ItemDef>();

function register(def: ItemDef): ItemDef {
  items.set(def.id, def);
  return def;
}

/** Placeable block item; its icon is the block's side texture. */
function blockItem(id: string, block: Block, name?: string): void {
  register({
    id,
    name: name ?? BLOCKS[block].name,
    tile: BLOCKS[block].tiles.side,
    maxStack: 64,
    block,
  });
}

function material(id: string, name: string, tile: number): void {
  register({ id, name, tile, maxStack: 64 });
}

const TOOL_TIERS = [
  { key: 'wooden', name: 'Wooden', tier: 1, speed: 2, durability: 59 },
  { key: 'stone', name: 'Stone', tier: 2, speed: 4, durability: 131 },
  { key: 'iron', name: 'Iron', tier: 3, speed: 6, durability: 250 },
  { key: 'diamond', name: 'Diamond', tier: 4, speed: 8, durability: 1561 },
] as const;

const PICKAXE_TILES = [
  ItemTile.WoodenPickaxe,
  ItemTile.StonePickaxe,
  ItemTile.IronPickaxe,
  ItemTile.DiamondPickaxe,
];
const AXE_TILES = [ItemTile.WoodenAxe, ItemTile.StoneAxe, ItemTile.IronAxe, ItemTile.DiamondAxe];
const SWORD_TILES = [
  ItemTile.WoodenSword,
  ItemTile.StoneSword,
  ItemTile.IronSword,
  ItemTile.DiamondSword,
];

// --- Blocks ---
blockItem('dirt', Block.Dirt);
blockItem('grass_block', Block.Grass, 'Grass Block');
blockItem('stone', Block.Stone);
blockItem('cobblestone', Block.Cobblestone);
blockItem('sand', Block.Sand);
blockItem('gravel', Block.Gravel);
blockItem('log', Block.Log, 'Oak Log');
blockItem('leaves', Block.Leaves);
blockItem('planks', Block.Planks, 'Oak Planks');
blockItem('bricks', Block.Bricks);
blockItem('glass', Block.Glass);
blockItem('crafting_table', Block.CraftingTable);
blockItem('furnace', Block.Furnace);
blockItem('coal_ore', Block.CoalOre, 'Coal Ore');
blockItem('iron_ore', Block.IronOre, 'Iron Ore');
blockItem('gold_ore', Block.GoldOre, 'Gold Ore');
blockItem('diamond_ore', Block.DiamondOre, 'Diamond Ore');

// --- Materials ---
material('stick', 'Stick', ItemTile.Stick);
material('coal', 'Coal', ItemTile.Coal);
material('raw_iron', 'Raw Iron', ItemTile.RawIron);
material('raw_gold', 'Raw Gold', ItemTile.RawGold);
material('iron_ingot', 'Iron Ingot', ItemTile.IronIngot);
material('gold_ingot', 'Gold Ingot', ItemTile.GoldIngot);
material('diamond', 'Diamond', ItemTile.Diamond);

// --- Food ---
register({
  id: 'raw_porkchop',
  name: 'Raw Porkchop',
  tile: ItemTile.RawPorkchop,
  maxStack: 64,
  food: { hunger: 3 },
});
register({
  id: 'cooked_porkchop',
  name: 'Cooked Porkchop',
  tile: ItemTile.CookedPorkchop,
  maxStack: 64,
  food: { hunger: 8 },
});
register({
  id: 'rotten_flesh',
  name: 'Rotten Flesh',
  tile: ItemTile.RottenFlesh,
  maxStack: 64,
  food: { hunger: 2 },
});

// --- Tools and weapons ---
TOOL_TIERS.forEach((t, i) => {
  register({
    id: `${t.key}_pickaxe`,
    name: `${t.name} Pickaxe`,
    tile: PICKAXE_TILES[i],
    maxStack: 1,
    tool: { kind: 'pickaxe', tier: t.tier, speed: t.speed, durability: t.durability },
    attack: { damage: 1 + t.tier, cooldown: 0.45 },
  });
  register({
    id: `${t.key}_axe`,
    name: `${t.name} Axe`,
    tile: AXE_TILES[i],
    maxStack: 1,
    tool: { kind: 'axe', tier: t.tier, speed: t.speed, durability: t.durability },
    attack: { damage: 2 + t.tier, cooldown: 0.6 },
  });
  register({
    id: `${t.key}_sword`,
    name: `${t.name} Sword`,
    tile: SWORD_TILES[i],
    maxStack: 1,
    tool: { kind: 'sword', tier: t.tier, speed: 1.5, durability: t.durability },
    attack: { damage: 3 + t.tier, cooldown: 0.35 },
  });
});

export function getItem(id: string): ItemDef | undefined {
  return items.get(id);
}

/** Throws for unknown ids — use for registry-authored ids that must exist. */
export function requireItem(id: string): ItemDef {
  const def = items.get(id);
  if (!def) throw new Error(`Unknown item: ${id}`);
  return def;
}

export function allItems(): ItemDef[] {
  return [...items.values()];
}
