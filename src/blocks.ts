// Block registry. Tile numbers index into the procedural texture atlas
// (textures.ts); drop ids reference the item registry (items/items.ts).
//
// Block and Tile are plain const objects rather than `const enum` because the
// multiplayer server imports this file and runs it through Node's native type
// stripping, which cannot erase an enum. They behave identically at call sites.

export const Block = {
  Air: 0,
  Grass: 1,
  Dirt: 2,
  Stone: 3,
  Sand: 4,
  Bedrock: 5,
  Water: 6,
  Log: 7,
  Leaves: 8,
  Planks: 9,
  Cobblestone: 10,
  Gravel: 11,
  CoalOre: 12,
  IronOre: 13,
  GoldOre: 14,
  DiamondOre: 15,
  Bricks: 16,
  Glass: 17,
  CraftingTable: 18,
  Furnace: 19,
} as const;
export type Block = (typeof Block)[keyof typeof Block];

export const Tile = {
  GrassTop: 0,
  GrassSide: 1,
  Dirt: 2,
  Stone: 3,
  Sand: 4,
  Bedrock: 5,
  Water: 6,
  LogSide: 7,
  LogTop: 8,
  Leaves: 9,
  Planks: 10,
  Cobblestone: 11,
  Gravel: 12,
  CoalOre: 13,
  IronOre: 14,
  GoldOre: 15,
  DiamondOre: 16,
  Bricks: 17,
  Glass: 18,
  CraftingTableTop: 19,
  CraftingTableSide: 20,
  FurnaceFront: 21,
  FurnaceSide: 22,
  FurnaceTop: 23,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export type SoundKind = 'soft' | 'hard' | 'wood' | 'sand' | 'liquid' | 'glass';

/** Which tool class mines a block quickly (and, if `minTier` > 0, at all). */
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | null;

export interface BlockDef {
  name: string;
  /** Atlas tiles per face group */
  tiles: { top: number; side: number; bottom: number };
  /** Opaque blocks cull neighbouring faces and cast ambient occlusion */
  opaque: boolean;
  /** Solid blocks collide with the player */
  solid: boolean;
  /** Rendered in the alpha-tested pass (see-through, but still a real block) */
  cutout: boolean;
  /** Seconds to break bare-handed with a correct-but-tierless tool; 0 = instant */
  hardness: number;
  /** Tool class that speeds this block up */
  tool: ToolKind;
  /** Minimum tool tier required for the block to drop anything (0 = hand) */
  minTier: number;
  /** Item id produced when broken, or null for nothing */
  drop: string | null;
  dropCount: number;
  breakable: boolean;
  sound: SoundKind;
}

interface BlockOpts {
  opaque?: boolean;
  solid?: boolean;
  cutout?: boolean;
  hardness?: number;
  tool?: ToolKind;
  minTier?: number;
  drop?: string | null;
  dropCount?: number;
  breakable?: boolean;
  sound?: SoundKind;
}

const def = (
  name: string,
  top: number,
  side: number,
  bottom: number,
  opts: BlockOpts = {},
): BlockDef => ({
  name,
  tiles: { top, side, bottom },
  opaque: opts.opaque ?? true,
  solid: opts.solid ?? true,
  cutout: opts.cutout ?? false,
  hardness: opts.hardness ?? 1,
  tool: opts.tool ?? null,
  minTier: opts.minTier ?? 0,
  // Most blocks drop themselves; `drop: null` means nothing.
  drop: opts.drop === undefined ? name.toLowerCase().replace(/ /g, '_') : opts.drop,
  dropCount: opts.dropCount ?? 1,
  breakable: opts.breakable ?? true,
  sound: opts.sound ?? 'soft',
});

/** Indexed by block id. Air has a placeholder entry that is never rendered. */
export const BLOCKS: BlockDef[] = [
  def('Air', 0, 0, 0, { opaque: false, solid: false, drop: null, breakable: false }),
  def('Grass', Tile.GrassTop, Tile.GrassSide, Tile.Dirt, {
    hardness: 0.6,
    tool: 'shovel',
    drop: 'dirt',
  }),
  def('Dirt', Tile.Dirt, Tile.Dirt, Tile.Dirt, { hardness: 0.5, tool: 'shovel' }),
  def('Stone', Tile.Stone, Tile.Stone, Tile.Stone, {
    hardness: 1.5,
    tool: 'pickaxe',
    minTier: 1,
    drop: 'cobblestone',
    sound: 'hard',
  }),
  def('Sand', Tile.Sand, Tile.Sand, Tile.Sand, {
    hardness: 0.5,
    tool: 'shovel',
    sound: 'sand',
  }),
  def('Bedrock', Tile.Bedrock, Tile.Bedrock, Tile.Bedrock, {
    breakable: false,
    hardness: Infinity,
    drop: null,
    sound: 'hard',
  }),
  def('Water', Tile.Water, Tile.Water, Tile.Water, {
    opaque: false,
    solid: false,
    breakable: false,
    hardness: Infinity,
    drop: null,
    sound: 'liquid',
  }),
  def('Log', Tile.LogTop, Tile.LogSide, Tile.LogTop, {
    hardness: 2,
    tool: 'axe',
    sound: 'wood',
  }),
  def('Leaves', Tile.Leaves, Tile.Leaves, Tile.Leaves, { hardness: 0.2, drop: null }),
  def('Planks', Tile.Planks, Tile.Planks, Tile.Planks, {
    hardness: 2,
    tool: 'axe',
    sound: 'wood',
  }),
  def('Cobblestone', Tile.Cobblestone, Tile.Cobblestone, Tile.Cobblestone, {
    hardness: 2,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'hard',
  }),
  def('Gravel', Tile.Gravel, Tile.Gravel, Tile.Gravel, {
    hardness: 0.6,
    tool: 'shovel',
    sound: 'sand',
  }),
  def('Coal Ore', Tile.CoalOre, Tile.CoalOre, Tile.CoalOre, {
    hardness: 3,
    tool: 'pickaxe',
    minTier: 1,
    drop: 'coal',
    sound: 'hard',
  }),
  def('Iron Ore', Tile.IronOre, Tile.IronOre, Tile.IronOre, {
    hardness: 3,
    tool: 'pickaxe',
    minTier: 2,
    drop: 'raw_iron',
    sound: 'hard',
  }),
  def('Gold Ore', Tile.GoldOre, Tile.GoldOre, Tile.GoldOre, {
    hardness: 3,
    tool: 'pickaxe',
    minTier: 3,
    drop: 'raw_gold',
    sound: 'hard',
  }),
  def('Diamond Ore', Tile.DiamondOre, Tile.DiamondOre, Tile.DiamondOre, {
    hardness: 3,
    tool: 'pickaxe',
    minTier: 3,
    drop: 'diamond',
    sound: 'hard',
  }),
  def('Bricks', Tile.Bricks, Tile.Bricks, Tile.Bricks, {
    hardness: 2,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'hard',
  }),
  def('Glass', Tile.Glass, Tile.Glass, Tile.Glass, {
    opaque: false,
    cutout: true,
    hardness: 0.3,
    drop: null, // shatters, like Minecraft
    sound: 'glass',
  }),
  def('Crafting Table', Tile.CraftingTableTop, Tile.CraftingTableSide, Tile.Planks, {
    hardness: 2.5,
    tool: 'axe',
    sound: 'wood',
  }),
  def('Furnace', Tile.FurnaceTop, Tile.FurnaceFront, Tile.FurnaceTop, {
    hardness: 3.5,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'hard',
  }),
];

export const isOpaque = (id: number): boolean => id !== Block.Air && BLOCKS[id].opaque;
export const isSolid = (id: number): boolean => id !== Block.Air && BLOCKS[id].solid;
export const isCutout = (id: number): boolean => id !== Block.Air && BLOCKS[id].cutout;
