# Voxelcraft

A playable Minecraft-like voxel sandbox in the browser. TypeScript + Three.js +
Vite, no image or audio assets — textures and sounds are generated at runtime.

## Run it

```sh
npm install
npm run dev      # then open the printed URL (default http://localhost:5173)
```

Production build: `npm run build`, serve with `npm run preview`.

## Controls

### Desktop

| Input | Action |
| --- | --- |
| Click | capture mouse (Esc releases) |
| W A S D | move |
| Mouse | look |
| Space | jump / swim up |
| Shift | sneak / swim down |
| Left click (hold) | break block |
| Right click (hold) | place selected block |
| 1–9 / mouse wheel | select hotbar slot |
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
| Tap | break targeted block |
| Press & hold | place selected block (repeats) |
| ▲ button | jump / swim up (hold) |
| ▼ button | sneak / swim down (toggle) |
| Tap hotbar | select block |
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

URL parameters: `?seed=12345` starts a specific world (a new seed wipes saved
edits), `?reset` wipes the save entirely, `?touch=1` forces touch controls.

## What's in the MVP

- First-person camera with pointer-lock mouse look
- Chunk-based world (16×72×16 columns), streamed in/out around the player
- Seeded procedural terrain: continents/oceans, plains, hills, mountains,
  beaches, water, trees; layered grass/dirt/stone/bedrock
- Break and place blocks with a 9-slot hotbar (grass, dirt, stone, sand, log,
  leaves, planks, cobblestone, water)
- AABB collision, gravity, jumping, swimming
- Day/night cycle driving sun light, ambient light, sky and fog colour
- Baked ambient occlusion + directional face shading on chunk meshes
- Generated sound effects (break / place / footsteps) via WebAudio
- Mobile touch controls: virtual joystick, drag-look, tap/hold to break/place
- World persistence in IndexedDB: seed, player state, and per-chunk edit diffs,
  auto-saved every 5 s and on tab hide

## Architecture

```
src/
  constants.ts       all tunables (chunk size, gravity, reach, speeds...)
  blocks.ts          block registry: tiles, solidity, opacity, sounds
  textures.ts        procedural 16px texture atlas (canvas -> CanvasTexture)
  input.ts           keyboard/wheel state, discrete press queue
  raycast.ts         Amanatides & Woo voxel DDA
  audio.ts           WebAudio generated sound effects
  sky.ts             day/night: sun/ambient lights, sky+fog colour keyframes
  save.ts            IndexedDB store (meta + per-chunk edit diffs)
  world/
    chunk.ts         flat Uint8Array voxel storage per 16x72x16 column
    noise.ts         seeded value noise + fBm
    terrain.ts       heightmap layers, biome-ish masks, deterministic trees
    world.ts         chunk map, streaming, edit tracking, remesh queue
    mesher.ts        culled face meshing with baked AO, opaque+water buffers
  player/
    camera.ts        pointer-lock yaw/pitch
    player.ts        AABB physics: axis-separated collision, swim, substeps
  ui/
    hud.ts           hotbar, FPS counter, debug panel, toasts
    touch.ts         virtual joystick, look/tap/long-press gestures, buttons
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

**Physics.** The player is an AABB moved one axis at a time; after each axis
move, any overlapped solid voxel clamps the position back to the voxel face
and zeroes that velocity component. Movement is integrated in substeps small
enough that no step exceeds 0.4 blocks, which rules out tunnelling at any
frame rate. Unloaded chunks read as solid so the player can't fall through
terrain that hasn't streamed in yet.

## Current limitations

- Water is static (no flow simulation); placing/removing blocks doesn't make
  water spread.
- No per-voxel light propagation — lighting is sun + ambient + baked AO, so
  caves/overhangs don't get properly dark and torches don't exist yet.
- Culled meshing, not greedy merging; fine at default view distance, and the
  mesher is the single hook to upgrade (`world/mesher.ts`,
  `buildChunkGeometry`). TODO there if 12+ chunk view distances are wanted.
- Chunk generation/meshing runs on the main thread under a time budget; a
  worker would remove the last hitches at high view distance.
  TODO hook: move `buildChunkGeometry` + `TerrainGenerator.generate` behind a
  worker boundary (both are pure functions of chunk data already).
- No inventory beyond the hotbar, no block drops — breaking destroys.

## Next 5 features (priority order)

1. **Per-voxel lighting** — flood-fill sunlight + block light (torches) stored
   per voxel, sampled in the mesher; makes caves dark and enables torches.
   Hook: add a light array to `Chunk`, sample it in `emitFace`.
2. **Web worker meshing/generation** — moves the remaining frame hitches off
   the main thread; `mesher.ts`/`terrain.ts` are already pure.
3. **Block drops + inventory counts** — breaking yields items, hotbar shows
   counts; first step toward survival mode.
4. **Greedy meshing** — merge coplanar same-texture quads; cuts triangle count
   several-fold and unlocks much larger view distances.
5. **Caves and ores** — 3D noise carving below the surface plus ore veins;
   makes digging worthwhile. Hook: carve in `TerrainGenerator.generate` after
   the column fill.
