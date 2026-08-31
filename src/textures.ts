// Procedural texture atlas: 16x16-pixel tiles drawn onto one canvas at startup,
// so the game ships with zero image assets. Nearest-filtered for the classic look.

import * as THREE from 'three';
import { Tile } from './blocks';

export const TILE_PX = 16;
export const ATLAS_TILES = 8; // 8x8 grid of tiles
const ATLAS_PX = TILE_PX * ATLAS_TILES;

/** Deterministic per-pixel hash so the atlas looks identical every run. */
function pixelHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

type RGB = [number, number, number];

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
  perPixel?: (px: number, py: number, rand: number) => RGB | null,
): void {
  const [ox, oy] = tileOrigin(tile);
  const img = ctx.createImageData(TILE_PX, TILE_PX);
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      const rand = pixelHash(px, py, tile * 7919);
      let rgb = perPixel?.(px, py, rand) ?? base;
      const jitter = 1 + (rand - 0.5) * 2 * variance;
      const i = (py * TILE_PX + px) * 4;
      img.data[i] = Math.min(255, rgb[0] * jitter);
      img.data[i + 1] = Math.min(255, rgb[1] * jitter);
      img.data[i + 2] = Math.min(255, rgb[2] * jitter);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, ox, oy);
}

function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX;
  canvas.height = ATLAS_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f0f';
  ctx.fillRect(0, 0, ATLAS_PX, ATLAS_PX);

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
  fillSpeckled(ctx, Tile.Cobblestone, [117, 117, 117], 0.08, (px, py) => {
    const cx = Math.floor(px / 5.34);
    const cy = Math.floor(py / 5.34);
    const jx = cx * 5.34 + 2.7 + (pixelHash(cx, cy, 5) - 0.5) * 2;
    const jy = cy * 5.34 + 2.7 + (pixelHash(cx, cy, 9) - 0.5) * 2;
    const d = Math.hypot(px - jx, py - jy);
    return d > 2.6 ? [86, 86, 86] : null;
  });

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
