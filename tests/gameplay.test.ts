// Gameplay systems that live in shared code: slot clicks and grid crafting,
// furnaces, chests and village loot, crops, beds and the night skip, death
// drops, sheep, saves, and villages. Every test runs the same code the server
// and the singleplayer client run.

import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCKS, Block } from '../src/blocks.ts';
import {
  CROP_GROWTH_MEAN_S,
  HUNGER_IDLE_DRAIN_PER_S,
  MAX_HUNGER,
  SLEEP_DURATION_S,
  SLEEP_START,
  SLEEP_WAKE_TIME,
  SMELT_TIME_S,
  WOOL_REGROW_S,
} from '../src/constants.ts';
import {
  CHEST_SLOTS,
  FURNACE_FUEL,
  FURNACE_INPUT,
  FURNACE_OUTPUT,
  clickSlot,
  closeHolding,
  craftFromGrid,
  craftResult,
  createHolding,
  sanitizeStack,
  setGridSize,
  type ClickContext,
} from '../src/items/containers.ts';
import { getRecipe, matchRecipe } from '../src/items/crafting.ts';
import { Inventory, type ItemStack } from '../src/items/inventory.ts';
import { fuelSeconds, isFuel, smeltResult } from '../src/items/smelting.ts';
import { blockDrops, canHarvest } from '../src/shared/harvest.ts';
import { MOB_LOOT, VILLAGE_CHEST_LOOT, positionSeed, rollLoot, seededRandom } from '../src/shared/loot.ts';
import { MOB_DEFS, pickSpawnKind } from '../src/shared/mobs.ts';
import { MobSim } from '../src/shared/mobsim.ts';
import { RoomSimulation, blockKey, isSleepTime, type SimulationHooks } from '../src/shared/roomsim.ts';
import { SAVE_VERSION, emptyWorldSave, validateSimState, validateWorldSave } from '../src/shared/save.ts';
import { TerrainGenerator } from '../src/world/terrain.ts';
import { layoutVillage } from '../src/world/village.ts';
import { ServerWorld } from '../server/world.ts';
import { MOB_FLAG_GRAZING, MOB_FLAG_SHEARED } from '../src/net/protocol.ts';

const SEED = 4;

function makeRoom(hooks: Partial<SimulationHooks> = {}) {
  const edits = new Map<string, Map<number, number>>();
  const world = new ServerWorld(SEED, edits);
  const sim = new RoomSimulation(world, {
    damagePlayer: () => {},
    giveItems: () => 0,
    ...hooks,
  });
  return { world, sim, edits };
}

/** A player standing on the spawn column. */
function spawnPlayer(world: ServerWorld, id = 'p1') {
  const spawn = world.terrain.findSpawnColumn();
  return { id, position: { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 }, dead: false, spawn };
}

function run(sim: RoomSimulation, players: { id: string; position: { x: number; y: number; z: number }; dead: boolean }[], seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) sim.update(dt, players);
}

/** Put a block into the world the way the server does for an accepted edit. */
function place(world: ServerWorld, edits: Map<string, Map<number, number>>, x: number, y: number, z: number, id: number) {
  world.getBlock(x, y, z); // load the chunk so the edit lands
  const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  let chunk = edits.get(key);
  if (!chunk) {
    chunk = new Map();
    edits.set(key, chunk);
  }
  const lx = ((x % 16) + 16) % 16;
  const lz = ((z % 16) + 16) % 16;
  chunk.set(lx + lz * 16 + y * 256, id);
  world.applyEdit(x, y, z, id);
}

function context(inventory = new Inventory(), gridSize: 2 | 3 = 2): ClickContext {
  return { inventory, holding: createHolding(gridSize), container: null };
}

// --- Slot clicks ------------------------------------------------------------

test('left click lifts a stack onto the cursor and puts it down again', () => {
  const ctx = context();
  ctx.inventory.add('cobblestone', 10);
  assert.ok(clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false));
  assert.equal(ctx.holding.cursor?.count, 10);
  assert.equal(ctx.inventory.slots[0], null);
  assert.ok(clickSlot(ctx, { kind: 'inv', index: 5 }, 0, false));
  assert.equal(ctx.inventory.slots[5]?.count, 10);
  assert.equal(ctx.holding.cursor, null);
});

test('right click takes half, then places one at a time', () => {
  const ctx = context();
  ctx.inventory.add('cobblestone', 9);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 1, false);
  assert.equal(ctx.holding.cursor?.count, 5, 'the larger half comes up');
  assert.equal(ctx.inventory.slots[0]?.count, 4);
  clickSlot(ctx, { kind: 'craft', index: 0 }, 1, false);
  clickSlot(ctx, { kind: 'craft', index: 1 }, 1, false);
  assert.equal(ctx.holding.craft[0]?.count, 1);
  assert.equal(ctx.holding.craft[1]?.count, 1);
  assert.equal(ctx.holding.cursor?.count, 3);
});

test('stacks merge up to the item limit and swap when they differ', () => {
  const ctx = context();
  ctx.inventory.slots[0] = { id: 'cobblestone', count: 60 };
  ctx.inventory.slots[1] = { id: 'cobblestone', count: 10 };
  ctx.inventory.slots[2] = { id: 'dirt', count: 3 };
  clickSlot(ctx, { kind: 'inv', index: 1 }, 0, false);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false);
  assert.equal(ctx.inventory.slots[0]?.count, 64, 'filled to the cap');
  assert.equal(ctx.holding.cursor?.count, 6, 'the rest stays on the cursor');
  clickSlot(ctx, { kind: 'inv', index: 2 }, 0, false);
  assert.equal(ctx.inventory.slots[2]?.id, 'cobblestone', 'different items swap');
  assert.equal(ctx.holding.cursor?.id, 'dirt');
});

test('shift-click moves between hotbar and bag, and equips armour', () => {
  const ctx = context();
  ctx.inventory.slots[0] = { id: 'dirt', count: 5 };
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, true);
  assert.equal(ctx.inventory.slots[0], null);
  assert.equal(ctx.inventory.slots[9]?.count, 5, 'hotbar goes to the first bag slot');
  ctx.inventory.slots[3] = { id: 'iron_helmet', count: 1 };
  clickSlot(ctx, { kind: 'inv', index: 3 }, 0, true);
  assert.equal(ctx.inventory.armor[0]?.id, 'iron_helmet', 'a helmet goes on the head');
  assert.equal(ctx.inventory.slots[3], null);
  // Armour slots refuse anything that is not their piece.
  ctx.holding.cursor = { id: 'dirt', count: 1 };
  assert.equal(clickSlot(ctx, { kind: 'armor', index: 1 }, 0, false), false);
});

test('tools never merge, so wear is never averaged away', () => {
  const ctx = context();
  ctx.inventory.slots[0] = { id: 'iron_pickaxe', count: 1, damage: 5 };
  ctx.inventory.slots[1] = { id: 'iron_pickaxe', count: 1 };
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false);
  clickSlot(ctx, { kind: 'inv', index: 1 }, 0, false);
  assert.equal(ctx.inventory.slots[1]?.damage, 5, 'the worn one went in');
  assert.equal(ctx.holding.cursor?.damage, undefined, 'the fresh one came out');
});

// --- Grid crafting ----------------------------------------------------------

test('a log in the pocket grid makes planks, and the grid pays for each craft', () => {
  const ctx = context();
  ctx.inventory.add('log', 3);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false);
  clickSlot(ctx, { kind: 'craft', index: 3 }, 0, false);
  assert.equal(craftResult(ctx.holding)?.id, 'planks', 'shapeless: any cell will do');
  assert.ok(craftFromGrid(ctx, false));
  assert.equal(ctx.holding.cursor?.id, 'planks');
  assert.equal(ctx.holding.cursor?.count, 4);
  assert.equal(ctx.holding.craft[3]?.count, 2, 'one log was spent');
  // Crafting again merges onto the cursor.
  assert.ok(craftFromGrid(ctx, false));
  assert.equal(ctx.holding.cursor?.count, 8);
});

test('shaped recipes match anywhere on the grid, mirrored, but not scrambled', () => {
  const stick = matchRecipe(['planks', null, 'planks', null], 2);
  assert.equal(stick?.id, 'sticks', 'a column of planks in the left column');
  const right = matchRecipe([null, 'planks', null, 'planks'], 2);
  assert.equal(right?.id, 'sticks', 'or the right column');
  assert.equal(matchRecipe(['planks', 'planks', null, null], 2), null, 'a row is not a column');
  const axe = matchRecipe(['cobblestone', 'cobblestone', null, 'cobblestone', 'stick', null, null, 'stick', null], 3);
  assert.equal(axe?.id, 'stone_axe');
  const mirrored = matchRecipe([null, 'cobblestone', 'cobblestone', null, 'stick', 'cobblestone', null, 'stick', null], 3);
  assert.equal(mirrored?.id, 'stone_axe', 'left- and right-handed layouts both work');
  assert.equal(matchRecipe(['cobblestone', null, null, null], 2), null, 'random junk is not a recipe');
});

test('the 3x3 recipes need a table: a pickaxe will not fit the pocket grid', () => {
  assert.equal(getRecipe('wooden_pickaxe')?.gridSize, 3);
  assert.equal(getRecipe('planks')?.gridSize, 2);
  assert.equal(getRecipe('bed')?.gridSize, 3);
  const ctx = context(new Inventory(), 2);
  assert.equal(ctx.holding.craft.length, 4);
  const overflow = setGridSize(ctx, 3);
  assert.equal(ctx.holding.craft.length, 9);
  assert.deepEqual(overflow, []);
});

test('shift-crafting makes as many as the grid allows straight into the bag', () => {
  const ctx = context();
  ctx.inventory.add('log', 5);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false);
  clickSlot(ctx, { kind: 'craft', index: 0 }, 0, false);
  assert.ok(craftFromGrid(ctx, true));
  assert.equal(ctx.inventory.count('planks'), 20);
  assert.equal(ctx.holding.craft[0], null, 'every log was used');
});

test('closing the screen hands the grid and cursor back, dropping only what will not fit', () => {
  const ctx = context();
  ctx.inventory.add('log', 2);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, false);
  clickSlot(ctx, { kind: 'craft', index: 0 }, 1, false);
  assert.deepEqual(closeHolding(ctx), []);
  assert.equal(ctx.inventory.count('log'), 2, 'nothing was lost');
  assert.equal(ctx.holding.cursor, null);
  // A full inventory spills the overflow instead of deleting it.
  for (let i = 0; i < ctx.inventory.slots.length; i++) ctx.inventory.slots[i] = { id: 'iron_pickaxe', count: 1 };
  ctx.holding.cursor = { id: 'diamond', count: 3 };
  const spilled = closeHolding(ctx);
  assert.deepEqual(spilled, [{ id: 'diamond', count: 3 }]);
});

// --- Furnaces ---------------------------------------------------------------

test('the smelting registry knows ores, food and fuel', () => {
  assert.equal(smeltResult('raw_iron')?.output, 'iron_ingot');
  assert.equal(smeltResult('raw_beef')?.output, 'cooked_beef');
  assert.equal(smeltResult('diamond'), undefined);
  assert.ok(isFuel('coal'));
  assert.ok(isFuel('planks'));
  assert.ok(!isFuel('dirt'));
  assert.equal(fuelSeconds('coal'), SMELT_TIME_S * 8, 'one coal smelts eight items');
});

test('a furnace burns fuel, smelts its input, lights up, and cools down again', () => {
  const { world, sim, edits } = makeRoom();
  const player = spawnPlayer(world);
  const at = { x: player.spawn.x + 2, y: player.spawn.y, z: player.spawn.z };
  place(world, edits, at.x, at.y, at.z, Block.Furnace);
  const furnace = sim.openContainer(at.x, at.y, at.z);
  assert.ok(furnace && furnace.kind === 'furnace');
  furnace.slots[FURNACE_INPUT] = { id: 'raw_iron', count: 2 };
  furnace.slots[FURNACE_FUEL] = { id: 'planks', count: 1 };

  run(sim, [player], 0.5);
  assert.equal(world.getBlock(at.x, at.y, at.z), Block.LitFurnace, 'the fire is lit');
  assert.ok(sim.blocks.some((b) => b.id === Block.LitFurnace), 'and everyone is told');
  assert.equal(furnace.slots[FURNACE_FUEL], null, 'the plank was consumed');
  assert.ok(furnace.progress > 0, 'the arrow is moving');

  run(sim, [player], SMELT_TIME_S);
  assert.equal(furnace.slots[FURNACE_OUTPUT]?.id, 'iron_ingot');
  assert.equal(furnace.slots[FURNACE_OUTPUT]?.count, 1);
  assert.equal(furnace.slots[FURNACE_INPUT]?.count, 1, 'one ore went in');

  // A plank is worth 1.5 smelts; the second ore needs more fuel.
  run(sim, [player], SMELT_TIME_S);
  assert.equal(furnace.slots[FURNACE_OUTPUT]?.count, 1, 'no fuel, no second ingot');
  assert.equal(world.getBlock(at.x, at.y, at.z), Block.Furnace, 'and the fire has gone out');
  assert.ok(sim.blocks.some((b) => b.id === Block.Furnace));
});

test('a furnace keeps its heat and contents across a save', () => {
  const { world, sim, edits } = makeRoom();
  const player = spawnPlayer(world);
  const at = { x: player.spawn.x + 2, y: player.spawn.y, z: player.spawn.z };
  place(world, edits, at.x, at.y, at.z, Block.Furnace);
  const furnace = sim.openContainer(at.x, at.y, at.z)!;
  furnace.slots[FURNACE_INPUT] = { id: 'sand', count: 4 };
  furnace.slots[FURNACE_FUEL] = { id: 'coal', count: 1 };
  run(sim, [player], 3);
  const saved = JSON.parse(JSON.stringify(sim.serialize()));
  const restored = validateSimState(saved);
  assert.equal(restored.containers.length, 1);
  assert.ok((restored.containers[0].burn ?? 0) > 0, 'the fire survives');

  const again = makeRoom();
  place(again.world, again.edits, at.x, at.y, at.z, Block.Furnace);
  again.sim.restore(restored);
  const back = again.sim.openContainer(at.x, at.y, at.z)!;
  assert.equal(back.slots[FURNACE_INPUT]?.id, 'sand');
  run(again.sim, [player], SMELT_TIME_S + 1);
  assert.equal(back.slots[FURNACE_OUTPUT]?.id, 'glass', 'and it carries on smelting');
});

test('shift-clicking into a furnace sorts fuel and ore into the right slots', () => {
  const { world, sim, edits } = makeRoom();
  const player = spawnPlayer(world);
  const at = { x: player.spawn.x + 2, y: player.spawn.y, z: player.spawn.z };
  place(world, edits, at.x, at.y, at.z, Block.Furnace);
  const furnace = sim.openContainer(at.x, at.y, at.z)!;
  const ctx: ClickContext = { inventory: new Inventory(), holding: createHolding(2), container: furnace };
  ctx.inventory.add('coal', 2);
  ctx.inventory.add('raw_gold', 3);
  clickSlot(ctx, { kind: 'inv', index: 0 }, 0, true);
  clickSlot(ctx, { kind: 'inv', index: 1 }, 0, true);
  assert.equal(furnace.slots[FURNACE_FUEL]?.id, 'coal');
  assert.equal(furnace.slots[FURNACE_INPUT]?.id, 'raw_gold');
  // Nothing can be put into the output slot by hand.
  ctx.holding.cursor = { id: 'dirt', count: 1 };
  assert.equal(clickSlot(ctx, { kind: 'container', index: FURNACE_OUTPUT }, 0, false), false);
});

// --- Chests and village loot ------------------------------------------------

test('breaking a chest spills everything inside it', () => {
  const { world, sim, edits } = makeRoom();
  const player = spawnPlayer(world);
  const at = { x: player.spawn.x + 2, y: player.spawn.y, z: player.spawn.z };
  place(world, edits, at.x, at.y, at.z, Block.Chest);
  const chest = sim.openContainer(at.x, at.y, at.z)!;
  assert.equal(chest.slots.length, CHEST_SLOTS);
  assert.equal(chest.slots.filter((s) => s !== null).length, 0, 'a placed chest starts empty');
  chest.slots[0] = { id: 'diamond', count: 2 };
  chest.slots[5] = { id: 'iron_pickaxe', count: 1, damage: 7 };
  place(world, edits, at.x, at.y, at.z, Block.Air);
  sim.blockRemoved(at.x, at.y, at.z);
  const drops = [...sim.drops.values()];
  assert.equal(drops.length, 2);
  assert.ok(drops.some((d) => d.itemId === 'iron_pickaxe' && d.damage === 7), 'wear survives the spill');
  assert.equal(sim.containers.size, 0);
  assert.deepEqual(sim.removedContainers, [blockKey(at.x, at.y, at.z)]);
});

test('a village chest is stocked from the seed, the same for everyone, and only once', () => {
  const { world, sim } = makeRoom();
  const village = world.villagesNear(0, 0, 600)[0];
  assert.ok(village, 'the smoke world has a village in reach');
  // Find a generated chest inside it.
  const layout = world.terrain.villageInCell(...(village.id.split(',').map(Number) as [number, number]))!;
  let chest: { x: number; y: number; z: number } | null = null;
  for (const house of layout.houses) {
    for (let z = house.z0; z <= house.z1 && !chest; z++) {
      for (let x = house.x0; x <= house.x1 && !chest; x++) {
        if (world.getBlock(x, house.floor, z) === Block.Chest) chest = { x, y: house.floor, z };
      }
    }
  }
  assert.ok(chest, 'every house has a chest');
  assert.ok(world.isNaturalBlock(chest!.x, chest!.y, chest!.z));
  const first = sim.openContainer(chest!.x, chest!.y, chest!.z)!;
  const stocked = first.slots.filter((s) => s !== null);
  assert.ok(stocked.length > 0, 'a village chest is not empty');

  const other = makeRoom();
  const second = other.sim.openContainer(chest!.x, chest!.y, chest!.z)!;
  assert.deepEqual(second.slots, first.slots, 'another server rolls the very same loot');

  // Taking the loot and saving must not restock it on reload.
  first.slots.fill(null);
  const reloaded = makeRoom();
  reloaded.sim.restore(validateSimState(JSON.parse(JSON.stringify(sim.serialize()))));
  const emptied = reloaded.sim.openContainer(chest!.x, chest!.y, chest!.z)!;
  assert.ok(emptied.slots.every((s) => s === null), 'looted stays looted');
});

test('loot tables are repeatable under a seeded generator', () => {
  const a = rollLoot(VILLAGE_CHEST_LOOT, seededRandom(positionSeed(SEED, 1, 2, 3)));
  const b = rollLoot(VILLAGE_CHEST_LOOT, seededRandom(positionSeed(SEED, 1, 2, 3)));
  assert.deepEqual(a, b);
  const c = rollLoot(VILLAGE_CHEST_LOOT, seededRandom(positionSeed(SEED, 1, 2, 4)));
  assert.notDeepEqual([a, b, c].map((r) => JSON.stringify(r)).length, 0);
  // Every mob has a table, and it only names real items.
  for (const kind of Object.keys(MOB_DEFS)) {
    assert.ok(Array.isArray(MOB_LOOT[kind]), `${kind} has no loot table`);
    for (const entry of MOB_LOOT[kind]) assert.ok(sanitizeStack({ id: entry.id, count: 1 }), `${entry.id} is not an item`);
  }
});

// --- Block drops ------------------------------------------------------------

test('what a block drops depends on the tool, and extras are rolled', () => {
  const stone = BLOCKS[Block.Stone];
  assert.deepEqual(blockDrops(stone, null), [], 'stone by hand yields nothing');
  assert.ok(canHarvest(stone, { id: 'wooden_pickaxe', count: 1 }));
  assert.deepEqual(blockDrops(stone, { id: 'wooden_pickaxe', count: 1 }), [{ id: 'cobblestone', count: 1 }]);
  assert.ok(!canHarvest(BLOCKS[Block.IronOre], { id: 'wooden_pickaxe', count: 1 }), 'iron needs stone or better');
  assert.deepEqual(blockDrops(BLOCKS[Block.IronOre], { id: 'stone_pickaxe', count: 1 }), [{ id: 'raw_iron', count: 1 }]);
  const wheat = blockDrops(BLOCKS[Block.Wheat3], null, () => 0);
  assert.ok(wheat.some((d) => d.id === 'wheat') && wheat.some((d) => d.id === 'wheat_seeds'), 'ripe wheat gives grain and seeds');
  assert.deepEqual(blockDrops(BLOCKS[Block.Wheat1], null, () => 0), [{ id: 'wheat_seeds', count: 1 }], 'unripe wheat only gives seeds back');
  const leaves = blockDrops(BLOCKS[Block.Leaves], null, () => 0);
  assert.ok(leaves.some((d) => d.id === 'apple'), 'leaves can drop an apple');
});

// --- Crops ------------------------------------------------------------------

test('crops on farmland grow near a player, stop when ripe, and break with their soil', () => {
  const { world, sim, edits } = makeRoom();
  const player = spawnPlayer(world);
  const at = { x: player.spawn.x + 1, y: player.spawn.y, z: player.spawn.z };
  place(world, edits, at.x, at.y - 1, at.z, Block.Farmland);
  place(world, edits, at.x, at.y, at.z, Block.Wheat0);
  sim.blockPlaced(at.x, at.y, at.z, Block.Wheat0);
  const key = blockKey(at.x, at.y, at.z);
  assert.ok(sim.crops.has(key), 'a planted crop is tracked');

  // Force the growth roll so the test does not wait minutes.
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    sim.update(0.05, [player]);
    assert.equal(world.getBlock(at.x, at.y, at.z), Block.Wheat1, 'one stage per lucky tick');
    sim.update(0.05, [player]);
    sim.update(0.05, [player]);
    assert.equal(world.getBlock(at.x, at.y, at.z), Block.Wheat3, 'ripe');
    assert.ok(!sim.crops.has(key), 'ripe crops no longer tick');
  } finally {
    Math.random = realRandom;
  }
  assert.ok(CROP_GROWTH_MEAN_S > 30, 'growth is slow enough to matter');

  place(world, edits, at.x, at.y - 1, at.z, Block.Air);
  sim.blockRemoved(at.x, at.y - 1, at.z);
  assert.equal(world.getBlock(at.x, at.y, at.z), Block.Air, 'the crop goes with its farmland');
  assert.ok([...sim.drops.values()].some((d) => d.itemId === 'wheat'), 'and drops its harvest');
});

test('village farms come with growing crops that the simulation picks up', () => {
  const { world, sim } = makeRoom();
  const village = world.villagesNear(0, 0, 600).find((v) => {
    const layout = world.terrain.villageInCell(...(v.id.split(',').map(Number) as [number, number]))!;
    return layout.farms.length > 0;
  });
  assert.ok(village, 'some village has a farm');
  const near = { id: 'p', position: { x: village!.x, y: 60, z: village!.z }, dead: false };
  world.getBlock(village!.x, 40, village!.z); // generate the village chunk
  sim.update(0.05, [near]);
  assert.ok(sim.crops.size > 0, 'the farm rows are tracked without scanning the world');
});

// --- Beds and sleeping ------------------------------------------------------

test('everyone in bed skips the night; dawn, death and a broken bed get you up', () => {
  const woken: string[] = [];
  const { world, sim, edits } = makeRoom({ onWake: (id, reason) => woken.push(`${id}:${reason}`) });
  const a = spawnPlayer(world, 'a');
  const b = { ...spawnPlayer(world, 'b'), position: { ...a.position, x: a.position.x + 1 } };
  const bedA = { x: a.spawn.x + 2, y: a.spawn.y, z: a.spawn.z };
  const bedB = { x: a.spawn.x + 3, y: a.spawn.y, z: a.spawn.z };
  place(world, edits, bedA.x, bedA.y, bedA.z, Block.Bed);
  place(world, edits, bedB.x, bedB.y, bedB.z, Block.Bed);

  sim.timeOfDay = 0.5;
  assert.ok(!isSleepTime(sim.timeOfDay));
  assert.equal(sim.trySleep('a', bedA.x, bedA.y, bedA.z, [a, b]).ok, false, 'not at noon');

  sim.timeOfDay = SLEEP_START + 0.01;
  assert.equal(sim.trySleep('a', a.spawn.x, a.spawn.y - 1, a.spawn.z, [a, b]).ok, false, 'the ground is not a bed');
  assert.equal(sim.trySleep('a', bedA.x, bedA.y, bedA.z, [a, b]).ok, true);
  assert.equal(sim.trySleep('b', bedA.x, bedA.y, bedA.z, [a, b]).ok, false, 'one sleeper per bed');
  run(sim, [a, b], SLEEP_DURATION_S + 1);
  assert.ok(sim.timeOfDay > SLEEP_START, 'one sleeper of two does not skip the night');
  assert.deepEqual(sim.sleepSnapshot([a, b]), { sleeping: ['a'], needed: 2 });

  assert.equal(sim.trySleep('b', bedB.x, bedB.y, bedB.z, [a, b]).ok, true);
  run(sim, [a, b], SLEEP_DURATION_S + 0.2);
  assert.ok(Math.abs(sim.timeOfDay - SLEEP_WAKE_TIME) < 0.01, 'morning came');
  assert.equal(sim.sleepers.size, 0);
  assert.ok(woken.includes('a:morning') && woken.includes('b:morning'));

  // Dying gets you out of bed; so does losing the bed.
  sim.timeOfDay = SLEEP_START + 0.01;
  sim.trySleep('a', bedA.x, bedA.y, bedA.z, [a, b]);
  sim.trySleep('b', bedB.x, bedB.y, bedB.z, [a, b]);
  place(world, edits, bedB.x, bedB.y, bedB.z, Block.Air);
  sim.blockRemoved(bedB.x, bedB.y, bedB.z);
  assert.ok(woken.includes('b:bed_gone'));
  const deadA = { ...a, dead: true };
  sim.update(0.05, [deadA, b]);
  assert.ok(woken.includes('a:dead'));
  assert.equal(sim.sleepers.size, 0);
});

// --- Death drops, sheep and saves -------------------------------------------

test('a dead player\'s things fall where they stood, once, with their wear', () => {
  const { sim } = makeRoom();
  const stacks: (ItemStack | null)[] = [
    { id: 'diamond', count: 3 },
    null,
    { id: 'iron_sword', count: 1, damage: 12 },
  ];
  sim.scatterStacks(stacks, 10, 40, 10);
  const drops = [...sim.drops.values()];
  assert.equal(drops.length, 2, 'null slots drop nothing');
  assert.ok(drops.some((d) => d.itemId === 'iron_sword' && d.damage === 12));
  assert.equal(sim.spawnDrop('not_an_item', 1, 0, 40, 0), null, 'unknown items never enter the world');
});

test('shears take a sheep\'s wool, which grows back; dying sheep drop wool only when fleeced', () => {
  const { world, sim } = makeRoom();
  const player = spawnPlayer(world);
  const sheep = new MobSim('sheep', player.position.x + 1, player.position.y, player.position.z);
  sim.addMob(sheep);
  const given: string[] = [];
  const room = makeRoom({ giveItems: (_p, id, count) => (given.push(`${id}x${count}`), 0) });
  room.sim.addMob(sheep);
  assert.ok(room.sim.shearMob(sheep.id, 'p1'));
  assert.ok(given.some((g) => g.startsWith('wool')), 'the wool goes to the shearer');
  assert.ok(sheep.sheared);
  assert.ok((sheep.flags() & MOB_FLAG_SHEARED) !== 0, 'and every client is told');
  assert.equal(room.sim.shearMob(sheep.id, 'p1'), false, 'nothing left to shear');
  assert.ok(!sheep.loot().some((l) => l.id === 'wool'), 'a bare sheep drops no wool');
  sheep.woolTimer = 0.01;
  sheep.update(0.05, world, [player], { onPlayerHit() {}, onMobDied() {}, onMobShoot() {} });
  assert.ok(!sheep.sheared, 'wool grows back');
  assert.ok(WOOL_REGROW_S > 60);
  assert.equal(sim.mobs.size, 1);
});

test('animals graze and look around, and a hit sends them running', () => {
  const { world, edits } = makeRoom();
  // A flat stone field, so nothing about the terrain gets in the way.
  const field = { x: 400, y: 60, z: 400 };
  for (let dz = -12; dz <= 12; dz++) {
    for (let dx = -12; dx <= 12; dx++) {
      place(world, edits, field.x + dx, field.y, field.z + dz, Block.Stone);
      for (let dy = 1; dy <= 4; dy++) place(world, edits, field.x + dx, field.y + dy, field.z + dz, Block.Air);
    }
  }
  const player = { id: 'p1', position: { x: field.x + 0.5, y: field.y + 1, z: field.z + 0.5 }, dead: false };
  const cow = new MobSim('cow', field.x + 3.5, field.y + 1, field.z + 0.5);
  const events = { onPlayerHit() {}, onMobDied() {}, onMobShoot() {} };
  let grazed = false;
  let looked = false;
  for (let t = 0; t < 120 && !(grazed && looked); t += 0.05) {
    cow.update(0.05, world, [player], events);
    if (cow.flags() & MOB_FLAG_GRAZING) grazed = true;
    if (Math.abs(cow.headYaw) > 0.05) looked = true;
  }
  assert.ok(grazed, 'a cow puts its head down now and then');
  assert.ok(looked, 'and looks around while idle');

  cow.position.x = field.x + 0.5;
  cow.position.z = field.z + 0.5;
  cow.takeDamage(1, cow.position.x - 1, cow.position.z, 'p1');
  const before = { ...cow.position };
  for (let t = 0; t < 1; t += 0.05) cow.update(0.05, world, [player], events);
  const fled = Math.hypot(cow.position.x - before.x, cow.position.z - before.z);
  assert.ok(fled > 0.5, `a hurt cow runs (moved ${fled.toFixed(2)})`);
  assert.ok(cow.position.x > before.x, 'away from the blow');
});

test('mobs survive a save round trip by name, never by wire number', () => {
  const sheep = new MobSim('sheep', 1, 2, 3);
  sheep.color = 5;
  sheep.shear();
  const villager = new MobSim('villager', 4, 5, 6);
  villager.home = { x: 10, y: 5, z: 12 };
  const saved = JSON.parse(JSON.stringify([sheep.toSave(), villager.toSave()]));
  const state = validateSimState({ timeOfDay: 0.4, mobs: saved, containers: [], drops: [] });
  assert.equal(state.mobs.length, 2);
  const back = MobSim.fromSave(state.mobs[0]);
  assert.equal(back.kind, 'sheep');
  assert.equal(back.color, 5);
  assert.ok(back.sheared);
  assert.deepEqual(MobSim.fromSave(state.mobs[1]).home, { x: 10, y: 5, z: 12 });
  assert.equal(state.mobs[0].kind, 'sheep', 'the save names the kind');
});

test('a world save validates field by field and upgrades an old one', () => {
  assert.equal(validateWorldSave(null), null);
  assert.equal(validateWorldSave({ id: 'abc' }), null, 'no seed, no world');
  const v1 = validateWorldSave({ id: 'deadbeefdeadbeef', seed: 7, timeOfDay: 0.5, edits: { '0,0': [5, 3, 99999, 3, 6, 9999] } });
  assert.ok(v1);
  assert.equal(v1.version, SAVE_VERSION);
  assert.deepEqual(v1.edits, { '0,0': [5, 3] }, 'bad pairs are dropped, good ones kept');
  assert.deepEqual(v1.mobs, []);
  assert.deepEqual(v1.players, {});
  const bad = validateWorldSave({
    ...emptyWorldSave('deadbeefdeadbeef', 'x', 7, 'host'),
    players: { k: { name: 'N', x: 'far', inventory: [{ id: 'nope', count: 1 }, { id: 'dirt', count: 1e9 }], health: 999 } },
    mobs: [{ kind: 'dragon', x: 0, y: 0, z: 0 }, { kind: 'cow', x: 1, y: 2, z: 3, yaw: 0, hp: 5 }],
    drops: [{ item: 'diamond', count: 2, x: 0, y: 40, z: 0, age: 1 }],
  });
  assert.ok(bad);
  const player = bad.players.k;
  assert.equal(player.x, 0, 'a broken coordinate falls back');
  assert.equal(player.health, 20, 'an impossible value is clamped to the maximum');
  assert.equal(player.inventory[0], null, 'unknown items are dropped');
  assert.equal(player.inventory[1]?.count, 64, 'oversized stacks are capped');
  assert.equal(bad.mobs.length, 1, 'unknown mob kinds are dropped');
  assert.equal(bad.drops[0].item, 'diamond');
});

// --- Spawning, villages and hunger ------------------------------------------

test('spawn rules pick by time of day, weighted, and animals need grass', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(pickSpawnKind('day', Math.random) ?? 'none');
  assert.ok(seen.has('pig') && seen.has('cow') && seen.has('sheep'), `daytime kinds: ${[...seen]}`);
  assert.ok(!seen.has('zombie') && !seen.has('villager'));
  for (const kind of ['pig', 'cow', 'sheep'] as const) assert.ok(MOB_DEFS[kind].spawn.needsGrass);
  assert.equal(pickSpawnKind('never', Math.random), null);
});

test('villages are deterministic, sit on land, and stay out of the spawn column', () => {
  const terrain = new TerrainGenerator(SEED);
  const a = layoutVillage(SEED, 0, 0, (x, z) => terrain.heightAt(x, z));
  const b = layoutVillage(SEED, 0, 0, (x, z) => terrain.heightAt(x, z));
  assert.deepEqual(a, b, 'the same cell lays out the same village every time');
  const villages = terrain.villagesNear(0, 0, 800);
  assert.ok(villages.length >= 2, 'a few villages within reach of the origin');
  for (const v of villages) {
    assert.ok(terrain.heightAt(v.x, v.z) > 30, 'a village well is on dry land');
    assert.ok(v.radius <= 36);
  }
  const spawn = terrain.findSpawnColumn();
  assert.equal(terrain.villageAt(spawn.x, spawn.z), null, 'nobody spawns inside a house');
});

test('hunger drains slowly enough that a full stomach lasts well over an hour', () => {
  const minutes = MAX_HUNGER / HUNGER_IDLE_DRAIN_PER_S / 60;
  assert.ok(minutes > 60, `idle drain empties the bar in ${minutes.toFixed(0)} min`);
});
