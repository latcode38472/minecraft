// Bootstrap and frame loop. Systems live in their own modules; this file wires
// them together and owns the play/paused/dead state machine.

import * as THREE from 'three';
import {
  initAudio,
  playAttack,
  playBreak,
  playEat,
  playHurt,
  playMobDeath,
  playPickup,
  playPlace,
  playStep,
} from './audio';
import { AutoQuality } from './autoquality';
import {
  CHUNK_SIZE,
  DEFAULT_VIEW_DISTANCE,
  KNOCKBACK_LIFT,
  KNOCKBACK_SPEED,
  MAX_HEALTH,
  MAX_HUNGER,
  MAX_TIMESTEP,
  MAX_VIEW_DISTANCE,
  MIN_VIEW_DISTANCE,
  RESPAWN_SEARCH_RADIUS,
  SAVE_INTERVAL_MS,
  TOUCH_DEFAULT_VIEW_DISTANCE,
  TOUCH_LOOK_SENSITIVITY,
  TOUCH_MAX_CHUNK_GENS_PER_FRAME,
  TOUCH_MESH_BUDGET_MS,
} from './constants';
import { BLOCKS } from './blocks';
import type { EntityContext } from './entities/entity';
import { EntityManager, isNightTime } from './entities/manager';
import { Interaction, breakTimeFor, canHarvest } from './game/interaction';
import { Inventory, type ItemStack } from './items/inventory';
import { RECIPES, craft, type Station } from './items/crafting';
import { Input } from './input';
import { MouseLook } from './player/camera';
import { Player, type MoveInput } from './player/player';
import { Survival } from './player/survival';
import type { MultiplayerSession } from './net/session';
import { MultiplayerSession as Session } from './net/session';
import type { StartChoice } from './ui/multiplayerui';
import { MultiplayerHud, showModeMenu } from './ui/multiplayerui';
import { SaveStore, type SaveMeta } from './save';
import { Sky } from './sky';
import { Hud } from './ui/hud';
import { InventoryUi } from './ui/inventoryui';
import { StatusUi } from './ui/statusui';
import { TouchControls, isTouchDevice } from './ui/touch';
import { World } from './world/world';

const STEP_INTERVAL_BLOCKS = 2.2;

async function boot(choice: StartChoice): Promise<void> {
  const params = new URLSearchParams(location.search);
  const multiplayer = choice.mode === 'multiplayer' ? choice : null;
  const store = await SaveStore.open();
  if (params.has('reset')) await store.clearAll();

  // Multiplayer worlds come from the server and are never mixed with the local
  // singleplayer save, so joining a room can't overwrite a solo world.
  let meta = multiplayer ? undefined : await store.loadMeta();
  const paramSeed = multiplayer ? null : params.get('seed');
  let seed = multiplayer ? multiplayer.world.seed : (meta?.seed ?? (Math.random() * 0xffffffff) >>> 0);
  if (paramSeed !== null) {
    const requested = Number(paramSeed) >>> 0;
    if (requested !== meta?.seed) {
      // A different seed means a different world: start over.
      await store.clearAll();
      meta = undefined;
    }
    seed = requested;
  }

  // --- Renderer & scene ---
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch {
    document.getElementById('menu')!.innerHTML =
      '<h1>VOXELCRAFT</h1><div>This browser does not support WebGL 2,<br>which the game needs to render. Try updating your browser or OS.</div>';
    return;
  }
  const basePixelRatio = Math.min(window.devicePixelRatio, 2);
  let pixelScale = 1; // lowered by AutoQuality under load
  renderer.setPixelRatio(basePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  scene.fog = new THREE.Fog(0x87ceeb, 10, 100);

  const touchDevice = params.has('touch') || isTouchDevice();
  if (touchDevice) document.documentElement.classList.add('touch');

  let viewDistance = clampViewDistance(
    Number(localStorage.getItem('voxelcraft.viewDistance')) ||
      (touchDevice ? TOUCH_DEFAULT_VIEW_DISTANCE : DEFAULT_VIEW_DISTANCE),
  );
  applyViewDistance();

  function clampViewDistance(v: number): number {
    return Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, v));
  }

  function applyViewDistance(): void {
    const far = viewDistance * CHUNK_SIZE;
    (scene.fog as THREE.Fog).near = far * 0.55;
    (scene.fog as THREE.Fog).far = far * 0.95;
    camera.far = far * 1.5 + 64;
    camera.updateProjectionMatrix();
  }

  function applyPixelScale(scale: number): void {
    pixelScale = scale;
    renderer.setPixelRatio(basePixelRatio * scale);
  }

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // --- Game systems ---
  const savedEdits = await store.loadAllEdits();
  const world = new World(seed, scene, savedEdits);
  const sky = new Sky(scene);
  const input = new Input();
  const look = new MouseLook(camera, renderer.domElement);
  const player = new Player(world);
  const inventory = new Inventory();
  const entities = new EntityManager(scene, world);

  const survival = new Survival({
    onHurt: () => playHurt(),
    onDeath: () => onPlayerDied(),
  });

  const hud = new Hud(inventory, (index) => inventory.selectSlot(index));
  const statusUi = new StatusUi(() => respawn());
  const inventoryUi = new InventoryUi(inventory, () => hud.refresh());

  const spawnPoint = new THREE.Vector3();
  if (meta) {
    player.position.set(meta.player.x, meta.player.y, meta.player.z);
    look.yaw = meta.player.yaw;
    look.pitch = meta.player.pitch;
    sky.timeOfDay = meta.timeOfDay;
    inventory.load(meta.inventory, meta.selectedSlot);
    if (meta.health !== undefined && meta.hunger !== undefined) {
      survival.load(meta.health, meta.hunger);
    }
    const s = meta.spawn;
    if (s) spawnPoint.set(s.x, s.y, s.z);
    else spawnPoint.copy(player.position);
  } else {
    // findSpawnColumn is deterministic from the seed, so every client in a room
    // resolves the same spawn. Each player gets a small offset so nobody starts
    // inside another player's collision box.
    const spawn = world.terrain.findSpawnColumn();
    const slot = multiplayer ? multiplayer.self.colorIndex : 0;
    const offsets: [number, number][] = [[0, 0], [2, 0], [0, 2]];
    const [ox, oz] = offsets[slot % offsets.length];
    player.position.set(spawn.x + ox + 0.5, spawn.y + 2, spawn.z + oz + 0.5);
    spawnPoint.copy(player.position);
  }
  hud.refresh();

  // Targeted-block outline.
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  highlight.visible = false;
  scene.add(highlight);

  const interaction = new Interaction(world, player, inventory, entities, {
    onBreakBlock: (def) => playBreak(def.sound),
    onPlaceBlock: (def) => playPlace(def.sound),
    onAttack: () => playAttack(),
    tryEat: (hunger) => {
      if (!survival.eat(hunger)) return false;
      playEat();
      return true;
    },
    onOpenStation: (station) => openInventory(station),
    toast: (msg) => hud.toast(msg),
  });

  // --- Play state ---
  const menu = document.getElementById('menu')!;
  let touchPlaying = false;
  const root = document.documentElement;

  /** True when the world should simulate and accept look/move input. */
  const isPlaying = (): boolean =>
    !survival.dead && !inventoryUi.open && (touchDevice ? touchPlaying : look.locked);

  function refreshPlayingClass(): void {
    root.classList.toggle('playing', isPlaying());
  }

  const touch = touchDevice ? new TouchControls(document.getElementById('app')!) : null;
  if (touch) {
    touch.onPause = () => {
      touchPlaying = false;
      menu.style.display = 'flex';
      refreshPlayingClass();
      flushSave();
    };
    touch.onInventory = () => toggleInventory();
  }

  const autoQuality = touchDevice
    ? new AutoQuality(viewDistance, {
        setViewDistance: (v) => {
          viewDistance = v;
          applyViewDistance();
        },
        setPixelScale: applyPixelScale,
        notify: (msg) => hud.toast(msg),
      })
    : null;

  menu.addEventListener('pointerup', () => {
    if (survival.dead) return;
    initAudio();
    if (touchDevice) {
      touchPlaying = true;
      menu.style.display = 'none';
    } else {
      look.requestLock();
    }
    refreshPlayingClass();
  });

  document.addEventListener('pointerlockchange', () => {
    // Only the menu path un-pauses; the inventory and death screens manage
    // their own overlays and must not be replaced by the main menu.
    if (touchDevice) return;
    const showMenu = !look.locked && !inventoryUi.open && !survival.dead;
    menu.style.display = showMenu ? 'flex' : 'none';
    refreshPlayingClass();
  });

  function openInventory(station: Station): void {
    inventoryUi.show(station);
    menu.style.display = 'none';
    if (!touchDevice && look.locked) document.exitPointerLock();
    refreshPlayingClass();
  }

  function toggleInventory(): void {
    if (inventoryUi.open) {
      inventoryUi.close();
      hud.refresh();
      if (!touchDevice && !survival.dead) look.requestLock();
      refreshPlayingClass();
    } else if (!survival.dead) {
      openInventory('none');
    }
  }

  function onPlayerDied(): void {
    inventoryUi.close();
    menu.style.display = 'none';
    statusUi.showDeath(entities.mobCount > 0 ? 'The night was not kind.' : 'Better luck next time.');
    if (!touchDevice && look.locked) document.exitPointerLock();
    refreshPlayingClass();
    flushSave();
  }

  function respawn(): void {
    // Drop the player at the recorded spawn, on top of whatever is there now.
    const sx = Math.floor(spawnPoint.x);
    const sz = Math.floor(spawnPoint.z);
    let y = Math.floor(spawnPoint.y);
    for (let dy = RESPAWN_SEARCH_RADIUS; dy >= -RESPAWN_SEARCH_RADIUS; dy--) {
      const candidate = Math.floor(spawnPoint.y) + dy;
      if (world.isSolidAt(sx, candidate - 1, sz) && !world.isSolidAt(sx, candidate, sz)) {
        y = candidate;
        break;
      }
    }
    player.position.set(sx + 0.5, y + 0.5, sz + 0.5);
    player.reset();
    survival.respawn();
    statusUi.hideDeath();
    entities.clear();
    if (!touchDevice) look.requestLock();
    else touchPlaying = true;
    refreshPlayingClass();
  }

  // --- Mouse actions ---
  let mineHeld = false;
  let useHeld = false;
  let mouseUseTaps = 0;
  document.addEventListener('mousedown', (e) => {
    if (!isPlaying()) return;
    if (e.button === 0) mineHeld = true;
    if (e.button === 2) {
      useHeld = true;
      mouseUseTaps++;
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mineHeld = false;
    if (e.button === 2) useHeld = false;
  });

  const eye = new THREE.Vector3();
  const lookDir = new THREE.Vector3();

  function handleKeys(): void {
    for (const code of input.takePresses()) {
      if (code.startsWith('Digit')) {
        const n = Number(code.slice(5));
        if (n >= 1 && n <= 9) {
          inventory.selectSlot(n - 1);
          hud.refresh();
        }
      } else if (code === 'KeyE') {
        toggleInventory();
      } else if (code === 'F3') {
        hud.toggleDebug();
      } else if (code === 'KeyT') {
        sky.timeOfDay = (sky.timeOfDay + 0.05) % 1;
        hud.toast(`Time: ${(sky.timeOfDay * 24).toFixed(1)}h`);
      } else if (code === 'BracketLeft' || code === 'BracketRight') {
        if (autoQuality?.enabled) autoQuality.disable(); // manual override wins
        viewDistance = clampViewDistance(viewDistance + (code === 'BracketRight' ? 1 : -1));
        applyViewDistance();
        localStorage.setItem('voxelcraft.viewDistance', String(viewDistance));
        hud.toast(`View distance: ${viewDistance} chunks`);
      }
    }
    const wheel = input.takeWheelSteps();
    if (wheel !== 0 && isPlaying()) {
      inventory.cycleSelection(wheel);
      hud.refresh();
    }
  }

  /** Shove the player away from a damage source. */
  function knockbackPlayer(fromX: number, fromZ: number): void {
    const dx = player.position.x - fromX;
    const dz = player.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    player.velocity.x = (dx / len) * KNOCKBACK_SPEED * 0.6;
    player.velocity.z = (dz / len) * KNOCKBACK_SPEED * 0.6;
    if (player.onGround) player.velocity.y = KNOCKBACK_LIFT * 0.6;
  }

  const entityContext: EntityContext = {
    world,
    dt: 0,
    playerPos: player.position,
    isNight: false,
    damagePlayer: (amount, fromX, fromZ) => {
      if (!isPlaying()) return;
      survival.damage(amount);
      knockbackPlayer(fromX, fromZ);
    },
    spawnDrop: (id, count, x, y, z) => entities.spawnDrop(id, count, x, y, z),
    collectItem: (id, count, damage) => {
      const leftover = inventory.add(id, count, damage);
      if (leftover < count) {
        playPickup();
        hud.refresh();
      }
      return leftover;
    },
    onMobDeath: () => playMobDeath(),
  };

  // --- Persistence ---
  function flushSave(): void {
    // Multiplayer worlds live on the server; writing them here would clobber
    // the player's singleplayer save.
    if (multiplayer) return;
    // Saving mid-death would reload the player, still dead, where they fell.
    // Persist the post-respawn state instead so the world reopens playable.
    const dead = survival.dead;
    const pos = dead ? spawnPoint : player.position;
    const metaOut: SaveMeta = {
      seed,
      timeOfDay: sky.timeOfDay,
      player: {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        yaw: look.yaw,
        pitch: look.pitch,
      },
      selectedSlot: inventory.selected,
      inventory: inventory.serialize(),
      health: dead ? MAX_HEALTH : survival.health,
      hunger: dead ? MAX_HUNGER : survival.hunger,
      spawn: { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z },
    };
    void store.saveMeta(metaOut);
    for (const key of world.unsavedEditKeys) {
      const edits = world.edits.get(key);
      if (edits) void store.saveChunkEdits(key, edits);
    }
    world.unsavedEditKeys.clear();
  }
  setInterval(flushSave, SAVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });

  // --- Multiplayer ---
  let session: MultiplayerSession | null = null;

  function leaveMultiplayer(): void {
    session?.leave();
    session = null;
    // Reloading is the cleanest way back to the start menu: it disposes the
    // whole scene and rebuilds from scratch with no leftover room state.
    location.reload();
  }

  const mpHud = new MultiplayerHud(leaveMultiplayer);

  if (multiplayer) {
    session = new Session(
      multiplayer.net,
      world,
      player,
      scene,
      multiplayer.code,
      multiplayer.self,
      multiplayer.world,
      multiplayer.players,
      {
        onRosterChange: (players) => mpHud.setRoster(players),
        onRoomClosed: (message) => {
          mpHud.notice(message);
          hud.toast(message);
          // Give the player a moment to read it, then drop back to the menu.
          setTimeout(() => location.reload(), 3500);
        },
        onStatusChange: (status) => {
          // Stay quiet once the room has ended, so a closing notice is not
          // overwritten by connection chatter.
          if (session?.ended) return;
          if (status === 'reconnecting') mpHud.notice('Connection lost — reconnecting…');
        },
        onNotice: (message) => mpHud.notice(message),
      },
    );
    mpHud.show(multiplayer.code);
    mpHud.setRoster(multiplayer.players);
    // Mobs are single-player only for now: they are not synchronised, so each
    // client would simulate its own and they would disagree.
    entities.clear();
  }

  // --- Debug hook for automated smoke tests ---
  (window as unknown as Record<string, unknown>).__voxel = {
    world,
    player,
    sky,
    look,
    touch,
    autoQuality,
    inventory,
    survival,
    entities,
    interaction,
    inventoryUi,
    respawn,
    getSession: () => session,
    getViewDistance: () => viewDistance,
    // Thin wrappers over the real rules, so automated tests exercise the same
    // code paths the game does rather than reimplementing them.
    __breakTime: (blockId: number, stack: ItemStack | null) =>
      breakTimeFor(BLOCKS[blockId], stack),
    __canHarvest: (blockId: number, stack: ItemStack | null) =>
      canHarvest(BLOCKS[blockId], stack),
    __craftAt: (recipeId: string, station: Station) => {
      const recipe = RECIPES.find((r) => r.id === recipeId);
      if (!recipe || (recipe.station !== 'none' && recipe.station !== station)) return false;
      return craft(inventory, recipe);
    },
  };

  refreshPlayingClass();

  // --- Main loop ---
  let lastTime = performance.now();
  renderer.setAnimationLoop(() => {
    const nowMs = performance.now();
    const dt = Math.min((nowMs - lastTime) / 1000, MAX_TIMESTEP);
    lastTime = nowMs;
    const playing = isPlaying();

    handleKeys();

    if (touch) {
      const [lookDx, lookDy] = touch.takeLookDelta();
      if (playing) look.rotate(lookDx, lookDy, TOUCH_LOOK_SENSITIVITY);
    }

    const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
    const move: MoveInput = {
      forward: clamp1(
        (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0) + (touch?.moveForward ?? 0),
      ),
      strafe: clamp1(
        (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0) + (touch?.moveStrafe ?? 0),
      ),
      jump: input.isDown('Space') || (touch?.jumpHeld ?? false),
      sneak: input.isDown('ShiftLeft') || input.isDown('ShiftRight') || (touch?.sneakOn ?? false),
    };

    if (playing) player.update(dt, move, look.yaw);
    survival.update(dt, player);

    world.update(
      player.position.x,
      player.position.z,
      viewDistance,
      touchDevice ? TOUCH_MAX_CHUNK_GENS_PER_FRAME : undefined,
      touchDevice ? TOUCH_MESH_BUDGET_MS : undefined,
    );
    sky.update(dt);
    if (playing) autoQuality?.update(dt);

    // Entities keep simulating while paused would be surprising; freeze them.
    // Mobs are disabled in multiplayer until they are server-authoritative.
    if (playing && !multiplayer) {
      entityContext.dt = dt;
      entityContext.isNight = isNightTime(sky.timeOfDay);
      entities.update(entityContext, sky.timeOfDay);
    }

    if (session) {
      // Camera yaw/pitch is the shared abstraction: keyboard+mouse and touch
      // both feed it, so both platforms emit identical network state.
      session.update(nowMs, dt, look.yaw, look.pitch, playing);
      mpHud.setPing(session.ping, session.status === 'connected' ? 'Ping: —' : session.status);
    }

    if (player.stepAccumulator > STEP_INTERVAL_BLOCKS) {
      player.stepAccumulator = 0;
      playStep();
    }

    player.eyePosition(eye);
    look.direction(lookDir);

    // Touch taps and mouse right-clicks both feed the same edge-triggered path.
    const useTaps = (touch?.takeTaps() ?? 0) + mouseUseTaps;
    mouseUseTaps = 0;
    if (playing) {
      interaction.update(dt, nowMs, eye, lookDir, {
        mining: mineHeld || (touch?.holdActive ?? false),
        using: useHeld,
        useTaps,
      });
    }

    const hit = playing ? interaction.target : null;
    highlight.visible = hit !== null;
    if (hit) highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

    look.apply(eye);
    hud.setUnderwater(player.eyeInWater);
    hud.refresh();
    statusUi.update(survival, playing ? interaction.breakProgress : 0);
    inventoryUi.render();

    hud.updateFrameStats(
      dt,
      [
        `pos ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`,
        `chunk ${Math.floor(player.position.x / CHUNK_SIZE)},${Math.floor(player.position.z / CHUNK_SIZE)}`,
        `chunks ${world.chunks.size} (pending mesh ${world.pendingMeshCount})`,
        `entities ${entities.entities.length} (mobs ${entities.mobCount})`,
        `hp ${survival.health.toFixed(0)}  food ${survival.hunger.toFixed(1)}`,
        `draw calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`,
        `seed ${seed}  time ${(sky.timeOfDay * 24).toFixed(1)}h ${isNightTime(sky.timeOfDay) ? '(night)' : '(day)'}`,
        `view ${viewDistance} chunks  render ${Math.round(pixelScale * 100)}%`,
      ].join('\n'),
    );

    renderer.render(scene, camera);
  });
}

async function main(): Promise<void> {
  const choice = await showModeMenu();
  await boot(choice);
}

void main();
