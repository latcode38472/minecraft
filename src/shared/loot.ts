// Loot tables: what falls out of a mob, a block, or a village chest.
//
// A table is a list of entries, each rolled independently: with `chance` it
// yields between `min` and `max` of the item. Rolling takes the random source
// as an argument so tests can be deterministic and village chests can be
// seeded from their position — the same chest always holds the same things,
// whichever player opens it first.

export interface LootEntry {
  id: string;
  min: number;
  max: number;
  /** 0..1 probability this entry drops at all. */
  chance: number;
}

export type LootTable = LootEntry[];

export interface LootRoll {
  id: string;
  count: number;
}

export type RandomSource = () => number;

/** One entry: `{ id, min, max, chance }` written compactly. */
export const drop = (id: string, min: number, max = min, chance = 1): LootEntry => ({
  id,
  min,
  max,
  chance,
});

export function rollLoot(table: LootTable, rand: RandomSource = Math.random): LootRoll[] {
  const out: LootRoll[] = [];
  for (const entry of table) {
    if (entry.chance < 1 && rand() >= entry.chance) continue;
    const count = entry.min + Math.floor(rand() * (entry.max - entry.min + 1));
    if (count > 0) out.push({ id: entry.id, count });
  }
  return out;
}

// --- Mob drops ------------------------------------------------------------

export const MOB_LOOT: Record<string, LootTable> = {
  // Killing an archer arms you as one: this is the main arrow supply.
  skeleton: [drop('bone', 1, 2), drop('arrow', 1, 2, 0.75)],
  // String from zombies keeps bows reachable without a spider mob.
  zombie: [drop('rotten_flesh', 1, 1, 0.6), drop('string', 1, 1, 0.5)],
  pig: [drop('raw_porkchop', 1, 2), drop('leather', 1, 2, 0.7)],
  cow: [drop('raw_beef', 1, 3), drop('leather', 1, 2)],
  sheep: [drop('raw_mutton', 1, 2)],
  villager: [],
};

/** Extra wool on top of the mutton when a sheep dies with its fleece on. */
export const SHEEP_WOOL_LOOT: LootTable = [drop('wool', 1)];
/** What shearing a fleeced sheep yields. */
export const SHEAR_LOOT: LootTable = [drop('wool', 1, 3)];

// --- Village chests -------------------------------------------------------

/**
 * A village chest is stocked from this table when the village generates. It
 * is a starter kit rather than a treasure hoard: food, seeds, a few materials.
 */
export const VILLAGE_CHEST_LOOT: LootTable = [
  drop('bread', 1, 3, 0.8),
  drop('wheat', 2, 6, 0.7),
  drop('wheat_seeds', 2, 5, 0.6),
  drop('carrot', 1, 4, 0.5),
  drop('apple', 1, 2, 0.4),
  drop('stick', 2, 6, 0.5),
  drop('planks', 4, 10, 0.5),
  drop('coal', 1, 4, 0.45),
  drop('iron_ingot', 1, 2, 0.25),
  drop('string', 1, 3, 0.3),
  drop('leather', 1, 2, 0.3),
  drop('wool', 1, 3, 0.35),
  drop('stone_hoe', 1, 1, 0.2),
  drop('wooden_pickaxe', 1, 1, 0.15),
  drop('diamond', 1, 1, 0.04),
];

/**
 * A small deterministic generator so seeded loot is repeatable. Mulberry32:
 * good enough for loot, tiny enough to live here.
 */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a world seed and a block position into one 32-bit seed. */
export function positionSeed(seed: number, x: number, y: number, z: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ (z | 0), 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
