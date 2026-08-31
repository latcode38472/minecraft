// Block registry. Tile numbers index into the procedural texture atlas (textures.ts).

export const enum Block {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Bedrock = 5,
  Water = 6,
  Log = 7,
  Leaves = 8,
  Planks = 9,
  Cobblestone = 10,
}

export const enum Tile {
  GrassTop = 0,
  GrassSide = 1,
  Dirt = 2,
  Stone = 3,
  Sand = 4,
  Bedrock = 5,
  Water = 6,
  LogSide = 7,
  LogTop = 8,
  Leaves = 9,
  Planks = 10,
  Cobblestone = 11,
}

export type SoundKind = 'soft' | 'hard' | 'wood' | 'sand' | 'liquid';

export interface BlockDef {
  name: string;
  /** Atlas tiles per face group */
  tiles: { top: number; side: number; bottom: number };
  /** Opaque blocks cull neighbouring faces and cast ambient occlusion */
  opaque: boolean;
  /** Solid blocks collide with the player */
  solid: boolean;
  breakable: boolean;
  sound: SoundKind;
}

const def = (
  name: string,
  top: number,
  side: number,
  bottom: number,
  opts: Partial<Pick<BlockDef, 'opaque' | 'solid' | 'breakable' | 'sound'>> = {},
): BlockDef => ({
  name,
  tiles: { top, side, bottom },
  opaque: opts.opaque ?? true,
  solid: opts.solid ?? true,
  breakable: opts.breakable ?? true,
  sound: opts.sound ?? 'soft',
});

/** Indexed by block id. Air has a placeholder entry that is never rendered. */
export const BLOCKS: BlockDef[] = [
  def('Air', 0, 0, 0, { opaque: false, solid: false }),
  def('Grass', Tile.GrassTop, Tile.GrassSide, Tile.Dirt),
  def('Dirt', Tile.Dirt, Tile.Dirt, Tile.Dirt),
  def('Stone', Tile.Stone, Tile.Stone, Tile.Stone, { sound: 'hard' }),
  def('Sand', Tile.Sand, Tile.Sand, Tile.Sand, { sound: 'sand' }),
  def('Bedrock', Tile.Bedrock, Tile.Bedrock, Tile.Bedrock, { breakable: false, sound: 'hard' }),
  def('Water', Tile.Water, Tile.Water, Tile.Water, {
    opaque: false,
    solid: false,
    sound: 'liquid',
  }),
  def('Log', Tile.LogTop, Tile.LogSide, Tile.LogTop, { sound: 'wood' }),
  def('Leaves', Tile.Leaves, Tile.Leaves, Tile.Leaves),
  def('Planks', Tile.Planks, Tile.Planks, Tile.Planks, { sound: 'wood' }),
  def('Cobblestone', Tile.Cobblestone, Tile.Cobblestone, Tile.Cobblestone, { sound: 'hard' }),
];

export const HOTBAR_BLOCKS: Block[] = [
  Block.Grass,
  Block.Dirt,
  Block.Stone,
  Block.Sand,
  Block.Log,
  Block.Leaves,
  Block.Planks,
  Block.Cobblestone,
  Block.Water,
];

export const isOpaque = (id: number): boolean => id !== Block.Air && BLOCKS[id].opaque;
export const isSolid = (id: number): boolean => id !== Block.Air && BLOCKS[id].solid;
