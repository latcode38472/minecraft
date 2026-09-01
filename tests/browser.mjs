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

    // Aim straight down. The look direction comes from the camera, which the
    // frame loop updates, so give it a frame before mining.
    const at = await page.evaluate(() => {
      const v = window.__voxel;
      const p = v.player.position;
      const at = { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) };
      v.world.setBlock(at.x, at.y, at.z, 3); // dirt: quick to break bare-handed
      v.look.pitch = -Math.PI / 2 + 0.01;
      return at;
    });
    await sleep(300);

    const mined = await page.evaluate((at) => {
      const v = window.__voxel;
      // Count in the simulation, not the view: the view only catches up on the
      // next frame, and these ticks run between frames.
      const before = v.getLocalSim().drops.size;
      // 20 simulated seconds: comfortably past dirt's bare-handed break time.
      for (let i = 0; i < 1200; i++) v.tickInteraction(1 / 60, true, false, 0);
      return {
        before,
        after: v.getLocalSim().drops.size,
        block: v.world.getBlock(at.x, at.y, at.z),
      };
    }, at);

    assert.equal(mined.block, 0, 'the block was not broken');
    assert.ok(mined.after > mined.before, 'breaking a block must drop an item');

    // And the drop must be collectable: standing on it puts it in the bag.
    const collected = await until(
      page,
      () => window.__voxel.inventory.count('dirt'),
      15000,
      'the drop to be collected',
    );
    assert.ok(collected > 0, 'walking over a drop must add it to the inventory');
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

      // A block placed by the phone must appear for the host. setBlock is what
      // the game itself calls; the session forwards local edits automatically.
      const placed = await phone.page.evaluate(() => {
        const v = window.__voxel;
        const p = v.player.position;
        const at = { x: Math.floor(p.x) + 2, y: Math.floor(p.y) + 3, z: Math.floor(p.z) };
        v.world.setBlock(at.x, at.y, at.z, 4); // cobblestone
        return at;
      });
      await until(
        host.page,
        new Function(
          `return window.__voxel.world.getBlock(${placed.x}, ${placed.y}, ${placed.z}) === 4`,
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

      // Stand the taker on the giver, so the thrown stack lands at their feet.
      const at = await host.page.evaluate(() => {
        const p = window.__voxel.player.position;
        return { x: p.x, y: p.y, z: p.z };
      });
      await guest.page.evaluate((pos) => {
        window.__voxel.player.position.set(pos.x, pos.y, pos.z);
      }, at);

      const beforeCount = await guest.page.evaluate(() => window.__voxel.inventory.count('diamond'));
      await host.page.evaluate(() => {
        window.__voxel.inventory.add('diamond', 3);
        window.__voxel.inventory.selectSlot(
          window.__voxel.inventory.slots.findIndex((s) => s && s.id === 'diamond'),
        );
        window.__voxel.dropHeldItem(true);
      });

      // The stack must reach the other player, not bounce back to the thrower.
      const taken = await until(
        guest.page,
        () => window.__voxel.inventory.count('diamond'),
        20000,
        'the item to change hands',
      );
      assert.ok(taken > beforeCount, 'the receiving player never got the item');

      const keptByThrower = await host.page.evaluate(() =>
        window.__voxel.inventory.count('diamond'),
      );
      assert.equal(keptByThrower, 0, 'the thrower must not still hold what they threw');
    } finally {
      await host.context.close();
      await guest.context.close();
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
