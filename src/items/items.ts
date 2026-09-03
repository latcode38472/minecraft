// Item registry. Items are keyed by string id so recipes, drops and saves stay
// readable and new items can be added in one place. Anything with a `block`
// can be placed; anything with a `tool` mines faster; anything with `attack`
// hits harder than a fist; anything with `food` restores hunger; anything with
// `plants` can be sown on farmland.
//
// Imports carry explicit `.ts` extensions because the multiplayer server loads
// this registry through Node's native type stripping, which does no extension
// guessing.

import { Block, type ToolKind } from '../blocks.ts';
import { ItemTile } from '../textures.ts';
import { BLOCKS } from '../blocks.ts';

/** Tool tiers: 0 hand, 1 wood, 2 stone, 3 iron, 4 diamond. */
export const TIER_HAND = 0;

export interface ToolStats {
  kind: ToolKind;
  tier: number;
  /** Mining speed multiplier against blocks this tool suits. */
  speed: number;
  durability: number;
}

/** Which body slot a piece of armour occupies. */
export type ArmorSlot = 'head' | 'chest' | 'legs' | 'feet';

export interface ArmorStats {
  slot: ArmorSlot;
  /** Armour points; 20 points is full protection (80% reduction). */
  points: number;
  durability: number;
  /** 1 leather, 2 iron, 3 diamond — sent over the network to draw the piece. */
  tier: number;
}

export interface FoodStats {
  /** Hunger points restored (20 is a full bar). */
  hunger: number;
  /** Seconds the eating animation runs before the bite lands. */
  eatTime: number;
}

export interface ItemDef {
  id: string;
  name: string;
  tile: number;
  maxStack: number;
  block?: Block;
  tool?: ToolStats;
  /**
   * Melee stats. `knockback` is how hard a landed hit shoves what it hits, in
   * the units shared/combat.ts turns into movement: a bare fist is 3.2, and
   * nothing goes above the diamond axe's 6.5. Heavier, slower weapons push
   * hardest; a pickaxe or a pair of shears barely more than a punch.
   */
  attack?: { damage: number; cooldown: number; knockback: number };
  food?: FoodStats;
  armor?: ArmorStats;
  /** Ranged weapon: charges up, then fires the named ammo item. */
  ranged?: { ammo: string; maxDamage: number; drawTime: number; durability: number };
  /** Held to block: reduces incoming damage while raised. */
  blocking?: { reduction: number; durability: number };
  /** Seed: the crop block sown when used on farmland. */
  plants?: Block;
}

const items = new Map<string, ItemDef>();

function register(def: ItemDef): ItemDef {
  items.set(def.id, def);
  return def;
}

/** Placeable block item; its icon is the block's side texture unless given. */
function blockItem(id: string, block: Block, name?: string, tile?: number): void {
  register({
    id,
    name: name ?? BLOCKS[block].name,
    tile: tile ?? BLOCKS[block].tiles.side,
    maxStack: 64,
    block,
  });
}

function material(id: string, name: string, tile: number): void {
  register({ id, name, tile, maxStack: 64 });
}

function food(id: string, name: string, tile: number, hunger: number, plants?: Block): void {
  register({ id, name, tile, maxStack: 64, food: { hunger, eatTime: 1.2 }, plants });
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
const HOE_TILES = [ItemTile.WoodenHoe, ItemTile.StoneHoe, ItemTile.IronHoe, ItemTile.DiamondHoe];

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
blockItem('wool', Block.Wool);
blockItem('chest', Block.Chest);
blockItem('hay_bale', Block.HayBale, 'Hay Bale');
blockItem('bed', Block.Bed, 'Bed', ItemTile.Bed);
blockItem('torch', Block.Torch);

// --- Materials ---
material('stick', 'Stick', ItemTile.Stick);
material('coal', 'Coal', ItemTile.Coal);
material('raw_iron', 'Raw Iron', ItemTile.RawIron);
material('raw_gold', 'Raw Gold', ItemTile.RawGold);
material('iron_ingot', 'Iron Ingot', ItemTile.IronIngot);
material('gold_ingot', 'Gold Ingot', ItemTile.GoldIngot);
material('diamond', 'Diamond', ItemTile.Diamond);
material('leather', 'Leather', ItemTile.Leather);
material('string', 'String', ItemTile.String);
material('flint', 'Flint', ItemTile.Flint);
material('bone', 'Bone', ItemTile.Bone);
material('wheat', 'Wheat', ItemTile.Wheat);
register({
  id: 'wheat_seeds',
  name: 'Wheat Seeds',
  tile: ItemTile.WheatSeeds,
  maxStack: 64,
  plants: Block.Wheat0,
});

// --- Food ---
// Cooked meat is worth far more than raw, which is what makes the furnace
// worth building; bread and carrots are the farmer's staples.
food('raw_porkchop', 'Raw Porkchop', ItemTile.RawPorkchop, 3);
food('cooked_porkchop', 'Cooked Porkchop', ItemTile.CookedPorkchop, 8);
food('raw_beef', 'Raw Beef', ItemTile.RawBeef, 3);
food('cooked_beef', 'Steak', ItemTile.CookedBeef, 8);
food('raw_mutton', 'Raw Mutton', ItemTile.RawMutton, 2);
food('cooked_mutton', 'Cooked Mutton', ItemTile.CookedMutton, 6);
food('rotten_flesh', 'Rotten Flesh', ItemTile.RottenFlesh, 2);
food('bread', 'Bread', ItemTile.Bread, 5);
food('apple', 'Apple', ItemTile.Apple, 4);
food('carrot', 'Carrot', ItemTile.Carrot, 3, Block.Carrots0);

// --- Tools and weapons ---
TOOL_TIERS.forEach((t, i) => {
  register({
    id: `${t.key}_pickaxe`,
    name: `${t.name} Pickaxe`,
    tile: PICKAXE_TILES[i],
    maxStack: 1,
    tool: { kind: 'pickaxe', tier: t.tier, speed: t.speed, durability: t.durability },
    // A pickaxe is for stone. Swung at something alive it is barely a punch.
    attack: { damage: 1 + t.tier, cooldown: 0.45, knockback: 3.4 + t.tier * 0.2 },
  });
  register({
    id: `${t.key}_axe`,
    name: `${t.name} Axe`,
    tile: AXE_TILES[i],
    maxStack: 1,
    tool: { kind: 'axe', tier: t.tier, speed: t.speed, durability: t.durability },
    // The heaviest swing in the game: slowest, and it shoves hardest.
    attack: { damage: 2 + t.tier, cooldown: 0.6, knockback: 4.5 + t.tier * 0.5 },
  });
  register({
    id: `${t.key}_sword`,
    name: `${t.name} Sword`,
    tile: SWORD_TILES[i],
    maxStack: 1,
    tool: { kind: 'sword', tier: t.tier, speed: 1.5, durability: t.durability },
    // Fast and sharp: more damage than an axe over time, less shove per blow.
    attack: { damage: 3 + t.tier, cooldown: 0.35, knockback: 4 + t.tier * 0.4 },
  });
  register({
    id: `${t.key}_hoe`,
    name: `${t.name} Hoe`,
    tile: HOE_TILES[i],
    maxStack: 1,
    tool: { kind: 'hoe', tier: t.tier, speed: t.speed, durability: t.durability },
    attack: { damage: 1, cooldown: 0.4, knockback: 3.4 },
  });
});
register({
  id: 'shears',
  name: 'Shears',
  tile: ItemTile.Shears,
  maxStack: 1,
  tool: { kind: 'shears', tier: 1, speed: 6, durability: 238 },
  // Snips rather than swings: the gentlest hit there is.
  attack: { damage: 1, cooldown: 0.4, knockback: 3 },
});

// --- Combat gear ---
register({
  id: 'bow',
  name: 'Bow',
  tile: ItemTile.Bow,
  maxStack: 1,
  ranged: { ammo: 'arrow', maxDamage: 9, drawTime: 1.0, durability: 384 },
  // Hitting someone with the bow itself; the arrow has its own shove.
  attack: { damage: 1, cooldown: 0.5, knockback: 3 },
});
material('arrow', 'Arrow', ItemTile.Arrow);
register({
  id: 'shield',
  name: 'Shield',
  tile: ItemTile.Shield,
  maxStack: 1,
  blocking: { reduction: 0.66, durability: 336 },
});

const ARMOR_TIERS = [
  { key: 'leather', name: 'Leather', mult: 1, durability: 80 },
  { key: 'iron', name: 'Iron', mult: 2.4, durability: 240 },
  { key: 'diamond', name: 'Diamond', mult: 3.4, durability: 528 },
] as const;

// Base points per slot; a chestplate protects most, boots least.
const ARMOR_SLOTS = [
  { slot: 'head' as ArmorSlot, piece: 'helmet', name: 'Helmet', base: 1.5 },
  { slot: 'chest' as ArmorSlot, piece: 'chestplate', name: 'Chestplate', base: 2.4 },
  { slot: 'legs' as ArmorSlot, piece: 'leggings', name: 'Leggings', base: 2.0 },
  { slot: 'feet' as ArmorSlot, piece: 'boots', name: 'Boots', base: 1.3 },
];

const ARMOR_TILES: Record<string, number[]> = {
  helmet: [ItemTile.LeatherHelmet, ItemTile.IronHelmet, ItemTile.DiamondHelmet],
  chestplate: [ItemTile.LeatherChestplate, ItemTile.IronChestplate, ItemTile.DiamondChestplate],
  leggings: [ItemTile.LeatherLeggings, ItemTile.IronLeggings, ItemTile.DiamondLeggings],
  boots: [ItemTile.LeatherBoots, ItemTile.IronBoots, ItemTile.DiamondBoots],
};

ARMOR_TIERS.forEach((tier, tierIndex) => {
  for (const slot of ARMOR_SLOTS) {
    register({
      id: `${tier.key}_${slot.piece}`,
      name: `${tier.name} ${slot.name}`,
      tile: ARMOR_TILES[slot.piece][tierIndex],
      maxStack: 1,
      armor: {
        slot: slot.slot,
        points: Math.round(slot.base * tier.mult),
        durability: tier.durability,
        tier: tierIndex + 1,
      },
    });
  }
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

/** Every item that can be eaten, for the food registry and the recipe book. */
export function allFoods(): ItemDef[] {
  return allItems().filter((def) => def.food !== undefined);
}
