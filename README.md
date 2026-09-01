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

Production build: `npm run build`, serve with `npm run preview`. The server has
no build step — Node runs the TypeScript directly.

## Controls

### Desktop

| Input | Action |
| --- | --- |
| Click | capture mouse (Esc releases) |
| W A S D | move |
| Mouse | look |
| Space | jump / swim up |
| Shift | sneak / swim down |
| Left click (hold) | mine the targeted block / attack a mob |
| Right click | place block, eat food, use a crafting table or furnace |
| E | inventory & crafting |
| 1–9 / mouse wheel | select hotbar slot |
| Right click (bow) | hold to draw, release to fire |
| Right click (shield) | hold to block |
| `[` / `]` | decrease / increase view distance |
| T | skip time forward (test day/night) |
| F3 | debug overlay |

### Mobile / touch

Touch devices get Pocket-Edition-style controls automatically (best in
landscape):

| Input | Action |
| --- | --- |
| Left pad | move (analog) |
| Drag anywhere else | look |
| Hold | mine the targeted block / attack a mob |
| Tap | place block, eat food, use a crafting table or furnace |
| Hold with a bow | draw; release to fire |
| Hold with a shield | raise it to block |
| ▲ button | jump / swim up (hold) |
| ▼ button | sneak / swim down (toggle) |
| Tap hotbar | select item |
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

URL parameters: `?seed=12345` starts a specific singleplayer world (a new seed
wipes saved edits), `?reset` wipes the save entirely, `?touch=1` forces touch
controls, `?server=host:port` points multiplayer at a specific server.

## Multiplayer

Up to **3 players** per room — one host and two guests — with full PC/mobile
cross-play. Pick **Multiplayer** on the start screen, enter a name, then either
**Create Multiplayer World** (you get a 6-character code like `F7K2Q9` to share)
or type a friend's code and **Join**.

### Playing from your phone

1. Start both processes on your computer: `npm run dev:all`
2. It prints a LAN address, e.g. `http://192.168.1.20:5173`
3. Open that address in your phone's browser, on the same Wi-Fi

The phone finds the multiplayer server automatically: the client defaults to
`ws://<the host you loaded the page from>:8787`, so nothing is hardcoded to
localhost. To point at a different server without rebuilding, append
`?server=192.168.1.20:8787`.

### Deploying for internet play

Set `VITE_MULTIPLAYER_URL` at build time and host the server anywhere with a
public address:

```sh
VITE_MULTIPLAYER_URL=wss://voxel.example.com npm run build
PORT=8787 node server/index.ts       # behind a TLS-terminating proxy
```

Serve the page over HTTPS and the socket over `wss://` — browsers block
plaintext `ws://` from an HTTPS page. `GET /health` on the server returns room
and player counts for monitoring.

### What is synchronised

| Synchronised | Not synchronised |
| --- | --- |
| Player position, yaw, pitch, movement/jump/sneak flags | Inventory and hotbar contents |
| Joins, leaves, display names, room roster | Time of day |
| Block breaks and placements (server-authoritative) | Block-break drops (each player collects their own) |
| Player health, hunger and death (server-authoritative) | |
| Worn armour, drawn on other players' bodies | |
| PvP damage from melee and arrows | |
| Mobs, including position, health and death | |
| Mob loot, awarded to whoever landed the killing blow | |
| Arrows fired by any player, latency-compensated | |

**Combat authority.** The server arbitrates player-vs-player damage: it knows
every player's last reported position and rejects a hit thrown from beyond
melee/arrow range, so a modified client cannot snipe across the map. Mobs are
simulated by the **host** — one simulation means everyone agrees who is alive —
and relayed through the server at 10 snapshots a second, which guests
interpolate. A guest's hit on a mob is forwarded to the host, which applies it.

## What's in the game

**World**
- Chunk-based world (16×72×16 columns), streamed in/out around the player
- Seeded terrain: continents/oceans, plains, hills, mountains, beaches, valleys,
  and cave systems carved by 3D noise (~6% of underground volume)
- Ore generation by depth: coal, then iron, gold, and diamond deepest and rarest
- 20 block types including gravel, bricks, glass, crafting table and furnace
- Trees, water, day/night cycle driving sun, sky and fog

**Survival and combat**
- 20 health, 20 hunger; hunger drains with time and distance, regenerates health
  when full, and starves you when empty
- Fall damage, mob damage with knockback and invulnerability frames
- Death screen and respawn at your world spawn point
- Passive pigs and hostile zombies; zombies chase and attack the nearest player,
  take damage, die, and drop loot
- **Melee**: swords, axes and pickaxes in four tiers, each with its own damage
  and attack cooldown; bare fists do 1
- **Bow and arrows**: hold to draw (a charge bar fills), release to fire.
  Damage and speed scale with draw; arrows are swept against the voxel grid so
  they cannot tunnel through walls, and they hit mobs and players
- **Armour**: leather, iron and diamond in four slots (head/chest/legs/feet).
  Each point removes 4% damage, capped at 80%; pieces wear out and break
- **Shield**: hold use to raise it — absorbs 66% of a hit and slows you down
- **PvP**: in multiplayer you can hit other players with melee or arrows.
  Worn armour is drawn on other players' bodies, and a small health bar appears
  under their name once they are hurt

**Items and building**
- Mining takes time based on block hardness and the tool you hold; the wrong
  tool tier means no drop at all (stone without a pickaxe drops nothing)
- Broken blocks and dead mobs drop collectable item entities
- 36-slot inventory with a 9-slot hotbar, stacking, and tool durability
- Crafting: planks, sticks and a crafting table by hand; pickaxes, axes and
  swords in four tiers at a table; smelting (iron, gold, glass, stone, bricks,
  cooked food) at a furnace
- Persistence in IndexedDB: seed, player state, inventory, health/hunger, and
  per-chunk edit diffs

## Architecture

```
src/
  constants.ts       all tunables (chunk size, gravity, reach, combat, hunger...)
  blocks.ts          block registry: tiles, hardness, tool + tier, drops
  textures.ts        procedural atlas: block tiles + pixel-art item icons
  physics.ts         shared AABB-vs-voxel collision (player and mobs)
  input.ts           keyboard/wheel state, discrete press queue
  raycast.ts         Amanatides & Woo voxel DDA
  audio.ts           WebAudio generated sound effects
  sky.ts             day/night: sun/ambient lights, sky+fog colour keyframes
  save.ts            IndexedDB store (meta, inventory, per-chunk edit diffs)
  items/
    items.ts         item registry: blocks, materials, food, tools, weapons
    inventory.ts     slots, stacking, durability, serialisation
    crafting.ts      recipes and stations (hand / table / furnace)
  entities/
    entity.ts        Entity + Mob base: gravity, knockback, hurt state
    arrow.ts         swept projectile: block, mob and player hits
    models.ts        merged box geometry per mob type (one draw call each)
    zombie.ts        hostile AI: chase, attack, wander
    pig.ts           passive AI: wander, flee when hit
    itemdrop.ts      dropped items: spin, bob, pickup
    manager.ts       lifecycle, spawning/despawning, ray-vs-mob queries
  game/
    interaction.ts   mining progress, placing, attacking, eating, stations
  net/
    protocol.ts      wire types, limits and validators (shared with the server)
    config.ts        WebSocket URL resolution (query > env > same-host)
    client.ts        socket lifecycle, reconnect backoff, ping/RTT
    session.ts       roster, state throttling, applying remote edits
    remoteplayers.ts remote bodies, name labels, snapshot interpolation
    remotemobs.ts    guest-side view of the host's mobs, interpolated
server/
  index.ts           authoritative room server (rooms, cap, edits, relay)
  world/
    chunk.ts         flat Uint8Array voxel storage per 16x72x16 column
    noise.ts         seeded value noise + fBm
    terrain.ts       heightmap layers, biome-ish masks, deterministic trees
    world.ts         chunk map, streaming, edit tracking, remesh queue
    mesher.ts        culled face meshing with baked AO, opaque+water buffers
  player/
    camera.ts        pointer-lock yaw/pitch
    player.ts        movement intent, water state, fall tracking
    survival.ts      health, hunger, regen, starvation, death
  ui/
    hud.ts           hotbar bound to the inventory, FPS, debug, toasts
    statusui.ts      hearts, hunger, mining progress, death screen
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

**Physics.** Bodies are AABBs moved one axis at a time (`physics.ts`, shared by
the player and every mob); after each axis move, any overlapped solid voxel
clamps the position back to the voxel face and zeroes that velocity component.
Movement is integrated in substeps small enough that no step exceeds 0.4 blocks,
which rules out tunnelling at any frame rate. Unloaded chunks read as solid so
nothing falls through terrain that hasn't streamed in yet.

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
- Mobs are not saved; they despawn past 72 blocks and respawn naturally. Only
  the seed, player state, inventory and block edits persist.
  TODO hook: serialise `EntityManager.entities` alongside `SaveMeta`.
- Mob AI has no pathfinding — zombies walk straight at you and hop one-block
  ledges, so they get stuck on complex terrain. Hook: `Zombie.update`.
- Culled meshing, not greedy merging; fine at default view distance.
  TODO hook: `buildChunkGeometry` in `world/mesher.ts`.
- Chunk generation/meshing runs on the main thread under a time budget.
  TODO hook: move `buildChunkGeometry` + `TerrainGenerator.generate` behind a
  worker boundary (both are already pure functions of chunk data).
- Inventory is click-to-pick-up/click-to-place rather than true drag-and-drop,
  and there is no drop-item-from-inventory action.
- Dying keeps your inventory (deliberate for now). No shovels yet — `ToolKind`
  already includes `'shovel'` as the extension point.
- Only the shooter's client reports arrow hits, so damage is never
  double-applied. Remote arrows are spawned with the elapsed network time
  replayed, so they appear where they actually are rather than trailing the
  shot — but a hit still registers on the shooter's view of the world, so at
  high latency a very near-miss can differ between screens.
- **Multiplayer:** mobs are *host*-authoritative rather than server-authoritative
  — the server cannot simulate them because it does not generate terrain. If
  the host's tab is backgrounded, mob updates slow for everyone.
- **Multiplayer:** inventory is per-client, so you cannot hand someone an item
  or trade. Health, hunger and worn armour are shared.
- **Multiplayer:** worlds are not saved. A room's edits live in server memory
  and are gone when the host leaves. Hook: persist `Room.edits` in
  `server/index.ts`.
- **Multiplayer:** no host migration — the room closes when the host leaves,
  and remaining players are told so.
- **Multiplayer:** block edits are applied locally first and relayed; the
  server validates coordinates, ids and rates, but does not re-check reach or
  tool rules, so a modified client could place blocks it should not own.

## Next 5 features (priority order)

1. **Per-voxel lighting** — flood-fill sunlight + block light stored per voxel
   and sampled in the mesher. Unlocks dark caves, torches, and light-based
   hostile spawning, all of which the current systems are stubbed for.
   Hook: add a light array to `Chunk`, sample it in `emitFace`.
2. **Web worker meshing/generation** — moves the remaining frame hitches off
   the main thread; `mesher.ts`/`terrain.ts` are already pure functions.
3. **Armour, bows and a real damage model** — item slots for armour with damage
   reduction, plus a projectile entity. `ItemDef` and `Entity` are the hooks.
4. **Biomes and structures** — swap the single terrain function for a biome
   table (desert, forest, snow) and scatter simple structures; the chunk
   pipeline already supports it via `TerrainGenerator.generate`.
5. **Multiplayer persistence and shared loot** — save a room's edits on the
   server so worlds survive the host leaving, and sync item drops so a guest
   collects what it kills.
