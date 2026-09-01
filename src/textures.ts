// Procedural texture atlas: 16x16-pixel tiles drawn onto one canvas at startup,
// so the game ships with zero image assets. Block tiles are generated from
// noise; item icons are 8x8 pixel-art sprite maps scaled 2x. Nearest-filtered
// for the classic look.

import * as THREE from 'three';
import { Tile } from './blocks';

export const TILE_PX = 16;
export const ATLAS_TILES = 8; // 8x8 grid of tiles
const ATLAS_PX = TILE_PX * ATLAS_TILES;

/** Item icon tiles, continuing after the block tiles in blocks.ts. */
export const enum ItemTile {
  WoodenPickaxe = 24,
  StonePickaxe = 25,
  IronPickaxe = 26,
  DiamondPickaxe = 27,
  WoodenSword = 28,
  StoneSword = 29,
  IronSword = 30,
  DiamondSword = 31,
  WoodenAxe = 32,
  StoneAxe = 33,
  IronAxe = 34,
  DiamondAxe = 35,
  Stick = 36,
  Coal = 37,
  RawIron = 38,
  RawGold = 39,
  IronIngot = 40,
  GoldIngot = 41,
  Diamond = 42,
  RawPorkchop = 43,
  CookedPorkchop = 44,
  RottenFlesh = 45,
  Bow = 46,
  Arrow = 47,
  Shield = 48,
  LeatherHelmet = 49,
  LeatherChestplate = 50,
  LeatherLeggings = 51,
  LeatherBoots = 52,
  IronHelmet = 53,
  IronChestplate = 54,
  IronLeggings = 55,
  IronBoots = 56,
  DiamondHelmet = 57,
  DiamondChestplate = 58,
  DiamondLeggings = 59,
  DiamondBoots = 60,
  Leather = 61,
  String = 62,
  Flint = 63,
}

/** Deterministic per-pixel hash so the atlas looks identical every run. */
function pixelHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

let atlasCanvas: HTMLCanvasElement | null = null;
let atlasTexture: THREE.CanvasTexture | null = null;

function tileOrigin(tile: number): [number, number] {
  return [(tile % ATLAS_TILES) * TILE_PX, Math.floor(tile / ATLAS_TILES) * TILE_PX];
}

function fillSpeckled(
  ctx: CanvasRenderingContext2D,
  tile: number,
  base: RGB,
  variance: number,
  perPixel?: (px: number, py: number, rand: number) => RGB | RGBA | null,
): void {
  const [ox, oy] = tileOrigin(tile);
  const img = ctx.createImageData(TILE_PX, TILE_PX);
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const rand = pixelHash(px, py, tile * 7919);
      const rgb = perPixel?.(px, py, rand) ?? base;
      const jitter = 1 + (rand - 0.5) * 2 * variance;
      const i = (py * TILE_PX + px) * 4;
      img.data[i] = Math.min(255, rgb[0] * jitter);
      img.data[i + 1] = Math.min(255, rgb[1] * jitter);
      img.data[i + 2] = Math.min(255, rgb[2] * jitter);
      img.data[i + 3] = rgb.length === 4 ? rgb[3] : 255;
    }
  }
  ctx.putImageData(img, ox, oy);
}

/**
 * Draw an 8x8 sprite map scaled 2x into a tile. Characters index `palette`;
 * '.' (or any unmapped char) leaves the pixel fully transparent.
 */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  tile: number,
  rows: string[],
  palette: Record<string, RGB>,
): void {
  const [ox, oy] = tileOrigin(tile);
  const img = ctx.createImageData(TILE_PX, TILE_PX);
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const ch = rows[py >> 1]?.[px >> 1] ?? '.';
      const rgb = palette[ch];
      const i = (py * TILE_PX + px) * 4;
      if (!rgb) {
        img.data[i + 3] = 0;
        continue;
      }
      // Slight top-left lighting so icons read as 3D rather than flat.
      const shade = 1 - ((px >> 1) + (py >> 1)) * 0.012;
      img.data[i] = Math.min(255, rgb[0] * shade);
      img.data[i + 1] = Math.min(255, rgb[1] * shade);
      img.data[i + 2] = Math.min(255, rgb[2] * shade);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, ox, oy);
}

// --- Sprite shapes (S = stick/handle, H = head material, D = darker shade) ---
const PICKAXE = [
  '.HHHHH..',
  'HH...HH.',
  'H..S..H.',
  '...S....',
  '..S.....',
  '.S......',
  'S.......',
  '........',
];
const SWORD = [
  '.....HH.',
  '....HHH.',
  '...HHH..',
  '..HHH...',
  '.DHH....',
  '.DD.....',
  'SD......',
  'SS......',
];
const AXE = [
  '.HHH....',
  'HHHHH...',
  'HH.HH...',
  'H..S....',
  '...S....',
  '..S.....',
  '.S......',
  'S.......',
];
const LUMP = [
  '........',
  '..HHH...',
  '.HHHHH..',
  '.HHHHH..',
  '.HHHH...',
  '..HH....',
  '........',
  '........',
];
const INGOT = [
  '........',
  '........',
  '..HHHH..',
  '.HHHHHH.',
  '.HHHHHH.',
  '..HHHH..',
  '........',
  '........',
];
const GEM = [
  '...HH...',
  '..HHHH..',
  '.HHHHHH.',
  'HHHHHHHH',
  '.HHHHHH.',
  '..HHHH..',
  '...HH...',
  '........',
];
const MEAT = [
  '........',
  '..HHHH..',
  '.HHHHHH.',
  'HHHDDHH.',
  'HHHDDHH.',
  '.HHHHHH.',
  '..HHHH..',
  '........',
];

const HELMET = [
  '..HHHH..',
  '.HHHHHH.',
  'HHHHHHHH',
  'HHH..HHH',
  'HH....HH',
  '........',
  '........',
  '........',
];
const CHESTPLATE = [
  '.H.HH.H.',
  'HHHHHHHH',
  'HHHHHHHH',
  'HHHHHHHH',
  '.HHHHHH.',
  '.HHHHHH.',
  '.HH..HH.',
  '........',
];
const LEGGINGS = [
  '........',
  '.HHHHHH.',
  '.HHHHHH.',
  '.HHHHHH.',
  '.HH..HH.',
  '.HH..HH.',
  '.HH..HH.',
  '........',
];
const BOOTS = [
  '........',
  '........',
  '........',
  '.HH..HH.',
  '.HH..HH.',
  '.HH..HH.',
  'HHH..HHH',
  'HHHHHHHH',
];
const BOW = [
  '.....HH.',
  '...HH..H',
  '..H.S..H',
  '..H..S.H',
  '..H.S..H',
  '...HH..H',
  '.....HH.',
  '........',
];
const ARROW = [
  '......DH',
  '.....DHD',
  '....DS..',
  '...DS...',
  '..FS....',
  '.FFS....',
  'FF......',
  '........',
];
const HIDE = [
  '........',
  '.HHHHHH.',
  'HHHHHHHH',
  'HHHDDHHH',
  'HHHDDHHH',
  'HHHHHHHH',
  '.HHHHHH.',
  '........',
];
const STRING_SPRITE = [
  '..HH....',
  '.H..H...',
  'H....H..',
  '.H....H.',
  '..H....H',
  '...H..H.',
  '....HH..',
  '........',
];
const FLINT = [
  '........',
  '...HH...',
  '..HHHH..',
  '.HHHHDH.',
  '.HHHDDH.',
  '..HHDH..',
  '...HH...',
  '........',
];
const SHIELD = [
  '.HHHHHH.',
  '.HDDDDH.',
  '.HDSSDH.',
  '.HDSSDH.',
  '.HDDDDH.',
  '..HDDH..',
  '...HH...',
  '........',
];

const STICK_COLOR: RGB = [122, 88, 51];
const ARMOR_TIERS: Record<string, RGB> = {
  leather: [160, 106, 60],
  iron: [216, 216, 216],
  diamond: [92, 219, 213],
};
const TIER_COLORS: Record<string, RGB> = {
  wood: [156, 118, 70],
  stone: [130, 130, 130],
  iron: [216, 216, 216],
  diamond: [92, 219, 213],
};

function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, ATLAS_PX, ATLAS_PX);

  const GRASS: RGB = [106, 170, 64];
  const DIRT: RGB = [134, 96, 67];
  const STONE: RGB = [127, 127, 127];
  const SAND: RGB = [219, 205, 158];
  const WOOD_DARK: RGB = [85, 66, 40];
  const WOOD_LIGHT: RGB = [107, 84, 51];
  const LEAF: RGB = [58, 138, 68];
  const PLANK: RGB = [166, 132, 82];

  fillSpeckled(ctx, Tile.GrassTop, GRASS, 0.09);
  fillSpeckled(ctx, Tile.Dirt, DIRT, 0.1);
  fillSpeckled(ctx, Tile.Stone, STONE, 0.07);
  fillSpeckled(ctx, Tile.Sand, SAND, 0.06);
  fillSpeckled(ctx, Tile.Bedrock, [58, 58, 58], 0.28);
  fillSpeckled(ctx, Tile.Water, [55, 108, 196], 0.04);
  fillSpeckled(ctx, Tile.Gravel, [136, 130, 127], 0.22);

  // Dirt with a jagged grass fringe along the top edge (canvas y=0 renders as UV v=1).
  fillSpeckled(ctx, Tile.GrassSide, DIRT, 0.1, (px, py) => {
    const fringe = 3 + Math.floor(pixelHash(px, 0, 42) * 3);
    return py < fringe ? GRASS : null;
  });

  // Vertical bark stripes.
  fillSpeckled(ctx, Tile.LogSide, WOOD_LIGHT, 0.08, (px) =>
    pixelHash(px, 0, 77) < 0.4 ? WOOD_DARK : null,
  );

  // Concentric rings.
  fillSpeckled(ctx, Tile.LogTop, [177, 144, 86], 0.06, (px, py) => {
    const d = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
    return Math.floor(d) % 2 === 0 ? [157, 125, 70] : null;
  });

  // Leafy noise with dark gaps.
  fillSpeckled(ctx, Tile.Leaves, LEAF, 0.14, (_px, _py, rand) =>
    rand < 0.18 ? [34, 84, 41] : null,
  );

  // Horizontal boards with seams.
  fillSpeckled(ctx, Tile.Planks, PLANK, 0.05, (px, py) => {
    if (py % 4 === 3) return [120, 92, 53];
    if ((py < 4 || py >= 8) && py < 12 && px === 7) return [130, 100, 58];
    return null;
  });

  // Blobby cobbles: distance to jittered cell centres.
  const cobble = (px: number, py: number): RGB | null => {
    const cx = Math.floor(px / 5.34);
    const cy = Math.floor(py / 5.34);
    const jx = cx * 5.34 + 2.7 + (pixelHash(cx, cy, 5) - 0.5) * 2;
    const jy = cy * 5.34 + 2.7 + (pixelHash(cx, cy, 9) - 0.5) * 2;
    return Math.hypot(px - jx, py - jy) > 2.6 ? [86, 86, 86] : null;
  };
  fillSpeckled(ctx, Tile.Cobblestone, [117, 117, 117], 0.08, cobble);

  // Ores: stone base with a cluster of coloured specks.
  const oreTile = (tile: number, color: RGB, salt: number): void => {
    fillSpeckled(ctx, tile, STONE, 0.07, (px, py) => {
      // Two blobs per tile, positioned deterministically from the salt.
      for (let b = 0; b < 3; b++) {
        const bx = 3 + pixelHash(b, 0, salt) * 10;
        const by = 3 + pixelHash(b, 1, salt) * 10;
        if (Math.hypot(px - bx, py - by) < 2.1 + pixelHash(b, 2, salt) * 0.9) return color;
      }
      return null;
    });
  };
  oreTile(Tile.CoalOre, [38, 38, 38], 11);
  oreTile(Tile.IronOre, [197, 155, 121], 23);
  oreTile(Tile.GoldOre, [232, 196, 76], 37);
  oreTile(Tile.DiamondOre, [92, 219, 213], 53);

  // Brick courses, offset every other row.
  fillSpeckled(ctx, Tile.Bricks, [150, 84, 68], 0.05, (px, py) => {
    const course = Math.floor(py / 4);
    const mortarY = py % 4 === 0;
    const offset = course % 2 === 0 ? 0 : 4;
    const mortarX = (px + offset) % 8 === 0;
    return mortarY || mortarX ? [176, 168, 160] : null;
  });

  // Glass: opaque frame, transparent centre (alpha-tested in the cutout pass).
  fillSpeckled(ctx, Tile.Glass, [190, 226, 236], 0.02, (px, py) => {
    const edge = px === 0 || py === 0 || px === TILE_PX - 1 || py === TILE_PX - 1;
    if (edge) return [206, 236, 244];
    // A couple of diagonal highlight streaks keep it readable as glass.
    if (px + py === 6 || px + py === 20) return [226, 244, 250, 190] as RGBA;
    return [0, 0, 0, 0] as RGBA;
  });

  // Crafting table: grid on top, tool rack on the sides.
  fillSpeckled(ctx, Tile.CraftingTableTop, PLANK, 0.05, (px, py) => {
    if (px % 5 === 0 || py % 5 === 0) return [96, 72, 42];
    return null;
  });
  fillSpeckled(ctx, Tile.CraftingTableSide, PLANK, 0.05, (px, py) => {
    if (py < 3) return [120, 92, 53];
    if (py > 5 && py < 13 && (px === 4 || px === 11)) return [96, 72, 42];
    if (py === 9 && px > 3 && px < 12) return [96, 72, 42];
    return null;
  });

  // Furnace: cobble body with a dark opening on the front face.
  fillSpeckled(ctx, Tile.FurnaceSide, [117, 117, 117], 0.08, cobble);
  fillSpeckled(ctx, Tile.FurnaceTop, [110, 110, 110], 0.08, (px, py) => {
    const ring = Math.max(Math.abs(px - 7.5), Math.abs(py - 7.5));
    return ring < 4 ? [92, 92, 92] : cobble(px, py);
  });
  fillSpeckled(ctx, Tile.FurnaceFront, [117, 117, 117], 0.08, (px, py) => {
    if (px >= 3 && px <= 12 && py >= 6 && py <= 13) {
      // Glowing embers at the bottom of the opening.
      return py >= 11 ? [196, 108, 42] : [38, 34, 32];
    }
    return cobble(px, py);
  });

  // --- Item icons ---
  const tool = (tile: number, shape: string[], tier: keyof typeof TIER_COLORS): void => {
    const head = TIER_COLORS[tier];
    drawSprite(ctx, tile, shape, {
      H: head,
      D: [head[0] * 0.7, head[1] * 0.7, head[2] * 0.7],
      S: STICK_COLOR,
    });
  };
  tool(ItemTile.WoodenPickaxe, PICKAXE, 'wood');
  tool(ItemTile.StonePickaxe, PICKAXE, 'stone');
  tool(ItemTile.IronPickaxe, PICKAXE, 'iron');
  tool(ItemTile.DiamondPickaxe, PICKAXE, 'diamond');
  tool(ItemTile.WoodenSword, SWORD, 'wood');
  tool(ItemTile.StoneSword, SWORD, 'stone');
  tool(ItemTile.IronSword, SWORD, 'iron');
  tool(ItemTile.DiamondSword, SWORD, 'diamond');
  tool(ItemTile.WoodenAxe, AXE, 'wood');
  tool(ItemTile.StoneAxe, AXE, 'stone');
  tool(ItemTile.IronAxe, AXE, 'iron');
  tool(ItemTile.DiamondAxe, AXE, 'diamond');

  drawSprite(ctx, ItemTile.Stick, [
    '........',
    '.....SS.',
    '....SS..',
    '...SS...',
    '..SS....',
    '.SS.....',
    '.S......',
    '........',
  ], { S: STICK_COLOR });

  drawSprite(ctx, ItemTile.Coal, LUMP, { H: [42, 42, 42] });
  drawSprite(ctx, ItemTile.RawIron, LUMP, { H: [197, 160, 130] });
  drawSprite(ctx, ItemTile.RawGold, LUMP, { H: [216, 180, 74] });
  drawSprite(ctx, ItemTile.IronIngot, INGOT, { H: [216, 216, 216] });
  drawSprite(ctx, ItemTile.GoldIngot, INGOT, { H: [246, 208, 62] });
  drawSprite(ctx, ItemTile.Diamond, GEM, { H: [92, 219, 213] });
  drawSprite(ctx, ItemTile.RawPorkchop, MEAT, { H: [238, 154, 150], D: [214, 112, 108] });
  drawSprite(ctx, ItemTile.CookedPorkchop, MEAT, { H: [190, 130, 74], D: [150, 96, 50] });
  drawSprite(ctx, ItemTile.RottenFlesh, MEAT, { H: [130, 110, 72], D: [96, 80, 52] });

  // Bow, arrow and shield.
  drawSprite(ctx, ItemTile.Bow, BOW, { H: [154, 107, 63], S: [225, 225, 210] });
  drawSprite(ctx, ItemTile.Arrow, ARROW, {
    H: [190, 190, 190], D: [140, 140, 140], S: STICK_COLOR, F: [235, 235, 235],
  });
  drawSprite(ctx, ItemTile.Shield, SHIELD, {
    H: [122, 84, 46], D: [154, 107, 63], S: [200, 200, 200],
  });

  drawSprite(ctx, ItemTile.Leather, HIDE, { H: [178, 128, 84], D: [148, 102, 64] });
  drawSprite(ctx, ItemTile.String, STRING_SPRITE, { H: [232, 232, 226] });
  drawSprite(ctx, ItemTile.Flint, FLINT, { H: [72, 68, 68], D: [44, 42, 42] });

  // Armour: one shape per slot, recoloured per tier.
  const armorPieces: [number[], string[]][] = [
    [[ItemTile.LeatherHelmet, ItemTile.IronHelmet, ItemTile.DiamondHelmet], HELMET],
    [[ItemTile.LeatherChestplate, ItemTile.IronChestplate, ItemTile.DiamondChestplate], CHESTPLATE],
    [[ItemTile.LeatherLeggings, ItemTile.IronLeggings, ItemTile.DiamondLeggings], LEGGINGS],
    [[ItemTile.LeatherBoots, ItemTile.IronBoots, ItemTile.DiamondBoots], BOOTS],
  ];
  const tierOrder = ['leather', 'iron', 'diamond'];
  for (const [tiles, shape] of armorPieces) {
    tiles.forEach((tile, i) => {
      const base = ARMOR_TIERS[tierOrder[i]];
      drawSprite(ctx, tile, shape, {
        H: base,
        D: [base[0] * 0.72, base[1] * 0.72, base[2] * 0.72],
      });
    });
  }

  return canvas;
}

export function getAtlasCanvas(): HTMLCanvasElement {
  if (!atlasCanvas) atlasCanvas = buildAtlas();
  return atlasCanvas;
}

export function getAtlasTexture(): THREE.CanvasTexture {
  if (!atlasTexture) {
    atlasTexture = new THREE.CanvasTexture(getAtlasCanvas());
    atlasTexture.magFilter = THREE.NearestFilter;
    atlasTexture.minFilter = THREE.NearestFilter;
    atlasTexture.generateMipmaps = false;
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return atlasTexture;
}

/**
 * UV rectangle for a tile, as [u0, v0, u1, v1] with v0 = texture-space bottom.
 * A half-pixel inset guards against sampling bleed from adjacent tiles.
 */
export function tileUVRect(tile: number): [number, number, number, number] {
  const inset = 0.5 / ATLAS_PX;
  const col = tile % ATLAS_TILES;
  const row = Math.floor(tile / ATLAS_TILES);
  const u0 = col / ATLAS_TILES + inset;
  const u1 = (col + 1) / ATLAS_TILES - inset;
  // Canvas textures flip Y: canvas row 0 is UV v=1.
  const v1 = 1 - row / ATLAS_TILES - inset;
  const v0 = 1 - (row + 1) / ATLAS_TILES + inset;
  return [u0, v0, u1, v1];
}

/** Draw one atlas tile into a 2D context (hotbar and inventory icons). */
export function drawTileTo(
  ctx: CanvasRenderingContext2D,
  tile: number,
  dx: number,
  dy: number,
  size: number,
): void {
  const [ox, oy] = tileOrigin(tile);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(getAtlasCanvas(), ox, oy, TILE_PX, TILE_PX, dx, dy, size, size);
}
