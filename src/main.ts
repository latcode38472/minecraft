// Bootstrap and frame loop. Systems live in their own modules; this file wires
// them together and owns the play/paused/dead/asleep state machine.

import * as THREE from 'three';
import {
  initAudio,
  playAttack,
  playBreak,
  playBubble,
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
  MOB_DESPAWN_DISTANCE,
  MAX_VIEW_DISTANCE,
  MIN_VIEW_DISTANCE,
  RESPAWN_SEARCH_RADIUS,
  SAVE_INTERVAL_MS,
  TOUCH_DEFAULT_VIEW_DISTANCE,
  TOUCH_LOOK_SENSITIVITY,
  TOUCH_MAX_CHUNK_GENS_PER_FRAME,
  TOUCH_MESH_BUDGET_MS,
} from './constants';
import { Block, BLOCKS } from './blocks';
import type { EntityContext } from './entities/entity';
import { EntityManager } from './entities/manager';
import { RoomSimulation } from './shared/roomsim';
import { MobSim, isNightTime, type MobKind, type SimPlayer } from './shared/mobsim';
import { blockDrops, breakTimeFor, canHarvest, wearsTool } from './shared/harvest';
import { WorldView } from './game/worldview';
import { Viewmodel } from './game/viewmodel';
import { BreakOverlay } from './game/breakoverlay';
import { drawTileTo } from './textures';
import { Arrow } from './entities/arrow';
import type { CombatTarget } from './game/interaction';
import { ARROW_SPEED, BLOCK_SLOWDOWN, PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from './constants';
import { Interaction } from './game/interaction';
import { InventoryController } from './game/inventoryctl';
import { Inventory, type ItemStack } from './items/inventory';
import { getItem } from './items/items';
import { getRecipe } from './items/crafting';
import { Input } from './input';
import { MouseLook } from './player/camera';
import { Player, type MoveInput } from './player/player';
import { Survival } from './player/survival';
import { receiveClock } from './net/protocol';
import type { MultiplayerSession } from './net/session';
import { MultiplayerSession as Session } from './net/session';
import type { StartChoice } from './ui/multiplayerui';
import { MultiplayerHud, showModeMenu } from './ui/multiplayerui';
import { SaveStore, type SaveMeta } from './save';
import { Sky } from './sky';
import { Hud } from './ui/hud';
import { InventoryUi, recipeCells } from './ui/inventoryui';
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
  const savedState = multiplayer || !meta ? undefined : await store.loadState();

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
    viewmodel.setAspect(camera.aspect);
  });

  // --- Game systems ---
  const savedEdits = await store.loadAllEdits();
  const world = new World(seed, scene, savedEdits);
  const sky = new Sky(scene);
  const input = new Input();
  const look = new MouseLook(camera, renderer.domElement);
  const player = new Player(world);
  const inventory = new Inventory();
  // Arrows still live in the client entity manager; mobs and dropped items are
  // simulation-owned and rendered from snapshots.
  const entities = new EntityManager(scene);
  const worldView = new WorldView(scene);
  // The hand/held item in front of the camera, and the cracks on the block
  // being mined. Both are pure presentation: no simulation depends on them.
  const viewmodel = new Viewmodel(camera.fov);
  viewmodel.setAspect(camera.aspect);
  const breakOverlay = new BreakOverlay(scene);
  /** Mirrors the quality ladder, so late-joining bodies match the rest. */
  let animatedLimbs = true;
  /** Singleplayer runs the SAME simulation class the server runs. */
  let localSim: RoomSimulation | null = null;
  /** In bed: the screen is dark and the night is (hopefully) passing. */
  let sleeping = false;

  const survival = new Survival({
    onHurt: () => playHurt(),
    onDeath: () => onPlayerDied(),
    onBubblePop: (remaining) => playBubble(remaining),
    armorPoints: () => inventory.armorPoints(),
    // `interaction` is created below; guard for the first frames.
    isBlocking: () => interaction?.blocking === true,
    onAbsorb: (blocked) => {
      // Gear that soaked a hit wears down.
      for (const id of inventory.damageArmor(1)) {
        hud.toast(`Your ${getItem(id)?.name ?? 'armour'} broke!`);
      }
      if (blocked) {
        const held = inventory.selectedStack;
        if (held && getItem(held.id)?.blocking) {
          const def = getItem(held.id)!.blocking!;
          held.damage = (held.damage ?? 0) + 1;
          if (held.damage >= def.durability) {
            inventory.slots[inventory.selected] = null;
            hud.toast('Your shield broke!');
          }
          inventory.version++;
        }
      }
      hud.refresh();
    },
  });

  /** Our own network id, or a stable local id in singleplayer. */
  function selfNetId(): string {
    return session?.self.id ?? 'local';
  }

  // The inventory as the game acts on it: local authority in singleplayer,
  // predicted and corrected by the server in multiplayer.
  const invCtl = new InventoryController(inventory, {
    eat: (hunger) => {
      if (!survival.eat(hunger)) return false;
      playEat();
      return true;
    },
    onChange: () => hud.refresh(),
    spawnDrop: (id, count, damage) => {
      // Only the local world takes overflow here; the server drops its own.
      localSim?.spawnDrop(id, count, player.position.x, player.position.y + 1.2, player.position.z, selfNetId(), damage);
    },
  });

  const hud = new Hud(
    inventory,
    (index) => invCtl.selectSlot(index),
    // Long-press on touch throws the stack: the phone's Ctrl+Q.
    (index) => {
      invCtl.selectSlot(index);
      dropHeldItem(true);
    },
  );
  const statusUi = new StatusUi(() => respawn());
  // Every way of leaving the screen lands here — the E key, the Close button,
  // Escape — so the grid is handed back and the mouse recaptured in exactly
  // one place, and no route out can forget one of the two.
  const inventoryUi = new InventoryUi(invCtl, () => {
    invCtl.close();
    hud.refresh();
    resumePlay();
  });

  const spawnPoint = new THREE.Vector3();
  if (multiplayer?.restore) {
    // We have been in this world before: carry on from where we left.
    const r = multiplayer.restore;
    player.position.set(r.x, r.y, r.z);
    look.yaw = r.yaw;
    look.pitch = r.pitch;
    survival.load(r.health, r.hunger);
    if (r.spawn) spawnPoint.set(r.spawn.x, r.spawn.y, r.spawn.z);
    else spawnPoint.copy(player.position);
  } else if (meta) {
    player.position.set(meta.player.x, meta.player.y, meta.player.z);
    look.yaw = meta.player.yaw;
    look.pitch = meta.player.pitch;
    sky.timeOfDay = meta.timeOfDay;
    inventory.load(meta.inventory, meta.selectedSlot, meta.armor);
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
  if (!multiplayer) {
    // Singleplayer: the client is its own authority, running the same code.
    localSim = new RoomSimulation(world, {
      damagePlayer: (_id, amount, fromX, fromZ) => {
        if (!isPlaying() && !sleeping) return;
        survival.damage(amount);
        knockbackPlayer(fromX, fromZ);
        if (sleeping) wakeUp('You were attacked in your sleep!');
      },
      giveItems: (_id, itemId, count, damage) => {
        const leftover = inventory.add(itemId, count, damage);
        if (leftover < count) {
          playPickup();
          hud.refresh();
        }
        return leftover;
      },
      onWake: (_id, reason) => {
        setSleeping(false, reason === 'morning' ? 'Good morning.' : reason === 'bed_gone' ? 'Your bed was broken.' : undefined);
      },
    });
    if (savedState) localSim.restore(savedState);
    else localSim.timeOfDay = sky.timeOfDay;
    sky.timeOfDay = localSim.timeOfDay;
    worldView.direct = true;
  }

  hud.refresh();

  // Targeted-block outline.
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  highlight.visible = false;
  scene.add(highlight);

  const interaction = new Interaction(world, player, inventory, {
    onBreakBlock: (hit, def, held) => {
      playBreak(def.sound);
      survival.exert('mine');
      if (!localSim) return; // the server decides drops, wear and block entities
      localSim.blockRemoved(hit.x, hit.y, hit.z);
      for (const roll of blockDrops(def, held)) {
        localSim.spawnDrop(roll.id, roll.count, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      }
      if (wearsTool(def, held) && inventory.damageSelected()) hud.toast('Your tool broke!');
      hud.refresh();
    },
    onPlaceBlock: (def, x, y, z) => {
      playPlace(def.sound);
      localSim?.blockPlaced(x, y, z, BLOCKS.indexOf(def));
      hud.refresh();
    },
    onAttack: () => playAttack(),
    onSwing: (kind) => viewmodel.swing(kind),
    tryEat: () => invCtl.eatHeld(),
    onUseBlock: (kind, hit) => {
      switch (kind) {
        case 'table':
          invCtl.openGrid(3, { x: hit.x, y: hit.y, z: hit.z });
          openScreen();
          break;
        case 'furnace':
        case 'chest':
          if (invCtl.openContainer(hit.x, hit.y, hit.z)) openScreen();
          break;
        case 'bed':
          trySleep(hit.x, hit.y, hit.z);
          break;
      }
    },
    onTill: (hit) => {
      playPlace('soft');
      if (localSim) {
        world.setBlock(hit.x, hit.y, hit.z, Block.Farmland);
        if (inventory.damageSelected()) hud.toast('Your hoe broke!');
        hud.refresh();
      } else if (session) {
        // Predict locally without broadcasting; the server confirms or reverts.
        world.applyRemoteEdit(hit.x, hit.y, hit.z, Block.Farmland);
        session.till(hit.x, hit.y, hit.z);
      }
    },
    toast: (msg) => hud.toast(msg),
    combatTargets: () => combatTargets(),
    onHitTarget: (id, damage) => {
      survival.exert('attack');
      hitTarget(id, damage);
    },
    onUseOnTarget: (id) => {
      if (!id.startsWith('mob:')) return false;
      const mobId = Number(id.slice(4));
      if (localSim) {
        if (!localSim.shearMob(mobId, selfNetId())) return false;
        if (inventory.damageSelected()) hud.toast('Your shears broke!');
        hud.refresh();
        return true;
      }
      session?.useOnMob(mobId);
      return true;
    },
    fireArrow: (origin, dir, charge) => {
      const speed = ARROW_SPEED * (0.35 + charge * 0.65);
      const damage = Math.max(1, Math.round(2 + charge * 7));
      spawnArrow(origin, dir, speed, damage, selfNetId());
      session?.sendArrow(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, speed);
    },
  });

  /**
   * Everything the local player can hit: every simulated mob, plus any live
   * remote players. Mob entries carry a "mob:" id prefix so a single target
   * list drives both melee and arrows in either mode.
   */
  function combatTargets(): CombatTarget[] {
    const targets: CombatTarget[] = [];
    for (const mob of worldView.allMobs) {
      if (!mob.object.visible || mob.dying) continue;
      targets.push({
        id: `mob:${mob.id}`,
        position: mob.position,
        halfWidth: mob.halfWidth,
        height: mob.height,
        kind: mob.kindName,
      });
    }
    if (!session) return targets;
    for (const p of session.remotePlayers.all) {
      // `visible` is only set once a snapshot has arrived; without it the body
      // still sits at the origin and could be "hit" by aiming at 0,0,0.
      if (!p.group.visible || session.vitals.get(p.info.id)?.dead) continue;
      targets.push({
        id: p.info.id,
        position: p.position,
        halfWidth: PLAYER_HALF_WIDTH,
        height: PLAYER_HEIGHT,
      });
    }
    return targets;
  }

  /** Route a hit to whichever simulation owns the target. */
  function hitTarget(id: string, damage: number): void {
    if (id.startsWith('mob:')) {
      const mobId = Number(id.slice(4));
      if (localSim) localSim.damageMob(mobId, damage, selfNetId(), player.position);
      else session?.attackMob(mobId, damage);
      return;
    }
    session?.attackPlayer(id, damage);
  }

  /** Play the death sound for any mob that died within earshot, and topple it. */
  function onMobDeaths(deaths: { i: number; x: number; y: number; z: number }[]): void {
    worldView.killMobs(deaths);
    const earshotSq = MOB_DESPAWN_DISTANCE * MOB_DESPAWN_DISTANCE;
    for (const at of deaths) {
      const dx = at.x - player.position.x;
      const dy = at.y - player.position.y;
      const dz = at.z - player.position.z;
      if (dx * dx + dy * dy + dz * dz <= earshotSq) {
        playMobDeath();
        return; // one sound per tick, however many died
      }
    }
  }

  function spawnArrow(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    damage: number,
    ownerId: string,
  ): Arrow {
    const arrow = new Arrow(origin, dir, speed, damage, ownerId, {
      // The shooter's own id is filtered inside Arrow; include everyone else.
      targets: () => combatTargets(),
      onHitTarget: (id, dmg) => hitTarget(id, dmg),
    });
    // Start slightly ahead of the eye so it doesn't clip the shooter.
    arrow.position.addScaledVector(dir, 0.4);
    entities.add(arrow);
    return arrow;
  }

  // --- Play state ---
  const menu = document.getElementById('menu')!;
  let touchPlaying = false;
  const root = document.documentElement;

  /** True when the world should simulate and accept look/move input. */
  const isPlaying = (): boolean =>
    !survival.dead && !inventoryUi.open && !sleeping && (touchDevice ? touchPlaying : look.locked);

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
        setAnimatedLimbs: setAnimatedLimbs,
        notify: (msg) => hud.toast(msg),
      })
    : null;

  /**
   * Turn limb animation on or off everywhere at once. Bodies are rebuilt in
   * place, keeping their interpolation state, so the switch is invisible apart
   * from the limbs stopping.
   */
  function setAnimatedLimbs(on: boolean): void {
    worldView.setArticulated(on);
    // The manager remembers it too, so anyone joining later matches.
    session?.remotePlayers.setArticulated(on);
    animatedLimbs = on;
    // The first-person hand is one mesh; it rides the same setting so the
    // weakest devices skip its extra pass entirely.
    viewmodel.enabled = on;
  }

  menu.addEventListener('pointerup', () => {
    if (survival.dead || sleeping) return;
    initAudio();
    if (touchDevice) {
      touchPlaying = true;
      menu.style.display = 'none';
    } else {
      look.requestLock();
    }
    refreshPlayingClass();
  });

  /** Catches a lock request the browser never granted and never reported. */
  let lockFallbackTimer = 0;

  document.addEventListener('pointerlockchange', () => {
    // Only the menu path un-pauses; the inventory, sleep and death screens
    // manage their own overlays and must not be replaced by the main menu.
    if (touchDevice) return;
    if (look.locked) clearTimeout(lockFallbackTimer);
    const showMenu = !look.locked && !inventoryUi.open && !survival.dead && !sleeping;
    menu.style.display = showMenu ? 'flex' : 'none';
    refreshPlayingClass();
  });

  /**
   * The browser refused to give the mouse back. Put the menu up so a click
   * resumes play, rather than leaving a free cursor over a world that no
   * longer responds to it.
   */
  document.addEventListener('pointerlockerror', () => offerMenu());

  function offerMenu(): void {
    if (touchDevice || look.locked || inventoryUi.open || survival.dead || sleeping) return;
    menu.style.display = 'flex';
    refreshPlayingClass();
  }

  /**
   * Hand the mouse back to the game after a screen closes.
   *
   * The request can be refused — Chrome rejects one made too soon after the
   * last lock ended, which is exactly what closing a screen you only just
   * opened does. `pointerlockerror` covers the browsers that report it; the
   * timer covers the rest. Either way the player ends up with the menu and a
   * click away from playing, never stranded with a cursor and no way back in.
   */
  function resumePlay(): void {
    if (touchDevice || survival.dead || sleeping || inventoryUi.open) return;
    look.requestLock();
    clearTimeout(lockFallbackTimer);
    lockFallbackTimer = window.setTimeout(offerMenu, 400);
  }

  /** Show the inventory screen in whatever state the controller is in. */
  function openScreen(): void {
    inventoryUi.show();
    menu.style.display = 'none';
    clearTimeout(lockFallbackTimer);
    if (!touchDevice && look.locked) document.exitPointerLock();
    refreshPlayingClass();
  }

  function closeScreen(): void {
    // The close itself hands the mouse back, through the InventoryUi callback
    // below — so the Close button and the E key behave identically.
    inventoryUi.close();
    refreshPlayingClass();
  }

  function toggleInventory(): void {
    if (inventoryUi.open) {
      closeScreen();
    } else if (!survival.dead && !sleeping) {
      invCtl.openGrid(2);
      openScreen();
    }
  }

  // --- Sleeping ---
  const sleepOverlay = document.getElementById('sleep-overlay')!;
  const sleepSub = document.getElementById('sleep-sub')!;
  document.getElementById('sleep-wake')!.addEventListener('click', () => wakeUp());

  function trySleep(x: number, y: number, z: number): void {
    if (localSim) {
      const result = localSim.trySleep(selfNetId(), x, y, z, currentSimPlayers());
      if (!result.ok) {
        if (result.message) hud.toast(result.message);
        return;
      }
      spawnPoint.set(x + 0.5, y + 1, z + 0.5);
      setSleeping(true);
      sleepSub.textContent = 'The night passes…';
      return;
    }
    session?.sleep(x, y, z);
  }

  function setSleeping(on: boolean, message?: string): void {
    if (sleeping === on) {
      if (!on && message) hud.toast(message);
      return;
    }
    sleeping = on;
    sleepOverlay.style.display = on ? 'flex' : 'none';
    if (on) {
      inventoryUi.close();
      menu.style.display = 'none';
      if (!touchDevice && look.locked) document.exitPointerLock();
    } else {
      if (message) hud.toast(message);
      resumePlay();
    }
    refreshPlayingClass();
  }

  function wakeUp(message?: string): void {
    if (localSim) localSim.wake(selfNetId());
    else session?.wake();
    setSleeping(false, message);
  }

  function onPlayerDied(): void {
    inventoryUi.close();
    if (sleeping) setSleeping(false);
    menu.style.display = 'none';
    statusUi.showDeath(deathMessage());
    if (!touchDevice && look.locked) document.exitPointerLock();
    refreshPlayingClass();
    // Everything carried falls where you fell. In multiplayer the server does
    // this from its own copy, so only the local screen is emptied here.
    const dropped = invCtl.dropEverything();
    if (localSim) {
      localSim.scatterStacks(dropped, player.position.x, player.position.y + 0.6, player.position.z);
    }
    hud.refresh();
    flushSave();
  }

  /** Name what killed you, the way vanilla's death screen does. */
  function deathMessage(): string {
    switch (survival.lastCause) {
      case 'drown':
        return 'You drowned.';
      case 'fall':
        return 'You hit the ground too hard.';
      case 'starve':
        return 'You starved to death.';
      default:
        return worldView.mobCount > 0 ? 'The night was not kind.' : 'Better luck next time.';
    }
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
    session?.sendRespawn();
    if (touchDevice) touchPlaying = true;
    else resumePlay();
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
        if (n >= 1 && n <= 9) invCtl.selectSlot(n - 1);
      } else if (code === 'KeyQ') {
        dropHeldItem(input.isDown('ControlLeft') || input.isDown('ControlRight'));
      } else if (code === 'KeyE') {
        toggleInventory();
      } else if (code === 'F3') {
        hud.toggleDebug();
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
      invCtl.selectSlot((inventory.selected + wheel + 900) % 9);
    }
  }

  /**
   * Throw the held item into the world — vanilla's Q, and the way you hand
   * something to another player. `wholeStack` mirrors Ctrl+Q.
   */
  function dropHeldItem(wholeStack: boolean): void {
    if (!isPlaying()) return;
    const thrown = invCtl.dropHeld(wholeStack);
    if (!thrown) return;
    hud.toast(`Dropped ${thrown.count} ${getItem(thrown.id)?.name ?? thrown.id}`);
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
      armor: inventory.serializeArmor(),
      health: dead ? MAX_HEALTH : survival.health,
      hunger: dead ? MAX_HUNGER : survival.hunger,
      spawn: { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z },
    };
    void store.saveMeta(metaOut);
    if (localSim) void store.saveState(localSim.serialize());
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
  window.addEventListener('pagehide', flushSave);

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
      multiplayer.key,
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
        onDamaged: (amount, byName) => {
          // The server already arbitrated the hit; apply it locally.
          survival.damage(amount);
          mpHud.notice(`${byName} hit you.`);
        },
        onWorldState: (state) => {
          // The server owns mobs, dropped items and the clock.
          // receiveClock() must match the clock the frame loop hands to
          // worldView.update, or interpolation silently renders stale frames.
          const now = receiveClock();
          sky.timeOfDay = state.time;
          worldView.applyMobs(state.mobs, now);
          worldView.applyDrops(state.drops, now);
          worldView.applyArrows(state.arrows, now);
          onMobDeaths(state.mobDeaths);
          worldView.removeMobs(state.removedMobs);
          worldView.removeDrops(state.removedDrops);
          worldView.removeArrows(state.removedArrows);
          // Anything absent from a full snapshot is gone.
          worldView.retainMobs(new Set(state.mobs.map((m) => m.i)));
          worldView.retainDrops(new Set(state.drops.map((d) => d.i)));
          worldView.retainArrows(new Set(state.arrows.map((a) => a.i)));
          if (sleeping) {
            const missing = state.sleep ? Math.max(0, state.sleep.needed - state.sleep.sleeping.length) : 0;
            sleepSub.textContent =
              missing > 0
                ? `Waiting for ${missing} more player${missing === 1 ? '' : 's'} to sleep…`
                : 'The night passes…';
          }
        },
        onKnockback: (fromX, fromZ) => knockbackPlayer(fromX, fromZ),
        onRemoteArrow: (x, y, z, dx, dy, dz, speed, ownerId, ageMs) => {
          const origin = new THREE.Vector3(x, y, z);
          const dir = new THREE.Vector3(dx, dy, dz);
          // Remote arrows are visual + physical locally, but only the shooter's
          // client reports hits, so damage is never applied twice.
          const arrow = spawnArrow(origin, dir, speed, 0, ownerId);
          // Catch the arrow up to where it actually is: replay the flight time
          // that elapsed while the packet was in transit.
          arrow.fastForward(ageMs / 1000, entityContext);
        },
        onInventory: (state) => {
          const before = inventory.slots.reduce((n, s) => n + (s?.count ?? 0), 0);
          invCtl.applyServerState(state);
          const after = inventory.slots.reduce((n, s) => n + (s?.count ?? 0), 0);
          if (after > before && state.ack === 0) playPickup();
          hud.refresh();
        },
        onContainer: (state) => {
          invCtl.applyContainerState(state);
          if (!inventoryUi.open && !survival.dead) openScreen();
        },
        onContainerClosed: () => {
          invCtl.containerClosed();
          if (inventoryUi.open) inventoryUi.render(true);
        },
        onVitalsSet: (health, hunger) => survival.setVitals(health, hunger),
        onSleepResult: (asleep, message) => {
          if (asleep) sleepSub.textContent = 'Waiting for everyone to sleep…';
          setSleeping(asleep, message);
        },
      },
    );
    mpHud.show(multiplayer.code);
    mpHud.setRoster(multiplayer.players);
    // Carry the current quality setting into the new session, in case the
    // ladder already stepped down before anyone joined.
    session.remotePlayers.setArticulated(animatedLimbs);
    // Arrows are per-client effects; drop any left from before the room.
    entities.clear();
  }
  invCtl.attach(session, localSim);

  /** The player list the simulation reasons about (local + remotes). */
  function currentSimPlayers(): SimPlayer[] {
    return [
      { id: selfNetId(), position: player.position, dead: survival.dead },
      ...(session?.remotePlayers.all ?? [])
        .filter((p) => p.group.visible)
        .map((p) => ({
          id: p.info.id,
          position: p.position,
          dead: session!.vitals.get(p.info.id)?.dead ?? false,
        })),
    ];
  }

  // --- Debug hook for automated smoke tests ---
  (window as unknown as Record<string, unknown>).__voxel = {
    /** The block id table, so tests can name blocks instead of numbering them. */
    Block,
    world,
    player,
    sky,
    look,
    touch,
    autoQuality,
    inventory,
    inventoryCtl: invCtl,
    survival,
    entities,
    interaction,
    inventoryUi,
    respawn,
    getSession: () => session,
    getWorldView: () => worldView,
    getLocalSim: () => localSim,
    dropHeldItem,
    viewmodel,
    breakOverlay,
    isSleeping: () => sleeping,
    /** Try the bed at a block position, exactly as a right-click on it would. */
    sleepAt: (x: number, y: number, z: number) => trySleep(x, y, z),
    /** Draw any atlas tile into a 2D context; used to inspect textures in tests. */
    drawTile: (ctx: CanvasRenderingContext2D, tile: number, x: number, y: number, size: number) =>
      drawTileTo(ctx, tile, x, y, size),
    setAnimatedLimbs,
    getAnimatedLimbs: () => animatedLimbs,
    getViewDistance: () => viewDistance,
    // Thin wrappers over the real rules, so automated tests exercise the same
    // code paths the game does rather than reimplementing them.
    getItemDef: (id: string) => getItem(id),
    /** Fire an arrow with plain numbers, so tests need no THREE in page scope. */
    spawnTestArrow: (
      ox: number, oy: number, oz: number,
      dx: number, dy: number, dz: number,
      speed: number, damage: number,
    ) =>
      spawnArrow(
        new THREE.Vector3(ox, oy, oz),
        new THREE.Vector3(dx, dy, dz),
        speed,
        damage,
        selfNetId(),
      ),
    /**
     * Put a mob of a given kind at a fixed spot in the local simulation, so a
     * test can exercise one deterministically instead of waiting for the
     * spawner to roll it. Singleplayer only; returns its id, or null.
     */
    spawnTestMob: (kind: MobKind, x: number, y: number, z: number): number | null => {
      if (!localSim) return null;
      const mob = new MobSim(kind, x, y, z);
      localSim.addMob(mob);
      return mob.id;
    },
    /** Drive one interaction tick with the live camera ray. */
    tickInteraction: (dt: number, mining: boolean, using: boolean, taps: number) => {
      player.eyePosition(eye);
      look.direction(lookDir);
      interaction.update(dt, performance.now(), eye, lookDir, { mining, using, useTaps: taps });
    },
    __breakTime: (blockId: number, stack: ItemStack | null) =>
      breakTimeFor(BLOCKS[blockId], stack),
    __canHarvest: (blockId: number, stack: ItemStack | null) =>
      canHarvest(BLOCKS[blockId], stack),
    /**
     * Craft a recipe the way the screen does: lay it out on the grid from the
     * inventory, take the result, and put the grid back. Returns whether the
     * result was made.
     */
    __craftAt: (recipeId: string, station: 'none' | 'table'): boolean => {
      const recipe = getRecipe(recipeId);
      const size: 2 | 3 = station === 'table' ? 3 : 2;
      if (!recipe || recipe.gridSize > size) return false;
      invCtl.openGrid(size);
      invCtl.fillGrid(recipeCells(recipe, size));
      const before = inventory.count(recipe.output.id) + (invCtl.holding.cursor?.count ?? 0);
      invCtl.craft(false);
      const crafted = inventory.count(recipe.output.id) + (invCtl.holding.cursor?.count ?? 0) > before;
      invCtl.close();
      return crafted;
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

    // Raising a shield slows you down, as it does in Minecraft.
    if (interaction.blocking) {
      move.forward *= BLOCK_SLOWDOWN;
      move.strafe *= BLOCK_SLOWDOWN;
    }
    if (playing) {
      // A jump costs a little food; charged on the frame it leaves the ground.
      if (move.jump && player.onGround && !player.feetInWater) survival.exert('jump');
      player.update(dt, move, look.yaw);
    }
    survival.update(dt, player);

    world.update(
      player.position.x,
      player.position.z,
      viewDistance,
      touchDevice ? TOUCH_MAX_CHUNK_GENS_PER_FRAME : undefined,
      touchDevice ? TOUCH_MESH_BUDGET_MS : undefined,
    );
    // In multiplayer the server owns the clock; sky.update only advances it
    // locally when there is no session to take it from.
    sky.update(session ? 0 : dt);
    if (playing) autoQuality?.update(dt);

    // Build the player list the simulation reasons about (local + remotes).
    const simPlayers = currentSimPlayers();

    // Singleplayer drives the shared simulation locally; multiplayer receives
    // authoritative snapshots instead and never simulates mobs itself. The
    // simulation keeps running while asleep — that is how the night passes —
    // and while the inventory is open, so a furnace smelts as you watch it.
    const simulating = playing || sleeping || (inventoryUi.open && !survival.dead);
    if (simulating && localSim) {
      localSim.update(dt, simPlayers);
      sky.timeOfDay = localSim.timeOfDay;
      worldView.applyMobs(localSim.mobSnapshot(), nowMs);
      worldView.applyDrops(localSim.dropSnapshot(), nowMs);
      worldView.applyArrows(localSim.arrowSnapshot(), nowMs);
      onMobDeaths(localSim.mobDeaths.splice(0));
      worldView.removeMobs(localSim.removedMobs.splice(0));
      worldView.removeDrops(localSim.removedDrops.splice(0));
      worldView.removeArrows(localSim.removedArrows.splice(0));
      // Applied to the world already through World.applyEdit; just drain.
      localSim.blocks.length = 0;
      if (localSim.removedContainers.length > 0) {
        const open = invCtl.container;
        for (const key of localSim.removedContainers.splice(0)) {
          if (open && key === `${open.x},${open.y},${open.z}`) invCtl.containerClosed();
        }
      }
      localSim.dirtyContainers.clear();
    }
    worldView.update(nowMs, dt);

    // Arrows still tick locally; their hits are reported, never applied here.
    if (playing) {
      entityContext.dt = dt;
      entities.update(entityContext);
    }

    if (session) {
      // Camera yaw/pitch is the shared abstraction: keyboard+mouse and touch
      // both feed it, so both platforms emit identical network state.
      // Publish what the body is doing so other players see it, not just the effects.
      session.flags.swinging = viewmodel.swinging;
      session.flags.using = interaction.useTime > 0;
      session.flags.hurt = survival.hurtFlash > 0;
      session.flags.dead = survival.dead;
      session.flags.sleeping = sleeping;
      session.update(nowMs, dt, look.yaw, look.pitch, playing);
      session.sendVitals(nowMs, survival.health, survival.hunger, survival.dead);
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

    // Cracks spread across whatever block is being worked on.
    if (hit && interaction.breakProgress > 0) {
      breakOverlay.show(hit.x, hit.y, hit.z, interaction.breakProgress);
    } else {
      breakOverlay.hide();
    }

    // The held item tracks the hand: sway with movement, arc on a swing.
    viewmodel.update({
      dt,
      held: inventory.selectedStack,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      velocityY: player.velocity.y,
      onGround: player.onGround,
      bowCharge: playing ? interaction.bowCharge : 0,
      blocking: playing && interaction.blocking,
    });

    look.apply(eye);
    hud.setUnderwater(player.eyeInWater);
    hud.refresh();
    statusUi.update(
      survival,
      playing ? interaction.breakProgress : 0,
      playing ? interaction.bowCharge : 0,
    );
    inventoryUi.render();

    hud.updateFrameStats(
      dt,
      [
        `pos ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`,
        `chunk ${Math.floor(player.position.x / CHUNK_SIZE)},${Math.floor(player.position.z / CHUNK_SIZE)}`,
        `chunks ${world.chunks.size} (pending mesh ${world.pendingMeshCount})`,
        `entities ${entities.entities.length}  mobs ${worldView.mobCount}  drops ${worldView.dropCount}  arrows ${worldView.arrowCount}`,
        `hp ${survival.health.toFixed(0)}  food ${survival.hunger.toFixed(1)}`,
        `draw calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`,
        `seed ${seed}  time ${(sky.timeOfDay * 24).toFixed(1)}h ${isNightTime(sky.timeOfDay) ? '(night)' : '(day)'}`,
        `view ${viewDistance} chunks  render ${Math.round(pixelScale * 100)}%`,
        ...(localSim ? [`crops ${localSim.crops.size}  containers ${localSim.containers.size}`] : []),
      ].join('\n'),
    );

    renderer.render(scene, camera);
    // Drawn last, over the finished world, on its own depth range.
    viewmodel.render(renderer);
  });
}

async function main(): Promise<void> {
  const choice = await showModeMenu();
  await boot(choice);
}

void main();
