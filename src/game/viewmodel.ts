// The hand — and whatever it is holding — drawn in front of the camera.
//
// Rendered in its own scene with its own camera, composited over the world
// with the depth buffer cleared, so a raised sword never clips into a wall the
// way it would if it lived in the main scene. That costs one extra draw call
// and no depth-sorting work, which is why it is affordable on a phone.
//
// Everything here is pose maths on a single mesh: no skeletons, no per-frame
// buffer uploads.

import * as THREE from 'three';
import { BLOCKS } from '../blocks';
import { buildBoxGeometry, getMobMaterial } from '../entities/models';
import type { ItemStack } from '../items/inventory';
import { getItem } from '../items/items';
import { getAtlasTexture, tileUVRect } from '../textures';
import { HandAnimator, type HoldKind, type StrikeKind, type SwingStyle } from './handpose';

const SKIN = 0xd8b18a;
const ITEM_SIZE = 0.36;
const BLOCK_SIZE = 0.3;

export interface ViewmodelState {
  /** Seconds elapsed this frame. */
  dt: number;
  /** Held item, or null for a bare hand. */
  held: ItemStack | null;
  /** Horizontal speed in blocks/second, for the walking sway. */
  speed: number;
  /** Vertical velocity, for the jump and landing bob. */
  velocityY: number;
  onGround: boolean;
  /** Bow draw, 0..1. */
  bowCharge: number;
  /** Shield raised. */
  blocking: boolean;
}

let itemMaterial: THREE.MeshBasicMaterial | null = null;
let blockMaterial: THREE.MeshLambertMaterial | null = null;

/**
 * Flat item icons are drawn unlit: the sprite already has its shading painted
 * in, so lighting it again would double it up. The colour is knocked back a
 * little so a held tool does not glow brighter than the world behind it.
 */
function getItemMaterial(): THREE.MeshBasicMaterial {
  if (!itemMaterial) {
    itemMaterial = new THREE.MeshBasicMaterial({
      map: getAtlasTexture(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      color: 0xd2d2d2,
    });
  }
  return itemMaterial;
}

/** A held block IS lit, so its faces shade like the ones in the world. */
function getBlockMaterial(): THREE.MeshLambertMaterial {
  if (!blockMaterial) {
    blockMaterial = new THREE.MeshLambertMaterial({ map: getAtlasTexture() });
  }
  return blockMaterial;
}

const itemGeometries = new Map<number, THREE.BufferGeometry>();

function itemQuad(tile: number): THREE.BufferGeometry {
  let geo = itemGeometries.get(tile);
  if (!geo) {
    geo = new THREE.PlaneGeometry(ITEM_SIZE, ITEM_SIZE);
    const [u0, v0, u1, v1] = tileUVRect(tile);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    }
    uv.needsUpdate = true;
    itemGeometries.set(tile, geo);
  }
  return geo;
}

const blockGeometries = new Map<number, THREE.BufferGeometry>();

/** A small textured cube showing the block's real faces. */
function blockCube(blockId: number): THREE.BufferGeometry {
  let geo = blockGeometries.get(blockId);
  if (!geo) {
    const { tiles } = BLOCKS[blockId];
    geo = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z.
    const faceTiles = [tiles.side, tiles.side, tiles.top, tiles.bottom, tiles.side, tiles.side];
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    faceTiles.forEach((tile, face) => {
      const [u0, v0, u1, v1] = tileUVRect(tile);
      for (let i = face * 4; i < face * 4 + 4; i++) {
        uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
      }
    });
    uv.needsUpdate = true;
    blockGeometries.set(blockId, geo);
  }
  return geo;
}

let handGeometry: THREE.BufferGeometry | null = null;

function getHandGeometry(): THREE.BufferGeometry {
  if (!handGeometry) {
    handGeometry = buildBoxGeometry([
      { pos: [0, 0, 0], size: [0.13, 0.13, 0.5], color: SKIN },
    ]);
  }
  return handGeometry;
}

export class Viewmodel {
  /** Off by default on the weakest devices; see AutoQuality. */
  enabled = true;

  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** The posed node. Public so tests can read the pose; treat as read-only. */
  readonly holder = new THREE.Group();
  /** The held model, or null when nothing is drawn. */
  mesh: THREE.Mesh | null = null;

  /** Item id currently modelled. `null` means "not built yet", which is
   * distinct from '' meaning "an empty hand". */
  private heldKey: string | null = null;
  /** The item the swap dip is on its way to showing, once it bottoms out. */
  private pendingKey: string | null = null;
  private hold: HoldKind = 'hand';
  private style: SwingStyle = 'jab';
  private readonly anim = new HandAnimator();

  constructor(fov: number) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 4);
    // A light aimed down the view axis, since the main scene's sun is not here.
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(0.5, 1, 0.8);
    this.scene.add(light, new THREE.AmbientLight(0xffffff, 0.85), this.holder);
  }

  /**
   * Start a stroke. Re-triggering restarts it, so holding the mouse down while
   * mining reads as one continuous action rather than a single frozen frame.
   */
  swing(kind: StrikeKind = 'attack'): void {
    this.anim.strike(kind);
  }

  get swinging(): boolean {
    return this.anim.swinging;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(state: ViewmodelState): void {
    // Queue the swap first: the model is rebuilt part-way through `pose`, at
    // the bottom of the dip, so the change is never seen on screen.
    this.queueHeld(state.held);

    const pose = this.anim.pose({
      dt: state.dt,
      hold: this.hold,
      style: this.style,
      speed: state.speed,
      velocityY: state.velocityY,
      onGround: state.onGround,
      bowCharge: state.bowCharge,
      blocking: state.blocking,
    });

    if (this.anim.takeSwap()) this.buildHeld();
    // The clocks above run even when the model is hidden: other players read
    // `swinging` off them to animate our arm on their screens, so switching the
    // viewmodel off for performance must not make us look motionless to them.
    if (!this.enabled || !this.mesh) return;

    this.holder.position.set(pose.x, pose.y, pose.z);
    this.holder.rotation.set(pose.rotX, pose.rotY, pose.rotZ);
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.enabled || !this.mesh) return;
    // Draw over the finished world frame, on a fresh depth range of its own.
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }

  /**
   * Note a change of held item, and start the dip that hides the swap.
   *
   * The very first item appears without one — there is nothing to swap from,
   * and an opening dip just looks like the hand falling into frame. So does a
   * change made while the model is hidden, which nobody can see anyway.
   */
  private queueHeld(stack: ItemStack | null): void {
    const def = stack ? getItem(stack.id) : undefined;
    const key = def ? def.id : '';
    if (key === this.pendingKey) return;
    this.pendingKey = key;

    if (this.heldKey === null || !this.enabled) {
      this.buildHeld();
      return;
    }
    this.anim.equip();
  }

  /** Swap in the model for `pendingKey`. Called at the bottom of the dip. */
  private buildHeld(): void {
    const key = this.pendingKey ?? '';
    if (key === this.heldKey) return;
    this.heldKey = key;

    if (this.mesh) {
      this.holder.remove(this.mesh);
      this.mesh = null;
    }

    const def = key ? getItem(key) : undefined;
    // Which rest pose and which strike style apply is decided here, once per
    // item change, rather than re-derived every frame.
    this.hold = !def ? 'hand' : def.block !== undefined ? 'block' : 'item';
    // A sword has an edge and sweeps it across; every other tool is swung
    // overhead and brought down; a bare fist, a block or an apple just goes out.
    const tool = def?.tool?.kind;
    this.style = tool === 'sword' ? 'sweep' : tool ? 'chop' : 'jab';

    if (!def) {
      this.mesh = new THREE.Mesh(getHandGeometry(), getMobMaterial());
    } else if (def.block !== undefined) {
      this.mesh = new THREE.Mesh(blockCube(def.block), getBlockMaterial());
    } else {
      this.mesh = new THREE.Mesh(itemQuad(def.tile), getItemMaterial());
    }
    this.holder.add(this.mesh);
  }

  dispose(): void {
    this.scene.clear();
  }
}
