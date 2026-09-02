# Voxelcraft

A playable Minecraft-like voxel sandbox in the browser. TypeScript + Three.js +
Vite, no image or audio assets — textures and sounds are generated at runtime.

## Run it

**Singleplayer only** — one command:

```sh
npm install
npm run dev          # game client, http://localhost:5173
```

**With multiplayer** — the game client and the multiplayer server are two
processes. Either run both at once:

```sh
npm run dev:all      # starts both, and prints the address to open on a phone
```

…or run them in separate terminals:

```sh
npm run server       # multiplayer WebSocket server, port 8787
npm run dev          # game client, port 5173
```

| Command | What it starts |
| --- | --- |
| `npm run dev` | the game client (Vite), bound to all interfaces |
| `npm run server` | the multiplayer server (Node, port 8787) |
| `npm run dev:all` | both, with the LAN URL printed for phones |
| `npm run build` | typecheck + production build |
| `npm run preview` | serve the production build |
| `npm test` | simulation, protocol and multiplayer tests |
| `npm run test:browser` | end-to-end tests in real browser tabs |

To put the game online for friends, see
[Playing with a friend who isn't on your Wi-Fi](#playing-with-a-friend-who-isnt-on-your-wi-fi).

Production build: `npm run build`, serve with `npm run preview`. The server has
no build step — Node runs the TypeScript directly.

### Tests

`npm test` needs nothing running: it drives the shared simulation headlessly and
spawns its own multiplayer server on port 8899 for the integration tests.

`npm run test:browser` drives real Chromium tabs — including a simulated phone —
through singleplayer and a full three-player room, so it needs the built client
and a server first:

```sh
npm run build
npm run server &     # port 8787
npm run preview &    # port 4173
npm run test:browser
```

It needs Playwright (`npm i -D playwright && npx playwright install chromium`);
without it the suite says so and exits successfully rather than failing.

## Controls

### Desktop

| Input | Action |
| --- | --- |
| Click | capture mouse (Esc releases) |
| W A S D | move |
| Mouse | look |
| Ctrl (hold) or double-tap W | sprint — 1.3x speed, more food |
| Space | jump / swim up |
| Shift | sneak / swim down |
| Left click (hold) | mine the targeted block / attack a mob |
| Right click | place block, eat food, open a crafting table, furnace or chest |
| Right click (bed, at night) | sleep; when everyone is in bed the night is skipped |
| Right click (hoe) | till dirt or grass into farmland; then right click with seeds to plant |
| Right click (shears, on a sheep) | shear it for wool |
| Shift + right click | place a block against a chest/table instead of opening it |
| E | inventory & crafting (2×2 grid; a crafting table gives 3×3) |
| 1–9 / mouse wheel | select hotbar slot |
| Q | drop one of the held item |
| Ctrl+Q | drop the whole stack |
| Right click (bow) | hold to draw, release to fire |
| Right click (shield) | hold to block |
| `[` / `]` | decrease / increase view distance |
| F3 | debug overlay |

In the inventory screen: left click picks a stack up onto the cursor and puts
it down, right click takes half or puts one, shift-click quick-moves (into a
chest or furnace, onto the armour slots, between hotbar and bag). The recipe
book on the right lays a recipe out on the grid from your bag; click the result
slot to take one, shift-click it to craft as many as the grid allows.

### Mobile / touch

Touch devices get Pocket-Edition-style controls automatically (best in
landscape):

| Input | Action |
| --- | --- |
| Left pad | move (analog) |
| Left pad, pushed to the edge | sprint |
| Drag anywhere else | look |
| Hold | mine the targeted block / attack a mob |
| Tap | place block, eat food, use a table / furnace / chest / bed, till, plant, shear |
| Tap a slot (inventory) | pick up / put down; hold a slot to take half |
| Hold with a bow | draw; release to fire |
| Hold with a shield | raise it to block |
| ▲ button | jump / swim up (hold) |
| ▼ button | sneak / swim down (toggle) |
| Tap hotbar | select item |
| Hold hotbar slot | drop that stack (hand it to another player) |
| ☰ button | inventory & crafting |
| ❚❚ button | pause / show menu |

Touch defaults to a 4-chunk view distance for phone GPUs. Detection uses the
primary-pointer media query, so touchscreen laptops keep the desktop scheme;
append `?touch=1` to force touch controls on any device.

**Adaptive quality (touch only):** the game watches its real frame rate and
walks a quality ladder automatically — lowering render resolution first
(100% → 80% → 66%), then view distance — whenever FPS stays under 45, and
stepping back up after a sustained smooth stretch. Weak or hot phones settle
at whatever their hardware can hold instead of lagging. Touch devices also
use smaller per-frame chunk generation/meshing budgets so world streaming
never causes visible hitches. A device without WebGL 2 gets a clear message
instead of a black screen.

**Animation and the draw-call budget.** Limbs can only move if the body is more
than one mesh, so an animated body costs more draw calls than a rigid one:

| Body | Meshes animated | Meshes merged |
| --- | --- | --- |
| Zombie | 4 (body, both arms together, each leg) | 1 |
| Skeleton | 4, plus 2 for the bow it carries | 1, plus the bow |
| Pig, cow, sheep | 4 (body, head, two diagonal leg pairs) | 1 |
| Villager | 4 (body with folded arms, head, each leg) | 1 |
| Player | 6 (head, torso, two arms, two legs) | 1 |

With the caps in place — 28 mobs and 2 other players — that is at most ~124
draw calls animated against ~26 merged. Both are small next to the few hundred
the terrain costs, so limb animation is on everywhere by default. It is only
traded away at the *bottom* of the quality ladder, below resolution and view
distance, because a world of sliding statues is a worse loss than a slightly
blurrier one. Bodies are rebuilt in place when it flips, keeping their
interpolation state, so nothing pops or teleports. Turning it off also drops
the first-person hand's render pass.

URL parameters: `?seed=12345` starts a specific singleplayer world (a new seed
wipes saved edits), `?reset` wipes the save entirely, `?touch=1` forces touch
controls, `?server=host:port` points multiplayer at a specific server.

## Multiplayer

Up to **3 players** per room — one host and two guests — with full PC/mobile
cross-play. Pick **Multiplayer** on the start screen and enter a name. The
panel lists **your worlds**: every world you have hosted or visited on this
server, with its host, how many people are in it and whether it is open right
now or saved. **Join** an open one straight away, or **Open** a saved one
(only its owner can). **Create** makes a new world (name optional) and gives
you a 6-character code like `F7K2Q9` to share; friends type it in and **Join**.

Worlds are saved on the server: block edits, chests and furnaces, mobs,
dropped items and the clock, plus every player's inventory, armour, health,
hunger and position under a stable per-browser key. Leave and come back — even
after the server restarted — and you carry on where you left off. If the host
leaves, the world keeps running and another player becomes host; the owner
takes the chair back when they return.

### Playing from your phone

1. Start both processes on your computer: `npm run dev:all`
2. It prints a LAN address, e.g. `http://192.168.1.20:5173`
3. Open that address in your phone's browser, on the same Wi-Fi

The phone finds the multiplayer server automatically: the client defaults to
`ws://<the host you loaded the page from>:8787`, so nothing is hardcoded to
localhost. To point at a different server without rebuilding, append
`?server=192.168.1.20:8787`.

### Playing with a friend who isn't on your Wi-Fi

The game is two things: a **static site** (the client) and a **long-running
WebSocket process** (the multiplayer server). A friend across the internet needs
both reachable. Three ways, fastest first.

**1. A tunnel — a couple of minutes, no accounts.** Run both locally, then
expose the two ports:

```sh
npm run dev:all                                   # client :5173, server :8787
cloudflared tunnel --url http://localhost:8787    # prints https://<a>.trycloudflare.com
cloudflared tunnel --url http://localhost:5173    # prints https://<b>.trycloudflare.com
```

Send your friend `https://<b>.trycloudflare.com/?server=wss://<a>.trycloudflare.com`.
Both links die when you close the terminal, and the game only runs while your
machine is on — fine for one evening.

**2. A permanent link.** The repo ships the config for this:

| File | What it does |
| --- | --- |
| `.github/workflows/deploy.yml` | tests, builds and publishes the client to GitHub Pages |
| `Dockerfile` | runs the multiplayer server (no build step — Node runs the TS) |
| `render.yaml` | one-click Render blueprint for that server, free tier |

1. **Server** — on [render.com](https://render.com): New → Blueprint → pick this
   repo. It reads `render.yaml` and gives you `https://voxelcraft-server-xxxx.onrender.com`.
2. **Client** — Settings → Secrets and variables → Actions → Variables → New
   variable named `MULTIPLAYER_URL`, set to your server's URL with `https`
   swapped for `wss` (`wss://voxelcraft-server-xxxx.onrender.com`). The
   workflow enables Pages itself, so there is nothing to switch on by hand.

   **The repository must be public**, unless you are on a paid GitHub plan:
   Pages is not available for private repos on the free tier, and the deploy
   fails with a bare `Not Found`. If you want to keep the code private, host
   the client on Netlify, Vercel or Cloudflare Pages instead — all three build
   private repos free. Point them at `npm run build`, publish `dist`, and set
   `VITE_MULTIPLAYER_URL` in their environment settings.
3. Push to `main` (or run the workflow by hand). Your link is
   `https://<your-username>.github.io/minecraft/`.

Share that one link. Multiplayer is baked in, so nobody needs a `?server=`
parameter.

**3. Any other host.** The server is a plain Node process that reads `PORT` and
`HOST`, so anything that runs a container works — Fly.io, Railway, a VPS. Point
the client at it with `VITE_MULTIPLAYER_URL` at build time, or per-visit with
`?server=wss://host`.

Two things that will bite you:

- **`wss://`, not `ws://`.** A page served over HTTPS cannot open a plaintext
  WebSocket; browsers block it silently-ish and the game just says it cannot
  reach the server. Any host that terminates TLS for you (Render, Fly) gives you
  `wss://` for free.
- **Free tiers sleep.** Render's free instance idles out after ~15 minutes and
  takes a few seconds to wake, so the first join after a quiet spell may fail.
  Try again and it connects. `GET /health` returns room and player counts, and
  is also what wakes it.
- **Free tiers forget.** Saved worlds are JSON files under `VOXEL_DATA_DIR`
  (default `data/worlds`). Render's free disk is wiped on every deploy and
  restart, so worlds survive a quiet spell but not a redeploy; attach a
  persistent disk and point `VOXEL_DATA_DIR` at it to keep them for good.

### What is synchronised

| Synchronised | Not synchronised |
| --- | --- |
| Player position, yaw, pitch, held item, and movement/jump/sneak/sprint/swing/use/hurt/dead/sleeping flags | Fall, drowning and starvation damage are computed on the client that suffers them (reported, clamped) |
| Knockback, with the strength derived server-side from the attacker's hand | |
| Joins, leaves, display names, room roster, host changes | |
| Block breaks and placements (server-authoritative, reach- and item-checked) | |
| Inventories, armour, the crafting grid and cursor (server-authoritative) | |
| Chests and furnaces: contents, fuel and smelting progress | |
| Crops growing, furnaces lighting, tilled soil | |
| Player health, hunger and death; death drops | |
| Eating and sleeping; the night skip | |
| Worn armour, drawn on other players' bodies | |
| PvP damage from melee and arrows | |
| Mobs — position, health, death, swings, bow draw, grazing, looking around, wool | |
| Arrows fired by mobs, simulated server-side | |
| Dropped items, including who is allowed to pick one up | |
| Mob loot, awarded to whoever landed the killing blow | |
| Time of day: the server owns the clock | |
| Arrows fired by any player, latency-compensated | |

**Authority.** The server owns the world. It runs the same `RoomSimulation` the
singleplayer client runs, over the same `TerrainGenerator`, so it knows what the
ground looks like and can collide mobs against it. Mobs, dropped items,
containers, crops, beds and the day/night clock all live there and are
broadcast as one `world_state` snapshot ten times a second, which clients
interpolate. No client — host included — simulates a mob in a room, so nothing
depends on one player's browser tab staying awake, and everyone sees the same
creatures in the same places.

The server owns every inventory too. Clicks in the inventory screen are applied
locally at once as a prediction and sent with a sequence number; the server
replays the same slot code (`items/containers.ts`) on its own copy and replies
with the inventory it now holds, which the client adopts once the reply has
caught up with its last click. Block drops, mob loot, crafting results, smelted
output, eaten food and thrown items all come from the server's copy, so a
modified client cannot give itself anything.

The server arbitrates damage too: it knows every player's last reported position
and rejects a hit thrown from beyond melee/arrow range, so a modified client
cannot snipe across the map. Damage values are clamped, not trusted. Block edits
are checked for reach and for the item in hand; a rejected edit is reverted on
the sender's screen.

**Item handoff.** There is no trade window, exactly as in vanilla: you throw the
item on the ground with **Q** (**Ctrl+Q** for the whole stack; hold a hotbar slot
on touch) and the other player walks over it. The drop is a real entity in the
shared world. The server decides who collects it, so two players reaching for the
same stack can never both get it, and a thrown item is out of its thrower's reach
for two seconds so it does not snap straight back.

## What's in the game

**World**
- Chunk-based world (16×72×16 columns), streamed in/out around the player
- Seeded terrain: continents/oceans, plains, hills, mountains, beaches, valleys,
  and cave systems carved by 3D noise (~6% of underground volume)
- Ore generation by depth: coal, then iron, gold, and diamond deepest and rarest
- 34 block types including gravel, bricks, glass, wool, hay, farmland, paths,
  crops, beds, chests, crafting tables and (lit) furnaces; slabs and crop
  sprites are meshed as partial blocks
- Trees, water, day/night cycle driving sun, sky and fog
- **Villages**: a well, four dirt paths, four to seven houses (cobblestone
  floors, plank walls, log corners, glass windows, a bed, a chest stocked from
  a seeded loot table, a crafting table or furnace) and up to three fenced
  farms with a water channel and growing wheat or carrots. Laid out once per
  144-block cell from the seed, so every player and every reload sees the same
  village; villagers spawn by day, wander near home, look at you when you walk
  up, and run from zombies

**Survival and combat**
- 20 health, 20 hunger. Hunger drains slowly with time (a full bar lasts about
  95 minutes idle) and a little with every block walked, more when swimming,
  plus a small cost per jump, swing and block broken — all in `constants.ts`.
  Above 18 it slowly regenerates health; at zero it starves you
- **Food**: apples from leaves, bread from wheat, carrots, and meat — pork,
  beef and mutton, raw or cooked in a furnace (cooked restores more). Village
  chests hold a starter kit. Farming: till dirt or grass with a hoe, plant
  seeds or carrots, wait; crops grow through four stages near a player
- **Beds**: craft one from wool and planks (or use a villager's). Sleeping is
  only possible at night; in a room every living player must be in bed, then
  the night is skipped for everyone and the bed becomes your respawn point.
  Dying, leaving, a broken bed or a mob's hit gets you up
- Fall damage, mob damage with knockback and invulnerability frames
- **Death drops** everything you carried — inventory, armour, cursor — where
  you fell, once, with tool wear intact; respawn comes with an empty bag
- **Drowning**: fifteen seconds of air underwater, shown as ten bubbles above
  the food bar that burst one at a time. When they run out you lose a heart a
  second until you surface or die — armour and shields do not help. Coming up
  refills the bar about four times faster than it drained
- Death screen and respawn at your spawn point (or your bed), naming what killed you
- Passive pigs, cows and sheep in small herds on grass, villagers in villages,
  hostile zombies and skeletons at night; all take damage, die with a keel-over
  animation and drop from a loot table (`shared/loot.ts`)
- **Animals** stroll, stand, look around, and (cows and sheep) put their head
  down to graze; a hit sends them running. **Sheep** come in several fleece
  colours; shears take the wool, which grows back in four minutes, and a
  fleeced sheep drops wool on top of its mutton
- **Zombies** chase the nearest player and swing in melee
- **Skeletons** are archers: they hold you at 5–11 blocks, strafe rather than
  stand, need line of sight, and spend a visible second drawing the bow before
  every shot — that draw is your cue to dodge or break cover. They aim with a
  real ballistic solution (plus a little spread), so the arc is right at any
  range, and they drop bones and arrows
- **Sprinting**: hold Ctrl or double-tap forward (on touch, push the stick to
  its edge) to run at 1.3x walking speed. The view widens a little, other
  players see the longer stride, and it costs about four times the food per
  second — roughly seven minutes of solid running on a full bar against
  twenty-four of walking. Below 6 hunger you cannot sprint at all
- **Melee**: swords, axes and pickaxes in four tiers, each with its own damage
  and attack cooldown; bare fists do 1
- **Knockback**: every way of dealing damage shoves what it hits by its own
  amount, from a pair of shears at half a block to a diamond axe at just over
  one. Heavier, slower weapons push hardest — an axe further than a sword of
  the same tier, a sword further than a pickaxe — and arrows and a zombie's
  punch have their own. The shove decays rather than being cancelled, so a hit
  interrupts and separates without launching anything: `strength / drag` is
  the distance, and it is capped. In multiplayer the server looks the strength
  up from its own copy of the attacker's hand, so it cannot be forged
- **Bow and arrows**: hold to draw (a charge bar fills), release to fire.
  Damage and speed scale with draw; arrows are swept against the voxel grid so
  they cannot tunnel through walls, and they hit mobs and players
- **Armour**: leather, iron and diamond in four slots (head/chest/legs/feet).
  Each point removes 4% damage, capped at 80%; pieces wear out and break
- **Shield**: hold use to raise it — absorbs 66% of a hit and slows you down
- **PvP**: in multiplayer you can hit other players with melee or arrows.
  Worn armour is drawn on other players' bodies, and a small health bar appears
  under their name once they are hurt

**Animation**
- **First-person hand**: the held tool, block or bare hand is drawn in front of
  the camera, sways as you walk, breathes when you stand still, lags behind a
  jump and dips when you land, draws back as a bow charges, and comes up to
  guard when a shield is raised
- **Strokes**: what you are doing decides how the hand moves. Mining winds the
  tool up over your shoulder and drives it down into the block, with a shudder
  at the moment of contact, looping seamlessly for as long as you hold the
  button. A sword sweeps across the view and rolls over as it goes; a pickaxe
  or axe chops; a fist, a block or an apple goes straight out. Placing a block
  is a shorter shove, and eating brings the food up to your mouth and wobbles
  it there. Every swing is asymmetric — out fast, back slowly — because a
  symmetrical one reads as a wave rather than a blow
- **Item swap**: changing what you hold lowers the old item out of frame and
  raises the new one back in, with the model exchanged at the bottom of the dip
  so the change itself is never seen
- **Block cracks**: ten damage stages spread across the block you are mining,
  chosen from the same 0..1 progress the HUD bar uses
- **Walking**: players and mobs have jointed limbs. Arms and legs counter-swing,
  four-legged animals move on diagonal pairs, and the gait is driven by
  distance travelled rather than by time, so it stays in step at any frame rate
- **Idle life**: animals and villagers turn their heads to look around, grazers
  lower them to eat; both ease in and out rather than snapping
- **Attacks and states**: swings, using an item (arm held out), the red hurt
  flash, keeling over on death and lying down in bed are all visible on other
  players and on mobs, not just felt — each crosses the wire as a flag bit
- **Aiming**: a skeleton raises its bow and pulls the string back as it draws,
  then looses; the draw is a 0..1 level on the wire so every client sees the
  same shot building
- On touch devices the quality ladder can trade limb animation for draw calls;
  see **Performance on phones**

**Items and building**
- Mining takes time based on block hardness and the tool you hold; the wrong
  tool tier means no drop at all (stone without a pickaxe drops nothing)
- Broken blocks and dead mobs drop collectable item entities; ripe crops drop
  their harvest plus seeds, leaves occasionally drop an apple
- 36-slot inventory with a 9-slot hotbar, stacking, and tool durability
- **Grid crafting**: a 2×2 grid in your pocket, 3×3 at a crafting table.
  Shaped and shapeless recipes from one registry (`items/crafting.ts`),
  matched anywhere on the grid and mirrored: planks, sticks, tables, chests,
  furnaces, beds, bread, hay, shears, bows, arrows, shields, tools and hoes
  in four tiers, armour in three
- **Furnaces** with input, fuel and output slots, a fuel registry (coal smelts
  eight items, planks one and a half, sticks half), burn time and progress
  bars, and a lit block while the fire is going — they keep working while
  nobody is looking, and across saves
- **Chests** with 27 slots; contents live in the simulation, so in a room
  everyone sees the same chest
- Persistence in IndexedDB: seed, player state, inventory, health/hunger,
  per-chunk edit diffs, and the simulation's state — chests, furnaces, mobs,
  dropped items and the clock — validated field by field on the way back in

## Architecture

```
src/
  constants.ts       all tunables (chunk size, gravity, reach, combat, hunger...)
  blocks.ts          block registry: tiles, hardness, tool + tier, drops
  textures.ts        procedural atlas: block tiles, item icons, crack stages
  input.ts           keyboard/wheel state, discrete press queue
  raycast.ts         Amanatides & Woo voxel DDA
  audio.ts           WebAudio generated sound effects
  sky.ts             day/night: sun/ambient lights, sky+fog colour keyframes
  save.ts            IndexedDB store (meta, sim state, per-chunk edit diffs)
  items/
    items.ts         item registry: blocks, materials, food, tools, weapons
    inventory.ts     slots, stacking, durability, serialisation
    crafting.ts      recipe registry (shaped + shapeless) and grid matching
    smelting.ts      fuel and smelting registries
    containers.ts    slot clicks, quick-move, grid crafting, chest/furnace slots
  shared/            runs identically in the browser and in Node
    voxel.ts         AABB-vs-voxel collision and ray/box tests, no THREE
    combat.ts        knockback: strength per damage source, decay and distance
    mobs.ts          mob registry: stats, shapes, loot and spawn rules
    loot.ts          loot tables (mobs, shears, village chests), seeded rolls
    harvest.ts       break time, tool tiers, what a block drops
    save.ts          save schema + validation for worlds, players, sim state
    mobsim.ts        mob behaviour (chase, shoot, wander/graze/flee), drops, arrows
    roomsim.ts       the world simulation: mobs, drops, containers, crops, beds, clock
  entities/
    entity.ts        Entity base: gravity, buoyancy, voxel collision
    arrow.ts         swept projectile: reports block, mob and player hits
    models.ts        box models as jointed rigs (or one merged mesh), + posing
    manager.ts       lifecycle for client-side entities (arrows)
  game/
    interaction.ts   mining, placing, attacking, eating, tilling, shearing, using blocks
    inventoryctl.ts  the inventory as the game acts on it; predicts, server corrects
    worldview.ts     renders mobs and drops from simulation snapshots
    handpose.ts      pure pose maths for the hand: strike curves, sway, swap
    viewmodel.ts     builds the held model and applies the pose to it
    breakoverlay.ts  the crack stages on the block being mined
  net/
    protocol.ts      wire types, limits and validators (shared with the server)
    identity.ts      the stable per-browser player key
    config.ts        WebSocket URL resolution (query > env > same-host)
    client.ts        socket lifecycle, reconnect backoff, ping/RTT
    session.ts       roster, state throttling, inventory/container/sleep replies
    remoteplayers.ts remote bodies, name labels, snapshot interpolation, states
server/
  index.ts           authoritative room server (rooms, inventories, containers, saves)
  store.ts           world files on disk: atomic writes, backups, validation
  world.ts           server-side terrain + chunk cache with eviction
tests/
  simulation.test.ts headless: terrain, mobs, loot, drops, memory bounds
  gameplay.test.ts   clicks, grid crafting, furnaces, chests, crops, beds, saves, villages
  combat.test.ts     knockback per weapon, how far it really moves a mob, sprint costs
  protocol.test.ts   every sanitiser, from an attacker's point of view
  animation.test.ts  rigs, gait, hand strokes, crack stages, the snapshot clock
  survival.test.ts   health, breath, drowning, and what the death screen says
  multiplayer.test.ts a real server driven by real WebSocket clients
  browser.mjs        real Chromium tabs, including a simulated phone
  world/
    chunk.ts         flat Uint8Array voxel storage per 16x72x16 column
    noise.ts         seeded value noise + fBm
    terrain.ts       heightmap layers, biome-ish masks, deterministic trees, villages
    village.ts       village layout (well, paths, houses, farms) and placement
    world.ts         chunk map, streaming, edit tracking, remesh queue
    mesher.ts        culled face meshing with baked AO; cubes, slabs, crop sprites
  player/
    camera.ts        pointer-lock yaw/pitch
    player.ts        movement intent, water state, fall tracking
    survival.ts      health, hunger, breath, regen, starvation, drowning, death
  ui/
    hud.ts           hotbar bound to the inventory, FPS, debug, toasts
    statusui.ts      hearts, hunger, air bubbles, mining progress, death screen
    inventoryui.ts   inventory grid and recipe list
    multiplayerui.ts start menu, create/join, lobby, in-game MP HUD
    touch.ts         virtual joystick, look/tap/hold gestures, buttons
  main.ts            bootstrapping and the frame loop
```

**Chunks.** The world is a `Map<"cx,cz", Chunk>`; each chunk is one flat
`Uint8Array` of block ids covering the full world height, so a chunk is data
only — no scene-graph cost until meshed. Every frame the world generates a few
missing chunks nearest the player (ring by ring, capped per frame) and unloads
chunks beyond view distance + padding. Player edits are stored as sparse
per-chunk diffs (`voxelIndex -> blockId`) on top of deterministic terrain, so
saves stay tiny and unloaded chunks can be regenerated and re-patched exactly.

**Meshing.** Culled face meshing: for each solid voxel, a quad is emitted only
for faces that touch a non-opaque block, so interior geometry costs nothing.
Each vertex bakes `directional face shade × ambient occlusion` into a vertex
colour; AO uses the classic 3-neighbour corner test, and each quad's diagonal
is flipped to match its AO gradient to avoid interpolation artifacts. Water
goes into a second transparent mesh with its surface lowered slightly where
exposed to air. One draw call per chunk per material; remeshing is queued and
processed nearest-first under a per-frame time budget (edits near the player
remesh the same frame, so interaction feels instant). Neighbour chunks are
re-queued when a border block changes so culling/AO stays correct across seams.

**Raycast.** Targeting uses the Amanatides & Woo DDA: starting from the camera
voxel, repeatedly step across whichever axis boundary is nearest along the
ray. Every voxel on the ray is visited exactly once (no skipped corners), and
the axis of the last step gives the hit face's normal — which is where a
placed block goes.

**Physics.** Bodies are AABBs moved one axis at a time (`shared/voxel.ts`);
after each axis move, any overlapped solid voxel clamps the position back to the
voxel face and zeroes that velocity component. Movement is integrated in
substeps small enough that no step exceeds 0.4 blocks, which rules out
tunnelling at any frame rate. Unloaded chunks read as solid so nothing falls
through terrain that hasn't streamed in yet.

That module is deliberately free of THREE and the DOM: positions are plain
`{x, y, z}`, which `THREE.Vector3` structurally satisfies, so the browser passes
its vectors straight in and Node runs the identical code. That is what lets the
server simulate mobs against real terrain rather than trusting a client to.

**One simulation, two homes.** `shared/roomsim.ts` is the only implementation of
mob and item behaviour. The multiplayer server constructs one per room over a
`ServerWorld`; a singleplayer client constructs one over its own streaming
`World`. Both satisfy the same small `SimWorld` interface (block lookups plus a
surface probe), and `game/worldview.ts` draws the result either way —
interpolating snapshots in multiplayer, rendering directly in singleplayer.
Singleplayer is therefore not a separate code path that can drift; it is the
same game with the network hop removed.

**Bounded server memory.** `ServerWorld` generates chunks on demand around the
players and evicts them behind (4-chunk keep radius, 400-chunk hard cap), so a
room's footprint stays flat however far anyone walks — a test walks 2,400 blocks
and asserts the cache never grows past the cap.

**Item icons.** Sprites are character maps — 16x16 for tools and weapons, 8x8
upscaled for simpler things — but the polish is generated, not drawn. Every
sprite gets an automatic outline (each transparent pixel touching the shape
takes a darkened copy of its neighbour's colour) and edge relief (upper-left
boundaries lighten, lower-right darken). That is what makes an icon read
against both a bright hotbar and a night sky, and it applies to every sprite
added later without anyone having to remember to draw a border.

**Caves.** Two independent 3D noise fields are each thresholded into a thin
shell (`|noise - 0.5| < t`); a voxel is carved only where *both* shells overlap,
which yields connected tunnels instead of the disconnected blobs a single
threshold gives. The threshold is the measured 5th percentile of that metric
(`TerrainGenerator.caveMetric` is public precisely so it can be re-measured),
so ~6% of underground volume becomes cave. Sea floors are left sealed because
water here is static and would not flow into an opened cavern.

**Mining.** Break time is `hardness × (harvestable ? 1.5 : 5) / toolSpeed`.
Holding the right tool class speeds a block up; holding one of insufficient
*tier* still breaks it but forfeits the drop — so stone mined by hand yields
nothing, exactly like Minecraft. Progress resets whenever the crosshair moves
to a different voxel.

**Mobs.** Each mob type's body is a handful of boxes merged into a single
cached `BufferGeometry` with baked vertex colours, so a mob costs one draw call
and all instances of a type share one buffer. AI is a per-frame `update` on a
`Mob` subclass: zombies chase and attack inside a detection radius, pigs wander
and flee. Attacks use a slab-method ray/AABB test against mob boxes, and a mob
in front of the targeted block takes the hit instead of the block.

**Multiplayer.** A Node WebSocket server is authoritative: it owns room
membership, the world seed, and the canonical set of block edits. Clients never
talk to each other, so there is no port forwarding, no NAT traversal, and no
browser tab acting as a server — a phone on cellular and a PC on Wi-Fi both just
dial the same host. The 3-player cap is enforced server-side on every join, so a
crafted packet cannot squeeze a fourth player in.

*World state* rides on the existing `World.edits` map, which was already
`Map<chunkKey, Map<voxelIndex, blockId>>` — exactly the shape the network needs.
The server keeps the same structure, so terrain is never transmitted: clients
generate it from the shared seed and receive only the diffs. A joining client
gets the room's existing edits in batched `chunk_edits` messages, and requests
edits per chunk as it streams new terrain in, so chunk unloading and the
effectively unbounded world both survive multiplayer untouched. Remote edits are
applied through `World.applyRemoteEdit`, which records the diff even for chunks
that are not loaded — `createChunk` replays it if the player ever walks there.

*Players* send state at 15 Hz, and only when something actually changed. Remote
players are rendered ~120 ms in the past and interpolated between the two
snapshots straddling that moment, so movement stays smooth at 60+ FPS and never
teleports between packets. Your own movement is applied locally the instant you
press a key or touch the joystick — nothing waits for a round trip.

Everything that arrives on the wire is timestamped with `receiveClock()`
(`net/protocol.ts`), which is the *same* clock the frame loop interpolates
against. This matters more than it looks: `Date.now()` and `performance.now()`
differ by about 1.7×10¹², so stamping with one and comparing against the other
means no snapshot is ever "old enough" to render. Bodies then silently fall back
to the oldest sample in the buffer — over a second stale, with no smoothing —
while still appearing to move, which is exactly the kind of bug that survives a
casual playtest. One function, used on both sides, removes the choice.

*Remote animation* rides the same snapshots rather than adding traffic. A walk
cycle is derived from how far a body actually moved on screen between frames, so
nothing about the gait is transmitted; a swing is a single flag bit. The
receiver replays a stroke whenever that bit is up and the last stroke has
finished, rather than edge-triggering on it — at 15 Hz a player mining
continuously holds the bit up with only millisecond gaps, and edge-triggering
would show one swing and then a frozen arm for the rest of the dig.

*Cross-play* falls out of the input design: both control schemes already funnel
into the same camera yaw/pitch and the same `MoveInput`, so the network layer
reads that shared state and never touches a keyboard, mouse or touch API. The
protocol is identical on both platforms.

## Current limitations

- Water is static (no flow simulation); placing/removing blocks doesn't make
  water spread.
- No per-voxel light propagation — lighting is sun + ambient + baked AO, so
  caves aren't dark inside and torches don't exist yet. Hostile spawning is
  gated on time of day rather than light level for the same reason.
- Mobs other than villagers still despawn past 72 blocks and drops after 5
  minutes; what is alive at save time is saved (mobs and drops up to a cap of
  256 each).
- Mob AI has no pathfinding — zombies walk straight at you and hop one-block
  ledges, so they get stuck on complex terrain. Hook: `MobSim.update`.
- Animation is procedural posing, not keyframes: bodies walk, swing, aim, use,
  look around, graze, flash when hurt, keel over and lie in bed, but there is
  no jump, fall, sneak or swim animation, and the first-person hand shows the
  item without an arm behind it. Hook: more cases in `Rig.pose` and
  `Viewmodel.update`, which already receive everything they would need.
- Villages are one style on one terrain function: no biomes, no village
  variants beyond layout, and a house on a steep slope is levelled into it
  rather than terraced. Villagers wander, greet and flee but do not trade.
- The recipe book fills the grid with a burst of ordinary slot clicks (up to
  three per cell), which is what keeps the server free of recipe knowledge;
  on a very slow connection the grid visibly fills in over a moment.
- Mob arrows are simulated server-side while *player* arrows stay client-side
  (latency-compensated on the shooter's machine, hits reported). Two systems
  for one concept; unifying them means moving player arrows into
  `RoomSimulation` and giving up the local prediction that makes a bow feel
  responsive. Hook: `ArrowSim` already models everything a player arrow needs.
- Culled meshing, not greedy merging; fine at default view distance.
  TODO hook: `buildChunkGeometry` in `world/mesher.ts`.
- Chunk generation/meshing runs on the main thread under a time budget.
  TODO hook: move `buildChunkGeometry` + `TerrainGenerator.generate` behind a
  worker boundary (both are already pure functions of chunk data).
- Inventory is click-to-pick-up/click-to-place rather than true drag-and-drop.
  Dropping works from the hotbar (Q / Ctrl+Q, or hold a slot on touch) but not
  from a backpack slot while the inventory screen is open.
- No shovels yet — `ToolKind` already includes `'shovel'` as the extension
  point.
- Only the shooter's client reports arrow hits, so damage is never
  double-applied. Remote arrows are spawned with the elapsed network time
  replayed, so they appear where they actually are rather than trailing the
  shot — but a hit still registers on the shooter's view of the world, so at
  high latency a very near-miss can differ between screens.
- **Multiplayer:** health lost to falls, drowning and starvation is computed
  on the client that suffers it and reported (clamped) — mob and PvP damage,
  eating and sleeping are the server's. A modified client could therefore
  refuse to fall.
- **Multiplayer:** the world list only shows worlds you have hosted or been
  in; there is no public server browser, and a saved world can only be
  reopened by the player key that created it — clear your browser storage and
  you lose that key.
- **Multiplayer:** saved worlds live on the server's disk (see *Free tiers
  forget* above); there is no export or import of a world file yet.

## Next 5 features (priority order)

1. **Per-voxel lighting** — flood-fill sunlight + block light stored per voxel
   and sampled in the mesher. Unlocks dark caves, torches, and light-based
   hostile spawning, all of which the current systems are stubbed for.
   Hook: add a light array to `Chunk`, sample it in `emitFace`.
2. **Web worker meshing/generation** — moves the remaining frame hitches off
   the main thread; `mesher.ts`/`terrain.ts` are already pure functions.
3. **Villager trading** — villagers already have homes, a greeting and a loot
   registry; a trade screen is the chest UI with two slots and a table of
   offers. Hook: `use_on_mob` in the protocol and `InventoryUi`'s container
   section.
4. **Biomes and village variants** — swap the single terrain function for a
   biome table (desert, forest, snow) and give `village.ts` a palette per
   biome; the chunk pipeline already supports it via `TerrainGenerator.generate`.
5. **World export/import** — a saved world is one validated JSON document
   (`shared/save.ts`), so downloading it from the server and uploading it
   again, or moving a singleplayer world into a room, is a small UI over the
   store that already exists.
