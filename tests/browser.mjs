// Browser end-to-end tests: real Chromium tabs playing the real game.
//
// Run with `npm run test:browser`. Unlike the node:test suites this needs a
// browser and two servers, so it is kept separate from `npm test`:
//
//   npm run build
//   npm run server &            # multiplayer server on :8787
//   npm run preview &           # the built client on :4173
//   npm run test:browser
//
// Playwright is optional; if it is not installed the suite says so and exits 0
// rather than failing a machine that simply cannot run browsers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_URL = process.env.VOXEL_CLIENT_URL ?? 'http://localhost:4173/';
const SERVER_URL = process.env.VOXEL_SERVER_URL ?? 'ws://localhost:8787';

/**
 * Playwright normally finds its own browser. Set VOXEL_CHROMIUM, or keep a
 * Chromium under PLAYWRIGHT_BROWSERS_PATH, when the bundled version does not
 * match the one on disk (common in prebuilt CI images).
 */
function findChromium() {
  if (process.env.VOXEL_CHROMIUM) return process.env.VOXEL_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  for (const dir of fs.readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const candidate = path.join(root, dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core is not installed — skipping browser tests.');
  process.exit(0);
}

// Chromium freezes requestAnimationFrame in backgrounded tabs, which stalls the
// game loop in every tab but the focused one. These flags keep all of them live.
const LAUNCH_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
];

const results = [];
let failures = 0;

async function testCase(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    failures++;
    results.push(`FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` in the page until it returns truthy, or time out. */
async function until(page, fn, timeoutMs = 20000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.evaluate(fn);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

/** Open a tab, point it at the test server, and wait for the game to boot. */
async function openGame(browser, { mobile = false } = {}) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
      : { viewport: { width: 1024, height: 700 } },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // ?server= is how the game is pointed at a specific backend (see net/config).
  const url = new URL(CLIENT_URL);
  url.searchParams.set('server', SERVER_URL);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

/** Start a singleplayer world and wait until it is simulating. */
async function startSingleplayer(page) {
  await page.click('#mode-single');
  await until(page, () => Boolean(window.__voxel), 30000, 'game boot');
  await page.evaluate(() => {
    // Enter play state without needing a real pointer lock.
    window.__voxel.look.locked = true;
  });
  await until(page, () => window.__voxel.world.chunks.size > 0, 30000, 'chunks');
}

const browser = await chromium.launch({
  args: LAUNCH_ARGS,
  executablePath: findChromium(),
});

try {
  // --- Singleplayer ---
  await testCase('singleplayer boots, generates terrain and runs the loop', async () => {
    const { context, page, errors } = await openGame(browser);
    await startSingleplayer(page);

    const state = await page.evaluate(() => ({
      chunks: window.__voxel.world.chunks.size,
      y: window.__voxel.player.position.y,
      health: window.__voxel.survival.health,
      hasSim: Boolean(window.__voxel.getLocalSim()),
      direct: window.__voxel.getWorldView().direct,
    }));
    assert.ok(state.chunks > 4, `too few chunks loaded: ${state.chunks}`);
    assert.ok(state.y > 0, 'the player fell out of the world');
    assert.equal(state.health, 20, 'a new player starts at full health');
    assert.ok(state.hasSim, 'singleplayer must run the shared simulation locally');
    assert.equal(state.direct, true, 'and render it with no interpolation delay');
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    await context.close();
  });

  await testCase('the player stands on the ground rather than falling forever', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const before = await page.evaluate(() => window.__voxel.player.position.y);
    await sleep(2500);
    const after = await page.evaluate(() => ({
      y: window.__voxel.player.position.y,
      onGround: window.__voxel.player.onGround,
    }));
    assert.ok(after.y > 0, 'the player fell out of the world');
    assert.ok(after.onGround || Math.abs(after.y - before) < 3, 'the player never settled');
    await context.close();
  });

  await testCase('singleplayer spawns mobs and dropped items into the view', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    // Force night so hostiles spawn promptly, then let the sim run.
    await page.evaluate(() => {
      window.__voxel.getLocalSim().timeOfDay = 0.8;
    });
    const mobs = await until(
      page,
      () => window.__voxel.getWorldView().mobCount,
      40000,
      'mobs to spawn',
    );
    assert.ok(mobs > 0, 'the local simulation must populate the world');

    // Drop an item and check it becomes a real entity in the view.
    await page.evaluate(() => {
      window.__voxel.inventory.add('dirt', 5);
      window.__voxel.dropHeldItem(false);
    });
    const drops = await until(
      page,
      () => window.__voxel.getWorldView().dropCount,
      10000,
      'a dropped item',
    );
    assert.ok(drops > 0, 'Q must put an item into the world');
    await context.close();
  });

  await testCase('mining a block yields an item you can pick up', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    // Clear a pocket, floor it with dirt, and aim down at it. Building the
    // ground rather than trusting the seed keeps the test deterministic.
    const at = await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -4; dz <= 0; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, 2); // dirt
          for (let dy = 0; dy < 4; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, 0);
        }
      }
      v.player.position.set(bx + 0.5, by, bz + 0.5);
      v.look.yaw = 0;
      v.look.pitch = -0.62;
      return { x: bx, y: by - 1, z: bz };
    });
    await sleep(1200);
    assert.ok(
      await page.evaluate(() => Boolean(window.__voxel.interaction.target)),
      'the crosshair must be on a block before mining can be tested',
    );

    // Hold the real mine button, so the game's own loop does the mining.
    const before = await page.evaluate(() => window.__voxel.getLocalSim().drops.size);
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })),
    );
    const after = await until(
      page,
      () => window.__voxel.getLocalSim().drops.size,
      20000,
      'a block to break and drop',
    );
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })),
    );
    assert.ok(after > before, 'breaking a block must drop an item');
    assert.ok(at.y > 0, 'sanity: the test built real ground');

    // And the drop must be collectable: step onto it and it goes in the bag.
    await page.evaluate(() => {
      const v = window.__voxel;
      const drop = [...v.getLocalSim().drops.values()][0];
      v.player.position.set(drop.position.x, drop.position.y, drop.position.z);
    });
    const collected = await until(
      page,
      () => window.__voxel.inventory.count('dirt'),
      15000,
      'the drop to be collected',
    );
    assert.ok(collected > 0, 'walking over a drop must add it to the inventory');
    await context.close();
  });

  // --- Animation ---
  await testCase('the held item is drawn in front of the camera and swings', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    const held = await page.evaluate(() => {
      const v = window.__voxel;
      v.inventory.add('diamond_pickaxe', 1);
      v.inventory.selectSlot(v.inventory.slots.findIndex((s) => s && s.id === 'diamond_pickaxe'));
      return true;
    });
    assert.ok(held);
    await sleep(300);

    // A pose is only meaningful if there is something to pose.
    const hasMesh = await page.evaluate(() => Boolean(window.__voxel.viewmodel.mesh));
    assert.ok(hasMesh, 'holding an item must put a model in front of the camera');

    // A swing must actually move it, then settle back.
    const rest = await page.evaluate(() => {
      const h = window.__voxel.viewmodel.holder;
      return { y: h.position.y, rotX: h.rotation.x };
    });

    // Sample the whole stroke rather than one instant. Which way the hand
    // travels depends on the item — a pickaxe chops down, a sword sweeps
    // sideways — so a single mid-stroke reading of one axis is a coin flip.
    const swung = await page.evaluate(async () => {
      const v = window.__voxel;
      v.viewmodel.swing('attack');
      const seen = [];
      while (v.viewmodel.swinging && seen.length < 240) {
        await new Promise((r) => requestAnimationFrame(r));
        const h = v.viewmodel.holder;
        seen.push({ y: h.position.y, z: h.position.z, rotX: h.rotation.x });
      }
      return seen;
    });
    assert.ok(swung.length > 3, `the stroke should span several frames, saw ${swung.length}`);
    const drop = rest.y - Math.min(...swung.map((p) => p.y));
    const forward = Math.min(...swung.map((p) => p.z));
    const rotated = rest.rotX - Math.min(...swung.map((p) => p.rotX));
    // A pickaxe chops: down and into the target, with the wrist turning over.
    // The exact shape of the curve is pinned by the unit tests, which sample it
    // at a fixed rate; here the renderer's framerate decides which parts of the
    // stroke a frame happens to land on, so only the gross motion is asserted.
    assert.ok(drop > 0.1, `the tool should come down through the blow, only got -${drop}`);
    assert.ok(forward < -0.7, `and drive forward, reached z=${forward}`);
    assert.ok(rotated > 0.3, `and rotate through the stroke, got ${rotated}`);

    // Poll rather than assume a wall-clock duration: the stroke advances on
    // frame dt, which runs slower than real time on a struggling renderer.
    await until(page, () => !window.__voxel.viewmodel.swinging, 8000, 'the stroke to end');
    await sleep(120);
    const after = await page.evaluate(() => window.__voxel.viewmodel.holder.position.y);
    assert.ok(Math.abs(after - rest.y) < 0.05, `the item must return to rest, got ${after}`);
    await context.close();
  });

  await testCase('going under water drains the air bar and then drowns you', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    // Dig a pool around the player and fill it over their head. Doing it with
    // the real setBlock means the real water rules apply.
    await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, v.Block.Stone);
          for (let dy = 0; dy < 5; dy++) {
            v.world.setBlock(bx + dx, by + dy, bz + dz, v.Block.Water);
          }
        }
      }
      v.player.position.set(bx + 0.5, by + 0.5, bz + 0.5);
    });

    // The eyes have to actually be under the surface, or nothing else follows.
    await until(page, () => window.__voxel.player.eyeInWater, 15000, 'the head to submerge');

    const bar = () => page.evaluate(() => ({
      air: window.__voxel.survival.air,
      health: window.__voxel.survival.health,
      bubblesShown: document.querySelectorAll('#air-bar svg:not(.empty)').length,
      barVisible: document.getElementById('air-bar').classList.contains('visible'),
    }));

    // Air goes down, and the HUD follows it. Only a second or so of it is
    // checked here — how fast it drains is settled in the unit tests, and the
    // frame loop clamps dt, so game time runs slower than the wall clock on a
    // software renderer.
    await until(
      page,
      () => window.__voxel.survival.air < 14,
      20000,
      'air to start draining',
    );
    const mid = await bar();
    assert.ok(mid.barVisible, 'the bubble bar must appear as soon as you go under');
    assert.equal(mid.bubblesShown, 10, 'and start out full');
    assert.equal(mid.health, 20, 'breath alone must not cost health');

    // Then the bubbles burst one at a time, rather than the bar draining as
    // one continuous slider.
    const spent = await until(
      page,
      () => {
        const n = document.querySelectorAll('#air-bar svg:not(.empty)').length;
        return n < 10 ? n + 1 : 0;
      },
      20000,
      'a bubble to burst',
    ) - 1;
    assert.ok(spent >= 0 && spent < 10, `expected a partly spent bar, saw ${spent} bubbles`);

    // Skip to the end of the air rather than sitting through fifteen game
    // seconds of it; what matters here is that running out actually hurts.
    await page.evaluate(() => {
      window.__voxel.survival.air = 0.2;
    });
    const hurt = await until(
      page,
      () => (window.__voxel.survival.health < 20 ? window.__voxel.survival.health : 0),
      25000,
      'drowning damage',
    );
    assert.ok(hurt < 20, `expected to be drowning, health was ${hurt}`);
    const empty = await bar();
    assert.equal(empty.bubblesShown, 0, 'every bubble should be gone by the time you drown');

    // Surfacing has to stop it and give the air back.
    await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = 0; dy < 6; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, v.Block.Air);
        }
      }
    });
    const healthAtSurface = (await bar()).health;
    await until(
      page,
      () => window.__voxel.survival.air >= 15,
      25000,
      'the lungs to refill',
    );
    const after = await bar();
    assert.ok(!after.barVisible, 'a full bar should disappear again');
    // Not equal: a well-fed player regenerates. Only a further loss would mean
    // the drowning was still running.
    assert.ok(
      after.health >= healthAtSurface,
      `the drowning kept going after surfacing: ${healthAtSurface} -> ${after.health}`,
    );
    await context.close();
  });

  await testCase('drowning kills, and the death screen says so', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, v.Block.Stone);
          for (let dy = 0; dy < 5; dy++) {
            v.world.setBlock(bx + dx, by + dy, bz + dz, v.Block.Water);
          }
        }
      }
      v.player.position.set(bx + 0.5, by + 0.5, bz + 0.5);
    });
    await until(page, () => window.__voxel.player.eyeInWater, 15000, 'the head to submerge');

    // Start on one heart with the air already gone, so the test does not sit
    // through fifteen seconds of breath and ten hearts of drowning.
    await page.evaluate(() => {
      window.__voxel.survival.air = 0;
      window.__voxel.survival.health = 2;
    });

    await until(page, () => window.__voxel.survival.dead, 25000, 'the player to drown');
    const message = await page.evaluate(() => document.getElementById('death-msg').textContent);
    assert.match(message, /drown/i, `the death screen should name drowning, said "${message}"`);

    // And respawning must hand the lungs back rather than dropping you in dead.
    await page.evaluate(() => window.__voxel.respawn());
    await sleep(500);
    const revived = await page.evaluate(() => ({
      air: window.__voxel.survival.air,
      health: window.__voxel.survival.health,
      dead: window.__voxel.survival.dead,
    }));
    assert.equal(revived.dead, false);
    assert.equal(revived.health, 20);
    assert.ok(revived.air > 14, `respawn should restore the air, got ${revived.air}`);
    await context.close();
  });

  await testCase('switching items dips the hand and swaps at the bottom', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    await page.evaluate(() => {
      const v = window.__voxel;
      // Software rendering here is slow enough that the quality ladder would
      // switch the viewmodel off mid-test; this is about the animation, not
      // about how the game copes with a struggling GPU.
      v.autoQuality?.disable();
      v.setAnimatedLimbs(true);
      v.inventory.add('diamond_pickaxe', 1);
      v.inventory.add('diamond_sword', 1);
      v.inventory.selectSlot(v.inventory.slots.findIndex((s) => s && s.id === 'diamond_pickaxe'));
    });

    // Wait for the pickaxe's own draw-in to finish before measuring, rather
    // than assuming a wall-clock duration: the dip advances on frame dt.
    await until(
      page,
      () => window.__voxel.viewmodel.holder.position.y > -0.45,
      15000,
      'the pickaxe to settle',
    );

    // Watch the hand across the swap: it has to leave the frame and come back,
    // and the model must change while it is out of sight rather than popping.
    const swap = await page.evaluate(async () => {
      const v = window.__voxel;
      const rest = v.viewmodel.holder.position.y;
      const swordSlot = v.inventory.slots.findIndex((s) => s && s.id === 'diamond_sword');
      v.inventory.selectSlot(swordSlot);

      const seen = [];
      let geometryChangedAt = -1;
      const startGeometry = v.viewmodel.mesh?.geometry.uuid;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        seen.push(v.viewmodel.holder.position.y);
        if (geometryChangedAt < 0 && v.viewmodel.mesh?.geometry.uuid !== startGeometry) {
          geometryChangedAt = seen.length - 1;
        }
      }
      return { rest, seen, geometryChangedAt, held: v.inventory.selectedStack?.id };
    });

    assert.equal(swap.held, 'diamond_sword', 'the sword should be selected');
    const lowest = Math.min(...swap.seen);
    assert.ok(
      lowest < swap.rest - 0.3,
      `the hand should drop out of frame to swap, only reached ${lowest} from ${swap.rest}`,
    );
    assert.ok(swap.geometryChangedAt >= 0, 'the model must actually change');
    // The swap has to happen near the bottom of the dip, not on the way in or out.
    const yAtSwap = swap.seen[swap.geometryChangedAt];
    assert.ok(
      yAtSwap < lowest + 0.15,
      `the swap was visible: y=${yAtSwap} but the dip bottomed out at ${lowest}`,
    );
    // And it must come back up.
    const settled = swap.seen[swap.seen.length - 1];
    assert.ok(
      Math.abs(settled - swap.rest) < 0.06,
      `the new item should rise back to rest, ended at ${settled}`,
    );
    await context.close();
  });

  await testCase('mining swings the arm and cracks the block', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    // Stone underfoot and a slow tool, so the crack stages are observable.
    await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -4; dz <= 0; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, 3); // stone
          for (let dy = 0; dy < 4; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, 0);
        }
      }
      v.player.position.set(bx + 0.5, by, bz + 0.5);
      v.look.yaw = 0;
      v.look.pitch = -0.62;
    });
    await sleep(1200);

    // Hold the real mine button: the game's own loop does the mining.
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })),
    );

    const stages = new Set();
    let sawSwing = false;
    for (let i = 0; i < 120; i++) {
      await sleep(50);
      const s = await page.evaluate(() => {
        const v = window.__voxel;
        const ov = v.breakOverlay;
        return {
          progress: v.interaction.breakProgress,
          overlayVisible: ov.mesh.visible,
          tile: ov.currentTile,
          swinging: v.viewmodel.swinging,
        };
      });
      if (s.swinging) sawSwing = true;
      if (s.progress > 0 && s.overlayVisible) stages.add(s.tile);
      if (stages.size >= 4) break;
    }
    await page.evaluate(() =>
      document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true })),
    );

    assert.ok(sawSwing, 'mining must swing the arm, not just fill a progress bar');
    assert.ok(stages.size >= 4, `cracks should advance through stages, saw ${stages.size}`);

    // Releasing the button clears the cracks.
    await sleep(300);
    const cleared = await page.evaluate(() => window.__voxel.breakOverlay.mesh.visible);
    assert.equal(cleared, false, 'cracks must disappear when you stop mining');
    await context.close();
  });

  await testCase('mobs walk with moving legs, and stand still when idle', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    await page.evaluate(() => {
      window.__voxel.getLocalSim().timeOfDay = 0.8; // night: hostiles that chase
    });
    await until(page, () => window.__voxel.getWorldView().mobCount, 40000, 'mobs');

    // Every mob must be built as a rig with independently posable limbs.
    const rig = await page.evaluate(() => {
      const mob = window.__voxel.getWorldView().allMobs[0];
      return {
        parts: mob.object.children.length,
        names: [...mob.rig.segments.keys()],
      };
    });
    assert.ok(rig.parts > 1, 'an animated mob is more than one rigid mesh');
    assert.ok(rig.names.includes('body'), `expected a body segment, got ${rig.names}`);

    // Sample a walking mob's leg over time: it must actually move.
    const swept = await page.evaluate(async () => {
      const view = window.__voxel.getWorldView();
      const angles = [];
      for (let i = 0; i < 40; i++) {
        for (const mob of view.allMobs) {
          const leg = mob.rig.segments.get('legL') ?? mob.rig.segments.get('legsA');
          if (leg && mob.object.visible) angles.push(leg.rotation.x);
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      return { min: Math.min(...angles), max: Math.max(...angles), n: angles.length };
    });
    assert.ok(swept.n > 0, 'no mob was visible to sample');
    assert.ok(
      swept.max - swept.min > 0.15,
      `mob legs barely moved over 2.4s (range ${(swept.max - swept.min).toFixed(3)})`,
    );
    await context.close();
  });

  await testCase('dropping limb animation keeps mobs on screen and cheap', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    await page.evaluate(() => {
      window.__voxel.getLocalSim().timeOfDay = 0.8;
    });
    await until(page, () => window.__voxel.getWorldView().mobCount, 40000, 'mobs');

    const before = await page.evaluate(() => {
      const view = window.__voxel.getWorldView();
      return {
        mobs: view.mobCount,
        parts: view.allMobs.reduce((n, m) => n + m.object.children.length, 0),
      };
    });

    // This is what the quality ladder does on a struggling device.
    await page.evaluate(() => window.__voxel.setAnimatedLimbs(false));
    await sleep(600);

    const after = await page.evaluate(() => {
      const view = window.__voxel.getWorldView();
      return {
        mobs: view.mobCount,
        parts: view.allMobs.reduce((n, m) => n + m.object.children.length, 0),
        visible: view.allMobs.filter((m) => m.object.visible).length,
        viewmodel: window.__voxel.viewmodel.enabled,
      };
    });

    assert.equal(after.mobs, before.mobs, 'no mob may be lost when limbs are dropped');
    assert.ok(after.parts < before.parts, 'and the draw-call count must actually fall');
    assert.equal(after.parts, after.mobs, 'a merged mob is exactly one mesh');
    assert.ok(after.visible > 0, 'mobs must still be rendered, just not animated');
    assert.equal(after.viewmodel, false, 'the held-item pass is dropped too');

    // And it must come back.
    await page.evaluate(() => window.__voxel.setAnimatedLimbs(true));
    await sleep(600);
    const restored = await page.evaluate(() => {
      const view = window.__voxel.getWorldView();
      return {
        parts: view.allMobs.reduce((n, m) => n + m.object.children.length, 0),
        mobs: view.mobCount,
      };
    });
    assert.ok(restored.parts > restored.mobs, 'limbs must come back when the device recovers');
    await context.close();
  });

  await testCase('a skeleton aims its bow, fires, and the arrow hurts you', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);

    // A flat lit arena, so line of sight is clear and nothing else interferes.
    const at = await page.evaluate(() => {
      const v = window.__voxel;
      v.getLocalSim().timeOfDay = 0.5;
      v.autoQuality?.disable();
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -12; dx <= 12; dx++) {
        for (let dz = -16; dz <= 6; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, 3);
          for (let dy = 0; dy < 6; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, 0);
        }
      }
      v.player.position.set(bx + 0.5, by, bz + 0.5);
      v.look.yaw = 0;
      v.look.pitch = -0.05;
      return { bx, by, bz };
    });
    await sleep(1200);

    const id = await page.evaluate(
      (a) => window.__voxel.spawnTestMob('skeleton', a.bx + 0.5, a.by, a.bz - 8),
      at,
    );
    assert.ok(id, 'the test skeleton was not spawned');

    // Watch a full draw / fire / reload cycle from the client's point of view.
    let peakDraw = 0;
    let sawArrow = false;
    let armsRaisedAtFullDraw = null;
    const health = [];
    for (let i = 0; i < 260; i++) {
      await sleep(45);
      const s = await page.evaluate((mobId) => {
        const v = window.__voxel;
        const view = v.getWorldView();
        const mob = view.allMobs.find((m) => m.id === mobId);
        const arms = mob && mob.rig.segments.get('arms');
        return {
          draw: v.getLocalSim().mobs.get(mobId)?.drawTime ?? 0,
          arrows: view.arrowCount,
          arms: arms ? arms.rotation.x : null,
          kind: mob ? mob.kind : null,
          health: v.survival.health,
        };
      }, id);
      health.push(s.health);
      if (s.draw > peakDraw) peakDraw = s.draw;
      if (s.draw > 0.85 && s.arms !== null) armsRaisedAtFullDraw = s.arms;
      if (s.arrows > 0) sawArrow = true;
      if (sawArrow && armsRaisedAtFullDraw !== null && s.health < 20) break;
    }

    assert.ok(peakDraw > 0.85, `the bow was never fully drawn (peak ${peakDraw.toFixed(2)}s)`);
    assert.ok(
      armsRaisedAtFullDraw !== null && armsRaisedAtFullDraw < -1,
      `the arms did not raise to aim (got ${armsRaisedAtFullDraw})`,
    );
    assert.ok(sawArrow, 'no arrow was ever rendered in the world');
    assert.ok(
      health[health.length - 1] < 20,
      'a skeleton that lands arrows must actually hurt the player',
    );

    // The arrow is a real world entity, not a client-side effect.
    const kind = await page.evaluate(
      (mobId) => window.__voxel.getWorldView().allMobs.find((m) => m.id === mobId)?.kind,
      id,
    );
    assert.equal(kind, 2, 'the skeleton should render as its own mob kind');
    await context.close();
  });

  await testCase('a skeleton keeps its distance rather than closing to melee', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const at = await page.evaluate(() => {
      const v = window.__voxel;
      v.getLocalSim().timeOfDay = 0.5;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -12; dx <= 12; dx++) {
        for (let dz = -12; dz <= 12; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, 3);
          for (let dy = 0; dy < 6; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, 0);
        }
      }
      v.player.position.set(bx + 0.5, by, bz + 0.5);
      return { bx, by, bz };
    });
    await sleep(1200);

    // Spawn it right on top of the player: an archer should back away.
    const id = await page.evaluate(
      (a) => window.__voxel.spawnTestMob('skeleton', a.bx + 1.5, a.by, a.bz),
      at,
    );
    // Poll rather than sleep: the frame loop clamps dt, so on a software
    // renderer the simulation advances slower than the wall clock and a fixed
    // wait can end before the skeleton has had time to move at all.
    let distance = -1;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      distance = await page.evaluate((mobId) => {
        const v = window.__voxel;
        const mob = v.getLocalSim().mobs.get(mobId);
        if (!mob) return -1;
        return Math.hypot(
          mob.position.x - v.player.position.x,
          mob.position.z - v.player.position.z,
        );
      }, id);
      if (distance > 3 || distance < 0) break;
      await sleep(250);
    }
    assert.ok(distance > 3, `the archer closed to ${distance.toFixed(1)} blocks instead of backing off`);
    await context.close();
  });

  // --- Crafting, containers, beds, death and villages ---
  await testCase('the crafting grid turns a log into planks, from the pocket and the table', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const result = await page.evaluate(() => {
      const v = window.__voxel;
      v.inventory.add('log', 2);
      const pocket = v.__craftAt('planks', 'none');
      const planks = v.inventory.count('planks');
      v.inventory.add('cobblestone', 3);
      v.inventory.add('stick', 2);
      const denied = v.__craftAt('stone_pickaxe', 'none');
      const table = v.__craftAt('stone_pickaxe', 'table');
      return { pocket, planks, denied, table, picks: v.inventory.count('stone_pickaxe'), open: v.inventoryUi.open };
    });
    assert.equal(result.pocket, true, 'planks come out of the pocket grid');
    assert.equal(result.planks, 4);
    assert.equal(result.denied, false, 'a pickaxe does not fit a 2x2 grid');
    assert.equal(result.table, true, 'but a crafting table makes it');
    assert.equal(result.picks, 1);

    // The screen itself shows the grid and the recipe book.
    await page.evaluate(() => {
      window.__voxel.inventoryCtl.openGrid(3);
      window.__voxel.inventoryUi.show();
    });
    const screen = await page.evaluate(() => ({
      cells: document.querySelectorAll('#inv-craft-grid .inv-slot').length,
      recipes: document.querySelectorAll('#recipe-list .recipe').length,
      title: document.getElementById('inv-title').textContent,
    }));
    assert.equal(screen.cells, 9, 'a table shows nine cells');
    assert.ok(screen.recipes > 10, 'the recipe book lists the recipes');
    assert.equal(screen.title, 'Crafting Table');
    await page.evaluate(() => window.__voxel.inventoryUi.close());
    await context.close();
  });

  await testCase('a furnace smelts ore over time and a chest keeps its contents', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const at = await page.evaluate(() => {
      const v = window.__voxel;
      v.autoQuality?.disable();
      const p = v.player.position;
      const bx = Math.floor(p.x) + 2, by = Math.floor(p.y), bz = Math.floor(p.z);
      v.world.setBlock(bx, by, bz, v.Block.Furnace);
      v.world.setBlock(bx + 1, by, bz, v.Block.Chest);
      v.inventory.add('raw_iron', 1);
      v.inventory.add('coal', 1);
      v.inventory.add('diamond', 2);
      const ctl = v.inventoryCtl;
      if (!ctl.openContainer(bx, by, bz)) return null;
      // Shift-click the ore and the coal into the furnace.
      ctl.click({ kind: 'inv', index: v.inventory.slots.findIndex((s) => s && s.id === 'raw_iron') }, 0, true);
      ctl.click({ kind: 'inv', index: v.inventory.slots.findIndex((s) => s && s.id === 'coal') }, 0, true);
      const slots = ctl.container.slots.slots.map((s) => (s ? s.id : null));
      return { bx, by, bz, slots };
    });
    assert.ok(at, 'the furnace must open as a container');
    assert.deepEqual(at.slots, ['raw_iron', 'coal', null], 'ore in the top, fuel in the bottom');

    // The world keeps going while the furnace screen is open: the flame and
    // the arrow must move on screen, not wait for the screen to close.
    await page.evaluate(() => window.__voxel.inventoryUi.show());
    await until(
      page,
      () => {
        const state = window.__voxel.inventoryCtl.furnaceState();
        return state && state.burn > 0 && state.progress > 0;
      },
      20000,
      'the furnace to burn while being watched',
    );
    const bars = await page.evaluate(() => ({
      flame: document.getElementById('furnace-flame-bar').style.height,
      arrow: document.getElementById('furnace-arrow-bar').style.width,
      title: document.getElementById('inv-title').textContent,
    }));
    assert.equal(bars.title, 'Furnace');
    assert.notEqual(bars.flame, '0%', 'the flame bar shows the fuel burning');
    assert.notEqual(bars.arrow, '0%', 'the arrow shows smelting progress');
    await page.evaluate(() => window.__voxel.inventoryUi.close());

    // The furnace works whether or not anyone is looking at it: it lights up
    // in the world, and an ingot comes out after the smelting time.
    await until(
      page,
      new Function(
        `const v = window.__voxel; return v.world.getBlock(${at.bx}, ${at.by}, ${at.bz}) === v.Block.LitFurnace;`,
      ),
      20000,
      'the furnace to light',
    );
    const smelted = await until(
      page,
      () => {
        for (const c of window.__voxel.getLocalSim().containers.values()) {
          if (c.kind === 'furnace' && c.slots[2] && c.slots[2].id === 'iron_ingot') return true;
        }
        return false;
      },
      60000,
      'the ore to smelt',
    );
    assert.ok(smelted, 'an ingot must come out');

    // Put diamonds into the chest, close it, reopen: still there.
    const kept = await page.evaluate((a) => {
      const v = window.__voxel;
      const ctl = v.inventoryCtl;
      ctl.openContainer(a.bx + 1, a.by, a.bz);
      ctl.click({ kind: 'inv', index: v.inventory.slots.findIndex((s) => s && s.id === 'diamond') }, 0, true);
      ctl.close();
      ctl.openContainer(a.bx + 1, a.by, a.bz);
      const inChest = ctl.container.slots.slots.filter((s) => s && s.id === 'diamond').reduce((n, s) => n + s.count, 0);
      ctl.close();
      return { inChest, inBag: v.inventory.count('diamond') };
    }, at);
    assert.equal(kept.inChest, 2, 'the chest holds what was put in it');
    assert.equal(kept.inBag, 0);
    await context.close();
  });

  await testCase('closing a crafting table or furnace gives the mouse back', async () => {
    // A real pointer lock, taken and given back the way a player does it.
    // Losing it here is the difference between playing on and being stranded
    // with a free cursor over a world that no longer answers to it.
    const { context, page } = await openGame(browser);
    await page.click('#mode-single');
    await until(page, () => Boolean(window.__voxel), 30000, 'game boot');
    await until(page, () => window.__voxel.world.chunks.size > 4, 30000, 'chunks');

    await page.mouse.click(512, 350); // "Click to play"
    await sleep(700);
    const locked = await page.evaluate(() => window.__voxel.look.locked);
    assert.ok(locked, 'this browser must grant pointer lock for the test to mean anything');

    // A flat pocket with a crafting table right under the crosshair.
    await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const bx = Math.round(p.x), bz = Math.round(p.z), by = Math.floor(p.y);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -4; dz <= 0; dz++) {
          v.world.setBlock(bx + dx, by - 1, bz + dz, v.Block.Dirt);
          for (let dy = 0; dy < 4; dy++) v.world.setBlock(bx + dx, by + dy, bz + dz, 0);
        }
      }
      v.player.position.set(bx + 0.5, by, bz + 0.5);
      v.look.yaw = 0;
      v.look.pitch = -0.62;
    });
    await sleep(1200);

    const aimAtTable = async () => {
      await page.evaluate(() => {
        const v = window.__voxel;
        v.look.yaw = 0;
        v.look.pitch = -0.62;
      });
      await sleep(500);
      await page.evaluate(() => {
        const v = window.__voxel;
        const t = v.interaction.target;
        if (t) v.world.setBlock(t.x, t.y, t.z, v.Block.CraftingTable);
      });
      await sleep(400);
    };

    const state = () =>
      page.evaluate(() => ({
        locked: window.__voxel.look.locked,
        menu: getComputedStyle(document.getElementById('menu')).display,
        open: window.__voxel.inventoryUi.open,
      }));

    /** Either the camera is back, or the menu is up and a click brings it back. */
    const assertNotStranded = async (how) => {
      const s = await state();
      assert.equal(s.open, false, `${how}: the screen should be closed`);
      assert.ok(
        s.locked || s.menu !== 'none',
        `${how}: stranded — pointer unlocked with no menu to click (${JSON.stringify(s)})`,
      );
    };

    const openTable = async () => {
      if (!(await page.evaluate(() => window.__voxel.look.locked))) {
        await page.mouse.click(512, 350);
        await sleep(700);
      }
      await aimAtTable();
      await page.mouse.click(512, 350, { button: 'right' });
      await sleep(700);
      const s = await state();
      assert.ok(s.open, `the crafting table did not open: ${JSON.stringify(s)}`);
      assert.equal(s.locked, false, 'opening a screen releases the mouse');
    };

    // 1. The E key.
    await openTable();
    await page.keyboard.press('KeyE');
    await sleep(1200);
    await assertNotStranded('closed with E');

    // 2. The Close button, which is the same action to a player.
    await openTable();
    await page.click('#inv-close');
    await sleep(1200);
    await assertNotStranded('closed with the Close button');

    // 3. Escape first (the browser drops the lock itself), then E — the case
    //    where the browser refuses to hand the lock straight back.
    await openTable();
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('KeyE');
    await sleep(1500);
    await assertNotStranded('escaped, then closed with E');

    // 4. Hammering the key, which is how a lock request gets refused.
    await openTable();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('KeyE');
      await sleep(120);
      await page.keyboard.press('KeyE');
      await sleep(120);
    }
    await page.keyboard.press('KeyE');
    await sleep(1500);
    await assertNotStranded('opened and closed repeatedly');

    // And the camera must actually answer the mouse again afterwards.
    if ((await state()).locked) {
      const before = await page.evaluate(() => window.__voxel.look.yaw);
      await page.mouse.move(512, 350);
      await page.mouse.move(712, 350);
      await sleep(400);
      const after = await page.evaluate(() => window.__voxel.look.yaw);
      assert.notEqual(after, before, 'the camera must turn with the mouse again');
    }
    await context.close();
  });

  await testCase('sleeping in a bed at night brings the morning', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const before = await page.evaluate(() => {
      const v = window.__voxel;
      v.autoQuality?.disable();
      const p = v.player.position;
      const bx = Math.floor(p.x) + 1, by = Math.floor(p.y), bz = Math.floor(p.z);
      v.world.setBlock(bx, by - 1, bz, v.Block.Stone);
      v.world.setBlock(bx, by, bz, v.Block.Bed);
      v.getLocalSim().timeOfDay = 0.5;
      const atNoon = v.sleepAt(bx, by, bz);
      const noonSleeping = v.isSleeping();
      v.getLocalSim().timeOfDay = 0.8;
      v.sleepAt(bx, by, bz);
      return { atNoon, noonSleeping, sleeping: v.isSleeping(), time: v.sky.timeOfDay };
    });
    assert.equal(before.noonSleeping, false, 'you cannot sleep at noon');
    assert.equal(before.sleeping, true, 'at night the bed is accepted');
    const overlay = await page.evaluate(() => document.getElementById('sleep-overlay').style.display);
    assert.equal(overlay, 'flex', 'the screen goes dark');

    await until(page, () => !window.__voxel.isSleeping(), 30000, 'the night to pass');
    const after = await page.evaluate(() => window.__voxel.sky.timeOfDay);
    assert.ok(after > 0.2 && after < 0.35, `it should be morning, time is ${after.toFixed(2)}`);
    await context.close();
  });

  await testCase('dying drops what you carried where you fell, and you get nothing back', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const result = await page.evaluate(() => {
      const v = window.__voxel;
      v.inventory.add('diamond', 5);
      v.inventory.add('iron_sword', 1);
      v.survival.damage(100, true, 'generic');
      const drops = [...v.getLocalSim().drops.values()].map((d) => d.itemId);
      return { dead: v.survival.dead, drops, left: v.inventory.count('diamond') };
    });
    assert.equal(result.dead, true);
    assert.ok(result.drops.includes('diamond') && result.drops.includes('iron_sword'), `dropped: ${result.drops}`);
    assert.equal(result.left, 0, 'the inventory is emptied');
    await page.evaluate(() => window.__voxel.respawn());
    const respawned = await page.evaluate(() => ({ alive: !window.__voxel.survival.dead, diamonds: window.__voxel.inventory.count('diamond') }));
    assert.equal(respawned.alive, true);
    assert.equal(respawned.diamonds, 0, 'nothing comes back for free');
    await context.close();
  });

  await testCase('villages exist in the world, with houses, chests and farms', async () => {
    const { context, page } = await openGame(browser);
    await startSingleplayer(page);
    const village = await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const near = v.world.terrain.villagesNear(p.x, p.z, 700);
      if (near.length === 0) return null;
      const [gx, gz] = near[0].id.split(',').map(Number);
      const layout = v.world.terrain.villageInCell(gx, gz);
      return { count: near.length, houses: layout.houses.length, farms: layout.farms.length, paths: layout.paths.length };
    });
    assert.ok(village, 'a village should be within reach of spawn');
    assert.ok(village.houses >= 1, 'with at least one house');
    assert.equal(village.paths, 4, 'and paths leading out of it');
    await context.close();
  });

  // --- Multiplayer: three real tabs, one of them "mobile" ---
  await testCase('three players share one world across desktop and mobile', async () => {
    const host = await openGame(browser);
    const guest = await openGame(browser);
    const phone = await openGame(browser, { mobile: true });

    try {
      // Host creates a room.
      await host.page.click('#mode-multi');
      await host.page.fill('#mp-name', 'Host');
      await host.page.click('#mp-create');
      await host.page.waitForSelector('#mp-lobby-code:not(:empty)');
      const code = (await host.page.textContent('#mp-lobby-code')).trim();
      assert.match(code, /^[A-Z0-9]{6}$/, `bad room code in the lobby: ${code}`);

      // Both guests join with that code — one desktop, one phone. Guests drop
      // straight into the world; only the host waits in the lobby.
      for (const [tab, name] of [[guest, 'Guest'], [phone, 'Phone']]) {
        await tab.page.click('#mode-multi');
        await tab.page.fill('#mp-name', name);
        await tab.page.fill('#mp-code', code);
        await tab.page.click('#mp-join');
        await until(tab.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');
      }

      // The lobby must show all three before the host starts.
      await host.page.waitForFunction(
        () => document.getElementById('mp-lobby-count').textContent.includes('3 / 3'),
        undefined,
        { timeout: 20000 },
      );
      await host.page.click('#mp-start');
      await until(host.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');

      for (const tab of [host, guest, phone]) {
        await until(tab.page, () => window.__voxel.world.chunks.size > 0, 40000, 'chunks');
      }

      // Everyone must be generating the same world.
      const seeds = [];
      for (const tab of [host, guest, phone]) {
        seeds.push(await tab.page.evaluate(() => window.__voxel.world.terrain.seed));
      }
      assert.equal(new Set(seeds).size, 1, `players got different worlds: ${seeds}`);

      // Everyone must see the other two.
      for (const tab of [host, guest, phone]) {
        const others = await until(
          tab.page,
          () => window.__voxel.getSession().remotePlayers.all.length,
          25000,
          'the other players',
        );
        assert.equal(others, 2, 'each player should see the other two');
      }

      // A block dug up by the phone must disappear for the host. setBlock is
      // what the game itself calls; the session forwards local edits, and the
      // server relays what it accepts. (Placing needs an item in hand, and a
      // fresh player holds nothing.)
      // A phone starts paused behind its tap-to-play menu; tap through it so
      // the body actually drops onto the ground before digging under it.
      await phone.page.evaluate(() =>
        document.getElementById('menu').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })),
      );
      await until(phone.page, () => window.__voxel.player.onGround, 20000, 'the phone to land');
      const dug = await phone.page.evaluate(() => {
        const v = window.__voxel;
        const p = v.player.position;
        const at = { x: Math.floor(p.x) + 1, y: Math.floor(p.y) - 1, z: Math.floor(p.z) };
        v.world.setBlock(at.x, at.y, at.z, 0);
        return at;
      });
      await until(
        host.page,
        new Function(
          `return window.__voxel.world.getBlock(${dug.x}, ${dug.y}, ${dug.z}) === 0`,
        ),
        20000,
        'the block to sync',
      );

      // The server's mobs and clock must reach every client identically.
      const times = [];
      for (const tab of [host, guest, phone]) {
        times.push(await tab.page.evaluate(() => window.__voxel.sky.timeOfDay));
      }
      const spread = Math.max(...times) - Math.min(...times);
      assert.ok(spread < 0.05, `the day/night clock drifted between clients: ${times}`);

      for (const tab of [host, guest, phone]) {
        assert.deepEqual(tab.errors, [], `page errors: ${tab.errors.join('; ')}`);
        const direct = await tab.page.evaluate(() => window.__voxel.getWorldView().direct);
        assert.equal(direct, false, 'multiplayer clients must interpolate, not simulate');
        const local = await tab.page.evaluate(() => Boolean(window.__voxel.getLocalSim()));
        assert.equal(local, false, 'no client may run its own mob simulation in a room');
      }
    } finally {
      await host.context.close();
      await guest.context.close();
      await phone.context.close();
    }
  });

  await testCase('an item dropped by one player can be picked up by another', async () => {
    const host = await openGame(browser);
    const guest = await openGame(browser);

    try {
      await host.page.click('#mode-multi');
      await host.page.fill('#mp-name', 'Giver');
      await host.page.click('#mp-create');
      await host.page.waitForSelector('#mp-lobby-code:not(:empty)');
      const code = (await host.page.textContent('#mp-lobby-code')).trim();

      await guest.page.click('#mode-multi');
      await guest.page.fill('#mp-name', 'Taker');
      await guest.page.fill('#mp-code', code);
      await guest.page.click('#mp-join');
      await until(guest.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');

      await host.page.click('#mp-start');
      await until(host.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');

      for (const tab of [host, guest]) {
        await until(tab.page, () => window.__voxel.world.chunks.size > 0, 40000, 'chunks');
        await tab.page.evaluate(() => {
          window.__voxel.look.locked = true;
        });
      }

      // Items only come from the world now: the giver digs up the block under
      // their feet, falls into the hole and collects the dirt the server drops.
      await until(host.page, () => window.__voxel.player.onGround, 20000, 'the giver to land');
      await host.page.evaluate(() => {
        const v = window.__voxel;
        const p = v.player.position;
        v.world.setBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), 0);
      });
      await until(
        host.page,
        () => window.__voxel.inventory.count('dirt'),
        30000,
        'the server to hand over the dug-up block',
      );

      // Stand the taker on the giver, so the thrown stack lands at their feet.
      const at = await host.page.evaluate(() => {
        const p = window.__voxel.player.position;
        return { x: p.x, y: p.y, z: p.z };
      });
      await guest.page.evaluate((pos) => {
        window.__voxel.player.position.set(pos.x, pos.y, pos.z);
      }, at);

      const beforeCount = await guest.page.evaluate(() => window.__voxel.inventory.count('dirt'));
      await host.page.evaluate(() => {
        const v = window.__voxel;
        v.inventoryCtl.selectSlot(v.inventory.slots.findIndex((s) => s && s.id === 'dirt'));
        v.dropHeldItem(true);
      });

      // The throw has to reach the world before it can reach anyone in it;
      // checking separately says which half failed.
      await until(
        host.page,
        () => window.__voxel.getWorldView().dropCount,
        20000,
        'the thrown stack to appear in the world',
      );

      // The stack must reach the other player, not bounce back to the thrower.
      // Generously timed: the frame loop clamps dt, so on a software renderer
      // the pickup delay and the fall both take longer than their wall clock.
      const taken = await until(
        guest.page,
        () => window.__voxel.inventory.count('dirt'),
        45000,
        'the item to change hands',
      );
      assert.ok(taken > beforeCount, 'the receiving player never got the item');

      const keptByThrower = await host.page.evaluate(() =>
        window.__voxel.inventory.count('dirt'),
      );
      assert.equal(keptByThrower, 0, 'the thrower must not still hold what they threw');
    } finally {
      await host.context.close();
      await guest.context.close();
    }
  });

  await testCase('another player\'s walking and swinging is visible across the wire', async () => {
    const host = await openGame(browser);
    // The watcher is a phone, so this also covers PC -> mobile animation.
    const phone = await openGame(browser, { mobile: true });

    try {
      await host.page.click('#mode-multi');
      await host.page.fill('#mp-name', 'Walker');
      await host.page.click('#mp-create');
      await host.page.waitForSelector('#mp-lobby-code:not(:empty)');
      const code = (await host.page.textContent('#mp-lobby-code')).trim();

      await phone.page.click('#mode-multi');
      await phone.page.fill('#mp-name', 'Watcher');
      await phone.page.fill('#mp-code', code);
      await phone.page.click('#mp-join');
      await until(phone.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');

      await host.page.click('#mp-start');
      await until(host.page, () => Boolean(window.__voxel?.getSession()), 30000, 'session');
      for (const tab of [host, phone]) {
        await until(tab.page, () => window.__voxel.world.chunks.size > 0, 40000, 'chunks');
      }
      await until(
        phone.page,
        () => window.__voxel.getSession().remotePlayers.all.length,
        25000,
        'the other player',
      );

      // This test is about what crosses the wire, not about the quality ladder.
      // Software rendering here runs at ~20 FPS, which would make AutoQuality
      // strip limbs mid-test on the phone tab and hide what we came to measure;
      // the ladder's own behaviour has a dedicated test above.
      await phone.page.evaluate(() => {
        window.__voxel.autoQuality?.disable();
        window.__voxel.setAnimatedLimbs(true);
      });

      // The watcher must be rendering the walker as a jointed body.
      const rig = await phone.page.evaluate(() => {
        const p = window.__voxel.getSession().remotePlayers.all[0];
        return [...p.rig.segments.keys()];
      });
      assert.ok(rig.includes('legL'), `remote body has no legs to swing: ${rig}`);
      assert.ok(rig.includes('armR'), 'remote body has no tool arm');

      // Walk the host forward for real, and watch the legs on the phone.
      await host.page.evaluate(() => {
        window.__voxel.look.locked = true;
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      });
      const legs = await phone.page.evaluate(async () => {
        const angles = [];
        for (let i = 0; i < 45; i++) {
          const p = window.__voxel.getSession().remotePlayers.all[0];
          const leg = p && p.rig.segments.get('legL');
          if (leg && p.group.visible) angles.push(leg.rotation.x);
          await new Promise((r) => setTimeout(r, 60));
        }
        return { min: Math.min(...angles), max: Math.max(...angles), n: angles.length };
      });
      await host.page.evaluate(() =>
        document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })),
      );
      assert.ok(legs.n > 10, 'the remote body was never visible');
      assert.ok(
        legs.max - legs.min > 0.15,
        `a walking player's legs did not move on the other screen (range ${(legs.max - legs.min).toFixed(3)})`,
      );

      // Now swing, and watch the arm.
      const arm = await Promise.all([
        phone.page.evaluate(async () => {
          const angles = [];
          for (let i = 0; i < 40; i++) {
            const p = window.__voxel.getSession().remotePlayers.all[0];
            const a = p && p.rig.segments.get('armR');
            if (a) angles.push(a.rotation.x);
            await new Promise((r) => setTimeout(r, 50));
          }
          return { min: Math.min(...angles), max: Math.max(...angles) };
        }),
        (async () => {
          // Repeated swings, so at least one lands inside the sampling window.
          for (let i = 0; i < 8; i++) {
            await host.page.evaluate(() => window.__voxel.viewmodel.swing());
            await sleep(220);
          }
        })(),
      ]);
      assert.ok(
        arm[0].max - arm[0].min > 0.5,
        `a swinging player's arm did not move on the other screen (range ${(arm[0].max - arm[0].min).toFixed(3)})`,
      );
    } finally {
      await host.context.close();
      await phone.context.close();
    }
  });

  await testCase('singleplayer still works after a multiplayer session', async () => {
    const { context, page, errors } = await openGame(browser);
    await page.click('#mode-multi');
    await page.click('#mp-back');
    await startSingleplayer(page);
    const chunks = await page.evaluate(() => window.__voxel.world.chunks.size);
    assert.ok(chunks > 4, 'singleplayer must be unaffected by the multiplayer UI');
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    await context.close();
  });
} finally {
  await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} browser tests passed`);
process.exit(failures > 0 ? 1 : 0);
