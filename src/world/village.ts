// Villages: a well, a few houses along dirt paths, farms, and chests.
//
// Everything is a pure function of (seed, cell): the world is divided into
// square cells of VILLAGE_CHUNK_SPACING chunks and each cell may hold one
// village, laid out once from a seeded generator and then clipped into every
// chunk it overlaps. The same village therefore appears identically on the
// server, on every client, and after any reload — no village state is stored.
//
// Loaded by Node as well as the browser: erasable TypeScript only.

import { Block } from '../blocks.ts';
import { CHUNK_SIZE, SEA_LEVEL, VILLAGE_CHUNK_SPACING, WORLD_HEIGHT } from '../constants.ts';
import { positionSeed, seededRandom } from '../shared/loot.ts';
import type { VillageInfo } from '../shared/roomsim.ts';
import type { Chunk } from './chunk.ts';
import { coordRandom } from './noise.ts';

/** Side length of a village cell, in blocks. */
export const VILLAGE_CELL = VILLAGE_CHUNK_SPACING * CHUNK_SIZE;
/** Chance a cell holds a village at all. */
const VILLAGE_CHANCE = 0.62;
/** A village never reaches farther than this from its well. */
export const VILLAGE_MAX_RADIUS = 36;
/** Centres keep this far from the cell edge, so a village never leaves its cell. */
const CELL_MARGIN = VILLAGE_MAX_RADIUS + 4;
const SALT = 0x51a6e;
const CROP_SALT = 0x3c0b;

export type HeightFn = (x: number, z: number) => number;

/** An axis-aligned footprint, inclusive on both ends. */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** 0 = +x, 1 = +z, 2 = -x, 3 = -z: the direction a path runs or a door faces. */
export type Facing = 0 | 1 | 2 | 3;

export interface House extends Rect {
  floor: number;
  /** Doorway column, on the wall that faces the path. */
  door: { x: number; z: number };
  facing: Facing;
  /** Picks the furniture: 0 crafting table, 1 furnace. */
  variant: number;
}

export interface Farm extends Rect {
  floor: number;
  crop: 'wheat' | 'carrots';
}

export interface Village extends VillageInfo {
  floor: number;
  houses: House[];
  farms: Farm[];
  paths: Rect[];
  /** Everything the village occupies, for overlap and clipping checks. */
  bounds: Rect;
}

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return !(
    a.x1 + margin < b.x0 ||
    b.x1 + margin < a.x0 ||
    a.z1 + margin < b.z0 ||
    b.z1 + margin < a.z0
  );
}

function farthestCorner(r: Rect, cx: number, cz: number): number {
  return Math.max(
    Math.hypot(r.x0 - cx, r.z0 - cz),
    Math.hypot(r.x1 - cx, r.z0 - cz),
    Math.hypot(r.x0 - cx, r.z1 - cz),
    Math.hypot(r.x1 - cx, r.z1 - cz),
  );
}

/** Is the ground here dry land where a building can stand? */
function isLand(heightAt: HeightFn, x: number, z: number): boolean {
  return heightAt(x, z) > SEA_LEVEL + 2;
}

/**
 * Lay out the village for a cell, or null when the cell has none. Deterministic
 * in (seed, gx, gz).
 */
export function layoutVillage(seed: number, gx: number, gz: number, heightAt: HeightFn): Village | null {
  const rand = seededRandom(positionSeed(seed ^ SALT, gx, 11, gz));
  if (rand() >= VILLAGE_CHANCE) return null;

  // Find a centre on flat, dry ground. A few tries; otherwise no village here.
  let cx = 0;
  let cz = 0;
  let found = false;
  for (let attempt = 0; attempt < 5 && !found; attempt++) {
    cx = gx * VILLAGE_CELL + CELL_MARGIN + Math.floor(rand() * (VILLAGE_CELL - 2 * CELL_MARGIN));
    cz = gz * VILLAGE_CELL + CELL_MARGIN + Math.floor(rand() * (VILLAGE_CELL - 2 * CELL_MARGIN));
    if (!isLand(heightAt, cx, cz)) continue;
    let lo = Infinity;
    let hi = -Infinity;
    let dry = true;
    for (let i = 0; i < 8 && dry; i++) {
      const angle = (i / 8) * Math.PI * 2;
      for (const r of [10, 20]) {
        const x = Math.round(cx + Math.cos(angle) * r);
        const z = Math.round(cz + Math.sin(angle) * r);
        const h = heightAt(x, z);
        if (h <= SEA_LEVEL + 1) dry = false;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    if (dry && hi - lo <= 7) found = true;
  }
  if (!found) return null;

  const floor = heightAt(cx, cz);
  const placed: Rect[] = [];
  const houses: House[] = [];
  const farms: Farm[] = [];
  const paths: Rect[] = [];

  const well: Rect = { x0: cx - 1, z0: cz - 1, x1: cx + 1, z1: cz + 1 };
  placed.push(well);

  // Four straight arms from the well; buildings hang off either side of each.
  const arms: { dir: Facing; length: number }[] = [];
  for (let dir = 0; dir < 4; dir++) {
    const length = 14 + Math.floor(rand() * 9);
    const [dx, dz] = DIRS[dir];
    const rect: Rect =
      dx !== 0
        ? {
            x0: Math.min(cx + dx * 2, cx + dx * (2 + length)),
            x1: Math.max(cx + dx * 2, cx + dx * (2 + length)),
            z0: cz - 1,
            z1: cz,
          }
        : {
            z0: Math.min(cz + dz * 2, cz + dz * (2 + length)),
            z1: Math.max(cz + dz * 2, cz + dz * (2 + length)),
            x0: cx - 1,
            x1: cx,
          };
    paths.push(rect);
    arms.push({ dir: dir as Facing, length });
  }

  /**
   * A building beside an arm: `along` blocks out from the well, on `side`
   * (+1/-1) of the path, `w` wide across the path and `d` deep away from it.
   * Returns the footprint and the door column, or null when it collides.
   */
  const tryPlace = (arm: { dir: Facing; length: number }, side: 1 | -1, w: number, d: number): { rect: Rect; door: { x: number; z: number }; facing: Facing } | null => {
    const [dx, dz] = DIRS[arm.dir];
    const along = 3 + Math.floor(rand() * Math.max(1, arm.length - w - 2));
    // Path occupies the two columns [c-1, c] across; the building starts 2 past it.
    let rect: Rect;
    let door: { x: number; z: number };
    let facing: Facing;
    if (dx !== 0) {
      const xStart = cx + dx * (2 + along);
      const x0 = Math.min(xStart, xStart + dx * (w - 1));
      const x1 = Math.max(xStart, xStart + dx * (w - 1));
      const zNear = side === 1 ? cz + 2 : cz - 3;
      const z0 = side === 1 ? zNear : zNear - (d - 1);
      const z1 = side === 1 ? zNear + (d - 1) : zNear;
      rect = { x0, z0, x1, z1 };
      const doorZ = side === 1 ? z0 : z1;
      door = { x: Math.floor((x0 + x1) / 2), z: doorZ };
      facing = side === 1 ? 3 : 1;
    } else {
      const zStart = cz + dz * (2 + along);
      const z0 = Math.min(zStart, zStart + dz * (w - 1));
      const z1 = Math.max(zStart, zStart + dz * (w - 1));
      const xNear = side === 1 ? cx + 2 : cx - 3;
      const x0 = side === 1 ? xNear : xNear - (d - 1);
      const x1 = side === 1 ? xNear + (d - 1) : xNear;
      rect = { x0, z0, x1, z1 };
      const doorX = side === 1 ? x0 : x1;
      door = { x: doorX, z: Math.floor((z0 + z1) / 2) };
      facing = side === 1 ? 2 : 0;
    }
    if (farthestCorner(rect, cx, cz) > VILLAGE_MAX_RADIUS - 1) return null;
    for (const other of placed) if (overlaps(rect, other, 1)) return null;
    for (const path of paths) if (overlaps(rect, path, 0)) return null;
    return { rect, door, facing };
  };

  // Houses first: up to two per arm, one each side.
  const slots: { arm: { dir: Facing; length: number }; side: 1 | -1 }[] = [];
  for (const arm of arms) for (const side of [1, -1] as const) slots.push({ arm, side });
  // Shuffle so the first arm is not always the fullest.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  const wantHouses = 4 + Math.floor(rand() * 4);
  const wantFarms = 1 + Math.floor(rand() * 3);
  for (const slot of slots) {
    // Farms take a slot early now and then, so a village is not all houses
    // with the fields squeezed out.
    const farmFirst = farms.length < wantFarms && (houses.length >= wantHouses || rand() < 0.35);
    if (!farmFirst && houses.length < wantHouses) {
      const w = 5 + Math.floor(rand() * 3);
      const d = 5 + Math.floor(rand() * 3);
      const spot = tryPlace(slot.arm, slot.side, w, d);
      if (spot) {
        const hx = Math.floor((spot.rect.x0 + spot.rect.x1) / 2);
        const hz = Math.floor((spot.rect.z0 + spot.rect.z1) / 2);
        const houseFloor = heightAt(hx, hz);
        if (isLand(heightAt, hx, hz) && Math.abs(houseFloor - floor) <= 6) {
          houses.push({
            ...spot.rect,
            floor: Math.max(houseFloor, floor - 3),
            door: spot.door,
            facing: spot.facing,
            variant: Math.floor(rand() * 2),
          });
          placed.push(spot.rect);
          continue;
        }
      }
    }
    if (farms.length < wantFarms) {
      const w = 7 + Math.floor(rand() * 2) * 2; // 7 or 9, odd so the channel is centred
      const d = 5 + Math.floor(rand() * 3);
      const spot = tryPlace(slot.arm, slot.side, w, d);
      if (spot) {
        const fx = Math.floor((spot.rect.x0 + spot.rect.x1) / 2);
        const fz = Math.floor((spot.rect.z0 + spot.rect.z1) / 2);
        const farmFloor = heightAt(fx, fz);
        if (isLand(heightAt, fx, fz) && Math.abs(farmFloor - floor) <= 6) {
          farms.push({ ...spot.rect, floor: farmFloor, crop: rand() < 0.5 ? 'wheat' : 'carrots' });
          placed.push(spot.rect);
        }
      }
    }
  }

  if (houses.length === 0) return null;

  const bounds: Rect = { x0: cx, z0: cz, x1: cx, z1: cz };
  let radius = 4;
  for (const r of [...placed, ...paths]) {
    bounds.x0 = Math.min(bounds.x0, r.x0 - 1);
    bounds.z0 = Math.min(bounds.z0, r.z0 - 1);
    bounds.x1 = Math.max(bounds.x1, r.x1 + 1);
    bounds.z1 = Math.max(bounds.z1, r.z1 + 1);
    radius = Math.max(radius, farthestCorner(r, cx, cz) + 2);
  }

  return {
    id: `${gx},${gz}`,
    x: cx,
    z: cz,
    radius: Math.min(VILLAGE_MAX_RADIUS, Math.ceil(radius)),
    floor,
    houses,
    farms,
    paths,
    bounds,
  };
}

// --- Placement ------------------------------------------------------------

/** Writes blocks into one chunk, clipped; anything outside is skipped. */
class ChunkWriter {
  readonly chunk: Chunk;
  readonly ox: number;
  readonly oz: number;

  constructor(chunk: Chunk) {
    this.chunk = chunk;
    this.ox = chunk.cx * CHUNK_SIZE;
    this.oz = chunk.cz * CHUNK_SIZE;
  }

  inside(x: number, z: number): boolean {
    return x >= this.ox && x < this.ox + CHUNK_SIZE && z >= this.oz && z < this.oz + CHUNK_SIZE;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (y < 1 || y >= WORLD_HEIGHT || !this.inside(x, z)) return;
    this.chunk.set(x - this.ox, y, z - this.oz, id);
  }

  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT || !this.inside(x, z)) return Block.Air;
    return this.chunk.get(x - this.ox, y, z - this.oz);
  }
}

/**
 * Bring a column to `floor`: fill below with dirt, clear above so nothing
 * generated (a tree, a hillside) pokes through the building. `top` is what
 * sits at floor-1, the surface you stand on.
 */
function levelColumn(w: ChunkWriter, heightAt: HeightFn, x: number, z: number, floor: number, top: number, clearTo: number): void {
  if (!w.inside(x, z)) return;
  const ground = heightAt(x, z);
  for (let y = Math.max(1, ground - 1); y < floor - 1; y++) {
    if (w.get(x, y, z) === Block.Air || w.get(x, y, z) === Block.Water) w.set(x, y, z, Block.Dirt);
  }
  // Solid footing under the surface block even when the terrain was lower.
  w.set(x, floor - 2, z, w.get(x, floor - 2, z) === Block.Air ? Block.Dirt : w.get(x, floor - 2, z));
  w.set(x, floor - 1, z, top);
  for (let y = floor; y <= clearTo; y++) w.set(x, y, z, Block.Air);
}

function placePaths(w: ChunkWriter, village: Village, heightAt: HeightFn): void {
  for (const path of village.paths) {
    for (let z = Math.max(path.z0, w.oz); z <= Math.min(path.z1, w.oz + CHUNK_SIZE - 1); z++) {
      for (let x = Math.max(path.x0, w.ox); x <= Math.min(path.x1, w.ox + CHUNK_SIZE - 1); x++) {
        const ground = heightAt(x, z);
        if (ground <= SEA_LEVEL + 1) continue;
        const surface = w.get(x, ground - 1, z);
        if (surface !== Block.Grass && surface !== Block.Dirt && surface !== Block.Sand) continue;
        w.set(x, ground - 1, z, Block.DirtPath);
        for (let y = ground; y <= ground + 2; y++) w.set(x, y, z, Block.Air);
      }
    }
  }
}

function placeWell(w: ChunkWriter, village: Village, heightAt: HeightFn): void {
  const { x: cx, z: cz, floor } = village;
  for (let z = cz - 1; z <= cz + 1; z++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (!w.inside(x, z)) continue;
      levelColumn(w, heightAt, x, z, floor, Block.Cobblestone, floor + 3);
      const rim = x !== cx || z !== cz;
      if (rim) {
        w.set(x, floor, z, Block.Cobblestone);
      } else {
        w.set(x, floor - 1, z, Block.Water);
        w.set(x, floor - 2, z, Block.Water);
        w.set(x, floor - 3, z, Block.Cobblestone);
      }
    }
  }
}

const WALL_HEIGHT = 4;

function placeHouse(w: ChunkWriter, house: House, heightAt: HeightFn): void {
  const { x0, z0, x1, z1, floor, door, facing, variant } = house;
  const roofY = floor + WALL_HEIGHT;

  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (!w.inside(x, z)) continue;
      levelColumn(w, heightAt, x, z, floor, Block.Cobblestone, roofY + 2);
      const onEdgeX = x === x0 || x === x1;
      const onEdgeZ = z === z0 || z === z1;
      if (onEdgeX || onEdgeZ) {
        const corner = onEdgeX && onEdgeZ;
        for (let y = floor; y < roofY; y++) w.set(x, y, z, corner ? Block.Log : Block.Planks);
        // A window in the middle of each wall, except where the door is.
        const midX = x === Math.floor((x0 + x1) / 2);
        const midZ = z === Math.floor((z0 + z1) / 2);
        if (!corner && ((onEdgeZ && midX) || (onEdgeX && midZ))) w.set(x, floor + 1, z, Block.Glass);
      }
      // Flat roof, with a second course set in one block for a little shape.
      w.set(x, roofY, z, Block.Planks);
      if (x > x0 && x < x1 && z > z0 && z < z1) w.set(x, roofY + 1, z, Block.Planks);
    }
  }

  // Doorway: two blocks of air in the wall, and a step outside.
  w.set(door.x, floor, door.z, Block.Air);
  w.set(door.x, floor + 1, door.z, Block.Air);
  const [nx, nz] = DIRS[facing];
  const stepX = door.x + nx;
  const stepZ = door.z + nz;
  if (w.inside(stepX, stepZ)) {
    levelColumn(w, heightAt, stepX, stepZ, floor, Block.DirtPath, floor + 2);
  }

  // Furniture along the back wall: a bed and a chest; a workstation by the door.
  const inner = { x0: x0 + 1, z0: z0 + 1, x1: x1 - 1, z1: z1 - 1 };
  const back = {
    x: nx === 0 ? null : nx > 0 ? inner.x0 : inner.x1,
    z: nz === 0 ? null : nz > 0 ? inner.z0 : inner.z1,
  };
  const front = {
    x: nx === 0 ? null : nx > 0 ? inner.x1 : inner.x0,
    z: nz === 0 ? null : nz > 0 ? inner.z1 : inner.z0,
  };
  const bed = { x: back.x ?? inner.x0, z: back.z ?? inner.z0 };
  const chest = { x: back.x ?? inner.x1, z: back.z ?? inner.z1 };
  const station = { x: front.x ?? inner.x0, z: front.z ?? inner.z1 };
  // Keep the station out of the doorway's line.
  if (station.x === door.x && station.z === door.z) station.x = inner.x1;
  w.set(bed.x, floor, bed.z, Block.Bed);
  w.set(chest.x, floor, chest.z, Block.Chest);
  w.set(station.x, floor, station.z, variant === 0 ? Block.CraftingTable : Block.Furnace);
}

function placeFarm(
  w: ChunkWriter,
  farm: Farm,
  seed: number,
  heightAt: HeightFn,
  crops: { x: number; y: number; z: number }[],
): void {
  const { x0, z0, x1, z1, floor } = farm;
  const channelX = Math.floor((x0 + x1) / 2);
  const stage0 = farm.crop === 'wheat' ? Block.Wheat0 : Block.Carrots0;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (!w.inside(x, z)) continue;
      const border = x === x0 || x === x1 || z === z0 || z === z1;
      const ground = border ? Block.Log : x === channelX ? Block.Water : Block.Farmland;
      levelColumn(w, heightAt, x, z, floor, ground, floor + 3);
      if (border || x === channelX) continue;
      const stage = Math.floor(coordRandom(x, z, seed ^ CROP_SALT) * 4);
      w.set(x, floor, z, stage0 + stage);
      crops.push({ x, y: floor, z });
    }
  }
}

/** Every block of the village that falls inside this chunk. Returns crop positions placed. */
export function placeVillage(
  chunk: Chunk,
  village: Village,
  seed: number,
  heightAt: HeightFn,
  crops: { x: number; y: number; z: number }[],
): void {
  const w = new ChunkWriter(chunk);
  placePaths(w, village, heightAt);
  for (const farm of village.farms) {
    if (overlaps(farm, chunkRect(chunk), 0)) placeFarm(w, farm, seed, heightAt, crops);
  }
  for (const house of village.houses) {
    if (overlaps(house, chunkRect(chunk), 1)) placeHouse(w, house, heightAt);
  }
  if (overlaps({ x0: village.x - 1, z0: village.z - 1, x1: village.x + 1, z1: village.z + 1 }, chunkRect(chunk), 0)) {
    placeWell(w, village, heightAt);
  }
}

export function chunkRect(chunk: Chunk): Rect {
  return {
    x0: chunk.cx * CHUNK_SIZE,
    z0: chunk.cz * CHUNK_SIZE,
    x1: chunk.cx * CHUNK_SIZE + CHUNK_SIZE - 1,
    z1: chunk.cz * CHUNK_SIZE + CHUNK_SIZE - 1,
  };
}

/** Village cell containing a world column. */
export function villageCell(x: number, z: number): [number, number] {
  return [Math.floor(x / VILLAGE_CELL), Math.floor(z / VILLAGE_CELL)];
}
