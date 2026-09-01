// Procedural texture atlas: 16x16-pixel tiles drawn onto one canvas at startup,
// so the game ships with zero image assets. Block tiles are generated from
// noise; item icons are pixel-art sprite maps, drawn at native 16x16 where the
// detail earns it and 8x8 upscaled where it does not, then outlined and
// shaded automatically (see drawSprite). Nearest-filtered for the classic look.

import * as THREE from 'three';
import { Tile } from './blocks.ts';

export const TILE_PX = 16;
export const ATLAS_TILES = 16; // 16x16 grid of tiles
const ATLAS_PX = TILE_PX * ATLAS_TILES;

/**
 * Progressive block-damage overlays, drawn over the block being mined.
 * Ten stages, like Minecraft's destroy_stage_0..9.
 */
export const CRACK_TILE_0 = 64;
export const CRACK_STAGES = 10;

/** Which crack tile matches a 0..1 mining progress. */
export function crackTileFor(progress: number): number {
  const stage = Math.min(CRACK_STAGES - 1, Math.floor(progress * CRACK_STAGES));
  return CRACK_TILE_0 + Math.max(0, stage);
}

/**
 * Item icon tiles, continuing after the block tiles in blocks.ts.
 *
 * A plain const object rather than a `const enum` for the same reason as
 * `Block` and `Tile`: Node's native type stripping runs this file in tests and
 * cannot erase an enum. Call sites are identical either way.
 */
export const ItemTile = {
  WoodenPickaxe: 24,
  StonePickaxe: 25,
  IronPickaxe: 26,
  DiamondPickaxe: 27,
  WoodenSword: 28,
  StoneSword: 29,
  IronSword: 30,
  DiamondSword: 31,
  WoodenAxe: 32,
  StoneAxe: 33,
  IronAxe: 34,
  DiamondAxe: 35,
  Stick: 36,
  Coal: 37,
  RawIron: 38,
  RawGold: 39,
  IronIngot: 40,
  GoldIngot: 41,
  Diamond: 42,
  RawPorkchop: 43,
  CookedPorkchop: 44,
  RottenFlesh: 45,
  Bow: 46,
  Arrow: 47,
  Shield: 48,
  LeatherHelmet: 49,
  LeatherChestplate: 50,
  LeatherLeggings: 51,
  LeatherBoots: 52,
  IronHelmet: 53,
  IronChestplate: 54,
  IronLeggings: 55,
  IronBoots: 56,
  DiamondHelmet: 57,
  DiamondChestplate: 58,
  DiamondLeggings: 59,
  DiamondBoots: 60,
  Leather: 61,
  String: 62,
  Flint: 63,
  Bone: 74,
} as const;
export type ItemTile = (typeof ItemTile)[keyof typeof ItemTile];

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

/** How much darker the automatic outline is than the pixel it borders. */
const OUTLINE_DARKEN = 0.34;
/** Lightening on an upper-left edge, darkening on a lower-right one. */
const EDGE_LIGHT = 1.22;
const EDGE_SHADE = 0.78;

/**
 * Draw a sprite map into a tile. Rows may be 16 characters wide (drawn at
 * native resolution) or 8 (scaled 2x). Characters index `palette`; '.' or any
 * unmapped character leaves the pixel transparent.
 *
 * Two passes run over the result, which is what separates a readable icon from
 * a flat blob of colour, and what the shapes below are drawn to rely on:
 *
 *   outline — every transparent pixel touching the sprite becomes a darkened
 *             version of its neighbour, so an icon reads against any
 *             background instead of dissolving into it.
 *   edges   — pixels on an upper-left boundary lighten, lower-right darken,
 *             giving each shape a consistent light direction and some relief.
 *
 * Doing both here rather than by hand means every sprite gets them, including
 * ones added later, and the shape maps stay legible as shapes.
 */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  tile: number,
  rows: string[],
  palette: Record<string, RGB>,
): void {
  const [ox, oy] = tileOrigin(tile);
  const img = ctx.createImageData(TILE_PX, TILE_PX);
  const native = rows.length >= TILE_PX;
  const at = (px: number, py: number): RGB | undefined => {
    const row = native ? rows[py] : rows[py >> 1];
    const ch = (native ? row?.[px] : row?.[px >> 1]) ?? '.';
    return palette[ch];
  };
  const solid = (px: number, py: number): boolean =>
    px >= 0 && py >= 0 && px < TILE_PX && py < TILE_PX && at(px, py) !== undefined;

  const put = (px: number, py: number, rgb: RGB, scale: number): void => {
    const i = (py * TILE_PX + px) * 4;
    img.data[i] = Math.max(0, Math.min(255, rgb[0] * scale));
    img.data[i + 1] = Math.max(0, Math.min(255, rgb[1] * scale));
    img.data[i + 2] = Math.max(0, Math.min(255, rgb[2] * scale));
    img.data[i + 3] = 255;
  };

  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const rgb = at(px, py);
      if (rgb) {
        // Relief: an exposed top or left edge catches the light; an exposed
        // bottom or right edge falls into shadow.
        const lit = !solid(px, py - 1) || !solid(px - 1, py);
        const shaded = !solid(px, py + 1) || !solid(px + 1, py);
        put(px, py, rgb, lit && !shaded ? EDGE_LIGHT : shaded && !lit ? EDGE_SHADE : 1);
        continue;
      }
      // Outline: borrow the colour of whichever neighbour we are touching.
      const neighbour =
        at(px, py - 1) ?? at(px, py + 1) ?? at(px - 1, py) ?? at(px + 1, py) ??
        at(px - 1, py - 1) ?? at(px + 1, py - 1) ?? at(px - 1, py + 1) ?? at(px + 1, py + 1);
      if (neighbour && px < TILE_PX && py < TILE_PX) {
        put(px, py, neighbour, OUTLINE_DARKEN);
      } else {
        img.data[(py * TILE_PX + px) * 4 + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, ox, oy);
}

// --- Sprite shapes ---------------------------------------------------------
//
// Palette characters, used consistently across every shape:
//   H  the item's main material      L  its light/edge highlight
//   D  its dark shade                S  stick/handle light   s  handle dark
//   F  fletching                     .  transparent
//
// Tools and weapons are drawn at the tile's native 16x16 — four times the
// detail of an upscaled 8x8 map, which is what lets a pickaxe head actually
// look forged rather than like a staircase. Outlines and relief are added by
// drawSprite, so none of these maps draw their own.

const PICKAXE = [
  '................',
  '....LLLLLLLL....',
  '...LHHHHHHHHL...',
  '...LH......HL...',
  '...HH..Ss..HH...',
  '.......Ss.......',
  '......Ss........',
  '......Ss........',
  '.....Ss.........',
  '.....Ss.........',
  '....Ss..........',
  '....Ss..........',
  '...Ss...........',
  '...Ss...........',
  '................',
  '................',
];
const SWORD = [
  '................',
  '............LL..',
  '...........LHL..',
  '..........LHHL..',
  '.........LHHL...',
  '........LHHL....',
  '.......LHHL.....',
  '......LHHL......',
  '.....LHHL.......',
  '....LHHL........',
  '..DDDHD.........',
  '..DDsDD.........',
  '....Ss..........',
  '...Ss...........',
  '..Ss............',
  '................',
];
// A wedge, not a ball: the cutting edge runs down the left and the head
// tapers into the haft, which is what tells an axe from a hammer at 16px.
const AXE = [
  '................',
  '....LLLL........',
  '...LHHHHL.......',
  '..LHHHHHHL......',
  '..LHHHHHHHSs....',
  '..LHHHHHHSs.....',
  '..LHHHHHSs......',
  '...LHHHSs.......',
  '....LHSs........',
  '......Ss........',
  '.....Ss.........',
  '.....Ss.........',
  '....Ss..........',
  '....Ss..........',
  '...Ss...........',
  '................',
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
// A bow is a crescent and a chord, not a ring: the wooden limb curves down the
// left only, and the string is the single straight line joining its two tips.
// Wood on both sides closes the shape and it stops reading as a bow at all.
const BOW = [
  '................',
  '........HHH.....',
  '......HH...H....',
  '.....HH.....S...',
  '....HH......S...',
  '....H.......S...',
  '...HH.......S...',
  '...H........S...',
  '...H........S...',
  '...HH.......S...',
  '....H.......S...',
  '....HH......S...',
  '.....HH.....S...',
  '......HH...H....',
  '........HHH.....',
  '................',
];
const ARROW = [
  '................',
  '...........LLL..',
  '..........LHHL..',
  '.........LHHD...',
  '.........Ss.....',
  '........Ss......',
  '.......Ss.......',
  '......Ss........',
  '.....Ss.........',
  '....Ss..........',
  '...FFs..........',
  '..FFF...........',
  '.FFF............',
  '.FF.............',
  '................',
  '................',
];
const BONE = [
  '................',
  '...........HH...',
  '..........HHHH..',
  '..........HHHH..',
  '.........HHHH...',
  '........HHH.....',
  '.......HHH......',
  '......HHH.......',
  '.....HHH........',
  '....HHH.........',
  '...HHHH.........',
  '..HHHH..........',
  '..HHHH..........',
  '...HH...........',
  '................',
  '................',
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
  '................',
  '...LLLLLLLLLL...',
  '...LHHHHHHHHL...',
  '...LHDDDDDDHL...',
  '...LHDSSSSDHL...',
  '...LHDSSSSDHL...',
  '...LHDSSSSDHL...',
  '...LHDDDDDDHL...',
  '...LHHHHHHHHL...',
  '....LHHHHHHL....',
  '.....LHHHHL.....',
  '......LHHL......',
  '.......LL.......',
  '................',
  '................',
  '................',
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

/**
 * Ten block-damage overlays: a fixed set of jagged fractures that reveal
 * themselves one at a time, so the crack pattern grows rather than shuffling
 * between frames. Everything not on a fracture is fully transparent.
 */
function drawCrackTiles(ctx: CanvasRenderingContext2D): void {
  // Each fracture walks from a seed point in a jittered direction. Generating
  // them once and revealing progressively is what makes the stages continuous.
  interface Fracture {
    points: [number, number][];
    /** Stage at which this fracture starts appearing. */
    stage: number;
  }
  const fractures: Fracture[] = [];
  const CENTRE = (TILE_PX - 1) / 2;

  const COUNT = 15;
  for (let f = 0; f < COUNT; f++) {
    // Fan the fractures evenly around the tile rather than letting the hash
    // clump them, then jitter — otherwise damage looks like a smudge on one
    // side instead of a block splitting.
    const spoke = (f / COUNT) * Math.PI * 2 + (pixelHash(f, 0, 991) - 0.5) * 0.7;
    const radius = 1.5 + pixelHash(f, 1, 991) * 4.5;
    let x = CENTRE + Math.cos(spoke) * radius;
    let y = CENTRE + Math.sin(spoke) * radius;
    // Fractures run outward from where they start, so they reach the edges.
    let dir = spoke + (pixelHash(f, 2, 991) - 0.5) * 0.9;
    const points: [number, number][] = [];
    const length = 5 + Math.floor(pixelHash(f, 3, 991) * 6);
    for (let s = 0; s < length; s++) {
      points.push([Math.round(x), Math.round(y)]);
      dir += (pixelHash(f, s + 4, 991) - 0.5) * 1.2; // wander, so lines look split not drawn
      x += Math.cos(dir) * 1.5;
      y += Math.sin(dir) * 1.5;
      if (x < -1 || x > TILE_PX || y < -1 || y > TILE_PX) break;
    }
    fractures.push({ points, stage: Math.floor((f / COUNT) * CRACK_STAGES) });
  }

  for (let stage = 0; stage < CRACK_STAGES; stage++) {
    const [ox, oy] = tileOrigin(CRACK_TILE_0 + stage);
    const img = ctx.createImageData(TILE_PX, TILE_PX);
    // Transparent everywhere by default (createImageData zero-fills alpha).
    const plot = (px: number, py: number, alpha: number): void => {
      if (px < 0 || py < 0 || px >= TILE_PX || py >= TILE_PX) return;
      const i = (py * TILE_PX + px) * 4;
      if (img.data[i + 3] >= alpha) return;
      img.data[i] = 26;
      img.data[i + 1] = 24;
      img.data[i + 2] = 22;
      img.data[i + 3] = alpha;
    };

    for (const fracture of fractures) {
      if (fracture.stage > stage) continue;
      // A fracture extends as later stages arrive, rather than popping in whole.
      const grown = (stage - fracture.stage + 1) / (CRACK_STAGES - fracture.stage);
      const visible = Math.max(2, Math.ceil(fracture.points.length * grown));
      for (let p = 0; p < Math.min(visible, fracture.points.length); p++) {
        const [px, py] = fracture.points[p];
        plot(px, py, 240);
        // Fill the gap to the next point so a wandering fracture stays a line
        // rather than a dotted trail at 16 pixels across.
        const next = fracture.points[p + 1];
        if (next && p + 1 < visible) {
          plot(Math.round((px + next[0]) / 2), Math.round((py + next[1]) / 2), 245);
        }
        // One softer shoulder gives the crack depth without closing up the
        // face — late stages must still read as damaged stone, not a black hole.
        plot(px + 1, py, 105);
      }
    }
    ctx.putImageData(img, ox, oy);
  }
}

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
    const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
    drawSprite(ctx, tile, shape, {
      H: head,
      L: scale(head, 1.18),
      D: scale(head, 0.7),
      S: STICK_COLOR,
      s: scale(STICK_COLOR, 0.74),
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
  drawSprite(ctx, ItemTile.Bow, BOW, {
    H: [154, 107, 63], L: [186, 134, 82], D: [110, 76, 44], S: [231, 231, 218],
  });
  drawSprite(ctx, ItemTile.Arrow, ARROW, {
    H: [190, 190, 190], D: [140, 140, 140], S: STICK_COLOR, F: [235, 235, 235],
  });
  drawSprite(ctx, ItemTile.Shield, SHIELD, {
    H: [154, 107, 63], L: [188, 136, 84], D: [110, 76, 44], S: [206, 208, 214],
  });

  drawSprite(ctx, ItemTile.Leather, HIDE, { H: [178, 128, 84], D: [148, 102, 64] });
  drawSprite(ctx, ItemTile.String, STRING_SPRITE, { H: [232, 232, 226] });
  drawSprite(ctx, ItemTile.Flint, FLINT, { H: [72, 68, 68], D: [44, 42, 42] });
  drawSprite(ctx, ItemTile.Bone, BONE, { H: [226, 224, 208] });

  drawCrackTiles(ctx);

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
