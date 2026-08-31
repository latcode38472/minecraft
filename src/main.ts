import * as THREE from 'three';
import { initAudio, playBreak, playPlace, playStep } from './audio';
import { BLOCKS, Block } from './blocks';
import {
  BREAK_REPEAT_MS,
  CHUNK_SIZE,
  DEFAULT_VIEW_DISTANCE,
  MAX_TIMESTEP,
  MAX_VIEW_DISTANCE,
  MIN_VIEW_DISTANCE,
  PLACE_REPEAT_MS,
  REACH_DISTANCE,
  SAVE_INTERVAL_MS,
  TOUCH_DEFAULT_VIEW_DISTANCE,
  TOUCH_LOOK_SENSITIVITY,
  TOUCH_MAX_CHUNK_GENS_PER_FRAME,
  TOUCH_MESH_BUDGET_MS,
} from './constants';
import { Input } from './input';
import { MouseLook } from './player/camera';
import { Player, type MoveInput } from './player/player';
import { AutoQuality } from './autoquality';
import { TouchControls, isTouchDevice } from './ui/touch';
import { raycastVoxel, type RayHit } from './raycast';
import { SaveStore, type SaveMeta } from './save';
import { Sky } from './sky';
import { Hud } from './ui/hud';
import { World } from './world/world';

const STEP_INTERVAL_BLOCKS = 2.2;

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const store = await SaveStore.open();
  if (params.has('reset')) await store.clearAll();

  let meta = await store.loadMeta();
  const paramSeed = params.get('seed');
  let seed = meta?.seed ?? (Math.random() * 0xffffffff) >>> 0;
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

  // --- Game objects ---
  const savedEdits = await store.loadAllEdits();
  const world = new World(seed, scene, savedEdits);
  const sky = new Sky(scene);
  const input = new Input();
  const look = new MouseLook(camera, renderer.domElement);
  const player = new Player(world);
  const hud = new Hud();

  if (meta) {
    player.position.set(meta.player.x, meta.player.y, meta.player.z);
    look.yaw = meta.player.yaw;
    look.pitch = meta.player.pitch;
    sky.timeOfDay = meta.timeOfDay;
    hud.selectSlot(meta.selectedSlot);
  } else {
    const spawn = world.terrain.findSpawnColumn();
    player.position.set(spawn.x + 0.5, spawn.y + 2, spawn.z + 0.5);
  }

  // Targeted-block outline.
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: 0x000000 }),
  );
  highlight.visible = false;
  scene.add(highlight);

  // --- Play state: pointer lock on desktop, an explicit flag on touch ---
  const menu = document.getElementById('menu')!;
  let touchPlaying = false;
  const isPlaying = (): boolean => (touchDevice ? touchPlaying : look.locked);

  const touch = touchDevice ? new TouchControls(document.getElementById('app')!) : null;
  if (touch) {
    touch.onPause = () => {
      touchPlaying = false;
      menu.style.display = 'flex';
      flushSave();
    };
  }

  // Adaptive quality on touch: phone GPUs vary a lot, so track the real frame
  // rate and trade render resolution / view distance for smoothness.
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
    initAudio();
    if (touchDevice) {
      touchPlaying = true;
      menu.style.display = 'none';
    } else {
      look.requestLock();
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (!touchDevice) menu.style.display = look.locked ? 'none' : 'flex';
  });

  // --- Mouse actions (hold to repeat) ---
  let breakHeld = false;
  let placeHeld = false;
  let nextActionAt = 0;
  document.addEventListener('mousedown', (e) => {
    if (!look.locked) return;
    if (e.button === 0) breakHeld = true;
    if (e.button === 2) placeHeld = true;
    nextActionAt = 0; // act immediately
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) breakHeld = false;
    if (e.button === 2) placeHeld = false;
  });

  const eye = new THREE.Vector3();
  const lookDir = new THREE.Vector3();

  function currentTarget(): RayHit | null {
    player.eyePosition(eye);
    look.direction(lookDir);
    return raycastVoxel(world, eye, lookDir, REACH_DISTANCE);
  }

  function breakAt(hit: RayHit): void {
    if (!BLOCKS[hit.id].breakable) return;
    world.setBlock(hit.x, hit.y, hit.z, Block.Air);
    playBreak(BLOCKS[hit.id].sound);
  }

  function placeAt(hit: RayHit): boolean {
    const px = hit.x + hit.normal[0];
    const py = hit.y + hit.normal[1];
    const pz = hit.z + hit.normal[2];
    const id = hud.selectedBlock;
    const occupied = world.getBlock(px, py, pz);
    if (occupied !== Block.Air && occupied !== Block.Water) return false;
    if (BLOCKS[id].solid && player.intersectsBlock(px, py, pz)) return false;
    if (!world.setBlock(px, py, pz, id)) return false;
    playPlace(BLOCKS[id].sound);
    return true;
  }

  function handleActions(nowMs: number): void {
    const taps = touch?.takeBreakTaps() ?? 0;
    if (!isPlaying()) return;

    // Touch taps break immediately, bypassing the hold-repeat timer.
    if (taps > 0) {
      const tapHit = currentTarget();
      if (tapHit) breakAt(tapHit);
    }

    const wantBreak = breakHeld;
    const wantPlace = placeHeld || (touch?.placeHeld ?? false);
    if ((!wantBreak && !wantPlace) || nowMs < nextActionAt) return;
    const hit = currentTarget();
    if (!hit) return;
    if (wantBreak) {
      breakAt(hit);
      nextActionAt = nowMs + BREAK_REPEAT_MS;
    } else if (wantPlace && placeAt(hit)) {
      nextActionAt = nowMs + PLACE_REPEAT_MS;
    }
  }

  function handleKeys(): void {
    for (const code of input.takePresses()) {
      if (code.startsWith('Digit')) {
        const n = Number(code.slice(5));
        if (n >= 1 && n <= 9) hud.selectSlot(n - 1);
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
    if (wheel !== 0 && isPlaying()) hud.cycleSlot(wheel);
  }

  // --- Persistence ---
  function flushSave(): void {
    const metaOut: SaveMeta = {
      seed,
      timeOfDay: sky.timeOfDay,
      player: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        yaw: look.yaw,
        pitch: look.pitch,
      },
      selectedSlot: hud.selectedSlot,
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

  // --- Debug hook for automated smoke tests ---
  (window as unknown as Record<string, unknown>).__voxel = {
    world,
    player,
    sky,
    look,
    touch,
    autoQuality,
    getViewDistance: () => viewDistance,
  };

  // --- Main loop ---
  let lastTime = performance.now();
  renderer.setAnimationLoop(() => {
    const nowMs = performance.now();
    const dt = Math.min((nowMs - lastTime) / 1000, MAX_TIMESTEP);
    lastTime = nowMs;

    handleKeys();
    handleActions(nowMs);

    if (touch) {
      const [lookDx, lookDy] = touch.takeLookDelta();
      if (isPlaying()) look.rotate(lookDx, lookDy, TOUCH_LOOK_SENSITIVITY);
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
      sneak:
        input.isDown('ShiftLeft') || input.isDown('ShiftRight') || (touch?.sneakOn ?? false),
    };
    if (isPlaying()) player.update(dt, move, look.yaw);
    world.update(
      player.position.x,
      player.position.z,
      viewDistance,
      touchDevice ? TOUCH_MAX_CHUNK_GENS_PER_FRAME : undefined,
      touchDevice ? TOUCH_MESH_BUDGET_MS : undefined,
    );
    sky.update(dt);
    if (isPlaying()) autoQuality?.update(dt);

    if (player.stepAccumulator > STEP_INTERVAL_BLOCKS) {
      player.stepAccumulator = 0;
      playStep();
    }

    const hit = isPlaying() ? currentTarget() : null;
    highlight.visible = hit !== null;
    if (hit) highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

    player.eyePosition(eye);
    look.apply(eye);
    hud.setUnderwater(player.eyeInWater);

    hud.updateFrameStats(
      dt,
      [
        `pos ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`,
        `chunk ${Math.floor(player.position.x / CHUNK_SIZE)},${Math.floor(player.position.z / CHUNK_SIZE)}`,
        `chunks ${world.chunks.size} (pending mesh ${world.pendingMeshCount})`,
        `draw calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`,
        `seed ${seed}  time ${(sky.timeOfDay * 24).toFixed(1)}h`,
        `view ${viewDistance} chunks  render ${Math.round(pixelScale * 100)}%`,
      ].join('\n'),
    );

    renderer.render(scene, camera);
  });
}

void boot();
