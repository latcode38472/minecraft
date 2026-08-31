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
} from './constants';
import { Input } from './input';
import { MouseLook } from './player/camera';
import { Player } from './player/player';
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
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  scene.fog = new THREE.Fog(0x87ceeb, 10, 100);

  let viewDistance = clampViewDistance(
    Number(localStorage.getItem('voxelcraft.viewDistance')) || DEFAULT_VIEW_DISTANCE,
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
    localStorage.setItem('voxelcraft.viewDistance', String(viewDistance));
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

  // --- Pointer lock / menu ---
  const menu = document.getElementById('menu')!;
  menu.addEventListener('click', () => {
    initAudio();
    look.requestLock();
  });
  document.addEventListener('pointerlockchange', () => {
    menu.style.display = look.locked ? 'none' : 'flex';
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

  function handleActions(nowMs: number): void {
    if (!look.locked || (!breakHeld && !placeHeld) || nowMs < nextActionAt) return;
    const hit = currentTarget();
    if (!hit) return;
    if (breakHeld) {
      if (!BLOCKS[hit.id].breakable) return;
      world.setBlock(hit.x, hit.y, hit.z, Block.Air);
      playBreak(BLOCKS[hit.id].sound);
      nextActionAt = nowMs + BREAK_REPEAT_MS;
    } else if (placeHeld) {
      const px = hit.x + hit.normal[0];
      const py = hit.y + hit.normal[1];
      const pz = hit.z + hit.normal[2];
      const id = hud.selectedBlock;
      const occupied = world.getBlock(px, py, pz);
      if (occupied !== Block.Air && occupied !== Block.Water) return;
      if (BLOCKS[id].solid && player.intersectsBlock(px, py, pz)) return;
      if (world.setBlock(px, py, pz, id)) {
        playPlace(BLOCKS[id].sound);
        nextActionAt = nowMs + PLACE_REPEAT_MS;
      }
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
        viewDistance = clampViewDistance(viewDistance + (code === 'BracketRight' ? 1 : -1));
        applyViewDistance();
        hud.toast(`View distance: ${viewDistance} chunks`);
      }
    }
    const wheel = input.takeWheelSteps();
    if (wheel !== 0 && look.locked) hud.cycleSlot(wheel);
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
  (window as unknown as Record<string, unknown>).__voxel = { world, player, sky, look };

  // --- Main loop ---
  let lastTime = performance.now();
  renderer.setAnimationLoop(() => {
    const nowMs = performance.now();
    const dt = Math.min((nowMs - lastTime) / 1000, MAX_TIMESTEP);
    lastTime = nowMs;

    handleKeys();
    handleActions(nowMs);

    if (look.locked) player.update(dt, input, look.yaw);
    world.update(player.position.x, player.position.z, viewDistance);
    sky.update(dt);

    if (player.stepAccumulator > STEP_INTERVAL_BLOCKS) {
      player.stepAccumulator = 0;
      playStep();
    }

    const hit = look.locked ? currentTarget() : null;
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
        `view ${viewDistance} chunks`,
      ].join('\n'),
    );

    renderer.render(scene, camera);
  });
}

void boot();
