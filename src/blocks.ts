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
  Wool: 20,
  Bed: 21,
  Farmland: 22,
  Wheat0: 23,
  Wheat1: 24,
  Wheat2: 25,
  Wheat3: 26,
  Carrots0: 27,
  Carrots1: 28,
  Carrots2: 29,
  Carrots3: 30,
  Chest: 31,
  DirtPath: 32,
  HayBale: 33,
  LitFurnace: 34,
  Torch: 35,
  // Flowing water, thinnest at level 7. `Water` above is a source block; these
  // are what a source spreads into, and they dry up when their source goes.
  WaterFlow1: 36,
  WaterFlow2: 37,
  WaterFlow3: 38,
  WaterFlow4: 39,
  WaterFlow5: 40,
  WaterFlow6: 41,
  WaterFlow7: 42,
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
  // Tiles 24-74 belong to items and crack overlays (see textures.ts).
  Wool: 75,
  Farmland: 76,
  Wheat0: 77,
  Wheat1: 78,
  Wheat2: 79,
  Wheat3: 80,
  Carrots0: 81,
  Carrots1: 82,
  Carrots2: 83,
  Carrots3: 84,
  ChestTop: 85,
  ChestFront: 86,
  ChestSide: 87,
  DirtPath: 88,
  HayTop: 89,
  HaySide: 90,
  BedTop: 91,
  BedSide: 92,
  FurnaceLit: 93,
  Torch: 94,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export type SoundKind = 'soft' | 'hard' | 'wood' | 'sand' | 'liquid' | 'glass';

/** Brightest light in the game; sunlight and a full-strength lamp both sit here. */
export const MAX_LIGHT = 15;
/** A torch, one step below daylight, so a lit cave still reads as a cave. */
export const TORCH_LIGHT = 14;
/** How many steps of flow a source is worth before the stream runs dry. */
export const WATER_LEVELS = 8;
/** Top of a full water block: slightly sunk, so a shoreline has an edge. */
export const WATER_SURFACE_HEIGHT = 0.875;

/** Which tool class mines a block quickly (and, if `minTier` > 0, at all). */
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe' | 'shears' | null;

/**
 * How a block fills its cell.
 *  - `cube`:  the ordinary full block.
 *  - `slab`:  a cube whose top sits at `height`; farmland, paths and beds.
 *  - `cross`: two diagonal sprite quads with no collision; crops.
 *  - `post`:  a thin box standing in the middle of the cell; torches.
 */
export type BlockShape = 'cube' | 'slab' | 'cross' | 'post';

/** A random extra drop rolled when a block breaks (apples from leaves, seeds). */
export interface BlockLoot {
  id: string;
  min: number;
  max: number;
  chance: number;
}

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
  shape: BlockShape;
  /** Top of the collision box and mesh, in blocks (1 for a full cube) */
  height: number;
  /** Seconds to break bare-handed with a correct-but-tierless tool; 0 = instant */
  hardness: number;
  /** Tool class that speeds this block up */
  tool: ToolKind;
  /** Minimum tool tier required for the block to drop anything (0 = hand) */
  minTier: number;
  /** Item id produced when broken, or null for nothing */
  drop: string | null;
  dropCount: number;
  /** Extra chance-based drops, rolled on top of `drop` */
  loot: BlockLoot[];
  breakable: boolean;
  sound: SoundKind;
  /** Crops: the block id of the next growth stage, or null when ripe */
  growsInto: number | null;
  /**
   * How much light this block swallows, 0..15. 0 lets light through
   * untouched (air, glass, a torch); 15 stops it dead (any solid block).
   * Anything between dims light as it passes, which is what makes deep
   * water darken with depth and a canopy cast shade.
   */
  lightOpacity: number;
  /** Light this block gives off, 0..15. A torch is 14. */
  lightEmission: number;
}

interface BlockOpts {
  opaque?: boolean;
  solid?: boolean;
  cutout?: boolean;
  shape?: BlockShape;
  height?: number;
  hardness?: number;
  tool?: ToolKind;
  minTier?: number;
  drop?: string | null;
  dropCount?: number;
  loot?: BlockLoot[];
  breakable?: boolean;
  sound?: SoundKind;
  growsInto?: number | null;
  lightOpacity?: number;
  lightEmission?: number;
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
  shape: opts.shape ?? 'cube',
  // Anything you cannot see or walk through stops light by default; sprites
  // and liquids let it through unless they say otherwise.
  lightOpacity:
    opts.lightOpacity ??
    ((opts.opaque ?? true) || ((opts.solid ?? true) && (opts.shape ?? 'cube') !== 'cross')
      ? 15
      : 0),
  lightEmission: opts.lightEmission ?? 0,
  height: opts.height ?? 1,
  hardness: opts.hardness ?? 1,
  tool: opts.tool ?? null,
  minTier: opts.minTier ?? 0,
  // Most blocks drop themselves; `drop: null` means nothing.
  drop: opts.drop === undefined ? name.toLowerCase().replace(/ /g, '_') : opts.drop,
  dropCount: opts.dropCount ?? 1,
  loot: opts.loot ?? [],
  breakable: opts.breakable ?? true,
  sound: opts.sound ?? 'soft',
  growsInto: opts.growsInto ?? null,
});

/** A growing crop: a see-through cross sprite that needs farmland underneath. */
const crop = (name: string, tile: number, next: number | null, drop: string, loot: BlockLoot[]) =>
  def(name, tile, tile, tile, {
    opaque: false,
    solid: false,
    cutout: true,
    shape: 'cross',
    hardness: 0,
    drop,
    loot,
    growsInto: next,
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
    // Daylight fades with depth, so the bottom of an ocean is genuinely gloomy.
    lightOpacity: 2,
  }),
  def('Log', Tile.LogTop, Tile.LogSide, Tile.LogTop, {
    hardness: 2,
    tool: 'axe',
    sound: 'wood',
  }),
  def('Leaves', Tile.Leaves, Tile.Leaves, Tile.Leaves, {
    hardness: 0.2,
    tool: 'shears',
    drop: null,
    // A canopy shades what is under it without blacking it out.
    lightOpacity: 3,
    // Foraging: the odd apple or stick falls out of a canopy.
    loot: [
      { id: 'apple', min: 1, max: 1, chance: 0.08 },
      { id: 'stick', min: 1, max: 2, chance: 0.05 },
    ],
  }),
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
    lightOpacity: 0, // a window is for looking through, and for daylight
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
  def('Wool', Tile.Wool, Tile.Wool, Tile.Wool, { hardness: 0.8, tool: 'shears' }),
  def('Bed', Tile.BedTop, Tile.BedSide, Tile.Planks, {
    opaque: false,
    shape: 'slab',
    height: 9 / 16,
    hardness: 0.3,
    sound: 'wood',
  }),
  def('Farmland', Tile.Farmland, Tile.Dirt, Tile.Dirt, {
    opaque: false,
    shape: 'slab',
    height: 15 / 16,
    hardness: 0.6,
    tool: 'shovel',
    drop: 'dirt',
  }),
  crop('Wheat', Tile.Wheat0, Block.Wheat1, 'wheat_seeds', []),
  crop('Wheat', Tile.Wheat1, Block.Wheat2, 'wheat_seeds', []),
  crop('Wheat', Tile.Wheat2, Block.Wheat3, 'wheat_seeds', []),
  crop('Wheat', Tile.Wheat3, null, 'wheat', [{ id: 'wheat_seeds', min: 1, max: 3, chance: 1 }]),
  crop('Carrots', Tile.Carrots0, Block.Carrots1, 'carrot', []),
  crop('Carrots', Tile.Carrots1, Block.Carrots2, 'carrot', []),
  crop('Carrots', Tile.Carrots2, Block.Carrots3, 'carrot', []),
  crop('Carrots', Tile.Carrots3, null, 'carrot', [{ id: 'carrot', min: 1, max: 3, chance: 1 }]),
  def('Chest', Tile.ChestTop, Tile.ChestFront, Tile.ChestTop, {
    hardness: 2.5,
    tool: 'axe',
    sound: 'wood',
  }),
  def('Dirt Path', Tile.DirtPath, Tile.Dirt, Tile.Dirt, {
    opaque: false,
    shape: 'slab',
    height: 15 / 16,
    hardness: 0.6,
    tool: 'shovel',
    drop: 'dirt',
  }),
  def('Hay Bale', Tile.HayTop, Tile.HaySide, Tile.HayTop, { hardness: 0.5, tool: 'hoe' }),
  // The lit furnace is the same block with its fire showing; it drops the
  // ordinary furnace so the two ids never leak into the inventory.
  def('Furnace', Tile.FurnaceTop, Tile.FurnaceLit, Tile.FurnaceTop, {
    hardness: 3.5,
    tool: 'pickaxe',
    minTier: 1,
    sound: 'hard',
    lightEmission: 13, // a lit furnace lights the room it is smelting in
  }),
  def('Torch', Tile.Torch, Tile.Torch, Tile.Torch, {
    opaque: false,
    solid: false,
    cutout: true,
    shape: 'post',
    height: 10 / 16,
    hardness: 0,
    sound: 'wood',
    lightOpacity: 0,
    lightEmission: TORCH_LIGHT,
  }),
  ...waterFlowDefs(),
];

/**
 * The seven flowing levels. They behave exactly like a source block except
 * that the simulation may take them away again, and each one sits lower than
 * the last, so a stream visibly thins out as it runs.
 */
function waterFlowDefs(): BlockDef[] {
  const out: BlockDef[] = [];
  for (let level = 1; level <= 7; level++) {
    out.push(
      def('Flowing Water', Tile.Water, Tile.Water, Tile.Water, {
        opaque: false,
        solid: false,
        breakable: false,
        hardness: Infinity,
        drop: null,
        sound: 'liquid',
        lightOpacity: 2,
        height: WATER_SURFACE_HEIGHT * ((WATER_LEVELS - level) / WATER_LEVELS),
      }),
    );
  }
  return out;
}

export const isOpaque = (id: number): boolean => id !== Block.Air && BLOCKS[id].opaque;
export const isSolid = (id: number): boolean => id !== Block.Air && BLOCKS[id].solid;
export const isCutout = (id: number): boolean => id !== Block.Air && BLOCKS[id].cutout;
/** Collision height of a block, 1 for anything that is not a slab. */
export const blockHeight = (id: number): number => BLOCKS[id]?.height ?? 1;
/** Crops in any growth stage. */
export const isCrop = (id: number): boolean => BLOCKS[id]?.shape === 'cross';
export const isFurnace = (id: number): boolean => id === Block.Furnace || id === Block.LitFurnace;

// --- Light ----------------------------------------------------------------

/** How much light this block takes out of whatever passes through it. */
export const lightOpacity = (id: number): number => BLOCKS[id]?.lightOpacity ?? MAX_LIGHT;
/** How much light this block gives off by itself. */
export const lightEmission = (id: number): number => BLOCKS[id]?.lightEmission ?? 0;

// --- Water ----------------------------------------------------------------

/** Water in any state: a source, or any of the seven flowing levels. */
export const isWater = (id: number): boolean =>
  id === Block.Water || (id >= Block.WaterFlow1 && id <= Block.WaterFlow7);
/** True only for water that will never dry up on its own. */
export const isWaterSource = (id: number): boolean => id === Block.Water;
/**
 * How far this water is from a source: 0 for a source itself, 1..7 as it
 * thins out, and -1 for anything that is not water at all.
 */
export const waterLevel = (id: number): number => {
  if (id === Block.Water) return 0;
  if (id >= Block.WaterFlow1 && id <= Block.WaterFlow7) return id - Block.WaterFlow1 + 1;
  return -1;
};
/**
 * Where the top of this water sits inside its cell, 0..1. A source almost
 * fills it; each level of flow sits lower, so a stream running downhill
 * steps down with it.
 */
export const waterSurfaceHeight = (id: number): number =>
  WATER_SURFACE_HEIGHT * ((WATER_LEVELS - Math.max(0, waterLevel(id))) / WATER_LEVELS);
/** The block id for a given flow level; level 0 is a source. */
export const waterBlockFor = (level: number): number =>
  level <= 0 ? Block.Water : Block.WaterFlow1 + Math.min(level, WATER_LEVELS - 1) - 1;
/** Air and water are both washed away when water flows in. */
export const isWaterReplaceable = (id: number): boolean =>
  id === Block.Air || isWater(id) || BLOCKS[id]?.shape === 'cross' || id === Block.Torch;
/** Ids that identify a block on the wire and in saves: the last valid one. */
export const MAX_BLOCK = BLOCKS.length - 1;
